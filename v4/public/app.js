const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const statusClass = (ok) => ok ? "good" : "bad";

async function refresh() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    const data = await response.json();
    document.querySelector("#overall").className = `pill ${data.running ? "good" : "bad"}`;
    document.querySelector("#overall").textContent = `${data.running ? "Running" : "Paused"} · ${data.mode}`;
    document.querySelector("#connections").innerHTML = data.connections.map((c) => `
      <article>
        <div class="row"><h3>${esc(c.name)}</h3><span class="dot ${statusClass(c.status.loggedIn)}"></span></div>
        <p>${esc(c.firm)} · ${esc(c.adapter)}</p>
        <dl><dt>Login</dt><dd>${c.status.loggedIn ? "Healthy" : "Needs attention"}</dd><dt>Worker</dt><dd>${c.status.busy ? "Busy" : "Idle"}</dd><dt>Selected</dt><dd>${esc(c.status.selectedAccount || "—")}</dd></dl>
        ${c.status.lastError ? `<p class="error">${esc(c.status.lastError)}</p>` : ""}
      </article>`).join("") || "<p>No enabled connections.</p>";
    document.querySelector("#pools").innerHTML = data.pools.map((p) => {
      const open = p.state?.openTrade;
      return `<article><div class="row"><h3>${esc(p.name)}</h3><span class="tag">${esc(p.id)}</span></div><p>${p.accounts.length} active account${p.accounts.length === 1 ? "" : "s"}</p><dl><dt>Webhook</dt><dd>/webhook/${esc(p.id)}</dd><dt>State</dt><dd>${open ? "Position recorded" : "Flat"}</dd><dt>Account</dt><dd>${esc(open?.accountName || "—")}</dd><dt>Next</dt><dd>${esc(p.state?.nextAccountId || p.accounts[0]?.id || "—")}</dd></dl><label>Execution lane<input id="lane-${esc(p.id)}" value="${esc(p.executionLane)}"></label><button type="button" onclick="saveLane('${esc(p.id)}')">Save lane</button><p id="lane-result-${esc(p.id)}"></p></article>`;
    }).join("") || "<p>No pools configured.</p>";
  } catch (error) {
    document.querySelector("#overall").className = "pill bad";
    document.querySelector("#overall").textContent = "Offline";
  }
}
async function saveLane(poolId) {
  const input = document.querySelector(`#lane-${CSS.escape(poolId)}`);
  const result = document.querySelector(`#lane-result-${CSS.escape(poolId)}`);
  const response = await fetch(`/api/pools/${encodeURIComponent(poolId)}/lane`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ executionLane: input.value.trim() }) });
  const body = await response.json();
  result.textContent = body.ok ? "Saved. Different lane names may trade together; matching names cannot hold trades at the same time." : body.error;
}
window.saveLane = saveLane;
refresh();
setInterval(refresh, 5000);
