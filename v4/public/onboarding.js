const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
let statusData;
let creatingLogin = false;
const BRACKET_DEFAULTS = {
  eval: { targetPerContract: 1520, stopPerContract: 1000 },
  funded: { targetPerContract: 4000, stopPerContract: 1000 },
};

function stageDefaults(stage) { return BRACKET_DEFAULTS[stage] || BRACKET_DEFAULTS.eval; }

function wireStageDefaults(card) {
  const stage = card.querySelector('[name="stage"]');
  stage.addEventListener("change", () => {
    const target = card.querySelector('[name="targetPerContract"]');
    const stop = card.querySelector('[name="stopPerContract"]');
    const currentTarget = Number(target.value);
    const currentStop = Number(stop.value);
    const recordedTarget = Number(card.dataset.autoTarget);
    const recordedStop = Number(card.dataset.autoStop);
    const next = stageDefaults(stage.value);
    if (currentTarget === recordedTarget && currentStop === recordedStop) {
      target.value = String(next.targetPerContract);
      stop.value = String(next.stopPerContract);
    }
    card.dataset.autoTarget = String(next.targetPerContract);
    card.dataset.autoStop = String(next.stopPerContract);
  });
}

async function loadStatus() {
  const selected = document.querySelector("#connection").value;
  const response = await fetch("/api/status", { cache: "no-store" });
  statusData = await response.json();
  document.querySelector("#connection").innerHTML = statusData.connections.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} · ${esc(c.firm)}</option>`).join("");
  if (statusData.connections.some((connection) => connection.id === selected)) document.querySelector("#connection").value = selected;
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
  document.querySelector("#discovered").innerHTML = body.accounts.map((label) => {
    const account = statusData.accounts.find((item) => item.connectionId === connection.id && item.platformLabel === label);
    return accountForm(connection, label, account);
  }).join("") || "<p>No matching account labels were found. Check the connection's accountPattern.</p>";
  document.querySelectorAll("#discovered .onboard-card").forEach(wireStageDefaults);
  document.querySelector("#missing").innerHTML = body.missing.map((label) => `<article><div class="row"><h3>${esc(label)}</h3><span class="pill bad">Not visible in browser</span></div></article>`).join("") || "<p>No configured accounts are missing.</p>";
});

function accountForm(connection, label, account) {
  const poolChecks = statusData.pools.map((pool) => `<label class="check"><input type="checkbox" name="pool" value="${esc(pool.id)}"${account && pool.accountIds.includes(account.id) ? " checked" : ""}> ${esc(pool.name)}</label>`).join("");
  const id = account?.id || slug(`${connection.firm}-${label}`);
  const stage = account?.stage || "eval";
  const defaults = stageDefaults(stage);
  const targetPerContract = account?.targetPerContract ?? defaults.targetPerContract;
  const stopPerContract = account?.stopPerContract ?? defaults.stopPerContract;
  return `<article class="onboard-card" data-label="${esc(label)}" data-account-id="${esc(account?.id || "")}" data-auto-target="${defaults.targetPerContract}" data-auto-stop="${defaults.stopPerContract}"><div class="row"><h3>${esc(label)}</h3><span class="pill ${account ? "good" : ""}">${account ? "Configured" : "New"}</span></div><div class="onboard-grid">
    <label>Internal id<input name="id" value="${esc(id)}"${account ? " readonly" : ""}></label>
    <label>Friendly name<input name="name" value="${esc(account?.name || label)}"></label>
    <label>Firm<input name="firm" value="${esc(account?.firm || connection.firm)}"></label>
    <label>Stage<select name="stage"><option value="eval"${stage === "eval" ? " selected" : ""}>Evaluation</option><option value="funded"${stage === "funded" ? " selected" : ""}>Funded</option></select></label>
    <label>Take profit / contract ($)<input name="targetPerContract" type="number" min="0" step="0.01" value="${esc(targetPerContract)}"></label>
    <label>Stop loss / contract ($)<input name="stopPerContract" type="number" min="0" step="0.01" value="${esc(stopPerContract)}"></label>
  </div><div class="pool-list"><strong>Rotation pools</strong>${poolChecks || "<p>No rotation pools are configured.</p>"}</div><button type="button" onclick="saveAccount(this)">${account ? "Save changes" : "Save account"}</button><p class="save-result"></p></article>`;
}

async function saveAccount(button) {
  const card = button.closest("article");
  const payload = {
    name: card.querySelector('[name="name"]').value.trim(),
    firm: card.querySelector('[name="firm"]').value.trim(), stage: card.querySelector('[name="stage"]').value,
    poolIds: [...card.querySelectorAll('[name="pool"]:checked')].map((input) => input.value),
    targetPerContract: Number(card.querySelector('[name="targetPerContract"]').value),
    stopPerContract: Number(card.querySelector('[name="stopPerContract"]').value),
  };
  const accountId = card.dataset.accountId;
  if (!accountId) {
    const connection = selectedConnection();
    payload.connectionId = connection.id;
    payload.platformLabel = card.dataset.label;
    payload.id = card.querySelector('[name="id"]').value.trim();
  }
  button.disabled = true;
  const response = await fetch(accountId ? `/api/accounts/${encodeURIComponent(accountId)}` : "/api/accounts/onboard", { method:accountId ? "PATCH" : "POST", headers:{"content-type":"application/json"}, body:JSON.stringify(payload) });
  const body = await response.json();
  button.disabled = false;
  card.querySelector(".save-result").textContent = body.ok ? `Saved${body.pools.length ? ` · rotations: ${body.pools.join(", ")}` : " · not currently in a rotation"}.` : body.error;
  if (body.ok) {
    card.dataset.accountId = body.account.id;
    card.querySelector('[name="id"]').readOnly = true;
    button.textContent = "Save changes";
    await loadStatus();
  }
}
window.saveAccount = saveAccount;
loadStatus().catch((error) => { document.querySelector("#scan-status").textContent = error.message; });

document.querySelector("#test-bracket").addEventListener("click", async () => {
  const connection = selectedConnection();
  const result = document.querySelector("#bracket-result");
  const targetPerContract = Number(document.querySelector("#test-target").value);
  const stopPerContract = Number(document.querySelector("#test-stop").value);
  result.textContent = `Checking ${connection.name} — no trade will be placed…`;
  const response = await fetch(`/api/connections/${encodeURIComponent(connection.id)}/test-bracket`, {
    method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ targetPerContract, stopPerContract }),
  });
  const body = await response.json();
  result.textContent = body.ok ? `Verified: +$${body.targetPerContract} take profit / -$${body.stopPerContract} stop per contract. No trade placed.` : body.error;
});

document.querySelector("#show-add-login").addEventListener("click", () => {
  const panel = document.querySelector("#add-login-panel");
  const button = document.querySelector("#show-add-login");
  const opening = panel.hidden;
  panel.hidden = !opening;
  panel.classList.toggle("is-open", opening);
  button.setAttribute("aria-expanded", String(opening));
  if (opening) requestAnimationFrame(() => {
    document.querySelector("#login-name").focus();
    panel.scrollIntoView({ behavior:"smooth", block:"nearest" });
  });
});
document.querySelector("#save-login").addEventListener("click", async () => {
  if (creatingLogin) return;
  const result = document.querySelector("#login-result");
  const saveButton = document.querySelector("#save-login");
  const name = document.querySelector("#login-name").value.trim();
  const firm = document.querySelector("#login-firm").value.trim();
  if (!name || !firm) { result.textContent = "Login name and firm name are required."; return; }
  creatingLogin = true;
  saveButton.disabled = true;
  result.textContent = "Creating saved browser session…";
  try {
    const response = await fetch("/api/connections", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ name, firm, url:document.querySelector("#login-url").value, accountPattern:document.querySelector("#login-pattern").value.trim(), autoConnect:document.querySelector("#login-auto").checked }) });
    const body = await response.json();
    if (!body.ok) { result.textContent = body.error; return; }
    await loadStatus();
    document.querySelector("#connection").value = body.connection.id;
    result.textContent = "Login created. Next: click Connect login, complete login/MFA, then scan browser.";
  } catch (error) {
    result.textContent = error.message;
  } finally {
    creatingLogin = false;
    saveButton.disabled = false;
  }
});
