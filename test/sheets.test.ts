// Roster ↔ worksheet reconciliation.
//
// A row typed by hand ("+ เพิ่มแถวใหม่") gets a local "m-…" accountId. The
// reconciler matched the roster on accountId alone, so once the same person
// was added on /accounts they got a SECOND row — one hand-typed, one from the
// roster. The bank account number is the real identity.
//
// Names follow KBIZ: after a sync the bank's Thai payee name replaces what was
// typed locally, in the roster and in any cycle that is still open.
// Run with `bun test`.

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "payroll-sheets-"));
process.env.DATA_PATH = join(dir, "accounts.json");
process.env.REGISTERED_PATH = join(dir, "kbiz-registered.json");
process.env.SHEETS_DIR = join(dir, "sheets");
mkdirSync(join(dir, "sheets"), { recursive: true });

const REGISTERED_NUMBER = "1213100211";
const UNREGISTERED_NUMBER = "999919999";
// An account whose typed name disagrees with the bank's record.
const MISMATCH_NUMBER = "1919919199";

writeFileSync(
  process.env.DATA_PATH,
  JSON.stringify([
    { id: "1", accountNumber: "1011100011", accountName: "น.ส. ทดสอบ หนึ่ง" },
    { id: "21", accountNumber: REGISTERED_NUMBER, accountName: "น.ส. ทดสอบ ยี่สิบเอ็ด" },
    { id: "22", accountNumber: UNREGISTERED_NUMBER, accountName: "น.ส. ยังไม่ลง ทะเบียน" },
    { id: "23", accountNumber: MISMATCH_NUMBER, accountName: "น.ส. มานีวรรณ สังข์ทอง" },
  ])
);
writeFileSync(
  process.env.REGISTERED_PATH,
  JSON.stringify({
    fetchedAt: "2026-08-04T00:00:00.000Z",
    count: 2,
    accounts: [
      { accountNumber: "1011100011", accountName: "MS. TESTONE SAMPLE", payeeName: "นางสาวทดสอบ หนึ่ง" },
      {
        accountNumber: REGISTERED_NUMBER,
        accountName: "MS. TESTTWENTYONE SAMPLE",
        payeeName: "นางสาวทดสอบ ยี่สิบเอ็ด",
      },
      {
        accountNumber: MISMATCH_NUMBER,
        accountName: "MS. KANOKWAN SANGKAEW",
        payeeName: "นางสาวมานะวรรณ สังข์ทอง",
      },
    ],
  })
);

// A cycle one month out never reaches its payout day (the 5th of the month
// after it), so it stays open no matter when this test runs.
const soon = new Date();
const openDate = new Date(soon.getFullYear(), soon.getMonth() + 1, 1);
const OPEN_PERIOD = `${openDate.getFullYear()}-${String(openDate.getMonth() + 1).padStart(2, "0")}`;
const PAST_PERIOD = "2020-01";

// The same person, typed in by hand before they existed on /accounts:
// local id, account number with the bank's dashes, an operator's shorthand name.
const handTypedRow = {
  accountId: "m-l3k2j-9f2a",
  accountNumber: "121-3-10021-1",
  accountName: "ทดสอบ (ครัว)",
  bank: "KBANK",
  nickname: "",
  position: "",
  salary: 12000,
  socialSecurity: 600,
  savings: 600,
  // Held at 0 on purpose: this fixture stands in for the cycles that are open
  // now, which are all before EWF_START_PERIOD, so every assertion about it
  // stays where it was before the welfare fund existed.
  welfareFund: 0,
  advance: 0,
  loan: 0,
  interest: 0,
  roomCost: 0,
  leave: 0,
  otherDeduction: 0,
  commission: 0,
  breakfast: 0,
  ot: 0,
  otherAddition: 0,
  note: "จ่ายสด",
};

for (const period of [OPEN_PERIOD, PAST_PERIOD]) {
  writeFileSync(
    join(dir, "sheets", `${period}.json`),
    JSON.stringify({
      period,
      effectiveDate: "",
      rows: [structuredClone(handTypedRow)],
      generalNotes: "",
      dismissed: [],
      updatedAt: "2026-08-04T00:00:00.000Z",
    })
  );
}

const { loadSheet, isPastPeriod, takeHome } = await import("../src/sheets");
const { listAccounts } = await import("../src/store");

describe("isPastPeriod", () => {
  it("locks a cycle on its payout day, the 5th of the next month", () => {
    expect(isPastPeriod("2020-01")).toBe(true);
    expect(isPastPeriod(OPEN_PERIOD)).toBe(false);
    expect(isPastPeriod("")).toBe(false);
    expect(isPastPeriod("nonsense")).toBe(false);
  });
});

