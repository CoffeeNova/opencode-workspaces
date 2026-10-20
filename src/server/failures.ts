import { errorCode, isUnavailableCode, WorkspaceError } from "../shared/errors.ts"

// Storage and filesystem outages become a WorkspaceError; any other failure propagates.
export function toWorkspaceFailure(error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error
  const code = errorCode(error)
  if (isUnavailableCode(code))
    return new WorkspaceError(
      code,
      "Workspace path or catalog is unavailable; reopen /workspace after correcting it",
    )
  throw error // Preserve native permission rejection and cancellation.
}
