/** Normalize the public origin shown for TradingView webhooks. Keeping this
 * separate from tunnel state supports permanent externally-managed domains. */
export function normalizePublicWebhookBase(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) {
    throw new Error("PUBLIC_WEBHOOK_BASE_URL must be an absolute HTTP or HTTPS URL.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_WEBHOOK_BASE_URL must be an absolute HTTP or HTTPS URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PUBLIC_WEBHOOK_BASE_URL must use HTTP or HTTPS.");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("PUBLIC_WEBHOOK_BASE_URL must contain only an origin, with no path, credentials, query, or hash.");
  }
  return url.origin;
}
