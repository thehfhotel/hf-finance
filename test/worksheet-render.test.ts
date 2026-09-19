// Guards the worksheet's number formatter against rows that predate a column.
//
// Most rows reach the browser through GET /api/sheets/:period, which runs
// normalize() and backfills every numeric field. One path does not: a queue
// snapshot (GET /api/queue/:id) replays summary.sheet straight out of the
// stored request JSON, exactly as it was submitted. Every payroll request
// filed before กองทุนสงเคราะห์ลูกจ้าง existed therefore has rows with no
// welfareFund key at all, and the read-only snapshot view still renders them.
//
// fmt() used to do `Math.abs(n) < 0.005` first — and Math.abs(undefined) is
// NaN, which is not < 0.005, so it fell through to undefined.toLocaleString()
// and threw inside renderRows(). That emptied the table and killed the print
// path for the audit record of an already-paid transfer.
//
// The page's client script is a template literal, not a module, so there is
// nothing to import. We pull the two functions out of the served HTML and run
// them — the same reproduction the review used. If they are ever renamed or
// rewritten as arrow consts this test fails loudly rather than silently
// passing, which is the behaviour we want from a guard.

import { describe, expect, it } from "bun:test";
import { WORKSHEET_HTML } from "../src/views/worksheet";
import { RATE_ERAS, ratesFor, salaryLinkedAmounts } from "../src/payroll-rates";

function extract(name: string): string {
  const m = WORKSHEET_HTML.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`could not find function ${name}() in the worksheet page`);
  return m[0];
}

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const clientFmt = new Function(
  `${extract("num")}\n${extract("fmt")}\nreturn fmt;`,
)() as (n: unknown) => string;

describe("worksheet fmt() — rows persisted before a column existed", () => {
  it("renders a missing field as blank instead of throwing", () => {
    // The exact shape a pre-EWF queue snapshot hands renderRows().
    const oldRow: Record<string, unknown> = {
      salary: 14000, socialSecurity: 700, savings: 700,
      advance: 0, loan: 0, interest: 0, roomCost: 0, leave: 0, otherDeduction: 0,
      commission: 0, breakfast: 0, ot: 0, otherAddition: 0,
    };
    expect(() => clientFmt(oldRow.welfareFund)).not.toThrow();
    expect(clientFmt(oldRow.welfareFund)).toBe("");
    expect(clientFmt(oldRow.salary)).toBe("14,000.00");
  });

  it("survives every junk value a hand-edited sheet can hold", () => {
    for (const junk of [undefined, null, "", "  ", NaN, "abc", {}, []]) {
      expect(() => clientFmt(junk)).not.toThrow();
      expect(clientFmt(junk)).toBe("");
    }
  });

  it("still formats real amounts, including the carve-out's satang", () => {
    expect(clientFmt(591.37)).toBe("591.37");
    expect(clientFmt(31.13)).toBe("31.13");
    expect(clientFmt("1,234.5")).toBe("1,234.50"); // comma-formatted input
    expect(clientFmt(0)).toBe("");                 // zero stays blank, as before
  });
});

// The rate table exists twice at runtime: once in src/payroll-rates.ts on the
// server, once serialised into this page for the browser. They are supposed to
// be the same table resolved by the same logic — and the copies are written in
// different languages inside a template literal, where a single backslash is
// enough to break one of them silently. (It did: `/^\d{4}-\d{2}$/` written
// with one backslash reaches the browser as `/^d{4}-d{2}$/`, matches nothing,
// and every period falls to the floor era — 3% ประกันสังคม, no fund, no
// warning anywhere.) So run the browser's copy and diff it against the
// server's for every period and salary that matters.
const clientRates = new Function(
  `${extract("num")}\n${WORKSHEET_HTML.match(/const RATE_ERAS = .*?;/)![0]}\n${extract("ratesFor")}\n${extract("salaryLinkedAmounts")}\nreturn { ratesFor, salaryLinkedAmounts };`,
)() as {
  ratesFor: (p: string) => { socialSecurity: number; savings: number; welfareFund: number };
  salaryLinkedAmounts: (s: number, r: unknown) => { socialSecurity: number; savings: number; welfareFund: number };
};

describe("the worksheet page's rate table matches the server's", () => {
  const periods = ["2020-01", "2026-06", "2026-07", "2026-09", "2026-10", "2031-09", "2031-10", "2040-01"];

  it("resolves every era identically", () => {
    for (const period of periods) {
      expect(clientRates.ratesFor(period)).toEqual(ratesFor(period));
    }
  });

  it("does not silently fall to the floor era for a real period", () => {
    // The specific failure the escaping bug caused: a valid period treated as
    // junk. Pin it directly, because "both sides agree" would also pass if
    // BOTH fell to the floor.
    expect(clientRates.ratesFor("2026-10")).toEqual({ socialSecurity: 0.05, savings: 0.0475, welfareFund: 0.0025 });
    expect(clientRates.ratesFor("2026-09").welfareFund).toBe(0);
  });

  it("guards junk the same way the server does", () => {
    const floor = RATE_ERAS[RATE_ERAS.length - 1].rates;
    for (const junk of ["nonsense", "2026", "2026-9", ""]) {
      expect(clientRates.ratesFor(junk)).toEqual(floor);
    }
  });

  it("computes the same satang as the server for every salary in band", () => {
    for (const period of ["2026-09", "2026-10", "2031-10"]) {
      const rates = ratesFor(period);
      for (let salary = 8000; salary <= 25000; salary += 10) {
        expect(clientRates.salaryLinkedAmounts(salary, rates)).toEqual(salaryLinkedAmounts(salary, rates));
      }
    }
  });
});
