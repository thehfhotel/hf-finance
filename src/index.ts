import { Elysia, t } from "elysia";
import { readFile } from "node:fs/promises";
import { randomBytes, randomInt } from "node:crypto";
import { buildWorkbook, buildBeneficiaryWorkbook } from "./excel";
import { MAIN_HTML } from "./views/main";
import { ACCOUNTS_HTML } from "./views/accounts";
import { APPROVALS_HTML } from "./views/approvals";
import { WORKSHEET_HTML } from "./views/worksheet";
import { STATUS_HTML } from "./views/status";
import { ADMIN_MODAL_HTML, adminNavHtml } from "./views/admin";
import { HF_BAR_PLACEHOLDER, hfBarScriptTag } from "./views/hf-bar";
import { ACCESS_EMAIL_HEADER, propertyHintFromHeaders } from "./property-hint";
import { addAccount, deleteAccount, listAccounts, updateAccount } from "./store";
import { loadRegistered, registeredByNumber, registeredSet } from "./registered";
import { getRequest, listRequests, submitRequest, submitSyncRequest, updateRequest } from "./queue";
import { notifySlack } from "./slack";
import { isValidPeriod, loadSheet, saveSheet } from "./sheets";
import { CardAssertionError, HF_ID_BASE_URL, cardAssertionJwks, verifyCardAssertion } from "./card";
import { namesAgree } from "./names";
import { createPayrollLedgerFeed } from "./ledger-feed";
import { payrollPaymentDisplay } from "./payroll-settlement";
import {
  KBIZ_QR_ROUTES,
  kbizLoginQrPageResponse,
  kbizLoginQrPngResponse,
  kbizLoginQrStateResponse,
  kbizLoginRequestResponse,
} from "./kbiz-login-qr";

const staticFile = async (path: string, mime: string) => {
  const buf = await readFile(path);
  return new Response(buf, { headers: { "content-type": mime, "cache-control": "public, max-age=86400" } });
};

const accountBody = t.Object({
  accountNumber: t.String({ pattern: "^[0-9\\-\\s]{6,30}$" }),
  accountName: t.String({ minLength: 1, maxLength: 100 }),
});

// In-memory OTP challenges keyed by request id. Lost on restart (rare and
// safe — approver just requests a new OTP). Each entry: 6-digit code, TTL,
// attempt counter.
const OTP_TTL_MS = 5 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const otpChallenges = new Map<string, { otp: string; expiresAt: number; attempts: number }>();
const newOtp = () => String(randomInt(100000, 1_000_000));

// Admin session unlock — gates the สร้างไฟล์ (/) and คิวอนุมัติ (/approvals)
// pages plus their state-changing endpoints. Two-step Slack OTP:
//   POST /api/admin/request-otp  → returns { token }, sends OTP to Slack
//   POST /api/admin/unlock       → { token, otp } → sets admin_session cookie
// Sessions and pending OTPs are in-memory; restart logs everyone out.
const ADMIN_SESSION_TTL_MS = 4 * 60 * 60_000; // 4h
// sessionId → session. Started life as a bare `number` (expiresAt); widened to
// an object so card-login (NFC staff tap) can record WHO unlocked (badge/name)
// alongside the expiry. OTP unlocks leave badge/name undefined.
type AdminSession = { expiresAt: number; badge?: string; name?: string };
const adminSessions = new Map<string, AdminSession>();
const adminOtpChallenges = new Map<string, { otp: string; expiresAt: number; attempts: number }>(); // pre-unlock token → challenge

function parseCookies(header: string | undefined | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function isAdminUnlocked(headers: Record<string, string | undefined>): boolean {
  const sid = parseCookies(headers.cookie)["admin_session"];
  if (!sid) return false;
  const session = adminSessions.get(sid);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    adminSessions.delete(sid);
    return false;
  }
  return true;
}

