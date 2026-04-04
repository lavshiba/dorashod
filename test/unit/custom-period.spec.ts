import { describe, expect, it } from "vitest";
import { parseCustomPeriodInput } from "@/utils/dates";

describe("parseCustomPeriodInput", () => {
  const todayIso = "2026-04-04";

  it("parses dotted date range with explicit years", () => {
    const parsed = parseCustomPeriodInput("с 01.03.2026 по 10.03.2026", todayIso);
    expect(parsed).toMatchObject({
      status: "resolved",
      from: "2026-03-01",
      to: "2026-03-10",
      label: "01.03.2026 — 10.03.2026"
    });
  });

  it("parses ambiguous short dotted date range", () => {
    const parsed = parseCustomPeriodInput("01.03 - 05.03", todayIso);
    expect(parsed).toMatchObject({
      status: "ambiguous",
      from: "2026-03-01",
      to: "2026-03-05",
      label: "01.03.2026 — 05.03.2026"
    });
  });

  it("parses iso month range", () => {
    const parsed = parseCustomPeriodInput("2026-03 - 2026-05", todayIso);
    expect(parsed).toMatchObject({
      status: "resolved",
      from: "2026-03-01",
      to: "2026-05-31",
      label: "2026-03 — 2026-05"
    });
  });

  it("parses year range", () => {
    const parsed = parseCustomPeriodInput("2024 - 2025", todayIso);
    expect(parsed).toMatchObject({
      status: "resolved",
      from: "2024-01-01",
      to: "2025-12-31",
      label: "2024 — 2025"
    });
  });

  it("parses month-name date range", () => {
    const parsed = parseCustomPeriodInput("1 марта - 10 марта", todayIso);
    expect(parsed).toMatchObject({
      status: "ambiguous",
      from: "2026-03-01",
      to: "2026-03-10",
      label: "1 марта — 10 марта"
    });
  });

  it("parses month-name date range with years", () => {
    const parsed = parseCustomPeriodInput("1 марта 2025 до 10 марта 2025", todayIso);
    expect(parsed).toMatchObject({
      status: "resolved",
      from: "2025-03-01",
      to: "2025-03-10",
      label: "1 марта 2025 — 10 марта 2025"
    });
  });
});
