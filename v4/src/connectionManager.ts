import type { ConnectionDefinition } from "./models.js";
import { ConnectionWorker, createWorker } from "./workers.js";

export class ConnectionManager {
  private readonly workers = new Map<string, ConnectionWorker>();

  constructor(definitions: ConnectionDefinition[]) {
    for (const definition of definitions) this.add(definition);
  }

  get(id: string): ConnectionWorker | undefined { return this.workers.get(id); }
  values(): ConnectionWorker[] { return [...this.workers.values()]; }

  add(definition: ConnectionDefinition): ConnectionWorker {
    if (this.workers.has(definition.id)) throw new Error(`Connection already active: ${definition.id}`);
    const worker = createWorker(definition);
    this.workers.set(definition.id, worker);
    return worker;
  }

  async remove(id: string): Promise<void> {
    const worker = this.workers.get(id);
    if (!worker) throw new Error(`Unknown connection: ${id}`);
    await worker.disconnect();
    this.workers.delete(id);
  }
}
