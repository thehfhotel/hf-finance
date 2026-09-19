// Period-gated payroll rates — the era boundaries, not the arithmetic.
//
// Every rate in src/payroll-rates.ts has already changed once (ประกันสังคม
// 3% → 5% at 2026-07) and changes again when กองทุนสงเคราะห์ลูกจ้าง starts at
// 2026-10. A wrong boundary is the dangerous failure here: it doesn't throw,
// it silently re-rates a cycle — reopening a pre-July month at 5%, or letting
// the 2026-09 cycle that is open TODAY pick up an EWF deduction that is not
// lawfully collected until October wages. Both produce a wrong payslip that
// nobody sees until the bank transfer is already out.
//
// So this suite pins the first and last month of every era rather than a
// convenient month in the middle. Run with `bun test`.

import { describe, expect, it } from "bun:test";
import { EWF_START_PERIOD, RATE_ERAS, hasWelfareFund, rateHint, ratesFor, salaryLinkedAmounts } from "../src/payroll-rates";

describe("ratesFor — era boundaries", () => {
  it("keeps the reduced ประกันสังคม 3% through the 2026-06 cycle", () => {
    expect(ratesFor("2026-06")).toEqual({ socialSecurity: 0.03, savings: 0.05, welfareFund: 0 });
    expect(ratesFor("2020-01")).toEqual({ socialSecurity: 0.03, savings: 0.05, welfareFund: 0 });
  });

  it("raises ประกันสังคม to 5% from 2026-07 without touching เงินสะสม", () => {
    expect(ratesFor("2026-07")).toEqual({ socialSecurity: 0.05, savings: 0.05, welfareFund: 0 });
  });

  it("leaves the cycle open today (2026-09) on เงินสะสม 5% and EWF 0%", () => {
    // The whole reason this module exists. The EWF decree is already published
    // but applies to October wages only, so the September worksheet an
    // operator has open right now must not grow a fourth deduction column.
    expect(ratesFor("2026-09")).toEqual({ socialSecurity: 0.05, savings: 0.05, welfareFund: 0 });
  });

  it("carves the EWF out of เงินสะสม from the very first cycle it applies to", () => {
    expect(EWF_START_PERIOD).toBe("2026-10");
    expect(ratesFor(EWF_START_PERIOD)).toEqual({ socialSecurity: 0.05, savings: 0.0475, welfareFund: 0.0025 });
  });

  it("holds 4.75% + 0.25% right up to the last month before the step-up", () => {
    expect(ratesFor("2031-09")).toEqual({ socialSecurity: 0.05, savings: 0.0475, welfareFund: 0.0025 });
  });

  it("steps both EWF shares to 0.5% from 2031-10, still carved out", () => {
    expect(ratesFor("2031-10")).toEqual({ socialSecurity: 0.05, savings: 0.045, welfareFund: 0.005 });
  });
});

describe("the carve-out invariant", () => {
  // The owner's decision that makes this whole change safe to ship: the
  // employee's 0.25% is taken OUT of the existing 5% เงินสะสม, not added on
  // top, so take-home does not move. Assert it over every era in the table
  // rather than the three spelled out above — a future era that quietly
  // pushes the employee's total past 5% is a pay cut, and it should fail here
  // rather than in a payslip.
  const eras = RATE_ERAS.filter((e) => e.from >= "2026-07");

  it("covers every era from 2026-07 onward", () => {
    // Guards the filter itself: if an era is renamed or the floor moves, this
    // catches an assertion loop that silently has nothing left to check.
    expect(eras.length).toBeGreaterThanOrEqual(3);
  });

  for (const era of eras) {
    it(`keeps the employee's total deduction at 5% from ${era.from}`, () => {
      // Tolerance, not toBe: 0.0475 + 0.0025 is 0.049999999999999996 in binary
      // floating point, and rounding to satang happens later, per row.
      expect(era.rates.savings + era.rates.welfareFund).toBeCloseTo(0.05, 10);
    });
  }
});

describe("hasWelfareFund", () => {
  it("is false for every cycle before the decree's start date", () => {
    expect(hasWelfareFund("2026-06")).toBe(false);
    expect(hasWelfareFund("2026-07")).toBe(false);
    expect(hasWelfareFund("2026-09")).toBe(false);
  });

  it("is true from the start period onward", () => {
    expect(hasWelfareFund(EWF_START_PERIOD)).toBe(true);
    expect(hasWelfareFund("2026-11")).toBe(true);
    expect(hasWelfareFund("2031-10")).toBe(true);
  });
});

