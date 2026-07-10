const form = document.querySelector("#sender-form");
const result = document.querySelector("#result");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  result.textContent = "Sending safe test…";
  const payload = {
    secret: data.secret,
    signalId: `sender-${Date.now()}`,
    action: data.action,
    symbol: data.symbol,
    quantity: Number(data.quantity),
    marketPosition: data.action === "close" ? "flat" : data.action === "buy" ? "long" : "short",
    test: true,
  };
  try {
    const response = await fetch(`/webhook/${encodeURIComponent(data.pool)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.json();
    result.textContent = JSON.stringify({ httpStatus: response.status, ...body }, null, 2);
  } catch (error) { result.textContent = `Request failed: ${error.message}`; }
});
