import type { AppsScriptBootstrapData } from "@/backend/contracts";
import { AppsScriptClient } from "@/backend/apps-script-client";
import type { Repository } from "@/db/repository";
import type { TelegramApi } from "@/telegram/api";
import { kb } from "@/ui/keyboard";
import { FINANCE_BOT_TITLE, FINANCE_BUTTONS } from "@/ui/finance-text";
import { decodeCallback } from "@/utils/callback";
import { splitNowForUser } from "@/utils/dates";
import { escapeHtml } from "@/utils/normalize";
import { formatTelegramScreenText, isTelegramMessageNotModified } from "@/utils/telegram-text";

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number };
    from?: { id: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message?: {
      message_id: number;
      chat: { id: number };
    };
  };
}

type SheetsFlow = "income" | "expense" | "transfer" | "credit_payment" | "balance";
type SheetsStep =
  | "idle"
  | "amount"
  | "datetime"
  | "datetime_manual"
  | "account"
  | "from_account"
  | "to_account"
  | "credit_account"
  | "category"
  | "subcategory"
  | "balance"
  | "comment"
  | "confirm";

type SheetsContext = {
  screen?: "main" | "more" | "flow" | "directory";
  screenMessageId?: number;
  bootstrap?: AppsScriptBootstrapData;
  bootstrapUpdatedAt?: number;
  awaiting?: "apps_script_url";
  appsScriptUrl?: string;
  appsScriptUrlConfirmedAt?: number;
  flow?: SheetsFlow;
  step?: SheetsStep;
  payload?: Record<string, unknown>;
  page?: number;
  listKind?: "accounts" | "incomeCategories" | "expenseCategories" | "subcategories";
  directoryKind?: "accounts" | "categories" | "subcategories";
  selectedCategory?: string;
  selectedScope?: "income" | "expense";
};

const LIST_PAGE_SIZE = 6;

export class SheetsBotService {
  constructor(
    private readonly repo: Repository,
    private readonly telegram: TelegramApi,
    private readonly appsScriptAuthToken: string
  ) {}

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const target = update.callback_query
      ? {
          fromId: update.callback_query.from.id,
          chatId: update.callback_query.message?.chat.id
        }
      : update.message
        ? {
            fromId: update.message.from?.id,
            chatId: update.message.chat.id
          }
        : null;

    if (!target?.fromId || !target.chatId) {
      return;
    }

    const user = await this.repo.getOrCreateUser(String(target.fromId), String(target.chatId));
    const lockToken = crypto.randomUUID();
    const acquired = await this.repo.tryAcquireUserUpdateLock(user.id, lockToken);
    if (!acquired) {
      return;
    }

