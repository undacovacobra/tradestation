/* Dashboard logic: polls the bot every 2 seconds and renders the state. */
"use strict";

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

let lastStatusJson = "";
let status = null;
let busy = false; // true while a button action is in flight

// ---------------------------------------------------------------------------
// Server helpers
// ---------------------------------------------------------------------------

/**
 * A slow/flaky tunnel connection (e.g. ngrok free tier from off-network) can
 * cause an occasional dropped request. Rather than bounce the user to the
 * login screen on a single hiccup, require two 401s in a row — with a short
 * pause between — before concluding the session really did expire.
 */
async function fetchAuthed(path, init) {
  const attempt = () => fetch(path, init);
  let res = await attempt();
  if (res.status === 401) {
    await new Promise((r) => setTimeout(r, 500));
    res = await attempt();
  }
  return res;
}

async function api(path, body) {
  const res = await fetchAuthed("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    showLogin(false);
    throw new Error("Please log in.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || "Something went wrong.");
  return data;
}

async function refresh() {
  try {
    const res = await fetchAuthed("/api/status");
    if (res.status === 401) return showLogin(false);
    const data = await res.json();
    hideLogin();
    const json = JSON.stringify(data);
    if (json === lastStatusJson) return;
    lastStatusJson = json;
    status = data;
    render();
  } catch {
    setPill("pill-running", "red", "Can't reach bot");
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function setPill(id, color, text, withDot = true) {
  const pill = $("#" + id);
  pill.className = "pill " + color;
  pill.querySelector(".pill-text").textContent = text;
  const dot = pill.querySelector(".dot");
  if (dot) dot.style.display = withDot ? "" : "none";
}

function render() {
  if (!status) return;

  // Header pills
  setPill("pill-running", status.running ? "green" : "amber", status.running ? "Running" : "Paused");
  const b = status.browser || {};
  setPill(
    "pill-browser",
    b.loggedIn ? "green" : b.connected ? "amber" : "gray",
    b.loggedIn ? "Tradovate: logged in" : b.connected ? "Tradovate: not logged in" : "Tradovate: not connected",
  );
  const t = status.tunnel || {};
  setPill(
    "pill-tunnel",
    t.state === "on" ? "green" : t.state === "connecting" ? "amber" : t.state === "error" ? "red" : "gray",
    t.state === "on" ? "Remote access: on" : t.state === "connecting" ? "Remote access: connecting…" : t.state === "error" ? "Remote access: problem" : "Remote access: off",
  );
  setPill("pill-mode", status.mode === "live" ? "red" : "green", status.mode === "live" ? "LIVE MODE" : "Practice mode", false);

  // Big buttons
  const btnRunning = $("#btn-running");
  btnRunning.textContent = status.running ? "⏸ Pause bot" : "▶ Start bot";
  btnRunning.className = "btn big " + (status.running ? "" : "success");

  const btnMode = $("#btn-mode");
  btnMode.textContent = status.mode === "live" ? "🛟 Switch to Practice" : "⚠️ Switch to LIVE";
  btnMode.className = "btn big " + (status.mode === "live" ? "success" : "danger");

  $("#btn-browser").textContent = b.connected ? "🌐 Reconnect browser" : "🌐 Connect browser";

  const btnTunnel = $("#btn-tunnel");
  btnTunnel.textContent = t.state === "on" ? "📡 Turn off remote access" : "📡 Turn on remote access";
  btnTunnel.className = "btn " + (t.state === "on" ? "success" : "");

  // Live-mode banner
  const banner = $("#banner");
  if (status.mode === "live") {
    banner.hidden = false;
    banner.className = "banner red";
    banner.textContent = "⚠️ LIVE MODE — incoming alerts will place REAL orders in Tradovate.";
  } else {
    banner.hidden = true;
  }

  for (const group of ["evals", "funded"]) renderGroup(group);
  renderPassed();
  renderEvents();
}

function renderGroup(group) {
  const card = $("#group-" + group);
  const info = status.groups[group];
  if (!card || !info) return;

  const url = new URL(info.webhookPath, window.location.origin).href;
  $(".webhook-url", card).textContent = url;

  // Keep the contracts box in sync unless the user is mid-edit.
  const cInput = $(".contracts-input", card);
  const cVal = (status.contracts || {})[group];
  if (cVal != null && document.activeElement !== cInput) cInput.value = cVal;

  // Next-up + open trade
  const nextRow = $(".next-row", card);
  let html = info.next
    ? `Next trade goes to: <strong>${esc(info.next)}</strong>`
    : `<span style="color:var(--muted)">No account is ready for the next trade.</span>`;
  if (info.openTrade) {
    const qty = info.openTrade.quantity
      ? ` · ${info.openTrade.quantity} contract${info.openTrade.quantity > 1 ? "s" : ""}`
      : "";
    html += `<span class="open-trade">📈 Trade open: ${esc(info.openTrade.action.toUpperCase())} ${esc(info.openTrade.symbol)} on ${esc(info.openTrade.accountName)}${esc(qty)}</span>`;
  }
  html += `<div style="color:var(--muted);font-size:13px;margin-top:4px">Round-trips finished today: ${info.tradesToday}</div>`;
  nextRow.innerHTML = html;

  // Account list
  const list = $(".account-list", card);
  list.innerHTML = "";
  if (info.accounts.length === 0) {
    list.innerHTML = `<li style="color:var(--muted)">No accounts yet — add one below or use “Scan Tradovate accounts”.</li>`;
  }
  for (const acct of info.accounts) {
    const li = document.createElement("li");
    if (!acct.enabled) li.classList.add("disabled");
    if (acct.restingToday) li.classList.add("resting");
    const isNext = info.next && acct.name === info.next && acct.enabled;
    if (isNext) li.classList.add("next-up");
    li.innerHTML = `
      <div class="acct-name">
        <span class="nick">${esc(acct.name)}</span>
        ${isNext ? '<span class="next-tag">NEXT</span>' : ""}
        ${acct.restingToday ? '<span class="rest-tag" title="Won a trade today — sitting out until tomorrow">😴 WON TODAY</span>' : ""}
        <span class="label">${esc(acct.tradovateLabel)}</span>
        ${balanceLine(acct, group === "evals")}
      </div>
      ${sparklineSvg(acct.history)}
      ${acct.enabled && !isNext ? '<button class="icon-btn nextbtn" title="Make this the next account to trade" data-act="next">⏭</button>' : ""}
      <button class="icon-btn" title="Move up" data-act="up">▲</button>
      <button class="icon-btn" title="Move down" data-act="down">▼</button>
      <button class="icon-btn" title="${acct.enabled ? "Turn off (skip this account)" : "Turn on"}" data-act="toggle">${acct.enabled ? "✅" : "🚫"}</button>
      <button class="icon-btn remove" title="Remove" data-act="remove">✕</button>`;
    for (const btn of $$(".icon-btn", li)) {
      btn.addEventListener("click", () => accountAction(btn.dataset.act, acct));
    }
    list.appendChild(li);
  }
}

function money(n) {
  return "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Balance + "$ to go" line under an account's name. Text only — no color-coded meaning. */
function balanceLine(acct, isEval) {
  if (acct.balance == null) {
    return `<span class="balance-row muted">Balance: — (shows once the browser is connected)</span>`;
  }
  let extra = "";
  if (isEval && acct.toTarget != null) {
    extra =
      acct.toTarget <= 0
        ? ` · 🏆 target reached`
        : ` · <strong>${money(acct.toTarget)}</strong> to go to ${money(status.evalTarget || 53000)}`;
  }
  return `<span class="balance-row">Balance: <strong>${money(acct.balance)}</strong>${extra}</span>`;
}

/**
 * Tiny single-series line chart of the account's balance history.
 * One quiet hue, 2px stroke, no axes (the numbers live in the text beside it);
 * a native tooltip carries the exact range for hover.
 */
function sparklineSvg(history) {
  if (!history || history.length < 2) return `<span class="spark spark-empty"></span>`;
  const W = 110;
  const H = 30;
  const P = 3;
  const vals = history.map((p) => p.b);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const pts = history
    .map((p, i) => {
      const x = P + (i / (history.length - 1)) * (W - 2 * P);
      const y = H - P - ((p.b - min) / span) * (H - 2 * P);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const first = history[0];
  const last = history[history.length - 1];
  const title = `${money(first.b)} → ${money(last.b)}`;
  return `<span class="spark" title="${esc(title)}"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Balance history: ${esc(title)}"><polyline points="${pts}" fill="none" stroke="var(--blue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
}

function renderPassed() {
  const card = $("#passed-card");
  const list = $("#passed-list");
  const passed = status.passed || [];
  card.hidden = passed.length === 0;
  list.innerHTML = "";
  for (const acct of passed) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="acct-name">
        <span class="nick">🏆 ${esc(acct.name)}</span>
        <span class="label">${esc(acct.tradovateLabel)}</span>
        ${acct.balance != null ? `<span class="balance-row">Balance: <strong>${money(acct.balance)}</strong></span>` : ""}
      </div>
      ${sparklineSvg(acct.history)}
      <button class="btn small" data-act="reactivate">Put back in rotation</button>
      <button class="icon-btn remove" title="Remove" data-act="remove">✕</button>`;
    $('[data-act="reactivate"]', li).addEventListener("click", () =>
      doAction(async () => {
        if (!confirm(`Put ${acct.name} back into the ${acct.group} rotation? It will be traded again.`)) return;
        await api("/accounts/reactivate", { label: acct.tradovateLabel });
      }),
    );
    $('[data-act="remove"]', li).addEventListener("click", () => accountAction("remove", acct));
    list.appendChild(li);
  }
}

function renderEvents() {
  const ul = $("#events");
  ul.innerHTML = "";
  if (!status.events || status.events.length === 0) {
    ul.innerHTML = `<li style="color:var(--muted)">Nothing yet — activity will show up here.</li>`;
    return;
  }
  for (const ev of status.events) {
    const li = document.createElement("li");
    li.className = ev.kind;
    const t = new Date(ev.time);
    li.innerHTML = `<span class="time">${t.toLocaleTimeString()}</span><span>${ev.group ? `<strong>[${esc(ev.group)}]</strong> ` : ""}${esc(ev.message)}</span>`;
    ul.appendChild(li);
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function doAction(fn) {
  if (busy) return;
  busy = true;
  document.body.style.cursor = "wait";
  try {
    await fn();
  } catch (err) {
    alert(err.message || "Something went wrong.");
  } finally {
    busy = false;
    document.body.style.cursor = "";
    lastStatusJson = "";
    refresh();
  }
}

async function accountAction(act, acct) {
  return doAction(async () => {
    if (act === "remove") {
      if (!confirm(`Remove ${acct.name} (${acct.tradovateLabel}) from the rotation?`)) return;
      await api("/accounts/remove", { label: acct.tradovateLabel });
    } else if (act === "toggle") {
      await api("/accounts/toggle", { label: acct.tradovateLabel });
    } else if (act === "next") {
      await api("/next", { group: acct.group, label: acct.tradovateLabel });
    } else {
      await api("/accounts/move", { label: acct.tradovateLabel, direction: act });
    }
  });
}

$("#btn-running").addEventListener("click", () =>
  doAction(() => api("/running", { running: !status.running })),
);

$("#btn-mode").addEventListener("click", () => {
  if (!status) return;
  if (status.mode === "live") {
    doAction(() => api("/mode", { mode: "practice" }));
    return;
  }
  showModal(`
    <h2>⚠️ Go LIVE?</h2>
    <div class="warn-box">
      Live mode places <u>REAL orders</u> on your real prop accounts the next time
      a TradingView alert arrives. Make sure:
      <ul style="margin:8px 0 0; padding-left:18px">
        <li>the right contract and size are set on the Tradovate screen,</li>
        <li>the browser is connected and logged in,</li>
        <li>you actually want real trades right now.</li>
      </ul>
    </div>
    <div class="modal-actions">
      <button class="btn" data-close>Cancel — stay in Practice</button>
      <button class="btn danger" id="confirm-live">Yes, switch to LIVE</button>
    </div>`);
  $("#confirm-live").addEventListener("click", () => {
    closeModal();
    doAction(() => api("/mode", { mode: "live", confirm: true }));
  });
});

$("#btn-browser").addEventListener("click", () =>
  doAction(async () => {
    const btn = $("#btn-browser");
    btn.disabled = true;
    btn.textContent = "Opening browser…";
    try {
      await api("/browser/connect", {});
    } finally {
      btn.disabled = false;
    }
  }),
);

$("#btn-scan").addEventListener("click", () =>
  doAction(async () => {
    const btn = $("#btn-scan");
    btn.disabled = true;
    btn.textContent = "Scanning…";
    try {
      const { labels, balances } = await api("/scan", {});
      showScanModal(labels, balances || []);
    } finally {
      btn.disabled = false;
      btn.textContent = "Scan Tradovate accounts";
    }
  }),
);

$("#btn-tunnel").addEventListener("click", () => {
  if (!status) return;
  const on = (status.tunnel || {}).state === "on";
  doAction(async () => {
    const btn = $("#btn-tunnel");
    btn.disabled = true;
    btn.textContent = on ? "Turning off…" : "Turning on…";
    try {
      await api(on ? "/tunnel/disconnect" : "/tunnel/connect", {});
    } finally {
      btn.disabled = false;
    }
  });
});

function showScanModal(labels, balances) {
  if (!labels || labels.length === 0) {
    showModal(`<h2>No accounts found</h2>
      <p>The scan didn't find any LFE… / LFF… accounts in the Tradovate menu.
      Make sure the browser is connected and logged in, then try again.</p>
      <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
    return;
  }
  const balByLabel = {};
  for (const b of balances || []) balByLabel[b.label] = b.balance;
  const anyDollars = (balances || []).some((b) => b.balance != null);
  const known = new Set(
    [...status.groups.evals.accounts, ...status.groups.funded.accounts].map((a) => a.tradovateLabel),
  );
  const rows = labels
    .map((label, i) => {
      const suggested = label.startsWith("LFE") ? "evals" : label.startsWith("LFF") ? "funded" : "skip";
      const already = known.has(label);
      const bal = balByLabel[label];
      const balTxt = bal != null ? `<span class="scan-bal">${money(bal)}</span>` : "";
      return `<li>
        <code>${esc(label)}</code>
        ${balTxt}
        ${already ? '<span style="font-size:12px;color:var(--muted)">(already added)</span>' : ""}
        <label><input type="radio" name="scan-${i}" value="evals" ${suggested === "evals" && !already ? "checked" : ""}/> Evals</label>
        <label><input type="radio" name="scan-${i}" value="funded" ${suggested === "funded" && !already ? "checked" : ""}/> Funded</label>
        <label><input type="radio" name="scan-${i}" value="skip" ${suggested === "skip" || already ? "checked" : ""}/> Skip</label>
      </li>`;
    })
    .join("");
  const balNote = anyDollars
    ? ""
    : `<p style="color:var(--amber);font-size:13px">No dollar balances showed up in the menu — the account numbers still work, but balances will read “—”. If that's unexpected, send a screenshot of your open Tradovate account menu.</p>`;
  showModal(`
    <h2>🔍 Accounts found in Tradovate</h2>
    <p>Tick where each account belongs. LFE… are pre-set to Evals, LFF… to Funded.</p>
    ${balNote}
    <ul class="scan-list">${rows}</ul>
    <div class="modal-actions">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="scan-apply">Add selected</button>
    </div>`);
  $("#scan-apply").addEventListener("click", () =>
    doAction(async () => {
      for (let i = 0; i < labels.length; i++) {
        const pick = $(`input[name="scan-${i}"]:checked`);
        if (pick && pick.value !== "skip") {
          await api("/accounts/add", { label: labels[i], group: pick.value });
        }
      }
      closeModal();
    }),
  );
}

for (const form of $$(".add-form")) {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const group = form.closest(".group").dataset.group;
    const label = form.elements.label.value.trim();
    const name = form.elements.name.value.trim();
    if (!label) return;
    doAction(async () => {
      await api("/accounts/add", { label, name, group });
      form.reset();
    });
  });
}

for (const btn of $$(".save-contracts")) {
  btn.addEventListener("click", () => {
    const card = btn.closest(".group");
    const group = card.dataset.group;
    const contracts = Number($(".contracts-input", card).value);
    doAction(() => api("/contracts", { group, contracts }));
  });
}

for (const btn of $$(".test-contracts")) {
  btn.addEventListener("click", () => {
    const card = btn.closest(".group");
    const group = card.dataset.group;
    doAction(async () => {
      btn.disabled = true;
      btn.textContent = "Testing…";
      try {
        // Save whatever's typed first, then test that value on Tradovate.
        await api("/contracts", { group, contracts: Number($(".contracts-input", card).value) });
        const { confirmed } = await api("/test-quantity", { group });
        alert(`✅ Tradovate now shows ${confirmed} contract(s) on the order ticket. No order was placed.`);
      } finally {
        btn.disabled = false;
        btn.textContent = "Test size on Tradovate";
      }
    });
  });
}

for (const btn of $$(".copy-webhook")) {
  btn.addEventListener("click", () => {
    const url = $(".webhook-url", btn.closest(".group")).textContent;
    navigator.clipboard.writeText(url).then(() => {
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = "Copy"), 1500);
    });
  });
}

// ---------------------------------------------------------------------------
// Modals + login
// ---------------------------------------------------------------------------

function showModal(html) {
  $("#modal-box").innerHTML = html;
  $("#modal-overlay").hidden = false;
  for (const el of $$("#modal-box [data-close]")) el.addEventListener("click", closeModal);
}
function closeModal() {
  $("#modal-overlay").hidden = true;
}

function showLogin(wrong) {
  $("#login-overlay").hidden = false;
  $("#login-error").hidden = !wrong;
}
function hideLogin() {
  $("#login-overlay").hidden = true;
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: $("#login-password").value }),
    }).then((r) => {
      if (!r.ok) throw new Error("wrong");
    });
    hideLogin();
    lastStatusJson = "";
    refresh();
  } catch {
    showLogin(true);
  }
});

// ---------------------------------------------------------------------------

refresh();
setInterval(refresh, 2000);