// The app sits behind Cloudflare, which terminates TLS and forwards the
// original scheme in X-Forwarded-Proto. Add `; Secure` to cookies when the
// edge saw https so the session/claim cookies never travel over plain http.
function secureCookieSuffix(headers: Record<string, string | undefined>): string {
  const proto = (headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return proto === "https" ? "; Secure" : "";
}

function renderHTML(
  template: string,
  currentPath: string,
  isAdmin: boolean,
  headers: Record<string, string | undefined>,
): Response {
  const body = template
    .replace("<!--ADMIN_NAV-->", adminNavHtml(currentPath, isAdmin))
    .replace("<!--ADMIN_MODAL-->", ADMIN_MODAL_HTML)
    // A replacer function, so nothing in the tag is read as a `$` substitution.
    .replace(HF_BAR_PLACEHOLDER, () => hfBarScriptTag(propertyHintFromHeaders(headers)));
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The HTML embeds inline JS that posts to /api/queue/transfer with
      // a `period` field added in fc94153. Browsers cache HTML aggressively
      // by default, so this must never be served from a cache.
      //
      // Stronger than the previous "no-cache, must-revalidate" because these
      // bytes are now PER IDENTITY: the estate band's `data-property` comes
      // from the caller's Access identity, and the admin nav from their
      // session cookie. One payroll instance serves both properties, so a
      // shell reused across identities would scope the wrong desk — worse
      // than never scoping at all. "no-cache" still permits a shared cache to
      // STORE the response; "private, no-store" permits neither.
      "cache-control": "private, no-store",
      // Names the identity on both sides of Cloudflare: the origin varies on
      // the header the edge injects, while anything upstream of the edge
      // (nginx, the browser) only ever sees the cookies that produced it —
      // CF_Authorization, and `admin_session` for the nav. Belt and braces
      // behind no-store, for any cache that ignores it.
      vary: `${ACCESS_EMAIL_HEADER}, Cookie`,
    },
  });
}

// Derive a YYYY-MM period from a "DD/MM/YYYY" effectiveDate string. Server
// fallback for queue submissions that came from stale clients which don't
// send body.period — without this, summary.sheet would silently be missing.
function periodFromEffective(eff: string | undefined): string | undefined {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(eff || "");
  return m ? `${m[3]}-${m[2]}` : undefined;
}

// Thai/Buddhist-era label for a YYYY-MM period, e.g. "2026-05" → "พฤษภาคม 2569".
const TH_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];
function periodLabelTH(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return period;
  return `${TH_MONTHS[Number(m[2]) - 1]} ${Number(m[1]) + 543}`;
}

function adminGuard(headers: Record<string, string | undefined>, set: { status?: number }): true | Response {
  if (isAdminUnlocked(headers)) return true;
  set.status = 401;
  return new Response("ต้องเข้าโหมด admin ก่อน", { status: 401 });
}


