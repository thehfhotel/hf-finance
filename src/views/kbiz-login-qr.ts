import type { KbizPageState, KbizQrStatus } from "../kbiz-login-qr";

// K BIZ QR login handoff — the operator-facing page (CR-2026-09-17).
//
// Standalone on purpose: no app nav, no admin modal, no HF One bar. It is a
// single-job page an operator opens from a Slack link ON A LAPTOP (phone
// second — the K BIZ app cannot scan a QR off the same screen, so a scan
// always needs a second screen), presses one button, scans with the K BIZ
// phone app, and closes.
//
// The bot never starts a login by itself any more: it keeps its session alive,
// publishes `session.json` on every check, and only runs the QR handoff when
// this page has written `login.request`. So the page shows one of four things,
// in the contract's priority order (`kbizPageView`): the QR, "preparing", the
// live session, or the button.
//
// The page is server-rendered for the state at request time AND polls
// `KBIZ_QR_ROUTES.state` every 5 s, updating the same nodes in place — that is
// why the copy, the routes and the first state are emitted once as JSON and
// reused by both sides instead of being written twice. The route paths are
// passed in by the caller (src/kbiz-login-qr.ts owns them) so this view has
// no value import back into the module that renders it.
//
// Auth: none here, deliberately. `payroll.thehfhotel.org` is gated by a
// whole-hostname Cloudflare Access app; see `src/property-hint.ts` for why
// this app verifies nothing at the origin.

type Copy = { badge: string; th: string; en: string };

const COPY: Record<KbizQrStatus, Copy> = {
  idle: {
    badge: "ว่าง",
    th: "ยังไม่มีคำขอสแกนในขณะนี้",
    en: "No scan pending.",
  },
  waiting: {
    badge: "รอสแกน",
    th: "สแกน QR ด้านล่างด้วยแอป K BIZ ภายใน 5 นาที",
    en: "Scan the QR below with the K BIZ app within 5 minutes.",
  },
  ok: {
    badge: "เข้าสู่ระบบแล้ว",
    th: "เข้าสู่ระบบ K BIZ เรียบร้อยแล้ว ปิดหน้านี้ได้เลย",
    en: "Logged in to K BIZ. You can close this page.",
  },
  // Nothing retries on its own since CR-2026-09-17 — the operator presses the
  // button again when a second screen is at hand, so the copy must not promise
  // a new QR that no one is going to ask for.
  expired: {
    badge: "หมดเวลา",
    th: "QR หมดอายุแล้ว กดปุ่มด้านล่างเพื่อขอใหม่เมื่อพร้อม",
    en: "The QR expired. Press the button below to ask for a new one.",
  },
  error: {
    badge: "ผิดพลาด",
    th: "อ่านสถานะการเข้าสู่ระบบไม่ได้",
    en: "Could not read the login state.",
  },
};

/**
 * The two states that come from `session.json` / `login.request` rather than
 * from the QR publication. `alive.th` is a PREFIX: the session's start time is
 * appended (raw ISO server-side, localised by the poller the moment it runs).
 */
const PAGE_COPY = {
  preparing: {
    badge: "กำลังเตรียม",
    th: "กำลังเตรียม QR…",
    en: "Preparing the QR — the bot is asking the bank for a code.",
    requestedPrefix: "ขอเมื่อ ",
  },
  alive: {
    badge: "เข้าสู่ระบบอยู่",
    th: "เข้าสู่ระบบ K BIZ อยู่ ตั้งแต่ ",
    en: "The K BIZ session is alive — nothing to do.",
  },
  button: {
    label: "เข้าสู่ระบบ K BIZ",
    hint: "กดปุ่มนี้เมื่ออยู่หน้าคอมพิวเตอร์และถือมือถือที่มีแอป K BIZ พร้อมสแกน",
    failed: "ขอเข้าสู่ระบบไม่สำเร็จ ลองใหม่อีกครั้ง",
    // The page is Thai; the POST's machine slugs are not. `qr-already-showing`
    // is the one an operator can act on (scroll down and scan), so it gets its
    // own line — everything else, including `request-write-failed`, falls back
    // to `failed` rather than putting an English slug on a Thai card.
    alreadyShowing: "มี QR รออยู่แล้ว เลื่อนลงไปสแกนได้เลย",
  },
  pendingPrefix: "มีงานรอโอน ",
  pendingSuffix: " รายการ",
  noResult: "ยังไม่มีข้อมูล",
  sessionAlive: "ใช้งานได้",
  sessionDead: "หมดอายุแล้ว",
  dash: "—",
} as const;

const ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
// Replacer FUNCTION, so nothing in the value is read as a `$` substitution.
const esc = (value: string) => value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);

// `<` is the only character that can end the enclosing <script> element early;
// everything else is already legal JSON text. Replacer function again.
const jsonForScript = (value: unknown) => JSON.stringify(value).replace(/</g, () => "\\u003c");

// The cache-buster key is spelled here and nowhere else: the server builds the
// first <img> src from this prefix, and the poller rebuilds later ones from the
// same prefix, handed to it through the boot blob.
const qrSrcPrefix = (pngPath: string) => `${pngPath}?t=`;

/** The URL the <img> points at while a QR is live — cache-busted by updatedAt. */
const qrImageSrc = (pngPath: string, updatedAt: string | null | undefined): string =>
  qrSrcPrefix(pngPath) + encodeURIComponent(updatedAt ?? "");

/** The three paths the page needs: the PNG, the poll, and the button's POST. */
export type KbizQrPageRoutes = { png: string; state: string; request: string };

/** Which of the contract's four states the page is in. */
export type KbizPageView = "qr" | "preparing" | "alive" | "button";

/**
 * The contract's priority order, in one place. The same four lines run in the
 * poller below (they cannot be imported into the browser) — keep them in step.
 * A `waiting` past its deadline never reaches here as `waiting`: the reader
 * has already downgraded it to `expired`, which is what "and not stale" means.
 */
export function kbizPageView(state: KbizPageState): KbizPageView {
  if (state.status === "waiting") return "qr";
  if (state.request) return "preparing";
  if (state.session?.alive) return "alive";
  return "button";
}

/** Server-side times are raw ISO; the poller re-renders them localised at once. */
const asIs = (iso: string | null | undefined): string => iso ?? PAGE_COPY.dash;

function headlineOf(state: KbizPageState, view: KbizPageView): Copy {
  if (view === "preparing") return PAGE_COPY.preparing;
  if (view === "alive") {
    return { badge: PAGE_COPY.alive.badge, th: PAGE_COPY.alive.th + asIs(state.session?.since), en: PAGE_COPY.alive.en };
  }
  return COPY[state.status] ?? COPY.error;
}

/**
 * The line under the headline: what the bot last said, or — while a request is
 * in flight — when it was made. `idle` has never had a handoff at all, so it
 * says so rather than showing an empty gap where a result would be.
 */
function messageOf(state: KbizPageState, view: KbizPageView): string {
  if (view === "preparing") return PAGE_COPY.preparing.requestedPrefix + asIs(state.request?.requestedAt);
  if (state.message) return state.message;
  return state.status === "idle" ? PAGE_COPY.noResult : "";
}

/** Approved queue items waiting on a session — shown whenever there are any. */
function pendingOf(state: KbizPageState): string {
  const pending = state.session?.pending ?? 0;
  return pending > 0 ? PAGE_COPY.pendingPrefix + String(pending) + PAGE_COPY.pendingSuffix : "";
}

function sessionOf(state: KbizPageState): string {
  if (!state.session) return PAGE_COPY.dash;
  return state.session.alive ? PAGE_COPY.sessionAlive : PAGE_COPY.sessionDead;
}

function requestedOf(state: KbizPageState): string {
  if (!state.request) return PAGE_COPY.dash;
  const at = asIs(state.request.requestedAt);
  return state.request.by && state.request.by !== "unknown" ? `${at} · ${state.request.by}` : at;
}

const FONT_HREF = "https://fonts.googleapis.com/css2?family=Sarabun:wght@400;500;600;700&display=swap";

