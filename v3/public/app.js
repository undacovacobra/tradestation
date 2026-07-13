/* Dashboard logic: polls the bot every 2 seconds and renders the state. */
"use strict";

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

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
  btnRunning.textContent = status.running ? "⏸ Pause bot" : "▶ Start bot";
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

  for (const group of ["evals", "funded"]) renderGroup(group);
  renderPassed();
  renderTradeLog();
  renderEvents();
}

/** "Today's trades" — every finished round-trip today, with contracts + time. */
function renderTradeLog() {
  const summary = $("#log-summary");
  const table = $("#log-table");
  let rows = [];
  for (const group of ["evals", "funded"]) {
    const info = status.groups[group];
    if (info && info.log) rows = rows.concat(info.log.map((t) => ({ ...t, group })));
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
      <td>${esc(t.accountName)} <span class="grouptag">${t.group === "evals" ? "Eval" : "Funded"}</span></td>
      <td>${esc(side)}</td>
      <td>${esc(String(qty))}</td>
      <td>${result}</td>
    </tr>`;
  }
  table.innerHTML = html;
}

function renderGroup(group) {
  const card = $("#group-" + group);
  const info = status.groups[group];
  if (!card || !info) return;

  $(".webhook-url", card).textContent = new URL(info.webhookPath, window.location.origin).href;

  const nextRow = $(".next-row", card);
  let html = info.next
    ? `Next trade goes to: <strong>${esc(info.next)}</strong>`
    : `<span style="color:var(--muted)">No account is ready for the next trade.</span>`;
  if (info.openTrade) {
    const q = info.openTrade.quantity != null ? info.openTrade.quantity + "x " : "";
    html += `<span class="open-trade">📈 Trade open: ${esc(info.openTrade.action.toUpperCase())} ${esc(q)}${esc(info.openTrade.symbol)} on ${esc(info.openTrade.accountName)}
      <button class="btn small reset-trade" title="Tell the bot this trade is closed and move to the next account (places no order)">✖ Mark closed / reset</button></span>`;
  }
  html += `<div style="color:var(--muted);font-size:13px;margin-top:4px">Round-trips finished today: ${info.tradesToday}</div>`;
  nextRow.innerHTML = html;

  const resetBtn = $(".reset-trade", nextRow);
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      if (!confirm("Tell the bot this trade is CLOSED and move to the next account?\n\nThis only fixes the bot's memory — it does NOT close any real position on Tradovate. Use it only when the bot thinks a trade is open but there isn't one.")) return;
      doAction(() => api("/reset-trade", { group }));
    });
  }

  const list = $(".account-list", card);
  list.innerHTML = "";
  if (info.accounts.length === 0) {
    list.innerHTML = `<li style="color:var(--muted)">No accounts yet — add one below or use “Scan Tradovate accounts”.</li>`;
  }
  for (const acct of info.accounts) {
    const li = document.createElement("li");
    if (!acct.enabled) li.classList.add("disabled");
    const resting = acct.restingToday;
    if (resting) li.classList.add("resting");
    const isNext = info.next && acct.name === info.next && acct.enabled && !resting;
    if (isNext) li.classList.add("next-up");
    li.innerHTML = `
      <div class="acct-name">
        <span class="nick">${esc(acct.name)}</span>
        ${isNext ? '<span class="next-tag">NEXT</span>' : ""}
        ${resting ? '<span class="rest-tag">😴 WON TODAY</span>' : ""}
        <span class="label">${esc(acct.tradovateLabel)}</span>
        ${balanceLine(acct)}
      </div>
      ${sparkline(acct.history)}
      ${resting ? '<button class="icon-btn" title="Take off rest — let it trade again today" data-act="unrest">▶</button>' : ""}
      ${acct.enabled && !isNext && !resting ? '<button class="icon-btn nextbtn" title="Make this the next account to trade" data-act="next">⏭</button>' : ""}
      <button class="icon-btn" title="Move up" data-act="up">▲</button>
      <button class="icon-btn" title="Move down" data-act="down">▼</button>
      <button class="icon-btn" title="${acct.enabled ? "Turn off (skip this account)" : "Turn on"}" data-act="toggle">${acct.enabled ? "✅" : "🚫"}</button>
      <button class="icon-btn remove" title="Remove" data-act="remove">✕</button>`;
    for (const btn of $$(".icon-btn", li)) btn.addEventListener("click", () => accountAction(btn.dataset.act, acct));
    list.appendChild(li);
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
  if (acct.balance >= target) {
    return `<span class="balance-row">💰 <strong>${money(acct.balance)}</strong> — at the ${money(target)} target 🎯</span>`;
  }
  const toGo = acct.toTarget != null ? acct.toTarget : target - acct.balance;
  return `<span class="balance-row">💰 <strong>${money(acct.balance)}</strong> · ${money(toGo)} to ${money(target)}</span>`;
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
  return doAction(async () => {
    if (act === "remove") {
      if (!confirm(`Remove ${acct.name} (${acct.tradovateLabel}) from the rotation?`)) return;
      await api("/accounts/remove", { label: acct.tradovateLabel });
    } else if (act === "toggle") {
      await api("/accounts/toggle", { label: acct.tradovateLabel });
    } else if (act === "next") {
      await api("/next", { group: acct.group, label: acct.tradovateLabel });
    } else if (act === "unrest") {
      await api("/accounts/unrest", { group: acct.group, label: acct.tradovateLabel });
    } else {
      await api("/accounts/move", { label: acct.tradovateLabel, direction: act });
    }
  });
}

$("#btn-running").addEventListener("click", () => doAction(() => api("/running", { running: !status.running })));

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
      const { labels } = await api("/scan", {});
      showScanModal(labels);
    } finally {
      btn.disabled = false;
      btn.textContent = "Scan Tradovate accounts";
    }
  }),
);

$("#btn-testqty").addEventListener("click", () => {
  if (!status) return;
  showModal(`
    <h2>🔢 Test order size</h2>
    <p>Type a number of contracts and time how long the bot takes to set it on the Tradovate ticket. <strong>No order is placed.</strong></p>
    <p style="color:var(--muted);font-size:13px">The browser must be connected, logged in, and sitting on an account (so the order ticket is showing). Type a different number each time to see a real set.</p>
    <form id="qty-form" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0">
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
      const r = await api("/test-quantity", { quantity: qty });
      const total = Date.now() - t0;
      if (r.set) {
        result.innerHTML = `<strong>Set to ${r.quantity} in ${r.ms}ms</strong> ✅ <span style="color:var(--muted);font-size:13px">(button-to-answer ${total}ms)</span>`;
      } else {
        let html = `<div style="font-size:16px;color:var(--red)">⚠️ ${esc(r.message || "Couldn't set it.")}</div>`;
        if (r.fields && r.fields.length) {
          html += `<p style="font-size:13px;color:var(--muted);margin:10px 0 4px">Boxes the bot can see on the ticket — <strong>screenshot this whole list for Claude</strong> so it can pick the right one:</p>`;
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
          html += `<p style="font-size:13px;color:var(--muted)">The bot couldn't see any input boxes at all — make sure the order ticket is open and showing on the Tradovate screen, then try again.</p>`;
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

for (const btn of $$(".speed-test")) {
  btn.addEventListener("click", () => {
    if (!status) return;
    const group = btn.closest(".group").dataset.group;
    const runTest = (confirmLive) =>
      doAction(async () => {
        btn.disabled = true;
        btn.textContent = "⏱ Testing…";
        const t0 = Date.now();
        try {
          const r = await api("/speedtest", { group, confirmLive });
          const total = Date.now() - t0;
          const leg = (label, ok, ms, msg) =>
            `<p style="font-size:20px;margin:6px 0"><strong>${label}: ${ms}ms</strong> ${ok ? "✅" : `<span style="color:var(--red)">⚠️ ${esc(msg)}</span>`}</p>`;
          showModal(`
            <h2>⏱ Speed test — ${esc(group)}</h2>
            ${leg("Open", r.openOk, r.openMs, r.openMsg)}
            ${leg("Close", r.closeOk, r.closeMs, r.closeMsg)}
            <p>${r.mode === "live" ? "LIVE: includes the real browser clicks in Tradovate." : "Practice: measures everything except the browser clicks (no order placed)."}</p>
            <p style="color:var(--muted);font-size:13px">This is the <strong>bot's</strong> own time. TradingView's own alert delivery adds 1–3s on top and isn't the bot. Button-to-answer total: ${total}ms.</p>
            <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
        } finally {
          btn.disabled = false;
          btn.textContent = "⏱ Speed test";
        }
      });
    if (status.mode === "live") {
      showModal(`
        <h2>⚠️ Speed test in LIVE mode?</h2>
        <div class="warn-box">This places a REAL order on the next ${esc(group)} account and immediately flattens it. It may cost a tick or two of slippage.</div>
        <div class="modal-actions">
          <button class="btn" data-close>Cancel</button>
          <button class="btn danger" id="confirm-speedtest">Yes, run live test</button>
        </div>`);
      $("#confirm-speedtest").addEventListener("click", () => {
        closeModal();
        runTest(true);
      });
    } else {
      runTest(false);
    }
  });
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

for (const btn of $$(".copy-webhook")) {
  btn.addEventListener("click", () => {
    const url = $(".webhook-url", btn.closest(".group")).textContent;
    navigator.clipboard.writeText(url).then(() => {
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = "Copy"), 1500);
    });
  });
}

function showScanModal(labels) {
  if (!labels || labels.length === 0) {
    showModal(`<h2>No accounts found</h2>
      <p>The scan didn't find any LFE… / LFF… accounts. Make sure the browser is connected and logged in, then try again.</p>
      <div class="modal-actions"><button class="btn" data-close>Close</button></div>`);
    return;
  }
  const known = new Set([...status.groups.evals.accounts, ...status.groups.funded.accounts].map((a) => a.tradovateLabel));
  const rows = labels
    .map((label, i) => {
      const suggested = label.startsWith("LFE") ? "evals" : label.startsWith("LFF") ? "funded" : "skip";
      const already = known.has(label);
      return `<li>
        <code>${esc(label)}</code>
        ${already ? '<span style="font-size:12px;color:var(--muted)">(already added)</span>' : ""}
        <label><input type="radio" name="scan-${i}" value="evals" ${suggested === "evals" && !already ? "checked" : ""}/> Evals</label>
        <label><input type="radio" name="scan-${i}" value="funded" ${suggested === "funded" && !already ? "checked" : ""}/> Funded</label>
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
        if (pick && pick.value !== "skip") await api("/accounts/add", { label: labels[i], group: pick.value });
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