describe("rateHint", () => {
  it("drops trailing zeros so the common rates read as they always have", () => {
    expect(rateHint(0.05)).toBe("5%");
    expect(rateHint(0.03)).toBe("3%");
  });

  it("keeps the two decimals the carve-out actually needs", () => {
    // 0.0475 * 100 and 0.0025 * 100 both land on a float that prints long
    // without the toFixed step — "4.750000000000001%" in a column header.
    expect(rateHint(0.0475)).toBe("4.75%");
    expect(rateHint(0.0025)).toBe("0.25%");
  });

  it("formats the 2031 step-up rates", () => {
    expect(rateHint(0.045)).toBe("4.5%");
    expect(rateHint(0.005)).toBe("0.5%");
  });
});

describe("ratesFor — junk input", () => {
  it("falls back to the floor era instead of throwing on an empty period", () => {
    // Callers reach this with whatever is in the URL. A blank or missing
    // period must produce a usable rate table, never a 500.
    const floor = RATE_ERAS[RATE_ERAS.length - 1].rates;
    expect(ratesFor("")).toEqual(floor);
    expect(ratesFor(undefined as unknown as string)).toEqual(floor);
    expect(ratesFor(null as unknown as string)).toEqual(floor);
  });

  it("sends a malformed period to the floor era, never to a future one", () => {
    // Era lookup is a string compare and letters sort ABOVE digits, so without
    // the format guard "nonsense" >= "2031-10" is true and junk would resolve
    // to the NEWEST era — handing a cycle rates that do not start for years.
    // Unreachable through the routes (isValidPeriod runs first), which is
    // exactly why it needs a test: nothing else would notice it regressing.
    const floor = RATE_ERAS[RATE_ERAS.length - 1].rates;
    for (const junk of ["nonsense", "2026", "2026-9", "2026-13-01", "  ", "\u0e15.\u0e04. 2569"]) {
      expect(ratesFor(junk)).toEqual(floor);
    }
  });
});

describe("salaryLinkedAmounts — the carve-out is satang-exact", () => {
  // The promise made to staff in the ประกาศ is that the total deducted does
  // not change: 5% before 2026-10, 4.75% + 0.25% after. Rounding each rate on
  // its own breaks that — 12,450 gives 591.38 + 31.13 = 622.51 against a flat
  // 622.50 — so the pot is rounded once and เงินสะสม absorbs the remainder.
  const cycles = ["2026-10", "2031-10"];

  for (const period of cycles) {
    it(`keeps savings + welfareFund exactly equal to a flat 5% (${period})`, () => {
      const rates = ratesFor(period);
      // Every 10 baht across the real salary band, plus the odd-satang cases.
      const salaries = [12450, 14002, 9999, 33333.33, 8750.5];
      for (let s = 8000; s <= 25000; s += 10) salaries.push(s);
      for (const salary of salaries) {
        const a = salaryLinkedAmounts(salary, rates);
        const flatFive = Math.round(salary * 0.05 * 100) / 100;
        expect(Math.round((a.savings + a.welfareFund) * 100) / 100).toBe(flatFive);
      }
    });

    it(`remits the exact statutory percentage, unrounded-away (${period})`, () => {
      // เงินสะสม absorbs the remainder, never the fund: the fund figure is the
      // one กสร. recomputes, and a short remittance carries เงินเพิ่ม 5%/month.
      const rates = ratesFor(period);
      for (const salary of [12450, 14002, 9999, 12345]) {
        const a = salaryLinkedAmounts(salary, rates);
        expect(a.welfareFund).toBe(Math.round(salary * rates.welfareFund * 100) / 100);
      }
    });
  }

  it("collapses to a plain rounded percentage before the fund starts", () => {
    const a = salaryLinkedAmounts(12450, ratesFor("2026-09"));
    expect(a).toEqual({ socialSecurity: 622.5, savings: 622.5, welfareFund: 0 });
  });

  it("is exactly the 2026-10 worked example", () => {
    expect(salaryLinkedAmounts(14000, ratesFor("2026-10"))).toEqual({
      socialSecurity: 700,
      savings: 665,
      welfareFund: 35,
    });
    // The satang case that motivated the helper.
    expect(salaryLinkedAmounts(12450, ratesFor("2026-10"))).toEqual({
      socialSecurity: 622.5,
      savings: 591.37,
      welfareFund: 31.13,
    });
  });

  it("treats a blank or non-numeric salary as zero rather than NaN", () => {
    expect(salaryLinkedAmounts(0, ratesFor("2026-10"))).toEqual({ socialSecurity: 0, savings: 0, welfareFund: 0 });
    expect(salaryLinkedAmounts(NaN, ratesFor("2026-10"))).toEqual({ socialSecurity: 0, savings: 0, welfareFund: 0 });
  });
});