export function renderKbizLoginQrPage(state: KbizPageState, routes: KbizQrPageRoutes): string {
  const view = kbizPageView(state);
  const copy = headlineOf(state, view);
  const pending = pendingOf(state);
  const imgAttr = view === "qr" ? ` src="${esc(qrImageSrc(routes.png, state.updatedAt))}"` : "";
  const boot = jsonForScript({
    copy: COPY,
    page: PAGE_COPY,
    state,
    routes: { state: routes.state, qrSrc: qrSrcPrefix(routes.png), request: routes.request },
  });
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>เข้าสู่ระบบ K BIZ</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONT_HREF}" rel="stylesheet" media="print" onload="this.media='all'">
<noscript><link href="${FONT_HREF}" rel="stylesheet"></noscript>
<style>
  :root {
    font: 16px/1.55 "Sarabun", "Noto Sans Thai", system-ui, sans-serif;
    --hf-brand-500: #8B0000;
    --hf-brand-700: #6B1212;
    --hf-shell: #FAF9F7;
    --hf-panel: #FFFFFF;
    --hf-border: #E8E4DF;
    --hf-text: #26221E;
    --hf-text-muted: #7A7268;
    --hf-success: #2F855A;
    --hf-warning: #B7791F;
    --hf-error: #C53030;
    --hf-info: #2C5282;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--hf-shell); color: var(--hf-text); }
  main { max-width: 620px; margin: 0 auto; padding: 32px 20px 56px; }
  h1 { font-size: 24px; font-weight: 600; margin: 0 0 6px; }
  .lede { margin: 0; font-size: 15px; color: var(--hf-text-muted); }
  .lede-en { margin: 2px 0 0; font-size: 13px; color: var(--hf-text-muted); }

  #card {
    margin-top: 22px; padding: 22px; background: var(--hf-panel);
    border: 1px solid var(--hf-border); border-radius: 12px; text-align: center;
  }
  .badge {
    display: inline-block; margin: 0 0 12px; padding: 3px 12px; border-radius: 999px;
    font-size: 13px; font-weight: 600; background: #EFEDEA; color: var(--hf-text-muted);
  }
  #card[data-status="waiting"] .badge { background: #FDF3E0; color: var(--hf-warning); }
  #card[data-status="ok"] .badge { background: #E6F4EC; color: var(--hf-success); }
  #card[data-status="expired"] .badge { background: #FDECEC; color: var(--hf-error); }
  #card[data-status="error"] .badge { background: #FDECEC; color: var(--hf-error); }
  #card[data-status="idle"] .badge { background: #EAF0F7; color: var(--hf-info); }
  /* The session/request states outrank whatever the last handoff left behind. */
  #card[data-view="preparing"] .badge { background: #FDF3E0; color: var(--hf-warning); }
  #card[data-view="alive"] .badge { background: #E6F4EC; color: var(--hf-success); }

  .headline { margin: 0; font-size: 18px; font-weight: 600; }
  .headline-en { margin: 4px 0 0; font-size: 13px; color: var(--hf-text-muted); }
  .pending { margin: 10px 0 0; font-size: 14px; font-weight: 600; color: var(--hf-brand-700); }
  .message { margin: 10px 0 0; font-size: 14px; color: var(--hf-text-muted); min-height: 1px; }

  /* The bank's QR is a 150px PNG. Blow it up with nearest-neighbour so the
     modules stay crisp squares instead of a blurred bilinear smear. */
  figure.qr { margin: 18px 0 0; display: none; }
  #card[data-view="qr"] figure.qr { display: block; }
  figure.qr img {
    width: min(400px, 100%); max-width: 400px; aspect-ratio: 1 / 1;
    image-rendering: pixelated; background: #FFFFFF;
    border: 1px solid var(--hf-border); border-radius: 8px; padding: 10px;
  }
  figcaption { margin-top: 8px; font-size: 13px; color: var(--hf-text-muted); }

  /* The button exists only in state 4 — there is nothing to ask for while a
     QR is on screen, a request is in flight, or the session is already up. */
  #request { display: none; margin: 18px 0 0; }
  #card[data-view="button"] #request { display: block; }
  #request-btn {
    font: inherit; font-weight: 600; font-size: 17px; color: #FFFFFF;
    background: var(--hf-brand-500); border: 0; border-radius: 10px;
    padding: 14px 26px; min-height: 52px; min-width: min(320px, 100%); cursor: pointer;
  }
  #request-btn:hover:not(:disabled) { background: var(--hf-brand-700); }
  #request-btn:disabled { opacity: 0.55; cursor: progress; }
  .hint { margin: 10px 0 0; font-size: 13px; color: var(--hf-text-muted); }
  .error { margin: 10px 0 0; font-size: 14px; font-weight: 600; color: var(--hf-error); }

  dl.meta {
    margin: 20px 0 0; padding-top: 14px; border-top: 1px solid var(--hf-border);
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 18px; text-align: left;
  }
  dl.meta dt { font-size: 12px; color: var(--hf-text-muted); }
  dl.meta dd { margin: 2px 0 0; font-size: 14px; word-break: break-word; }

  .foot { margin: 18px 0 0; font-size: 12px; color: var(--hf-text-muted); text-align: center; }
  @media (max-width: 480px) { dl.meta { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>เข้าสู่ระบบ K BIZ</h1>
    <p class="lede">ธนาคารขอให้สแกน QR ด้วยแอป K BIZ ทุกครั้งที่เข้าสู่ระบบ เปิดหน้านี้บนคอมพิวเตอร์แล้วสแกนด้วยมือถือ</p>
    <p class="lede-en">K BIZ requires a scan from the K BIZ phone app on every login — open this page on a second screen.</p>
  </header>

  <section id="card" data-status="${esc(state.status)}" data-view="${esc(view)}">
    <p class="badge" id="badge">${esc(copy.badge)}</p>
    <p class="headline" id="headline">${esc(copy.th)}</p>
    <p class="headline-en" id="headline-en">${esc(copy.en)}</p>
    <p class="pending" id="pending"${pending ? "" : " hidden"}>${esc(pending)}</p>

    <figure class="qr">
      <img id="qr" alt="QR สำหรับเข้าสู่ระบบ K BIZ" width="400" height="400"${imgAttr}>
      <figcaption>เปิดแอป K BIZ บนมือถือ แล้วสแกน QR นี้</figcaption>
    </figure>

    <p class="message" id="message">${esc(messageOf(state, view))}</p>

    <div id="request">
      <button type="button" id="request-btn">${esc(PAGE_COPY.button.label)}</button>
      <p class="hint">${esc(PAGE_COPY.button.hint)}</p>
      <p class="error" id="request-error" role="alert" hidden></p>
    </div>

    <dl class="meta">
      <div><dt>เซสชัน</dt><dd id="session">${esc(sessionOf(state))}</dd></div>
      <div><dt>ตรวจล่าสุด</dt><dd id="checked">${esc(asIs(state.session?.checkedAt))}</dd></div>
      <div><dt>คำขอล่าสุด</dt><dd id="requested">${esc(requestedOf(state))}</dd></div>
      <div><dt>เหตุผล</dt><dd id="reason">${esc(state.reason ?? "—")}</dd></div>
      <div><dt>QR ครั้งที่</dt><dd id="attempt">${state.attempt ? esc(String(state.attempt)) : "—"}</dd></div>
      <div><dt>หมดอายุ</dt><dd id="expires">${esc(state.expiresAt ?? "—")}</dd></div>
      <div><dt>อัปเดตล่าสุด</dt><dd id="updated">${esc(state.updatedAt ?? "—")}</dd></div>
    </dl>
  </section>

  <p class="foot">หน้านี้อัปเดตอัตโนมัติทุก 5 วินาที ไม่ต้องกดรีเฟรช · This page refreshes itself every 5 seconds.</p>
</main>

<script type="application/json" id="qr-boot">${boot}</script>
<script>
(function () {
  var boot = JSON.parse(document.getElementById("qr-boot").textContent);
  var COPY = boot.copy;
  var PAGE = boot.page;
  var ROUTES = boot.routes;
  var card = document.getElementById("card");
  var img = document.getElementById("qr");
  var button = document.getElementById("request-btn");
  var errorBox = document.getElementById("request-error");
  var inFlight = false;

  function set(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function when(iso) {
    if (!iso) return PAGE.dash;
    var at = new Date(iso);
    return isNaN(at.getTime()) ? iso : at.toLocaleString("th-TH", { hour12: false });
  }

  // The contract's priority order — the same four lines as kbizPageView().
  function viewOf(state) {
    if (state.status === "waiting") return "qr";
    if (state.request) return "preparing";
    if (state.session && state.session.alive) return "alive";
    return "button";
  }

  function headlineOf(state, view) {
    if (view === "preparing") return PAGE.preparing;
    if (view === "alive") {
      return {
        badge: PAGE.alive.badge,
        th: PAGE.alive.th + when(state.session && state.session.since),
        en: PAGE.alive.en
      };
    }
    return COPY[state.status] || COPY.error;
  }

  function messageOf(state, view) {
    if (view === "preparing") return PAGE.preparing.requestedPrefix + when(state.request && state.request.requestedAt);
    if (state.message) return state.message;
    return state.status === "idle" ? PAGE.noResult : "";
  }

  function requestedOf(state) {
    if (!state.request) return PAGE.dash;
    var at = when(state.request.requestedAt);
    var by = state.request.by;
    return by && by !== "unknown" ? at + " · " + by : at;
  }

  function showError(text) {
    errorBox.textContent = text || "";
    errorBox.hidden = !text;
  }

  // The server answers with a machine slug; the operator reads Thai.
  function errorTextFor(slug) {
    return slug === "qr-already-showing" ? PAGE.button.alreadyShowing : PAGE.button.failed;
  }

  function apply(state) {
    var view = viewOf(state);
    var copy = headlineOf(state, view);
    var pending = state.session && state.session.pending > 0
      ? PAGE.pendingPrefix + String(state.session.pending) + PAGE.pendingSuffix
      : "";
    card.setAttribute("data-status", state.status);
    card.setAttribute("data-view", view);
    set("badge", copy.badge);
    set("headline", copy.th);
    set("headline-en", copy.en);
    set("pending", pending);
    document.getElementById("pending").hidden = !pending;
    set("message", messageOf(state, view));
    set("session", state.session ? (state.session.alive ? PAGE.sessionAlive : PAGE.sessionDead) : PAGE.dash);
    set("checked", when(state.session && state.session.checkedAt));
    set("requested", requestedOf(state));
    set("reason", state.reason || PAGE.dash);
    set("attempt", state.attempt ? String(state.attempt) : PAGE.dash);
    set("expires", when(state.expiresAt));
    set("updated", when(state.updatedAt));
    button.disabled = inFlight;
    if (view === "qr") {
      img.setAttribute("src", ROUTES.qrSrc + encodeURIComponent(state.updatedAt || ""));
    } else {
      img.removeAttribute("src");
    }
    // The QR is what was asked for: a stale failure must not sit under it.
    if (view !== "button") showError("");
  }

  function poll() {
    // A backgrounded tab is nobody's live view; stop polling until it is looked
    // at again. The interval keeps running (a later handoff reuses the tab).
    if (document.hidden) return;
    fetch(ROUTES.state, { cache: "no-store", credentials: "same-origin" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (state) {
        if (!state || typeof state.status !== "string") return;
        apply(state);
      })
      .catch(function () { /* transient: the next tick retries */ });
  }

  // The ONLY way a login ever starts. One press writes login.request; the bot
  // claims it on its next tick and the poll above shows the QR when it lands.
  button.addEventListener("click", function () {
    if (inFlight) return;
    inFlight = true;
    button.disabled = true;
    showError("");
    fetch(ROUTES.request, { method: "POST", credentials: "same-origin" })
      .then(function (res) {
        if (res.ok) return null;
        return res.json().then(function (body) {
          showError(errorTextFor(body && body.error));
        }, function () { showError(PAGE.button.failed); });
      })
      .catch(function () { showError(PAGE.button.failed); })
      .then(function () {
        inFlight = false;
        button.disabled = false;
        poll();
      });
  });

  apply(boot.state);
  setInterval(poll, 5000);
  // Returning to the tab must not mean up to 5 s of stale card — the skipped
  // ticks above are made good the moment the page is looked at again.
  document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });
})();
</script>
</body>
</html>`;
}
