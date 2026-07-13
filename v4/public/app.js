const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
const money = (value) => value == null ? "Not read" : new Intl.NumberFormat("en-US", { style:"currency", currency:"USD", maximumFractionDigits:0 }).format(value);
const age = (value) => { if (!value) return "Never"; const seconds=Math.max(0,Math.round((Date.now()-new Date(value).getTime())/1000)); return seconds<60 ? `${seconds}s ago` : seconds<3600 ? `${Math.floor(seconds/60)}m ago` : `${Math.floor(seconds/3600)}h ago`; };
let data;

async function refresh() {
  const response = await fetch("/api/status", { cache:"no-store" });
  data = await response.json();
  render();
}

function render() {
  document.querySelector("#overall").className = `pill ${data.running ? "good" : "bad"}`;
  document.querySelector("#overall").textContent = `${data.running ? "Running" : "Paused"} · ${data.mode}`;
  const ready = data.connections.filter((connection) => connection.status.loggedIn).length;
  document.querySelector("#summary").innerHTML = `<article><span>Connections</span><strong>${ready}/${data.connections.length} ready</strong></article>${data.pools.map((pool) => `<article><span>${esc(pool.name)}</span><strong>${pool.accounts.filter((account) => account.enabled && account.status === "active").length} active · ${pool.state?.openTrade ? "Trading" : "Flat"}</strong></article>`).join("")}`;
  document.querySelector("#connections").innerHTML = data.connections.map((connection) => `<article class="connection-card"><div class="row"><h3>${esc(connection.name)}</h3><span class="pill ${connection.status.loggedIn ? "good" : "bad"}">${connection.status.loggedIn ? "Ready" : "Login required"}</span></div><p>${esc(connection.firm)} · ${connection.accountCount} account${connection.accountCount===1?"":"s"}</p><dl><dt>Worker</dt><dd>${connection.status.busy ? "Busy" : "Idle"}</dd><dt>Selected</dt><dd>${esc(connection.status.selectedAccount || "—")}</dd></dl>${connection.status.lastError ? `<p class="error">${esc(connection.status.lastError)}</p>` : ""}</article>`).join("") || "<p>No logins configured.</p>";
  document.querySelector("#pool-list").innerHTML = data.pools.map(renderPool).join("") || "<p>No pools configured.</p>";
  document.querySelector("#events").innerHTML = (data.events || []).map((event) => `<div class="event ${esc(event.kind)}"><time>${new Date(event.time).toLocaleTimeString()}</time><span>${esc(event.message)}</span></div>`).join("") || "<p>No activity yet.</p>";
}

function renderPool(pool) {
  const open = pool.state?.openTrade;
  const armStatus = open ? "" : pool.armed
    ? `<p><span class="pill good">Armed</span> The next account and bracket are prepared.</p>`
    : pool.prearmError
      ? `<p class="error"><span class="pill bad">Pre-arm failed</span> ${esc(pool.prearmError)}</p>`
      : `<p><span class="pill">Not armed</span> Click Make next to prepare the account.</p>`;
  return `<article class="pool-panel"><div class="pool-title"><div><h3>${esc(pool.name)}</h3><p>/webhook/${esc(pool.id)} · lane ${esc(pool.executionLane)}${pool.balanceTarget ? ` · auto-close ${money(pool.balanceTarget)}` : " · no balance auto-close"}</p></div><span class="pill ${open?"bad":"good"}">${open ? `${esc(open.action)} ${esc(open.symbol)} · ${esc(open.accountName)}` : "Flat"}</span></div>
  ${armStatus}<div class="table-wrap"><table><thead><tr><th>#</th><th>Account</th><th>Login / firm</th><th>Last-known balance</th><th>Status</th><th>Controls</th></tr></thead><tbody>${pool.accounts.map((account,index) => renderAccountRow(pool, account, index)).join("")}</tbody></table></div>
  <div class="lane-row"><label>Execution lane<input id="lane-${esc(pool.id)}" value="${esc(pool.executionLane)}"></label><button onclick="saveLane('${esc(pool.id)}')">Save lane</button></div></article>`;
}