describe("listAccounts", () => {
  it("replaces ชื่อบัญชี with the KBIZ Thai payee name", async () => {
    const accounts = await listAccounts();
    expect(accounts.find((a) => a.id === "21")?.accountName).toBe("นางสาวทดสอบ ยี่สิบเอ็ด");
    expect(accounts.find((a) => a.id === "1")?.accountName).toBe("นางสาวทดสอบ หนึ่ง");
  });

  it("leaves an account KBIZ doesn't know alone", async () => {
    const accounts = await listAccounts();
    expect(accounts.find((a) => a.id === "22")?.accountName).toBe("น.ส. ยังไม่ลง ทะเบียน");
  });

  it("persists the synced name", async () => {
    await listAccounts();
    const onDisk = JSON.parse(readFileSync(process.env.DATA_PATH!, "utf8"));
    expect(onDisk.find((a: { id: string }) => a.id === "21").accountName).toBe("นางสาวทดสอบ ยี่สิบเอ็ด");
  });

  it("takes the bank's name even when it disagrees with what was typed", async () => {
    // KBIZ is the source of truth: a disagreement is reported, never resolved
    // in favour of the local entry.
    const account = (await listAccounts()).find((a) => a.id === "23");
    expect(account?.accountName).toBe("นางสาวมานะวรรณ สังข์ทอง");
  });

  it("keeps the typed name so the disagreement stays visible", async () => {
    const account = (await listAccounts()).find((a) => a.id === "23");
    expect(account?.enteredName).toBe("น.ส. มานีวรรณ สังข์ทอง");
  });

  it("records the pre-sync entry for agreeing rows too", async () => {
    const account = (await listAccounts()).find((a) => a.id === "1");
    expect(account?.enteredName).toBe("น.ส. ทดสอบ หนึ่ง");
    expect(account?.accountName).toBe("นางสาวทดสอบ หนึ่ง");
  });
});

describe("loadSheet reconciliation", () => {
  it("adopts a hand-typed row instead of appending a duplicate", async () => {
    const sheet = await loadSheet(OPEN_PERIOD);

    const forAccount21 = sheet.rows.filter((r) => r.accountNumber.replace(/-/g, "") === REGISTERED_NUMBER);
    expect(forAccount21).toHaveLength(1);

    const row = forAccount21[0];
    expect(row.accountId).toBe("21"); // linked to the roster, so future cycles carry it forward
    expect(row.accountNumber).toBe(REGISTERED_NUMBER); // normalized to the roster's form
    expect(row.salary).toBe(12000); // the operator's figures survive
    expect(row.note).toBe("จ่ายสด");
  });

  it("lets KBIZ rename the row in an open cycle", async () => {
    const sheet = await loadSheet(OPEN_PERIOD);
    const row = sheet.rows.find((r) => r.accountId === "21");
    expect(row?.accountName).toBe("นางสาวทดสอบ ยี่สิบเอ็ด");
  });

  it("still appends roster accounts that have no row yet", async () => {
    const sheet = await loadSheet(OPEN_PERIOD);
    expect(sheet.rows.map((r) => r.accountId).sort()).toEqual(["1", "21", "22", "23"]);
  });

  it("never rewrites a locked past cycle's name", async () => {
    const sheet = await loadSheet(PAST_PERIOD);
    const row = sheet.rows.find((r) => r.accountNumber.replace(/-/g, "") === REGISTERED_NUMBER);
    // Deduped (one row, linked) but paid out under the name on the slip.
    expect(sheet.rows.filter((r) => r.accountNumber.replace(/-/g, "") === REGISTERED_NUMBER)).toHaveLength(1);
    expect(row?.accountId).toBe("21");
    expect(row?.accountName).toBe("ทดสอบ (ครัว)");
  });

  it("links a kept row even when the roster account was dismissed", async () => {
    // The workaround operators actually used for the duplicate: delete the
    // roster row, keep the hand-typed one. That row still gets linked+renamed.
    const period = "2031-07";
    writeFileSync(
      join(dir, "sheets", `${period}.json`),
      JSON.stringify({
        period,
        effectiveDate: "",
        rows: [structuredClone(handTypedRow)],
        generalNotes: "",
        dismissed: ["21"],
        updatedAt: "2026-08-04T00:00:00.000Z",
      })
    );
    const sheet = await loadSheet(period);
    const rows = sheet.rows.filter((r) => r.accountNumber.replace(/-/g, "") === REGISTERED_NUMBER);
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe("21");
    expect(rows[0].accountName).toBe("นางสาวทดสอบ ยี่สิบเอ็ด");
    expect(rows[0].salary).toBe(12000);
  });

  it("does not resurrect a dismissed account", async () => {
    const period = "2031-05";
    writeFileSync(
      join(dir, "sheets", `${period}.json`),
      JSON.stringify({
        period,
        effectiveDate: "",
        rows: [],
        generalNotes: "",
        dismissed: ["21"],
        updatedAt: "2026-08-04T00:00:00.000Z",
      })
    );
    const sheet = await loadSheet(period);
    expect(sheet.rows.map((r) => r.accountId)).not.toContain("21");
  });
});

