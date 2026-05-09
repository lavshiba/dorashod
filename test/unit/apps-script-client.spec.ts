import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppsScriptClient } from "@/backend/apps-script-client";

describe("AppsScriptClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("posts bootstrap request with bearer auth and returns data", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, message: "готово", data: { version: "v1" } }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      })
    );

    const client = new AppsScriptClient("https://example.com/apps-script", "secret-token");
    const data = await client.bootstrap();

    expect(data).toEqual({ version: "v1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://example.com/apps-script");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token"
      }
    });
    expect(JSON.parse(String(init?.body))).toEqual({ action: "bootstrap" });
  });

  it("posts income payload with action merged into body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, message: "доход записан" }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      })
    );

    const client = new AppsScriptClient("https://example.com/apps-script", "secret-token");
    await client.income({
      amount: 500,
      account: "пэй"
    });

    const [_, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      action: "income",
      amount: 500,
      account: "пэй"
    });
  });
});
