import { WorkspaceError } from "../../shared/errors.ts"
import { SESSION_LIMITS } from "../../shared/limits.ts"
import type { Binding, Workspace } from "../../shared/schemas.ts"
import type { CatalogAccess } from "../catalog/catalog-access.ts"
import { toWorkspaceFailure } from "../failures.ts"
import { pathKey } from "../filesystem/paths.ts"

export type ActiveBinding = Binding & { workspace: Workspace }
export type InactiveResolution =
  { mode: "passive" } | { mode: "unavailable"; error: WorkspaceError }
export type Resolution = InactiveResolution | { mode: "active"; binding: ActiveBinding }

// Resolves each session's pinned binding. Sessions once seen active fail closed;
// inactive results are cached (bounded) so passive requests skip the catalog.
export class BindingResolver {
  private readonly knownActive = new Set<string>()
  private readonly inactive = new Map<string, InactiveResolution>()

  constructor(
    private readonly directory: string,
    private readonly catalogs: CatalogAccess,
  ) {}

  remember(sessionID: string, binding: Binding | null): void {
    if (binding?.workspace) {
      this.rememberActive(sessionID, binding)
      return
    }
    if (this.knownActive.has(sessionID))
      throw new WorkspaceError(
        "BINDING_UNAVAILABLE",
        "This session's active binding cannot be confirmed; restore its catalog before continuing workspace work",
      )
    this.cacheInactive(sessionID, { mode: "passive" })
  }

  async selection(sessionID: string) {
    const current = await this.catalogs.reader()
    const result = current?.selection(sessionID) ?? {
      catalogID: null,
      revision: 0,
      binding: null,
    }
    this.remember(sessionID, result.binding)
    return result
  }

  async resolve(sessionID: string): Promise<Resolution> {
    const cached = this.inactive.get(sessionID)
    if (cached && !this.knownActive.has(sessionID)) return cached
    try {
      const { binding } = await this.selection(sessionID)
      if (!binding?.workspace) return { mode: "passive" }
      return { mode: "active", binding: { ...binding, workspace: binding.workspace } }
    } catch (error) {
      return this.unavailable(sessionID, cached, toWorkspaceFailure(error))
    }
  }

  isKnownActive(sessionID: string): boolean {
    return this.knownActive.has(sessionID)
  }

  forgetActive(sessionID: string): void {
    this.knownActive.delete(sessionID)
  }

  clear(): void {
    this.knownActive.clear()
    this.inactive.clear()
  }

  private rememberActive(sessionID: string, binding: Binding): void {
    this.knownActive.add(sessionID)
    if (pathKey(binding.directory) !== pathKey(this.directory))
      throw new WorkspaceError(
        "LOCATION_MISMATCH",
        "This binding belongs to the session's original Location",
      )
    this.inactive.delete(sessionID)
  }

  // Warns once per distinct problem, then caches the session as unavailable.
  private unavailable(
    sessionID: string,
    cached: InactiveResolution | undefined,
    problem: WorkspaceError,
  ): InactiveResolution {
    if (cached?.mode !== "unavailable" || cached.error.message !== problem.message)
      console.warn(
        `[workspace-manager] Binding resolution unavailable for ${sessionID}: ${problem.message}. Known active sessions fail closed; an undiscovered session retains native behavior, not a confirmed passive binding. Reopen /workspace after restoring catalog access.`,
      )
    const result: InactiveResolution = { mode: "unavailable", error: problem }
    this.cacheInactive(sessionID, result)
    return result
  }

  // Re-inserting moves the session to the newest position; the oldest is evicted.
  private cacheInactive(sessionID: string, value: InactiveResolution): void {
    this.inactive.delete(sessionID)
    this.inactive.set(sessionID, value)
    if (this.inactive.size <= SESSION_LIMITS.inactiveCache) return
    const oldest = this.inactive.keys().next()
    if (!oldest.done) this.inactive.delete(oldest.value)
  }
}
