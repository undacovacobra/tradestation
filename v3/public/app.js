/* Dashboard logic: polls the bot every 2 seconds and renders the state. */
"use strict";

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

/** The rotation lanes, in display order, and their names in each UI form. */
const STAGES = ["evals", "funded", "winning"];
const STAGE = {
  evals: { label: "Evaluations", short: "EVAL", tag: "Eval" },
  funded: { label: "Funded", short: "FUNDED", tag: "Funded" },
  winning: { label: "Winning Days", short: "WINNING", tag: "Winning" },
};
const stageInfo = (g) => STAGE[g] || { label: g, short: (g || "").toUpperCase(), tag: g };

const loginOptions = (selectedId = "") => ((status && status.logins) || [])
  .map((login) => `<option value="${esc(login.id)}" ${login.id === selectedId ? "selected" : ""}>${esc(login.name)} - ${esc(login.firm)}</option>`)
  .join("");

let lastStatusJson = "";
let status = null;
let busy = false;

// --- Server helpers --------------------------------------------------------

async function fetchAuthed(path, init) {
  let res = await fetch(path, init);
  if (res.status === 401) {
    await new Promise((r) => setTimeout(r, 500));
    res = await fetch(path, init); // one retry — tolerate a flaky tunnel hiccup
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

async function apiDelete(path) {
  const res = await fetchAuthed("/api" + path, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || "Something went wrong.");
  return data;
}

async function flattenApi(path, body) {
  const res = await fetchAuthed("/api" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    showLogin(false);
    throw new Error("Please log in.");
  }
  const data = await res.json().catch(() => ({}));
  if (((!res.ok && res.status !== 207) && !data.result) || (!data.results && !data.result)) {
    throw new Error(data.error || "The broker flatten scan could not run.");
  }
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
    setPill("pill-running", "red", "Can't reach ATLAS");
  }
}

// --- Rendering -------------------------------------------------------------

function setPill(id, color, text, withDot = true) {
  const pill = $("#" + id);
  pill.className = "pill " + color;
  pill.querySelector(".pill-text").textContent = text;
  const dot = pill.querySelector(".dot");
  if (dot) dot.style.display = withDot ? "" : "none";
}

function render() {
  if (!status) return;

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

  const btnRunning = $("#btn-running");
  btnRunning.textContent = status.running ? "⏸ Pause ATLAS" : "▶ Start ATLAS";
  btnRunning.className = "btn big " + (status.running ? "" : "success");

  const btnMode = $("#btn-mode");
  btnMode.textContent = status.mode === "live" ? "🛟 Switch to Practice" : "⚠️ Switch to LIVE";
  btnMode.className = "btn big " + (status.mode === "live" ? "success" : "danger");

  $("#btn-browser").textContent = b.connected ? "🌐 Reconnect browser" : "🌐 Connect browser";

  const btnTunnel = $("#btn-tunnel");
  btnTunnel.textContent = t.state === "on" ? "📡 Turn off remote access" : "📡 Turn on remote access";
  btnTunnel.className = "btn " + (t.state === "on" ? "success" : "");

  const banner = $("#banner");
  if (status.mode === "live") {
    banner.hidden = false;
    banner.className = "banner red";
    banner.textContent = "⚠️ LIVE MODE — incoming alerts will place REAL orders in Tradovate.";
  } else {
    banner.hidden = true;
  }

  renderLogins();
  renderPassed();
  renderTradeLog();
  renderEvents();
}

/** "Today's trades" — every finished round-trip today, with contracts + time. */
function renderTradeLog() {
  const summary = $("#log-summary");
  const table = $("#log-table");
  let rows = [];
  for (const credential of status.credentials || []) {
    for (const lane of credential.lanes || []) {
      if (lane.log) rows = rows.concat(lane.log.map((t) => ({ ...t, group: lane.stage, credential: credential.name })));
    }
  }
  rows.sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));

  if (rows.length === 0) {
    summary.innerHTML = `<span style="color:var(--muted)">No trades yet today — finished round-trips will show up here.</span>`;
    table.innerHTML = "";
    return;
  }

  // Per-account tally: trades + total contracts today.
  const tally = {};
  for (const t of rows) {
    const key = t.tradovateLabel;
    if (!tally[key]) tally[key] = { name: t.accountName, trades: 0, contracts: 0 };
    tally[key].trades += 1;
    tally[key].contracts += Number(t.quantity) || 0;
  }
  summary.innerHTML = Object.values(tally)
    .map(
      (a) =>
        `<span class="tally-chip"><strong>${esc(a.name)}</strong>: ${a.trades} trade${a.trades === 1 ? "" : "s"}${a.contracts ? ` · ${a.contracts} contract${a.contracts === 1 ? "" : "s"}` : ""}</span>`,
    )
    .join("");

  let html =
    `<tr><th>Time</th><th>Account</th><th>Side</th><th>Contracts</th><th>Result</th></tr>`;
  for (const t of rows) {
    const time = new Date(t.closedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const side = String(t.action || "").toUpperCase();
    const qty = t.quantity != null ? t.quantity : "—";
    let result = `<span style="color:var(--muted)">—</span>`;
    if (t.won) result = `<span style="color:var(--green);font-weight:600">🏅 WON${t.pnl != null ? " +" + money(t.pnl) : ""}</span>`;
    else if (t.pnl != null) result = `<span style="color:${t.pnl < 0 ? "var(--red)" : "var(--muted)"}">${t.pnl < 0 ? "−" : "+"}${money(Math.abs(t.pnl))}</span>`;
    html += `<tr>
      <td>${esc(time)}</td>
      <td>${esc(t.accountName)} <span class="grouptag">${esc(stageInfo(t.group).tag)}</span></td>
      <td>${esc(side)}</td>
      <td>${esc(String(qty))}</td>
      <td>${result}</td>
    </tr>`;
  }
  table.innerHTML = html;
}

