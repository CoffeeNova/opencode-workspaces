import { SESSION_LIMITS } from "../../shared/limits.ts"

// Sessions that have started a request can never be attached. Hooks mark a
// session synchronously at entry, so attach either commits first or is refused.
export class SessionAdmission {
  private readonly started = new Set<string>()
  private full = false

  markStarted(sessionID: string): void {
    if (this.started.has(sessionID) || this.full) return
    if (this.started.size < SESSION_LIMITS.admissionMarkers) {
      this.started.add(sessionID)
      return
    }
    this.full = true
    console.warn(
      "[workspace-manager] Session admission capacity reached; further attachment is disabled until plugin reload. Native passive sessions remain unchanged.",
    )
  }

  hasStarted(sessionID: string): boolean {
    return this.started.has(sessionID)
  }

  get saturated(): boolean {
    return this.full
  }

  admits(sessionID: string | undefined): boolean {
    return !!sessionID && !this.full && !this.started.has(sessionID)
  }

  clear(): void {
    this.started.clear()
  }
}
