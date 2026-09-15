import { ZOOM_HTML } from "./zoom";

// Admin queue management. Pending requests get full action cards (approve /
// reject / download / drill into snapshot); everything else collapses to
// single-line history rows. Visual language mirrors /status — same pills,
// border-left status colors, typography.

export const APPROVALS_HTML = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>คิวอนุมัติ - KBIZ Payroll</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    font: 16px/1.5 "Sarabun", "Noto Sans Thai", system-ui, sans-serif;
    --hf-brand-50: #FBEAEA;
    --hf-brand-100: #F5C9C9;
    --hf-brand-300: #C76060;
    --hf-brand-500: #8B0000;
    --hf-brand-600: #7A0000;
    --hf-brand-700: #6B1212;
    --hf-brand-800: #4F0E0E;
    --hf-gold-100: #F6EACB;
    --hf-gold-300: #E7C97F;
    --hf-gold-500: #D9A441;
    --hf-gold-600: #B98730;
    --hf-gold-700: #93691F;
    --hf-shell: #FAF9F7;
    --hf-panel: #FFFFFF;
    --hf-panel-tint: #F4F1ED;
    --hf-zebra: #FAFAFB;
    --hf-border: #E8E4DF;
    --hf-border-strong: #CFC9C1;
    --hf-text: #26221E;
    --hf-text-muted: #7A7268;
    --hf-success: #2F855A;
    --hf-warning: #B7791F;
    --hf-error: #C53030;
    --hf-info: #2C5282;
  }
  body { max-width: 880px; margin: 24px auto; padding: 0 20px; color: var(--hf-text); }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
  h1 { font-size: 22px; margin: 0; flex: 1; font-weight: 600; }
  nav a { color: var(--hf-brand-500); text-decoration: none; margin-left: 14px; font-size: 15px; }
  nav a.active { font-weight: 600; }
  h2 { font-size: 14px; font-weight: 500; color: var(--hf-text-muted); margin: 32px 0 10px; letter-spacing: 0.02em; }

  .updated { font-size: 12px; color: var(--hf-text-muted); margin-bottom: 12px; transition: color 0.4s; }
  .updated.pulse { color: var(--hf-success); }

  /* Pending card — hero-style, since admin needs to act on it. */
  .pcard {
    border: 1px solid var(--hf-border-strong); border-radius: 10px; padding: 22px 26px;
    background: var(--hf-panel); border-left: 4px solid var(--hf-warning);
    margin-bottom: 14px;
  }
  .pcard.s-approved { border-left-color: var(--hf-brand-500); }
  .pcard.s-running { border-left-color: var(--hf-info); }
  .pcard-row1 { display: flex; align-items: baseline; gap: 12px; }
  .pcard-row1 .ago { color: var(--hf-text-muted); font-size: 14px; }
  .pcard-headline { font-size: 18px; font-weight: 600; margin-top: 8px; }
  .pcard-figures { margin-top: 4px; color: var(--hf-text-muted); font-size: 14px; font-variant-numeric: tabular-nums; }
  .pcard-figures .amount { color: var(--hf-text); font-weight: 600; font-size: 18px; }
  .pcard-state {
    margin-top: 14px; padding: 8px 12px; border-radius: 6px;
    font-size: 13px; color: var(--hf-text-muted); background: var(--hf-zebra);
  }
  .pcard-actions {
    margin-top: 16px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
  }
  .pcard-actions a { color: var(--hf-brand-500); text-decoration: none; font-size: 13px; }
  .pcard-actions a:hover { text-decoration: underline; }
  .pcard-actions a.spacer { color: var(--hf-border-strong); }
  .pcard-actions button {
    font: inherit; padding: 7px 14px; border-radius: 6px; border: 1px solid var(--hf-border-strong);
    background: var(--hf-panel); cursor: pointer;
  }
  .pcard-actions button.primary { background: var(--hf-brand-500); color: var(--hf-panel); border-color: var(--hf-brand-500); }
  .pcard-actions button.primary:hover { background: var(--hf-brand-600); }
  .pcard-actions button.danger { color: var(--hf-error); border-color: color-mix(in srgb, var(--hf-error) 45%, white); }
  .pcard-actions button.danger:hover { background: color-mix(in srgb, var(--hf-error) 6%, white); }
  .pcard-recipients { margin-top: 16px; }
  .pcard-recipients summary {
    cursor: pointer; user-select: none; color: var(--hf-brand-500); font-size: 13px;
  }
  .pcard-recipients[open] summary { margin-bottom: 10px; }
  .pcard-recipients table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .pcard-recipients th, .pcard-recipients td {
    padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--hf-border);
  }
  .pcard-recipients th { background: var(--hf-zebra); font-weight: 500; color: var(--hf-text-muted); }
  .pcard-recipients td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pcard-recipients td.acct { font-variant-numeric: tabular-nums; color: var(--hf-text); }
  .pcard-recipients tfoot td {
    font-weight: 600; border-top: 2px solid var(--hf-border-strong); border-bottom: none;
    color: var(--hf-brand-500);
  }
  .pcard-audit { margin-top: 12px; font-size: 12px; color: var(--hf-text-muted); }
  .pcard-audit code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; color: var(--hf-text-muted); }

  /* Pills */
  .pill { display: inline-block; padding: 4px 12px; border-radius: 10px; font-size: 13px; font-weight: 600; }
  .pill.p-pending { background: color-mix(in srgb, var(--hf-warning) 18%, white); color: var(--hf-warning); }
  .pill.p-approved { background: var(--hf-brand-50); color: var(--hf-brand-500); }
  .pill.p-running { background: color-mix(in srgb, var(--hf-info) 15%, white); color: var(--hf-info); }
  .pill.p-done { background: color-mix(in srgb, var(--hf-success) 15%, white); color: var(--hf-success); }
  .pill.p-failed { background: color-mix(in srgb, var(--hf-error) 15%, white); color: var(--hf-error); }
  .pill.p-rejected { background: color-mix(in srgb, var(--hf-error) 15%, white); color: var(--hf-error); }

  /* History rows — single line, muted. Mirrors /status. */
  .row {
    display: grid;
    grid-template-columns: 90px 70px 1fr auto auto auto;
    gap: 14px; align-items: center;
    padding: 10px 14px; font-size: 14px;
    border: 1px solid var(--hf-border); border-radius: 6px; background: var(--hf-panel);
    margin-bottom: 6px;
  }
  .row.s-failed, .row.s-rejected { border-left: 3px solid color-mix(in srgb, var(--hf-error) 45%, white); }
  .row .pill { padding: 2px 8px; font-size: 11px; font-weight: 600; }
  .row .when { color: var(--hf-text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .row .label { color: var(--hf-text); }
  .row .figures { color: var(--hf-text-muted); font-variant-numeric: tabular-nums; font-size: 13px; }
  .row .ref { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; color: var(--hf-text-muted); }
  .row .links { display: flex; gap: 10px; }
  .row .links a { color: var(--hf-brand-500); text-decoration: none; font-size: 12px; }
  .row .links a:hover { text-decoration: underline; }

  .empty { color: var(--hf-text-muted); padding: 28px; text-align: center; border: 1px dashed var(--hf-border-strong); border-radius: 8px; }

  .filters {
    display: flex; gap: 10px; align-items: center; margin: 8px 0 16px;
    font-size: 13px; color: var(--hf-text-muted);
  }
  .filters select {
    font: inherit; padding: 4px 8px; border: 1px solid var(--hf-border-strong);
    border-radius: 4px; background: var(--hf-panel); color: var(--hf-text);
  }

  /* OTP dialog */
  dialog {
    border: 0; border-radius: 8px; padding: 22px;
    box-shadow: 0 8px 24px rgb(38 34 30 / 0.15); min-width: 340px;
  }
  dialog::backdrop { background: rgba(38,34,30,0.4); }
  dialog h3 { margin: 0 0 8px; font-size: 18px; }
  dialog p { margin: 0 0 14px; color: var(--hf-text-muted); font-size: 14px; }
  dialog input {
    font: 24px/1.2 monospace; padding: 10px 14px; width: 100%; box-sizing: border-box;
    letter-spacing: 4px; text-align: center; border: 1px solid var(--hf-border-strong); border-radius: 6px;
  }
  dialog .actions { margin-top: 14px; display: flex; gap: 8px; justify-content: flex-end; }
  dialog .actions button {
    font: inherit; padding: 8px 14px; border: 1px solid var(--hf-border-strong); background: var(--hf-panel);
    border-radius: 4px; cursor: pointer;
  }
  dialog .actions button.primary { background: var(--hf-brand-500); color: var(--hf-panel); border-color: var(--hf-brand-500); }
  dialog .err { color: var(--hf-error); margin-top: 8px; font-size: 13px; min-height: 18px; }
</style>
</head>
<body>
<header>
  <h1>คิวอนุมัติคำขอ</h1>
  <nav>
    <a href="/worksheet">คำนวณเงินเดือน</a>
    <a href="/accounts">จัดการบัญชี</a>
    <a href="/status">สถานะคำขอ</a>
    <!--ADMIN_NAV-->
  </nav>
  ${ZOOM_HTML}
</header>
<!--ADMIN_MODAL-->

<div class="updated" id="updated">&nbsp;</div>

<div id="filtersHost"></div>

<div id="pendingHost"></div>

<div id="historyHost"></div>

<dialog id="otpDialog">
  <h3>กรอก OTP</h3>
  <p>ระบบส่ง OTP ไปที่ Slack แล้ว ดู OTP แล้วกรอกที่นี่ (อายุ 5 นาที)</p>
  <input id="otpInput" type="text" inputmode="numeric" pattern="\\d{6}" maxlength="6" autocomplete="off">
  <div class="err" id="otpErr"></div>
  <div class="actions">
    <button type="button" id="otpCancel">ยกเลิก</button>
    <button type="button" id="otpSubmit" class="primary">ยืนยันอนุมัติ</button>
  </div>
</dialog>

<script>
const pendingHost = document.getElementById("pendingHost");
const historyHost = document.getElementById("historyHost");
const filtersHost = document.getElementById("filtersHost");
const updatedEl = document.getElementById("updated");
const otpDialog = document.getElementById("otpDialog");
const otpInput = document.getElementById("otpInput");
const otpErr = document.getElementById("otpErr");
const otpSubmit = document.getElementById("otpSubmit");
const otpCancel = document.getElementById("otpCancel");

let cache = [];
let currentPeriod = new URLSearchParams(window.location.search).get("period") || "all";
let lastFetchedAt = 0;
let otpTargetId = null;

const STATUS_LABELS = {
  pending: "รออนุมัติ", approved: "อนุมัติแล้ว",
  rejected: "ปฏิเสธ", running: "กำลังประมวลผล",
  done: "สำเร็จ", failed: "ไม่สำเร็จ",
};
function statusLabel(req) {
  if (req.type === "transfer-payroll") {
    if (req.payrollPaidDate) return "จ่ายแล้ว · ธนาคารยืนยัน";
    if (req.payrollVerificationStatus === "FAILED") return "โอนไม่สำเร็จ";
    if (req.payrollVerificationStatus === "UNKNOWN") return "รอตรวจสอบผลโอน";
    if (req.status === "done") return "ส่งธนาคารแล้ว · รอผลโอน";
  }
  return STATUS_LABELS[req.status] || req.status;
}
function statusTone(req) {
  if (req.type === "transfer-payroll") {
    if (req.payrollPaidDate) return "done";
    if (req.payrollVerificationStatus === "FAILED") return "failed";
    if (req.status === "done") return "approved";
  }
  return req.status;
}
const STATE_HINTS = {
  pending: "รอ admin อนุมัติ — กดปุ่มอนุมัติเพื่อขอ OTP",
  approved: "อนุมัติแล้ว · รอ kbiz-bot รับงาน",
  running: "kbiz-bot กำลังดำเนินการในระบบ KBIZ…",
};
const TH_MONTHS = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
                   "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function fmtAmount(n) {
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatAccount(n) {
  const s = String(n).replace(/[^0-9]/g, "");
  if (s.length === 10) return s.slice(0,3)+"-"+s.slice(3,4)+"-"+s.slice(4,9)+"-"+s.slice(9);
  return s;
}
function periodLabel(p) {
  if (!p || !/^\\d{4}-\\d{2}$/.test(p)) return p || "—";
  const [y, m] = p.split("-").map(Number);
  return \`\${TH_MONTHS[m-1]} \${y + 543}\`;
}
function periodFromEffective(eff) {
  if (!eff) return null;
  const m = /^(\\d{2})\\/(\\d{2})\\/(\\d{4})$/.exec(eff);
  return m ? \`\${m[3]}-\${m[2]}\` : null;
}
function reqPeriod(req) {
  if (req.summary && req.summary.period) return req.summary.period;
  if (req.summary && req.summary.effectiveDate) return periodFromEffective(req.summary.effectiveDate);
  return null;
}
function relativeTime(iso) {
  if (!iso) return "";
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return "เมื่อสักครู่";
  if (sec < 3600) return \`เมื่อ \${Math.floor(sec/60)} นาทีที่แล้ว\`;
  if (sec < 86400) return \`เมื่อ \${Math.floor(sec/3600)} ชั่วโมงที่แล้ว\`;
  if (sec < 86400 * 7) return \`เมื่อ \${Math.floor(sec/86400)} วันที่แล้ว\`;
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return \`\${pad(d.getDate())}/\${pad(d.getMonth()+1)}/\${d.getFullYear()+543}\`;
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return \`\${pad(d.getDate())}/\${pad(d.getMonth()+1)}/\${d.getFullYear()+543} \${pad(d.getHours())}:\${pad(d.getMinutes())}\`;
}
function shortWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return \`\${pad(d.getDate())}/\${pad(d.getMonth()+1)} \${pad(d.getHours())}:\${pad(d.getMinutes())}\`;
}
function effectiveTime(req) {
  return req.completedAt || req.startedAt || req.approvedAt || req.rejectedAt || req.createdAt;
}
function headlineFor(req) {
  if (req.type === "transfer-payroll") {
    return \`โอนเงินเดือน \${periodLabel(reqPeriod(req)) || "—"}\`;
  }
  if (req.type === "add-payroll") {
    return "เพิ่มผู้รับเงินใหม่ (KBIZ)";
  }
  if (req.type === "list-registered") {
    return "ซิงค์สถานะบัญชี KBIZ";
  }
  return req.type;
}
function figuresFor(req) {
  const bits = [];
  if (req.type === "transfer-payroll") {
    bits.push(\`\${req.summary.rows.length} คน\`);
    bits.push(\`<span class="amount">฿\${fmtAmount(req.summary.totalAmount)}</span>\`);
    if (req.summary.effectiveDate) bits.push(\`กำหนดโอน \${escapeHtml(req.summary.effectiveDate)}\`);
  } else if (req.type === "add-payroll") {
    bits.push(\`\${req.summary.accounts.length} บัญชี\`);
  }
  return bits.join(" · ");
}

function renderRecipients(req) {
  if (req.type === "transfer-payroll") {
    const rows = req.summary.rows.map((r, i) => \`
      <tr><td>\${i+1}</td><td>\${escapeHtml(r.accountName)}</td>
      <td class="acct">\${escapeHtml(formatAccount(r.accountNumber))}</td>
      <td class="num">\${fmtAmount(r.amount)}</td></tr>\`).join("");
    return \`<table>
      <thead><tr><th style="width:42px">#</th><th>ชื่อบัญชี</th><th>เลขบัญชี</th><th class="num">จำนวนเงิน</th></tr></thead>
      <tbody>\${rows}</tbody>
      <tfoot><tr><td colspan="3" style="text-align:right">รวม</td><td class="num">\${fmtAmount(req.summary.totalAmount)}</td></tr></tfoot>
    </table>\`;
  }
  if (req.type === "add-payroll") {
    const rows = req.summary.accounts.map((a, i) => \`
      <tr><td>\${i+1}</td><td>\${escapeHtml(a.accountName)}</td>
      <td class="acct">\${escapeHtml(formatAccount(a.accountNumber))}</td></tr>\`).join("");
    return \`<table>
      <thead><tr><th style="width:42px">#</th><th>ชื่อบัญชี</th><th>เลขบัญชี</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>\`;
  }
  return "";
}

function renderPendingCard(req) {
  const status = req.status;
  const stateHtml = STATE_HINTS[status] ? \`<div class="pcard-state">\${STATE_HINTS[status]}</div>\` : "";
  const actionsHtml = status === "pending"
    ? \`<button class="primary" data-action="approve" data-id="\${req.id}">อนุมัติ</button>
       <button class="danger" data-action="reject" data-id="\${req.id}">ปฏิเสธ</button>\`
    : "";
  const snapshotHtml = req.type === "transfer-payroll"
    ? \`<a href="/worksheet?snapshot=\${encodeURIComponent(req.id)}">ดูรายละเอียดเงินเดือน</a>\`
    : "";
  const recipientCount = req.type === "transfer-payroll" ? req.summary.rows.length : (req.type === "add-payroll" ? req.summary.accounts.length : 0);

  return \`<div class="pcard s-\${status}">
    <div class="pcard-row1">
      <span class="pill p-\${status}">\${escapeHtml(statusLabel(req))}</span>
      <span class="ago">\${relativeTime(effectiveTime(req))}</span>
    </div>
    <div class="pcard-headline">\${escapeHtml(headlineFor(req))}</div>
    <div class="pcard-figures">\${figuresFor(req)}</div>
    \${stateHtml}
    <div class="pcard-actions">
      \${actionsHtml}
      \${snapshotHtml}
      \${snapshotHtml ? '<span class="spacer">·</span>' : ''}
      <a href="/api/queue/\${req.id}/xlsx">ดาวน์โหลด xlsx</a>
    </div>
    <details class="pcard-recipients">
      <summary>ดูรายการผู้รับเงิน (\${recipientCount} ราย)</summary>
      \${renderRecipients(req)}
    </details>
    <div class="pcard-audit">สร้าง \${fmtDate(req.createdAt)} · <code>\${escapeHtml(req.id)}</code></div>
  </div>\`;
}

function renderHistoryRow(req) {
  const ref = req.result && req.result.referenceNo ? escapeHtml(req.result.referenceNo) : "";
  const figures = req.type === "transfer-payroll"
    ? \`\${req.summary.rows.length} คน · ฿\${fmtAmount(req.summary.totalAmount)}\`
    : (req.type === "add-payroll" ? \`\${req.summary.accounts.length} บัญชี\` : "");
  const snapLink = req.type === "transfer-payroll"
    ? \`<a href="/worksheet?snapshot=\${encodeURIComponent(req.id)}">รายละเอียด</a>\`
    : "";
  return \`<div class="row s-\${statusTone(req)}" title="\${escapeHtml(req.id)}">
    <span class="pill p-\${statusTone(req)}">\${escapeHtml(statusLabel(req))}</span>
    <span class="when">\${shortWhen(effectiveTime(req))}</span>
    <span class="label">\${escapeHtml(headlineFor(req))}</span>
    <span class="figures">\${figures}</span>
    <span class="ref">\${ref}</span>
    <span class="links">\${snapLink}<a href="/api/queue/\${req.id}/xlsx">xlsx</a></span>
  </div>\`;
}

function renderFilters(periods) {
  if (periods.length <= 1) { filtersHost.innerHTML = ""; return; }
  const opts = ['<option value="all">ทุกเดือน</option>']
    .concat(periods.map((p) => \`<option value="\${escapeHtml(p)}"\${p === currentPeriod ? " selected" : ""}>\${escapeHtml(periodLabel(p))}</option>\`));
  filtersHost.innerHTML = \`<div class="filters">
    <span>กรองตามเดือน:</span>
    <select id="periodFilter">\${opts.join("")}</select>
  </div>\`;
  document.getElementById("periodFilter").addEventListener("change", (e) => {
    currentPeriod = e.target.value;
    paint();
  });
}

function paint() {
  let items = cache;
  if (currentPeriod !== "all") items = items.filter((r) => reqPeriod(r) === currentPeriod);
  const pending = items.filter((r) => r.status === "pending");
  const rest = items.filter((r) => r.status !== "pending");

  if (pending.length === 0) {
    pendingHost.innerHTML = "";
  } else {
    pendingHost.innerHTML = pending.map(renderPendingCard).join("");
    pendingHost.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => handleAction(btn.dataset.action, btn.dataset.id));
    });
  }

  if (rest.length === 0) {
    historyHost.innerHTML = pending.length === 0
      ? '<div class="empty">ยังไม่มีคำขอ</div>'
      : "";
  } else {
    const heading = pending.length > 0 ? "ก่อนหน้านี้" : "คำขอทั้งหมด";
    historyHost.innerHTML = \`<h2>\${heading} (\${rest.length})</h2>\` + rest.map(renderHistoryRow).join("");
  }
}

function repaintRelativeTimes() {
  const cards = document.querySelectorAll(".pcard");
  if (cards.length === 0) return;
  const items = currentPeriod === "all" ? cache : cache.filter((r) => reqPeriod(r) === currentPeriod);
  const pending = items.filter((r) => r.status === "pending");
  cards.forEach((card, i) => {
    if (!pending[i]) return;
    const ago = card.querySelector(".pcard-row1 .ago");
    if (ago) ago.textContent = relativeTime(effectiveTime(pending[i]));
  });
}
function flashUpdated() {
  lastFetchedAt = Date.now();
  updatedEl.textContent = "อัปเดตเมื่อสักครู่";
  updatedEl.classList.add("pulse");
  setTimeout(() => updatedEl.classList.remove("pulse"), 600);
}
function tickUpdatedLabel() {
  if (lastFetchedAt === 0) return;
  const sec = Math.floor((Date.now() - lastFetchedAt) / 1000);
  if (sec < 5) updatedEl.textContent = "อัปเดตเมื่อสักครู่";
  else if (sec < 60) updatedEl.textContent = \`อัปเดตเมื่อ \${sec} วินาทีที่แล้ว\`;
  else updatedEl.textContent = \`อัปเดตเมื่อ \${Math.floor(sec/60)} นาทีที่แล้ว\`;
}

async function refresh() {
  const res = await fetch("/api/queue");
  if (!res.ok) {
    pendingHost.innerHTML = '<div class="empty err">โหลดข้อมูลไม่สำเร็จ</div>';
    historyHost.innerHTML = "";
    return;
  }
  cache = await res.json();
  const seen = new Set();
  for (const r of cache) { const p = reqPeriod(r); if (p) seen.add(p); }
  renderFilters(Array.from(seen).sort().reverse());
  paint();
  flashUpdated();
}

// OTP approve modal
otpCancel.addEventListener("click", () => otpDialog.close());
otpDialog.addEventListener("close", () => { otpTargetId = null; otpInput.value = ""; otpErr.textContent = ""; });
otpInput.addEventListener("input", () => { otpErr.textContent = ""; });
otpSubmit.addEventListener("click", () => submitOtp());
otpInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitOtp(); });

async function submitOtp() {
  if (!otpTargetId) return;
  const otp = otpInput.value.trim();
  if (!/^\\d{6}$/.test(otp)) { otpErr.textContent = "OTP ต้องเป็นตัวเลข 6 หลัก"; return; }
  otpSubmit.disabled = true;
  try {
    const res = await fetch(\`/api/queue/\${otpTargetId}/approve\`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ otp }),
    });
    if (!res.ok) { otpErr.textContent = await res.text(); return; }
    otpDialog.close();
    await refresh();
  } finally {
    otpSubmit.disabled = false;
  }
}

async function handleAction(action, id) {
  if (action === "approve") {
    const res = await fetch(\`/api/queue/\${id}/request-otp\`, { method: "POST" });
    if (!res.ok) { alert("ส่ง OTP ไปยัง Slack ไม่สำเร็จ: " + (await res.text())); return; }
    otpTargetId = id;
    otpErr.textContent = "";
    otpInput.value = "";
    otpDialog.showModal();
    setTimeout(() => otpInput.focus(), 50);
    return;
  }
  if (action === "reject") {
    const reason = prompt("เหตุผลที่ปฏิเสธ (ไม่ระบุก็ได้):");
    if (reason === null) return;
    const res = await fetch(\`/api/queue/\${id}/reject\`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: reason || undefined }),
    });
    if (!res.ok) { alert("ไม่สำเร็จ: " + (await res.text())); return; }
    await refresh();
  }
}

refresh();
setInterval(refresh, 5000);
setInterval(() => { tickUpdatedLabel(); repaintRelativeTimes(); }, 1000);
</script>
<!--HF_BAR-->
</body>
</html>`;
