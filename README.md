# opencode-workspaces

A multi-root workspace plugin for OpenCode V2. The supported package exports the
server, native TUI, and typed RPC from its compiled `dist/` build. The legacy
`.opencode/` implementation remains in the source checkout for compatibility and
rollback only; it is not included in the release archive.

## Start OpenCode

Requires OpenCode V2 `2.0.32` and Bun `1.4.3` or newer. From this checkout:

```powershell
bun install --frozen-lockfile
bun run start
```

The start command builds the package and opens OpenCode in a neutral launcher
folder at `%LOCALAPPDATA%/opencode-workspaces/launcher` on Windows, or
`$XDG_DATA_HOME/opencode-workspaces/launcher` (`~/.local/share` by default) on Unix.
It creates only that launcher's local registration, never rewrites global settings,
never restarts the shared service, and refuses to overwrite unrelated configuration.
Existing providers and authentication stay managed by OpenCode.

Open `/workspace`, create a definition, add your folders, and explicitly open a
workspace session. `/workspace-add` and `/workspace-switch` also have palette
entries. Use a model declaring at least 128k context for instruction-aware requests;
the menus do not require a model.

If Bun is not on PATH after dependencies have been installed:

```powershell
npm exec --yes --package=bun@1.4.3 -- bun run start
```

Set `OPENCODE_BIN` to the native OpenCode executable if it is not on PATH.
`OPENCODE_WORKSPACE_LAUNCHER` can select a different launcher folder. Do not run
plain `opencode` from this repository: that selects the legacy auto-discovered
plugin. Do not register both generations globally or locally in the same Location;
the new package rejects a detected legacy plugin instead of silently combining them.

The default server catalog is
`~/.config/opencode/workspace-manager/workspaces-v2.sqlite`. It is separate from
the legacy JSON and is created when the plugin loads. `options.catalogPath` remains
available for an explicit `.sqlite` override. Existing SQLite catalogs are retained;
foreign databases are rejected. No JSON import or workspace attachment is automatic.

## Workspace behavior

The actual `/workspace` menu can create saved definitions, browse server folders,
add/remove registrations, inspect status, and explicitly open an empty workspace
session without model calls. `/workspace-add` and `/workspace-switch` have direct
handlers and palette entries. Session selections and pinned roots persist in a
transactional SQLite catalog. The agent receives scoped root/nested `AGENTS.md`
and can use native file tools, tests, and Git in the selected independent roots.
The prompt footer shows the displayed session's `[ws:name]`, with compact
ellipsized names in narrow terminals. `[ws:none]` means no selection;
`[ws:unavailable]` means the server could not confirm it, and `!` marks instruction
loading blocked at the last request. Background refresh reads selection metadata,
not repository contents or file counts.

