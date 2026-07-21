import type { Application, Response } from "express";
import { z } from "zod";
import type { EventKind } from "./events.js";
import { GroupDispatcher } from "./groupDispatch.js";
import type { CredentialLane, LaneKey } from "./lanes.js";
import { AlertSchema, GROUPS, isCloseAlert, isGroup, type Alert, type Group, type SavedLogin } from "./types.js";

const BroadcastAlertSchema = AlertSchema.extend({
  groups: z.array(z.enum(GROUPS)).min(1).default([...GROUPS]),
});

export interface WebhookHandleResult {
  message: string;
  timingMs?: { queueWaitMs: number; executionMs: number; totalMs: number };
  duplicate?: boolean;
}

interface WebhookRouteDependencies {
  webhookSecret: string;
  isRunning(): boolean;
  // Generic key support keeps the old group dispatcher source-compatible while
  // ATLAS dispatches by credential lane.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dispatcher: GroupDispatcher<any>;
  lanes?(): readonly CredentialLane[];
  handleLane?(
    lane: CredentialLane,
    alert: Alert,
    options: { skipFundedWindow: boolean },
  ): Promise<WebhookHandleResult>;
  handleGroup?(group: Group, alert: Alert): Promise<WebhookHandleResult>;
  cancelPendingLane?(lane: CredentialLane): unknown;
  pushEvent(kind: EventKind, message: string, group?: Group): unknown;
  notifyActionNeeded(message: string): unknown;
}

function legacyLanes(): CredentialLane[] {
  const credential: SavedLogin = {
    id: "primary-tradovate",
    name: "Primary Tradovate",
    firm: "Primary prop firm",
    platform: "tradovate",
    sessionDir: ".tradovate-session",
    enabled: true,
    autoConnect: true,
  };
  return GROUPS.map((stage) => ({
    key: `${credential.id}:${stage}`,
    credentialId: credential.id,
    credential,
    stage,
    accounts: [],
    webhookPath: `/webhook/${credential.id}/${stage}`,
    credentialWebhookPath: `/webhook/${credential.id}`,
    globalWebhookPath: `/webhook/${stage}`,
  }));
}

function fundedFirst(lanes: readonly CredentialLane[]): CredentialLane[] {
  return [...lanes].sort((a, b) => {
    const stageOrder = (stage: Group) => stage === "funded" ? 0 : 1;
    return stageOrder(a.stage) - stageOrder(b.stage);
  });
}