function renderLogins() {
  const list = $("#login-list");
  if (!list) return;
  const credentials = status.credentials || [];
  const webhookBase = status.publicWebhookBaseUrl || (status.tunnel && status.tunnel.url) || window.location.origin;

  list.innerHTML = credentials.map((credential) => {
    const connection = credential.status || {};
    const connectionState = connection.loggedIn ? "Logged in" : connection.connected ? "Needs login" : "Not connected";
    const lanes = credential.lanes || [];
    const orderedStages = STAGES;
    const stagePanels = orderedStages.map((stage) => {
      const lane = lanes.find((candidate) => candidate.stage === stage) || {
        stage,
        accounts: [],
        next: "None",
        nextLabel: null,
        queue: { totalPending: 0, running: false },
        brokerPosition: { state: "FLAT" },
      };
      const queue = lane.queue || { totalPending: 0, running: false };
      const brokerPosition = lane.brokerPosition || { state: lane.openTrade ? "AWAITING BROKER" : "FLAT" };
      const accountRows = (lane.accounts || []).map((account) => {
        const isNext = lane.nextLabel === account.tradovateLabel;
        const isOpen = lane.openTrade && (
          lane.openTrade.tradovateLabel === account.tradovateLabel ||
          lane.openTrade.accountName === account.name
        );
        const brokerAccountOpen = account.brokerPosition?.status === "open";
        const stageLabel = stageInfo(account.group).short;
        return `<li class="credential-account-row ${account.enabled ? "" : "disabled"}" data-stage="${esc(account.group)}" data-label="${esc(account.tradovateLabel)}">
          <div class="credential-account-main">
            <span class="credential-account-identity">
              <strong>${esc(account.name)}</strong>
              <small class="credential-account-id">${esc(account.tradovateLabel)}</small>
            </span>
            <span class="stage-tag ${esc(account.group)}">${stageLabel}</span>
            ${isNext ? '<span class="next-tag">NEXT</span>' : ""}
            ${account.restingToday ? `<span class="rest-tag">😴 ${account.group === "winning" ? "traded today" : "won today"}</span>` : ""}
          </div>
          <div class="credential-account-details">
            ${balanceLine(account)}
            ${bracketLine(account)}
            ${sparkline(account.history)}
            ${isOpen ? `<span class="open-account-trade">Open: ${esc(lane.openTrade.symbol || "position")}</span>` : ""}
            ${account.brokerPosition ? `<span class="account-broker-position">Position: <strong>${account.brokerPosition.status === "open" ? esc(String(account.brokerPosition.netPosition)) : esc(account.brokerPosition.status.toUpperCase())}</strong></span>` : ""}
          </div>
          <div class="credential-account-actions">
            ${!isNext && account.enabled ? '<button class="btn small credential-account-action" data-act="next">Next</button>' : ""}
            ${account.restingToday ? '<button class="btn small credential-account-action" data-act="unrest">Trade again today</button>' : ""}
            <button class="btn small credential-account-action" data-act="bracket">ATM</button>
            <button class="btn small credential-position-check">Position</button>
            ${brokerAccountOpen ? '<button class="btn small danger credential-flatten-position">Flatten position</button>' : ""}
            <button class="btn small credential-account-action" data-act="up" title="Move up">&#9650;</button>
            <button class="btn small credential-account-action" data-act="down" title="Move down">&#9660;</button>
            <button class="btn small credential-account-action" data-act="toggle">${account.enabled ? "Disable" : "Enable"}</button>
            <button class="btn small credential-account-action remove" data-act="remove">Remove</button>
            ${isOpen ? '<button class="btn small credential-reset">Mark closed / reset</button>' : ""}
          </div>
        </li>`;
      }).join("") || '<li class="credential-account-empty">No accounts assigned. Use Scan &amp; assign accounts above.</li>';

      return `<section class="credential-stage-panel" data-stage="${esc(lane.stage)}">
        <header class="credential-stage-heading">
          <strong>${stageInfo(lane.stage).label}</strong>
          <span>Next: ${esc(lane.next || "None")}</span>
          <span>Queue: ${queue.totalPending || 0}${queue.running ? " + running" : ""}</span>
          <span class="broker-position" data-broker-state="${esc(brokerPosition.state || "UNKNOWN")}">Broker: <strong>${esc(brokerPosition.state || "UNKNOWN")}</strong></span>
          ${brokerPosition.reason ? `<span class="readiness-error">${esc(brokerPosition.reason)}</span>` : ""}
          ${lane.readinessError ? `<span class="readiness-error">${esc(lane.readinessError)}</span>` : ""}
        </header>
        <ul class="credential-account-list">${accountRows}</ul>
      </section>`;
    }).join("");

    const accountCount = lanes.flatMap((lane) => lane.accounts || []).length;
    return `<div class="credential-card" data-login-id="${esc(credential.id)}">
      <div class="credential-heading">
        <div class="login-details">
          <strong>${esc(credential.name)}</strong>
          <span>${esc(credential.firm)} &middot; Tradovate &middot; one browser connection for all accounts</span>
          <small>${esc(connectionState)} &middot; ${accountCount} account${accountCount === 1 ? "" : "s"}</small>
        </div>
        ${accountCount === 0 ? '<button class="btn small login-remove">Remove unused login</button>' : ""}
      </div>
      <div class="credential-stage-grid">${stagePanels}</div>
    </div>`;
  }).join("") || '<p style="color:var(--muted)">No saved Tradovate credentials.</p>';

  for (const stage of STAGES) {
    const el = $(`#global-${stage}-webhook-url`);
    if (el) el.textContent = new URL((status.globalWebhookPaths || {})[stage] || `/webhook/${stage}`, webhookBase).href;
  }

  for (const credentialRow of $$(".credential-card", list)) {
    const loginId = credentialRow.dataset.loginId;
    const credential = credentials.find((item) => item.id === loginId);
    const remove = $(".login-remove", credentialRow);
    if (remove) remove.addEventListener("click", () => doAction(() => apiDelete(`/logins/${loginId}`)));

    for (const accountRow of $$(".credential-account-row", credentialRow)) {
      const stage = accountRow.dataset.stage;
      const label = accountRow.dataset.label;
      const lane = (credential.lanes || []).find((item) => item.stage === stage);
      const account = lane && (lane.accounts || []).find((item) => item.tradovateLabel === label);
      if (!account) continue;

      for (const button of $$(".credential-account-action", accountRow)) {
        button.addEventListener("click", () => accountAction(button.dataset.act, account));
      }
      $(".credential-position-check", accountRow).addEventListener("click", () => doAction(() => api("/browser/position", {
        loginId,
        group: stage,
        label,
      })));
      const flatten = $(".credential-flatten-position", accountRow);
      if (flatten) flatten.addEventListener("click", () => showFlattenOneModal(account));
      const reset = $(".credential-reset", accountRow);
      if (reset) reset.addEventListener("click", () => doAction(() => api("/reset-trade", { group: stage, credentialId: loginId })));
    }
  }
}
function renderPassed() {
  const card = $("#passed-card");
  const list = $("#passed-list");
  const passed = (status && status.passed) || [];
  if (passed.length === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  list.innerHTML = "";
  for (const acct of passed) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="acct-name">
        <span class="nick">🏆 ${esc(acct.name)}</span>
        <span class="label">${esc(acct.tradovateLabel)} · ${esc(acct.group)}</span>
        ${acct.balance != null ? `<span class="balance-row">Finished at <strong>${money(acct.balance)}</strong></span>` : ""}
      </div>
      <button class="btn small" data-act="reactivate">Put back in rotation</button>`;
    $("[data-act=reactivate]", li).addEventListener("click", () =>
      doAction(() => api("/accounts/reactivate", { label: acct.tradovateLabel })),
    );
    list.appendChild(li);
  }
}

function money(n) {
  return "$" + Math.round(n).toLocaleString("en-US");
}

/** One line under an account: its balance and how far to the profit target. */
function balanceLine(acct) {
  const target = (status && status.evalTarget) || 53000;
  if (acct.balance == null) {
    return `<span class="balance-row muted">Balance: not read yet (updates when it's armed or trading).</span>`;
  }
  if (acct.group !== "evals") {
    // Only the evaluation lane tracks a profit target; funded and winning show
    // the plain balance.
    return `<span class="balance-row">&#128176; <strong>${money(acct.balance)}</strong></span>`;
  }
  if (acct.balance >= target) {
    return `<span class="balance-row">💰 <strong>${money(acct.balance)}</strong> — at the ${money(target)} target 🎯</span>`;
  }
  const toGo = acct.toTarget != null ? acct.toTarget : target - acct.balance;
  return `<span class="balance-row">💰 <strong>${money(acct.balance)}</strong> · ${money(toGo)} to ${money(target)}</span>`;
}

/** One line showing which saved ATM preset this account uses. */
function bracketLine(acct) {
  if (acct.atmPreset) {
    return `<span class="balance-row">🎯 ATM preset: <strong>${esc(acct.atmPreset)}</strong></span>`;
  }
  return `<span class="balance-row muted">🎯 no ATM preset — uses the Tradovate ticket's</span>`;
}

/** Tiny inline SVG sparkline of an account's recent balance history. */
function sparkline(history) {
  if (!history || history.length < 2) return '<span class="spark-empty"></span>';
  const vals = history.map((p) => p.b);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const w = 110;
  const h = 26;
  const n = vals.length;
  const span = max - min || 1;
  const pts = vals
    .map((v, i) => {
      const x = (i / (n - 1)) * w;
      const y = h - ((v - min) / span) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const up = vals[vals.length - 1] >= vals[0];
  const color = up ? "var(--green)" : "var(--red)";
  return `<span class="spark"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
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
    const time = new Date(ev.time);
    li.innerHTML = `<span class="time">${time.toLocaleTimeString()}</span><span>${ev.group ? `<strong>[${esc(ev.group)}]</strong> ` : ""}${esc(ev.message)}</span>`;
    ul.appendChild(li);
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// --- Actions ---------------------------------------------------------------

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
  if (act === "bracket") return showBracketModal(acct);
  return doAction(async () => {
    if (act === "remove") {
      if (!confirm(`Remove ${acct.name} (${acct.tradovateLabel}) from the rotation?`)) return;
      await api("/accounts/remove", { label: acct.tradovateLabel });
    } else if (act === "toggle") {
      await api("/accounts/toggle", { label: acct.tradovateLabel });
    } else if (act === "next") {
      await api("/next", { group: acct.group, credentialId: acct.loginId, label: acct.tradovateLabel });
    } else if (act === "unrest") {
      await api("/accounts/unrest", { group: acct.group, label: acct.tradovateLabel });
    } else {
      await api("/accounts/move", { label: acct.tradovateLabel, direction: act });
    }
  });
}

function chooseLogin(title, action) {
  const logins = status.logins || [];
  if (logins.length === 1) return action(logins[0].id);
  if (logins.length === 0) return alert("Add a Tradovate login first.");
  showModal(`<h2>${esc(title)}</h2>
    <p>Choose the saved Tradovate session to use.</p>
    <div class="login-picker">${logins.map((login) => `<button class="btn pick-login" data-login-id="${esc(login.id)}">${esc(login.name)} - ${esc(login.firm)}</button>`).join("")}</div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button></div>`);
  for (const button of $$(".pick-login", $("#modal-box"))) {
    button.addEventListener("click", () => {
      const loginId = button.dataset.loginId;
      closeModal();
      action(loginId);
    });
  }
}

function showFlattenResults(title, results) {
  const rows = (results || []).map((result) => `<li class="flatten-result ${esc(result.outcome)}">
    <strong>${esc(result.name)} (${esc(result.label)})</strong>
    <span>${esc(result.message)}</span>
  </li>`).join("");
  showModal(`<h2>${esc(title)}</h2>
    <ul class="flatten-results">${rows || '<li class="flatten-result failed">No account results were returned.</li>'}</ul>
    <p class="modal-note">ATLAS kept its existing Running or Paused state.</p>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
}

function showFlattenOneModal(account) {
  showModal(`<h2>Flatten ${esc(account.name)}?</h2>
    <div class="warn-box">
      ATLAS will re-check <strong>${esc(account.tradovateLabel)}</strong> on Tradovate and only click
      <strong>Exit at Mkt &amp; Cxl</strong> if the broker confirms a nonzero position.
      This is a <strong>REAL broker action even in Practice mode</strong>.
    </div>
    <p>This does not pause ATLAS. Completion requires two consecutive broker-flat reads.</p>
    <div class="modal-actions">
      <button class="btn" data-close>Cancel</button>
      <button class="btn danger" id="confirm-flatten-one">Flatten this position</button>
    </div>`);
  $("#confirm-flatten-one").addEventListener("click", () => doAction(async () => {
    const data = await flattenApi("/positions/flatten-one", {
      confirm: "FLATTEN ONE",
      loginId: account.loginId,
      group: account.group,
      label: account.tradovateLabel,
    });
    showFlattenResults("Flatten result", [data.result]);
  }));
}

$("#btn-running").addEventListener("click", () => doAction(() => api("/running", { running: !status.running })));

$("#btn-flatten-all").addEventListener("click", () => {
  showModal(`<h2>Flatten every open position?</h2>
    <div class="warn-box">
      ATLAS will scan <strong>every saved account</strong>, including disabled and passed accounts.
      It will only click <strong>Exit at Mkt &amp; Cxl</strong> where Tradovate confirms a nonzero position.
      These are <strong>REAL broker actions even in Practice mode</strong>.
    </div>
    <p>Funded accounts are checked first within each login. This does not pause ATLAS; its current Running or Paused state stays unchanged.</p>
    <div class="modal-actions">
      <button class="btn" data-close>Cancel</button>
      <button class="btn danger" id="confirm-flatten-all">Flatten all confirmed positions</button>
    </div>`);
  $("#confirm-flatten-all").addEventListener("click", () => doAction(async () => {
    const data = await flattenApi("/positions/flatten-all", { confirm: "FLATTEN ALL" });
    showFlattenResults("Flatten all results", data.results);
  }));
});

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
      a TradingView alert arrives. Make sure the right contract and size are set on
      the Tradovate screen, the browser is connected and logged in, and you actually
      want real trades right now.
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

$("#btn-browser").addEventListener("click", () => chooseLogin("Connect a Tradovate login", (loginId) =>
  doAction(async () => {
    const btn = $("#btn-browser");
    btn.disabled = true;
    btn.textContent = "Opening browser…";
    try {
      await api("/browser/connect", { loginId });
    } finally {
      btn.disabled = false;
    }
  }),
));

$("#btn-scan-assign").addEventListener("click", () => chooseLogin("Scan and assign a Tradovate login", (loginId) =>
  doAction(async () => {
    const result = await api(`/logins/${loginId}/accounts`);
    showScanModal(result.labels, loginId);
  }),
));

function showAddLoginModal() {
  showModal(`
    <h2>Add a Tradovate login</h2>
    <p>Add another login only for a different Tradovate username and password. Evaluation and Funded accounts under the same username belong together in one login. After adding it, connect and log in, then scan and assign its accounts.</p>
    <form id="add-login-modal" class="modal-form-grid">
      <label class="field-stack">Login name<input name="name" placeholder="e.g. Tradovate Funded" required /></label>
      <label class="field-stack">Prop firm<input name="firm" placeholder="e.g. Apex" required /></label>
      <div id="add-login-result" class="modal-result" aria-live="polite"></div>
      <div class="modal-actions">
        <button class="btn" type="button" data-close>Cancel</button>
        <button class="btn primary" type="submit">Add login</button>
      </div>
    </form>`);
  const form = $("#add-login-modal");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const result = $("#add-login-result");
    button.disabled = true;
    result.textContent = "Adding login…";
    try {
      await api("/logins", { name: form.elements.name.value.trim(), firm: form.elements.firm.value.trim() });
      closeModal();
      lastStatusJson = "";
      await refresh();
    } catch (error) {
      result.innerHTML = `<span class="error-text">${esc(error.message || "Could not add this login.")}</span>`;
    } finally {
      button.disabled = false;
    }
  });
}

$("#btn-add-login").addEventListener("click", showAddLoginModal);

function showBracketModal(acct) {
  showModal(`
    <h2>🎯 ${esc(acct.name)} — ATM preset</h2>
    <p>Type the <strong>name</strong> of the saved Tradovate ATM preset this account should use (e.g. <strong>25</strong>, <strong>50</strong>, <strong>funded</strong>). ATLAS picks it from the ATM dropdown before each trade, so the exchange holds the stop/target. Leave it blank to just use whatever ATM is on the ticket.</p>
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:14px 0">
      <label>ATM preset name <input id="atm-preset" type="text" value="${esc(acct.atmPreset || "")}" placeholder="e.g. 25" style="font:inherit;width:160px;padding:10px;border-radius:8px;border:1px solid var(--line)" /></label>
    </div>
    <p style="color:var(--muted);font-size:13px">It must match the preset name in Tradovate <em>exactly</em> (same spelling and capitals).</p>
    <div class="modal-actions">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="atm-apply">Save</button>
    </div>`);
  $("#atm-apply").addEventListener("click", () =>
    doAction(async () => {
      await api("/accounts/atm-preset", { label: acct.tradovateLabel, preset: $("#atm-preset").value });
      closeModal();
    }),
  );
}

$("#btn-testbracket").addEventListener("click", () => {
  if (!status) return;
  showModal(`
    <h2>🎯 Test an ATM preset</h2>
    <p>Type the name of a saved ATM preset. ATLAS picks it from the Tradovate ATM dropdown — <strong>no order is placed.</strong> Watch the ATM name change on the Tradovate screen.</p>
    <p style="color:var(--muted);font-size:13px">The browser must be connected, logged in, and on an account.</p>
    <form id="brk-form" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0">
      <label>Login <select id="brk-login">${loginOptions()}</select></label>
      <label>Preset name <input id="brk-preset" type="text" value="25" style="font:inherit;width:150px;padding:10px;border-radius:8px;border:1px solid var(--line)" /></label>
      <button class="btn primary" type="submit">Pick &amp; time it</button>
    </form>
    <div id="brk-result" style="font-size:18px;min-height:24px"></div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  const form = $("#brk-form");
  const result = $("#brk-result");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const preset = String($("#brk-preset").value || "").trim();
    const btn = form.querySelector("button");
    btn.disabled = true;
    result.textContent = "Selecting…";
    try {
      const r = await api("/test-preset", { preset, loginId: $("#brk-login").value });
      if (r.set) {
        result.innerHTML = `<strong>Selected preset "${esc(r.preset)}" in ${r.ms}ms</strong> ✅`;
      } else {
        result.innerHTML = `<div style="font-size:16px;color:var(--red)">⚠️ ${esc(r.message || "Couldn't select it.")}</div>`;
      }
    } catch (err) {
      result.innerHTML = `<span style="color:var(--red)">⚠️ ${esc(err.message)}</span>`;
    } finally {
      btn.disabled = false;
    }
  });
});

$("#btn-testqty").addEventListener("click", () => {
  if (!status) return;
  showModal(`
    <h2>🔢 Test order size</h2>
    <p>Type a number of contracts and time how long ATLAS takes to set it on the Tradovate ticket. <strong>No order is placed.</strong></p>
    <p style="color:var(--muted);font-size:13px">The browser must be connected, logged in, and sitting on an account (so the order ticket is showing). Type a different number each time to see a real set.</p>
    <form id="qty-form" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0">
      <label>Login <select id="qty-login">${loginOptions()}</select></label>
      <input id="qty-input" type="number" min="1" step="1" value="1" style="font:inherit;width:90px;padding:10px;border-radius:8px;border:1px solid var(--line)" />
      <button class="btn primary" type="submit">Set &amp; time it</button>
    </form>
    <div id="qty-result" style="font-size:20px;min-height:26px"></div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  const form = $("#qty-form");
  const result = $("#qty-result");
  const input = $("#qty-input");
  input.focus();
  input.select();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const qty = Math.floor(Number(input.value));
    if (!Number.isFinite(qty) || qty < 1) {
      result.innerHTML = `<span style="color:var(--red)">Enter a whole number of 1 or more.</span>`;
      return;
    }
    const btn = form.querySelector("button");
    btn.disabled = true;
    result.textContent = "Setting…";
    const t0 = Date.now();
    try {
      const r = await api("/test-quantity", { quantity: qty, loginId: $("#qty-login").value });
      const total = Date.now() - t0;
      if (r.set) {
        result.innerHTML = `<strong>Set to ${r.quantity} in ${r.ms}ms</strong> ✅ <span style="color:var(--muted);font-size:13px">(button-to-answer ${total}ms)</span>`;
      } else {
        let html = `<div style="font-size:16px;color:var(--red)">⚠️ ${esc(r.message || "Couldn't set it.")}</div>`;
        if (r.fields && r.fields.length) {
          html += `<p style="font-size:13px;color:var(--muted);margin:10px 0 4px">Boxes ATLAS can see on the ticket — <strong>screenshot this whole list for support</strong> so it can be calibrated:</p>`;
          html += `<div style="max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:8px">`;
          html += `<table style="width:100%;font-size:12px;border-collapse:collapse">`;
          html += `<tr style="text-align:left;color:var(--muted)"><th style="padding:3px 6px">#</th><th style="padding:3px 6px">kind</th><th style="padding:3px 6px">label / name / class</th><th style="padding:3px 6px">near</th><th style="padding:3px 6px">value</th></tr>`;
          r.fields.forEach((f, i) => {
            const lbl = [f.ariaLabel, f.name, f.placeholder, f.cls].filter(Boolean).join(" · ") || "—";
            const kind = esc(f.tag) + (f.type ? "/" + esc(f.type) : "") + (f.role ? " " + esc(f.role) : "");
            html += `<tr style="border-top:1px solid var(--line)"><td style="padding:3px 6px">${i}</td><td style="padding:3px 6px">${kind}</td><td style="padding:3px 6px">${esc(lbl)}</td><td style="padding:3px 6px">${esc(f.near || "")}</td><td style="padding:3px 6px">${esc(f.value)}</td></tr>`;
          });
          html += `</table></div>`;
        } else if (r.fields) {
          html += `<p style="font-size:13px;color:var(--muted)">ATLAS couldn't see any input boxes — make sure the order ticket is open on the Tradovate screen, then try again.</p>`;
        }
        result.innerHTML = html;
      }
    } catch (err) {
      result.innerHTML = `<span style="color:var(--red)">⚠️ ${esc(err.message)}</span>`;
    } finally {
      btn.disabled = false;
      input.select();
    }
  });
});

