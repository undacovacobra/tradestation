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
  renderEvents();
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
    html += `<span class="open-trade">📈 Trade open: ${esc(info.openTrade.action.toUpperCase())} ${esc(info.openTrade.symbol)} on ${esc(info.openTrade.accountName)}</span>`;
  }
  html += `<div style="color:var(--muted);font-size:13px;margin-top:4px">Round-trips finished today: ${info.tradesToday}</div>`;
  nextRow.innerHTML = html;

  const list = $(".account-list", card);
  list.innerHTML = "";
  if (info.accounts.length === 0) {
    list.innerHTML = `<li style="color:var(--muted)">No accounts yet — add one below or use “Scan Tradovate accounts”.</li>`;
  }
  for (const acct of info.accounts) {
    const li = document.createElement("li");
    if (!acct.enabled) li.classList.add("disabled");
    const isNext = info.next && acct.name === info.next && acct.enabled;
    if (isNext) li.classList.add("next-up");
    li.innerHTML = `
      <div class="acct-name">
        <span class="nick">${esc(acct.name)}</span>
        ${isNext ? '<span class="next-tag">NEXT</span>' : ""}
        <span class="label">${esc(acct.tradovateLabel)}</span>
      </div>
      ${acct.enabled && !isNext ? '<button class="icon-btn nextbtn" title="Make this the next account to trade" data-act="next">⏭</button>' : ""}
      <button class="icon-btn" title="Move up" data-act="up">▲</button>
      <button class="icon-btn" title="Move down" data-act="down">▼</button>
      <button class="icon-btn" title="${acct.enabled ? "Turn off (skip this account)" : "Turn on"}" data-act="toggle">${acct.enabled ? "✅" : "🚫"}</button>
      <button class="icon-btn remove" title="Remove" data-act="remove">✕</button>`;
    for (const btn of $$(".icon-btn", li)) btn.addEventListener("click", () => accountAction(btn.dataset.act, acct));
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
