// Packages the host provides at runtime. Bundles must keep importing them.
export const HOST_EXTERNALS = [
  "@opencode/plugin",
  "@opencode/plugin/*",
  "@opentui/core",
  "@opentui/solid",
  "@opentui/solid/*",
  "solid-js",
  "solid-js/*",
]

// Source files under src/ that become the package's bundle entrypoints.
export const ENTRYPOINTS = ["index.ts", "tui.ts", "rpc.ts"]
