import { Plugin } from "@opencode/plugin"

// A discoverable package entrypoint lets V2 load the ./tui companion locally,
// without changing the user's global cli.json or adding any custom UI.
export default Plugin.define({
  id: "workspace-manager.notifications",
  setup() {},
})
