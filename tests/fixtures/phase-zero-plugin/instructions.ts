// The verified algorithm now lives in the real plugin. Keep the old probe import
// stable without maintaining a second instruction implementation.
import { instructionBlock as block, type InstructionSnapshot } from "../../../src/instructions/delivery.ts"
export { instructionDelivery, InstructionError, patchTargets } from "../../../src/instructions/delivery.ts"
export function instructionBlock(snapshot: InstructionSnapshot) { return block(snapshot, "WORKSPACE_INSTRUCTION_PROBE") }
export type { InstructionRoot as ProbeRoot, InstructionSource, InstructionSnapshot } from "../../../src/instructions/delivery.ts"
