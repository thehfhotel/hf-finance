// Payroll rates that are pinned to a CYCLE, not to "now".
//
// Every rate here has changed at least once and will change again, and a
// reseeded old cycle must reproduce the rate that cycle was actually paid
// with — so the rates are looked up by period rather than held as constants.
// Before this module, ประกันสังคม 3% → 5% (the 2026-07 change) was a bare
// constant flip, which meant reopening a pre-July cycle silently re-rated it.
//
// One source of truth for both sides of the app: `ratesFor` runs server-side
// in sheets.ts, and RATE_ERAS is serialised into the worksheet page so the
// browser resolves the identical table (see views/worksheet.ts). Don't
// duplicate a rate literal into either side.
//
// Rates are fractions of เงินเดือน (the row's `salary`), not of net pay.

export type PayrollRates = {
  /** ประกันสังคม — withheld from the employee. */
  socialSecurity: number;
  /** เงินสะสม — the hotel's in-house savings scheme, held on our own books. */
  savings: number;
  /**
   * กองทุนสงเคราะห์ลูกจ้าง (Employee Welfare Fund) — the employee's เงินสะสม
   * share, withheld and remitted to กรมสวัสดิการและคุ้มครองแรงงาน. The
   * employer owes เงินสมทบ at the SAME rate on top (ฝ่ายละเท่า ๆ กัน), which
   * is why the worksheet derives the employer column from this one instead of
   * storing it twice.
   */
  welfareFund: number;
};

/**
 * First cycle the Employee Welfare Fund applies to.
 *
 * พระราชกฤษฎีกากำหนดระยะเวลาเริ่มดำเนินการจัดเก็บเงินสะสมและเงินสมทบ
 * กองทุนสงเคราะห์ลูกจ้าง พ.ศ. 2568 (ราชกิจจานุเบกษา เล่ม 142 ตอนที่ 59 ก,
 * 14 ก.ย. 2568) มาตรา 4: จัดเก็บตั้งแต่วันที่ 1 ตุลาคม พ.ศ. 2569. It repealed
 * the พ.ศ. 2567 decree that had set 1 ต.ค. 2568, so anything citing 2568 —
 * or a step-up in 2571/2573 — is quoting the repealed table.
 *
 * October 2026 wages are the first deduction; both shares are remitted by
 * 15 November 2026. See docs/research/2026-09-19-employee-welfare-fund.md.
 */
export const EWF_START_PERIOD = "2026-10";

/**
 * Newest era first. `from` is the first YYYY-MM the rates applied to; the
 * last entry is the floor and needs no `from`.
 */
export const RATE_ERAS: { from: string; rates: PayrollRates }[] = [
  // กฎกระทรวงกำหนดอัตราเงินสะสมและเงินสมทบกองทุนสงเคราะห์ลูกจ้าง พ.ศ. 2568
  // steps both sides up to 0.5% from 1 ต.ค. 2574 (2031-10). Kept carved out
  // of เงินสะสม on the same principle as 2026-10, so the employee's total
  // deduction stays 5% — revisit with the owner before that cycle opens.
  { from: "2031-10", rates: { socialSecurity: 0.05, savings: 0.045, welfareFund: 0.005 } },
  // EWF starts. The employee's 0.25% is CARVED OUT of เงินสะสม (5% → 4.75%)
  // rather than added on top, so take-home is unchanged — an owner decision
  // of 2026-09-19, and one that needed a ประกาศ + หนังสือยินยอม because
  // reducing an existing welfare benefit changes สภาพการจ้าง. The employer's
  // matching 0.25% is new money and cannot come out of this deduction.
  { from: EWF_START_PERIOD, rates: { socialSecurity: 0.05, savings: 0.0475, welfareFund: 0.0025 } },
  // ประกันสังคม returned to its full 5% after the reduced-rate relief period.
  { from: "2026-07", rates: { socialSecurity: 0.05, savings: 0.05, welfareFund: 0 } },
  { from: "0000-00", rates: { socialSecurity: 0.03, savings: 0.05, welfareFund: 0 } },
];

/** Rates in force for a YYYY-MM cycle. Unparseable periods get the floor era. */
export function ratesFor(period: string): PayrollRates {
  const p = String(period ?? "");
  // The era scan is a string compare, and letters sort ABOVE digits — so
  // "nonsense" >= "2031-10" is true and a malformed period would resolve to
  // the NEWEST era, handing a cycle rates that do not start for years. Routes
  // validate with isValidPeriod first, so this is unreachable today; the guard
  // is here so it stays unreachable, and so junk fails toward the floor (the
  // conservative direction) rather than toward the future.
  if (!/^\d{4}-\d{2}$/.test(p)) return RATE_ERAS[RATE_ERAS.length - 1].rates;
  for (const era of RATE_ERAS) {
    if (p >= era.from) return era.rates;
  }
  return RATE_ERAS[RATE_ERAS.length - 1].rates;
}

/**
 * The three salary-linked deductions for one row, in satang-exact form.
 *
 * Rounding each rate independently would break the promise the carve-out is
 * built on. เงินสะสม 4.75% and กองทุนสงเคราะห์ฯ 0.25% of ฿12,450 round UP
 * separately to 591.38 + 31.13 = 622.51, a satang more than the 622.50 the
 * employee was deducted at a flat 5% — so "your total deduction does not
 * change" would be false for roughly a fifth of salaries.
 *
 * Instead the employee's combined pot is rounded ONCE, the statutory fund
 * share is rounded exactly (it is the figure we remit to กสร. and the one a
 * labour inspector recomputes), and เงินสะสม absorbs the remainder — which is
 * precisely what "carve 0.25% out of the existing 5%" means. For an era with
 * no fund the arithmetic collapses back to a plain rounded percentage.
 */
export function salaryLinkedAmounts(salary: number, rates: PayrollRates): {
  socialSecurity: number;
  savings: number;
  welfareFund: number;
} {
  const s = Number(salary) || 0;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const welfareFund = r2(s * rates.welfareFund);
  const pot = r2(s * (rates.savings + rates.welfareFund));
  return {
    socialSecurity: r2(s * rates.socialSecurity),
    savings: r2(pot - welfareFund),
    welfareFund,
  };
}

/** True once the cycle owes Employee Welfare Fund contributions. */
export function hasWelfareFund(period: string): boolean {
  return ratesFor(period).welfareFund > 0;
}

/**
 * A rate as a column hint: 0.0475 → "4.75%", 0.05 → "5%". Trailing zeros are
 * dropped so the common rates stay as short as they read on the old headers.
 */
export function rateHint(rate: number): string {
  return `${Number((rate * 100).toFixed(4))}%`;
}