The [revised plan](docs/DEVELOPMENT_PLAN.md#0-implementation-decision-after-capability-research)
chooses conservative first-release behavior:

- Select a workspace **before starting work**. After the first request, switch by
  opening a new session; the existing session's roots never change mid-task.
- Saved-definition edits affect future selections, not existing pinned sessions.
  Before starting work, select the definition again to apply saved root changes.
- Children/forks do not automatically inherit selection. No native session metadata
  is modified, and the experimental metadata journal is not used.
- One catalog per server; no automatic project override or catalog move. Legacy
  JSON import is explicit through the workspace menu. Native glob/grep targeting bound roots redirect the
  agent to the workspace search helpers; unrelated native searches are unchanged.
- Instruction byte limits are 32 KiB/file and 64 KiB total. The initial adapter
  requires a declared context of at least 128k; smaller/unknown budgets are blocked,
  not silently treated as supported. No shell/MCP sandbox or atomic instruction
  freshness across a native permission wait is claimed.

Covered native file paths and shell workdirs are checked by both their supplied
location and resolved filesystem location, including nearest existing parents of
new files. An outside directory link into a selected root is rejected rather
than treated as an unrelated native operation. Use the registered canonical path;
approving an external-directory prompt does not override this policy. Multi-file
patches and both rename endpoints are checked before any mutation. This does not
inspect paths embedded in arbitrary shell commands or unknown third-party tools.

`workspace_glob { pattern, alias?, exclude? }` and
`workspace_grep { pattern, alias?, include?, exclude? }` search the invoking
session's pinned roots, defaulting to all of them. Glob also accepts `alias:/glob`.
Paths are alias-qualified; duplicate relative names remain distinguishable.
The helpers share the legacy canonical-path, nested `.gitignore`, sensitive-path,
link, and bounded UTF-8 reading implementation. Native read permissions apply to
grep input and ignore files; a permission denial or cancellation is not partial success.

Results are deterministic, with fixed per-root shares of 200 file paths or 100
matching lines. Unused shares are not redistributed; narrow by alias to use the
full limit in one root. Each response reports per-root completion/unavailability,
`partial`, `truncated`, and limits. Each root has a 10,000-entry scan budget and
an 8 MiB grep-input budget; individual grep files stay capped at 200 KiB. Grep
uses the existing isolated JavaScript regex worker with a one-second per-file
deadline, not ripgrep syntax. Binary/invalid UTF-8 and oversized grep files are
excluded. Search exclusions do not prohibit an independently authorized native read.

## Build and install

Production compilation and packaging do not run tests:

```powershell
bun run typecheck
bun run build
bun run pack
```

`typecheck` covers production source and release scripts only. `build` emits all
three entrypoints, with OpenTUI/Solid external so the host supplies its UI runtime.
`pack` creates `opencode-workspaces-0.1.0.tgz`; it includes only compiled modules,
maps, a standalone manifest, and this README. SDK dependencies are declared in the
archive. Source, legacy commands/plugins, tests, and build scripts are excluded.

To install the archive elsewhere, extract it into an empty folder and install its
declared dependencies. Adjust paths for your machine:

```powershell
New-Item -ItemType Directory -Force -Path 'C:/tools/opencode-workspaces' | Out-Null
tar -xf './opencode-workspaces-0.1.0.tgz' -C 'C:/tools/opencode-workspaces'
bun install --cwd 'C:/tools/opencode-workspaces/package'
```

Register the extracted package exactly once in a neutral Location's `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "C:/tools/opencode-workspaces/package" }]
}
```

For a checkout installation instead, run `bun run build` and register its `dist`
folder, not the repository root. OpenCode 2.0.32 probes local directories for
root-level `index` and `tui` files rather than following their manifest exports.
`bun run start` handles that registration and repairs its older root registration
in its own neutral folder automatically. It checks the existing service's plugin
inventory after activation and stops with an error if the plugin is unavailable.
Do not add a second
global registration. User-owned global/local legacy files are never removed by
these commands. Disable their registration separately if a conflict is reported.

Opening the menu does not change your launch directory or load registered roots'
plugins. Folder browsing/import are authenticated human administration;
instruction contents are read later with the real session's permissions. There is
no generic content/execute RPC.

The current release build and archive contents have been checked. Post-packaging
runtime acceptance and further test changes are deferred until explicit approval;
the earlier 139-test/runtime results predate these installation changes. No claim
of new runtime acceptance is made by a successful build alone.

Current handoff: [implementation status and next work](docs/PHASE_ZERO_HANDOFF.md).
Historical [capability findings](docs/PHASE_ZERO_FINDINGS.md) explain which original
requirements could not be supported safely and why the scope changed.

## Import a legacy registry

1. Stop every writer of the old JSON registry. Load only the new package in the
  launcher Location, using a separate `.sqlite` catalog as above. Do not point
  `catalogPath` at the JSON, an OpenCode database, or a foreign SQLite file.
2. Open `/workspace`, choose **Import legacy registry**, and enter the server's
  v1 JSON path. Preview and confirm explicitly. Cancel makes no changes. This is
  human administration; registered instruction contents are not read by import.
3. Import creates an exclusively named, timestamped backup beside the JSON,
  syncs and verifies its bytes, then commits definitions and a durable receipt in
  one SQLite transaction. The original JSON is never rewritten. Names, aliases,
  root order, and normalized absolute paths are retained, including missing roots.
4. The former `active` value is only a **Review former active** suggestion. Nothing
  is attached automatically; review and explicitly select it in an empty or new
  session. Existing selections and pinned roots remain unchanged.

Retries of an unchanged canonical source reuse the original receipt and IDs,
including after restart. A changed already-imported source is rejected instead of
silently merged. Existing-name conflicts and malformed/future registries fail
without partial definitions. Unknown lock owners fail closed; investigate ownership
before removing a stale lock. The shared sidecar lock coordinates cooperating v1
writers, not arbitrary external programs, so keep writers stopped during import.

Interrupted or failed attempts may leave backup files; they are never overwritten
or automatically restored. Only the backup path recorded by a successful import
has completed verification. A failed attempt does not imply its backup is complete.

To roll back to the legacy plugin, disable the new package and use the retained
original JSON with the legacy installation. No JSON restore is needed. Keep the
SQLite catalog for later use; development catalog schema 1 is upgraded atomically
to schema 2 for import receipts, and older development builds cannot open schema 2.
Do not load both plugins in one Location. Migration was previously exercised in
the private TUI; fresh packaged-install runtime acceptance awaits approval.

## Legacy read-only plugin

The remainder of this README documents the existing `.opencode/` installation,
not the new `src/` package. It remains a read-only, globally selected virtual
workspace with model-orchestrated menus. Its JSON remains separate from the new
SQLite catalog, even when definitions have been imported.

## Compatibility and UI limits

**This implementation targets OpenCode V2 with `@opencode/plugin@2.0.30`;
the tested CLI/private-service baseline is `2.0.32`.** It default-exports `Plugin.define({id,
setup})`; it no longer imports `@opencode-ai/plugin` or returns V1 hooks. The
original registry format, tool names and security checks are retained, so existing
workspaces need no data migration. V1 runtimes are no longer supported.

- No custom windows, native folder picker, session move, `chdir`, or worktree API.
- `/workspace` uses the existing built-in `question` dialog and its custom-answer
  entry. The agent orchestrates the conversation; this is not a deterministic
  client-side menu handler.
- The native V2 `session.hook("context")` injects fresh workspace instructions
  before each agent model request. It does not modify the prompt composer or
  accumulate old mapping notes. `session.hook("compaction")` preserves the same
  mapping during `/compact`, including a summary supplied by an earlier plugin.
- The small `workspace-manager-notifications` companion uses documented plugin
  RPC events and the existing TUI `ui.toast.show` API. It creates no windows,
  dialogs, slots, folder picker or custom header. It ignores notifications from
  other Locations and unsubscribes on unload. It is packaged for automatic local
  discovery, so no changes to global `cli.json` are needed.
- There is **no custom `[ws:name]` header badge**, native attachment/autocomplete
  indexing, automatic cwd change, or automatic external-directory approval.
- `permission.hook("evaluate")` adds an approval suggestion to an existing
  external-directory prompt only when every canonical path is inside active
  roots. It **never auto-allows or replies to a request**. Traversal checks made
  by this plugin are escalated from allow to ask, never from deny to ask.
- A corrupt/unavailable registry produces an unavailable-state context notice,
  not guessed roots, and does not prevent ordinary generation or compaction.

References: [V2 plugins](https://opencode.ai/v2/docs/build/plugins),
[CLI plugins](https://opencode.ai/v2/docs/build/plugins/cli),
[RPC](https://opencode.ai/v2/docs/build/plugins/rpc),
[permissions](https://opencode.ai/v2/docs/permissions), and
[V1 plugin migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1).

## Files

```text
.opencode/
  package.json
  plugins/workspace-manager.ts    # complete plugin; one default export
  plugins/workspace-manager-notifications/
    package.json                 # discovers the standard ./tui entrypoint
    index.ts                     # no-op server package entrypoint
    rpc.ts                       # notification-only contract; no filesystem RPC
    tui.ts                       # native toast listener, no custom UI
  commands/workspace.md           # complete question/navigation flow
  commands/workspace-add.md       # optional quick entry
  commands/workspace-switch.md    # optional quick entry
  workspace.json                 # optional private project registry, not committed
