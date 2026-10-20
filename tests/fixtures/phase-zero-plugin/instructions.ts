// The verified algorithm now lives in the real plugin. Keep the old probe import
// stable without maintaining a second instruction implementation.
import { instructionBlock as block, type DeliveredSource, type InstructionSnapshot } from "../../../src/instructions/delivery.ts"
export { instructionDelivery, InstructionError, patchTargets } from "../../../src/instructions/delivery.ts"
export function instructionBlock(snapshot: InstructionSnapshot) { return block(snapshot, "WORKSPACE_INSTRUCTION_PROBE") }
export type { DeliveredSource, InstructionRoot as ProbeRoot, InstructionSource, InstructionSnapshot } from "../../../src/instructions/delivery.ts"
// A provider receives this shape; blocked snapshots omit loaded bodies.
export type DeliveredSnapshot = Omit<InstructionSnapshot, "sources"> & { sources: readonly DeliveredSource[] }
export const sourceContent = (source: DeliveredSource | undefined) => source && "content" in source ? source.content : undefined
