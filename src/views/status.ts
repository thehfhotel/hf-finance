import { ZOOM_HTML } from "./zoom";

// Read-only "where's my submission" page. Visible without admin OTP — HR
// users who submit transfer requests can track them through to the KBIZ
// outcome here. No row-level PII, no xlsx download, no approve/reject —
// those live on /approvals (admin-only).
//
// Layout: hero (latest request) + condensed history rows. Filters appear
// only when there's enough volume to need them.

export const STATUS_HTML = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>สถานะคำขอ - KBIZ Payroll</title>
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

  .updated {
    font-size: 12px; color: var(--hf-text-muted); margin-bottom: 12px; transition: color 0.4s;
  }
  .updated.pulse { color: var(--hf-success); }

  /* Hero card — latest request gets the focal weight. */
  .hero {
    border: 1px solid var(--hf-border-strong); border-radius: 10px; padding: 22px 26px;
    background: var(--hf-panel); border-left-width: 4px;
  }
  .hero.s-pending  { border-left-color: var(--hf-warning); }
  .hero.s-approved { border-left-color: var(--hf-brand-500); }
  .hero.s-running  { border-left-color: var(--hf-info); }
  .hero.s-done     { border-left-color: var(--hf-success); }
  .hero.s-failed   { border-left-color: var(--hf-error); }
  .hero.s-rejected { border-left-color: var(--hf-error); }
  .hero-row1 { display: flex; align-items: baseline; gap: 12px; }
  .hero-row1 .ago { color: var(--hf-text-muted); font-size: 14px; }
  .hero-headline { font-size: 18px; font-weight: 600; margin-top: 8px; }
  .hero-figures {
    margin-top: 4px; color: var(--hf-text-muted); font-size: 14px; font-variant-numeric: tabular-nums;
  }
  .hero-figures .amount {
    color: var(--hf-text); font-weight: 600; font-size: 18px;
  }
  .hero-state {
    margin-top: 16px; padding: 10px 14px; border-radius: 6px;
    font-size: 14px; color: var(--hf-text); background: var(--hf-zebra);
    border-left: 3px solid transparent;
  }
  .hero-state.success { background: transparent; border-left-color: var(--hf-success); padding-left: 12px; padding-right: 0; }
  .hero-state.failure { background: color-mix(in srgb, var(--hf-error) 6%, white); border-left-color: var(--hf-error); color: var(--hf-error); }
  .hero-state .ref { font-family: ui-monospace, SFMono-Regular, monospace; color: var(--hf-text); }
  .hero-state .label { color: var(--hf-text-muted); margin-right: 6px; }
  .hero-actions {
    margin-top: 16px; display: flex; gap: 14px; align-items: center;
  }
  .hero-actions a { color: var(--hf-brand-500); text-decoration: none; font-size: 13px; }
  .hero-actions a:hover { text-decoration: underline; }
  .hero-actions .spacer { color: var(--hf-border-strong); }

  .hero-details {
    margin-top: 12px; font-size: 13px; color: var(--hf-text-muted);
  }
  .hero-details summary { cursor: pointer; user-select: none; color: var(--hf-brand-500); font-size: 13px; }
  .hero-details[open] summary { margin-bottom: 8px; }
  .hero-details .kv {
    display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin-top: 8px;
  }
  .hero-details .kv dt { color: var(--hf-text-muted); }
  .hero-details .kv dd { margin: 0; font-variant-numeric: tabular-nums; color: var(--hf-text); }
  .hero-details .kv dd code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; }

  /* History rows — single line, muted, scannable. */
  .row {
    display: grid;
    grid-template-columns: 90px 70px 1fr auto auto auto;
    gap: 14px; align-items: center;
    padding: 10px 14px; font-size: 14px;
    border: 1px solid var(--hf-border); border-radius: 6px; background: var(--hf-panel);
    margin-bottom: 6px;
  }
  .row.s-failed, .row.s-rejected { border-left: 3px solid color-mix(in srgb, var(--hf-error) 45%, white); }
  .row .pill {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 11px; font-weight: 600; text-align: center;
  }
  .row .when { color: var(--hf-text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .row .label { color: var(--hf-text); }
  .row .figures { color: var(--hf-text-muted); font-variant-numeric: tabular-nums; font-size: 13px; }
  .row .ref { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; color: var(--hf-text-muted); }
  .row .links { display: flex; gap: 10px; }
  .row .links a { color: var(--hf-brand-500); text-decoration: none; font-size: 12px; }
  .row .links a:hover { text-decoration: underline; }

  /* Pills (shared with hero + rows). Color tokens match /approvals. */
  .pill.p-pending  { background: color-mix(in srgb, var(--hf-warning) 18%, white); color: var(--hf-warning); }
  .pill.p-approved { background: var(--hf-brand-50); color: var(--hf-brand-500); }
  .pill.p-running  { background: color-mix(in srgb, var(--hf-info) 15%, white); color: var(--hf-info); }
  .pill.p-done     { background: color-mix(in srgb, var(--hf-success) 15%, white); color: var(--hf-success); }
  .pill.p-failed   { background: color-mix(in srgb, var(--hf-error) 15%, white); color: var(--hf-error); }
  .pill.p-rejected { background: color-mix(in srgb, var(--hf-error) 15%, white); color: var(--hf-error); }
  .hero-row1 .pill { padding: 4px 12px; font-size: 13px; }

  .empty { color: var(--hf-text-muted); padding: 28px; text-align: center; border: 1px dashed var(--hf-border-strong); border-radius: 8px; }

  /* Filter row — only mounted when cache exceeds threshold. */
  .filters {
    display: flex; gap: 10px; align-items: center; margin: 8px 0 16px;
    font-size: 13px; color: var(--hf-text-muted);
  }
  .filters select {
    font: inherit; padding: 4px 8px; border: 1px solid var(--hf-border-strong);
    border-radius: 4px; background: var(--hf-panel); color: var(--hf-text);
  }
</style>
</head>
<body>
<header>
  <h1>สถานะคำขอ</h1>
  <nav>
    <a href="/worksheet">คำนวณเงินเดือน</a>
    <a href="/accounts">จัดการบัญชี</a>
    <a href="/status" class="active">สถานะคำขอ</a>
    <!--ADMIN_NAV-->
  </nav>
  ${ZOOM_HTML}
</header>
<!--ADMIN_MODAL-->

<div class="updated" id="updated">&nbsp;</div>

<div id="filtersHost"></div>

<div id="hero"></div>

<div id="historyHost"></div>

<script>
const heroEl = document.getElementById("hero");
const historyHost = document.getElementById("historyHost");
const filtersHost = document.getElementById("filtersHost");
const updatedEl = document.getElementById("updated");
let lastFetchedAt = 0;
let cache = [];
let currentPeriod = new URLSearchParams(window.location.search).get("period") || "all";

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
  pending: "รอผู้อนุมัติยืนยัน OTP",
  approved: "อนุมัติแล้ว · รอ kbiz-bot รับงาน",
  running: "กำลังดำเนินการในระบบ KBIZ…",
};
const TH_MONTHS = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
                   "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
const TH_MONTHS_SHORT = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.",
                         "ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function fmtAmount(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function periodLong(p) {
  if (!p || !/^\\d{4}-\\d{2}$/.test(p)) return p || "";
  const [y, m] = p.split("-").map(Number);
  return \`\${TH_MONTHS[m-1]} \${y + 543}\`;
}
function periodShort(p) {
  if (!p || !/^\\d{4}-\\d{2}$/.test(p)) return p || "";
  const [y, m] = p.split("-").map(Number);
  return \`\${TH_MONTHS_SHORT[m-1]} \${y + 543}\`;
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
// "Effective time" for relative display = the most recent state transition.
function effectiveTime(req) {
  return req.completedAt || req.startedAt || req.approvedAt || req.rejectedAt || req.createdAt;
}

function headlineFor(req) {
  if (req.type === "transfer-payroll") {
    return \`โอนเงินเดือน \${periodLong(req.period) || "—"}\`;
  }
  if (req.type === "add-payroll") {
    return "เพิ่มผู้รับเงินใหม่ (KBIZ)";
  }
  if (req.type === "list-registered") {
    return "ซิงค์สถานะบัญชี KBIZ";
  }
  return req.type;
}

function renderHero(req) {
  const status = req.status;
  const pillClass = "p-" + statusTone(req);
  const cardClass = "hero s-" + statusTone(req);

  // Figure line: "23 คน · ฿487,520.50 · เงินเข้า 09/05/2569"
  const bits = [];
  if (req.recipientCount) bits.push(\`\${req.recipientCount} \${req.type === "transfer-payroll" ? "คน" : "บัญชี"}\`);
  if (req.totalAmount != null) bits.push(\`<span class="amount">฿\${fmtAmount(req.totalAmount)}</span>\`);
  if (req.effectiveDate) bits.push(\`กำหนดโอน \${escapeHtml(req.effectiveDate)}\`);

  // State line — depends on lifecycle stage.
  let stateHtml = "";
  if (req.type === "transfer-payroll" && req.payrollPaidDate) {
    stateHtml = \`<div class="hero-state success">ธนาคารยืนยันโอนสำเร็จครบทุกคน · วันที่จ่าย \${escapeHtml(req.payrollPaidDate)} · ระบบส่งสถานะไปบัญชีรายจ่ายอัตโนมัติ</div>\`;
  } else if (req.type === "transfer-payroll" && (req.status === "failed" || req.payrollVerificationStatus === "UNKNOWN")) {
    stateHtml = \`<div class="hero-state">ยังยืนยันผลโอนไม่ได้ ระบบกำลังตรวจสอบกับธนาคาร กรุณารอผลก่อนส่งเงินเดือนรอบนี้ซ้ำ</div>\`;
  } else if (req.type === "transfer-payroll" && req.status === "done") {
    const failed = req.payrollVerificationStatus === "FAILED";
    stateHtml = \`<div class="hero-state\${failed ? ' failure' : ''}">\${failed ? 'ธนาคารแจ้งว่าโอนไม่สำเร็จ กรุณาตรวจสอบรายละเอียดกับธนาคาร' : 'ส่งคำสั่งให้ธนาคารแล้ว ระบบกำลังตรวจสอบผลโอน ยังไม่ถือว่าจ่ายเงินเดือนสำเร็จ'}</div>\`;
  } else if (req.result) {
    if (req.result.success) {
      const ref = req.result.referenceNo
        ? \`<span class="label">KBIZ Reference</span><span class="ref">\${escapeHtml(req.result.referenceNo)}</span>\`
        : "ไม่พบ reference";
      stateHtml = \`<div class="hero-state success">\${ref}</div>\`;
    } else {
      stateHtml = \`<div class="hero-state failure">KBIZ ไม่สำเร็จ — \${escapeHtml(req.result.error || "ไม่ทราบสาเหตุ")}</div>\`;
    }
  } else if (status === "rejected") {
    stateHtml = \`<div class="hero-state failure">ปฏิเสธ\${req.rejectionReason ? " — " + escapeHtml(req.rejectionReason) : ""}</div>\`;
  } else if (STATE_HINTS[status]) {
    stateHtml = \`<div class="hero-state">\${STATE_HINTS[status]}</div>\`;
  }

  // Audit disclosure
  const audit = [];
  audit.push(["สร้าง", req.createdAt]);
  if (req.approvedAt) audit.push(["อนุมัติ", req.approvedAt]);
  if (req.rejectedAt) audit.push(["ปฏิเสธ", req.rejectedAt]);
  if (req.startedAt) audit.push(["เริ่มประมวลผล", req.startedAt]);
  if (req.completedAt) audit.push(["เสร็จ", req.completedAt]);
  const auditHtml = audit.map(([k, v]) => \`<dt>\${k}</dt><dd>\${fmtDate(v)}</dd>\`).join("");

  // Detail / print / xlsx links — only meaningful for transfer-payroll
  // items (the worksheet snapshot view is structured around the worksheet
  // schema). The print link reuses the snapshot view with ?print=1 to
  // auto-trigger window.print() on load.
  const actionsHtml = req.type === "transfer-payroll"
    ? \`<div class="hero-actions">
        <a href="/worksheet?snapshot=\${encodeURIComponent(req.id)}">ดูรายละเอียดเงินเดือน</a>
        <span class="spacer">·</span>
        <a href="/worksheet?snapshot=\${encodeURIComponent(req.id)}&print=1" target="_blank" rel="noopener">🖨 พิมพ์รายงาน</a>
        <span class="spacer">·</span>
        <a href="/api/queue/\${encodeURIComponent(req.id)}/xlsx">ดาวน์โหลด xlsx</a>
       </div>\`
    : "";

  return \`<div class="\${cardClass}">
    <div class="hero-row1">
      <span class="pill \${pillClass}">\${escapeHtml(statusLabel(req))}</span>
      <span class="ago">\${relativeTime(effectiveTime(req))}</span>
    </div>
    <div class="hero-headline">\${escapeHtml(headlineFor(req))}</div>
    <div class="hero-figures">\${bits.join(" · ")}</div>
    \${stateHtml}
    \${actionsHtml}
    <details class="hero-details">
      <summary>ดูเวลาทุกขั้นตอน</summary>
      <dl class="kv">\${auditHtml}<dt>ID</dt><dd><code>\${escapeHtml(req.id)}</code></dd></dl>
    </details>
  </div>\`;
}

function renderRow(req) {
  const ref = req.result && req.result.referenceNo ? escapeHtml(req.result.referenceNo) : "";
  const figures = [
    req.recipientCount ? \`\${req.recipientCount} \${req.type === "transfer-payroll" ? "คน" : "บัญชี"}\` : "",
    req.totalAmount != null ? \`฿\${fmtAmount(req.totalAmount)}\` : "",
  ].filter(Boolean).join(" · ");
  const detailLink = req.type === "transfer-payroll"
    ? \`<a href="/worksheet?snapshot=\${encodeURIComponent(req.id)}">รายละเอียด</a>
       <a href="/worksheet?snapshot=\${encodeURIComponent(req.id)}&print=1" target="_blank" rel="noopener" title="พิมพ์รายงาน">🖨</a>\`
    : "";
  return \`<div class="row s-\${statusTone(req)}" title="\${escapeHtml(req.id)}">
    <span class="pill p-\${statusTone(req)}">\${escapeHtml(statusLabel(req))}</span>
    <span class="when">\${shortWhen(effectiveTime(req))}</span>
    <span class="label">\${escapeHtml(headlineFor(req))}</span>
    <span class="figures">\${figures}</span>
    <span class="ref">\${ref}</span>
    <span class="links">\${detailLink}</span>
  </div>\`;
}

function renderFilters(periods) {
  // Only mount the dropdown when there's actually a choice to make.
  if (periods.length <= 1) {
    filtersHost.innerHTML = "";
    return;
  }
  const opts = ['<option value="all">ทุกเดือน</option>']
    .concat(periods.map((p) => \`<option value="\${escapeHtml(p)}"\${p === currentPeriod ? " selected" : ""}>\${escapeHtml(periodLong(p))}</option>\`));
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
  let items = cache.slice();
  if (currentPeriod !== "all") items = items.filter((r) => r.period === currentPeriod);

  if (items.length === 0) {
    heroEl.innerHTML = '<div class="empty">ยังไม่มีคำขอ</div>';
    historyHost.innerHTML = "";
    return;
  }

  // Hero = first item (cache is sorted desc by createdAt server-side).
  heroEl.innerHTML = renderHero(items[0]);

  const rest = items.slice(1);
  if (rest.length === 0) {
    historyHost.innerHTML = "";
  } else {
    historyHost.innerHTML =
      \`<h2>ก่อนหน้านี้ (\${rest.length})</h2>\` +
      rest.map(renderRow).join("");
  }
}

function repaintRelativeTimes() {
  // Re-render the hero "ago" without re-fetching, so the time stays accurate
  // between auto-refresh ticks.
  if (cache.length === 0) return;
  const items = currentPeriod === "all" ? cache : cache.filter((r) => r.period === currentPeriod);
  if (items.length === 0) return;
  const ago = document.querySelector(".hero-row1 .ago");
  if (ago) ago.textContent = relativeTime(effectiveTime(items[0]));
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
  try {
    const res = await fetch("/api/queue/status");
    if (!res.ok) {
      heroEl.innerHTML = '<div class="empty err">โหลดข้อมูลไม่สำเร็จ</div>';
      historyHost.innerHTML = "";
      return;
    }
    cache = await res.json();
    const seen = new Set();
    for (const r of cache) if (r.period) seen.add(r.period);
    const periods = Array.from(seen).sort().reverse();
    renderFilters(periods);
    paint();
    flashUpdated();
  } catch {
    heroEl.innerHTML = '<div class="empty err">โหลดข้อมูลไม่สำเร็จ</div>';
  }
}

refresh();
setInterval(refresh, 5000);
setInterval(() => { tickUpdatedLabel(); repaintRelativeTimes(); }, 1000);
</script>
<!--HF_BAR-->
</body>
</html>`;