tests/workspace-manager.test.ts
tests/notifications.test.ts
tests/opencode-smoke.ts           # opt-in check against the real V2 loader
package.json                     # development/typecheck/test scripts
tsconfig.json
bun.lock
README.md
```

The extra tool `workspace_browse {path?: string}` is intentional: none of the nine
specified tools can list arbitrary candidate directories for the question loop.
It lists **directory names only**, asks `external_directory` permission outside
the live project, and never reads file contents or registers folders. The nine
specified tool names and argument fields are otherwise unchanged.

## Install

Use **OpenCode V2.0.32** and Bun on Windows. Bun `1.4.3` is the
development/test runtime. All paths can use `C:/...`; commands below work in
Windows PowerShell 5.1 (no `&&`, bash, WSL, or native dialogs required).

### Run from this folder

```powershell
bun install
bun run bun-typecheck
bun test
opencode --version
```

After upgrading from the earlier V1 implementation, close active work first and
restart the **background service**, then reopen the TUI:

```powershell
opencode service restart
opencode
```

The plugin and commands are discovered automatically under `.opencode/` on a
compatible V2 release. A new terminal or TUI does **not** restart the shared
service. Dependency changes may require `opencode service restart` even when
source changes hot-reload. This can interrupt other clients, so do it after any
active work is saved. No registry needs to be created or edited: the first
mutation creates it.

If Bun is not installed, install it using the official Bun instructions first.
Development can also bootstrap a disposable runtime with
`npm exec --yes --package=bun@1.4.3 -- bun install`, then use the same prefix to run
`bun run bun-typecheck` and `bun test`.

### Install into another existing project

Set these two paths. The copy loop refuses to overwrite existing plugin/command
files. It does not replace an existing `.opencode/package.json` or OpenCode config.

```powershell
$Source = 'C:/development/Repository/workspace-manager'
$Project = 'C:/Users/you/Documents/Default Project'

