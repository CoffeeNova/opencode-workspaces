# opencode-workspaces

A multi-root workspace plugin for OpenCode V2. Install it once, then use ordinary
`opencode` from your chosen project directory. Sessions stay native until you
explicitly select a workspace through `/workspace`. Opening or cancelling the
menu does not activate multi-folder mode.

The package exports its server, native TUI, and typed RPC from the compiled
`dist/` build. This is an unreleased development package; earlier workspace
implementations, commands, and storage formats are not supported.

## Install and use normally

Requires OpenCode V2 `2.0.32` and Bun `1.4.3` or newer. Build this checkout:

```powershell
bun install --frozen-lockfile
bun run build
```

Merge one plugin registration into your existing OpenCode V2 **global
configuration** for availability in all projects, or into one project's
`opencode.json(c)` for availability only there. Do not replace the rest of your
configuration. Adjust this absolute path to your checkout:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "C:/development/Repository/opencode-workspaces/dist" }
  ]
}
```

Register the absolute **`dist` directory**, not the checkout root. Pinned OpenCode
2.0.32 probes local directories for root-level `index`/`server`, `tui`, and `rpc`
files rather than following the checkout manifest's compiled exports. Register
this package only once: do not duplicate global and project-local entries.

Then start OpenCode normally in any chosen project:

```powershell
Set-Location 'C:\projects\my-app'
opencode
```

No launcher, wrapper, changed execution directory, custom executable, or new
provider authentication is needed. Native launch-project/global instructions,
agents, providers, and permissions still apply, including after workspace
selection. Registering workspace folders does not load their plugins or OpenCode
configuration, and does not erase the launch project's instructions.

Use `/workspace` to manage saved definitions and explicitly select one in an
empty or new session. It is the single management-menu command;
`/workspace-add` and `/workspace-switch` retain their handlers and palette entries.
Menus require no model. Only active instruction-aware workspace requests require
a model declaring at least 128k context.

### Catalog storage

On every platform, the default catalog is stored alongside OpenCode's global
configuration at `~/.config/opencode/workspace-manager/workspaces-v2.sqlite`.
On Windows this is
`%USERPROFILE%\.config\opencode\workspace-manager\workspaces-v2.sqlite`, normally
`C:\Users\<user>\.config\opencode\workspace-manager\workspaces-v2.sqlite`.
The path belongs to the server user and is independent of the project directory.
`LOCALAPPDATA` no longer affects catalog storage.

`options.catalogPath` still accepts an explicit `.sqlite` override and takes
precedence over the default. A temporary `catalogPath` in a project-local config
therefore deliberately stores the database there; omit that option for normal
centralized storage.

The resolved location stays fixed for the plugin lifetime. Older Windows paths
are not searched or retained. No catalog is copied, moved, reset, or merged
automatically.

The catalog contains machine-specific absolute paths and session state, not just
portable preferences. Do not commit it to Git or synchronize its live SQLite/WAL
files between machines.

Startup, passive requests, menu opening, and status reads do not create a missing
catalog, its parent, or binding rows. Creation is deferred to an explicit
administrative write such as creating a definition. Current-format definitions,
bindings, revisions, and change receipts are retained. No attachment is automatic.

Only the current SQLite application ID/storage version 2 is accepted. Version 1,
unknown future versions, JSON registries, and foreign databases are rejected
without conversion, upgrade, or overwrite. There is no legacy import menu/RPC,
sidecar-lock protocol, or old-plugin rollback path. The existing filename,
application ID, storage version, and plugin/RPC IDs are not renamed or reset:
they identify the current format, not a promise of older-version support.
An unused historical import table in an existing current-format database is left
untouched; new catalogs do not create it.

#### Keeping or moving an existing catalog

The default has changed from
`%LOCALAPPDATA%\opencode-workspaces\workspaces-v2.sqlite` on Windows.
Changing the default or changing/removing an explicit override selects another
catalog; it does not transfer definitions or bindings. Before using the new
default, either set `options.catalogPath` to the existing catalog's absolute path
to keep using it, or deliberately transfer that current-format catalog:

1. Stop every OpenCode server using the source or destination catalog. Closing
   only the TUI may leave its server running.
2. Make a SQLite-consistent backup. Use a SQLite-aware backup, or copy only after
   all connections are closed and WAL data has been checkpointed. Never copy
   just the main file while WAL writes may still be pending.
3. Place the backup at the new default path without overwriting another catalog.
   Keep the original as a backup.
4. Remove the old path override, or update it to the destination, then restart
   OpenCode and verify saved definitions and previously bound sessions.

No existing user catalog is moved, copied, converted, or merged by the plugin.

## Workspace behavior

The `/workspace` menu creates and edits saved definitions, browses server folders,
and inspects status without model calls. None of those actions selects a
workspace. Only **Use in this empty session** or **Open in new session** activates
multi-folder mode. From home, Open creates an empty host session, binds it, then
navigates after confirmation; it sends no prompt.

An unbound session receives no workspace system text, root mappings, instruction
reads, native-tool restrictions, extra permission decisions, or footer node.
Workspace helper schemas are removed from its per-request tool map. The helpers
also request Code Mode exclusion (`codemode: false`) and reject direct execution
without that invoking session's persisted binding. The pinned host's internal
Code Mode inventory construction is not available in the local SDK declarations;
complete indirect schema invisibility still needs approved runtime acceptance.

Selections and pinned roots persist in the current SQLite catalog. Previously
bound sessions restore without another slash command; unrelated sessions and
children/forks do not inherit them. Active requests receive scoped root/nested
`AGENTS.md` and retain covered native file preflight, tests/Git workflows, and
bounded multi-root search.

Only an active displayed session contributes `[ws:name]`, with grapheme-safe
clipping and `!` for instruction loading blocked at the last request.
`[ws:unavailable]` is reserved for a previously confirmed active view whose
selection cannot currently be confirmed. Passive views have no label, loading
dots, reserved text node, or recurring selection timer. A bounded metadata lookup
on navigation/reconnect can discover a binding; explicit binding events and menu
changes also refresh it. Active views reconcile periodically with timeout/backoff,
without reading root contents. Leaving or deleting the viewed session cancels
pending work and timers.

The [revised plan](docs/DEVELOPMENT_PLAN.md#0-implementation-decision-after-capability-research)
chooses conservative first-release behavior:

- Select a workspace **before starting work**. Started conversations offer a new
  workspace session; detaching after work starts opens a new ordinary session.
  Neither action reinterprets the original conversation.
- Request/tool/compaction hooks mark admission synchronously before awaiting
  metadata. Attachment checks native history and rechecks admission immediately
  before the SQLite transaction, with no intervening await. A request that starts
  during attachment rejects that attachment; an earlier committed binding is used
  by the request. Passive admission markers are not stored as unbound rows.
- Saved-definition edits affect future selections, not existing pinned sessions.
  Before starting work, select the definition again to apply saved root changes.
- Children/forks do not automatically inherit selection. No native session metadata
  is modified, and the experimental metadata journal is not used.
- One catalog per server; no automatic project override or catalog move. Native
  glob/grep targeting bound roots redirect the agent to the workspace search
  helpers; unrelated native searches are unchanged.
- Instruction byte limits are 32 KiB/file and 64 KiB total. The initial adapter
  requires a declared context of at least 128k; smaller/unknown budgets are blocked,
  not silently treated as supported. No shell/MCP sandbox or atomic instruction
  freshness across a native permission wait is claimed.

Admission tracks at most 10,000 started session IDs per Location/plugin lifetime.
Markers are never evicted to make an unsafe empty-session guess. At capacity,
further attachment is disabled until plugin reload; ordinary native work and
existing active bindings continue. Native history is checked again after reload.
This is a single-server admission boundary, not a distributed lock between
independent servers sharing a catalog.

### Unavailable storage

Missing storage is distinct from unreadable/invalid storage. Workspace menu and
helper failures report actionable errors; no guessed root mapping is used.
A session discovered as active in this server process fails closed if its binding
later cannot be confirmed, and its active indicator enters the unavailable state.
Previously confirmed passive sessions continue natively without repeated reads.

There is a startup ambiguity: if an existing catalog cannot be read before a
session's binding is discovered, the public host API provides no independent
binding authority. This implementation records an **unavailable** resolution and
logs the problem, but leaves undiscovered sessions' native work enabled instead of
blocking every ordinary conversation. It does not claim those sessions are unbound
or guarantee restoration safety for a formerly bound, undiscovered session during
that outage. Restore catalog access and reopen `/workspace` (or revisit/reconnect
the session) before continuing such a conversation. No second binding store or
automatic reset is used to conceal this limitation.

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
The helpers use hardened canonical-path, nested `.gitignore`, sensitive-path,
link, and bounded UTF-8 reading primitives. Native read permissions apply to
grep input and ignore files; a permission denial or cancellation is not partial success.

Results are deterministic, with fixed per-root shares of 200 file paths or 100
matching lines. Unused shares are not redistributed; narrow by alias to use the
full limit in one root. Each response reports per-root completion/unavailability,
`partial`, `truncated`, and limits. Each root has a 10,000-entry scan budget and
an 8 MiB grep-input budget; individual grep files stay capped at 200 KiB. Grep
uses the existing isolated JavaScript regex worker with a one-second per-file
deadline, not ripgrep syntax. Binary/invalid UTF-8 and oversized grep files are
excluded. Search exclusions do not prohibit an independently authorized native read.

## Build and package

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
archive. Source, tests, and build scripts are excluded.

To install the archive elsewhere, extract it into an empty folder and install its
declared dependencies. Adjust paths for your machine:

```powershell
New-Item -ItemType Directory -Force -Path 'C:\tools\opencode-workspaces' | Out-Null
tar -xf '.\opencode-workspaces-0.1.0.tgz' -C 'C:\tools\opencode-workspaces'
bun install --cwd 'C:\tools\opencode-workspaces\package'
```

Register the extracted `package` directory once in your existing global or
project configuration, using the same normal-installation workflow above:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "C:/tools/opencode-workspaces/package" }]
}
```

