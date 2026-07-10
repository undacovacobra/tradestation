import { config } from "./config.js";
import { pushEvent } from "./events.js";
import { log } from "./logger.js";

/**
 * Manages the ngrok tunnel from inside the app, so the dashboard has a
 * "Remote access" on/off button and the user never has to run an ngrok
 * command or keep a second window open.
 *
 * Uses the official @ngrok/ngrok SDK, which runs the tunnel in-process (no
 * separate ngrok.exe needed). It's an OPTIONAL dependency and loaded lazily:
 * if it isn't installed the bot still runs fine and the button just reports
 * that remote access isn't available.
 */

export type TunnelState = "off" | "connecting" | "on" | "error";

export interface TunnelStatus {
  state: TunnelState;
  url: string | null;
  error: string | null;
  /** Whether an authtoken is configured (so the UI can prompt if not). */
  configured: boolean;
}

let state: TunnelState = "off";
let publicUrl: string | null = null;
let lastError: string | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let listener: any = null;
// undefined = not yet tried to load; null = tried and unavailable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ngrokMod: any = undefined;

async function loadNgrok(): Promise<any> {
  if (ngrokMod !== undefined) return ngrokMod;
  try {
    const mod: any = await import("@ngrok/ngrok");
    ngrokMod = mod.default ?? mod;
  } catch {
    ngrokMod = null;
  }
  return ngrokMod;
}

export function tunnelStatus(): TunnelStatus {
  return { state, url: publicUrl, error: lastError, configured: Boolean(config.ngrokAuthtoken) };
}

export async function connectTunnel(): Promise<TunnelStatus> {
  if (state === "on" || state === "connecting") return tunnelStatus();

  if (!config.ngrokAuthtoken) {
    state = "error";
    lastError = "No ngrok token set. Add NGROK_AUTHTOKEN to your .env to enable remote access.";
    return tunnelStatus();
  }

  const ngrok = await loadNgrok();
  if (!ngrok) {
    state = "error";
    lastError = "Remote-access module isn't installed. Run npm install, then try again.";
    return tunnelStatus();
  }

  state = "connecting";
  lastError = null;
  try {
    listener = await ngrok.forward({
      addr: config.port,
      authtoken: config.ngrokAuthtoken,
      domain: config.ngrokDomain || undefined,
    });
    publicUrl = listener.url() ?? (config.ngrokDomain ? `https://${config.ngrokDomain}` : null);
    state = "on";
    pushEvent("info", `Remote access is ON — reachable at ${publicUrl ?? "your ngrok address"}.`);
  } catch (err) {
    state = "error";
    lastError = friendlyTunnelError((err as Error).message);
    listener = null;
    publicUrl = null;
    pushEvent("warn", `Couldn't turn on remote access: ${lastError}`);
  }
  return tunnelStatus();
}

export async function disconnectTunnel(): Promise<TunnelStatus> {
  try {
    await listener?.close();
  } catch (err) {
    log.warn(`Error closing tunnel: ${(err as Error).message}`);
  }
  listener = null;
  publicUrl = null;
  state = "off";
  lastError = null;
  pushEvent("info", "Remote access turned off.");
  return tunnelStatus();
}

/** Best-effort connect at startup; never throws. */
export async function autoStartTunnel(): Promise<void> {
  if (!config.ngrokAutostart || !config.ngrokAuthtoken) return;
  await connectTunnel().catch(() => {});
}

/** Turn ngrok's raw errors into something a non-technical user can act on. */
function friendlyTunnelError(message: string): string {
  if (/already online|ERR_NGROK_334/i.test(message)) {
    return "That web address is already in use by another computer. Turn the bot off on the other computer first, then try again.";
  }
  if (/authentication failed|ERR_NGROK_107|authtoken/i.test(message)) {
    return "ngrok didn't accept the token. Double-check NGROK_AUTHTOKEN in your .env.";
  }
  return message;
}