New-Item -ItemType Directory -Force -Path "$Project/.opencode/plugins" | Out-Null
New-Item -ItemType Directory -Force -Path "$Project/.opencode/commands" | Out-Null
New-Item -ItemType Directory -Force -Path "$Project/.opencode/plugins/workspace-manager-notifications" | Out-Null

$ServerPlugin = Join-Path $Project '.opencode/plugins/workspace-manager.ts'
if (Test-Path -LiteralPath $ServerPlugin) {
  throw "Already exists; review before replacing: $ServerPlugin"
}

$Files = @(
  '.opencode/plugins/workspace-manager-notifications/package.json',
  '.opencode/plugins/workspace-manager-notifications/index.ts',
  '.opencode/plugins/workspace-manager-notifications/rpc.ts',
  '.opencode/plugins/workspace-manager-notifications/tui.ts',
  '.opencode/commands/workspace.md',
  '.opencode/commands/workspace-add.md',
  '.opencode/commands/workspace-switch.md'
)
foreach ($File in $Files) {
  $Destination = Join-Path $Project $File
  if (Test-Path -LiteralPath $Destination) {
    throw "Already exists; review before replacing: $Destination"
  }
  Copy-Item -LiteralPath (Join-Path $Source $File) -Destination $Destination
}

bun build "$Source/.opencode/plugins/workspace-manager.ts" --target bun --external '@opencode/plugin' --external '@opencode/plugin/*' --outfile $ServerPlugin
if ($LASTEXITCODE -ne 0) { throw 'Legacy server plugin bundle failed' }
bun add --cwd "$Project/.opencode" '@opencode/plugin@2.0.30' 'ignore@7.0.12' 'zod@4.1.8'
Set-Location -LiteralPath $Project
opencode
```

The two quick commands reference the project-local `workspace.md`; keep the
command files together. The server entrypoint is bundled with its shared helpers;
copying only its raw source no longer works. For an existing installation,
review/diff updates rather than blindly overwriting local edits.

### V2 permission configuration

Merge this into your existing `opencode.json(c)` or global configuration. Do not
replace unrelated settings. **V2 allows external directories by default**, unlike
V1. Add an explicit `ask` rule if you want the native approval UI before accessing
external roots. Global/system/agent policies still take precedence as documented
by OpenCode; this plugin does not rewrite them.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "workspace_*", "resource": "*", "effect": "allow" },
    { "action": "workspace_escape", "resource": "*", "effect": "ask" },
    { "action": "question", "resource": "*", "effect": "allow" },
    { "action": "external_directory", "resource": "*", "effect": "ask" }
  ]
}
```

The wrappers explicitly call `ctx.permission.assert` for external roots, carrying
the session, agent and native tool source; allowing the custom tool does not
bypass a configured external-directory ask/deny. Choose
`once`, `always` for the suggested root pattern, or reject in OpenCode's permission
UI. Browse requests outside roots are not endorsed by the permission suggestion.

