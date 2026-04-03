import type { DraftPayload, EntryRecord, EntryType, UiSession, UserRecord } from "@/domain/types";
import type { Repository } from "@/db/repository";
import type { TelegramApi } from "@/telegram/api";
import { BUTTONS, BOT_TITLE, ONBOARDING_TEXTS, onboardingProgress } from "@/ui/text";
import { kb } from "@/ui/keyboard";
import { decodeCallback } from "@/utils/callback";
import { parseQuickPeriod } from "@/utils/dates";
import { parseEntryAttempt } from "@/utils/entry-parser";
import { formatAmountFromMinor } from "@/utils/money";
import { escapeHtml } from "@/utils/normalize";

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
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

    if (session.mode === "search" && session.context.awaiting === "query") {
      await this.repo.saveSession(user.id, { ...session, context: { ...session.context, query: text, awaiting: undefined } });
      await this.showSearchResults(user, text, 0);
      return;
    }

    if (session.mode === "categories" && session.context.awaiting === "new-category") {
      await this.repo.ensureCategory(user.id, String(session.context.type) as EntryType, text);
      await this.showCategoryList(user, String(session.context.type) as EntryType, 0);
      return;
    }

    if (session.mode === "settings" && session.context.awaiting === "currency") {
      await this.updateUserSetting(user.id, "currency_label", text.trim(), "currency_code", "CUSTOM");
      await this.showSettings(user);
      return;
    }

    if (session.mode === "settings" && session.context.awaiting === "timezone") {
      await this.updateUserSetting(user.id, "timezone_name", text.trim(), "timezone_source", "city");
      await this.showTimeSettings(user);
      return;
    }

    if (session.mode === "reports" && session.context.awaiting === "custom-period") {
      const normalized = text.trim().toLowerCase();
      if (normalized === "сегодня") {
        await this.showReport(user, "today");
        return;
      }
      if (normalized === "вчера") {
        await this.showReport(user, "yesterday");
        return;
      }
      if (normalized === "неделя") {
        await this.showReport(user, "week");
        return;
      }
      if (normalized === "месяц") {
        await this.showReport(user, "month");
        return;
      }
      if (normalized === "год") {
        await this.showReport(user, "year");
        return;
      }
      if (normalized === "всё время") {
        await this.showReport(user, "all");
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
      case "operations:view":
        await this.showEntryCard(user, Number(params.id), "operations", Number(params.page ?? "0"));
        return;
      case "entry:edit":
        await this.startEditEntry(user, Number(params.id), Number(params.page ?? "0"), "operations");
        return;
      case "entry:delete":
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Удалить запись?",
          reply_markup: kb([[{ text: BUTTONS.delete, action: "entry:confirm-delete", payload: { id: params.id, page: params.page } }, { text: BUTTONS.back, action: "operations:view", payload: { id: params.id, page: params.page } }]])
        });
        return;
      case "entry:confirm-delete":
        await this.repo.deleteEntry(user.id, Number(params.id));
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
      case "reports:custom":
        await this.repo.saveSession(user.id, { mode: "reports", stack: ["home"], context: { awaiting: "custom-period" } });
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Напиши период сообщением.",
          reply_markup: kb([[{ text: BUTTONS.cancel, action: "reports:open" }, { text: BUTTONS.main, action: "nav:home" }]])
        });
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
      case "data:open":
        await this.showData(user);
        return;
      case "data:this-bot":
        await this.showDataThisBot(user);
        return;
      case "data:other-apps":
        await this.showDataOtherApps(user);
        return;
      case "data:reset-settings":
        await this.repo.resetUserSettings(user.id);
        await this.showData(user);
        return;
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
    const stats = await this.repo.getHomeStats(user.id);
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
      await this.telegram.sendMessage({ chat_id: user.chatId, text: "Напиши категорию." });
      return;
    }

    if (draft.step === "category") {
      payload.categoryName = text.trim();
      const category = await this.repo.ensureCategory(user.id, payload.type ?? "expense", payload.categoryName);
      payload.categoryId = category.id;
      const subcategoryCount = user.subcategoriesEnabled ? await this.repo.getSubcategoryCount(user.id, category.id) : 0;
      await this.repo.saveDraft(user.id, payload, subcategoryCount > 0 ? "subcategory" : "description");
      if (subcategoryCount > 0) {
        await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: "Напиши подкатегорию.",
          reply_markup: kb([[{ text: BUTTONS.skip, action: "add:skip-description" }]])
        });
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
      await this.telegram.sendMessage({ chat_id: user.chatId, text: "Напиши категорию." });
      return;
    }
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "Напиши описание или нажми пропустить.",
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

  private async showOperations(user: UserRecord, page: number): Promise<void> {
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
    const numberButtons = items.map((item, index) => ({
      text: String(index + 1),
      action: "operations:view",
      payload: { id: item.id, page }
    }));

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `операции\n\n${lines}`,
      reply_markup: kb([
        numberButtons,
        [{ text: BUTTONS.multipleSelect, action: "noop" }],
        [{ text: BUTTONS.search, action: "search:open" }],
        [{ text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showEntryCard(user: UserRecord, entryId: number, source: "operations" | "search", page: number, query?: string): Promise<void> {
    const entry = await this.repo.getEntryById(user.id, entryId);
    if (!entry) {
      await this.showOperations(user, 0);
      return;
    }
    const backText = source === "search" ? BUTTONS.toResults : BUTTONS.back;
    const backAction = source === "search" ? "search:results" : "operations:list";
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
        [{ text: BUTTONS.delete, action: "entry:delete", payload: { id: entry.id, page } }],
        [{ text: "◀️", action: "noop" }, { text: "▶️", action: "noop" }],
        [{ text: backText, action: backAction, payload: { query, page } }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async startEditEntry(
    user: UserRecord,
    entryId: number,
    page: number,
    source: "operations" | "search"
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
      context: { entryId, page, source }
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
        [{ text: BUTTONS.back, action: session.context.source === "search" ? "search:view" : "operations:view", payload: { id: session.context.entryId as number, page: session.context.page as number } }, { text: BUTTONS.main, action: "nav:home" }]
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
    const range = parseQuickPeriod(period as "today" | "yesterday" | "week" | "month" | "year" | "all");
    await this.showSearchPeriodResults(user, period, 0, range.from, range.to);
  }

  private async showSearchResults(user: UserRecord, query: string, page: number): Promise<void> {
    const data = await this.repo.searchEntries(user.id, query, page);
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
    const numberButtons = data.items.map((item, index) => ({
      text: String(index + 1),
      action: "search:view",
      payload: { id: item.id, page, query }
    }));

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `запрос: ${query}\nнайдено: ${data.total}\n\n${lines}`,
      reply_markup: kb([
        numberButtons,
        [{ text: BUTTONS.multipleSelect, action: "noop" }],
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
    to: string | null
  ): Promise<void> {
    const data = await this.repo.getEntriesByDateRange({
      userId: user.id,
      page,
      from,
      to
    });

    const title = periodToLabel(periodLabel);
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
    const numberButtons = data.items.map((item, index) => ({
      text: String(index + 1),
      action: "search:view",
      payload: { id: item.id, page, query: title }
    }));

    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `запрос: ${title}\nнайдено: ${data.total}\n\n${lines}`,
      reply_markup: kb([
        numberButtons,
        [{ text: BUTTONS.multipleSelect, action: "noop" }],
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
    const range = parseQuickPeriod(period as "today" | "yesterday" | "week" | "month" | "year" | "all");
    const summary = await this.repo.getSummaryByDateRange(user.id, range.from, range.to);
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: `доход\n${formatAmountByType(summary.income, "income", user.currencyLabel)}\n\nрасход\n${formatAmountByType(summary.expense, "expense", user.currencyLabel)}\n\nбаланс\n${formatAmountFromMinor(summary.income - summary.expense, user.currencyLabel)}\n\nзаписей\n${summary.entries}`,
      reply_markup: kb([
        [{ text: BUTTONS.expenseBreakdown, action: "noop" }],
        [{ text: BUTTONS.incomeBreakdown, action: "noop" }],
        [{ text: BUTTONS.allEntries, action: "operations:list", payload: { page: 0 } }],
        [{ text: BUTTONS.anotherPeriod, action: "reports:open" }],
        [{ text: BUTTONS.back, action: "reports:open" }, { text: BUTTONS.main, action: "nav:home" }]
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
    const categories = await this.repo.listCategories(user.id, type, false, page);
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
    const categories = await this.repo.listCategories(user.id, type, true, page);
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
    const subcategories = await this.repo.getSubcategories(user.id, category.id);
    const usageCount = await this.repo.getCategoryUsageCount(category.id);
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text:
        `тип: ${type === "expense" ? "расход" : "доход"}\n` +
        `записей: ${usageCount}\n` +
        `подкатегории:\n${subcategories.length ? subcategories.map((item, index) => `${index + 1}. ${item.name}`).join("\n") : "пока нет"}`,
      reply_markup: kb([
        subcategories.length ? subcategories.map((_, index) => ({ text: String(index + 1), action: "noop" })) : [{ text: BUTTONS.addSubcategory, action: "noop" }],
        [{ text: BUTTONS.addSubcategory, action: "noop" }],
        [{ text: BUTTONS.edit, action: "noop" }],
        [{ text: category.hiddenAt ? BUTTONS.restore : BUTTONS.hide, action: category.hiddenAt ? "category:restore" : "category:hide", payload: { id: category.id, page, type } }],
        [{ text: BUTTONS.delete, action: "noop" }],
        [{ text: BUTTONS.allEntries, action: "operations:list", payload: { page: 0 } }],
        [{ text: BUTTONS.back, action: "categories:list", payload: { type, page } }, { text: BUTTONS.main, action: "nav:home" }]
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
        [{ text: BUTTONS.quickAccess, action: "noop" }],
        [{ text: BUTTONS.sorting, action: "noop" }],
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
        [{ text: BUTTONS.quickAccess, action: "noop" }],
        [{ text: BUTTONS.sorting, action: "noop" }],
        [{ text: BUTTONS.back, action: "settings:open" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showData(user: UserRecord): Promise<void> {
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "данные",
      reply_markup: kb([
        [{ text: BUTTONS.forThisBot, action: "data:this-bot" }],
        [{ text: BUTTONS.forOtherApps, action: "data:other-apps" }],
        [{ text: BUTTONS.resetSettings, action: "data:reset-settings" }],
        [{ text: BUTTONS.clearAll, action: "noop" }],
        [{ text: BUTTONS.back, action: "settings:open" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showDataThisBot(user: UserRecord): Promise<void> {
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "для этого бота",
      reply_markup: kb([
        [{ text: BUTTONS.saveToFile, action: "noop" }],
        [{ text: BUTTONS.loadFromFile, action: "noop" }],
        [{ text: BUTTONS.back, action: "data:open" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
  }

  private async showDataOtherApps(user: UserRecord): Promise<void> {
    await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: "в другие приложения",
      reply_markup: kb([
        [{ text: BUTTONS.saveToFile, action: "noop" }],
        [{ text: BUTTONS.loadFromFile, action: "noop" }],
        [{ text: BUTTONS.back, action: "data:open" }, { text: BUTTONS.main, action: "nav:home" }]
      ])
    });
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