Opening the menu does not change your launch directory or load registered roots'
plugins. Folder browsing is authenticated human administration; instruction
contents are read later with the real session's permissions. There is no generic
content/execute RPC.

If Bun is not on PATH, the existing pinned npm bootstrap can run the same production
commands, for example `npm exec --yes --package=bun@1.4.3 -- bun run build`.

### Optional isolated development/demo launcher

As an alternative to global registration, `bun run start` builds and opens
OpenCode in `%LOCALAPPDATA%\opencode-workspaces\launcher` on Windows, or
`$XDG_DATA_HOME/opencode-workspaces/launcher` (`~/.local/share` by default) on Unix.
Use it only when the same package is not already registered globally. It creates
only that launcher's local registration and refuses to overwrite unrelated
existing configuration. Only its current `dist` registration is recognized;
older checkout-root entries are not repaired or rewritten.
It checks an existing service's plugin inventory and never restarts the service.
Existing providers/authentication remain managed by OpenCode.

`OPENCODE_BIN` can choose the native executable and `OPENCODE_WORKSPACE_LAUNCHER`
can choose a different launcher folder. This wrapper is optional; the plugin
itself never changes cwd. No launcher files are removed on normal installation.

On 2026-10-19 the user reported that the opt-in plugin behaved as expected in
manual testing, then requested the single menu command, Windows storage default,
and removal of earlier unreleased implementations. After explicit approval,
obsolete legacy tests/harness sections were removed and shared-module cases
preserved independently. Those increments used production-only verification.
The user then approved related automated unit/adapter test updates and execution,
without OpenCode. Current regressions cover the actual catalog, opt-in server
hooks/admission, and deterministic menu handlers with mocked native host APIs.
Automated verification passed: **112 tests, 0 failures, 507 assertions**, plus full
and production-only typechecks. See the handoff for details. No OpenCode, acceptance-harness,
loader smoke, or live capability checks are authorized for this test increment;
automated tests are not fresh runtime acceptance. Earlier 139-test/runtime results
predate these increments.

Current handoff: [implementation status and next work](docs/PHASE_ZERO_HANDOFF.md).
Historical [capability findings](docs/PHASE_ZERO_FINDINGS.md) explain which original
requirements could not be supported safely and why the scope changed.
