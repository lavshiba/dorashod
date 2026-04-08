import { describe, expect, it } from "vitest";
import { Repository } from "@/db/repository";

class FakeStatement {
  public binds: unknown[] = [];

  constructor(public readonly query: string, private readonly changes = 0) {}

  bind(...args: unknown[]) {
    this.binds = args;
    return this;
  }

  async run() {
    return { meta: { changes: this.changes } };
  }
}

class FakeDb {
  public statements: FakeStatement[] = [];

  prepare(query: string) {
    const changes =
      query.includes("DELETE FROM callback_locks") ? 2
      : query.includes("DELETE FROM user_update_locks") ? 1
      : query.includes("DELETE FROM imports") ? 3
      : query.includes("DELETE FROM cron_runs") ? 4
      : 0;
    const statement = new FakeStatement(query, changes);
    this.statements.push(statement);
    return statement;
  }

  async batch(statements: FakeStatement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

describe("Repository maintenance", () => {
  it("resets settings as part of clearAllUserData", async () => {
    const db = new FakeDb();
    const repo = new Repository(db as unknown as D1Database);

    await repo.clearAllUserData(7);

    const resetStatement = db.statements.find((statement) => statement.query.includes("UPDATE users"));
    expect(resetStatement?.query).toContain("currency_code = 'RUB'");
    expect(resetStatement?.query).toContain("timezone_name = 'Europe/Moscow'");
    expect(resetStatement?.query).toContain("quick_access_mode_expense = 'automatically'");
    expect(resetStatement?.query).toContain("sort_mode_subcategories = 'usage'");
    expect(resetStatement?.binds).toEqual([7]);
  });

  it("runs real cron housekeeping queries and returns their counts", async () => {
    const db = new FakeDb();
    const repo = new Repository(db as unknown as D1Database);

    const result = await repo.runCronHousekeeping();

    expect(result).toEqual({
      expiredCallbackLocks: 2,
      expiredUserUpdateLocks: 1,
      staleImports: 3,
      staleCronRuns: 4
    });
  });

  it("rejects unknown dynamic user fields", async () => {
    const db = new FakeDb();
    const repo = new Repository(db as unknown as D1Database);

    await expect(repo.updateUserFields(7, { timezone_name: "Europe/Moscow" })).resolves.toBeUndefined();
    await expect(repo.updateUserFields(7, { evil_field: "boom" } as never)).rejects.toThrow("Unsupported user field update");
  });
});
