import type { Selection } from "../../shared/schemas.ts"
import { createInstructionDelivery, type InstructionDelivery } from "./delivery.ts"
import type { InstructionRoot } from "./types.ts"

type InstructionStatus = Selection["instructions"]

// Per-session instruction delivery and the status reported to the footer.
export class SessionInstructions {
  private readonly deliveries = new Map<string, InstructionDelivery>()
  private readonly statuses = new Map<string, InstructionStatus>()

  deliveryFor(sessionID: string): InstructionDelivery | undefined {
    return this.deliveries.get(sessionID)
  }

  // The first active request fixes the session's roots; later calls reuse that delivery.
  ensureDelivery(
    sessionID: string,
    roots: readonly InstructionRoot[],
    authorize: (source: string) => Promise<void>,
  ): InstructionDelivery {
    const existing = this.deliveries.get(sessionID)
    if (existing) return existing
    const delivery = createInstructionDelivery(roots, authorize)
    this.deliveries.set(sessionID, delivery)
    return delivery
  }

  status(sessionID: string): InstructionStatus {
    return this.statuses.get(sessionID) ?? "not-loaded"
  }

  setStatus(sessionID: string, status: InstructionStatus): void {
    this.statuses.set(sessionID, status)
  }

  // Compaction drops the delivered snapshot and its reported status.
  invalidate(sessionID: string): void {
    this.deliveries.get(sessionID)?.invalidate()
    this.statuses.delete(sessionID)
  }

  clear(): void {
    this.deliveries.clear()
    this.statuses.clear()
  }
}