Any path containing a literal `..` component requests the separate
`workspace_escape` permission with an empty `save` list. The scoped evaluation
hook escalates our allow decisions to ask, so `workspace_*: allow` cannot
accidentally remove that check. Denies remain denies. This is
stricter than asking only when normalization actually crosses a boundary. An
alias read escaping its root, or an absolute read outside all active roots, is
**denied even after approval**. Confirmation is not an escape hatch into arbitrary
files. Do not enable automatic client-side approvals if you require an actual
human confirmation; the plugin cannot control how a client answers a pending
permission request.

## Storage and restart behavior

Default registry, on Windows usually under `C:/Users/<you>/`:

```text
~/.config/opencode/workspace-manager/workspaces.json
```

This exact location is used regardless of `XDG_CONFIG_HOME`. Schema:

```json
{
  "$schema": "https://example.com/workspace-manager.json",
  "version": 1,
  "active": "research-xyz",
  "workspaces": {
    "research-xyz": {
      "name": "research-xyz",
      "createdAt": "2026-10-16T00:00:00Z",
      "roots": [
        { "alias": "docs", "path": "C:/data/docs" },
        { "alias": "src", "path": "D:/My data/src" }
      ]
    }
  }
}
```

`$schema` retains the requested placeholder identifier; no schema is hosted at
that example URL. Validation is performed locally by Zod. The Zod 4 record
declaration uses `z.record(z.string(), Workspace)` (the one-argument V3 form is
not valid with the pinned dependency).

- Registry reads are fresh on each call. The active selection is global to all
  instances using this registry, not session-local.
- Mutations use an exclusive lock, validated read/modify/write, fsync, and a
  same-directory atomic rename. No unlink-before-rename or silent corrupt-file
  reset. Multiple processes cannot silently lose each other's changes.
- A lock older than 30 seconds is reaped only if its owning PID no longer exists;
  live locks time out with `REGISTRY_BUSY` after five seconds. If a crashed process
  left a very recent lock, wait 30 seconds and retry. Never delete a live lock.
- A malformed registry fails closed and is not overwritten. Back it up before
  recovery; the plugin deliberately does not guess how to repair user data.
- Missing roots can still be listed and removed by alias. Status/read/search
  report an error instead of silently returning an incomplete result.
- Removing a root/workspace changes registrations only, never files. Removing
  the active workspace sets `active` to `null`.

### Optional project override

If `.opencode/workspace.json` exists **when the plugin starts**, it becomes the
entire registry for that project. It has the same schema and receives all writes;
there is no merge or write-through to the global file. Restart after creating or
removing it. Do not commit private absolute paths.

To opt in with an empty project registry without hand-editing JSON:

```powershell
$Override = '.opencode/workspace.json'
if (Test-Path -LiteralPath $Override) { throw 'Project registry already exists' }
New-Item -ItemType Directory -Force -Path '.opencode' | Out-Null
'{"version":1,"active":null,"workspaces":{}}' | Set-Content -LiteralPath $Override -Encoding UTF8
```

Normal usage needs no JSON editing. For integration tests or a package-configured
V2 plugin, `options.registryPath` selects an isolated registry and takes precedence
over the project override. `options.ripgrep: false` forces the fallback. Do not
load an auto-discovered file a second time just to supply options.

## Tools

V2 tool results use the native `{content: "..."}` result shape, with JSON text in
content. The agent-facing argument schemas are JSON Schema generated from Zod,
and Zod validates arguments again before execution. Expected errors have shape
`{"error":{"code":"...","message":"..."}}`; permission rejections and cancellation
propagate to the host instead of being disguised as successful tool output.

| Tool | Arguments | Result |
| --- | --- | --- |
| `workspace_create` | `{name}` | Creates an empty workspace, activates it; existing names are an error |
| `workspace_switch` | `{name}` | `{active, roots}`; no native directory change |
| `workspace_list` | `{}` | Full validated registry including `active` |
| `workspace_add` | `{workspace, path, alias?}` | `{added, root, roots, workspace, active}` |
| `workspace_remove` | `{workspace, aliasOrPath?}` | Removes one root, or the workspace when omitted |
| `workspace_read` | `{path}` | `{content, truncated}`; UTF-8, at most 204,800 content bytes |
| `workspace_glob` | `{pattern, alias?}` | `{files, truncated}`; newest first, at most 200 alias paths |
| `workspace_grep` | `{pattern, alias?, include?}` | `{matches: [{file,line,text}], truncated, engine}`; at most 100 matching lines |
| `workspace_status` | `{}` | `{active, roots, fileCount}` |
| `workspace_browse` | `{path?}` | `{current,parent,directories,truncated}`; folder metadata only |