export function registerWebhookRoutes(app: Application, deps: WebhookRouteDependencies): void {
  const signalTtlMs = 5 * 60_000;
  const completedOrRunning = new Map<string, { work: Promise<WebhookHandleResult>; expiresAt: number }>();
  const laneEpoch = new Map<LaneKey, number>();
  const activeEntry = new Map<LaneKey, Promise<WebhookHandleResult>>();
  const activeClose = new Map<LaneKey, Promise<WebhookHandleResult>>();
  const lanes = () => deps.lanes?.() ?? legacyLanes();

  const parseAlert = (body: unknown, response: Response, group?: Group): Alert | undefined => {
    const parsed = AlertSchema.safeParse(body);
    if (!parsed.success) {
      deps.pushEvent("warn", "Rejected an alert that did not look right (bad or missing fields).", group);
      response.status(400).json({ ok: false, error: "Invalid alert payload" });
      return undefined;
    }
    if (parsed.data.secret !== deps.webhookSecret) {
      deps.pushEvent("warn", "Rejected an alert with the wrong secret.", group);
      response.status(401).json({ ok: false, error: "Bad secret" });
      return undefined;
    }
    return parsed.data;
  };

  const executeLane = async (
    lane: CredentialLane,
    alert: Alert,
    skipFundedWindow: boolean,
    expectedEpoch: number,
  ): Promise<WebhookHandleResult> => {
    const signalKey = alert.tradeId
      ? `${lane.key}:${alert.tradeId}:${alert.action}:${alert.marketPosition ?? ""}`
      : undefined;
    if (signalKey) {
      const now = Date.now();
      for (const [key, entry] of completedOrRunning) {
        if (entry.expiresAt <= now) completedOrRunning.delete(key);
      }
      const existing = completedOrRunning.get(signalKey);
      if (existing) {
        await existing.work;
        return { message: "Duplicate signal ignored for this lane.", duplicate: true };
      }
    }
    const invoke = () => deps.handleLane
      ? deps.handleLane(lane, alert, { skipFundedWindow })
      : deps.handleGroup
        ? deps.handleGroup(lane.stage, alert)
        : Promise.reject(new Error("No webhook lane handler is configured."));
    let work: Promise<WebhookHandleResult>;
    if (isCloseAlert(alert)) {
      const priorClose = activeClose.get(lane.key) ?? Promise.resolve({ message: "" });
      work = priorClose.catch(() => ({ message: "" })).then(async () => {
        const inFlight = activeEntry.get(lane.key);
        if (inFlight) await inFlight.catch(() => undefined);
        return invoke();
      });
      activeClose.set(lane.key, work);
    } else {
      if ((laneEpoch.get(lane.key) ?? 0) !== expectedEpoch) {
        throw new Error(`Entry for ${lane.key} was cancelled because a newer close signal arrived.`);
      }
      const closing = activeClose.get(lane.key);
      if (closing) await closing.catch(() => undefined);
      if ((laneEpoch.get(lane.key) ?? 0) !== expectedEpoch) {
        throw new Error(`Entry for ${lane.key} was cancelled because a newer close signal arrived.`);
      }
      work = invoke();
      activeEntry.set(lane.key, work);
    }
    if (signalKey) {
      completedOrRunning.set(signalKey, { work, expiresAt: Date.now() + signalTtlMs });
      if (completedOrRunning.size > 5_000) completedOrRunning.delete(completedOrRunning.keys().next().value!);
    }
    try {
      return await work;
    } catch (error) {
      if (signalKey) completedOrRunning.delete(signalKey);
      throw error;
    } finally {
      if (!isCloseAlert(alert) && activeEntry.get(lane.key) === work) activeEntry.delete(lane.key);
      if (isCloseAlert(alert) && activeClose.get(lane.key) === work) activeClose.delete(lane.key);
    }
  };

  const dispatch = async (
    selected: readonly CredentialLane[],
    alert: Alert,
    combined: boolean,
    response: Response,
  ) => {
    const ordered = fundedFirst(selected);
    const byKey = new Map(ordered.map((lane) => [lane.key, lane]));
    const epochs = new Map<LaneKey, number>();
    for (const lane of ordered) {
      if (isCloseAlert(alert)) {
        const next = (laneEpoch.get(lane.key) ?? 0) + 1;
        laneEpoch.set(lane.key, next);
        deps.cancelPendingLane?.(lane);
      }
      epochs.set(lane.key, laneEpoch.get(lane.key) ?? 0);
    }
    const results = await deps.dispatcher.dispatchMany(
      ordered.map((lane) => lane.key),
      (key: LaneKey) => executeLane(
        byKey.get(key)!,
        alert,
        combined && byKey.get(key)!.stage === "evals",
        epochs.get(key)!,
      ),
      { serialize: !isCloseAlert(alert) },
    );
    const bodyResults = results.map((result) => {
      const lane = byKey.get(result.group as LaneKey)!;
      return result.ok
        ? { ok: true, group: lane.key, laneKey: lane.key, credentialId: lane.credentialId, stage: lane.stage, ...result.value }
        : { ok: false, group: lane.key, laneKey: lane.key, credentialId: lane.credentialId, stage: lane.stage, error: result.error };
    });
    for (const result of bodyResults) {
      if (result.ok) continue;
      const message = `Webhook failed for ${result.laneKey}: ${result.error}`;
      deps.pushEvent("error", message, result.stage);
      deps.notifyActionNeeded(message);
    }
    const successes = bodyResults.filter((result) => result.ok).length;
    const status = successes === bodyResults.length ? 200 : successes > 0 ? 207 : 409;
    return response.status(status).json({ ok: successes === bodyResults.length, results: bodyResults });
  };

  app.post("/webhook", async (req, res) => {
    const parsed = BroadcastAlertSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Invalid broadcast alert payload" });
    const { groups, ...alert } = parsed.data;
    if (alert.secret !== deps.webhookSecret) return res.status(401).json({ ok: false, error: "Bad secret" });
    if (!deps.isRunning()) return res.json({ ok: true, message: "ATLAS is paused; alert ignored.", results: [] });
    const selected = lanes().filter((lane) => groups.includes(lane.stage));
    return dispatch(selected, alert, groups.length > 1, res);
  });

  for (const stage of GROUPS) {
    app.post(`/webhook/${stage}`, async (req, res) => {
      const alert = parseAlert(req.body, res, stage);
      if (!alert) return;
      if (!deps.isRunning()) return res.json({ ok: true, message: "ATLAS is paused; alert ignored." });
      return dispatch(lanes().filter((lane) => lane.stage === stage), alert, false, res);
    });
  }

  app.post("/webhook/:credentialId/:stage", async (req, res) => {
    const stage = req.params.stage;
    if (!isGroup(stage)) {
      return res.status(404).json({ ok: false, error: `Unknown stage. Use ${GROUPS.join(", ")}.` });
    }
    const selected = lanes().filter((lane) => lane.credentialId === req.params.credentialId && lane.stage === stage);
    if (selected.length === 0) return res.status(404).json({ ok: false, error: "Unknown credential webhook." });
    const alert = parseAlert(req.body, res, stage);
    if (!alert) return;
    if (!deps.isRunning()) return res.json({ ok: true, message: "ATLAS is paused; alert ignored." });
    return dispatch(selected, alert, false, res);
  });

  app.post("/webhook/:credentialId", async (req, res) => {
    const selected = lanes().filter((lane) => lane.credentialId === req.params.credentialId);
    if (selected.length === 0) return res.status(404).json({ ok: false, error: "Unknown credential webhook." });
    const alert = parseAlert(req.body, res);
    if (!alert) return;
    if (!deps.isRunning()) return res.json({ ok: true, message: "ATLAS is paused; alert ignored." });
    return dispatch(selected, alert, true, res);
  });
}
