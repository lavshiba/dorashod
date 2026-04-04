import type { CategoryRecord, DraftPayload, EntryRecord, EntryType, SubcategoryRecord, UiSession, UserRecord } from "@/domain/types";
import type { Repository } from "@/db/repository";
import type { TelegramApi } from "@/telegram/api";
import { BUTTONS, BOT_TITLE, ONBOARDING_TEXTS, onboardingProgress } from "@/ui/text";
import { kb } from "@/ui/keyboard";
import { decodeCallback } from "@/utils/callback";
import { parseCustomPeriodInput, parseQuickPeriod, splitNowForUser } from "@/utils/dates";
import { parseEntryAttempt } from "@/utils/entry-parser";
import { formatAmountFromMinor } from "@/utils/money";
import { escapeHtml, normalizeName } from "@/utils/normalize";
import { resolveTimezoneFromCity, resolveTimezoneFromLocation } from "@/utils/timezone";

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    document?: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
    };
    chat: { id: number };
    from?: { id: number };
    location?: { latitude: number; longitude: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message?: {
      chat: { id: number };
    };
  };
}

export class BotService {
  constructor(
    private readonly repo: Repository,
    private readonly telegram: TelegramApi
  ) {}

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }

    if (update.message?.text) {
      await this.handleMessage(update.message.from?.id, update.message.chat.id, update.message.text);
      return;
    }

    if (update.message?.location) {
      await this.handleLocation(update.message.from?.id, update.message.chat.id, update.message.location);
      return;
    }

    if (update.message?.document) {
      await this.handleDocument(update.message.from?.id, update.message.chat.id, update.message.document);
    }
  }

  async runCron(controllerName: string): Promise<void> {
    await this.repo.createCronRun(controllerName, "ok", "cron completed");
  }

  private async handleMessage(fromId: number | undefined, chatId: number, text: string): Promise<void> {
    if (!fromId) {
      return;
    }

    const user = await this.repo.getOrCreateUser(String(fromId), String(chatId));
    const session = await this.repo.getSession(user.id);

    if (text === "/start") {
      await this.showStart(user);
      return;
    }

    if (!user.onboardingCompletedAt && (user.onboardingStep < 7 || user.onboardingStep === 0)) {
      await this.showOnboarding(user, Math.min(user.onboardingStep, 6));
      return;
    }

    if (session.mode === "add") {
      await this.handleAddInput(user, session, text);
      return;
    }

    if (session.mode === "edit") {
      await this.handleEditInput(user, session, text);
      return;
    }

    if (session.mode === "operations" && session.context.awaiting === "bulk-transfer-category") {
      await this.repo.saveSession(user.id, {
        ...session,
        context: { ...session.context, transferCategoryName: text.trim(), awaiting: user.subcategoriesEnabled ? "bulk-transfer-subcategory" : undefined }
      });
      if (user.subcategoriesEnabled) {
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Напиши подкатегорию.",
          reply_markup: kb([[{ text: BUTTONS.skip, action: "bulk:transfer-skip-subcategory" }, { text: BUTTONS.main, action: "nav:home" }]])
        });
        return;
      }
      await this.applyBulkTransfer(user);
      return;
    }

    if (session.mode === "operations" && session.context.awaiting === "bulk-transfer-subcategory") {
      await this.repo.saveSession(user.id, {
        ...session,
        context: { ...session.context, transferSubcategoryName: text.trim(), awaiting: undefined }
      });
      await this.applyBulkTransfer(user);
      return;
    }

    if (session.mode === "search" && session.context.awaiting === "query") {
      await this.repo.saveSession(user.id, { ...session, context: { ...session.context, query: text, awaiting: undefined } });
      await this.showSearchResults(user, text, 0);
      return;
    }

    if (session.mode === "categories" && session.context.awaiting === "new-category") {
      await this.handleCategoryCreate(user, String(session.context.type) as EntryType, text);
      return;
    }

    if (session.mode === "categories" && session.context.awaiting === "new-subcategory") {
      await this.handleSubcategoryCreate(user, Number(session.context.categoryId), String(session.context.type) as EntryType, Number(session.context.page ?? "0"), text);
      return;
    }

    if (session.mode === "categories" && session.context.awaiting === "rename-category") {
      await this.handleCategoryRename(user, Number(session.context.categoryId), String(session.context.type) as EntryType, Number(session.context.page ?? "0"), text);
      return;
    }

    if (session.mode === "categories" && session.context.awaiting === "rename-subcategory") {
      await this.handleSubcategoryRename(
        user,
        Number(session.context.subcategoryId),
        Number(session.context.categoryId),
        String(session.context.type) as EntryType,
        Number(session.context.page ?? "0"),
        text
      );
      return;
    }

    if (session.mode === "categories" && session.context.awaiting === "transfer-category-name") {
      await this.handleCategoryTransferAll(user, Number(session.context.categoryId), String(session.context.type) as EntryType, Number(session.context.page ?? "0"), text);
      return;
    }

    if (session.mode === "settings" && session.context.awaiting === "currency") {
      await this.updateUserSetting(user.id, "currency_label", text.trim(), "currency_code", "CUSTOM");
      await this.showSettings(user);
      return;
    }

    if (session.mode === "settings" && session.context.awaiting === "timezone") {
      const timezone = resolveTimezoneFromCity(text);
      if (!timezone) {
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Не удалось определить город.\n\nПришли другой город или отправь геопозицию.",
          reply_markup: kb([[{ text: BUTTONS.back, action: "settings:time" }, { text: BUTTONS.main, action: "nav:home" }]])
        });
        return;
      }
      await this.updateUserSetting(user.id, "timezone_name", timezone, "timezone_source", "city");
      await this.showTimeSettings(await this.repo.getOrCreateUser(user.telegramUserId, user.chatId));
      return;
    }

    if (session.mode === "import" && session.context.awaiting === "fix-line") {
      await this.handleImportFixInput(user, session, text);
      return;
    }

    if (session.mode === "reports" && session.context.awaiting === "custom-period") {
      const parsed = parseCustomPeriodInput(text, this.userNow(user.timezoneName).date);
      if (parsed.status === "resolved") {
        await this.showReportRange(user, parsed.label, parsed.from, parsed.to, "custom");
        return;
      }
      if (parsed.status === "ambiguous") {
        await this.repo.saveSession(user.id, {
          ...session,
          mode: "reports",
          context: {
            ...session.context,
            awaiting: "custom-period-confirm",
            customPeriodFrom: parsed.from,
            customPeriodTo: parsed.to,
            customPeriodLabel: parsed.label
          }
        });
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: `период понят не до конца\n\nкак бот понял:\n${parsed.label}\n\nподтверди или напиши период ещё раз`,
          reply_markup: kb([
            [{ text: BUTTONS.save, action: "reports:custom-confirm" }],
            [{ text: BUTTONS.back, action: "reports:open" }, { text: BUTTONS.main, action: "nav:home" }]
          ])
        });
        return;
      }
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: `период понят не до конца\n\nкак бот понял:\n${text}\n\nподтверди или напиши период ещё раз`,
        reply_markup: kb([[{ text: BUTTONS.back, action: "reports:open" }, { text: BUTTONS.main, action: "nav:home" }]])
      });
      return;
    }

    const parsed = parseEntryAttempt(text);
    if (parsed.isBatch) {
      for (const line of parsed.lines) {
        const item = parseEntryAttempt(line);
        await this.repo.enqueueIntake(user.id, "message-batch", line, item, item.missing);
      }
      await this.showHome(user, "Новые записи добавлены в очередь.");
      return;
    }

    if (session.mode === "search") {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "Пришло сообщение, похожее на новую запись.\n\n[искать это] или [в новые записи]?",
        reply_markup: kb([[{ text: BUTTONS.searchThis, action: "search:use-text" }, { text: BUTTONS.toNewEntries, action: "search:to-queue" }]])
      });
      await this.repo.saveSession(user.id, { ...session, context: { ...session.context, pendingText: text } });
      return;
    }

    if (parsed.missing.length === 0 && parsed.type && parsed.amountMinor && parsed.category) {
      await this.repo.createEntry({
        user,
        type: parsed.type,
        amountMinor: parsed.amountMinor,
        categoryName: parsed.category,
        subcategoryName: parsed.subcategory,
        description: parsed.description,
        source: "message"
      });
      await this.showHome(user, "запись добавлена");
      return;
    }

    if (parsed.type || parsed.amountMinor || parsed.category) {
      await this.repo.saveDraft(
        user.id,
        {
          type: parsed.type,
          amountMinor: parsed.amountMinor,
          categoryName: parsed.category,
          subcategoryName: parsed.subcategory,
          description: parsed.description
        },
        this.nextAddStep({
          type: parsed.type,
          amountMinor: parsed.amountMinor,
          categoryName: parsed.category
        })
      );
      await this.repo.saveSession(user.id, { mode: "add", stack: ["home"], context: { source: "message" } });
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: `Из записи удалось понять:\n${this.describeDraft({
          type: parsed.type,
          amountMinor: parsed.amountMinor,
          categoryName: parsed.category,
          subcategoryName: parsed.subcategory,
          description: parsed.description
        }, user.currencyLabel)}\n\nНе хватает: ${parsed.missing.map(formatMissingField).join(", ")}.`,
        reply_markup: kb([[{ text: BUTTONS.cancel, action: "add:cancel" }, { text: BUTTONS.main, action: "nav:home" }]])
      });
      await this.continueDraft(user);
      return;
    }

    await this.showHome(user);
  }

  private async handleLocation(
    fromId: number | undefined,
    chatId: number,
    location: { latitude: number; longitude: number }
  ): Promise<void> {
    if (!fromId) {
      return;
    }
    const user = await this.repo.getOrCreateUser(String(fromId), String(chatId));
    const session = await this.repo.getSession(user.id);
    if (session.mode === "settings" && session.context.awaiting === "timezone") {
      const timezone = resolveTimezoneFromLocation(location.latitude, location.longitude);
      await this.updateUserSetting(user.id, "timezone_name", timezone, "timezone_source", "location");
      await this.showTimeSettings(await this.repo.getOrCreateUser(user.telegramUserId, user.chatId));
      return;
    }
    await this.showHome(user);
  }

  private async handleDocument(
    fromId: number | undefined,
    chatId: number,
    document: { file_id: string; file_name?: string; mime_type?: string }
  ): Promise<void> {
    if (!fromId) {
      return;
    }

    const user = await this.repo.getOrCreateUser(String(fromId), String(chatId));
    const session = await this.repo.getSession(user.id);
    if (session.mode !== "data" || !session.context.awaitingUploadType) {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "Сначала открой раздел данные и выбери, куда загрузить файл.",
        reply_markup: kb([[{ text: BUTTONS.data, action: "data:open" }, { text: BUTTONS.main, action: "nav:home" }]])
      });
      return;
    }

    const downloaded = await this.telegram.downloadTextFile(document.file_id);
    const uploadType = String(session.context.awaitingUploadType);

    if (uploadType === "full") {
      const snapshot = parseFullSnapshot(downloaded.content);
      if (!snapshot) {
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Файл не удалось прочитать.\n\nПришли полную копию для этого бота ещё раз.",
          reply_markup: kb([[{ text: BUTTONS.back, action: "data:this-bot" }, { text: BUTTONS.main, action: "nav:home" }]])
        });
        return;
      }

      const importId = await this.repo.createImport(user.id, "full-backup", "preview", snapshot.raw);
      await this.repo.saveSession(user.id, {
        mode: "data",
        stack: ["data"],
        context: { importId, awaitingUploadType: undefined }
      });
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text:
          `для этого бота\n\n` +
          `записи: ${snapshot.entries}\n` +
          `категории: ${snapshot.categories}\n` +
          `подкатегории: ${snapshot.subcategories}\n` +
          `черновик: ${snapshot.hasDraft ? "есть" : "нет"}\n` +
          `новые записи: ${snapshot.queue}`,
        reply_markup: kb([
          [{ text: BUTTONS.loadFromFile, action: "data:import-full-confirm", payload: { importId } }],
          [{ text: BUTTONS.back, action: "data:this-bot" }, { text: BUTTONS.main, action: "nav:home" }]
        ])
      });
      return;
    }

    const preview = parseEntriesImport(downloaded.content);
    const importId = await this.repo.createImport(user.id, "entries", "preview", {
      filename: document.file_name ?? downloaded.filePath,
      entries: preview.entries,
      errors: preview.errors
    });
    await this.repo.saveSession(user.id, {
      mode: "data",
      stack: ["data"],
      context: { importId, awaitingUploadType: undefined }
    });

    if (preview.errors.length > 0) {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: `не удалось прочитать: ${preview.errors.length}\n\nкраткие причины:\n${preview.errors.slice(0, 3).join("\n")}`,
        reply_markup: kb([
          [{ text: `добавить ${preview.entries.length}`, action: "data:import-entries-add-all", payload: { importId } }],
          [{ text: `исправить ${preview.errors.length}`, action: "data:import-fix-open", payload: { importId } }],
          [{ text: BUTTONS.back, action: "data:other-apps" }, { text: BUTTONS.main, action: "nav:home" }]
        ])
      });
      return;
    }

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `в другие приложения\n\nзаписей: ${preview.entries.length}`,
      reply_markup: kb([
        [{ text: BUTTONS.merge, action: "data:import-entries-merge", payload: { importId } }],
        [{ text: BUTTONS.addAll, action: "data:import-entries-add-all", payload: { importId } }],
        [{ text: BUTTONS.back, action: "data:other-apps" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async handleCallback(callbackQuery: TelegramUpdate["callback_query"]): Promise<void> {
    if (!callbackQuery?.message) {
      return;
    }
    const params = decodeCallback(callbackQuery.data);
    const action = params.a;
    const user = await this.repo.getOrCreateUser(String(callbackQuery.from.id), String(callbackQuery.message.chat.id));
    const session = await this.repo.getSession(user.id);

    if (callbackQuery.id) {
      await this.telegram.answerCallbackQuery(callbackQuery.id);
    }

    if (session.mode === "edit" && action === "nav:home") {
      await this.handleEditLeave(user, "home");
      return;
    }

    switch (action) {
      case "onboarding:show":
        await this.showOnboarding(user, Number(params.step ?? "0"));
        return;
      case "onboarding:start":
        await this.showOnboarding(user, 1);
        return;
      case "onboarding:next":
        await this.showOnboarding(user, Number(params.step ?? "0") + 1);
        return;
      case "onboarding:back":
        await this.showOnboarding(user, Math.max(Number(params.step ?? "0") - 1, 0));
        return;
      case "onboarding:skip":
        await this.repo.completeOnboarding(user.id);
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Можно добавить доход или расход сейчас, или перейти на главную.",
          reply_markup: kb([
            [{ text: BUTTONS.income, action: "add:start", payload: { type: "income" } }, { text: BUTTONS.expense, action: "add:start", payload: { type: "expense" } }],
            [{ text: BUTTONS.toMain, action: "nav:home" }]
          ])
        });
        return;
      case "onboarding:import":
        await this.repo.completeOnboarding(user.id);
        await this.showData(user);
        return;
      case "onboarding:complete":
      case "nav:home":
        await this.repo.completeOnboarding(user.id);
        await this.repo.clearSession(user.id);
        await this.showHome(user);
        return;
      case "add:start":
        await this.repo.saveSession(user.id, { mode: "add", stack: ["home"], context: { type: params.type } });
        await this.repo.saveDraft(user.id, { type: String(params.type) as EntryType }, "amount");
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Напиши сумму.",
          reply_markup: kb([[{ text: BUTTONS.cancel, action: "add:cancel" }, { text: BUTTONS.main, action: "nav:home" }]])
        });
        return;
      case "add:pick-category":
        await this.pickAddCategory(user, Number(params.id));
        return;
      case "add:pick-subcategory":
        await this.pickAddSubcategory(user, Number(params.id));
        return;
      case "add:skip-subcategory":
        await this.skipAddSubcategory(user);
        return;
      case "add:skip-description":
        await this.finalizeDraft(user, undefined);
        return;
      case "add:cancel":
        await this.repo.clearSession(user.id);
        await this.showHome(user);
        return;
      case "draft:open":
        await this.showDraft(user);
        return;
      case "draft:continue":
        await this.repo.saveSession(user.id, { mode: "add", stack: ["home"], context: { source: "draft" } });
        await this.continueDraft(user);
        return;
      case "draft:delete":
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Удалить черновик?",
          reply_markup: kb([[{ text: BUTTONS.delete, action: "draft:confirm-delete" }, { text: BUTTONS.back, action: "draft:open" }]])
        });
        return;
      case "draft:confirm-delete":
        await this.repo.deleteDraft(user.id);
        await this.showHome(user);
        return;
      case "queue:open":
        await this.showQueue(user);
        return;
      case "queue:save-current":
        await this.saveQueueItem(user);
        return;
      case "queue:skip-current":
        await this.skipQueueItem(user);
        return;
      case "operations:list":
        await this.showOperations(user, Number(params.page ?? "0"));
        return;
      case "operations:select-mode":
        await this.showOperations(user, Number(params.page ?? "0"), true);
        return;
      case "select:toggle":
        await this.toggleSelection(user, Number(params.id), String(params.origin), Number(params.page ?? "0"));
        return;
      case "select:all":
        await this.selectAllOnPage(user, String(params.origin), Number(params.page ?? "0"));
        return;
      case "select:actions":
        await this.showBulkActions(user, String(params.origin), Number(params.page ?? "0"));
        return;
      case "bulk:transfer":
        await this.startBulkTransfer(user, String(params.origin), Number(params.page ?? "0"));
        return;
      case "bulk:transfer-skip-subcategory":
        await this.applyBulkTransfer(user);
        return;
      case "bulk:delete":
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Удалить выбранные записи?",
          reply_markup: kb([
            [{ text: BUTTONS.delete, action: "bulk:delete-confirm", payload: { origin: params.origin, page: params.page } }],
            [{ text: BUTTONS.back, action: "select:actions", payload: { origin: params.origin, page: params.page } }]
          ])
        });
        return;
      case "bulk:delete-confirm":
        await this.applyBulkDelete(user, String(params.origin), Number(params.page ?? "0"));
        return;
      case "bulk:remove-subcategory":
        await this.applyBulkRemoveSubcategory(user, String(params.origin), Number(params.page ?? "0"));
        return;
      case "bulk:cancel":
        await this.clearBulkSelection(user, String(params.origin), Number(params.page ?? "0"));
        return;
      case "operations:view":
        await this.showEntryCard(
          user,
          Number(params.id),
          params.source === "report" ? "report" : params.source === "category" ? "category" : "operations",
          Number(params.page ?? "0")
        );
        return;
      case "entry:move":
        await this.moveEntryCard(user, Number(params.id), String(params.source ?? "operations"), Number(params.page ?? "0"));
        return;
      case "entry:edit":
        await this.startEditEntry(
          user,
          Number(params.id),
          Number(params.page ?? "0"),
          params.source === "report" ? "report" : params.source === "search" ? "search" : params.source === "category" ? "category" : "operations",
          typeof params.query === "string" ? String(params.query) : undefined
        );
        return;
      case "entry:delete":
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Удалить запись?",
          reply_markup: kb([
            [
              { text: BUTTONS.delete, action: "entry:confirm-delete", payload: { id: params.id, page: params.page, source: params.source, query: params.query } },
              { text: BUTTONS.back, action: "operations:view", payload: { id: params.id, page: params.page, source: params.source, query: params.query } }
            ]
          ])
        });
        return;
      case "entry:confirm-delete":
        await this.repo.deleteEntry(user.id, Number(params.id));
        if (params.source === "report") {
          await this.showReportEntries(user, {
            page: Number(params.page ?? "0"),
            type: typeof session.context.reportEntriesType === "string" ? (String(session.context.reportEntriesType) as EntryType) : undefined,
            categoryId: typeof session.context.reportEntriesCategoryId === "number" ? (session.context.reportEntriesCategoryId as number) : undefined,
            subcategoryId: typeof session.context.reportEntriesSubcategoryId === "number" ? (session.context.reportEntriesSubcategoryId as number) : undefined
          });
          return;
        }
        if (params.source === "search") {
          if (session.context.searchPeriod) {
            await this.showSearchPeriodResults(
              user,
              String(session.context.searchPeriod),
              Number(params.page ?? "0"),
              (session.context.searchFrom as string | null | undefined) ?? null,
              (session.context.searchTo as string | null | undefined) ?? null
            );
            return;
          }
          await this.showSearchResults(user, String(params.query ?? session.context.query ?? ""), Number(params.page ?? "0"));
          return;
        }
        await this.showOperations(user, Number(params.page ?? "0"));
        return;
      case "search:open":
        await this.showSearchEntry(user);
        return;
      case "search:prompt":
        await this.repo.saveSession(user.id, { mode: "search", stack: ["home"], context: { awaiting: "query" } });
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Напиши запрос сообщением.",
          reply_markup: kb([[{ text: BUTTONS.cancel, action: "search:open" }, { text: BUTTONS.main, action: "nav:home" }]])
        });
        return;
      case "search:quick":
        await this.showQuickSearch(user, String(params.period));
        return;
      case "search:results":
        await this.showSearchResults(user, String(params.query ?? ""), Number(params.page ?? "0"));
        return;
      case "search:select-mode":
        if (session.context.searchPeriod) {
          await this.showSearchPeriodResults(
            user,
            String(session.context.searchPeriod),
            Number(params.page ?? "0"),
            (session.context.searchFrom as string | null | undefined) ?? null,
            (session.context.searchTo as string | null | undefined) ?? null,
            true
          );
          return;
        }
        await this.showSearchResults(user, String(params.query ?? ""), Number(params.page ?? "0"), true);
        return;
      case "search:view":
        await this.showEntryCard(user, Number(params.id), "search", Number(params.page ?? "0"), String(params.query ?? ""));
        return;
      case "edit:field":
        await this.promptEditField(user, String(params.field));
        return;
      case "edit:save":
        await this.saveEditedEntry(user);
        return;
      case "edit:back":
        await this.showEditScreen(user);
        return;
      case "edit:leave":
        await this.handleEditLeave(user, String(params.target ?? "source"));
        return;
      case "edit:discard":
        await this.discardEditChanges(user, String(params.target ?? "source"));
        return;
      case "search:use-text":
        await this.showSearchResults(user, String(session.context.pendingText ?? ""), 0);
        return;
      case "search:to-queue": {
        const pendingText = String(session.context.pendingText ?? "");
        const parsed = parseEntryAttempt(pendingText);
        await this.repo.enqueueIntake(user.id, "search-conflict", pendingText, parsed, parsed.missing);
        await this.showSearchEntry(user);
        return;
      }
      case "reports:open":
        await this.showReportsEntry(user);
        return;
      case "reports:quick":
        await this.showReport(user, String(params.period));
        return;
      case "reports:breakdown":
        await this.showReportBreakdown(user, String(params.type) as EntryType, Number(params.page ?? "0"));
        return;
      case "report:category":
        await this.showReportCategoryCard(user, Number(params.id), String(params.type) as EntryType, Number(params.page ?? "0"));
        return;
      case "report:subcategory":
        await this.showReportSubcategoryCard(
          user,
          Number(params.categoryId),
          Number(params.id),
          String(params.type) as EntryType,
          Number(params.page ?? "0")
        );
        return;
      case "report:entries":
        await this.showReportEntries(user, {
          page: Number(params.page ?? "0"),
          type: typeof params.type === "string" ? (String(params.type) as EntryType) : undefined,
          categoryId: params.categoryId ? Number(params.categoryId) : undefined,
          subcategoryId: params.subcategoryId ? Number(params.subcategoryId) : undefined
        });
        return;
      case "report:entries-select":
        await this.showReportEntries(
          user,
          {
            page: Number(params.page ?? "0"),
            type: typeof params.type === "string" ? (String(params.type) as EntryType) : undefined,
            categoryId: params.categoryId ? Number(params.categoryId) : undefined,
            subcategoryId: params.subcategoryId ? Number(params.subcategoryId) : undefined
          },
          true
        );
        return;
      case "reports:custom":
        await this.repo.saveSession(user.id, { mode: "reports", stack: ["home"], context: { awaiting: "custom-period" } });
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Напиши период сообщением.",
          reply_markup: kb([[{ text: BUTTONS.cancel, action: "reports:open" }, { text: BUTTONS.main, action: "nav:home" }]])
        });
        return;
      case "reports:custom-confirm":
        await this.showReportRange(
          user,
          String(session.context.customPeriodLabel ?? "свой период"),
          (session.context.customPeriodFrom as string | null | undefined) ?? null,
          (session.context.customPeriodTo as string | null | undefined) ?? null,
          "custom"
        );
        return;
      case "reports:current":
        await this.showReportRange(
          user,
          String(session.context.reportTitle ?? "свой период"),
          (session.context.reportFrom as string | null | undefined) ?? null,
          (session.context.reportTo as string | null | undefined) ?? null,
          String(session.context.reportPeriod ?? "custom")
        );
        return;
      case "categories:open":
        await this.showCategoryRoot(user);
        return;
      case "categories:list":
        await this.showCategoryList(user, String(params.type) as EntryType, Number(params.page ?? "0"));
        return;
      case "categories:add":
        await this.repo.saveSession(user.id, { mode: "categories", stack: ["categories"], context: { awaiting: "new-category", type: params.type } });
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Напиши название категории.",
          reply_markup: kb([[{ text: BUTTONS.cancel, action: "categories:list", payload: { type: params.type } }, { text: BUTTONS.main, action: "nav:home" }]])
        });
        return;
      case "category:view":
        await this.showCategoryCard(user, Number(params.id), String(params.type) as EntryType, Number(params.page ?? "0"));
        return;
      case "subcategory:view":
        await this.showSubcategoryCard(user, Number(params.id), Number(params.categoryId), String(params.type) as EntryType, Number(params.page ?? "0"));
        return;
      case "category:hide":
        await this.repo.hideCategory(user.id, Number(params.id));
        await this.showCategoryList(user, String(params.type) as EntryType, Number(params.page ?? "0"));
        return;
      case "category:restore":
        await this.repo.restoreCategory(user.id, Number(params.id));
        await this.showCategoryList(user, String(params.type) as EntryType, Number(params.page ?? "0"));
        return;
      case "categories:hidden":
        await this.showHiddenCategoryList(user, String(params.type) as EntryType, Number(params.page ?? "0"));
        return;
      case "subcategories:hidden":
        await this.showHiddenSubcategoryList(user, Number(params.categoryId), String(params.type) as EntryType, Number(params.page ?? "0"));
        return;
      case "subcategory:add":
        await this.repo.saveSession(user.id, {
          mode: "categories",
          stack: ["categories"],
          context: { awaiting: "new-subcategory", categoryId: Number(params.categoryId), type: params.type, page: Number(params.page ?? "0") }
        });
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Напиши название подкатегории.",
          reply_markup: kb([[{ text: BUTTONS.cancel, action: "category:view", payload: { id: params.categoryId, type: params.type, page: params.page } }, { text: BUTTONS.main, action: "nav:home" }]])
        });
        return;
      case "subcategory:hide":
        await this.repo.hideSubcategory(user.id, Number(params.id));
        await this.showCategoryCard(user, Number(params.categoryId), String(params.type) as EntryType, Number(params.page ?? "0"));
        return;
      case "category:edit":
        await this.startCategoryRename(user, Number(params.id), String(params.type) as EntryType, Number(params.page ?? "0"));
        return;
      case "subcategory:edit":
        await this.startSubcategoryRename(user, Number(params.id), Number(params.categoryId), String(params.type) as EntryType, Number(params.page ?? "0"));
        return;
      case "subcategory:restore":
        await this.repo.restoreSubcategory(user.id, Number(params.id));
        await this.showSubcategoryCard(user, Number(params.id), Number(params.categoryId), String(params.type) as EntryType, Number(params.page ?? "0"));
        return;
      case "category:delete":
        await this.handleCategoryDelete(user, Number(params.id), String(params.type) as EntryType, Number(params.page ?? "0"));
        return;
      case "subcategory:delete":
        await this.handleSubcategoryDelete(user, Number(params.id), Number(params.categoryId), String(params.type) as EntryType, Number(params.page ?? "0"));
        return;
      case "category:transfer-all":
        await this.startCategoryTransferAll(user, Number(params.id), String(params.type) as EntryType, Number(params.page ?? "0"));
        return;
      case "subcategory:transfer-all":
        await this.startSubcategoryTransferAll(user, Number(params.id), Number(params.categoryId), String(params.type) as EntryType, Number(params.page ?? "0"));
        return;
      case "subcategory:transfer-to":
        await this.applySubcategoryTransferAll(
          user,
          Number(params.id),
          Number(params.categoryId),
          String(params.type) as EntryType,
          Number(params.page ?? "0"),
          params.target ? Number(params.target) : null
        );
        return;
      case "category:entries":
        await this.showCategoryEntries(user, Number(params.categoryId), undefined, String(params.type) as EntryType, Number(params.page ?? "0"));
        return;
      case "subcategory:entries":
        await this.showCategoryEntries(user, Number(params.categoryId), Number(params.id), String(params.type) as EntryType, Number(params.page ?? "0"));
        return;
      case "category:entries-select":
        await this.showCategoryEntries(
          user,
          Number(params.categoryId),
          params.id ? Number(params.id) : undefined,
          String(params.type) as EntryType,
          Number(params.page ?? "0"),
          true
        );
        return;
      case "settings:open":
        await this.showSettings(user);
        return;
      case "settings:currency":
        await this.showCurrencySettings(user);
        return;
      case "settings:set-currency":
        await this.updateUserSetting(user.id, "currency_label", String(params.label), "currency_code", String(params.code));
        await this.showCurrencySettings(await this.repo.getOrCreateUser(user.telegramUserId, user.chatId));
        return;
      case "settings:currency-custom":
        await this.repo.saveSession(user.id, { mode: "settings", stack: ["settings"], context: { awaiting: "currency" } });
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Пришли знак или короткое имя валюты.",
          reply_markup: kb([[{ text: BUTTONS.cancel, action: "settings:currency" }, { text: BUTTONS.main, action: "nav:home" }]])
        });
        return;
      case "settings:time":
        await this.repo.saveSession(user.id, { mode: "settings", stack: ["settings"], context: { awaiting: "timezone" } });
        await this.showTimeSettings(user);
        return;
      case "settings:subcategories":
        await this.showSubcategoriesSettings(user);
        return;
      case "settings:set-subcategories":
        await this.updateUserSetting(user.id, "subcategories_enabled", params.enabled === "1" ? 1 : 0);
        await this.showSubcategoriesSettings(await this.repo.getOrCreateUser(user.telegramUserId, user.chatId));
        return;
      case "settings:quick-access":
        await this.showQuickAccessRoot(user);
        return;
      case "settings:quick-access-section":
        await this.showQuickAccessSection(user, String(params.section));
        return;
      case "settings:set-quick-access":
        await this.applyQuickAccessMode(user, String(params.section), String(params.mode));
        return;
      case "settings:quick-access-slot":
        await this.showQuickAccessSlotEditor(user, String(params.section), Number(params.slot ?? "1"), Number(params.page ?? "0"));
        return;
      case "settings:quick-access-slot-pick":
        await this.applyQuickAccessSlot(user, String(params.section), Number(params.slot ?? "1"), Number(params.id), Number(params.page ?? "0"));
        return;
      case "settings:quick-access-slot-clear":
        await this.clearQuickAccessSlot(user, String(params.section), Number(params.slot ?? "1"));
        return;
      case "settings:sorting":
        await this.showSortingRoot(user);
        return;
      case "settings:sorting-section":
        await this.showSortingSection(user, String(params.section));
        return;
      case "settings:set-sorting":
        await this.applySortingMode(user, String(params.section), String(params.mode));
        return;
      case "data:open":
        await this.showData(user);
        return;
      case "data:this-bot":
        await this.showDataThisBot(user);
        return;
      case "data:other-apps":
        await this.showDataOtherApps(user);
        return;
      case "data:import-full-open":
        await this.repo.saveSession(user.id, { mode: "data", stack: ["data"], context: { awaitingUploadType: "full" } });
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Пришли файл.",
          reply_markup: kb([[{ text: BUTTONS.back, action: "data:this-bot" }, { text: BUTTONS.main, action: "nav:home" }]])
        });
        return;
      case "data:import-entries-open":
        await this.repo.saveSession(user.id, { mode: "data", stack: ["data"], context: { awaitingUploadType: "entries" } });
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Пришли файл.",
          reply_markup: kb([[{ text: BUTTONS.back, action: "data:other-apps" }, { text: BUTTONS.main, action: "nav:home" }]])
        });
        return;
      case "data:import-full-confirm": {
        const pendingImport = await this.repo.getImport(user.id, Number(params.importId));
        if (!pendingImport) {
          await this.showDataThisBot(user);
          return;
        }
        await this.repo.replaceUserDataFromSnapshot(user, pendingImport.previewJson);
        await this.repo.deleteImport(user.id, pendingImport.id);
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "данные загружены"
        });
        await this.showHome(await this.repo.getOrCreateUser(user.telegramUserId, user.chatId));
        return;
      }
      case "data:import-entries-merge":
        await this.applyEntriesImport(user, Number(params.importId), true);
        return;
      case "data:import-entries-add-all":
        await this.applyEntriesImport(user, Number(params.importId), false);
        return;
      case "data:import-fix-open":
        await this.showImportFixItem(user, Number(params.importId), 0);
        return;
      case "data:import-fix-edit":
        await this.repo.saveSession(user.id, {
          mode: "import",
          stack: ["data"],
          context: { importId: Number(params.importId), fixIndex: Number(params.index ?? "0"), awaiting: "fix-line" }
        });
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Пришли исправленную строку.",
          reply_markup: kb([[{ text: BUTTONS.cancel, action: "data:import-fix-open", payload: { importId: params.importId } }, { text: BUTTONS.main, action: "nav:home" }]])
        });
        return;
      case "data:import-fix-save":
        await this.applyImportFixSave(user, Number(params.importId), Number(params.index ?? "0"));
        return;
      case "data:import-fix-skip":
        await this.showImportFixItem(user, Number(params.importId), Number(params.index ?? "0") + 1);
        return;
      case "data:reset-settings":
        await this.repo.resetUserSettings(user.id);
        await this.showData(user);
        return;
      case "data:clear-all":
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "очистить всё?\n\nэто самое опасное действие",
          reply_markup: kb([
            [{ text: BUTTONS.clearAll, action: "data:clear-all-confirm" }],
            [{ text: BUTTONS.back, action: "data:open" }, { text: BUTTONS.main, action: "nav:home" }]
          ])
        });
        return;
      case "data:clear-all-confirm":
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "подтверди очистить всё",
          reply_markup: kb([
            [{ text: BUTTONS.clearAll, action: "data:clear-all-final" }],
            [{ text: BUTTONS.back, action: "data:open" }, { text: BUTTONS.main, action: "nav:home" }]
          ])
        });
        return;
      case "data:clear-all-final":
        await this.repo.clearAllUserData(user.id);
        await this.showHome(await this.repo.getOrCreateUser(user.telegramUserId, user.chatId));
        return;
      case "data:export-full": {
        const snapshot = await this.repo.exportFullUserSnapshot(user.id);
        await this.telegram.sendDocument({
          chat_id: user.chatId,
          filename: "finance-bot-backup.json",
          content: JSON.stringify(snapshot, null, 2),
          caption: "полная копия для этого бота"
        });
        return;
      }
      case "data:export-entries": {
        const snapshot = await this.repo.exportEntriesSnapshot(user.id);
        await this.telegram.sendDocument({
          chat_id: user.chatId,
          filename: "finance-bot-entries.json",
          content: JSON.stringify(snapshot, null, 2),
          caption: "записи для других приложений"
        });
        return;
      }
      default:
        await this.showHome(user);
    }
  }

  private async showStart(user: UserRecord): Promise<void> {
    if (!user.onboardingCompletedAt && user.onboardingStep < 7) {
      await this.showOnboarding(user, user.onboardingStep > 0 ? user.onboardingStep : 0);
      return;
    }
    await this.showHome(user);
  }

  private async showOnboarding(user: UserRecord, step: number): Promise<void> {
    await this.repo.setOnboardingStep(user.id, step);
    await this.repo.saveSession(user.id, { mode: "onboarding", stack: [], context: { step } });

    const rows =
      step === 0
        ? [[{ text: BUTTONS.start, action: "onboarding:start" }, { text: BUTTONS.skip, action: "onboarding:skip" }]]
        : step === 6
          ? [
              [{ text: BUTTONS.back, action: "onboarding:back", payload: { step } }, { text: BUTTONS.moveData, action: "onboarding:import" }],
              [{ text: BUTTONS.toMain, action: "onboarding:complete" }]
            ]
          : [
              [{ text: BUTTONS.back, action: "onboarding:back", payload: { step } }, { text: BUTTONS.next, action: "onboarding:next", payload: { step } }],
              [{ text: BUTTONS.skip, action: "onboarding:skip" }]
            ];

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `<b>${BOT_TITLE}</b>\n\n${escapeHtml(ONBOARDING_TEXTS[step])}\n\n${onboardingProgress(step)}`,
      reply_markup: kb(rows)
    });
  }

  private async showHome(user: UserRecord, notice?: string): Promise<void> {
    const nowForUser = this.userNow(user.timezoneName);
    const stats = await this.repo.getHomeStats(user.id, nowForUser.date, nowForUser.date.slice(0, 7));
    const queueCount = await this.repo.getQueueCount(user.id);
    const draft = await this.repo.getDraft(user.id);

    const rows: ReturnType<typeof kb>["inline_keyboard"] = [
      [
        { text: BUTTONS.income, callback_data: "a=add%3Astart&type=income" },
        { text: BUTTONS.expense, callback_data: "a=add%3Astart&type=expense" }
      ],
      [
        { text: BUTTONS.operations, callback_data: "a=operations%3Alist&page=0" },
        { text: BUTTONS.report, callback_data: "a=reports%3Aopen" }
      ],
      [
        { text: BUTTONS.categories, callback_data: "a=categories%3Aopen" },
        { text: BUTTONS.settings, callback_data: "a=settings%3Aopen" }
      ]
    ];

    if (stats.totalEntries === 0) {
      rows.push([{ text: BUTTONS.howToUse, callback_data: "a=onboarding%3Ashow&step=0" }]);
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: `${notice ? `${notice}\n\n` : ""}пока записей нет\nможно добавить доход или расход кнопками\nили просто написать запись сообщением\n-450 продукты пятёрочка хлеб`,
        reply_markup: { inline_keyboard: rows }
      });
      return;
    }

    if (draft) {
      rows.push([{ text: BUTTONS.draft, callback_data: "a=draft%3Aopen" }]);
    }
    if (queueCount > 0) {
      rows.push([{ text: `новые записи: ${queueCount}`, callback_data: "a=queue%3Aopen" }]);
    }

    const lastEntry = stats.lastEntry
      ? `${formatAmountByType(stats.lastEntry.amountMinor, stats.lastEntry.type, user.currencyLabel)} · ${stats.lastEntry.categoryName}${stats.lastEntry.subcategoryName ? ` · ${stats.lastEntry.subcategoryName}` : ""}`
      : "нет";

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text:
        `${notice ? `${notice}\n\n` : ""}` +
        `сегодня\nдоход: ${formatAmountByType(stats.todayIncome, "income", user.currencyLabel)}\nрасход: ${formatAmountByType(stats.todayExpense, "expense", user.currencyLabel)}\n\n` +
        `месяц\nдоход: ${formatAmountByType(stats.monthIncome, "income", user.currencyLabel)}\nрасход: ${formatAmountByType(stats.monthExpense, "expense", user.currencyLabel)}\nбаланс: ${formatAmountFromMinor(stats.monthIncome - stats.monthExpense, user.currencyLabel)}\n\n` +
        `последняя запись\n${lastEntry}`,
      reply_markup: { inline_keyboard: rows }
    });
  }

  private async handleAddInput(user: UserRecord, session: UiSession, text: string): Promise<void> {
    const draft = (await this.repo.getDraft(user.id)) ?? { payload: {} as DraftPayload, step: "amount" };
    const payload = draft.payload;

    if (draft.step === "amount") {
      const parsed = parseEntryAttempt(`${payload.type === "income" ? "+" : "-"}${text}`);
      if (!parsed.amountMinor) {
        await this.telegram.sendMessage({ chat_id: user.chatId, text: "Не удалось понять сумму. Напиши сумму ещё раз." });
        return;
      }
      payload.amountMinor = parsed.amountMinor;
      await this.repo.saveDraft(user.id, payload, "category");
      await this.promptAddCategory(user, payload.type ?? "expense");
      return;
    }

    if (draft.step === "category") {
      payload.categoryName = text.trim();
      const category = await this.repo.ensureCategory(user.id, payload.type ?? "expense", payload.categoryName);
      payload.categoryId = category.id;
      const subcategoryCount = user.subcategoriesEnabled ? await this.repo.getSubcategoryCount(user.id, category.id) : 0;
      await this.repo.saveDraft(user.id, payload, subcategoryCount > 0 ? "subcategory" : "description");
      if (subcategoryCount > 0) {
        await this.promptAddSubcategory(user, category.id);
        return;
      }
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "Напиши описание.",
        reply_markup: kb([[{ text: BUTTONS.skip, action: "add:skip-description" }]])
      });
      return;
    }

    if (draft.step === "subcategory") {
      payload.subcategoryName = text.trim();
      await this.repo.saveDraft(user.id, payload, "description");
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "Напиши описание.",
        reply_markup: kb([[{ text: BUTTONS.skip, action: "add:skip-description" }]])
      });
      return;
    }

    await this.finalizeDraft(user, text);
  }

  private async finalizeDraft(user: UserRecord, description: string | undefined): Promise<void> {
    const draft = await this.repo.getDraft(user.id);
    if (!draft?.payload.type || !draft.payload.amountMinor || !draft.payload.categoryName) {
      await this.showHome(user);
      return;
    }

    await this.repo.createEntry({
      user,
      type: draft.payload.type,
      amountMinor: draft.payload.amountMinor,
      categoryName: draft.payload.categoryName,
      subcategoryName: draft.payload.subcategoryName,
      description: description ?? draft.payload.description,
      source: "step"
    });

    await this.repo.deleteDraft(user.id);
    await this.repo.clearSession(user.id);
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "запись добавлена",
      reply_markup: kb([
        [{ text: BUTTONS.income, action: "add:start", payload: { type: "income" } }, { text: BUTTONS.expense, action: "add:start", payload: { type: "expense" } }],
        [{ text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async handleEditInput(user: UserRecord, session: UiSession, text: string): Promise<void> {
    const field = String(session.context.awaitingField ?? "");
    const draft = await this.repo.getDraft(user.id);
    if (!draft) {
      await this.showHome(user);
      return;
    }

    if (field === "amount") {
      const parsed = parseEntryAttempt(`${draft.payload.type === "income" ? "+" : "-"}${text}`);
      if (!parsed.amountMinor) {
        await this.telegram.sendMessage({ chat_id: user.chatId, text: "Не удалось понять сумму. Напиши сумму ещё раз." });
        return;
      }
      draft.payload.amountMinor = parsed.amountMinor;
    } else if (field === "category") {
      draft.payload.categoryName = text.trim();
      draft.payload.subcategoryName = undefined;
    } else if (field === "subcategory") {
      draft.payload.subcategoryName = text.trim();
    } else if (field === "description") {
      draft.payload.description = text.trim();
    }

    await this.repo.saveDraft(user.id, draft.payload, "edit-menu");
    await this.repo.saveSession(user.id, { ...session, context: { ...session.context, awaitingField: undefined } });
    await this.showEditScreen(user);
  }

  private async continueDraft(user: UserRecord): Promise<void> {
    const draft = await this.repo.getDraft(user.id);
    if (!draft) {
      await this.showHome(user);
      return;
    }

    if (draft.step === "amount") {
      await this.telegram.sendMessage({ chat_id: user.chatId, text: "Напиши сумму." });
      return;
    }
    if (draft.step === "category") {
      await this.promptAddCategory(user, draft.payload.type ?? "expense");
      return;
    }
    if (draft.step === "subcategory" && draft.payload.categoryId) {
      await this.promptAddSubcategory(user, draft.payload.categoryId);
      return;
    }
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "Напиши описание или нажми пропустить.",
      reply_markup: kb([[{ text: BUTTONS.skip, action: "add:skip-description" }]])
    });
  }

  private async promptAddCategory(user: UserRecord, type: EntryType): Promise<void> {
    const items = await this.getAddQuickCategories(user, type);
    if (items.length === 0) {
      await this.telegram.sendMessage({ chat_id: user.chatId, text: "Напиши категорию." });
      return;
    }

    const lines = items.map((item, index) => `${index + 1}. ${item.name}`).join("\n");
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `Напиши категорию.\n\n${lines}`,
      reply_markup: kb([
        items.map((item, index) => ({ text: String(index + 1), action: "add:pick-category", payload: { id: item.id } })),
        [{ text: BUTTONS.cancel, action: "add:cancel" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async promptAddSubcategory(user: UserRecord, categoryId: number): Promise<void> {
    const items = await this.getAddQuickSubcategories(user, categoryId);
    if (items.length === 0) {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "Напиши подкатегорию.",
        reply_markup: kb([[{ text: BUTTONS.skip, action: "add:skip-subcategory" }]])
      });
      return;
    }

    const lines = items.map((item, index) => `${index + 1}. ${item.name}`).join("\n");
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `Напиши подкатегорию.\n\n${lines}`,
      reply_markup: kb([
        items.map((item, index) => ({ text: String(index + 1), action: "add:pick-subcategory", payload: { id: item.id } })),
        [{ text: BUTTONS.skip, action: "add:skip-subcategory" }],
        [{ text: BUTTONS.cancel, action: "add:cancel" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async getAddQuickCategories(user: UserRecord, type: EntryType): Promise<CategoryRecord[]> {
    const mode = type === "expense" ? user.quickAccessModeExpense : user.quickAccessModeIncome;
    if (mode === "disabled") {
      return [];
    }
    if (mode === "custom") {
      return this.repo.listQuickAccessCategories(user.id, type);
    }
    return this.repo.listCategories(user.id, type, false, 0, 4, "usage");
  }

  private async getAddQuickSubcategories(user: UserRecord, categoryId: number): Promise<SubcategoryRecord[]> {
    if (!user.subcategoriesEnabled) {
      return [];
    }
    const mode = user.quickAccessModeSubcategories;
    if (mode === "disabled") {
      return [];
    }
    if (mode === "custom") {
      return this.repo.listQuickAccessSubcategories(user.id, categoryId);
    }
    return (await this.repo.getSubcategories(user.id, categoryId, "usage")).slice(0, 4);
  }

  private async pickAddCategory(user: UserRecord, categoryId: number): Promise<void> {
    const draft = await this.repo.getDraft(user.id);
    if (!draft?.payload.type) {
      await this.showHome(user);
      return;
    }
    const category = await this.repo.getCategory(user.id, categoryId);
    if (!category) {
      await this.promptAddCategory(user, draft.payload.type);
      return;
    }

    draft.payload.categoryId = category.id;
    draft.payload.categoryName = category.name;
    draft.payload.subcategoryId = undefined;
    draft.payload.subcategoryName = undefined;

    const subcategoryCount = user.subcategoriesEnabled ? await this.repo.getSubcategoryCount(user.id, category.id) : 0;
    await this.repo.saveDraft(user.id, draft.payload, subcategoryCount > 0 ? "subcategory" : "description");
    if (subcategoryCount > 0) {
      await this.promptAddSubcategory(user, category.id);
      return;
    }
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "Напиши описание.",
      reply_markup: kb([[{ text: BUTTONS.skip, action: "add:skip-description" }]])
    });
  }

  private async pickAddSubcategory(user: UserRecord, subcategoryId: number): Promise<void> {
    const draft = await this.repo.getDraft(user.id);
    if (!draft?.payload.categoryId) {
      await this.showHome(user);
      return;
    }
    const subcategory = await this.repo.getSubcategory(user.id, subcategoryId);
    if (!subcategory) {
      await this.promptAddSubcategory(user, draft.payload.categoryId);
      return;
    }

    draft.payload.subcategoryId = subcategory.id;
    draft.payload.subcategoryName = subcategory.name;
    await this.repo.saveDraft(user.id, draft.payload, "description");
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "Напиши описание.",
      reply_markup: kb([[{ text: BUTTONS.skip, action: "add:skip-description" }]])
    });
  }

  private async skipAddSubcategory(user: UserRecord): Promise<void> {
    const draft = await this.repo.getDraft(user.id);
    if (!draft) {
      await this.showHome(user);
      return;
    }
    draft.payload.subcategoryId = undefined;
    draft.payload.subcategoryName = undefined;
    await this.repo.saveDraft(user.id, draft.payload, "description");
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "Напиши описание.",
      reply_markup: kb([[{ text: BUTTONS.skip, action: "add:skip-description" }]])
    });
  }

  private async showDraft(user: UserRecord): Promise<void> {
    const draft = await this.repo.getDraft(user.id);
    if (!draft) {
      await this.showHome(user);
      return;
    }

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `черновик\n\n${this.describeDraft(draft.payload, user.currencyLabel)}`,
      reply_markup: kb([
        [{ text: BUTTONS.continue, action: "draft:continue" }],
        [{ text: BUTTONS.delete, action: "draft:delete" }],
        [{ text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showQueue(user: UserRecord): Promise<void> {
    const item = await this.repo.getNextQueueItem(user.id);
    if (!item) {
      await this.showHome(user);
      return;
    }
    await this.repo.saveSession(user.id, { mode: "queue", stack: ["home"], context: { queueId: item.id } });
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text:
        `новые записи\n\nиз записи удалось понять:\n${this.describeQueueParsed(item.parsed, user.currencyLabel)}\n\n` +
        (item.missing.length ? `не хватает: ${item.missing.map(formatMissingField).join(", ")}.` : "запись готова к сохранению"),
      reply_markup: kb([
        [
          { text: BUTTONS.save, action: "queue:save-current" },
          { text: BUTTONS.edit, action: "draft:continue" },
          { text: BUTTONS.skip, action: "queue:skip-current" },
          { text: BUTTONS.main, action: "nav:home" }
        ]
      ])
    });
  }

  private async saveQueueItem(user: UserRecord): Promise<void> {
    const item = await this.repo.getNextQueueItem(user.id);
    if (!item) {
      await this.showHome(user);
      return;
    }

    const parsed = item.parsed;
    if (!parsed.type || !parsed.amountMinor || !parsed.category) {
      await this.repo.saveDraft(
        user.id,
        {
          type: parsed.type as EntryType | undefined,
          amountMinor: Number(parsed.amountMinor ?? 0) || undefined,
          categoryName: parsed.category ? String(parsed.category) : undefined,
          subcategoryName: parsed.subcategory ? String(parsed.subcategory) : undefined,
          description: parsed.description ? String(parsed.description) : undefined
        },
        "category"
      );
      await this.repo.saveSession(user.id, { mode: "add", stack: ["queue"], context: { source: "queue", queueId: item.id } });
      await this.continueDraft(user);
      return;
    }

    await this.repo.createEntry({
      user,
      type: String(parsed.type) as EntryType,
      amountMinor: Number(parsed.amountMinor),
      categoryName: String(parsed.category),
      subcategoryName: parsed.subcategory ? String(parsed.subcategory) : undefined,
      description: parsed.description ? String(parsed.description) : undefined,
      source: "queue"
    });
    await this.repo.markQueueItem(user.id, item.id, "saved");
    await this.showQueue(user);
  }

  private async skipQueueItem(user: UserRecord): Promise<void> {
    const item = await this.repo.getNextQueueItem(user.id);
    if (!item) {
      await this.showHome(user);
      return;
    }
    await this.repo.markQueueItem(user.id, item.id, "skipped");
    await this.showQueue(user);
  }

  private async showOperations(user: UserRecord, page: number, selectMode = false): Promise<void> {
    const items = await this.repo.getEntryList(user.id, page);
    if (items.length === 0) {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "пока записей нет\nможно добавить доход или расход с главной",
        reply_markup: kb([[{ text: BUTTONS.main, action: "nav:home" }]])
      });
      return;
    }

    const lines = items.map((item, index) => `${index + 1}. ${formatEntryLine(item, user.currencyLabel)}`).join("\n");
    const session = await this.repo.getSession(user.id);
    const selectedIds = new Set<number>(Array.isArray(session.context.selectedIds) ? (session.context.selectedIds as number[]) : []);
    await this.repo.saveSession(user.id, {
      ...session,
      mode: "operations",
      context: { ...session.context, visibleEntryIds: items.map((item) => item.id), visibleSource: "operations" }
    });
    const numberButtons = items.map((item, index) => ({
      text: selectedIds.has(item.id) ? `✓${index + 1}` : String(index + 1),
      action: selectMode ? "select:toggle" : "operations:view",
      payload: { id: item.id, page, origin: "operations" }
    }));
    const hasSelection = selectedIds.size > 0;

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `операции\n\n${lines}`,
      reply_markup: kb([
        numberButtons,
        [
          {
            text: BUTTONS.multipleSelect,
            action: "operations:select-mode",
            payload: { page }
          }
        ],
        ...(selectMode
          ? [
              [{ text: BUTTONS.chooseAll, action: "select:all", payload: { origin: "operations", page } }],
              ...(hasSelection ? [[{ text: `действия: ${selectedIds.size}`, action: "select:actions", payload: { origin: "operations", page } }]] : [])
            ]
          : []),
        [{ text: BUTTONS.search, action: "search:open" }],
        [{ text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showEntryCard(user: UserRecord, entryId: number, source: "operations" | "search" | "report" | "category", page: number, query?: string): Promise<void> {
    const entry = await this.repo.getEntryById(user.id, entryId);
    if (!entry) {
      await this.showOperations(user, 0);
      return;
    }
    const backText = source === "search" ? BUTTONS.toResults : BUTTONS.back;
    const backAction =
      source === "search"
        ? "search:results"
        : source === "report"
          ? "report:entries"
          : source === "category"
            ? "category:entries"
            : "operations:list";
    const session = await this.repo.getSession(user.id);
    const visibleIds = Array.isArray(session.context.visibleEntryIds) ? (session.context.visibleEntryIds as number[]) : [];
    const currentIndex = visibleIds.indexOf(entryId);
    const prevId = currentIndex > 0 ? visibleIds[currentIndex - 1] : undefined;
    const nextId = currentIndex >= 0 && currentIndex < visibleIds.length - 1 ? visibleIds[currentIndex + 1] : undefined;
    const backPayload =
      source === "search"
        ? { query, page }
        : source === "report"
          ? { page }
          : source === "category"
            ? {
                categoryId: session.context.categoryEntriesCategoryId as number | undefined,
                ...(typeof session.context.categoryEntriesSubcategoryId === "number" ? { id: session.context.categoryEntriesSubcategoryId as number } : {}),
                type: session.context.categoryEntriesType as string | undefined,
                page
              }
          : { page };
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text:
        `${formatAmountByType(entry.amountMinor, entry.type, user.currencyLabel)}\n` +
        `${entry.categoryName}${entry.subcategoryName ? ` / ${entry.subcategoryName}` : ""}\n` +
        `${entry.description ? `${entry.description}\n` : ""}` +
        `${entry.isDateMissing ? "дата не указана" : `${entry.entryDate} ${entry.entryTime ?? ""}`.trim()}\n` +
        `${entry.isTimeAuto ? "время поставлено автоматически" : ""}`,
      reply_markup: kb([
        [{ text: BUTTONS.edit, action: "entry:edit", payload: { id: entry.id, page, source, query } }],
        [{ text: BUTTONS.delete, action: "entry:delete", payload: { id: entry.id, page, source, query } }],
        [
          { text: "◀️", action: prevId ? "entry:move" : "noop", payload: prevId ? { id: prevId, page, source, query } : undefined },
          { text: "▶️", action: nextId ? "entry:move" : "noop", payload: nextId ? { id: nextId, page, source, query } : undefined }
        ],
        [{ text: backText, action: backAction, payload: backPayload }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async startEditEntry(
    user: UserRecord,
    entryId: number,
    page: number,
    source: "operations" | "search" | "report" | "category",
    query?: string
  ): Promise<void> {
    const entry = await this.repo.getEntryById(user.id, entryId);
    if (!entry) {
      await this.showOperations(user, page);
      return;
    }

    await this.repo.saveDraft(
      user.id,
      {
        type: entry.type,
        amountMinor: entry.amountMinor,
        categoryName: entry.categoryName,
        categoryId: entry.categoryId,
        subcategoryName: entry.subcategoryName ?? undefined,
        subcategoryId: entry.subcategoryId ?? undefined,
        description: entry.description ?? undefined,
        entryDate: entry.entryDate,
        entryTime: entry.entryTime,
        isTimeAuto: entry.isTimeAuto,
        isDateMissing: entry.isDateMissing
      },
      "edit-menu"
    );
    await this.repo.saveSession(user.id, {
      mode: "edit",
      stack: [source],
      context: {
        entryId,
        page,
        source,
        query,
        originalDraft: JSON.stringify({
          type: entry.type,
          amountMinor: entry.amountMinor,
          categoryName: entry.categoryName,
          subcategoryName: entry.subcategoryName ?? undefined,
          description: entry.description ?? undefined,
          entryDate: entry.entryDate,
          entryTime: entry.entryTime,
          isTimeAuto: entry.isTimeAuto,
          isDateMissing: entry.isDateMissing
        })
      }
    });
    await this.showEditScreen(user);
  }

  private async showEditScreen(user: UserRecord): Promise<void> {
    const draft = await this.repo.getDraft(user.id);
    const session = await this.repo.getSession(user.id);
    if (!draft) {
      await this.showHome(user);
      return;
    }

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text:
        `изменить\n\n${this.describeDraft(draft.payload, user.currencyLabel)}\n` +
        `${draft.payload.entryDate ? `дата: ${draft.payload.entryDate}\n` : ""}` +
        `${draft.payload.entryTime ? `время: ${draft.payload.entryTime}\n` : ""}`,
      reply_markup: kb([
        [{ text: "сумма", action: "edit:field", payload: { field: "amount" } }],
        [{ text: "категория", action: "edit:field", payload: { field: "category" } }],
        [{ text: "подкатегория", action: "edit:field", payload: { field: "subcategory" } }],
        [{ text: "описание", action: "edit:field", payload: { field: "description" } }],
        [{ text: BUTTONS.save, action: "edit:save" }],
        [{ text: BUTTONS.back, action: "edit:leave", payload: { target: "source" } }, { text: BUTTONS.main, action: "edit:leave", payload: { target: "home" } }]
      ])
    });
  }

  private async promptEditField(user: UserRecord, field: string): Promise<void> {
    const session = await this.repo.getSession(user.id);
    await this.repo.saveSession(user.id, {
      ...session,
      mode: "edit",
      context: { ...session.context, awaitingField: field }
    });

    const prompts: Record<string, string> = {
      amount: "Напиши сумму.",
      category: "Напиши категорию.",
      subcategory: "Напиши подкатегорию.",
      description: "Напиши описание."
    };

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: prompts[field] ?? "Напиши значение.",
      reply_markup: kb([[{ text: BUTTONS.cancel, action: "edit:back" }, { text: BUTTONS.main, action: "nav:home" }]])
    });
  }

  private async saveEditedEntry(user: UserRecord): Promise<void> {
    const session = await this.repo.getSession(user.id);
    const draft = await this.repo.getDraft(user.id);
    if (!draft || !draft.payload.type || !draft.payload.amountMinor || !draft.payload.categoryName) {
      await this.showHome(user);
      return;
    }

    await this.repo.updateEntry(user, Number(session.context.entryId), {
      type: draft.payload.type,
      amountMinor: draft.payload.amountMinor,
      categoryName: draft.payload.categoryName,
      subcategoryName: draft.payload.subcategoryName,
      description: draft.payload.description,
      entryDate: draft.payload.entryDate,
      entryTime: draft.payload.entryTime,
      isTimeAuto: draft.payload.isTimeAuto,
      isDateMissing: draft.payload.isDateMissing
    });

    await this.repo.deleteDraft(user.id);
    await this.repo.saveSession(user.id, { mode: "idle", stack: [], context: {} });
    await this.showEntryCard(
      user,
      Number(session.context.entryId),
      String(session.context.source) === "search" ? "search" : "operations",
      Number(session.context.page ?? 0)
    );
  }

  private async handleEditLeave(user: UserRecord, target: string): Promise<void> {
    const session = await this.repo.getSession(user.id);
    const dirty = await this.isEditDirty(user);
    if (!dirty) {
      await this.discardEditChanges(user, target, false);
      return;
    }

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "Есть несохранённые изменения.\n\nУйти без сохранения?",
      reply_markup: kb([
        [{ text: BUTTONS.save, action: "edit:save" }],
        [{ text: BUTTONS.back, action: "edit:discard", payload: { target } }],
        [{ text: BUTTONS.cancel, action: "edit:back" }]
      ])
    });
  }

  private async discardEditChanges(user: UserRecord, target: string, dropDraft = true): Promise<void> {
    const session = await this.repo.getSession(user.id);
    if (dropDraft) {
      await this.repo.deleteDraft(user.id);
    }
    await this.repo.saveSession(user.id, { mode: "idle", stack: [], context: {} });

    if (target === "home") {
      await this.showHome(user);
      return;
    }

    const source = String(session.context.source ?? "operations");
    const entryId = Number(session.context.entryId);
    const page = Number(session.context.page ?? 0);
    if (source === "search") {
      await this.showEntryCard(user, entryId, "search", page, String(session.context.query ?? ""));
      return;
    }
    if (source === "report") {
      await this.showEntryCard(user, entryId, "report", page);
      return;
    }
    if (source === "category") {
      await this.showEntryCard(user, entryId, "category", page);
      return;
    }
    await this.showEntryCard(user, entryId, "operations", page);
  }

  private async isEditDirty(user: UserRecord): Promise<boolean> {
    const session = await this.repo.getSession(user.id);
    const draft = await this.repo.getDraft(user.id);
    if (!draft) {
      return false;
    }
    const current = JSON.stringify({
      type: draft.payload.type,
      amountMinor: draft.payload.amountMinor,
      categoryName: draft.payload.categoryName,
      subcategoryName: draft.payload.subcategoryName,
      description: draft.payload.description,
      entryDate: draft.payload.entryDate,
      entryTime: draft.payload.entryTime,
      isTimeAuto: draft.payload.isTimeAuto,
      isDateMissing: draft.payload.isDateMissing
    });
    return current !== String(session.context.originalDraft ?? "");
  }

  private async showSearchEntry(user: UserRecord): Promise<void> {
    await this.repo.saveSession(user.id, { mode: "search", stack: ["home"], context: {} });
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "поиск",
      reply_markup: kb([
        [{ text: BUTTONS.enterQuery, action: "search:prompt" }],
        [{ text: BUTTONS.today, action: "search:quick", payload: { period: "today" } }, { text: BUTTONS.yesterday, action: "search:quick", payload: { period: "yesterday" } }],
        [{ text: BUTTONS.week, action: "search:quick", payload: { period: "week" } }, { text: BUTTONS.month, action: "search:quick", payload: { period: "month" } }],
        [{ text: BUTTONS.back, action: "operations:list", payload: { page: 0 } }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showQuickSearch(user: UserRecord, period: string): Promise<void> {
    const baseDate = new Date(`${this.userNow(user.timezoneName).date}T12:00:00Z`);
    const range = parseQuickPeriod(period as "today" | "yesterday" | "week" | "month" | "year" | "all", baseDate);
    await this.showSearchPeriodResults(user, period, 0, range.from, range.to);
  }

  private async showSearchResults(user: UserRecord, query: string, page: number, selectMode = false): Promise<void> {
    const currentSession = await this.repo.getSession(user.id);
    const data = await this.repo.searchEntries(user.id, query, page);
    await this.repo.saveSession(user.id, {
      ...currentSession,
      mode: "search",
      context: { ...currentSession.context, query, visibleEntryIds: data.items.map((item) => item.id), visibleSource: "search" }
    });
    if (data.total === 0) {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: `Запрос: ${query}\nНайдено: 0\n\nПока ничего не найдено.\nМожно сделать новый поиск или вернуться назад.`,
        reply_markup: kb([
          [{ text: BUTTONS.newSearch, action: "search:open" }],
          [{ text: BUTTONS.back, action: "search:open" }, { text: BUTTONS.main, action: "nav:home" }]
        ])
      });
      return;
    }

    const lines = data.items.map((item, index) => `${index + 1}. ${formatEntryLine(item, user.currencyLabel)}${item.description ? ` — ${item.description}` : ""}`).join("\n");
    const session = await this.repo.getSession(user.id);
    const selectedIds = new Set<number>(Array.isArray(session.context.selectedIds) ? (session.context.selectedIds as number[]) : []);
    const numberButtons = data.items.map((item, index) => ({
      text: selectedIds.has(item.id) ? `✓${index + 1}` : String(index + 1),
      action: selectMode ? "select:toggle" : "search:view",
      payload: { id: item.id, page, query, origin: "search" }
    }));

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `запрос: ${query}\nнайдено: ${data.total}\n\n${lines}`,
      reply_markup: kb([
        numberButtons,
        [{ text: BUTTONS.multipleSelect, action: "search:select-mode", payload: { query, page } }],
        ...(selectMode
          ? [
              [{ text: BUTTONS.chooseAll, action: "select:all", payload: { origin: "search", page, query } }],
              ...(selectedIds.size > 0 ? [[{ text: `действия: ${selectedIds.size}`, action: "select:actions", payload: { origin: "search", page, query } }]] : [])
            ]
          : []),
        [{ text: BUTTONS.newSearch, action: "search:open" }],
        [{ text: BUTTONS.back, action: "search:open" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showSearchPeriodResults(
    user: UserRecord,
    periodLabel: string,
    page: number,
    from: string | null,
    to: string | null,
    selectMode = false
  ): Promise<void> {
    const title = periodToLabel(periodLabel);
    const currentSession = await this.repo.getSession(user.id);
    const data = await this.repo.getEntriesByDateRange({
      userId: user.id,
      page,
      from,
      to
    });
    await this.repo.saveSession(user.id, {
      ...currentSession,
      mode: "search",
      context: { ...currentSession.context, query: title, searchPeriod: periodLabel, searchFrom: from, searchTo: to, visibleEntryIds: data.items.map((item) => item.id), visibleSource: "search" }
    });
    if (data.total === 0) {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: `запрос: ${title}\nнайдено: 0\n\nпока ничего не найдено\nможно сделать новый поиск или вернуться назад`,
        reply_markup: kb([
          [{ text: BUTTONS.newSearch, action: "search:open" }],
          [{ text: BUTTONS.back, action: "search:open" }, { text: BUTTONS.main, action: "nav:home" }]
        ])
      });
      return;
    }

    const lines = data.items.map((item, index) => `${index + 1}. ${formatEntryLine(item, user.currencyLabel)}`).join("\n");
    const session = await this.repo.getSession(user.id);
    const selectedIds = new Set<number>(Array.isArray(session.context.selectedIds) ? (session.context.selectedIds as number[]) : []);
    const numberButtons = data.items.map((item, index) => ({
      text: selectedIds.has(item.id) ? `✓${index + 1}` : String(index + 1),
      action: selectMode ? "select:toggle" : "search:view",
      payload: { id: item.id, page, query: title, origin: "search" }
    }));

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `запрос: ${title}\nнайдено: ${data.total}\n\n${lines}`,
      reply_markup: kb([
        numberButtons,
        [{ text: BUTTONS.multipleSelect, action: "search:select-mode", payload: { query: title, page } }],
        ...(selectMode
          ? [
              [{ text: BUTTONS.chooseAll, action: "select:all", payload: { origin: "search", page, query: title } }],
              ...(selectedIds.size > 0 ? [[{ text: `действия: ${selectedIds.size}`, action: "select:actions", payload: { origin: "search", page, query: title } }]] : [])
            ]
          : []),
        [{ text: BUTTONS.newSearch, action: "search:open" }],
        [{ text: BUTTONS.back, action: "search:open" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showReportsEntry(user: UserRecord): Promise<void> {
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "отчёт",
      reply_markup: kb([
        [{ text: BUTTONS.today, action: "reports:quick", payload: { period: "today" } }, { text: BUTTONS.yesterday, action: "reports:quick", payload: { period: "yesterday" } }],
        [{ text: BUTTONS.week, action: "reports:quick", payload: { period: "week" } }, { text: BUTTONS.month, action: "reports:quick", payload: { period: "month" } }],
        [{ text: BUTTONS.year, action: "reports:quick", payload: { period: "year" } }, { text: BUTTONS.allTime, action: "reports:quick", payload: { period: "all" } }],
        [{ text: BUTTONS.customPeriod, action: "reports:custom" }],
        [{ text: BUTTONS.back, action: "nav:home" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showReport(user: UserRecord, period: string): Promise<void> {
    const baseDate = new Date(`${this.userNow(user.timezoneName).date}T12:00:00Z`);
    const range = parseQuickPeriod(period as "today" | "yesterday" | "week" | "month" | "year" | "all", baseDate);
    const title = periodToLabel(period);
    await this.showReportRange(user, title, range.from, range.to, period);
  }

  private async showReportRange(user: UserRecord, title: string, from: string | null, to: string | null, periodKey: string): Promise<void> {
    await this.repo.saveSession(user.id, {
      mode: "reports",
      stack: ["home"],
      context: { reportPeriod: periodKey, reportTitle: title, reportFrom: from, reportTo: to }
    });
    const summary = await this.repo.getSummaryByDateRange(user.id, from, to);
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `доход\n${formatAmountByType(summary.income, "income", user.currencyLabel)}\n\nрасход\n${formatAmountByType(summary.expense, "expense", user.currencyLabel)}\n\nбаланс\n${formatAmountFromMinor(summary.income - summary.expense, user.currencyLabel)}\n\nзаписей\n${summary.entries}`,
      reply_markup: kb([
        [{ text: BUTTONS.expenseBreakdown, action: "reports:breakdown", payload: { type: "expense", page: 0 } }],
        [{ text: BUTTONS.incomeBreakdown, action: "reports:breakdown", payload: { type: "income", page: 0 } }],
        [{ text: BUTTONS.allEntries, action: "report:entries", payload: { page: 0 } }],
        [{ text: BUTTONS.anotherPeriod, action: "reports:open" }],
        [{ text: BUTTONS.back, action: "reports:open" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showReportBreakdown(user: UserRecord, type: EntryType, page: number): Promise<void> {
    const session = await this.repo.getSession(user.id);
    const from = (session.context.reportFrom as string | null | undefined) ?? null;
    const to = (session.context.reportTo as string | null | undefined) ?? null;
    const breakdown = await this.repo.getCategoryBreakdownByDateRange({
      userId: user.id,
      type,
      page,
      from,
      to
    });

    if (breakdown.total === 0) {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: `пока записей нет\nможно выбрать другой период`,
        reply_markup: kb([
          [{ text: BUTTONS.anotherPeriod, action: "reports:open" }],
          [{ text: BUTTONS.back, action: "reports:open" }, { text: BUTTONS.main, action: "nav:home" }]
        ])
      });
      return;
    }

    const lines = breakdown.items
      .map((item, index) => `${index + 1}. ${item.categoryName} · ${formatAmountByType(item.amountMinor, type, user.currencyLabel)} · записей: ${item.entries}`)
      .join("\n");
    const numberButtons = breakdown.items.map((item, index) => ({
      text: String(index + 1),
      action: "report:category",
      payload: { id: item.categoryId, type, page }
    }));

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `${type === "expense" ? "по расходам" : "по доходам"}\n\n${lines}`,
      reply_markup: kb([
        numberButtons,
        [{ text: BUTTONS.back, action: "reports:current" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showReportCategoryCard(user: UserRecord, categoryId: number, type: EntryType, page: number): Promise<void> {
    const session = await this.repo.getSession(user.id);
    const from = (session.context.reportFrom as string | null | undefined) ?? null;
    const to = (session.context.reportTo as string | null | undefined) ?? null;
    const card = await this.repo.getCategoryReportCard({
      userId: user.id,
      categoryId,
      type,
      from,
      to
    });

    if (!card.category) {
      await this.showReportBreakdown(user, type, page);
      return;
    }

    const shareLabel = type === "expense" ? "от всех расходов" : "от всех доходов";
    const shareText = formatShare(card.amountMinor, card.totalByType);
    const subcategoryLines = card.subcategories.length
      ? card.subcategories
          .map((item, index) => `${index + 1}. ${item.subcategoryName} · ${formatAmountByType(item.amountMinor, type, user.currencyLabel)} · записей: ${item.entries}`)
          .join("\n")
      : "подкатегорий пока нет";
    const subcategoryButtons = card.subcategories.length
      ? [
          card.subcategories.map((item, index) => ({
            text: String(index + 1),
            action: "report:subcategory",
            payload: { id: item.subcategoryId, categoryId, type, page }
          }))
        ]
      : [];

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text:
        `${card.category.name}\n\n` +
        `сумма\n${formatAmountByType(card.amountMinor, type, user.currencyLabel)}\n\n` +
        `записей\n${card.entries}\n\n` +
        `${shareLabel}\n${shareText}\n\n` +
        `${subcategoryLines}`,
      reply_markup: kb([
        ...subcategoryButtons,
        [{ text: BUTTONS.allEntries, action: "report:entries", payload: { page: 0, type, categoryId } }],
        [{ text: BUTTONS.back, action: "reports:breakdown", payload: { type, page } }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showReportSubcategoryCard(
    user: UserRecord,
    categoryId: number,
    subcategoryId: number,
    type: EntryType,
    page: number
  ): Promise<void> {
    const session = await this.repo.getSession(user.id);
    const from = (session.context.reportFrom as string | null | undefined) ?? null;
    const to = (session.context.reportTo as string | null | undefined) ?? null;
    const card = await this.repo.getSubcategoryReportCard({
      userId: user.id,
      categoryId,
      subcategoryId,
      type,
      from,
      to
    });

    if (!card.category || !card.subcategory) {
      await this.showReportCategoryCard(user, categoryId, type, page);
      return;
    }

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text:
        `${card.subcategory.name}\n\n` +
        `сумма\n${formatAmountByType(card.amountMinor, type, user.currencyLabel)}\n\n` +
        `записей\n${card.entries}\n\n` +
        `внутри категории\n${formatShare(card.amountMinor, card.totalInCategory)}`,
      reply_markup: kb([
        [{ text: "записи", action: "report:entries", payload: { page: 0, type, categoryId, subcategoryId } }],
        [{ text: BUTTONS.back, action: "report:category", payload: { id: categoryId, type, page } }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showReportEntries(
    user: UserRecord,
    input: { page: number; type?: EntryType; categoryId?: number; subcategoryId?: number },
    selectMode = false
  ): Promise<void> {
    const session = await this.repo.getSession(user.id);
    const from = (session.context.reportFrom as string | null | undefined) ?? null;
    const to = (session.context.reportTo as string | null | undefined) ?? null;
    const data = await this.repo.getEntriesByDateRange({
      userId: user.id,
      page: input.page,
      from,
      to,
      type: input.type,
      categoryId: input.categoryId,
      subcategoryId: input.subcategoryId
    });

    await this.repo.saveSession(user.id, {
      ...session,
      mode: "reports",
      context: {
        ...session.context,
        visibleEntryIds: data.items.map((item) => item.id),
        visibleSource: "report",
        reportEntriesType: input.type,
        reportEntriesCategoryId: input.categoryId,
        reportEntriesSubcategoryId: input.subcategoryId
      }
    });

    if (data.total === 0) {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "пока записей нет\nможно выбрать другой период",
        reply_markup: kb([
          [{ text: BUTTONS.anotherPeriod, action: "reports:open" }],
          [{ text: BUTTONS.back, action: "reports:open" }, { text: BUTTONS.main, action: "nav:home" }]
        ])
      });
      return;
    }

    const lines = data.items.map((item, index) => `${index + 1}. ${formatEntryLine(item, user.currencyLabel)}`).join("\n");
    const selectedIds = new Set<number>(Array.isArray(session.context.selectedIds) ? (session.context.selectedIds as number[]) : []);
    const numberButtons = data.items.map((item, index) => ({
      text: selectedIds.has(item.id) ? `✓${index + 1}` : String(index + 1),
      action: selectMode ? "select:toggle" : "operations:view",
      payload: { id: item.id, page: input.page, origin: "report", source: "report" }
    }));

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `все записи\n\n${lines}`,
      reply_markup: kb([
        numberButtons,
        [
          {
            text: BUTTONS.multipleSelect,
            action: "report:entries-select",
            payload: {
              page: input.page,
              ...(input.type ? { type: input.type } : {}),
              ...(typeof input.categoryId === "number" ? { categoryId: input.categoryId } : {}),
              ...(typeof input.subcategoryId === "number" ? { subcategoryId: input.subcategoryId } : {})
            }
          }
        ],
        ...(selectMode
          ? [
              [
                {
                  text: BUTTONS.chooseAll,
                  action: "select:all",
                  payload: {
                    origin: "report",
                    page: input.page
                  }
                }
              ],
              ...(selectedIds.size > 0 ? [[{ text: `действия: ${selectedIds.size}`, action: "select:actions", payload: { origin: "report", page: input.page } }]] : [])
            ]
          : []),
        [{ text: BUTTONS.back, action: this.reportEntriesBackAction(session, input), payload: this.reportEntriesBackPayload(session, input) }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showCategoryRoot(user: UserRecord): Promise<void> {
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "категории",
      reply_markup: kb([
        [{ text: BUTTONS.expenseCategories, action: "categories:list", payload: { type: "expense", page: 0 } }],
        [{ text: BUTTONS.incomeCategories, action: "categories:list", payload: { type: "income", page: 0 } }],
        [{ text: BUTTONS.back, action: "nav:home" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showCategoryList(user: UserRecord, type: EntryType, page: number): Promise<void> {
    const sortMode = type === "expense" ? user.sortModeExpense : user.sortModeIncome;
    const categories = await this.repo.listCategories(user.id, type, false, page, 6, sortMode);
    const hiddenCount = await this.repo.getHiddenCategoryCount(user.id, type);
    if (categories.length === 0) {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "пока категорий нет\nможно создать категорию",
        reply_markup: kb([
          [{ text: BUTTONS.addCategory, action: "categories:add", payload: { type } }],
          ...(hiddenCount > 0 ? [[{ text: BUTTONS.hidden, action: "categories:hidden", payload: { type, page: 0 } }]] : []),
          [{ text: BUTTONS.back, action: "categories:open" }, { text: BUTTONS.main, action: "nav:home" }]
        ])
      });
      return;
    }

    const lines = categories.map((item, index) => `${index + 1}. ${item.name} · записей: ${item.usageCountCache}`).join("\n");
    const numberButtons = categories.map((item, index) => ({
      text: String(index + 1),
      action: "category:view",
      payload: { id: item.id, page, type }
    }));
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `${type === "expense" ? "расходы" : "доходы"}\n\n${lines}`,
      reply_markup: kb([
        numberButtons,
        [{ text: BUTTONS.addCategory, action: "categories:add", payload: { type } }],
        ...(hiddenCount > 0 ? [[{ text: BUTTONS.hidden, action: "categories:hidden", payload: { type, page: 0 } }]] : []),
        [{ text: BUTTONS.back, action: "categories:open" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showHiddenCategoryList(user: UserRecord, type: EntryType, page: number): Promise<void> {
    const sortMode = type === "expense" ? user.sortModeExpense : user.sortModeIncome;
    const categories = await this.repo.listCategories(user.id, type, true, page, 6, sortMode);
    if (categories.length === 0) {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "пока скрытых категорий нет\nможно вернуться назад",
        reply_markup: kb([[{ text: BUTTONS.back, action: "categories:list", payload: { type, page: 0 } }, { text: BUTTONS.main, action: "nav:home" }]])
      });
      return;
    }

    const lines = categories.map((item, index) => `${index + 1}. ${item.name}`).join("\n");
    const numberButtons = categories.map((item, index) => ({
      text: String(index + 1),
      action: "category:view",
      payload: { id: item.id, page, type }
    }));

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `скрытые\n\n${lines}`,
      reply_markup: kb([
        numberButtons,
        [{ text: BUTTONS.back, action: "categories:list", payload: { type, page: 0 } }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showCategoryCard(user: UserRecord, categoryId: number, type: EntryType, page: number): Promise<void> {
    const category = await this.repo.getCategory(user.id, categoryId);
    if (!category) {
      await this.showCategoryList(user, type, page);
      return;
    }
    const subcategories = await this.repo.getSubcategories(user.id, category.id, user.sortModeSubcategories);
    const usageCount = await this.repo.getCategoryUsageCount(category.id);
    const hiddenSubcategoryCount = await this.repo.getHiddenSubcategoryCount(user.id, category.id);
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text:
        `тип: ${type === "expense" ? "расход" : "доход"}\n` +
        `записей: ${usageCount}\n` +
        `подкатегории:\n${subcategories.length ? subcategories.map((item, index) => `${index + 1}. ${item.name}`).join("\n") : "пока нет"}`,
      reply_markup: kb([
        subcategories.length
          ? subcategories.map((item, index) => ({ text: String(index + 1), action: "subcategory:view", payload: { id: item.id, categoryId: category.id, page, type } }))
          : [{ text: BUTTONS.addSubcategory, action: "subcategory:add", payload: { categoryId: category.id, page, type } }],
        [{ text: BUTTONS.addSubcategory, action: "subcategory:add", payload: { categoryId: category.id, page, type } }],
        ...(hiddenSubcategoryCount > 0 ? [[{ text: BUTTONS.hidden, action: "subcategories:hidden", payload: { categoryId: category.id, page, type } }]] : []),
        [{ text: BUTTONS.edit, action: "category:edit", payload: { id: category.id, page, type } }],
        [{ text: category.hiddenAt ? BUTTONS.restore : BUTTONS.hide, action: category.hiddenAt ? "category:restore" : "category:hide", payload: { id: category.id, page, type } }],
        [{ text: BUTTONS.delete, action: "category:delete", payload: { id: category.id, page, type } }],
        ...(usageCount > 0 ? [[{ text: BUTTONS.transferAllEntries, action: "category:transfer-all", payload: { id: category.id, page, type } }]] : []),
        [{ text: BUTTONS.allEntries, action: "category:entries", payload: { categoryId: category.id, type, page: 0 } }],
        [{ text: BUTTONS.back, action: "categories:list", payload: { type, page } }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showHiddenSubcategoryList(user: UserRecord, categoryId: number, type: EntryType, page: number): Promise<void> {
    const items = await this.repo.listHiddenSubcategories(user.id, categoryId, user.sortModeSubcategories);
    if (items.length === 0) {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "пока скрытых подкатегорий нет\nможно вернуться назад",
        reply_markup: kb([[{ text: BUTTONS.back, action: "category:view", payload: { id: categoryId, type, page } }, { text: BUTTONS.main, action: "nav:home" }]])
      });
      return;
    }

    const lines = items.map((item, index) => `${index + 1}. ${item.name}`).join("\n");
    const numberButtons = items.map((item, index) => ({
      text: String(index + 1),
      action: "subcategory:view",
      payload: { id: item.id, categoryId, type, page }
    }));
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `скрытые\n\n${lines}`,
      reply_markup: kb([
        numberButtons,
        [{ text: BUTTONS.back, action: "category:view", payload: { id: categoryId, type, page } }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showSubcategoryCard(user: UserRecord, subcategoryId: number, categoryId: number, type: EntryType, page: number): Promise<void> {
    const subcategory = await this.repo.getSubcategory(user.id, subcategoryId);
    if (!subcategory) {
      await this.showCategoryCard(user, categoryId, type, page);
      return;
    }
    const usageCount = await this.repo.getSubcategoryUsageCount(subcategoryId);
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `${subcategory.name}\n\nзаписей: ${usageCount}`,
      reply_markup: kb([
        [{ text: BUTTONS.edit, action: "subcategory:edit", payload: { id: subcategory.id, categoryId, page, type } }],
        [{ text: subcategory.hiddenAt ? BUTTONS.restore : BUTTONS.hide, action: subcategory.hiddenAt ? "subcategory:restore" : "subcategory:hide", payload: { id: subcategory.id, categoryId, page, type } }],
        [{ text: BUTTONS.delete, action: "subcategory:delete", payload: { id: subcategory.id, categoryId, page, type } }],
        ...(usageCount > 0 ? [[{ text: BUTTONS.transferAllEntries, action: "subcategory:transfer-all", payload: { id: subcategory.id, categoryId, page, type } }]] : []),
        [{ text: BUTTONS.allEntries, action: "subcategory:entries", payload: { id: subcategory.id, categoryId, type, page: 0 } }],
        [{ text: BUTTONS.back, action: "category:view", payload: { id: categoryId, type, page } }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async handleCategoryDelete(user: UserRecord, categoryId: number, type: EntryType, page: number): Promise<void> {
    const usageCount = await this.repo.getCategoryUsageCount(categoryId);
    if (usageCount > 0) {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "Удалить категорию нельзя, пока в ней есть записи.\n\nМожно скрыть её или потом перенести все записи.",
        reply_markup: kb([
          [{ text: BUTTONS.hide, action: "category:hide", payload: { id: categoryId, page, type } }],
          [{ text: BUTTONS.transferAllEntries, action: "category:transfer-all", payload: { id: categoryId, page, type } }],
          [{ text: BUTTONS.back, action: "category:view", payload: { id: categoryId, page, type } }, { text: BUTTONS.main, action: "nav:home" }]
        ])
      });
      return;
    }
    await this.repo.deleteCategory(user.id, categoryId);
    await this.showCategoryList(user, type, page);
  }

  private async handleSubcategoryDelete(user: UserRecord, subcategoryId: number, categoryId: number, type: EntryType, page: number): Promise<void> {
    const usageCount = await this.repo.getSubcategoryUsageCount(subcategoryId);
    if (usageCount > 0) {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "Удалить подкатегорию нельзя, пока в ней есть записи.\n\nМожно скрыть её или потом перенести все записи.",
        reply_markup: kb([
          [{ text: BUTTONS.hide, action: "subcategory:hide", payload: { id: subcategoryId, categoryId, page, type } }],
          [{ text: BUTTONS.transferAllEntries, action: "subcategory:transfer-all", payload: { id: subcategoryId, categoryId, page, type } }],
          [{ text: BUTTONS.back, action: "subcategory:view", payload: { id: subcategoryId, categoryId, page, type } }, { text: BUTTONS.main, action: "nav:home" }]
        ])
      });
      return;
    }
    await this.repo.deleteSubcategory(user.id, subcategoryId);
    await this.showCategoryCard(user, categoryId, type, page);
  }

  private async startCategoryRename(user: UserRecord, categoryId: number, type: EntryType, page: number): Promise<void> {
    await this.repo.saveSession(user.id, {
      mode: "categories",
      stack: ["categories"],
      context: { awaiting: "rename-category", categoryId, type, page }
    });
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "Напиши новое название категории.",
      reply_markup: kb([[{ text: BUTTONS.cancel, action: "category:view", payload: { id: categoryId, type, page } }, { text: BUTTONS.main, action: "nav:home" }]])
    });
  }

  private async startSubcategoryRename(user: UserRecord, subcategoryId: number, categoryId: number, type: EntryType, page: number): Promise<void> {
    await this.repo.saveSession(user.id, {
      mode: "categories",
      stack: ["categories"],
      context: { awaiting: "rename-subcategory", subcategoryId, categoryId, type, page }
    });
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "Напиши новое название подкатегории.",
      reply_markup: kb([[{ text: BUTTONS.cancel, action: "subcategory:view", payload: { id: subcategoryId, categoryId, type, page } }, { text: BUTTONS.main, action: "nav:home" }]])
    });
  }

  private async handleCategoryCreate(user: UserRecord, type: EntryType, text: string): Promise<void> {
    const existing = await this.repo.findCategoryByNormalizedName(user.id, type, text);
    if (existing?.hiddenAt) {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "Такая категория уже есть в скрытых.\n\nМожно вернуть её.",
        reply_markup: kb([
          [{ text: BUTTONS.restore, action: "category:restore", payload: { id: existing.id, type, page: 0 } }],
          [{ text: BUTTONS.back, action: "categories:list", payload: { type, page: 0 } }, { text: BUTTONS.main, action: "nav:home" }]
        ])
      });
      return;
    }
    await this.repo.ensureCategory(user.id, type, text);
    await this.showCategoryList(user, type, 0);
  }

  private async handleSubcategoryCreate(user: UserRecord, categoryId: number, type: EntryType, page: number, text: string): Promise<void> {
    const existing = await this.repo.findSubcategoryByNormalizedName(categoryId, text);
    if (existing?.hiddenAt) {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "Такая подкатегория уже есть в скрытых.\n\nМожно вернуть её.",
        reply_markup: kb([
          [{ text: BUTTONS.restore, action: "subcategory:restore", payload: { id: existing.id, categoryId, type, page } }],
          [{ text: BUTTONS.back, action: "category:view", payload: { id: categoryId, type, page } }, { text: BUTTONS.main, action: "nav:home" }]
        ])
      });
      return;
    }
    await this.repo.ensureSubcategory(user.id, categoryId, text);
    await this.showCategoryCard(user, categoryId, type, page);
  }

  private async handleCategoryRename(user: UserRecord, categoryId: number, type: EntryType, page: number, text: string): Promise<void> {
    const existing = await this.repo.findCategoryByNormalizedName(user.id, type, text);
    if (existing && existing.id !== categoryId) {
      if (existing.hiddenAt) {
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Такая категория уже есть в скрытых.\n\nМожно вернуть её.",
          reply_markup: kb([
            [{ text: BUTTONS.restore, action: "category:restore", payload: { id: existing.id, type, page: 0 } }],
            [{ text: BUTTONS.back, action: "category:view", payload: { id: categoryId, type, page } }, { text: BUTTONS.main, action: "nav:home" }]
          ])
        });
        return;
      }
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "Такая категория уже есть.",
        reply_markup: kb([[{ text: BUTTONS.back, action: "category:view", payload: { id: categoryId, type, page } }, { text: BUTTONS.main, action: "nav:home" }]])
      });
      return;
    }
    await this.repo.renameCategory(user.id, categoryId, text);
    await this.showCategoryCard(user, categoryId, type, page);
  }

  private async handleSubcategoryRename(user: UserRecord, subcategoryId: number, categoryId: number, type: EntryType, page: number, text: string): Promise<void> {
    const existing = await this.repo.findSubcategoryByNormalizedName(categoryId, text);
    if (existing && existing.id !== subcategoryId) {
      if (existing.hiddenAt) {
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Такая подкатегория уже есть в скрытых.\n\nМожно вернуть её.",
          reply_markup: kb([
            [{ text: BUTTONS.restore, action: "subcategory:restore", payload: { id: existing.id, categoryId, type, page } }],
            [{ text: BUTTONS.back, action: "subcategory:view", payload: { id: subcategoryId, categoryId, type, page } }, { text: BUTTONS.main, action: "nav:home" }]
          ])
        });
        return;
      }
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "Такая подкатегория уже есть.",
        reply_markup: kb([[{ text: BUTTONS.back, action: "subcategory:view", payload: { id: subcategoryId, categoryId, type, page } }, { text: BUTTONS.main, action: "nav:home" }]])
      });
      return;
    }
    await this.repo.renameSubcategory(user.id, subcategoryId, text);
    await this.showSubcategoryCard(user, subcategoryId, categoryId, type, page);
  }

  private async startCategoryTransferAll(user: UserRecord, categoryId: number, type: EntryType, page: number): Promise<void> {
    await this.repo.saveSession(user.id, {
      mode: "categories",
      stack: ["categories"],
      context: { awaiting: "transfer-category-name", categoryId, type, page }
    });
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "Напиши категорию.\n\nЕсли в новой категории нет нужных подкатегорий, подкатегории у записей очистятся.",
      reply_markup: kb([[{ text: BUTTONS.cancel, action: "category:view", payload: { id: categoryId, type, page } }, { text: BUTTONS.main, action: "nav:home" }]])
    });
  }

  private async handleCategoryTransferAll(user: UserRecord, categoryId: number, type: EntryType, page: number, text: string): Promise<void> {
    const result = await this.repo.transferAllCategoryEntries(user, categoryId, type, text);
    if (result === "same") {
      await this.repo.clearSession(user.id);
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "Это уже эта категория.",
        reply_markup: kb([[{ text: BUTTONS.back, action: "category:view", payload: { id: categoryId, type, page } }, { text: BUTTONS.main, action: "nav:home" }]])
      });
      return;
    }
    await this.repo.clearSession(user.id);
    await this.showCategoryCard(user, categoryId, type, page);
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "записи перенесены"
    });
  }

  private async startSubcategoryTransferAll(user: UserRecord, subcategoryId: number, categoryId: number, type: EntryType, page: number): Promise<void> {
    const subcategories = (await this.repo.getSubcategories(user.id, categoryId, user.sortModeSubcategories)).filter((item) => item.id !== subcategoryId && !item.hiddenAt);
    const lines = subcategories.length ? subcategories.slice(0, 6).map((item, index) => `${index + 1}. ${item.name}`).join("\n") : "";
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `перенести все записи\n\n${subcategories.length ? `${lines}\n\nвыбери подкатегорию` : "можно снять подкатегорию у всех записей"}`,
      reply_markup: kb([
        ...(subcategories.length
          ? [subcategories.slice(0, 6).map((item, index) => ({ text: `${index + 1}`, action: "subcategory:transfer-to", payload: { id: subcategoryId, target: item.id, categoryId, type, page } }))]
          : []),
        [{ text: BUTTONS.withoutSubcategory, action: "subcategory:transfer-to", payload: { id: subcategoryId, categoryId, type, page } }],
        [{ text: BUTTONS.back, action: "subcategory:view", payload: { id: subcategoryId, categoryId, type, page } }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async applySubcategoryTransferAll(
    user: UserRecord,
    subcategoryId: number,
    categoryId: number,
    type: EntryType,
    page: number,
    targetSubcategoryId: number | null
  ): Promise<void> {
    await this.repo.transferAllSubcategoryEntries(user.id, subcategoryId, targetSubcategoryId);
    await this.showSubcategoryCard(user, subcategoryId, categoryId, type, page);
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "записи перенесены"
    });
  }

  private async showCategoryEntries(
    user: UserRecord,
    categoryId: number,
    subcategoryId: number | undefined,
    type: EntryType,
    page: number,
    selectMode = false
  ): Promise<void> {
    const data = await this.repo.getEntriesByDateRange({
      userId: user.id,
      page,
      type,
      categoryId,
      subcategoryId
    });

    if (data.total === 0) {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "пока записей нет\nможно вернуться назад",
        reply_markup: kb([[{ text: BUTTONS.back, action: subcategoryId ? "subcategory:view" : "category:view", payload: subcategoryId ? { id: subcategoryId, categoryId, type, page: 0 } : { id: categoryId, type, page: 0 } }, { text: BUTTONS.main, action: "nav:home" }]])
      });
      return;
    }

    const session = await this.repo.getSession(user.id);
    await this.repo.saveSession(user.id, {
      ...session,
      mode: "categories",
      context: {
        ...session.context,
        visibleEntryIds: data.items.map((item) => item.id),
        visibleSource: "category",
        categoryEntriesCategoryId: categoryId,
        categoryEntriesSubcategoryId: subcategoryId,
        categoryEntriesType: type
      }
    });

    const selectedIds = new Set<number>(Array.isArray(session.context.selectedIds) ? (session.context.selectedIds as number[]) : []);
    const lines = data.items.map((item, index) => `${index + 1}. ${formatEntryLine(item, user.currencyLabel)}`).join("\n");
    const numberButtons = data.items.map((item, index) => ({
      text: selectedIds.has(item.id) ? `✓${index + 1}` : String(index + 1),
      action: selectMode ? "select:toggle" : "operations:view",
      payload: { id: item.id, page, source: "category", origin: "category" }
    }));

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `все записи\n\n${lines}`,
      reply_markup: kb([
        numberButtons,
        [
          {
            text: BUTTONS.multipleSelect,
            action: "category:entries-select",
            payload: {
              categoryId,
              ...(typeof subcategoryId === "number" ? { id: subcategoryId } : {}),
              type,
              page
            }
          }
        ],
        ...(selectMode
          ? [
              [{ text: BUTTONS.chooseAll, action: "select:all", payload: { origin: "category", page } }],
              ...(selectedIds.size > 0 ? [[{ text: `действия: ${selectedIds.size}`, action: "select:actions", payload: { origin: "category", page } }]] : [])
            ]
          : []),
        [{ text: BUTTONS.back, action: subcategoryId ? "subcategory:view" : "category:view", payload: subcategoryId ? { id: subcategoryId, categoryId, type, page: 0 } : { id: categoryId, type, page: 0 } }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showSettings(user: UserRecord): Promise<void> {
    await this.telegram.sendMessage({
      chat_id: user.chatId,
        text: "настройки",
      reply_markup: kb([
        [{ text: BUTTONS.currency, action: "settings:currency" }, { text: BUTTONS.time, action: "settings:time" }],
        [{ text: BUTTONS.subcategories, action: "settings:subcategories" }],
        [{ text: BUTTONS.quickAccess, action: "settings:quick-access" }],
        [{ text: BUTTONS.sorting, action: "settings:sorting" }],
        [{ text: BUTTONS.data, action: "data:open" }],
        [{ text: BUTTONS.howToUse, action: "onboarding:show", payload: { step: 0 } }],
        [{ text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showCurrencySettings(user: UserRecord): Promise<void> {
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `валюта\n\nтекущее значение: ${user.currencyLabel}`,
      reply_markup: kb([
        [{ text: BUTTONS.ruble, action: "settings:set-currency", payload: { code: "RUB", label: "₽" } }],
        [{ text: BUTTONS.dollar, action: "settings:set-currency", payload: { code: "USD", label: "$" } }],
        [{ text: BUTTONS.euro, action: "settings:set-currency", payload: { code: "EUR", label: "€" } }],
        [{ text: BUTTONS.another, action: "settings:currency-custom" }],
        [{ text: BUTTONS.back, action: "settings:open" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showTimeSettings(user: UserRecord): Promise<void> {
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `пришли свой город или отправь геопозицию\n\nнапример:\nсанкт-петербург\nмосква\nхельсинки\n\nтекущее значение: ${user.timezoneName}`,
      reply_markup: kb([[{ text: BUTTONS.back, action: "settings:open" }, { text: BUTTONS.main, action: "nav:home" }]])
    });
  }

  private async showSubcategoriesSettings(user: UserRecord): Promise<void> {
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: user.subcategoriesEnabled ? "включены" : "выключены",
      reply_markup: kb([
        [{ text: user.subcategoriesEnabled ? BUTTONS.disable : BUTTONS.enable, action: "settings:set-subcategories", payload: { enabled: user.subcategoriesEnabled ? 0 : 1 } }],
        [{ text: BUTTONS.quickAccess, action: "settings:quick-access-section", payload: { section: "subcategories" } }],
        [{ text: BUTTONS.sorting, action: "settings:sorting-section", payload: { section: "subcategories" } }],
        [{ text: BUTTONS.back, action: "settings:open" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showQuickAccessRoot(user: UserRecord): Promise<void> {
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "быстрый доступ",
      reply_markup: kb([
        [{ text: BUTTONS.expenseCategories, action: "settings:quick-access-section", payload: { section: "expense" } }],
        [{ text: BUTTONS.incomeCategories, action: "settings:quick-access-section", payload: { section: "income" } }],
        [{ text: BUTTONS.subcategories, action: "settings:quick-access-section", payload: { section: "subcategories" } }],
        [{ text: BUTTONS.back, action: "settings:open" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showQuickAccessSection(user: UserRecord, section: string): Promise<void> {
    const current =
      section === "expense"
        ? user.quickAccessModeExpense
        : section === "income"
          ? user.quickAccessModeIncome
          : user.quickAccessModeSubcategories;
    const title = section === "expense" ? BUTTONS.expenseCategories : section === "income" ? BUTTONS.incomeCategories : BUTTONS.subcategories;
    const slots = await this.getQuickAccessSlots(user, section);
    const slotLines = slots.length ? `\n\n${slots.map((item, index) => `${index + 1}. ${item.name}`).join("\n")}` : "";
    const slotRows: Array<Array<{ text: string; action: string; payload?: Record<string, string | number | undefined> }>> = [];
    if (current === "custom") {
      slotRows.push(Array.from({ length: Math.min(slots.length + 1, 4) }, (_, index) => ({ text: String(index + 1), action: "settings:quick-access-slot", payload: { section, slot: index + 1 } })));
      if (slots.length > 0) {
        slotRows.push([{ text: BUTTONS.done, action: "settings:quick-access", payload: { section } }]);
      }
    }
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `${title}\n\nтекущее значение: ${formatQuickAccessMode(current)}${slotLines}`,
      reply_markup: kb([
        [{ text: BUTTONS.automatically, action: "settings:set-quick-access", payload: { section, mode: "automatically" } }],
        [{ text: BUTTONS.own, action: "settings:set-quick-access", payload: { section, mode: "custom" } }],
        [{ text: BUTTONS.off, action: "settings:set-quick-access", payload: { section, mode: "disabled" } }],
        ...slotRows,
        [{ text: BUTTONS.back, action: "settings:quick-access" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async applyQuickAccessMode(user: UserRecord, section: string, mode: string): Promise<void> {
    const field =
      section === "expense"
        ? "quick_access_mode_expense"
        : section === "income"
          ? "quick_access_mode_income"
          : "quick_access_mode_subcategories";
    await this.updateUserSetting(user.id, field, mode);
    await this.showQuickAccessSection(await this.repo.getOrCreateUser(user.telegramUserId, user.chatId), section);
  }

  private async getQuickAccessSlots(user: UserRecord, section: string): Promise<Array<CategoryRecord | SubcategoryRecord>> {
    if (section === "expense" || section === "income") {
      return this.repo.listQuickAccessCategories(user.id, section);
    }
    const categoryId = await this.getLatestQuickAccessSubcategoryCategoryId(user.id);
    if (!categoryId) {
      return [];
    }
    return this.repo.listQuickAccessSubcategories(user.id, categoryId);
  }

  private async showQuickAccessSlotEditor(user: UserRecord, section: string, slot: number, page: number): Promise<void> {
    if (section === "subcategories") {
      await this.showQuickAccessSubcategoryCategoryChooser(user, slot);
      return;
    }
    if (section.startsWith("subcategory:")) {
      const categoryId = Number(section.split(":")[1]);
      const current = await this.repo.listQuickAccessSubcategories(user.id, categoryId);
      const items = (await this.repo.getSubcategories(user.id, categoryId, user.sortModeSubcategories)).slice(page * 6, page * 6 + 6);
      const lines = items.length ? items.map((item, index) => `${index + 1}. ${item.name}`).join("\n") : "пока подкатегорий нет";
      const slotItem = current[slot - 1];
      await this.repo.saveSession(user.id, { mode: "settings", stack: ["settings"], context: { lastQuickAccessCategoryId: categoryId } });
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: `быстрый доступ\n\nслот ${slot}${slotItem ? `: ${slotItem.name}` : ""}\n\n${lines}`,
        reply_markup: kb([
          ...(items.length
            ? [items.map((item, index) => ({ text: String(index + 1), action: "settings:quick-access-slot-pick", payload: { section, slot, id: item.id, page } }))]
            : []),
          ...(slotItem ? [[{ text: BUTTONS.delete, action: "settings:quick-access-slot-clear", payload: { section, slot } }]] : []),
          [{ text: BUTTONS.back, action: "settings:quick-access-section", payload: { section: "subcategories" } }, { text: BUTTONS.main, action: "nav:home" }]
        ])
      });
      return;
    }

    const current = await this.repo.listQuickAccessCategories(user.id, section as EntryType);
    const items = await this.repo.listCategories(user.id, section as EntryType, false, page, 6, "usage");
    const lines = items.length ? items.map((item, index) => `${index + 1}. ${item.name}`).join("\n") : "пока категорий нет";
    const slotItem = current[slot - 1];
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `быстрый доступ\n\nслот ${slot}${slotItem ? `: ${slotItem.name}` : ""}\n\n${lines}`,
      reply_markup: kb([
        ...(items.length
          ? [items.map((item, index) => ({ text: String(index + 1), action: "settings:quick-access-slot-pick", payload: { section, slot, id: item.id, page } }))]
          : []),
        ...(slotItem ? [[{ text: BUTTONS.delete, action: "settings:quick-access-slot-clear", payload: { section, slot } }]] : []),
        [{ text: BUTTONS.back, action: "settings:quick-access-section", payload: { section } }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showQuickAccessSubcategoryCategoryChooser(user: UserRecord, slot: number): Promise<void> {
    const expense = await this.repo.listCategories(user.id, "expense", false, 0, 3, "usage");
    const income = await this.repo.listCategories(user.id, "income", false, 0, 3, "usage");
    const merged = [...expense, ...income].slice(0, 6);
    if (merged.length === 0) {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "пока категорий нет\nможно вернуться назад",
        reply_markup: kb([[{ text: BUTTONS.back, action: "settings:quick-access-section", payload: { section: "subcategories" } }, { text: BUTTONS.main, action: "nav:home" }]])
      });
      return;
    }
    const lines = merged.map((item, index) => `${index + 1}. ${item.name}`).join("\n");
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `подкатегории\n\n${lines}\n\nвыбери категорию`,
      reply_markup: kb([
        merged.map((item, index) => ({ text: String(index + 1), action: "settings:quick-access-slot", payload: { section: `subcategory:${item.id}`, slot } })),
        [{ text: BUTTONS.back, action: "settings:quick-access-section", payload: { section: "subcategories" } }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async applyQuickAccessSlot(user: UserRecord, section: string, slot: number, entityId: number, page: number): Promise<void> {
    if (section.startsWith("subcategory:")) {
      const categoryId = Number(section.split(":")[1]);
      const current = await this.repo.listQuickAccessSubcategories(user.id, categoryId);
      const next = this.applySlotSelection(
        current.map((item) => item.id),
        slot,
        entityId
      );
      await this.repo.updateSubcategoryQuickAccessSlots(user.id, categoryId, next);
      await this.repo.saveSession(user.id, { mode: "settings", stack: ["settings"], context: { lastQuickAccessCategoryId: categoryId } });
      await this.showQuickAccessSection(await this.repo.getOrCreateUser(user.telegramUserId, user.chatId), "subcategories");
      return;
    }

    const current = await this.repo.listQuickAccessCategories(user.id, section as EntryType);
    const next = this.applySlotSelection(
      current.map((item) => item.id),
      slot,
      entityId
    );
    await this.repo.updateCategoryQuickAccessSlots(user.id, section as EntryType, next);
    await this.showQuickAccessSlotEditor(await this.repo.getOrCreateUser(user.telegramUserId, user.chatId), section, slot, page);
  }

  private async clearQuickAccessSlot(user: UserRecord, section: string, slot: number): Promise<void> {
    if (section.startsWith("subcategory:")) {
      const categoryId = Number(section.split(":")[1]);
      const current = await this.repo.listQuickAccessSubcategories(user.id, categoryId);
      const next = current.map((item) => item.id).filter((_, index) => index !== slot - 1);
      await this.repo.updateSubcategoryQuickAccessSlots(user.id, categoryId, next);
      await this.repo.saveSession(user.id, { mode: "settings", stack: ["settings"], context: { lastQuickAccessCategoryId: categoryId } });
      await this.showQuickAccessSection(await this.repo.getOrCreateUser(user.telegramUserId, user.chatId), "subcategories");
      return;
    }

    const current = await this.repo.listQuickAccessCategories(user.id, section as EntryType);
    const next = current.map((item) => item.id).filter((_, index) => index !== slot - 1);
    await this.repo.updateCategoryQuickAccessSlots(user.id, section as EntryType, next);
    await this.showQuickAccessSection(await this.repo.getOrCreateUser(user.telegramUserId, user.chatId), section);
  }

  private applySlotSelection(currentIds: number[], slot: number, entityId: number): number[] {
    const next = currentIds.slice(0, 4);
    const targetIndex = Math.max(0, Math.min(slot - 1, 3));
    const existingIndex = next.indexOf(entityId);

    if (existingIndex >= 0) {
      const swapValue = next[targetIndex];
      next[targetIndex] = entityId;
      if (typeof swapValue === "number") {
        next[existingIndex] = swapValue;
      } else {
        next.splice(existingIndex, 1);
      }
      return next.filter((value, index, array) => typeof value === "number" && array.indexOf(value) === index);
    }

    if (targetIndex >= next.length) {
      next.push(entityId);
      return next;
    }

    next[targetIndex] = entityId;
    return next.filter((value, index, array) => typeof value === "number" && array.indexOf(value) === index);
  }

  private async getLatestQuickAccessSubcategoryCategoryId(userId: number): Promise<number | null> {
    const session = await this.repo.getSession(userId);
    return typeof session.context.lastQuickAccessCategoryId === "number" ? (session.context.lastQuickAccessCategoryId as number) : null;
  }

  private async showSortingRoot(user: UserRecord): Promise<void> {
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "сортировка",
      reply_markup: kb([
        [{ text: BUTTONS.expenseCategories, action: "settings:sorting-section", payload: { section: "expense" } }],
        [{ text: BUTTONS.incomeCategories, action: "settings:sorting-section", payload: { section: "income" } }],
        [{ text: BUTTONS.subcategories, action: "settings:sorting-section", payload: { section: "subcategories" } }],
        [{ text: BUTTONS.back, action: "settings:open" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showSortingSection(user: UserRecord, section: string): Promise<void> {
    const current =
      section === "expense"
        ? user.sortModeExpense
        : section === "income"
          ? user.sortModeIncome
          : user.sortModeSubcategories;
    const title = section === "expense" ? BUTTONS.expenseCategories : section === "income" ? BUTTONS.incomeCategories : BUTTONS.subcategories;
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `${title}\n\nтекущее значение: ${formatSortingMode(current)}`,
      reply_markup: kb([
        [{ text: "по количеству операций", action: "settings:set-sorting", payload: { section, mode: "usage" } }],
        [{ text: "недавние", action: "settings:set-sorting", payload: { section, mode: "recent" } }],
        [{ text: "по алфавиту", action: "settings:set-sorting", payload: { section, mode: "alphabet" } }],
        ...(section === "subcategories" ? [[{ text: BUTTONS.resetToGeneral, action: "settings:set-sorting", payload: { section, mode: "usage" } }]] : []),
        [{ text: BUTTONS.back, action: "settings:sorting" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async applySortingMode(user: UserRecord, section: string, mode: string): Promise<void> {
    const field =
      section === "expense"
        ? "sort_mode_expense"
        : section === "income"
          ? "sort_mode_income"
          : "sort_mode_subcategories";
    await this.updateUserSetting(user.id, field, mode);
    await this.showSortingSection(await this.repo.getOrCreateUser(user.telegramUserId, user.chatId), section);
  }

  private userNow(timezone: string): { date: string; time: string; sort: string } {
    return splitNowForUser(timezone);
  }

  private async showData(user: UserRecord): Promise<void> {
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "данные",
      reply_markup: kb([
        [{ text: BUTTONS.forThisBot, action: "data:this-bot" }],
        [{ text: BUTTONS.forOtherApps, action: "data:other-apps" }],
        [{ text: BUTTONS.resetSettings, action: "data:reset-settings" }],
        [{ text: BUTTONS.clearAll, action: "data:clear-all" }],
        [{ text: BUTTONS.back, action: "settings:open" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showDataThisBot(user: UserRecord): Promise<void> {
    await this.telegram.sendMessage({
      chat_id: user.chatId,
        text: "для этого бота",
      reply_markup: kb([
        [{ text: BUTTONS.saveToFile, action: "data:export-full" }],
        [{ text: BUTTONS.loadFromFile, action: "data:import-full-open" }],
        [{ text: BUTTONS.back, action: "data:open" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showDataOtherApps(user: UserRecord): Promise<void> {
    await this.telegram.sendMessage({
      chat_id: user.chatId,
        text: "в другие приложения",
      reply_markup: kb([
        [{ text: BUTTONS.saveToFile, action: "data:export-entries" }],
        [{ text: BUTTONS.loadFromFile, action: "data:import-entries-open" }],
        [{ text: BUTTONS.back, action: "data:open" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async applyEntriesImport(user: UserRecord, importId: number, mergeOnly: boolean): Promise<void> {
    const pendingImport = await this.repo.getImport(user.id, importId);
    if (!pendingImport) {
      await this.showDataOtherApps(user);
      return;
    }

    const previewEntries = Array.isArray(pendingImport.previewJson.entries)
      ? (pendingImport.previewJson.entries as Array<Record<string, unknown>>)
      : [];
    const existingKeys = mergeOnly ? new Set(await this.repo.getExistingEntryDedupKeys(user.id)) : new Set<string>();
    let added = 0;

    for (const item of previewEntries) {
      const key = makeEntryDedupKey({
        type: String(item.type) as EntryType,
        amountMinor: Number(item.amountMinor),
        entryDate: item.entryDate ? String(item.entryDate) : null,
        entryTime: item.entryTime ? String(item.entryTime) : null,
        categoryName: String(item.categoryName),
        subcategoryName: item.subcategoryName ? String(item.subcategoryName) : null,
        description: item.description ? String(item.description) : null
      });
      if (mergeOnly && existingKeys.has(key)) {
        continue;
      }
      await this.repo.createEntry({
        user,
        type: String(item.type) as EntryType,
        amountMinor: Number(item.amountMinor),
        categoryName: String(item.categoryName),
        subcategoryName: item.subcategoryName ? String(item.subcategoryName) : undefined,
        description: item.description ? String(item.description) : undefined,
        entryDate: item.entryDate ? String(item.entryDate) : null,
        entryTime: item.entryTime ? String(item.entryTime) : null,
        isTimeAuto: Boolean(item.isTimeAuto),
        isDateMissing: Boolean(item.isDateMissing),
        source: "import"
      });
      existingKeys.add(key);
      added += 1;
    }

    await this.repo.deleteImport(user.id, importId);
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `записи добавлены: ${added}`
    });
    await this.showDataOtherApps(user);
  }

  private async showImportFixItem(user: UserRecord, importId: number, index: number): Promise<void> {
    const pendingImport = await this.repo.getImport(user.id, importId);
    if (!pendingImport) {
      await this.showDataOtherApps(user);
      return;
    }

    const errors = Array.isArray(pendingImport.previewJson.errors) ? (pendingImport.previewJson.errors as Array<Record<string, unknown>>) : [];
    const current = errors[index];
    if (!current) {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "проблемных строк больше нет"
      });
      await this.showDataOtherApps(user);
      return;
    }

    const parsed = parseFixCandidate(String(current.rawText ?? ""));
    const understood = this.describeQueueParsed(parsed, user.currencyLabel) || "пока ничего не удалось понять";
    const buttons =
      parsed.type && parsed.amountMinor && parsed.category
        ? [
            [{ text: BUTTONS.save, action: "data:import-fix-save", payload: { importId, index } }],
            [{ text: BUTTONS.edit, action: "data:import-fix-edit", payload: { importId, index } }],
            [{ text: BUTTONS.skip, action: "data:import-fix-skip", payload: { importId, index } }],
            [{ text: BUTTONS.main, action: "nav:home" }]
          ]
        : [
            [{ text: BUTTONS.edit, action: "data:import-fix-edit", payload: { importId, index } }],
            [{ text: BUTTONS.skip, action: "data:import-fix-skip", payload: { importId, index } }],
            [{ text: BUTTONS.main, action: "nav:home" }]
          ];

    await this.repo.saveSession(user.id, {
      mode: "import",
      stack: ["data"],
      context: { importId, fixIndex: index }
    });
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text:
        `исправить\n\n` +
        `строка:\n${String(current.rawText ?? "")}\n\n` +
        `причина:\n${String(current.reason ?? "")}\n\n` +
        `из записи удалось понять:\n${understood}` +
        (!(parsed.type && parsed.amountMinor && parsed.category) ? `\n\nне хватает: ${parsed.missing.map(formatMissingField).join(", ")}` : ""),
      reply_markup: kb(buttons)
    });
  }

  private async handleImportFixInput(user: UserRecord, session: UiSession, text: string): Promise<void> {
    const importId = Number(session.context.importId);
    const index = Number(session.context.fixIndex ?? 0);
    const pendingImport = await this.repo.getImport(user.id, importId);
    if (!pendingImport) {
      await this.showDataOtherApps(user);
      return;
    }
    const preview = pendingImport.previewJson;
    const errors = Array.isArray(preview.errors) ? ([...preview.errors] as Array<Record<string, unknown>>) : [];
    if (!errors[index]) {
      await this.showDataOtherApps(user);
      return;
    }
    errors[index] = {
      ...errors[index],
      rawText: text
    };
    await this.repo.updateImportPreview(user.id, importId, {
      ...preview,
      errors
    });
    await this.showImportFixItem(user, importId, index);
  }

  private async applyImportFixSave(user: UserRecord, importId: number, index: number): Promise<void> {
    const pendingImport = await this.repo.getImport(user.id, importId);
    if (!pendingImport) {
      await this.showDataOtherApps(user);
      return;
    }
    const preview = pendingImport.previewJson;
    const errors = Array.isArray(preview.errors) ? ([...preview.errors] as Array<Record<string, unknown>>) : [];
    const entries = Array.isArray(preview.entries) ? ([...preview.entries] as Array<Record<string, unknown>>) : [];
    const current = errors[index];
    if (!current) {
      await this.showDataOtherApps(user);
      return;
    }
    const parsed = parseFixCandidate(String(current.rawText ?? ""));
    if (!(parsed.type && parsed.amountMinor && parsed.category)) {
      await this.showImportFixItem(user, importId, index);
      return;
    }

    const entry = {
      type: parsed.type,
      amountMinor: parsed.amountMinor,
      categoryName: parsed.category,
      subcategoryName: parsed.subcategory ?? null,
      description: parsed.description ?? null,
      entryDate: null,
      entryTime: null,
      isTimeAuto: true,
      isDateMissing: true
    };

    await this.repo.createEntry({
      user,
      type: entry.type,
      amountMinor: entry.amountMinor,
      categoryName: entry.categoryName,
      subcategoryName: entry.subcategoryName ?? undefined,
      description: entry.description ?? undefined,
      entryDate: null,
      entryTime: null,
      isTimeAuto: true,
      isDateMissing: true,
      source: "import-fix"
    });

    entries.push(entry);
    errors.splice(index, 1);
    await this.repo.updateImportPreview(user.id, importId, {
      ...preview,
      entries,
      errors
    });

    if (errors.length === 0) {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "проблемных строк больше нет"
      });
      await this.showDataOtherApps(user);
      return;
    }

    await this.showImportFixItem(user, importId, Math.min(index, errors.length - 1));
  }

  private async toggleSelection(user: UserRecord, entryId: number, origin: string, page: number): Promise<void> {
    const session = await this.repo.getSession(user.id);
    const selectedIds = new Set<number>(Array.isArray(session.context.selectedIds) ? (session.context.selectedIds as number[]) : []);
    if (selectedIds.has(entryId)) {
      selectedIds.delete(entryId);
    } else {
      selectedIds.add(entryId);
    }
    await this.repo.saveSession(user.id, {
      ...session,
      context: { ...session.context, selectedIds: Array.from(selectedIds) }
    });

    if (origin === "search") {
      if (session.context.searchPeriod) {
        await this.showSearchPeriodResults(
          user,
          String(session.context.searchPeriod),
          page,
          (session.context.searchFrom as string | null | undefined) ?? null,
          (session.context.searchTo as string | null | undefined) ?? null
        );
        return;
      }
      await this.showSearchResults(user, String(session.context.query ?? ""), page, true);
      return;
    }
    if (origin === "report") {
      await this.showReportEntries(
        user,
        {
          page,
          type: typeof session.context.reportEntriesType === "string" ? (String(session.context.reportEntriesType) as EntryType) : undefined,
          categoryId: typeof session.context.reportEntriesCategoryId === "number" ? (session.context.reportEntriesCategoryId as number) : undefined,
          subcategoryId: typeof session.context.reportEntriesSubcategoryId === "number" ? (session.context.reportEntriesSubcategoryId as number) : undefined
        },
        true
      );
      return;
    }
    if (origin === "category") {
      await this.showCategoryEntries(
        user,
        Number(session.context.categoryEntriesCategoryId),
        typeof session.context.categoryEntriesSubcategoryId === "number" ? (session.context.categoryEntriesSubcategoryId as number) : undefined,
        String(session.context.categoryEntriesType) as EntryType,
        page,
        true
      );
      return;
    }
    await this.showOperations(user, page, true);
  }

  private async selectAllOnPage(user: UserRecord, origin: string, page: number): Promise<void> {
    const session = await this.repo.getSession(user.id);
    const selectedIds = new Set<number>(Array.isArray(session.context.selectedIds) ? (session.context.selectedIds as number[]) : []);
    const items =
      origin === "search"
        ? session.context.searchPeriod
          ? (
              await this.repo.getEntriesByDateRange({
                userId: user.id,
                page,
                from: (session.context.searchFrom as string | null | undefined) ?? null,
                to: (session.context.searchTo as string | null | undefined) ?? null
              })
            ).items
          : (await this.repo.searchEntries(user.id, String(session.context.query ?? ""), page)).items
        : origin === "report"
          ? (
              await this.repo.getEntriesByDateRange({
                userId: user.id,
                page,
                from: (session.context.reportFrom as string | null | undefined) ?? null,
                to: (session.context.reportTo as string | null | undefined) ?? null,
                type: typeof session.context.reportEntriesType === "string" ? (String(session.context.reportEntriesType) as EntryType) : undefined,
                categoryId: typeof session.context.reportEntriesCategoryId === "number" ? (session.context.reportEntriesCategoryId as number) : undefined,
                subcategoryId: typeof session.context.reportEntriesSubcategoryId === "number" ? (session.context.reportEntriesSubcategoryId as number) : undefined
              })
            ).items
          : origin === "category"
            ? (
                await this.repo.getEntriesByDateRange({
                  userId: user.id,
                  page,
                  type: String(session.context.categoryEntriesType) as EntryType,
                  categoryId: Number(session.context.categoryEntriesCategoryId),
                  subcategoryId: typeof session.context.categoryEntriesSubcategoryId === "number" ? (session.context.categoryEntriesSubcategoryId as number) : undefined
                })
              ).items
          : await this.repo.getEntryList(user.id, page);
    for (const item of items) {
      selectedIds.add(item.id);
    }
    await this.repo.saveSession(user.id, {
      ...session,
      context: { ...session.context, selectedIds: Array.from(selectedIds) }
    });

    if (origin === "search") {
      if (session.context.searchPeriod) {
        await this.showSearchPeriodResults(
          user,
          String(session.context.searchPeriod),
          page,
          (session.context.searchFrom as string | null | undefined) ?? null,
          (session.context.searchTo as string | null | undefined) ?? null
        );
        return;
      }
      await this.showSearchResults(user, String(session.context.query ?? ""), page, true);
      return;
    }
    if (origin === "report") {
      await this.showReportEntries(
        user,
        {
          page,
          type: typeof session.context.reportEntriesType === "string" ? (String(session.context.reportEntriesType) as EntryType) : undefined,
          categoryId: typeof session.context.reportEntriesCategoryId === "number" ? (session.context.reportEntriesCategoryId as number) : undefined,
          subcategoryId: typeof session.context.reportEntriesSubcategoryId === "number" ? (session.context.reportEntriesSubcategoryId as number) : undefined
        },
        true
      );
      return;
    }
    if (origin === "category") {
      await this.showCategoryEntries(
        user,
        Number(session.context.categoryEntriesCategoryId),
        typeof session.context.categoryEntriesSubcategoryId === "number" ? (session.context.categoryEntriesSubcategoryId as number) : undefined,
        String(session.context.categoryEntriesType) as EntryType,
        page,
        true
      );
      return;
    }
    await this.showOperations(user, page, true);
  }

  private async showBulkActions(user: UserRecord, origin: string, page: number): Promise<void> {
    const session = await this.repo.getSession(user.id);
    const selectedIds = Array.isArray(session.context.selectedIds) ? (session.context.selectedIds as number[]) : [];
    const entries = await Promise.all(selectedIds.map((id) => this.repo.getEntryById(user.id, id)));
    const hasSubcategory = entries.some((entry) => entry?.subcategoryId);

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `действия: ${selectedIds.length}`,
      reply_markup: kb([
        [{ text: BUTTONS.transfer, action: "bulk:transfer", payload: { origin, page } }],
        [{ text: BUTTONS.delete, action: "bulk:delete", payload: { origin, page } }],
        ...(hasSubcategory ? [[{ text: BUTTONS.removeSubcategory, action: "bulk:remove-subcategory", payload: { origin, page } }]] : []),
        [{ text: BUTTONS.cancel, action: "bulk:cancel", payload: { origin, page } }],
        [{ text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async clearBulkSelection(user: UserRecord, origin: string, page: number): Promise<void> {
    const session = await this.repo.getSession(user.id);
    await this.repo.saveSession(user.id, {
      ...session,
      context: { ...session.context, selectedIds: [] }
    });
    if (origin === "search") {
      if (session.context.searchPeriod) {
        await this.showSearchPeriodResults(
          user,
          String(session.context.searchPeriod),
          page,
          (session.context.searchFrom as string | null | undefined) ?? null,
          (session.context.searchTo as string | null | undefined) ?? null
        );
        return;
      }
      await this.showSearchResults(user, String(session.context.query ?? ""), page);
      return;
    }
    if (origin === "report") {
      await this.showReportEntries(user, {
        page,
        type: typeof session.context.reportEntriesType === "string" ? (String(session.context.reportEntriesType) as EntryType) : undefined,
        categoryId: typeof session.context.reportEntriesCategoryId === "number" ? (session.context.reportEntriesCategoryId as number) : undefined,
        subcategoryId: typeof session.context.reportEntriesSubcategoryId === "number" ? (session.context.reportEntriesSubcategoryId as number) : undefined
      });
      return;
    }
    if (origin === "category") {
      await this.showCategoryEntries(
        user,
        Number(session.context.categoryEntriesCategoryId),
        typeof session.context.categoryEntriesSubcategoryId === "number" ? (session.context.categoryEntriesSubcategoryId as number) : undefined,
        String(session.context.categoryEntriesType) as EntryType,
        page
      );
      return;
    }
    await this.showOperations(user, page);
  }

  private async moveEntryCard(user: UserRecord, entryId: number, source: string, page: number): Promise<void> {
    await this.showEntryCard(
      user,
      entryId,
      source === "report" ? "report" : source === "search" ? "search" : source === "category" ? "category" : "operations",
      page
    );
  }

  private async startBulkTransfer(user: UserRecord, origin: string, page: number): Promise<void> {
    const session = await this.repo.getSession(user.id);
    const selectedIds = Array.isArray(session.context.selectedIds) ? (session.context.selectedIds as number[]) : [];
    const entries = (await Promise.all(selectedIds.map((id) => this.repo.getEntryById(user.id, id)))).filter(Boolean) as EntryRecord[];
    const typeSet = new Set(entries.map((entry) => entry.type));

    if (entries.length === 0) {
      await this.clearBulkSelection(user, origin, page);
      return;
    }

    if (typeSet.size > 1) {
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: "Нельзя перенести вместе доходы и расходы.\n\nСними лишний выбор и попробуй ещё раз.",
        reply_markup: kb([
          [{ text: BUTTONS.back, action: "select:actions", payload: { origin, page } }],
          [{ text: BUTTONS.main, action: "nav:home" }]
        ])
      });
      return;
    }

    await this.repo.saveSession(user.id, {
      ...session,
      mode: "operations",
      context: {
        ...session.context,
        awaiting: "bulk-transfer-category",
        bulkOrigin: origin,
        bulkPage: page,
        bulkTransferType: entries[0]?.type
      }
    });

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "Напиши категорию.",
      reply_markup: kb([[{ text: BUTTONS.cancel, action: "select:actions", payload: { origin, page } }, { text: BUTTONS.main, action: "nav:home" }]])
    });
  }

  private async applyBulkTransfer(user: UserRecord): Promise<void> {
    const session = await this.repo.getSession(user.id);
    const selectedIds = Array.isArray(session.context.selectedIds) ? (session.context.selectedIds as number[]) : [];
    const categoryName = String(session.context.transferCategoryName ?? "").trim();
    const subcategoryNameRaw = String(session.context.transferSubcategoryName ?? "").trim();
    const origin = String(session.context.bulkOrigin ?? "operations");
    const page = Number(session.context.bulkPage ?? 0);
    const type = String(session.context.bulkTransferType ?? "") as EntryType;

    if (!selectedIds.length || !categoryName || (type !== "income" && type !== "expense")) {
      await this.showBulkActions(user, origin, page);
      return;
    }

    await this.repo.moveEntriesToCategory({
      user,
      entryIds: selectedIds,
      type,
      categoryName,
      subcategoryName: subcategoryNameRaw || undefined
    });

    await this.repo.saveSession(user.id, {
      ...session,
      mode: "idle",
      context: {
        ...session.context,
        awaiting: undefined,
        transferCategoryName: undefined,
        transferSubcategoryName: undefined,
        bulkTransferType: undefined,
        selectedIds: []
      }
    });

    await this.showBulkResult(user, origin, page, "записи перенесены");
  }

  private async applyBulkDelete(user: UserRecord, origin: string, page: number): Promise<void> {
    const session = await this.repo.getSession(user.id);
    const selectedIds = Array.isArray(session.context.selectedIds) ? (session.context.selectedIds as number[]) : [];
    await this.repo.deleteEntries(user.id, selectedIds);
    await this.repo.saveSession(user.id, {
      ...session,
      context: { ...session.context, selectedIds: [] }
    });
    await this.showBulkResult(user, origin, page, "записи удалены");
  }

  private async applyBulkRemoveSubcategory(user: UserRecord, origin: string, page: number): Promise<void> {
    const session = await this.repo.getSession(user.id);
    const selectedIds = Array.isArray(session.context.selectedIds) ? (session.context.selectedIds as number[]) : [];
    await this.repo.clearSubcategoryForEntries(user.id, selectedIds);
    await this.repo.saveSession(user.id, {
      ...session,
      context: { ...session.context, selectedIds: [] }
    });
    await this.showBulkResult(user, origin, page, "подкатегория снята");
  }

  private async showBulkResult(user: UserRecord, origin: string, page: number, notice: string): Promise<void> {
    if (origin === "search") {
      const session = await this.repo.getSession(user.id);
      if (session.context.searchPeriod) {
        await this.showSearchPeriodResults(
          user,
          String(session.context.searchPeriod),
          page,
          (session.context.searchFrom as string | null | undefined) ?? null,
          (session.context.searchTo as string | null | undefined) ?? null
        );
        return;
      }
      await this.showSearchResults(user, String(session.context.query ?? ""), page);
      return;
    }

    if (origin === "report") {
      const session = await this.repo.getSession(user.id);
      await this.showReportEntries(user, {
        page,
        type: typeof session.context.reportEntriesType === "string" ? (String(session.context.reportEntriesType) as EntryType) : undefined,
        categoryId: typeof session.context.reportEntriesCategoryId === "number" ? (session.context.reportEntriesCategoryId as number) : undefined,
        subcategoryId: typeof session.context.reportEntriesSubcategoryId === "number" ? (session.context.reportEntriesSubcategoryId as number) : undefined
      });
      await this.telegram.sendMessage({
        chat_id: user.chatId,
        text: notice
      });
      return;
    }

    await this.showOperations(user, page);
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: notice
    });
  }

  private reportEntriesBackAction(session: UiSession, input: { type?: EntryType; categoryId?: number; subcategoryId?: number }): string {
    if (typeof input.subcategoryId === "number" && typeof input.categoryId === "number" && input.type) {
      return "report:subcategory";
    }
    if (typeof input.categoryId === "number" && input.type) {
      return "report:category";
    }
    return "reports:current";
  }

  private reportEntriesBackPayload(
    session: UiSession,
    input: { type?: EntryType; categoryId?: number; subcategoryId?: number }
  ): Record<string, string | number | undefined> {
    if (typeof input.subcategoryId === "number" && typeof input.categoryId === "number" && input.type) {
      return { id: input.subcategoryId, categoryId: input.categoryId, type: input.type, page: 0 };
    }
    if (typeof input.categoryId === "number" && input.type) {
      return { id: input.categoryId, type: input.type, page: 0 };
    }
    return {};
  }

  private describeDraft(draft: DraftPayload, currencyLabel: string): string {
    const lines = [
      draft.type ? `тип: ${draft.type === "income" ? "доход" : "расход"}` : undefined,
      draft.amountMinor ? `сумма: ${formatAmountFromMinor(draft.amountMinor, currencyLabel)}` : undefined,
      draft.categoryName ? `категория: ${draft.categoryName}` : undefined,
      draft.subcategoryName ? `подкатегория: ${draft.subcategoryName}` : undefined,
      draft.description ? `описание: ${draft.description}` : undefined
    ].filter(Boolean);
    return lines.join("\n");
  }

  private describeQueueParsed(parsed: Record<string, unknown>, currencyLabel: string): string {
    const draft: DraftPayload = {
      type: parsed.type ? (String(parsed.type) as EntryType) : undefined,
      amountMinor: parsed.amountMinor ? Number(parsed.amountMinor) : undefined,
      categoryName: parsed.category ? String(parsed.category) : undefined,
      subcategoryName: parsed.subcategory ? String(parsed.subcategory) : undefined,
      description: parsed.description ? String(parsed.description) : undefined
    };
    return this.describeDraft(draft, currencyLabel);
  }

  private nextAddStep(draft: DraftPayload): string {
    if (!draft.amountMinor) {
      return "amount";
    }
    if (!draft.categoryName) {
      return "category";
    }
    return "description";
  }

  private async updateUserSetting(userId: number, field: string, value: string | number, secondField?: string, secondValue?: string | number): Promise<void> {
    if (secondField) {
      await this.repo.updateUserFields(userId, {
        [field]: value,
        [secondField]: secondValue ?? null
      });
      return;
    }
    await this.repo.updateUserFields(userId, {
      [field]: value
    });
  }
}

function formatAmountByType(amountMinor: number, type: EntryType, currencyLabel: string): string {
  return type === "expense" ? `-${formatAmountFromMinor(amountMinor, currencyLabel).replace(/^-/, "")}` : formatAmountFromMinor(amountMinor, currencyLabel);
}

function formatEntryLine(item: EntryRecord, currencyLabel: string): string {
  const amount = formatAmountByType(item.amountMinor, item.type, currencyLabel);
  const date = item.isDateMissing ? "дата не указана" : `${item.entryDate} ${item.entryTime ?? ""}`.trim();
  return `${amount} · ${item.categoryName}${item.subcategoryName ? ` · ${item.subcategoryName}` : ""} · ${date}`;
}

function formatMissingField(field: string): string {
  if (field === "type") {
    return "тип";
  }
  if (field === "amount") {
    return "сумма";
  }
  return "категория";
}

function periodToLabel(period: string): string {
  if (period === "today") {
    return BUTTONS.today;
  }
  if (period === "yesterday") {
    return BUTTONS.yesterday;
  }
  if (period === "week") {
    return BUTTONS.week;
  }
  if (period === "month") {
    return BUTTONS.month;
  }
  if (period === "year") {
    return BUTTONS.year;
  }
  if (period === "all") {
    return BUTTONS.allTime;
  }
  return period;
}

function formatShare(part: number, whole: number): string {
  if (whole <= 0) {
    return "0%";
  }
  return `${Math.round((part / whole) * 100)}%`;
}

function formatQuickAccessMode(mode: string): string {
  if (mode === "automatically") {
    return BUTTONS.automatically;
  }
  if (mode === "custom") {
    return BUTTONS.own;
  }
  return BUTTONS.off;
}

function formatSortingMode(mode: string): string {
  if (mode === "recent") {
    return "недавние";
  }
  if (mode === "alphabet") {
    return "по алфавиту";
  }
  return "по количеству операций";
}

function parseFullSnapshot(content: string):
  | {
      raw: Record<string, unknown>;
      categories: number;
      subcategories: number;
      entries: number;
      hasDraft: boolean;
      queue: number;
    }
  | null {
  try {
    const raw = JSON.parse(content) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") {
      return null;
    }
    return {
      raw,
      categories: Array.isArray(raw.categories) ? raw.categories.length : 0,
      subcategories: Array.isArray(raw.subcategories) ? raw.subcategories.length : 0,
      entries: Array.isArray(raw.entries) ? raw.entries.length : 0,
      hasDraft: Boolean(raw.draft),
      queue: Array.isArray(raw.intake_queue) ? raw.intake_queue.length : 0
    };
  } catch {
    return null;
  }
}

export function parseEntriesImport(content: string): {
  entries: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
} {
  const jsonParsed = parseEntriesImportJson(content);
  if (jsonParsed) {
    return jsonParsed;
  }
  const csvParsed = parseEntriesImportCsv(content);
  if (csvParsed) {
    return csvParsed;
  }
  return { entries: [], errors: [{ rawText: "", reason: "файл не удалось прочитать" }] };
}

function parseEntriesImportJson(content: string):
  | {
      entries: Array<Record<string, unknown>>;
      errors: Array<Record<string, unknown>>;
    }
  | null {
  try {
    const raw = JSON.parse(content) as Record<string, unknown>;
    const items = Array.isArray(raw.entries) ? raw.entries : Array.isArray(raw) ? raw : [];
    const entries: Array<Record<string, unknown>> = [];
    const errors: Array<Record<string, unknown>> = [];

    for (const item of items) {
      const parsed = parseImportedEntry(item as Record<string, unknown>);
      if ("error" in parsed) {
        errors.push({
          rawText: stringifyImportRow(item as Record<string, unknown>),
          reason: parsed.error
        });
      } else {
        entries.push(parsed.entry);
      }
    }

    return { entries, errors };
  } catch {
    return null;
  }
}

function parseEntriesImportCsv(content: string):
  | {
      entries: Array<Record<string, unknown>>;
      errors: Array<Record<string, unknown>>;
    }
  | null {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return null;
  }

  const delimiter = detectCsvDelimiter(lines[0]);
  const headers = splitCsvLine(lines[0], delimiter).map(normalizeImportHeader);
  const hasCoreField = headers.includes("type") || headers.includes("amount") || headers.includes("category") || headers.includes("datetime") || headers.includes("date");
  if (!hasCoreField) {
    return null;
  }

  const entries: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];

  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line, delimiter);
    const row: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      row[header] = normalizeImportValue(cells[index] ?? "");
    });

    const parsed = parseImportedEntry(row);
    if ("error" in parsed) {
      errors.push({
        rawText: line,
        reason: parsed.error
      });
    } else {
      entries.push(parsed.entry);
    }
  }

  return { entries, errors };
}

function parseImportedEntry(
  item: Record<string, unknown>
): { entry: Record<string, unknown> } | { error: string } {
  const rawAmount = item.amount_minor ?? item.amount;
  const inferredType = parseImportedType(item.type ?? item.kind ?? item.direction ?? rawAmount);
  const amountMinor = parseImportedAmount(rawAmount);
  const categoryName = String(item.category ?? item.categoryName ?? "").trim();
  const subcategoryName = String(item.subcategory ?? item.subcategoryName ?? "").trim();
  const description = String(item.description ?? item.comment ?? item.note ?? "").trim();
  const dateSource = item.datetime ?? item.date ?? item.entryDate ?? item.createdAt ?? "";
  const timeSource = item.time ?? item.entryTime ?? item.datetime ?? item.createdAt ?? "";
  const parsedDate = parseImportedDate(String(dateSource));
  const parsedTime = parseImportedTime(String(timeSource));

  if (!inferredType) {
    return { error: "не удалось понять тип" };
  }
  if (amountMinor === null) {
    return { error: "не удалось понять сумму" };
  }
  if (!categoryName) {
    return { error: "не удалось понять категорию" };
  }

  return {
    entry: {
      type: inferredType,
      amountMinor,
      categoryName,
      subcategoryName: subcategoryName || null,
      description: description || null,
      entryDate: parsedDate.readable ? parsedDate.value : null,
      entryTime: parsedTime,
      isTimeAuto: !parsedTime,
      isDateMissing: !parsedDate.readable
    }
  };
}

function parseFixCandidate(rawText: string): {
  type?: EntryType;
  amountMinor?: number;
  category?: string;
  subcategory?: string;
  description?: string;
  missing: string[];
} {
  const parsed = parseEntryAttempt(rawText);
  return {
    type: parsed.type,
    amountMinor: parsed.amountMinor,
    category: parsed.category,
    subcategory: parsed.subcategory,
    description: parsed.description,
    missing: parsed.missing
  };
}

function parseImportedAmount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(Math.abs(value) < 100000000 ? Math.abs(value) * 100 : Math.abs(value));
  }
  const raw = String(value ?? "")
    .trim()
    .replace(/\(null\)/gi, "")
    .replace(/\s+/g, "")
    .replace(/[^0-9,.\-+]/g, "");
  if (!raw) {
    return null;
  }
  const normalized = normalizeImportNumber(raw);
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const usesDecimal = /[.,]\d{1,2}$/.test(normalized);
  const abs = Math.abs(numeric);
  return Math.round(abs < 100000000 ? abs * (usesDecimal ? 100 : 1) : abs);
}

function parseImportedDate(value: string): { readable: boolean; value: string | null } {
  const raw = value.trim();
  if (!raw || raw.toLowerCase() === "(null)") {
    return { readable: false, value: null };
  }
  const normalized = raw.replace(/\s+/g, " ").trim();
  const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return { readable: true, value: `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}` };
  }
  const dottedMatch = normalized.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (dottedMatch) {
    const day = dottedMatch[1].padStart(2, "0");
    const month = dottedMatch[2].padStart(2, "0");
    const year = dottedMatch[3];
    return { readable: true, value: `${year}-${month}-${day}` };
  }
  const slashYearFirst = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (slashYearFirst) {
    const month = slashYearFirst[2].padStart(2, "0");
    const day = slashYearFirst[3].padStart(2, "0");
    return { readable: true, value: `${slashYearFirst[1]}-${month}-${day}` };
  }
  const parsed = new Date(normalized.replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) {
    return { readable: false, value: null };
  }
  return { readable: true, value: parsed.toISOString().slice(0, 10) };
}

function parseImportedTime(value: string): string | null {
  const raw = value.trim();
  if (!raw || raw.toLowerCase() === "(null)") {
    return null;
  }
  const match = raw.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (!match) {
    return null;
  }
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function makeEntryDedupKey(entry: {
  type: EntryType;
  amountMinor: number;
  entryDate: string | null;
  entryTime: string | null;
  categoryName: string;
  subcategoryName: string | null;
  description: string | null;
}): string {
  return [
    entry.type,
    String(entry.amountMinor),
    entry.entryDate ?? "",
    entry.entryTime ?? "",
    normalizeName(entry.categoryName),
    normalizeName(entry.subcategoryName ?? ""),
    String(entry.description ?? "").trim().toLowerCase()
  ].join("|");
}

function stringifyImportRow(row: Record<string, unknown>): string {
  return Object.entries(row)
    .map(([key, value]) => `${key}: ${String(value ?? "")}`)
    .join(", ");
}

function splitCsvLine(line: string, delimiter = ","): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  result.push(current.trim());
  return result;
}

function detectCsvDelimiter(headerLine: string): string {
  const delimiters = [",", ";", "\t"];
  let best = ",";
  let bestCount = -1;
  for (const delimiter of delimiters) {
    const count = headerLine.split(delimiter).length;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

function normalizeImportHeader(value: string): string {
  const raw = normalizeName(value).replace(/[^a-zа-я0-9]+/g, " ").trim();
  const map: Record<string, string> = {
    type: "type",
    тип: "type",
    direction: "type",
    kind: "type",
    operation: "type",
    "transaction type": "type",
    amount: "amount",
    "amount minor": "amount",
    amountminor: "amount",
    сумма: "amount",
    value: "amount",
    money: "amount",
    date: "date",
    дата: "date",
    day: "date",
    datetime: "datetime",
    "date time": "datetime",
    "дата время": "datetime",
    "created at": "datetime",
    created: "datetime",
    "время операции": "datetime",
    time: "time",
    время: "time",
    category: "category",
    категория: "category",
    "category name": "category",
    subcategory: "subcategory",
    подкатегория: "subcategory",
    "sub category": "subcategory",
    note: "description",
    notes: "description",
    comment: "description",
    description: "description",
    описание: "description"
  };
  return map[raw] ?? raw;
}

function normalizeImportValue(value: string): string {
  const trimmed = value.trim().replace(/^"(.*)"$/, "$1").trim();
  if (trimmed.toLowerCase() === "(null)") {
    return "";
  }
  return trimmed;
}

function parseImportedType(value: unknown): EntryType | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (["income", "доход", "+", "in", "credit", "deposit"].includes(raw)) {
    return "income";
  }
  if (["expense", "расход", "-", "out", "debit", "withdrawal"].includes(raw)) {
    return "expense";
  }
  if (raw.startsWith("+")) {
    return "income";
  }
  if (raw.startsWith("-")) {
    return "expense";
  }
  return null;
}

function normalizeImportNumber(raw: string): string {
  const commas = (raw.match(/,/g) ?? []).length;
  const dots = (raw.match(/\./g) ?? []).length;
  if (commas > 0 && dots > 0) {
    if (raw.lastIndexOf(",") > raw.lastIndexOf(".")) {
      return raw.replace(/\./g, "").replace(",", ".");
    }
    return raw.replace(/,/g, "");
  }
  if (commas > 0) {
    return raw.replace(",", ".");
  }
  return raw;
}
