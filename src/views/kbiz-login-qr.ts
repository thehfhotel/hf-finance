import type { KbizQrState, KbizQrStatus } from "../kbiz-login-qr";

// K BIZ QR login handoff — the operator-facing page (CR-2026-09-17).
//
// Standalone on purpose: no app nav, no admin modal, no HF One bar. It is a
// single-job page an operator opens from a Slack link on a laptop, scans with
// the K BIZ phone app, and closes. The bot publishes `current.png` +
// `state.json`; this page only reads them (`src/kbiz-login-qr.ts`).
//
// The page is server-rendered for the state at request time AND polls
// `/kbiz/login-qr/state.json` every 5 s, updating the same nodes in place —
// that is why the copy below is emitted once as JSON and reused by both sides
// instead of being written twice.
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
  expired: {
    badge: "หมดเวลา",
    th: "QR หมดอายุแล้ว ระบบจะขอ QR ใหม่ให้อีกครั้ง",
    en: "The QR expired. A new one will be requested.",
  },
  error: {
    badge: "ผิดพลาด",
    th: "อ่านสถานะการเข้าสู่ระบบไม่ได้",
    en: "Could not read the login state.",
  },
};

const ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
// Replacer FUNCTION, so nothing in the value is read as a `$` substitution.
const esc = (value: string) => value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);

// `<` is the only character that can end the enclosing <script> element early;
// everything else is already legal JSON text. Replacer function again.
const jsonForScript = (value: unknown) => JSON.stringify(value).replace(/</g, () => "\\u003c");

/** The URL the <img> points at while a QR is live — cache-busted by updatedAt. */
export function kbizQrImageSrc(updatedAt: string | null | undefined): string {
  return `/kbiz/login-qr.png?t=${encodeURIComponent(updatedAt ?? "")}`;
}

export function renderKbizLoginQrPage(state: KbizQrState): string {
  const copy = COPY[state.status] ?? COPY.error;
  const waiting = state.status === "waiting";
  const imgAttr = waiting ? ` src="${esc(kbizQrImageSrc(state.updatedAt))}"` : "";
  const boot = jsonForScript({ copy: COPY, state });
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>สแกน QR เข้าสู่ระบบ K BIZ</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;500;600;700&display=swap" rel="stylesheet">
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

  .headline { margin: 0; font-size: 18px; font-weight: 600; }
  .headline-en { margin: 4px 0 0; font-size: 13px; color: var(--hf-text-muted); }
  .message { margin: 10px 0 0; font-size: 14px; color: var(--hf-text-muted); min-height: 1px; }

  /* The bank's QR is a 150px PNG. Blow it up with nearest-neighbour so the
     modules stay crisp squares instead of a blurred bilinear smear. */
  figure.qr { margin: 18px 0 0; display: none; }
  #card[data-status="waiting"] figure.qr { display: block; }
  figure.qr img {
    width: min(400px, 100%); max-width: 400px; aspect-ratio: 1 / 1;
    image-rendering: pixelated; background: #FFFFFF;
    border: 1px solid var(--hf-border); border-radius: 8px; padding: 10px;
  }
  figcaption { margin-top: 8px; font-size: 13px; color: var(--hf-text-muted); }

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
    <p class="lede">ธนาคารขอให้สแกน QR ด้วยแอป K BIZ ทุกครั้งที่เข้าสู่ระบบ ระบบโอนเงินจะทำงานต่อได้หลังสแกนสำเร็จ</p>
    <p class="lede-en">K BIZ requires a scan from the K BIZ phone app on every login.</p>
  </header>

  <section id="card" data-status="${esc(state.status)}">
    <p class="badge" id="badge">${esc(copy.badge)}</p>
    <p class="headline" id="headline">${esc(copy.th)}</p>
    <p class="headline-en" id="headline-en">${esc(copy.en)}</p>

    <figure class="qr">
      <img id="qr" alt="QR สำหรับเข้าสู่ระบบ K BIZ" width="400" height="400"${imgAttr}>
      <figcaption>เปิดแอป K BIZ บนมือถือ แล้วสแกน QR นี้</figcaption>
    </figure>

    <p class="message" id="message">${esc(state.message ?? "")}</p>

    <dl class="meta">
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
  var card = document.getElementById("card");
  var img = document.getElementById("qr");
  var last = boot.state;

  function set(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function when(iso) {
    if (!iso) return "—";
    var at = new Date(iso);
    return isNaN(at.getTime()) ? iso : at.toLocaleString("th-TH", { hour12: false });
  }

  function apply(state) {
    var copy = COPY[state.status] || COPY.error;
    card.setAttribute("data-status", state.status);
    set("badge", copy.badge);
    set("headline", copy.th);
    set("headline-en", copy.en);
    set("message", state.message || "");
    set("reason", state.reason || "—");
    set("attempt", state.attempt ? String(state.attempt) : "—");
    set("expires", when(state.expiresAt));
    set("updated", when(state.updatedAt));
    if (state.status === "waiting") {
      img.setAttribute("src", "/kbiz/login-qr.png?t=" + encodeURIComponent(state.updatedAt || ""));
    } else {
      img.removeAttribute("src");
    }
  }

  function poll() {
    fetch("/kbiz/login-qr/state.json", { cache: "no-store", credentials: "same-origin" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (state) {
        if (!state || typeof state.status !== "string") return;
        if (state.status === last.status && state.updatedAt === last.updatedAt) return;
        last = state;
        apply(state);
      })
      .catch(function () { /* transient: the next tick retries */ });
  }

  apply(last);
  setInterval(poll, 5000);
})();
</script>
</body>
</html>`;
}