// A row with every money column zeroed, so each test below sets exactly the
// fields it is about and nothing else can drift into the arithmetic. Shaped
// off handTypedRow rather than importing SheetRow, because src/sheets is only
// reachable through the dynamic import above (DATA_PATH has to be set first).
type Row = typeof handTypedRow;

function zeroRow(over: Partial<Row> = {}): Row {
  return {
    ...structuredClone(handTypedRow),
    accountId: "m-takehome-0001",
    accountName: "ทดสอบ ยอดโอน",
    note: "",
    salary: 0,
    socialSecurity: 0,
    savings: 0,
    welfareFund: 0,
    ...over,
  };
}

describe("takeHome", () => {
  it("subtracts กองทุนสงเคราะห์ลูกจ้าง like any other deduction", () => {
    // Only welfareFund is non-zero, so the row proves the field is actually
    // wired into the sum — a column that is displayed but never subtracted
    // pays the employee 0.25% too much and still looks right on screen.
    expect(takeHome(zeroRow({ salary: 10000, welfareFund: 25 }))).toBe(9975);
  });

  it("leaves take-home unchanged by the carve-out", () => {
    // The owner's whole reason for carving the EWF out of เงินสะสม instead of
    // adding it on top: 5% becomes 4.75% + 0.25%, and the employee's net does
    // not move. Same salary, same net, either side of 2026-10.
    const before = zeroRow({ salary: 12000, socialSecurity: 600, savings: 600, welfareFund: 0 });
    const after = zeroRow({ salary: 12000, socialSecurity: 600, savings: 570, welfareFund: 30 });
    expect(takeHome(before)).toBe(10800);
    expect(takeHome(after)).toBe(10800);
  });

  it("never charges the employee the employer's matching เงินสมทบ", () => {
    // The employer owes 0.25% on top, but it is employer cost — new money the
    // hotel remits, never withheld. If the derived employer figure ever leaks
    // into the row's deductions the net drops by a second 0.25% (฿10770 here),
    // which is the one way this change can quietly underpay someone.
    const row = zeroRow({ salary: 12000, socialSecurity: 600, savings: 570, welfareFund: 30 });
    const deductions = row.socialSecurity + row.savings + row.welfareFund;
    expect(takeHome(row)).toBe(row.salary - deductions);
    expect(takeHome(row)).not.toBe(row.salary - deductions - row.welfareFund);
  });

  it("still counts the additions alongside the new deduction", () => {
    const row = zeroRow({ salary: 12000, socialSecurity: 600, savings: 570, welfareFund: 30, ot: 500, breakfast: 100 });
    expect(takeHome(row)).toBe(11400);
  });
});

describe("loadSheet — sheets written before welfareFund existed", () => {
  it("reads a missing welfareFund as 0 rather than NaN", async () => {
    // The regression this guards: data/sheets/*.json already on disk have no
    // welfareFund key at all, so the row arrives with `undefined`, every sum
    // touching it becomes NaN, and the worksheet renders NaN in the ยอดโอน
    // column for a cycle nobody edited. normalize() is not exported, so this
    // goes through loadSheet(), which is what actually runs it in production.
    const period = "2031-08";
    const legacyRow = {
      accountId: "m-legacy-0002",
      accountNumber: "555-1-23456-7", // not on the roster, so it stays its own row
      accountName: "ทดสอบ แถวเก่า",
      bank: "KBANK",
      nickname: "",
      position: "",
      salary: 10000,
      socialSecurity: 500,
      savings: 500,
      // welfareFund deliberately absent — this is the old on-disk shape.
      advance: 0,
      loan: 0,
      interest: 0,
      roomCost: 0,
      leave: 0,
      otherDeduction: 0,
      commission: 0,
      breakfast: 0,
      ot: 0,
      otherAddition: 0,
      note: "",
    } as unknown as Row;
    writeFileSync(
      join(dir, "sheets", `${period}.json`),
      JSON.stringify({
        period,
        effectiveDate: "",
        rows: [legacyRow],
        generalNotes: "",
        dismissed: [],
        updatedAt: "2026-08-04T00:00:00.000Z",
      })
    );

    const sheet = await loadSheet(period);
    const row = sheet.rows.find((r) => r.accountId === "m-legacy-0002");
    expect(row?.welfareFund).toBe(0);
    expect(takeHome(row!)).toBe(9000);
  });
});