const app = new Elysia()
  .use(createPayrollLedgerFeed())
  .get("/", ({ headers, redirect }) =>
    isAdminUnlocked(headers) ? renderHTML(MAIN_HTML, "/", true, headers) : redirect("/worksheet", 302)
  )
  .get("/worksheet", ({ headers }) => renderHTML(WORKSHEET_HTML, "/worksheet", isAdminUnlocked(headers), headers))
  .get("/accounts", ({ headers }) => renderHTML(ACCOUNTS_HTML, "/accounts", isAdminUnlocked(headers), headers))
  .get("/approvals", ({ headers, redirect }) =>
    isAdminUnlocked(headers) ? renderHTML(APPROVALS_HTML, "/approvals", true, headers) : redirect("/worksheet", 302)
  )
  .get("/status", ({ headers }) => renderHTML(STATUS_HTML, "/status", isAdminUnlocked(headers), headers))
  .get("/health", () => "ok")

  // K BIZ QR login handoff (CR-2026-09-17). kbiz-bot cannot log in unattended
  // any more — the bank demands a scan from the K BIZ phone app on every web
  // login — so the bot publishes the QR and payroll-form shows it to whoever
  // the payroll hostname's Cloudflare Access app admits. The POST is the
  // operator's button: the only thing this side writes (`login.request`), and
  // the only way a login ever starts. No origin auth of its own — the header
  // it records is informational (see src/property-hint.ts for why this app
  // verifies nothing here).
  .get(KBIZ_QR_ROUTES.page, () => kbizLoginQrPageResponse())
  .get(KBIZ_QR_ROUTES.png, () => kbizLoginQrPngResponse())
  .get(KBIZ_QR_ROUTES.state, () => kbizLoginQrStateResponse())
  .post(KBIZ_QR_ROUTES.request, ({ headers }) => kbizLoginRequestResponse({ headers }))

  // Sanitised status feed for the /status page — no per-row PII, no xlsx
  // path, no embedded sheet snapshot. Just enough for HR to track their
  // own submissions through to the KBIZ result. Open to non-admins on
  // purpose: counterpart to the open POST /api/queue/transfer.
  .get("/api/queue/status", async () => {
    const all = await listRequests();
    return all.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      period: r.summary.type === "transfer-payroll" ? r.summary.period : undefined,
      effectiveDate: r.summary.type === "transfer-payroll" ? r.summary.effectiveDate : undefined,
      totalAmount: r.summary.type === "transfer-payroll" ? r.summary.totalAmount : undefined,
      recipientCount:
        r.summary.type === "transfer-payroll" ? r.summary.rows.length :
        r.summary.type === "add-payroll" ? r.summary.accounts.length : 0,
      createdAt: r.createdAt,
      approvedAt: r.approvedAt,
      rejectedAt: r.rejectedAt,
      rejectionReason: r.rejectionReason,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      result: r.result ? {
        success: r.result.success,
        finalUrl: r.result.finalUrl,
        referenceNo: r.result.referenceNo,
        error: r.result.error,
      } : undefined,
      ...payrollPaymentDisplay(r),
    }));
  })

  // Admin OTP unlock flow. Pre-unlock token is single-use; on success a
  // 4-hour session cookie is set. Lock endpoint clears both server-side
  // session and the cookie.
  .post("/api/admin/request-otp", async () => {
    const token = randomBytes(16).toString("hex");
    const otp = newOtp();
    adminOtpChallenges.set(token, { otp, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });
    await notifySlack(`:closed_lock_with_key: *Admin unlock OTP*\nOTP: \`${otp}\`  (5 นาที)`);
    return { token };
  })
  .post(
    "/api/admin/unlock",
    ({ body, set }) => {
      const ch = adminOtpChallenges.get(body.token);
      if (!ch) { set.status = 400; return "ยังไม่ได้ขอ OTP — กดส่ง OTP อีกครั้ง"; }
      if (Date.now() > ch.expiresAt) {
        adminOtpChallenges.delete(body.token);
        set.status = 400;
        return "OTP หมดอายุแล้ว กรุณาขอ OTP ใหม่";
      }
      ch.attempts++;
      if (ch.attempts > OTP_MAX_ATTEMPTS) {
        adminOtpChallenges.delete(body.token);
        set.status = 429;
        return "ลอง OTP เกินจำนวนที่อนุญาต กรุณาขอ OTP ใหม่";
      }
      if (ch.otp !== body.otp.trim()) {
        set.status = 400;
        return `OTP ไม่ถูกต้อง (ลอง ${ch.attempts}/${OTP_MAX_ATTEMPTS})`;
      }
      adminOtpChallenges.delete(body.token);
      const sid = randomBytes(24).toString("hex");
      const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
      adminSessions.set(sid, { expiresAt });
      set.headers["set-cookie"] = `admin_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ADMIN_SESSION_TTL_MS / 1000}`;
      return { unlocked: true, expiresAt };
    },
    { body: t.Object({ token: t.String({ minLength: 1, maxLength: 64 }), otp: t.String({ pattern: "^\\d{6}$" }) }) }
  )
  .post("/api/admin/lock", ({ headers, set }) => {
    const sid = parseCookies(headers.cookie)["admin_session"];
    if (sid) adminSessions.delete(sid);
    set.headers["set-cookie"] = `admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
    return { unlocked: false };
  })

  // ── Card login — "tap your NFC staff card to unlock" ──────────────────────
  // A per-terminal browser pairs to a `reader_id`, then this backend talks
  // server-to-server to the central HF ID service (browsers never reach HF ID
  // directly). HF ID mints a signed card assertion on a tap; we verify it and
  // mint payroll's normal `admin_session`. The whole surface ships DARK: with
  // READER_RESOLVE_SECRET unset both routes return 503 and the UI shows
  // "card login not configured".
  //
  // 1) /card-login/start — claim a reader→app binding, stash the claim token
  //    in a short-lived HttpOnly cookie the wait poll reads back.
  .post(
    "/card-login/start",
    async ({ body, headers, set }) => {
      const secret = process.env.READER_RESOLVE_SECRET;
      if (!secret) { set.status = 503; return { error: "not_configured" }; }
      let res: globalThis.Response;
      try {
        res = await fetch(`${HF_ID_BASE_URL}/api/private/reader/claim`, {
          method: "POST",
          headers: { "content-type": "application/json", "X-Reader-Secret": secret },
          body: JSON.stringify({ reader_id: body.reader_id, app: "payroll" }),
        });
      } catch {
        set.status = 502; return { error: "central_unreachable" };
      }
      if (!res.ok) { set.status = 502; return { error: "claim_failed" }; }
      const data = (await res.json().catch(() => null)) as { claim_token?: string } | null;
      if (!data?.claim_token) { set.status = 502; return { error: "claim_failed" }; }
      set.headers["set-cookie"] =
        `card_claim=${data.claim_token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secureCookieSuffix(headers)}`;
      return { ok: true };
    },
    { body: t.Object({ reader_id: t.String({ minLength: 1, maxLength: 128 }) }) }
  )
  // 2) /card-login/wait — long-poll the central /wait with the stashed claim.
  //    204 → no tap yet (client re-polls). 200 → verify the assertion and mint
  //    the payroll session. 403 → tapped employee lacks the payroll grant.
  //    401 → assertion failed verification.
  .get("/card-login/wait", async ({ headers, set }) => {
    const secret = process.env.READER_RESOLVE_SECRET;
    if (!secret) { set.status = 503; return { error: "not_configured" }; }
    const claimToken = parseCookies(headers.cookie)["card_claim"];
    if (!claimToken) { set.status = 400; return { error: "no_claim" }; }

    let res: globalThis.Response;
    try {
      res = await fetch(`${HF_ID_BASE_URL}/api/private/reader/wait`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Reader-Secret": secret },
        body: JSON.stringify({ claim_token: claimToken }),
      });
    } catch {
      set.status = 502; return { error: "central_unreachable" };
    }

    if (res.status === 204) { set.status = 204; return ""; }              // no tap yet
    if (res.status === 403) { set.status = 403; return { error: "not_authorized" }; }
    if (!res.ok) { set.status = 502; return { error: "wait_failed" }; }

    const data = (await res.json().catch(() => null)) as { assertion?: string } | null;
    if (!data?.assertion) { set.status = 502; return { error: "wait_failed" }; }

    let identity;
    try {
      identity = await verifyCardAssertion(data.assertion, cardAssertionJwks);
    } catch (e) {
      if (e instanceof CardAssertionError && e.reason === "not_authorized") {
        set.status = 403; return { error: "not_authorized" };
      }
      set.status = 401; return { error: "invalid_assertion" };
    }

    // Success → mint the payroll session (same shape as the OTP unlock block),
    // tagging it with the tapped employee's badge/name.
    const sid = randomBytes(24).toString("hex");
    const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
    adminSessions.set(sid, { expiresAt, badge: identity.badge || undefined, name: identity.name });
    set.headers["set-cookie"] =
      `admin_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ADMIN_SESSION_TTL_MS / 1000}${secureCookieSuffix(headers)}`;
    return { ok: true, name: identity.name };
  })

  .get("/static/flatpickr.css", () => staticFile("node_modules/flatpickr/dist/flatpickr.min.css", "text/css; charset=utf-8"))
  .get("/static/flatpickr.js", () => staticFile("node_modules/flatpickr/dist/flatpickr.min.js", "application/javascript; charset=utf-8"))
  .get("/static/flatpickr-th.js", () => staticFile("node_modules/flatpickr/dist/l10n/th.js", "application/javascript; charset=utf-8"))
  .get("/static/html2canvas.js", () => staticFile("node_modules/html2canvas/dist/html2canvas.min.js", "application/javascript; charset=utf-8"))

  .get("/api/accounts", async () => {
    const accounts = await listAccounts();
    const reg = await registeredByNumber();
    return accounts.map((a) => {
      const bankName = reg.get(a.accountNumber)?.payeeName?.trim() ?? "";
      // accountName already IS the bank's name — KBIZ is the source of truth.
      // The flag says the operator's original entry disagreed with it, which
      // is worth a human look (a bank typo, or the wrong account number).
      const nameMismatch = !!(bankName && a.enteredName && !namesAgree(a.enteredName, bankName));
      return { ...a, registered: reg.has(a.accountNumber), bankName, nameMismatch };
    });
  })
  .get("/api/registered", async () => (await loadRegistered()) ?? { fetchedAt: null, count: 0, accounts: [] })
  .post("/api/accounts", ({ body }) => addAccount(body), { body: accountBody })
  .put("/api/accounts/:id", ({ params, body }) => updateAccount(params.id, body), { body: accountBody })
  .delete("/api/accounts/:id", async ({ params, set }) => {
    await deleteAccount(params.id);
    set.status = 204;
    return "";
  })

  .get("/api/sheets/:period", async ({ params, set }) => {
    if (!isValidPeriod(params.period)) { set.status = 400; return "invalid period (expected YYYY-MM)"; }
    return loadSheet(params.period);
  })
  .put(
    "/api/sheets/:period",
    async ({ params, body, set }) => {
      if (!isValidPeriod(params.period)) { set.status = 400; return "invalid period (expected YYYY-MM)"; }
      return saveSheet(params.period, body);
    },
    {
      body: t.Object({
        effectiveDate: t.String({ maxLength: 10 }),
        generalNotes: t.String({ maxLength: 5000 }),
        dismissed: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 40 }), { maxItems: 500 })),
        rows: t.Array(
          t.Object({
            accountId: t.String({ minLength: 1, maxLength: 40 }),
            accountNumber: t.String({ maxLength: 30 }),
            accountName: t.String({ maxLength: 100 }),
            bank: t.String({ maxLength: 20 }),
            nickname: t.String({ maxLength: 50 }),
            position: t.String({ maxLength: 50 }),
            salary: t.Number({ minimum: 0 }),
            socialSecurity: t.Number({ minimum: 0 }),
            savings: t.Number({ minimum: 0 }),
            advance: t.Number({ minimum: 0 }),
            loan: t.Number({ minimum: 0 }),
            interest: t.Number({ minimum: 0 }),
            roomCost: t.Number({ minimum: 0 }),
            leave: t.Number({ minimum: 0 }),
            otherDeduction: t.Number({ minimum: 0 }),
            commission: t.Number({ minimum: 0 }),
            breakfast: t.Number({ minimum: 0 }),
            ot: t.Number({ minimum: 0 }),
            otherAddition: t.Number({ minimum: 0 }),
            note: t.String({ maxLength: 500 }),
          }),
          { maxItems: 200 }
        ),
      }),
    }
  )

  // Manual adjustment of a closed cycle. The worksheet lock (past the 5th-of-
  // next-month payout) is advisory UX, not an approval gate: HR can still edit
  // a past month, but doing so is a "special manual request" we put on record
  // by pinging admins on Slack. Best-effort — notifySlack swallows its own
  // errors, so a Slack outage never blocks the edit.
  .post(
    "/api/sheets/:period/adjust-request",
    async ({ params, body, set }) => {
      if (!isValidPeriod(params.period)) { set.status = 400; return "invalid period (expected YYYY-MM)"; }
      const reason = (body?.reason || "").trim();
      await notifySlack(
        `:unlock: *Past payroll edit — manual adjustment*\n` +
          `• Cycle: ${periodLabelTH(params.period)} (${params.period}) — payout already passed\n` +
          `• Reason: ${reason || "(none given)"}\n` +
          `• Worksheet: <http://localhost:3000/worksheet|open>`
      );
      return { ok: true };
    },
    { body: t.Object({ reason: t.Optional(t.String({ maxLength: 500 })) }) }
  )

  .post(
    "/generate-beneficiary",
    async ({ body, set }) => {
      // KBIZ rejects uploads containing already-registered accounts.
      // Filter them out here using the latest scrape from kbiz-bot.
      const reg = await registeredSet();
      const filtered = body.accounts.filter((a) => !reg.has(a.accountNumber));
      const skipped = body.accounts.length - filtered.length;
      if (filtered.length === 0) {
        set.status = 400;
        return `บัญชีที่เลือกทั้งหมด (${skipped}) ลงทะเบียนกับ KBIZ แล้ว`;
      }
      const buf = await buildBeneficiaryWorkbook(filtered);
      const stamp = new Date().toISOString().slice(0, 10);
      set.headers["content-type"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      set.headers["content-disposition"] = `attachment; filename="KBIZAddBeneficiary-${stamp}.xlsx"`;
      if (skipped > 0) set.headers["x-skipped-registered"] = String(skipped);
      return buf;
    },
    {
      body: t.Object({
        accounts: t.Array(
          t.Object({
            accountNumber: t.String({ minLength: 1, maxLength: 20 }),
            accountName: t.String({ minLength: 1, maxLength: 100 }),
          }),
          { minItems: 1, maxItems: 100 }
        ),
      }),
    }
  )

  .post(
    // Open to non-admins: HR submits transfer requests; admins approve them
    // separately via /approvals (still OTP-gated). The submission contains
    // sensitive row/amount data, but only HR can land here in the first
    // place — there's no anonymous internet access (Cloudflare tunnel only).
    "/api/queue/transfer",
    async ({ body }) => {
      const buf = await buildWorkbook(body);
      const totalAmount = body.rows.reduce((s, r) => s + r.amount, 0);
      // Snapshot the full worksheet (deductions/additions/notes) into the
      // queue item. The worksheet has just been autosaved by the client
      // before submit — loadSheet() returns the current on-disk state.
      // If the client didn't send `period` (stale tab), derive it from the
      // effective date so the snapshot is still recorded.
      const period = body.period && isValidPeriod(body.period)
        ? body.period
        : periodFromEffective(body.effectiveDate);
      const sheet = period ? await loadSheet(period) : undefined;
      const req = await submitRequest({
        type: "transfer-payroll",
        summary: {
          type: "transfer-payroll",
          effectiveDate: body.effectiveDate,
          totalAmount: Math.round(totalAmount * 100) / 100,
          rows: body.rows,
          period,
          sheet,
        },
        xlsxBuffer: buf,
      });
      const fmt = totalAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      await notifySlack(
        `:moneybag: *Payroll transfer awaiting approval*\n` +
          `• Effective: ${body.effectiveDate}\n` +
          `• ${body.rows.length} recipient(s), total ฿${fmt}\n` +
          `• Review: <http://localhost:3000/approvals|/approvals> (id: \`${req.id}\`)`
      );
      return req;
    },
    {
      body: t.Object({
        effectiveDate: t.String({ pattern: "^\\d{2}/\\d{2}/\\d{4}$" }),
        period: t.Optional(t.String({ pattern: "^\\d{4}-(0[1-9]|1[0-2])$" })),
        rows: t.Array(
          t.Object({
            accountNumber: t.String({ minLength: 1, maxLength: 20 }),
            accountName: t.String({ minLength: 1, maxLength: 100 }),
            amount: t.Number({ exclusiveMinimum: 0 }),
          }),
          { minItems: 1, maxItems: 100 }
        ),
      }),
    }
  )

  .post(
    "/api/queue/add-payroll",
    async ({ body, set }) => {
      const reg = await registeredSet();
      const filtered = body.accounts.filter((a) => !reg.has(a.accountNumber));
      if (filtered.length === 0) {
        set.status = 400;
        return `บัญชีที่เลือกทั้งหมด (${body.accounts.length}) ลงทะเบียนกับ KBIZ แล้ว`;
      }
      const buf = await buildBeneficiaryWorkbook(filtered);
      const req = await submitRequest({
        type: "add-payroll",
        summary: { type: "add-payroll", accounts: filtered },
        xlsxBuffer: buf,
      });
      await notifySlack(
        `:bust_in_silhouette: *Add Payroll Account awaiting approval*\n` +
          `• ${filtered.length} new account(s)\n` +
          `• Review: <http://localhost:3000/approvals|/approvals> (id: \`${req.id}\`)`
      );
      return req;
    },
    {
      body: t.Object({
        accounts: t.Array(
          t.Object({
            accountNumber: t.String({ minLength: 1, maxLength: 20 }),
            accountName: t.String({ minLength: 1, maxLength: 100 }),
          }),
          { minItems: 1, maxItems: 100 }
        ),
      }),
    }
  )

  // Open like the other queue POSTs (the app itself is Cloudflare-gated).
  // Read-only sync — born approved, no OTP; the bot picks it up on its next
  // poll. Returns the in-flight request if one is already queued/running.
  .post("/api/queue/sync-registered", () => submitSyncRequest())

  // Bulk listing stays admin-gated — /status uses the sanitised
  // /api/queue/status feed for HR. Single-item GET + xlsx are open so
  // that the /worksheet?snapshot=<id> view and the "ดาวน์โหลด xlsx" link
  // on /status work without requiring an admin OTP.
  .get("/api/queue", async ({ headers, set }) => {
    const guard = adminGuard(headers, set);
    if (guard !== true) return guard;
    return (await listRequests()).map((request) => ({ ...request, ...payrollPaymentDisplay(request) }));
  })
  .get("/api/queue/:id", async ({ params, set }) => {
    const req = await getRequest(params.id);
    if (!req) { set.status = 404; return "not found"; }
    return req;
  })
  .get("/api/queue/:id/xlsx", async ({ params, set }) => {
    const req = await getRequest(params.id);
    if (!req) { set.status = 404; return "not found"; }
    const buf = await readFile(req.xlsxPath);
    set.headers["content-type"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    set.headers["content-disposition"] = `attachment; filename="${params.id}.xlsx"`;
    return buf;
  })
  .post(
    "/api/queue/:id/request-otp",
    async ({ params, headers, set }) => {
      const guard = adminGuard(headers, set);
      if (guard !== true) return guard;
      const existing = await getRequest(params.id);
      if (!existing) { set.status = 404; return "not found"; }
      if (existing.status !== "pending") { set.status = 409; return `cannot OTP-challenge (status: ${existing.status})`; }
      const otp = newOtp();
      const expiresAt = Date.now() + OTP_TTL_MS;
      otpChallenges.set(params.id, { otp, expiresAt, attempts: 0 });
      await notifySlack(
        `:closed_lock_with_key: *OTP เพื่ออนุมัติ* \`${existing.id}\` (${existing.type})\n` +
          `OTP: \`${otp}\`  (5 นาที)`
      );
      return { sent: true };
    }
  )
  .post(
    "/api/queue/:id/approve",
    async ({ params, body, headers, set }) => {
      const guard = adminGuard(headers, set);
      if (guard !== true) return guard;
      const existing = await getRequest(params.id);
      if (!existing) { set.status = 404; return "not found"; }
      if (existing.status !== "pending") { set.status = 409; return `cannot approve (status: ${existing.status})`; }
      const ch = otpChallenges.get(params.id);
      if (!ch) { set.status = 400; return "ยังไม่ได้ขอ OTP — กดปุ่มอนุมัติใหม่อีกครั้ง"; }
      if (Date.now() > ch.expiresAt) {
        otpChallenges.delete(params.id);
        set.status = 400;
        return "OTP หมดอายุแล้ว กรุณาขอ OTP ใหม่";
      }
      ch.attempts++;
      if (ch.attempts > OTP_MAX_ATTEMPTS) {
        otpChallenges.delete(params.id);
        set.status = 429;
        return "ลอง OTP เกินจำนวนที่อนุญาต กรุณาขอ OTP ใหม่";
      }
      if (ch.otp !== body.otp.trim()) {
        set.status = 400;
        return `OTP ไม่ถูกต้อง (ลอง ${ch.attempts}/${OTP_MAX_ATTEMPTS})`;
      }
      otpChallenges.delete(params.id);
      const updated = await updateRequest(params.id, {
        status: "approved",
        approvedAt: new Date().toISOString(),
      });
      await notifySlack(`:white_check_mark: Approved \`${updated.id}\` (${updated.type}) — ready for KBIZ`);
      return updated;
    },
    { body: t.Object({ otp: t.String({ pattern: "^\\d{6}$" }) }) }
  )
  .post(
    "/api/queue/:id/reject",
    async ({ params, body, headers, set }) => {
      const guard = adminGuard(headers, set);
      if (guard !== true) return guard;
      const existing = await getRequest(params.id);
      if (!existing) { set.status = 404; return "not found"; }
      if (existing.status !== "pending") { set.status = 409; return `cannot reject (status: ${existing.status})`; }
      const updated = await updateRequest(params.id, {
        status: "rejected",
        rejectedAt: new Date().toISOString(),
        rejectionReason: body?.reason,
      });
      await notifySlack(`:x: Rejected \`${updated.id}\` (${updated.type})${body?.reason ? ` — ${body.reason}` : ""}`);
      return updated;
    },
    { body: t.Optional(t.Object({ reason: t.Optional(t.String({ maxLength: 500 })) })) }
  )

  // Legacy direct-download endpoints (PoC, kept as fallback)
  .post(
    "/generate",
    async ({ body, headers, set }) => {
      const guard = adminGuard(headers, set);
      if (guard !== true) return guard;
      const buf = await buildWorkbook(body);
      const stamp = body.effectiveDate.replaceAll("/", "-");
      set.headers["content-type"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      set.headers["content-disposition"] = `attachment; filename="KBIZPayroll-${stamp}.xlsx"`;
      return buf;
    },
    {
      body: t.Object({
        effectiveDate: t.String({ pattern: "^\\d{2}/\\d{2}/\\d{4}$" }),
        rows: t.Array(
          t.Object({
            accountNumber: t.String({ minLength: 1, maxLength: 20 }),
            accountName: t.String({ minLength: 1, maxLength: 100 }),
            amount: t.Number({ exclusiveMinimum: 0 }),
          }),
          { minItems: 1, maxItems: 100 }
        ),
      }),
    }
  )
  .listen({ hostname: "0.0.0.0", port: Number(process.env.PORT ?? 3000) });

console.log(`payroll-form listening on http://${app.server?.hostname}:${app.server?.port}`);