$("#btn-testwebhook").addEventListener("click", () => {
  if (!status) return;
  const live = status.mode === "live";
  showModal(`
    <h2>🧪 Test webhook — real 1-for-1</h2>
    <p>Sends a real alert to <strong>/webhook/&lt;lane&gt;</strong> exactly like TradingView would — same address, same secret, same handling. ${live ? '<strong style="color:var(--red)">You are in LIVE mode — this places a REAL order.</strong>' : "You are in Practice mode — no real order is placed."}</p>
    <form id="tw-form" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0">
      <label>Lane <select id="tw-group">${STAGES.map((s) => `<option value="${s}">${esc(stageInfo(s).label)}</option>`).join("")}</select></label>
      <label>Action <select id="tw-action"><option value="buy">Buy</option><option value="sell">Sell</option></select></label>
      <label>Quantity <input id="tw-qty" type="number" min="1" step="1" value="1" style="width:80px;padding:8px;border-radius:8px;border:1px solid var(--line)"/></label>
      <label style="display:flex;align-items:center;gap:6px"><input id="tw-close" type="checkbox"/> send as CLOSE (flat)</label>
      <button class="btn primary" type="submit">Fire it</button>
    </form>
    <div id="tw-result" style="font-size:14px;min-height:24px"></div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  const form = $("#tw-form");
  const result = $("#tw-result");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const group = $("#tw-group").value;
    const action = $("#tw-action").value;
    const quantity = Math.floor(Number($("#tw-qty").value));
    const close = $("#tw-close").checked;
    if (!Number.isFinite(quantity) || quantity < 1) {
      result.innerHTML = `<span style="color:var(--red)">Enter a whole number of 1 or more.</span>`;
      return;
    }
    const btn = form.querySelector("button");
    btn.disabled = true;
    result.textContent = "Firing…";
    try {
      const r = await api("/test-webhook", { group, action, quantity, close, confirmLive: true });
      const msg = (r.response && (r.response.message || r.response.error)) || "(no message)";
      result.innerHTML = `<div><strong>Sent to ${esc(r.sentTo)}</strong> — HTTP ${r.httpStatus} in ${r.ms}ms</div>
        <div style="margin-top:6px">Bot replied: <strong>${esc(msg)}</strong></div>
        <pre style="margin-top:8px;background:rgba(127,127,127,.12);padding:8px;border-radius:8px;overflow:auto;font-size:12px">${esc(JSON.stringify(r.sentPayload, null, 2))}</pre>
        <p style="color:var(--muted);font-size:12px">This is the exact JSON that was sent — compare it field-for-field to your TradingView alert message.</p>`;
    } catch (err) {
      result.innerHTML = `<span style="color:var(--red)">⚠️ ${esc(err.message)}</span>`;
    } finally {
      btn.disabled = false;
      lastStatusJson = "";
      refresh();
    }
  });
});

$("#btn-stress").addEventListener("click", () => {
  if (!status) return;
  showModal(`
    <h2>🏋️ Stress test — all lanes at once</h2>
    <p>Fires a full arm — <strong>switch account → set its ATM preset → set the size</strong> — for <strong>every enabled account in every lane, all at the same time</strong>. This recreates the heaviest churn a real trade storm could throw at it. <strong>No orders are placed.</strong></p>
    <p style="color:var(--muted);font-size:13px">Run this only when everything is flat (no open trades). The browser must be connected and logged in. Each row shows whether that account set its account + ATM + size cleanly, and how long it took.</p>
    <form id="stress-form" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0">
      <label>Size <input id="stress-qty" type="number" min="1" step="1" value="20" style="width:80px;padding:8px;border-radius:8px;border:1px solid var(--line)"/></label>
      <label>Rounds <input id="stress-rounds" type="number" min="1" max="5" step="1" value="1" style="width:70px;padding:8px;border-radius:8px;border:1px solid var(--line)"/></label>
      <button class="btn primary" type="submit">Run stress test</button>
    </form>
    <div id="stress-result" style="font-size:14px;min-height:24px"></div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
  const form = $("#stress-form");
  const result = $("#stress-result");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const quantity = Math.floor(Number($("#stress-qty").value));
    const rounds = Math.floor(Number($("#stress-rounds").value));
    if (!Number.isFinite(quantity) || quantity < 1) {
      result.innerHTML = `<span style="color:var(--red)">Enter a whole-number size of 1 or more.</span>`;
      return;
    }
    const btn = form.querySelector("button");
    btn.disabled = true;
    result.innerHTML = `Running the storm… <span style="color:var(--muted)">this takes a few seconds per account</span>`;
    try {
      const r = await api("/tests/stress-all", { quantity, rounds });
      const rows = r.results || [];
      const fails = rows.filter((x) => !x.ok);
      let html = r.passed
        ? `<div style="font-size:18px;color:var(--green);font-weight:600">✅ PASSED — all ${rows.length} arms set account + ATM + size cleanly.</div>`
        : `<div style="font-size:18px;color:var(--red);font-weight:600">⚠️ ${fails.length} of ${rows.length} arms failed.</div>`;
      html += `<div style="color:var(--muted);font-size:13px;margin:4px 0 10px">Total ${r.totalMs}ms · slowest single arm ${r.slowestMs}ms · ${r.rounds} round(s) · no orders placed.</div>`;
      html += `<div style="max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:8px"><table style="width:100%;font-size:12px;border-collapse:collapse">`;
      html += `<tr style="text-align:left;color:var(--muted)"><th style="padding:4px 8px">Lane</th><th style="padding:4px 8px">Account</th><th style="padding:4px 8px">Result</th><th style="padding:4px 8px">ms</th></tr>`;
      for (const x of rows) {
        const tag = stageInfo(x.group).tag;
        const res = x.ok
          ? `<span style="color:var(--green)">✅ ok</span>`
          : `<span style="color:var(--red)">⚠️ ${esc(x.error || "failed")}</span>`;
        html += `<tr style="border-top:1px solid var(--line)"><td style="padding:4px 8px">${esc(tag)}</td><td style="padding:4px 8px">${esc(x.account)}</td><td style="padding:4px 8px">${res}</td><td style="padding:4px 8px">${x.ms ?? "—"}</td></tr>`;
      }
      html += `</table></div>`;
      result.innerHTML = html;
    } catch (err) {
      result.innerHTML = `<span style="color:var(--red)">⚠️ ${esc(err.message)}</span>`;
    } finally {
      btn.disabled = false;
      lastStatusJson = "";
      refresh();
    }
  });
});

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

