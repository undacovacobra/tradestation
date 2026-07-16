import type { Group } from "./types.js";

export type SettledGroupResult<T, Key extends string = Group> =
  | { ok: true; group: Key; value: T }
  | { ok: false; group: Key; error: string };

/** Serialize within a rotation while allowing independent rotations to overlap. */
export class GroupDispatcher<Key extends string = Group> {
  private readonly tails = new Map<Key, Promise<unknown>>();

  enqueue<T>(group: Key, task: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(group) ?? Promise.resolve();
    const result = prior.then(task, task);
    this.tails.set(group, result.catch(() => undefined));
    return result;
  }

  async dispatchMany<T>(
    groups: readonly Key[],
    task: (group: Key) => Promise<T>,
    options: { serialize?: boolean } = {},
  ): Promise<Array<SettledGroupResult<T, Key>>> {
    const unique = [...new Set(groups)];
    const settled = await Promise.allSettled(unique.map((group) =>
      options.serialize === false ? task(group) : this.enqueue(group, () => task(group)),
    ));
    return settled.map((result, index) => result.status === "fulfilled"
      ? { ok: true, group: unique[index]!, value: result.value }
      : {
          ok: false,
          group: unique[index]!,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
  }
}