Aliases match `[a-z0-9_-]+`. Automatic aliases come from the directory basename;
collisions receive `-2`, `-3`, etc. Same canonical path is a no-op retaining the
existing alias. An explicit alias already assigned to a different path is an
error. Workspace names can contain spaces but not control characters/reserved
object-property names.

Examples:

```text
workspace_read  {"path":"src:/api.ts"}
workspace_read  {"path":"D:/My data/src/api.ts"}
workspace_glob  {"pattern":"**/*.ts","alias":"src"}
workspace_glob  {"pattern":"docs:/**/*.md"}
workspace_grep  {"pattern":"deprecated","alias":"docs","include":"**/*.md"}
```

For single-letter aliases there is a possible drive-name ambiguity: an exact
lowercase registered alias wins (`c:/file`); use uppercase `C:/file` for an
absolute Windows drive path. Glob patterns are relative; use `alias` or an
alias-prefixed pattern, not an absolute drive glob.

## Security and search semantics

- Home expansion supports leading `~`, `$HOME`, and `${HOME}`, not arbitrary
  variable interpolation. Quotes surrounding pasted paths are stripped;
  backslashes become forward slashes. Relative add/browse paths resolve against
  the tool's live session directory, never a changed process cwd.
- Roots are `fs.stat(...).isDirectory()` checked and stored as real, absolute
  paths. Duplicate comparisons are case-insensitive on Windows.
- Windows drive-relative paths, device/extended namespaces, alternate data
  streams, reserved DOS names, control characters and trailing-dot/space path
  components are rejected. Normal absolute drive paths and standard UNC paths
  supported by the filesystem are accepted; UNC may require network credentials.
- `workspace_read` checks lexical **and realpath** containment in an active root.
  Alias suffixes cannot reset the drive/root. Junction/link escapes are denied;
  searches/picker listings do not traverse symlinks or junctions. Retargeted saved
  roots require removal and explicit re-registration.
- Default deny is case-insensitive: `.env`, `*.env`, `.env.*`, `*.pem`, and any
  `.ssh`/`.aws` component. The latter is deliberately stricter than just the home
  copies. Denied names are not returned by glob or passed to ripgrep.
- The built-in file-tool guard blocks obvious sensitive paths and redirects
  built-in reads/searches of active roots to the wrappers. **This plugin is not
  an OS sandbox.** Shell, MCP, other plugins, hard links and malicious concurrent
  filesystem mutation are outside a complete isolation guarantee. Use trusted
  folders and restrictive host permissions; never bypass a denied wrapper call
  using another tool.
- The scanner honors root and nested `.gitignore`, including negations and
  ignored-parent behavior, even outside Git repos. It always skips `.git`.
  It does not read parent/global ignore files outside the allowed roots. A
  `.gitignore` larger than 200 KB fails the scan rather than applying partial
  rules. Direct reads intentionally do not apply `.gitignore` (deny rules still
  apply), so a known ignored file in a root can be read explicitly.
- `fileCount` counts unique, nonignored regular files in the selected roots;
  overlapping roots count once. `.gitignore`, binary and large regular files
  count too, even though grep skips binary/oversized input. Counting and glob
  sorting scan all eligible files; use focused roots rather than whole drives.
  The first root supplies the alias for overlapping files; selecting an alias
  explicitly scopes to that root instead.
- Grep uses Bun's `$` helper imported from `bun`, safely interpolated
  arguments, `rg --no-config`, and batches of already-filtered absolute files.
  No raw shell interpolation, PowerShell quoting, `cd`, or shell-script fallback.
  When `rg` is unavailable/rejects a pattern, it uses bounded filesystem reads
  plus JavaScript `RegExp` in a separate worker with a one-second timeout request.
  Bun can take longer to interrupt a running regex during worker shutdown; the
  server thread stays responsive. Rust/JS regex dialects are not identical;
  prefer their common subset.
  Grep skips files over 200 KB, limits output to 100 matching lines, and clips
  each line to 2,000 characters. The rg `truncated` flag is conservative when the
  limit is reached. UTF-8 is expected; `workspace_read` rejects binary/invalid
  UTF-8 and drops an incomplete final character when truncating. OpenCode's own
  tool-output limits can further truncate results; 200 KB is an upper bound,
  not a promise to override host limits.

