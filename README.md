# opencode-workspaces

An OpenCode V2 plugin for working across several project folders in one session.
Each session has its own workspace selection. Sessions without a selection keep
OpenCode's native single-folder behavior.

## Install

Requires OpenCode V2 `2.0.32` and Bun `1.4.3` or newer.

Clone and build the plugin:

```powershell
git clone https://github.com/CoffeeNova/opencode-workspaces.git
Set-Location .\opencode-workspaces
bun install --frozen-lockfile
bun run build
```

Add the plugin to your existing OpenCode configuration. Register it once,
globally for all projects or in a project's `opencode.json` for that project
only. Merge the entry with your other settings.

Replace the example path with the absolute path to this checkout's `dist`
directory:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "C:/development/Repository/opencode-workspaces/dist" }
  ]
}
```

Start OpenCode from your project folder:

```powershell
Set-Location 'C:\projects\my-app'
opencode
```

Open `/workspace` to create a workspace, add folders, and select it in an empty
or new session before the first prompt. Opening the menu alone does not select
a workspace. Workspace requests require a model with at least 128k context.
