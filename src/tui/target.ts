import type { Context } from "@opencode/plugin/tui/context"

type Location = NonNullable<Context["location"]>

// The session (or home Location) the menu was opened for.
export type MenuTarget = { sessionID: string | undefined; location: Location }

// Reads the displayed session's own Location; never falls back to the launch Location.
export function currentTarget(context: Context): MenuTarget {
  const route = context.ui.router.current()
  const sessionID = route.type === "session" ? route.sessionID : undefined
  const location = sessionID
    ? context.data.session.get(sessionID)?.location
    : (context.location ?? context.data.location.default())
  if (!location?.directory) throw new Error("Session metadata is loading; reopen Workspace shortly")
  return { sessionID, location }
}

export function isSameTarget(a: MenuTarget, b: MenuTarget): boolean {
  return a.sessionID === b.sessionID && a.location.directory === b.location.directory
}