## Example dialog transcript

Illustrative conversation, **not a claim of a recorded interactive TUI test**.
Permission dialogs and question options are the real built-in OpenCode widgets;
there is no extra header or custom window.

```text
you> /workspace
agent> workspace_list -> active: null, workspaces: {}
agent> workspace_status -> active: null, roots: [], fileCount: 0
question [workspace]: What to do? Active: (none) (0 roots)
  Switch workspace / Create new / Add folder to current / Remove folder / Show status
you> Create new
question [workspace]: Name the workspace (custom answer).
you> research-xyz
agent> workspace_create {"name":"research-xyz"}
toast> Created "research-xyz" — workspace saved
agent> workspace_status -> research-xyz, 0 roots, 0 files
question [workspace]: Add a folder now?
you> Yes

agent> workspace_browse {} -> current: C:/Users/me/Documents/Default Project
question [workspace]: Where to go? Current: C:/Users/me/Documents/Default Project
  [subdirs...] / [..] up / [✓] Add CURRENT folder / [✎] Paste path manually
you> [✎] Paste path manually
question [workspace]: Paste a directory path (custom answer).
you> C:\data\docs
permission> external_directory C:/data/docs/** ?
you> Allow once
agent> workspace_browse {"path":"C:/data/docs"} -> current: C:/data/docs
question [workspace]: Add C:/data/docs, browse, or cancel?
you> Add
question [workspace]: Alias? Use automatic alias or a custom answer.
you> docs
agent> workspace_add {"workspace":"research-xyz","path":"C:/data/docs","alias":"docs"}
permission> external_directory C:/data/docs/** ?
you> Always allow this root
toast> Added docs -> C:/data/docs — workspace saved
agent> workspace_status -> research-xyz, 1 root
question [workspace]: Add another folder?
you> Yes
you> [✎] Paste path manually
you> D:\My data\src
permission> external_directory D:/My data/src/** ?
you> Always allow this root
agent> workspace_browse {"path":"D:/My data/src"}
question [workspace]: Add D:/My data/src, browse, or cancel?
you> Add
question [workspace]: Alias?
you> src
agent> workspace_add {"workspace":"research-xyz","path":"D:/My data/src","alias":"src"}
toast> Added src -> D:/My data/src — workspace saved
agent> Current virtual workspace [research-xyz]:
         docs:/ -> C:/data/docs
         src:/  -> D:/My data/src

you> /workspace create scratch
agent> workspace_create {"name":"scratch"} -> active: scratch
you> /workspace-switch research-xyz
agent> workspace_switch {"name":"research-xyz"} -> 2 roots
agent> workspace_status -> active: research-xyz, roots: [docs, src], fileCount: ...
you> Compare src:/api.ts with docs:/spec.md; find deprecated APIs.
agent> workspace_read {"path":"src:/api.ts"}
agent> workspace_read {"path":"docs:/spec.md"}
agent> workspace_glob {"pattern":"**/*.ts","alias":"src"}
agent> workspace_grep {"pattern":"deprecated","alias":"docs","include":"**/*.md"}

[restart OpenCode]
you> /workspace status
agent> workspace_list -> 2 saved workspaces, active: research-xyz
agent> workspace_status -> same persisted roots
you> /compact
plugin> compaction context: Active workspace "research-xyz": docs->"C:/data/docs", src->"D:/My data/src".
agent> workspace_status -> current mapping refreshed
you> Read docs:/.env
agent> workspace_read {"path":"docs:/.env"}
tool> {"error":{"code":"DENIED_PATH","message":"Sensitive paths are blocked (...)"}}
```

## Verification

```powershell
bun install --frozen-lockfile
bun run bun-typecheck
bun test
```

