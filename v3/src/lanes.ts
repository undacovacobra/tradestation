import type { Group, SavedLogin, StoredAccount } from "./types.js";

export type Stage = Group;
export type LaneKey = `${string}:${Stage}`;

export interface ParsedLaneKey {
  credentialId: string;
  stage: Stage;
}

export interface CredentialLane {
  key: LaneKey;
  credentialId: string;
  credential: SavedLogin;
  stage: Stage;
  accounts: StoredAccount[];
  webhookPath: string;
  credentialWebhookPath: string;
  globalWebhookPath: string;
}

export function laneKey(credentialId: string, stage: Stage): LaneKey {
  return `${credentialId}:${stage}`;
}

export function parseLaneKey(value: string): ParsedLaneKey | undefined {
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const credentialId = value.slice(0, separator);
  const stage = value.slice(separator + 1);
  if (stage !== "evals" && stage !== "funded") return undefined;
  return { credentialId, stage };
}

/**
 * Read-only, derived view of the execution lanes available right now. A lane
 * is never stored independently from its credential, avoiding stale or
 * duplicated ownership metadata.
 */
export class CredentialLaneRegistry {
  private readonly lanes = new Map<LaneKey, CredentialLane>();

  constructor(
    credentials: readonly SavedLogin[],
    accounts: readonly StoredAccount[],
  ) {
    for (const credential of credentials) {
      if (!credential.enabled) continue;
      for (const stage of ["evals", "funded"] as const) {
        const key = laneKey(credential.id, stage);
        this.lanes.set(key, {
          key,
          credentialId: credential.id,
          credential,
          stage,
          accounts: accounts.filter((account) =>
            account.loginId === credential.id
            && account.group === stage
            && account.enabled
            && account.status === "active"),
          webhookPath: `/webhook/${credential.id}/${stage}`,
          credentialWebhookPath: `/webhook/${credential.id}`,
          globalWebhookPath: `/webhook/${stage}`,
        });
      }
    }
  }

  get(key: LaneKey | string): CredentialLane | undefined {
    return this.lanes.get(key as LaneKey);
  }

  keys(): LaneKey[] {
    return [...this.lanes.keys()];
  }

  values(): CredentialLane[] {
    return [...this.lanes.values()];
  }

  forCredential(credentialId: string): CredentialLane[] {
    return this.values().filter((lane) => lane.credentialId === credentialId);
  }

  forStage(stage: Stage): CredentialLane[] {
    return this.values().filter((lane) => lane.stage === stage);
  }
}