function renderAccountRow(pool, account, index) {
  const poolOpen = Boolean(pool.state?.openTrade);
  const hasOpenTrade = pool.state?.openTrade?.accountId === account.id;
  const status = hasOpenTrade ? "Trading now"
    : account.isNext && pool.armed && pool.armedAccountId === account.id ? "Armed"
    : account.isNext && pool.prearmError ? "Pre-arm failed"
    : account.skippedToday ? "Skipped today" : account.status;
  const statusClass = hasOpenTrade || (account.isNext && pool.prearmError) ? "bad" : account.status === "active" && !account.skippedToday ? "good" : "";
  const rowClass = [account.isNext ? "next-row" : "", account.skippedToday ? "skipped-row" : ""].filter(Boolean).join(" ");
  const nextDisabled = poolOpen || account.status !== "active" || account.skippedToday;
  const dailyControl = account.status === "active" ? `<button ${poolOpen ? "disabled" : ""} onclick="accountAction('${esc(pool.id)}','${esc(account.id)}','${account.skippedToday ? "resume-today" : "skip-today"}')">${account.skippedToday ? "Resume today" : "Skip today"}</button>` : "";
  const persistentControl = `<button ${hasOpenTrade ? "disabled" : ""} onclick="accountAction('${esc(pool.id)}','${esc(account.id)}','${account.status === "held" ? "activate" : "hold"}')">${account.status === "held" ? "Reactivate" : "Hold"}</button>`;
  const configured = account.targetPerContract > 0 && account.stopPerContract > 0;
  const key = `${pool.id}-${account.id}`;
  const bracketStatus = configured ? `TP +${money(account.targetPerContract)} / SL -${money(account.stopPerContract)} per contract` : `<span class="bracket-warning">Unconfigured — trade blocked</span>`;
  const bracket = `${bracketStatus}<span class="bracket-controls"><label>TP $<input id="tp-${esc(key)}" type="number" min="0" step="0.01" value="${esc(account.targetPerContract)}"></label><label>SL $<input id="sl-${esc(key)}" type="number" min="0" step="0.01" value="${esc(account.stopPerContract)}"></label><button ${hasOpenTrade ? "disabled" : ""} onclick="saveBracket('${esc(pool.id)}','${esc(account.id)}')">Save bracket</button></span>`;
  return `<tr class="${rowClass}"><td>${index+1}</td><td><strong>${account.isNext?"→ NEXT · ":""}${esc(account.name)}</strong><small>${esc(account.platformLabel)} · ${esc(account.stage)}</small><small>${bracket}</small></td><td>${esc(data.connections.find((connection)=>connection.id===account.connectionId)?.name || account.connectionId)}<small>${esc(account.firm)}</small></td><td><strong>${money(account.balance)}</strong><small>${age(account.balanceUpdatedAt)}${account.toTarget!=null ? ` · ${money(account.toTarget)} to target` : ""}</small></td><td><span class="pill ${statusClass}">${esc(status)}</span></td><td><div class="account-actions"><button ${nextDisabled ? "disabled" : ""} onclick="accountAction('${esc(pool.id)}','${esc(account.id)}','next')">Make next</button>${dailyControl}${persistentControl}<button class="danger" ${hasOpenTrade ? "disabled" : ""} onclick="accountAction('${esc(pool.id)}','${esc(account.id)}','remove',true)">Remove from rotation</button></div></td></tr>`;
}

async function accountAction(poolId, accountId, action, confirmFirst=false) { if (confirmFirst && !confirm("Remove this account from this pool?")) return; await post(`/api/pools/${encodeURIComponent(poolId)}/accounts/${encodeURIComponent(accountId)}`, { action }); }
async function saveLane(poolId) { await post(`/api/pools/${encodeURIComponent(poolId)}/lane`, { executionLane:document.getElementById(`lane-${poolId}`).value.trim() }); }
async function saveBracket(poolId, accountId) {
  const key = `${poolId}-${accountId}`;
  const targetPerContract = Number(document.getElementById(`tp-${key}`).value);
  const stopPerContract = Number(document.getElementById(`sl-${key}`).value);
  const response = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/bracket`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ targetPerContract, stopPerContract }) });
  const result = await response.json();
  document.querySelector("#action-result").textContent = result.ok ? `Bracket saved for ${result.account.name}.` : result.error;
  if (result.ok) await refresh();
}
async function post(url, body) { const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}); const result=await response.json(); document.querySelector("#action-result").textContent=result.ok?"Saved.":result.error; await refresh(); }
function summarizeBalanceRefresh(results) {
  const updated = results.reduce((sum, item) => sum + item.refreshed, 0);
  const enabled = data.accounts.filter((account) => account.enabled).length;
  const notUpdated = Math.max(0, enabled - updated);
  const deferred = results.filter((item) => item.deferred).length;
  const errors = results.filter((item) => item.error).map((item) => item.error);
  return `${updated} balances updated; ${notUpdated} not updated.${deferred ? ` ${deferred} login${deferred === 1 ? "" : "s"} deferred because a trade is open.` : ""}${errors.length ? ` ${errors[0]}` : ""}`;
}
document.querySelector("#refresh-balances").addEventListener("click", async () => {
  const button = document.querySelector("#refresh-balances");
  const resultArea = document.querySelector("#action-result");
  button.disabled = true;
  resultArea.textContent = "Refreshing idle logins…";
  try {
    const response = await fetch("/api/balances/refresh", { method:"POST", headers:{"content-type":"application/json"}, body:"{}" });
    const result = await response.json();
    resultArea.textContent = result.ok ? summarizeBalanceRefresh(result.results) : result.error;
    await refresh();
  } catch (error) {
    resultArea.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
window.accountAction=accountAction; window.saveLane=saveLane; window.saveBracket=saveBracket;
refresh().catch((error)=>{ document.querySelector("#overall").textContent="Offline"; document.querySelector("#action-result").textContent=error.message; }); setInterval(refresh,5000);