The unit suite uses isolated `Temp/opencode/workspace-manager-test-*`
fixtures. It does not modify the real global registry. It exercises the exact
tool shapes, non-Git persistence/reload, project overrides, concurrent writes,
two external folders including spaces, Windows path hardening and junctions,
deny rules, byte limits/UTF-8, ignored files/negation, sorting/count limits, real
ripgrep and fs/regex fallback, regex timeouts, permission rejection, folder
browsing, native V2 registration, context/compaction hooks, permission source and
escalation, notification routing and listener cleanup. The dev-only `@vscode/ripgrep`
dependency supplies the real search binary for tests; users need not install it
for fallback operation. `solid-js` is a development dependency for importing the
published TUI SDK during unit tests; OpenCode provides its own TUI runtime.
The development-only `@xterm/headless` dependency parses real PTY frames for
current-screen assertions; it is not bundled into the plugin or used to mock OpenCode.

For an opt-in integration check against the installed OpenCode service:

```powershell
bun run test:opencode
```

This starts a short-lived `opencode serve` bound only to `127.0.0.1` on an
automatically allocated port, reads the model catalog to activate this Location's
plugins, and checks plugin status through the authenticated `opencode api --server`
CLI. The model catalog read does not generate text or create a Session. Both
workspace plugins must be active and the companion must expose its TUI entrypoint.
Backend setup also forces a real tool-registry replay and verifies all ten names.
The check stops only its own private process tree; it does not restart the shared
service, execute workspace tools, evict shared Locations, or modify system plugins
or the user's global registry. It does not simulate an interactive TUI. On Windows
it supports a binary on PATH or the V2 `@opencode/cli` npm wrapper layout.

### Development capability probes

```powershell
bun run test:capabilities
bun run test:capabilities:tui
# Independent instruction-delivery probe:
bun run test:capabilities:instructions
# UI-only iteration, with the provider completely unavailable:
bun run tests/opencode-tui-capabilities.ts --keep
```

These opt-in checks use a separate package under `tests/fixtures/`, disposable
configuration/storage, two external fixture repositories, a loopback scripted
provider, and a private server. The second also drives an actual Windows TUI
through the authenticated PTY API. `/workspace-probe` is a test-only direct
command; the existing `/workspace` behavior is unchanged. No paid model is used,
and no user registry/global configuration/shared service is modified.
The UI-only runner exercises the same terminal helper without scripted development
requests. Its generated fixture package, not repository source or host internals,
is changed when testing native local-source reloads.

See [results, limitations, artifacts, and remaining gates](docs/PHASE_ZERO_FINDINGS.md).
Lifecycle probes now include native inherited metadata, Effect-native idle waits,
scoped executor interruption, and private-server restart checks.
The separate instruction probe captures fixed-root/nested `AGENTS.md` content in
real scripted requests and checks pre-mutation fingerprints, rename/patch targets,
permissions, and byte overflow. Its mapping is test-only; it does not solve either
binding blocker or validate token budgeting for real small-context models.
In particular, native external reads do not load external `AGENTS.md`, and native
snapshots/undo do not cover external edits. These tests do not establish that the
future workspace instruction or lifecycle adapters are implemented.

### Startup troubleshooting

- In `/plugins`, the server IDs should be `workspace-manager` and
  `workspace-manager.notifications`. The latter provides the packaged toast
  companion; its server setup is intentionally empty.
- `Cannot find package ...` after dependency installation: finish installing
  dependencies, then restart the **service**, not just the terminal. Source hot
  reload does not necessarily refresh dependency-resolution caches.
- `Plugin must export a default definition with an id and an effect or setup
  function`: a V1 plugin is being loaded by V2. Adding `default` to a V1 function
  is not a complete port; tools, permissions and hooks must use the V2 API.
- `C:/ProgramData/opencode/plugin/bay-enforcer.ts` is a separate system plugin.
  This project does not modify, disable or migrate it. Its named V1 export needs
  an independent update by its owner; that failure is not fixed by this port.

Interactive acceptance still needs the V2 TUI:

1. `/workspace`: create -> add two external folders, one containing spaces.
2. Create/select another workspace, then switch back.
3. Read/glob/grep through aliases and grant only intended external-directory
   requests. Confirm `.env` is blocked and a missing directory gives a clean error.
4. Restart OpenCode; `/workspace status` must retain both roots and active name.
5. `/compact`; ask for workspace_status and verify the retained mapping.
