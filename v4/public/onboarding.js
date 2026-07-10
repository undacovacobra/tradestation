const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
let statusData;

async function loadStatus() {
  const response = await fetch("/api/status", { cache: "no-store" });
  statusData = await response.json();
  document.querySelector("#connection").innerHTML = statusData.connections.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} · ${esc(c.firm)}</option>`).join("");
}

function selectedConnection() { return statusData.connections.find((c) => c.id === document.querySelector("#connection").value); }

document.querySelector("#connect").addEventListener("click", async () => {
  const connection = selectedConnection();
  const response = await fetch(`/api/connections/${encodeURIComponent(connection.id)}/connect`, { method:"POST", headers:{"content-type":"application/json"}, body:"{}" });
  const body = await response.json();
  document.querySelector("#scan-status").textContent = body.ok ? `${connection.name} is connected. Complete login/MFA in its browser if prompted, then scan.` : body.error;
});

document.querySelector("#scan").addEventListener("click", async () => {
  const connection = selectedConnection();
  const message = document.querySelector("#scan-status");
  message.textContent = `Scanning ${connection.name}…`;
  const response = await fetch(`/api/connections/${encodeURIComponent(connection.id)}/accounts`);
  const body = await response.json();
  if (!body.ok) { message.textContent = body.error; return; }
  message.textContent = `Found ${body.accounts.length} account label${body.accounts.length === 1 ? "" : "s"}.`;
  const known = new Set(body.accounts.filter((label) => !body.unknown.includes(label)));
  document.querySelector("#discovered").innerHTML = body.accounts.map((label) => known.has(label)
    ? `<article><div class="row"><h3>${esc(label)}</h3><span class="pill good">Already configured</span></div></article>`
    : accountForm(connection, label)).join("") || "<p>No matching account labels were found. Check the connection's accountPattern.</p>";
  document.querySelector("#missing").innerHTML = body.missing.map((label) => `<article><div class="row"><h3>${esc(label)}</h3><span class="pill bad">Not visible in browser</span></div></article>`).join("") || "<p>No configured accounts are missing.</p>";
});

function accountForm(connection, label) {
  const poolChecks = statusData.pools.map((pool) => `<label class="check"><input type="checkbox" name="pool" value="${esc(pool.id)}"> ${esc(pool.name)}</label>`).join("");
  return `<article class="onboard-card" data-label="${esc(label)}"><div class="row"><h3>${esc(label)}</h3><span class="pill">New</span></div><div class="onboard-grid">
    <label>Internal id<input name="id" value="${esc(slug(`${connection.firm}-${label}`))}"></label>
    <label>Friendly name<input name="name" value="${esc(label)}"></label>
    <label>Firm<input name="firm" value="${esc(connection.firm)}"></label>
    <label>Stage<select name="stage"><option value="eval">Evaluation</option><option value="funded">Funded</option></select></label>
  </div><div class="pool-list"><strong>Rotation pools</strong>${poolChecks || "<p>Create a pool in registry.json first.</p>"}</div><button type="button" onclick="saveAccount(this)">Save account</button><p class="save-result"></p></article>`;
}

async function saveAccount(button) {
  const card = button.closest("article");
  const connection = selectedConnection();
  const payload = {
    connectionId: connection.id, platformLabel: card.dataset.label,
    id: card.querySelector('[name="id"]').value.trim(), name: card.querySelector('[name="name"]').value.trim(),
    firm: card.querySelector('[name="firm"]').value.trim(), stage: card.querySelector('[name="stage"]').value,
    poolIds: [...card.querySelectorAll('[name="pool"]:checked')].map((input) => input.value),
  };
  const response = await fetch("/api/accounts/onboard", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(payload) });
  const body = await response.json();
  card.querySelector(".save-result").textContent = body.ok ? `Saved to registry.json${body.pools.length ? ` and added to: ${body.pools.join(", ")}` : ""}.` : body.error;
  if (body.ok) { button.disabled = true; button.textContent = "Saved"; await loadStatus(); }
}
window.saveAccount = saveAccount;
loadStatus().catch((error) => { document.querySelector("#scan-status").textContent = error.message; });