function copyButton(button, text) {
  navigator.clipboard.writeText(text).then(() => {
    button.textContent = "Copied!";
    setTimeout(() => (button.textContent = "Copy"), 1500);
  });
}

for (const button of $$(".copy-global")) {
  button.addEventListener("click", () => copyButton(button, $("#" + button.dataset.copyTarget).textContent));
}

function showScanModal(labels, loginId) {
  if (!labels || labels.length === 0) {
    showModal(`<h2>No accounts found</h2>
      <p>The scan didn't find any LFE… / LFF… accounts. Make sure the browser is connected and logged in, then try again.</p>
      <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
    return;
  }
  const known = new Set((status.credentials || []).flatMap((credential) => credential.lanes || []).flatMap((lane) => lane.accounts || []).map((a) => a.tradovateLabel));
  const rows = labels
    .map((label, i) => {
      const suggested = label.startsWith("LFE") ? "evals" : label.startsWith("LFF") ? "funded" : "skip";
      const already = known.has(label);
      return `<li>
        <code>${esc(label)}</code>
        ${already ? '<span style="font-size:12px;color:var(--muted)">(already added)</span>' : ""}
        <label><input type="radio" name="scan-${i}" value="evals" ${suggested === "evals" && !already ? "checked" : ""}/> Evals</label>
        <label><input type="radio" name="scan-${i}" value="funded" ${suggested === "funded" && !already ? "checked" : ""}/> Funded</label>
        <label><input type="radio" name="scan-${i}" value="winning" ${suggested === "winning" && !already ? "checked" : ""}/> Winning Days</label>
        <label><input type="radio" name="scan-${i}" value="skip" ${suggested === "skip" || already ? "checked" : ""}/> Skip</label>
      </li>`;
    })
    .join("");
  showModal(`
    <h2>🔍 Accounts found in Tradovate</h2>
    <p>Tick where each account belongs. LFE… are pre-set to Evals, LFF… to Funded.</p>
    <ul class="scan-list">${rows}</ul>
    <div class="modal-actions">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="scan-apply">Add selected</button>
    </div>`);
  $("#scan-apply").addEventListener("click", () =>
    doAction(async () => {
      for (let i = 0; i < labels.length; i++) {
        const pick = $(`input[name="scan-${i}"]:checked`);
        if (pick && pick.value !== "skip") await api("/accounts/add", { label: labels[i], group: pick.value, loginId });
      }
      closeModal();
    }),
  );
}

// --- Modals + login --------------------------------------------------------

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
