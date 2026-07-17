import type { BrokerPosition } from "./brokerPosition.js";
import type { PositionObservation } from "./positionReconciler.js";

/** Take the second explicit-zero reading immediately instead of depending on
 * a later timer/webhook to finish broker-flat reconciliation. */
export async function readWithFlatConfirmation(
  read: () => Promise<BrokerPosition>,
  observe: (position: BrokerPosition) => PositionObservation,
  delayMs = 350,
): Promise<{ position: BrokerPosition; observation: PositionObservation }> {
  let position = await read();
  let observation = observe(position);
  if (observation.kind === "flat-candidate") {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    position = await read();
    observation = observe(position);
  }
  return { position, observation };
}