    try {
      if (update.callback_query) {
        await this.handleCallback(user, update.callback_query.id, update.callback_query.data);
        return;
      }

      if (update.message?.text) {
        await this.handleMessage(user, update.message.text);
      }
    } finally {
      await this.repo.releaseUserUpdateLock(user.id, lockToken);
    }
  }

  private async handleMessage(user: { id: number; chatId: string; onboardingCompletedAt: string | null; timezoneName: string }, text: string): Promise<void> {
    const session = await this.loadSession(user.id);
    if (text === "/start") {
      await this.repo.completeOnboarding(user.id);
      if (!session.context.appsScriptUrlConfirmedAt) {
        await this.renderAppsScriptSetup(user, session);
        return;
      }
      const configuredUrl = await this.resolveAppsScriptUrl(user.id, session);
      if (!configuredUrl) {
        await this.renderAppsScriptSetup(user, session);
        return;
      }
      const bootstrap = await this.loadBootstrap(user.id, session, true);
      await this.renderMain(user, session, bootstrap);
      return;
    }

    if (session.context.awaiting === "apps_script_url") {
      await this.handleAppsScriptUrlInput(user, session, text);
      return;
    }

    const flow = session.context.flow as SheetsFlow | undefined;
    const step = session.context.step as SheetsStep | undefined;
    if (!flow || !step) {
      return;
    }

    if (step === "amount" || step === "balance" || step === "datetime_manual" || step === "comment") {
      await this.handleTextStep(user, session, text);
    }
  }

  private async handleCallback(user: { id: number; chatId: string; timezoneName: string }, callbackQueryId: string, data?: string): Promise<void> {
    const params = decodeCallback(data);
    const action = params.a;
    const session = await this.loadSession(user.id);

    try {
      switch (action) {
        case "sheet:main": {
          await this.renderMain(user, session);
          break;
        }
        case "sheet:more": {
          await this.renderMore(user, session);
          break;
        }
        case "sheet:refresh": {
          await this.loadBootstrap(user.id, session, true);
          await this.renderMain(user, session);
          break;
        }
        case "sheet:webapp": {
          await this.renderAppsScriptSetup(user, session);
          break;
        }
        case "sheet:webapp-change": {
          await this.renderAppsScriptSetup(user, session);
          break;
        }
        case "sheet:webapp-keep": {
          const configuredUrl = await this.resolveAppsScriptUrl(user.id, session);
          if (!configuredUrl) {
            await this.renderAppsScriptSetup(user, session);
            break;
          }
          const nextSession = this.mergeSession(session, {
            context: {
              ...session.context,
              appsScriptUrlConfirmedAt: Date.now(),
              awaiting: undefined
            }
          });
          await this.saveSession(user.id, nextSession);
          const bootstrap = await this.loadBootstrap(user.id, nextSession, true);
          await this.renderMain(user, nextSession, bootstrap);
          break;
        }
        case "sheet:accounts": {
          await this.renderDirectory(user, session, "accounts");
          break;
        }
        case "sheet:categories": {
          await this.renderDirectory(user, session, "categories");
          break;
        }
        case "sheet:subcategories": {
          await this.renderDirectory(user, session, "subcategories");
          break;
        }
        case "sheet:income":
        case "sheet:expense":
        case "sheet:transfer":
        case "sheet:credit_payment":
        case "sheet:balance": {
          await this.startFlow(user, session, action.replace("sheet:", "") as SheetsFlow);
          break;
        }
        case "sheet:cancel": {
          await this.resetToMain(user, session);
          break;
        }
        case "sheet:back": {
          await this.goBack(user, session);
          break;
        }
        case "sheet:confirm": {
          await this.submitFlow(user, session);
          break;
        }
        case "sheet:manual": {
          await this.setStep(user, session, "datetime_manual");
          await this.renderFlow(user, session, "введи дату и время в формате 09.05.2026 21:40");
          break;
        }
        case "sheet:now": {
          await this.setDateTimeStep(user, session, "now");
          break;
        }
        case "sheet:today": {
          await this.setDateTimeStep(user, session, "today");
          break;
        }
        case "sheet:yesterday": {
          await this.setDateTimeStep(user, session, "yesterday");
          break;
        }
        case "sheet:tomorrow": {
          await this.setDateTimeStep(user, session, "tomorrow");
          break;
        }
        case "sheet:pick": {
          const index = Number(params.i);
          await this.pickFromList(user, session, index);
          break;
        }
        case "sheet:page-prev": {
          await this.changePage(user, session, -1);
          break;
        }
        case "sheet:page-next": {
          await this.changePage(user, session, 1);
          break;
        }
        case "sheet:without-subcategory": {
          const nextSession = this.mergeSession(session, {
            context: {
              ...session.context,
              payload: {
                ...(session.context.payload as Record<string, unknown> | undefined),
                subcategory: "без подкатегории"
              },
              step: "comment",
              listKind: undefined,
              page: 0
            }
          });
          await this.saveSession(user.id, nextSession);
          await this.renderFlow(user, nextSession);
          break;
        }
        default: {
          await this.renderMain(user, session);
          break;
        }
      }
    } catch (error) {
      console.error("telegram callback failed", error);
      await this.renderError(user, session, error instanceof Error ? error.message : "ошибка обработки кнопки");
    } finally {
      await this.telegram.answerCallbackQuery(callbackQueryId).catch(() => undefined);
    }
  }

  private async startFlow(user: { id: number; chatId: string; timezoneName: string }, session: { mode: string; stack: string[]; context: Record<string, unknown> }, flow: SheetsFlow): Promise<void> {
    const nextSession = this.mergeSession(session, {
      mode: "add",
      stack: [flow],
      context: {
        ...session.context,
        flow,
        step: flow === "balance" ? "account" : "amount",
        payload: {},
        page: 0,
        listKind: undefined,
        selectedCategory: undefined,
        selectedScope: undefined
      }
    });
    await this.saveSession(user.id, nextSession);
    await this.renderFlow(user, nextSession);
  }

   private async renderMain(
    user: { id: number; chatId: string; timezoneName: string },
    session: { mode: string; stack: string[]; context: Record<string, unknown> },
    bootstrap?: AppsScriptBootstrapData
  ): Promise<void> {
    const configuredUrl = await this.resolveAppsScriptUrl(user.id, session);
    if (!configuredUrl) {
      await this.renderAppsScriptSetup(user, session);
      return;
    }
    const nextSession = this.mergeSession(session, {
      mode: "idle",
      stack: ["main"],
      context: {
        ...session.context,
        screen: "main",
        flow: undefined,
        step: undefined,
        payload: {},
        page: 0,
        listKind: undefined,
        directoryKind: undefined,
        selectedCategory: undefined,
        selectedScope: undefined
      }
    });
    await this.saveSession(user.id, nextSession);
    const finalBootstrap = bootstrap ?? (await this.loadBootstrap(user.id, nextSession));
    const text = this.buildMainText(finalBootstrap);
    const reply_markup = kb([
      [
        { text: FINANCE_BUTTONS.income, action: "sheet:income" },
        { text: FINANCE_BUTTONS.expense, action: "sheet:expense" }
      ],
      [
        { text: FINANCE_BUTTONS.transfer, action: "sheet:transfer" },
        { text: FINANCE_BUTTONS.creditPayment, action: "sheet:credit_payment" }
      ],
      [{ text: FINANCE_BUTTONS.more, action: "sheet:more" }]
    ]);
    await this.sendOrEdit(user, nextSession, text, reply_markup);
  }

  private async renderMore(
    user: { id: number; chatId: string; timezoneName: string },
    session: { mode: string; stack: string[]; context: Record<string, unknown> }
  ): Promise<void> {
    const configuredUrl = await this.resolveAppsScriptUrl(user.id, session);
    if (!configuredUrl) {
      await this.renderAppsScriptSetup(user, session);
      return;
    }
    const nextSession = this.mergeSession(session, {
      mode: "idle",
      stack: ["more"],
      context: {
        ...session.context,
        screen: "more",
        flow: undefined,
        step: undefined,
        page: 0,
        directoryKind: undefined,
        selectedCategory: undefined,
        selectedScope: undefined
      }
    });
    await this.saveSession(user.id, nextSession);
    const current = await this.resolveAppsScriptUrl(user.id, session);
    const webAppButton = current ? { text: FINANCE_BUTTONS.webAppChange, action: "sheet:webapp-change" } : { text: FINANCE_BUTTONS.webApp, action: "sheet:webapp" };
    const text = `${FINANCE_BOT_TITLE}\n\nслужебные действия`;
    const reply_markup = kb([
      [
        { text: FINANCE_BUTTONS.balance, action: "sheet:balance" },
        { text: FINANCE_BUTTONS.accounts, action: "sheet:accounts" }
      ],
      [
        { text: FINANCE_BUTTONS.categories, action: "sheet:categories" },
        { text: FINANCE_BUTTONS.subcategories, action: "sheet:subcategories" }
      ],
      [webAppButton],
      [{ text: FINANCE_BUTTONS.refresh, action: "sheet:refresh" }],
      [{ text: FINANCE_BUTTONS.back, action: "sheet:main" }]
    ]);
    await this.sendOrEdit(user, nextSession, text, reply_markup);
  }

  private async renderAppsScriptSetup(
    user: { id: number; chatId: string; timezoneName: string },
    session: { mode: string; stack: string[]; context: Record<string, unknown> }
  ): Promise<void> {
    const current = await this.resolveAppsScriptUrl(user.id, session);
    const nextSession = this.mergeSession(session, {
      mode: "idle",
      stack: ["setup"],
      context: {
        ...session.context,
        screen: "main",
        awaiting: "apps_script_url",
        flow: undefined,
        step: undefined,
        page: 0,
        listKind: undefined,
        directoryKind: undefined,
        selectedCategory: undefined,
        selectedScope: undefined
      }
    });
    await this.saveSession(user.id, nextSession);
    const text = formatTelegramScreenText(
      [
        FINANCE_BOT_TITLE,
        "",
        "нужна ссылка на web app таблицы",
        current ? "ссылка уже настроена" : "ссылка пока не задана",
        "",
        "пришли url web app одним сообщением"
      ].join("\n")
    );
    const rows: Array<Array<{ text: string; action: string }>> = [];
    if (current) {
      rows.push([
        { text: FINANCE_BUTTONS.webAppKeep, action: "sheet:webapp-keep" },
        { text: FINANCE_BUTTONS.webAppChange, action: "sheet:webapp-change" }
      ]);
    }
    rows.push([{ text: FINANCE_BUTTONS.cancel, action: "sheet:cancel" }]);
    await this.sendOrEdit(user, nextSession, text, kb(rows));
  }

  private async handleAppsScriptUrlInput(
    user: { id: number; chatId: string; timezoneName: string },
    session: { mode: string; stack: string[]; context: Record<string, unknown> },
    text: string
  ): Promise<void> {
    const trimmed = text.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      await this.renderError(user, session, "пришли полный url web app");
      return;
    }

    if (parsed.protocol !== "https:" || !parsed.hostname.includes("script.google.com")) {
      await this.renderError(user, session, "нужен https url web app google apps script");
      return;
    }

    await this.repo.setBotSetting(this.appsScriptUrlKey(user.id), parsed.toString());
    const nextSession = this.mergeSession(session, {
      context: {
        ...session.context,
        appsScriptUrl: parsed.toString(),
        awaiting: undefined,
        appsScriptUrlConfirmedAt: Date.now()
      }
    });
    await this.saveSession(user.id, nextSession);
    const bootstrap = await this.loadBootstrap(user.id, nextSession, true);
    await this.renderMain(user, nextSession, bootstrap);
  }

  private async renderFlow(
    user: { id: number; chatId: string; timezoneName: string },
    session: { mode: string; stack: string[]; context: Record<string, unknown> },
    overrideText?: string
  ): Promise<void> {
    const configuredUrl = await this.resolveAppsScriptUrl(user.id, session);
    if (!configuredUrl) {
      await this.renderAppsScriptSetup(user, session);
      return;
    }
    const nextSession = this.mergeSession(session, {
      mode: "add",
      stack: Array.isArray(session.stack) && session.stack.length > 0 ? session.stack : [String(session.context.flow ?? "flow")],
      context: {
        ...session.context,
        screen: "flow"
      }
    });
    await this.saveSession(user.id, nextSession);
    const bootstrap = await this.loadBootstrap(user.id, nextSession);
    const flow = nextSession.context.flow as SheetsFlow;
    const step = nextSession.context.step as SheetsStep;
    const payload = (nextSession.context.payload as Record<string, unknown> | undefined) ?? {};

    const text =
      overrideText ??
      this.buildFlowText(flow, step, payload, bootstrap, user.timezoneName, nextSession.context.selectedCategory as string | undefined);
    const reply_markup = this.buildFlowKeyboard(
      flow,
      step,
      bootstrap,
      payload,
      Number(nextSession.context.page ?? 0),
      nextSession.context.selectedCategory as string | undefined
    );
    await this.sendOrEdit(user, nextSession, text, reply_markup);
  }

  private async renderDirectory(
    user: { id: number; chatId: string; timezoneName: string },
    session: { mode: string; stack: string[]; context: Record<string, unknown> },
    kind: "accounts" | "categories" | "subcategories"
  ): Promise<void> {
    const configuredUrl = await this.resolveAppsScriptUrl(user.id, session);
    if (!configuredUrl) {
      await this.renderAppsScriptSetup(user, session);
      return;
    }
    const nextSession = this.mergeSession(session, {
      mode: "idle",
      stack: ["more", kind],
      context: {
        ...session.context,
        screen: "directory",
        directoryKind: kind,
        flow: undefined,
        step: undefined,
        page: 0,
        listKind: kind,
        selectedCategory: undefined,
        selectedScope: undefined
      }
    });
    await this.saveSession(user.id, nextSession);
    const bootstrap = await this.loadBootstrap(user.id, nextSession);
    const text = this.buildDirectoryText(kind, bootstrap, 0);
    const reply_markup = this.buildDirectoryKeyboard(kind, 0, bootstrap);
    await this.sendOrEdit(user, nextSession, text, reply_markup);
  }

  private buildMainText(bootstrap: AppsScriptBootstrapData): string {
    const overview = (bootstrap.overview as Record<string, unknown> | undefined) ?? {};
    const available = this.readOverviewValue(overview, ["available", "доступно", "available_amount"]);
    const assets = this.readOverviewValue(overview, ["assets", "активы", "total_assets"]);
    const income = this.readOverviewValue(overview, ["incomeMonth", "income_month", "доходы месяца", "income"]);
    const expense = this.readOverviewValue(overview, ["expenseMonth", "expense_month", "расходы месяца", "expense"]);
    const debt = this.readOverviewValue(overview, ["debt", "к возврату", "debt_to_return", "return_debt"]);
    return formatTelegramScreenText(
      [
        FINANCE_BOT_TITLE,
        "",
        `доступно: ${available}`,
        `активы: ${assets}`,
        `доходы месяца: ${income}`,
        `расходы месяца: ${expense}`,
        `к возврату: ${debt}`
      ].join("\n")
    );
  }

  private buildFlowText(
    flow: SheetsFlow,
    step: SheetsStep,
    payload: Record<string, unknown>,
    bootstrap: AppsScriptBootstrapData,
    timezone: string,
    selectedCategory?: string
  ): string {
    const title = this.flowLabel(flow);
    const summary = this.payloadSummary(flow, payload, timezone);
    const prompt = this.stepPrompt(flow, step);

    if (step === "account" || step === "from_account" || step === "to_account" || step === "credit_account") {
      return formatTelegramScreenText([title, "", ...summary, "", prompt].join("\n"));
    }

    if (step === "category") {
      return formatTelegramScreenText([title, "", ...summary, "", prompt].join("\n"));
    }

    if (step === "subcategory") {
      const category = selectedCategory ? `\nкатегория: ${selectedCategory}` : "";
      return formatTelegramScreenText([title, "", ...summary, category, "", prompt].join("\n"));
    }

    if (step === "confirm") {
      return formatTelegramScreenText([title, "", ...summary, "", "подтверждение"].join("\n"));
    }

    return formatTelegramScreenText([title, "", ...summary, "", prompt].join("\n"));
  }

  private payloadSummary(flow: SheetsFlow, payload: Record<string, unknown>, timezone: string): string[] {
    const lines: string[] = [];
    const amount = payload.amount ?? payload.balance;
    if (amount !== undefined) {
      lines.push(`сумма: ${amount}`);
    }
    if (payload.datetime) {
      lines.push(`дата и время: ${payload.datetime}`);
    }
    if (flow === "income" || flow === "expense") {
      if (payload.account) {
        lines.push(`счёт: ${payload.account}`);
      }
      if (payload.category) {
        lines.push(`категория: ${payload.category}`);
      }
      if (payload.subcategory) {
        lines.push(`подкатегория: ${payload.subcategory}`);
      }
      if (payload.comment !== undefined) {
        lines.push(`комментарий: ${payload.comment || "—"}`);
      }
    } else if (flow === "transfer") {
      if (payload.from_account) {
        lines.push(`откуда: ${payload.from_account}`);
      }
      if (payload.to_account) {
        lines.push(`куда: ${payload.to_account}`);
      }
      if (payload.comment !== undefined) {
        lines.push(`комментарий: ${payload.comment || "—"}`);
      }
    } else if (flow === "credit_payment") {
      if (payload.from_account) {
        lines.push(`откуда: ${payload.from_account}`);
      }
      if (payload.credit_account) {
        lines.push(`кредитка: ${payload.credit_account}`);
      }
      if (payload.comment !== undefined) {
        lines.push(`комментарий: ${payload.comment || "—"}`);
      }
    } else if (flow === "balance") {
      if (payload.account) {
        lines.push(`счёт: ${payload.account}`);
      }
      if (payload.comment !== undefined) {
        lines.push(`комментарий: ${payload.comment || "—"}`);
      }
    }
    return lines;
  }

  private stepPrompt(flow: SheetsFlow, step: SheetsStep): string {
    const title = this.flowLabel(flow);
    switch (step) {
      case "amount":
        return `${title}\n\nвведи сумму`;
      case "datetime":
        return `${title}\n\nвыбери дату и время`;
      case "datetime_manual":
        return `${title}\n\nвведи дату и время в формате 09.05.2026 21:40`;
      case "account":
      case "from_account":
      case "to_account":
      case "credit_account":
        return `${title}\n\nвыбери счёт`;
      case "category":
        return `${title}\n\nвыбери категорию`;
      case "subcategory":
        return `${title}\n\nвыбери подкатегорию`;
      case "balance":
        return `${title}\n\nвведи баланс`;
      case "comment":
        return `${title}\n\nвведи комментарий`;
      case "confirm":
        return `${title}\n\nподтверждение`;
      default:
        return title;
    }
  }

  private buildFlowKeyboard(
    flow: SheetsFlow,
    step: SheetsStep,
    bootstrap: AppsScriptBootstrapData,
    payload: Record<string, unknown>,
    page: number,
    selectedCategory?: string
  ) {
    if (step === "amount" || step === "comment" || step === "datetime_manual" || step === "balance") {
      return kb([
        [{ text: FINANCE_BUTTONS.cancel, action: "sheet:cancel" }],
        [{ text: FINANCE_BUTTONS.back, action: "sheet:back" }]
      ]);
    }

    if (step === "datetime") {
      return kb([
        [
          { text: FINANCE_BUTTONS.now, action: "sheet:now" },
          { text: FINANCE_BUTTONS.today, action: "sheet:today" }
        ],
        [
          { text: FINANCE_BUTTONS.yesterday, action: "sheet:yesterday" },
          { text: FINANCE_BUTTONS.tomorrow, action: "sheet:tomorrow" }
        ],
        [{ text: FINANCE_BUTTONS.manual, action: "sheet:manual" }],
        [{ text: FINANCE_BUTTONS.back, action: "sheet:back" }, { text: FINANCE_BUTTONS.cancel, action: "sheet:cancel" }]
      ]);
    }

    if (step === "confirm") {
      return kb([
        [{ text: FINANCE_BUTTONS.confirm, action: "sheet:confirm" }],
        [{ text: FINANCE_BUTTONS.edit, action: "sheet:back" }],
        [{ text: FINANCE_BUTTONS.cancel, action: "sheet:cancel" }]
      ]);
    }

    const list = this.listForStep(flow, step, bootstrap, payload, selectedCategory);
    const items = list.slice(page * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE + LIST_PAGE_SIZE);
    const rows = items.map((item, index) => [{ text: item, action: "sheet:pick", payload: { i: page * LIST_PAGE_SIZE + index } }]);
    const navRows: Array<Array<{ text: string; action: string; payload?: Record<string, string | number | undefined> }>> = [];
    if (page > 0 || list.length > LIST_PAGE_SIZE) {
      navRows.push([
        ...(page > 0 ? [{ text: FINANCE_BUTTONS.prev, action: "sheet:page-prev" }] : []),
        ...(list.length > (page + 1) * LIST_PAGE_SIZE ? [{ text: FINANCE_BUTTONS.next, action: "sheet:page-next" }] : [])
      ]);
    }
    navRows.push([{ text: FINANCE_BUTTONS.back, action: "sheet:back" }, { text: FINANCE_BUTTONS.cancel, action: "sheet:cancel" }]);
    return kb([...rows, ...navRows]);
  }

  private listForStep(
    flow: SheetsFlow,
    step: SheetsStep,
    bootstrap: AppsScriptBootstrapData,
    payload: Record<string, unknown>,
    selectedCategory?: string
  ): string[] {
    const categories = bootstrap.categories as
      | {
          subcategories?: {
            income?: Record<string, string[]>;
            expense?: Record<string, string[]>;
          };
        }
      | undefined;

    if (step === "account") {
      if (flow === "transfer" || flow === "credit_payment") {
        return bootstrap.non_credit_account_names ?? bootstrap.account_names ?? [];
      }
      if (flow === "income" || flow === "expense") {
        return bootstrap.income_expense_account_names ?? bootstrap.account_names ?? [];
      }
      return bootstrap.account_names ?? [];
    }

    if (step === "from_account") {
      return bootstrap.non_credit_account_names ?? bootstrap.account_names ?? [];
    }

    if (step === "to_account") {
      return bootstrap.non_credit_account_names ?? bootstrap.account_names ?? [];
    }

    if (step === "credit_account") {
      return bootstrap.credit_account_names ?? [];
    }

    if (step === "category") {
      return flow === "income" ? bootstrap.income_category_names ?? [] : bootstrap.expense_category_names ?? [];
    }

    if (step === "subcategory") {
      const category = selectedCategory ?? String(payload.category ?? "");
      const scope = flow === "income" ? "income" : "expense";
      const subcategories = categories?.subcategories?.[scope]?.[category] ?? [];
      return ["без подкатегории", ...subcategories.filter((item) => item !== "без подкатегории")];
    }

    return [];
  }

  private async handleTextStep(
    user: { id: number; chatId: string; timezoneName: string },
    session: { mode: string; stack: string[]; context: Record<string, unknown> },
    text: string
  ): Promise<void> {
    const flow = session.context.flow as SheetsFlow;
    const step = session.context.step as SheetsStep;
    const payload = (session.context.payload as Record<string, unknown> | undefined) ?? {};
    const trimmed = text.trim();

    if (step === "amount" || step === "balance") {
      const amount = this.parseAmount(trimmed);
      if (amount === null) {
        await this.renderError(user, session, "сумма должна быть больше нуля");
        return;
      }
      const nextStep = step === "amount" ? this.firstFlowStep(flow) : "datetime";
      const nextPayload = { ...payload, [step === "amount" ? "amount" : "balance"]: amount };
      await this.saveFlowState(user.id, session, { payload: nextPayload, step: nextStep, page: 0 });
      await this.renderFlow(user, this.mergeSession(session, { context: { ...session.context, payload: nextPayload, step: nextStep, page: 0 } }));
      return;
    }

    if (step === "datetime_manual") {
      const datetime = this.parseDateTime(trimmed);
      if (!datetime) {
        await this.renderError(user, session, "не понял дату и время");
        return;
      }
      const nextStep = this.nextStep(flow, "datetime");
      await this.saveFlowState(user.id, session, { payload: { ...payload, datetime }, step: nextStep, page: 0 });
      await this.renderFlow(user, this.mergeSession(session, { context: { ...session.context, payload: { ...payload, datetime }, step: nextStep, page: 0 } }));
      return;
    }

    if (step === "comment") {
      const nextPayload = { ...payload, comment: trimmed };
      await this.saveFlowState(user.id, session, { payload: nextPayload, step: "confirm", page: 0 });
      await this.renderFlow(user, this.mergeSession(session, { context: { ...session.context, payload: nextPayload, step: "confirm", page: 0 } }));
    }
  }

  private async pickFromList(
    user: { id: number; chatId: string; timezoneName: string },
    session: { mode: string; stack: string[]; context: Record<string, unknown> },
    index: number
  ): Promise<void> {
    const bootstrap = await this.loadBootstrap(user.id, session);
    const flow = session.context.flow as SheetsFlow;
    const step = session.context.step as SheetsStep;
    const payload = (session.context.payload as Record<string, unknown> | undefined) ?? {};
    const list = this.listForStep(flow, step, bootstrap, payload, session.context.selectedCategory as string | undefined);
    const selected = list[index];
    if (!selected) {
      await this.renderError(user, session, "не удалось выбрать значение");
      return;
    }

    let nextPayload = { ...payload };
    let nextStep: SheetsStep = this.nextStep(flow, step);
    let nextCategory = session.context.selectedCategory as string | undefined;

    if (step === "account") {
      nextPayload = { ...nextPayload, account: selected };
    } else if (step === "from_account") {
      nextPayload = { ...nextPayload, from_account: selected };
    } else if (step === "to_account") {
      nextPayload = { ...nextPayload, to_account: selected };
    } else if (step === "credit_account") {
      nextPayload = { ...nextPayload, credit_account: selected };
    } else if (step === "category") {
      nextPayload = { ...nextPayload, category: selected };
      nextCategory = selected;
    } else if (step === "subcategory") {
      nextPayload = { ...nextPayload, subcategory: selected };
    }

    if (step === "category") {
      nextStep = "subcategory";
    } else if (step === "subcategory") {
      nextStep = "comment";
    } else if (flow === "balance" && step === "account") {
      nextStep = "balance";
    }

    await this.saveFlowState(user.id, session, {
      payload: nextPayload,
      step: nextStep,
      page: 0,
      selectedCategory: nextCategory
    });
    await this.renderFlow(
      user,
      this.mergeSession(session, {
        context: {
          ...session.context,
          payload: nextPayload,
          step: nextStep,
          page: 0,
          selectedCategory: nextCategory
        }
      })
    );
  }

  private async setDateTimeStep(
    user: { id: number; chatId: string; timezoneName: string },
    session: { mode: string; stack: string[]; context: Record<string, unknown> },
    preset: "now" | "today" | "yesterday" | "tomorrow"
  ): Promise<void> {
    const payload = (session.context.payload as Record<string, unknown> | undefined) ?? {};
    const datetime = this.buildDateTimePreset(user.timezoneName, preset);
    const nextStep = this.nextStep(session.context.flow as SheetsFlow, "datetime");
    const nextSession = this.mergeSession(session, {
      context: {
        ...session.context,
        payload: { ...payload, datetime },
        step: nextStep,
        page: 0
      }
    });
    await this.saveSession(user.id, nextSession);
    await this.renderFlow(user, nextSession);
  }

  private async submitFlow(
    user: { id: number; chatId: string; timezoneName: string },
    session: { mode: string; stack: string[]; context: Record<string, unknown> }
  ): Promise<void> {
    const flow = session.context.flow as SheetsFlow;
    const payload = (session.context.payload as Record<string, unknown> | undefined) ?? {};
    const requestId = `${flow}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const requestPayload = { ...payload, client_request_id: requestId };
    const appsScript = await this.getAppsScriptClient(user.id, session);
    if (!appsScript) {
      await this.renderAppsScriptSetup(user, session);
      return;
    }

    try {
      if (flow === "income") {
        await appsScript.income(requestPayload);
      } else if (flow === "expense") {
        await appsScript.expense(requestPayload);
      } else if (flow === "transfer") {
        await appsScript.transfer(requestPayload);
      } else if (flow === "credit_payment") {
        await appsScript.creditPayment(requestPayload);
      } else if (flow === "balance") {
        await appsScript.updateBalance(requestPayload);
      }
    } catch (error) {
      await this.renderError(user, session, error instanceof Error ? error.message : "ошибка отправки");
      return;
    }

    await this.resetToMain(user, session, `${this.flowLabel(flow)} записан`);
  }

  private async goBack(
    user: { id: number; chatId: string; timezoneName: string },
    session: { mode: string; stack: string[]; context: Record<string, unknown> }
  ): Promise<void> {
    if (session.context.screen === "directory") {
      await this.renderMore(user, session);
      return;
    }
    const flow = session.context.flow as SheetsFlow | undefined;
    const step = session.context.step as SheetsStep | undefined;

    if (!flow || !step) {
      await this.renderMain(user, session);
      return;
    }

    const prev = this.prevStep(flow, step);
    if (prev === null) {
      await this.renderMain(user, session);
      return;
    }

    const nextSession = this.mergeSession(session, {
      context: {
        ...session.context,
        step: prev,
        page: 0
      }
    });
    await this.saveSession(user.id, nextSession);
    await this.renderFlow(user, nextSession);
  }

  private async changePage(
    user: { id: number; chatId: string; timezoneName: string },
    session: { mode: string; stack: string[]; context: Record<string, unknown> },
    delta: number
  ): Promise<void> {
    const current = Number(session.context.page ?? 0);
    const nextPage = Math.max(0, current + delta);
    const nextSession = this.mergeSession(session, {
      context: {
        ...session.context,
        page: nextPage
      }
    });
    await this.saveSession(user.id, nextSession);
    if (nextSession.context.screen === "directory") {
      const kind = (nextSession.context.directoryKind ?? "accounts") as "accounts" | "categories" | "subcategories";
      const bootstrap = await this.loadBootstrap(user.id, nextSession);
      const text = this.buildDirectoryText(kind, bootstrap, nextPage);
      const reply_markup = this.buildDirectoryKeyboard(kind, nextPage, bootstrap);
      await this.sendOrEdit(user, nextSession, text, reply_markup);
      return;
    }
    await this.renderFlow(user, nextSession);
  }

  private async resetToMain(
    user: { id: number; chatId: string; timezoneName: string },
    session: { mode: string; stack: string[]; context: Record<string, unknown> },
    successMessage?: string
  ): Promise<void> {
    const bootstrap = await this.loadBootstrap(user.id, session);
    const nextSession = this.mergeSession(session, {
      mode: "idle",
      stack: ["main"],
      context: {
        ...session.context,
        screen: "main",
        flow: undefined,
        step: undefined,
        payload: {},
        page: 0,
        listKind: undefined,
        directoryKind: undefined,
        selectedCategory: undefined
      }
    });
    await this.saveSession(user.id, nextSession);
    if (successMessage) {
      await this.sendOrEdit(user, nextSession, `${FINANCE_BOT_TITLE}\n\n${successMessage}`, kb([[{ text: FINANCE_BUTTONS.menu, action: "sheet:main" }]]));
      return;
    }
    await this.renderMain(user, nextSession, bootstrap);
  }

  private async renderError(
    user: { id: number; chatId: string; timezoneName: string },
    session: { mode: string; stack: string[]; context: Record<string, unknown> },
    message: string
  ): Promise<void> {
    const text = formatTelegramScreenText(`ошибка\n\n${message}`);
    const reply_markup = kb([
      [{ text: FINANCE_BUTTONS.edit, action: "sheet:back" }],
      [{ text: FINANCE_BUTTONS.cancel, action: "sheet:cancel" }]
    ]);
    await this.sendOrEdit(user, session, text, reply_markup);
  }

  private async sendOrEdit(
    user: { id: number; chatId: string; timezoneName: string },
    session: { mode: string; stack: string[]; context: Record<string, unknown> },
    text: string,
    reply_markup: ReturnType<typeof kb>
  ): Promise<void> {
    const messageId = Number(session.context.screenMessageId ?? 0);
    const formatted = formatTelegramScreenText(text);
    if (messageId > 0) {
      try {
        await this.telegram.editMessageText({
          chat_id: user.chatId,
          message_id: messageId,
          text: formatted,
          reply_markup
        });
        return;
      } catch (error) {
        if (isTelegramMessageNotModified(error)) {
          return;
        }
        const newMessageId = await this.telegram.sendMessage({
          chat_id: user.chatId,
          text: formatted,
          reply_markup
        });
        await this.saveSession(user.id, {
          ...session,
          context: { ...session.context, screenMessageId: newMessageId }
        });
        return;
      }
    }

    const newMessageId = await this.telegram.sendMessage({
      chat_id: user.chatId,
      text: formatted,
      reply_markup
    });
    await this.saveSession(user.id, {
      ...session,
      context: { ...session.context, screenMessageId: newMessageId }
    });
  }

  private async loadSession(userId: number) {
    return this.repo.getSession(userId);
  }

  private async saveSession(userId: number, session: { mode: string; stack: string[]; context: Record<string, unknown> }) {
    await this.repo.saveSession(userId, {
      mode: session.mode as never,
      stack: session.stack,
      context: session.context
    });
  }

  private mergeSession(
    session: { mode: string; stack: string[]; context: Record<string, unknown> },
    patch: Partial<{ mode: string; stack: string[]; context: Record<string, unknown> }>
  ) {
    return {
      mode: patch.mode ?? session.mode,
      stack: patch.stack ?? session.stack,
      context: patch.context ?? session.context
    };
  }

  private async loadBootstrap(userId: number, session: { mode: string; stack: string[]; context: Record<string, unknown> }, force = false): Promise<AppsScriptBootstrapData> {
    const cached = session.context.bootstrap as AppsScriptBootstrapData | undefined;
    if (cached && !force) {
      return cached;
    }

    const appsScript = await this.getAppsScriptClient(userId, session);
    if (!appsScript) {
      throw new Error("apps script url is not configured");
    }

    const bootstrap = await appsScript.bootstrap();
    session.context.bootstrap = bootstrap;
    session.context.bootstrapUpdatedAt = Date.now();
    await this.repo.saveSession(userId, {
      mode: session.mode as never,
      stack: session.stack,
      context: session.context
    }).catch(() => undefined);
    return bootstrap;
  }

  private appsScriptUrlKey(userId: number): string {
    return `apps_script_url:${userId}`;
  }

  private async resolveAppsScriptUrl(
    userId: number,
    session?: { context: Record<string, unknown> }
  ): Promise<string | null> {
    const stored = session?.context?.appsScriptUrl as string | undefined;
    const sessionUrl = (stored ?? "").trim();
    if (sessionUrl) {
      return sessionUrl;
    }
    const persisted = await this.repo.getBotSetting(this.appsScriptUrlKey(userId));
    const url = (persisted ?? "").trim();
    return url || null;
  }

  private async getAppsScriptClient(
    userId: number,
    session?: { context: Record<string, unknown> }
  ): Promise<AppsScriptClient | null> {
    const url = await this.resolveAppsScriptUrl(userId, session);
    if (!url) {
      return null;
    }
    return new AppsScriptClient(url, this.appsScriptAuthToken);
  }

  private async saveFlowState(
    userId: number,
    session: { mode: string; stack: string[]; context: Record<string, unknown> },
    patch: Partial<SheetsContext>
  ): Promise<void> {
    await this.repo.saveSession(userId, {
      mode: patch.step && patch.step !== "confirm" ? "add" : (session.mode as never),
      stack: session.stack,
      context: {
        ...session.context,
        ...patch
      }
    });
  }

  private async setStep(
    user: { id: number; chatId: string; timezoneName: string },
    session: { mode: string; stack: string[]; context: Record<string, unknown> },
    step: SheetsStep
  ): Promise<void> {
    const configuredUrl = await this.resolveAppsScriptUrl(user.id, session);
    if (!configuredUrl) {
      await this.renderAppsScriptSetup(user, session);
      return;
    }
    const nextSession = this.mergeSession(session, { context: { ...session.context, step } });
    await this.saveSession(user.id, nextSession);
  }

  private firstFlowStep(flow: SheetsFlow): SheetsStep {
    if (flow === "balance") {
      return "account";
    }
    return "datetime";
  }

  private nextStep(flow: SheetsFlow, step: SheetsStep): SheetsStep {
    const steps = this.flowSteps(flow);
    const currentIndex = steps.indexOf(step);
    return currentIndex >= 0 && currentIndex < steps.length - 1 ? steps[currentIndex + 1] : "confirm";
  }

  private prevStep(flow: SheetsFlow, step: SheetsStep): SheetsStep | null {
    const steps = this.flowSteps(flow);
    const currentIndex = steps.indexOf(step);
    if (currentIndex <= 0) {
      return null;
    }
    return steps[currentIndex - 1] ?? null;
  }

  private flowSteps(flow: SheetsFlow): SheetsStep[] {
    if (flow === "income" || flow === "expense") {
      return ["amount", "datetime", "account", "category", "subcategory", "comment", "confirm"];
    }
    if (flow === "transfer") {
      return ["amount", "datetime", "from_account", "to_account", "comment", "confirm"];
    }
    if (flow === "credit_payment") {
      return ["amount", "datetime", "from_account", "credit_account", "comment", "confirm"];
    }
    return ["account", "balance", "datetime", "comment", "confirm"];
  }

  private flowLabel(flow: SheetsFlow): string {
    if (flow === "credit_payment") {
      return FINANCE_BUTTONS.creditPayment;
    }
    return {
      income: FINANCE_BUTTONS.income,
      expense: FINANCE_BUTTONS.expense,
      transfer: FINANCE_BUTTONS.transfer,
      balance: FINANCE_BUTTONS.balance
    }[flow];
  }

  private parseAmount(text: string): number | null {
    const normalized = text.replace(/\s+/g, "").replace(",", ".").replace(/[₽$€]/g, "");
    if (!normalized) {
      return null;
    }
    const amount = Number(normalized);
    return Number.isFinite(amount) && amount > 0 ? amount : null;
  }

  private parseDateTime(text: string): string | null {
    const normalized = text.trim().replace(/\s+/g, " ");
    const full = normalized.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/);
    if (full) {
      const [, dd, mm, yyyy, hh, min] = full;
      return `${dd.padStart(2, "0")}.${mm.padStart(2, "0")}.${yyyy} ${hh.padStart(2, "0")}:${min}`;
    }
    const short = normalized.match(/^(\d{1,2})\.(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
    if (short) {
      const year = new Date().getFullYear();
      const [, dd, mm, hh, min] = short;
      return `${dd.padStart(2, "0")}.${mm.padStart(2, "0")}.${year} ${hh.padStart(2, "0")}:${min}`;
    }
    return null;
  }

  private buildDateTimePreset(timezone: string, preset: "now" | "today" | "yesterday" | "tomorrow"): string {
    const now = new Date();
    const shift = preset === "yesterday" ? -1 : preset === "tomorrow" ? 1 : 0;
    if (shift !== 0) {
      now.setDate(now.getDate() + shift);
    }
    const parts = new Intl.DateTimeFormat("ru-RU", {
      timeZone: timezone || "Europe/Moscow",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(now);
    const lookup = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return `${String(lookup.day)}.${String(lookup.month)}.${String(lookup.year)} ${String(lookup.hour)}:${String(lookup.minute)}`;
  }

  private readOverviewValue(overview: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
      const value = overview[key];
      if (value === null || value === undefined || value === "") {
        continue;
      }
      return String(value);
    }
    return "—";
  }

  private buildDirectoryText(kind: "accounts" | "categories" | "subcategories", bootstrap: AppsScriptBootstrapData, page: number): string {
    const title = kind === "accounts" ? "счета" : kind === "categories" ? "категории" : "подкатегории";
    const items = this.directoryItems(kind, bootstrap);
    const totalPages = Math.max(1, Math.ceil(items.length / LIST_PAGE_SIZE));
    const start = page * LIST_PAGE_SIZE;
    const visible = items.slice(start, start + LIST_PAGE_SIZE);
    const lines = [FINANCE_BOT_TITLE, "", title, ""];
    if (visible.length === 0) {
      lines.push("нет данных");
    } else {
      lines.push(...visible.map((item, index) => `${start + index + 1}. ${item}`));
    }
    lines.push("", `страница ${Math.min(page + 1, totalPages)} / ${totalPages}`);
    return formatTelegramScreenText(lines.join("\n"));
  }

  private buildDirectoryKeyboard(kind: "accounts" | "categories" | "subcategories", page: number, bootstrap: AppsScriptBootstrapData) {
    const items = this.directoryItems(kind, bootstrap);
    const hasPrev = page > 0;
    const hasNext = items.length > (page + 1) * LIST_PAGE_SIZE;
    return kb([
      ...(hasPrev || hasNext
        ? [[
            ...(hasPrev ? [{ text: FINANCE_BUTTONS.prev, action: "sheet:page-prev" }] : []),
            ...(hasNext ? [{ text: FINANCE_BUTTONS.next, action: "sheet:page-next" }] : [])
          ]]
        : []),
      [{ text: FINANCE_BUTTONS.back, action: "sheet:back" }, { text: FINANCE_BUTTONS.menu, action: "sheet:main" }]
    ]);
  }

  private directoryItems(kind: "accounts" | "categories" | "subcategories", bootstrap: AppsScriptBootstrapData): string[] {
    if (kind === "accounts") {
      return bootstrap.account_names ?? [];
    }

    if (kind === "categories") {
      return [
        ...(bootstrap.income_category_names ?? []).map((item) => `доход · ${item}`),
        ...(bootstrap.expense_category_names ?? []).map((item) => `расход · ${item}`)
      ];
    }

    const categories = bootstrap.categories as
      | {
          subcategories?: {
            income?: Record<string, string[]>;
            expense?: Record<string, string[]>;
          };
        }
      | undefined;
    const income = Object.entries(categories?.subcategories?.income ?? {}).flatMap(([category, items]) =>
      items.map((item) => `доход · ${category} · ${item}`)
    );
    const expense = Object.entries(categories?.subcategories?.expense ?? {}).flatMap(([category, items]) =>
      items.map((item) => `расход · ${category} · ${item}`)
    );
    return [...income, ...expense];
  }
}
