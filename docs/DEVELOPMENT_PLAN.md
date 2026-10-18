# Multi-root Workspace Plugin: Development Plan and Contract

Status: revised implementation contract; working first release in development.
Research date: 2026-10-18.
Target: OpenCode V2 terminal UI, Windows-first, with a server-side workspace service.

Implementation tracking: [Phase-zero capability evidence and open gates](PHASE_ZERO_FINDINGS.md).
Phase-zero research is concluded for the reduced first-release scope below.
The original inheritance/metadata gates did not pass and are not being relabelled
as supported. The legacy plugin and registry remain available during development.
**Current implementation phase: Phase 5 — full multi-repository development (in progress).**
The working cross-root edit/test/Git slice and Phase 3 core UI/indicator are verified;
multi-root search adapters are the next implementation task. See the current
[handoff](PHASE_ZERO_HANDOFF.md#current-decision-and-implementation).

## 0. Implementation decision after capability research

On 2026-10-18 the user delegated technical/scope decisions, authorized revising
this plan, and requested working plugin code instead of further test-first probes.
The first release will use the following explicit simplifications. They override
conflicting requirements later in this document; the broader design remains a
future target, not a prerequisite for starting implementation.

- **No native session metadata mirror.** Plugin-owned storage is the sole binding
  authority. The unsafe two-store journal stays experimental and is not promoted.
- **No automatic child/fork inheritance.** New sessions have no plugin binding.
  Select a workspace explicitly before starting work. A fork with copied history
  is not an empty session and cannot be retroactively attached in this release.
- **Seal selection at first request.** Binding/root changes are allowed only before
  the first model request and only in an empty session. Context capture seals even
  an unbound session atomically in plugin storage. Switch/detach after work starts
  offers an explicitly created new session; it does not retarget the running one.
  This avoids depending on an atomic host idle-check-and-update API.
- **Pinned root snapshots.** A binding contains the selected definition's name,
  revision, and roots. Editing/deleting a saved definition does not change existing
  sessions. Apply saved changes before work starts or open a new session. Instruction
  file contents still refresh; it is the root mapping, not source text, that is pinned.
- **One catalog per server for the first release.** Project-specific catalog overrides
  and automatic catalog moves are deferred. A bound session moved to another Location
  is rejected rather than silently rebased.
- **Single-store SQLite catalog.** Use Bun's supported SQLite API for transactional
  definitions, bindings, request receipts, and sealing. The initial development package
  requires an explicit new `.sqlite` catalog path. It does not touch the v1 JSON file;
  import/backup and a default installation path follow the working vertical slice.
- **Honest instruction enforcement.** Reuse the verified scoped-delivery algorithm
  in production modules, with bounded source reads and native-tool preflight. No
  promise of atomic filesystem snapshots, changes during a native permission wait,
  or sandboxing arbitrary shell/MCP calls. Byte caps are not tokenizer guarantees;
  initially require the verified large-context baseline and report unsupported budgets.

Alternatives considered: waiting for upstream APIs preserves the original contract
but delays a usable plugin; parent-current lookup and cooperative metadata writes
produce incorrect inheritance or lost updates; merely disabling busy UI controls
does not provide safety. The pinned-snapshot/sealed-session release retains the main
product goal without those dependencies. Do not claim the full original contract is
complete, and do not silently reintroduce unsafe live switching.

Implementation order is now **working vertical slice first**: real package, catalog,
native menus, explicit binding, scoped context, and cross-root native edits. Reuse
existing regression coverage and check the actual package in one isolated runtime
after implementation. Add focused regression cases for real defects, not another
large throwaway capability suite. The footer indicator is implemented and checked in
the real TUI. Multi-root search adapters are the current Phase 5 task; safe v1 import,
default installation path, and package/install polish remain Phase 6 work. If the core
workflow cannot run safely on public APIs, stop and report that development should
be held.

The working indicator uses the pinned host UI combination: OpenTUI `0.5.17` and
Solid `1.9.15` on CLI `2.0.32`. Its small text contribution uses the documented
automatic JSX runtime, with UI/Solid imports external to development bundles so
the host supplies the runtime instances. The published OpenTUI Solid peer declares
`1.9.12`, while this OpenCode host pins `1.9.15`; Bun's peer warning is known, not a
reason to bundle or downgrade the host's Solid runtime.

### Reading map

- [Product requirements](#1-purpose-and-confirmed-decisions) and [scope](#4-scope-and-non-goals)
- [Host capability checks](#5-verified-opencode-api-surface-and-capability-gates)
- [Architecture](#6-architecture), [storage](#7-data-model-persistence-and-migration), and [session isolation](#8-session-isolation-and-lifecycle)
- [UI behavior](#9-tui-interaction-contract)
- [Agent context and instructions](#10-agent-context-and-agentsmd)
- [Full development](#11-full-development-across-independent-roots) and [security](#13-security-and-failure-behavior)
- [Implementation phases](#14-implementation-sequence-and-exit-criteria) and [acceptance tests](#15-verification-matrix)
- [Definition of done](#16-definition-of-done-and-non-negotiable-review-rules) and [sources](#17-sources-and-research-boundaries)

## 1. Purpose and confirmed decisions

Build an actual OpenCode extension for working on several local repositories or
ordinary folders in one agent session, similar in purpose to a VS Code multi-root
workspace with Copilot.

The user confirmed:

- Workspaces support **full development**, not just read-only reference material:
  discovery, reading, editing, tests, command execution, and repository-specific Git.
- The agent knows **all registered roots** and receives additional system context.
- Applicable `AGENTS.md` instructions from those roots must be discovered and used.
- Saved workspace definitions are shared; **the active selection belongs to a
  session**, not to a global variable.
- Menus and workspace administration are deterministic plugin code. They must not
  depend on an AI model interpreting a Markdown command or calling `question`.

This document supersedes the original prompt where it conflicts with these goals.
It authorizes no implementation or live configuration changes by itself.

### 1.1 Product acceptance sentence

> With the model unavailable, I can open `/workspace`, create a named workspace,
> add folders, and attach it to a session. When I subsequently ask the agent to
> change code across those folders, it has the correct root mapping and scoped
> instructions, can edit both repositories and run their tests, and does not
> change the workspace selected in another session.

### 1.2 Terminology

| Term | Meaning |
| --- | --- |
| Workspace definition | A durable named collection of canonical folder roots |
| Root | A registered folder, with an unambiguous alias; Git is optional |
| Binding | A session's selection of a workspace definition |
| Location | OpenCode's native project/directory context; not this plugin's workspace |
| Execution directory | Explicit per-command working directory in one root |
| Instruction scope | A root or descendant directory governed by an `AGENTS.md` |
| Workspace revision | A version of the definition used to detect stale operations |

## 2. Why the original implementation missed the product goal

The old prompt explicitly prohibited custom TUI, required the built-in `question`
tool, and specified `.opencode/commands/workspace.md` with `agent: build`.
That describes an agent-orchestrated conversation, even when its mockup looks
like a menu.

Current repository evidence:

| Location | Current behavior | Required change |
| --- | --- | --- |
| `.opencode/commands/workspace.md:6` | Instructs the model to orchestrate tools and questions | Replace with a TUI command handler |
| `.opencode/plugins/workspace-manager-notifications/tui.ts:6` | Subscribes to toasts only | Build the actual management UI |
| `.opencode/plugins/workspace-manager-notifications/rpc.ts:7` | No RPC methods | Add a typed workspace service contract |
| `.opencode/plugins/workspace-manager.ts:37` | Registry has one global `active` value | Persist session bindings separately from definitions |
| `.opencode/plugins/workspace-manager.ts:674` | Derives tool context from one live session directory | Resolve workspace by the invoking session ID |
| `.opencode/plugins/workspace-manager.ts:789` | Implements storage and read/search wrappers | Extract reusable services and support native editing |
| `.opencode/plugins/workspace-manager.ts:977` | Redirects built-in reads/searches to wrappers | Remove this restriction once native integration passes tests |
| `.opencode/plugins/workspace-manager.ts:1006` | Injects a globally selected mapping | Inject a fresh session-specific workspace snapshot |
| `tests/notifications.test.ts:5` | Tests a notification-only companion | Replace that product assumption with deterministic UI tests |

These line references describe the research baseline and may move during refactoring.

The registry, atomic writes, path validation, ignore handling, and search tests
are reusable assets. A rewrite must not casually discard their guarantees.

## 3. Lessons from VS Code and Copilot

### 3.1 Verified behavior to borrow

Official VS Code documentation describes:

1. Multiple independent folders in a workspace, even outside one parent folder.
2. Folder names to disambiguate paths and search results.
3. Search across roots, with the ability to narrow to one root.
4. Separate repository identities and source-control state.
5. Workspace awareness through structure, instructions, search, and selective
   reads; not by copying every repository file into a system prompt.
6. Root project instructions and targeted instructions for narrower areas.
7. Instruction diagnostics: discovering a file is not proof that its content
   was included in a model request or followed by the model.

Do not claim exact behavioral parity with every Copilot harness. Current VS Code
documentation distinguishes Copilot, Local, Claude, and Codex harnesses. Nested
`AGENTS.md` behavior is harness-dependent; the Local harness's nested discovery
setting is experimental and disabled by default.

### 3.2 Deliberate differences

- Use the existing named registry, not a mandatory `.code-workspace` format.
- Bind the selected workspace to an OpenCode session rather than an editor window.
- Implement a terminal directory browser, not a native operating-system picker.
- Ship lexical search first. Semantic indexing is a separate future project.
- Define and test our instruction-scoping contract explicitly, rather than
  asserting that all VS Code agents use the same ordering rules.

## 4. Scope and non-goals

### 4.1 Required for the first complete release

- Native TUI entry points: `/workspace`, `/workspace-add`, `/workspace-switch`.
- Palette entries for those same handlers, without imposed global shortcuts.
- Create, select, detach, and delete workspace definitions.
- Add/remove folders, including non-Git folders and paths containing spaces.
- A compact active-workspace indicator in a supported UI slot.
- Persistent session selection and independent selections in concurrent sessions.
- Root mapping plus applicable instructions in agent context.
- Cross-root search, native file edits, and explicit-root shell/Git workflows.
- Safe migration from the existing registry and a tested installation path.
- Observable failures and clear permission handling.

### 4.2 Not promised by this release

- Merging repositories, branches, indexes, or histories into one Git repository.
- Changing process cwd, moving sessions automatically, or creating worktrees.
- A replacement editor, Explorer, Source Control view, or VS Code compatibility layer.
- Automatic multi-root LSP/formatter configuration or native attachment indexing.
- Loading each root's OpenCode plugins, MCP servers, providers, agents, or arbitrary
  `.opencode` configuration. Registering a folder must not execute its plugins.
- An OS sandbox, complete shell-path analysis, or cross-repository undo.
- Automatic delegation to multiple agents.
- Remote clone/provisioning or semantic indexing.

Native OpenCode snapshots, review diffs, formatting, and LSP remain host features.
Verify their behavior with external edits; do not advertise workspace-wide support
unless it has actually been demonstrated.

## 5. Verified OpenCode API surface and capability gates

At research time, the installed CLI reports `2.0.32`. This repository pins
`@opencode/plugin` to `2.0.30`. The published `2.0.30` TUI types already expose
dialogs, commands, slots, routes, and session panels.

| Capability | Public API / mechanism | Use |
| --- | --- | --- |
| Server extension | `Plugin.define` from `@opencode/plugin` or `@opencode/plugin/effect` | Storage, context, tools, RPC; Effect-native cancellation for lifecycle waits |
| Terminal extension | `Plugin.define` from `@opencode/plugin/tui` | UI and client-side state |
| Direct commands | `context.keymap.layer`, command `run`, `slash`, `palette` | No model involvement |
| Built-in dialogs | `ui.dialog.select/prompt/confirm/alert` | Initial management UI |
| Custom UI if needed | `ui.dialog.show`, JSX, OpenTUI/Solid | Only for demonstrated UX needs |
| Visible indicator | `ui.slot`, e.g. `prompt.footer.status` | Session-aware badge |
| Typed backend calls | `Rpc.define`, `ctx.rpc.register`, `context.client.rpc` | UI-to-server operations |
| Request context | `session.hook("context")` | Fresh per-session system block |
| Compaction context | `session.hook("compaction")` | Preserve/rebuild workspace awareness |
| File-tool integration | `tool.hook("execute.before/after")` | Known-schema preflight and diagnostics |
| Permissions | `permission.assert`, native file/shell tools | Preserve host approvals and denials |
| Native external development | Absolute file paths; `shell.workdir` | Edits and commands in any root |

Use the connected `context.client`; never construct an unauthenticated local
HTTP connection or bypass the user's selected server.

### 5.1 Phase-zero capability checks

Before implementing the full design, verify on the pinned target release:

1. A packaged server plugin and its `./tui` export load together exactly once.
2. A slash handler opens a dialog without a session prompt or model request.
3. RPC calls specify the intended Location and validate the target session.
4. Native tools can read, edit, patch, and run shell commands in two external roots.
5. How native `AGENTS.md` discovery behaves for reads outside the native Location.
6. Hook ordering, failure propagation, and instruction visibility before mutations.
7. Public session parent/fork metadata and lifecycle events available for inheritance.
8. Native busy-state/safe-boundary semantics and concurrent tool-call behavior.
9. Formatting, review/snapshot, and revert behavior for external changes.

Record results with exact versions and reproduction fixtures. Do not turn an
unverified assumption into an invented API, silently fall back to AI menus, or
claim that a core limitation has been solved by prompt text.

If a gate cannot be satisfied, document the exact limitation and revise the
contract before implementing the affected feature. A prototype is not a release.

## 6. Architecture

```text
Terminal plugin                         Server plugin
---------------                         -------------
slash / palette handlers -- typed RPC -> WorkspaceService
dialogs + folder browser                RegistryStore + SessionBindings
session-aware indicator <- RPC events - revisioned snapshots
                                        PathPolicy + PermissionAdapter
                                        InstructionResolver + ContextBuilder
                                        native-tool integration / search tools

User's development request -> OpenCode agent -> native tools + workspace helpers
```

### 6.1 Separation of responsibilities

- **Domain:** validated workspace definitions, bindings, revisions, path ownership.
- **Storage:** locking, atomic replacement, backups, migration, corruption reporting.
- **Workspace service:** all operations shared by RPC and compatibility tools.
- **Instruction service:** discovery, scope resolution, freshness, delivery state.
- **Host adapters:** session lookup, permissions, hooks, tools, event lifecycle.
- **TUI:** presentation and navigation only; never a second registry implementation.

RPC handlers must call the service, not fabricate tool messages, invoke an agent,
or call a registered tool executor with a fake message/tool ID.

All filesystem discovery happens on the **server's filesystem**. The TUI must not
use local `node:fs` to enumerate a potentially remote server's directories. Path
normalization and platform semantics belong to the server, not `process.platform`
in the terminal client.

### 6.2 Proposed package layout

```text
package.json                 # exports: ., ./tui, ./rpc
src/
  index.ts                   # server Plugin.define
  tui.tsx                    # terminal Plugin.define
  rpc.ts                     # shared schemas; no filesystem side effects
  domain/
    schema.ts
    workspace-service.ts
    session-bindings.ts
  infrastructure/
    registry-store.ts
    path-policy.ts
    folder-browser.ts
  instructions/
    resolver.ts
    context-builder.ts
  server/
    permissions.ts
    hooks.ts
    tools.ts
  tui/
    commands.ts
    controller.ts
    dialogs.ts
    indicator.ts
tests/
  ...                        # domain, integration, and real TUI acceptance
docs/
  DEVELOPMENT_PLAN.md
README.md
```

This is one plugin package, not two loosely connected notification plugins.
Keep helper modules outside auto-discovered plugin entrypoint directories.
OpenTUI and Solid peers are needed when rendering JSX; pin a tested compatible
SDK/runtime combination rather than copying version ranges from old examples.

## 7. Data model, persistence, and migration

### 7.1 Logical schema

Use a version-2 registry containing definitions and session bindings. The
following is a logical example, not an already implemented schema:

```json
{
  "version": 2,
  "revision": 7,
  "workspaces": {
    "workspace-uuid": {
      "id": "workspace-uuid",
      "name": "research-xyz",
      "revision": 3,
      "createdAt": "2026-10-18T00:00:00Z",
      "updatedAt": "2026-10-18T00:10:00Z",
      "roots": [
        { "alias": "src", "path": "D:/proj/src" },
        { "alias": "docs", "path": "C:/data/docs" }
      ]
    }
  },
  "sessionBindings": {
    "ses_example": {
      "workspaceID": "workspace-uuid"
    }
  }
}
```

- Workspace IDs are stable; names are display labels and remain unique.
- Aliases remain unique inside a definition and match `[a-z0-9_-]+`.
- Canonical duplicate roots remain a no-op. Retain the existing 20-root limit.
- Root order is stable; no implicit execution root is inferred from array order.
- There is **no authoritative global `active` field**.
- Status is computed using the invoking session, never the last TUI that switched.
- Definitions are shared: editing their roots affects all bound sessions. The UI
  must explain this; it is different from changing one session's selection.
- Removing a definition clears its bindings atomically and never removes folders.
- In-flight request snapshots and instruction fingerprints are runtime state, not
  trusted facts restored from a previous process.

Keep the existing default global registry location for compatibility. Preserve the
optional project registry override as a separate catalog, with no implicit merge.
A session must have one authoritative catalog owner; do not attach it to both.
Include catalog identity in caches/events. If a session moves to a Location using
a different catalog, report the mismatch rather than silently importing bindings.

### 7.2 Version-1 migration

1. Read and fully validate v1 without mutation.
2. Take a timestamped backup using exclusive creation; never overwrite a backup.
3. Generate and persist IDs for the existing definitions; preserve aliases and paths.
4. Convert under the existing exclusive lock and atomic-write discipline.
5. Do **not** assign the old global `active` selection to every session.
6. Offer the former active workspace as a migration suggestion in the UI. Bind it
   only after the user selects it for a particular session.
7. Make migration idempotent and resilient to interruption at every write step.

Reject unknown future versions and malformed data without overwriting anything.
Rolling back the plugin requires the documented backup procedure; do not run v1
and v2 writers against one registry concurrently.

Preserve fsync/atomic replacement, lock ownership checks, stale-lock handling,
canonical storage paths, cancellation, and clean expected errors. Session-binding
growth needs a bounded maintenance policy; never silently prune live sessions to
fit the old 4 MB registry limit. Start with explicit maintenance and a clear size
error, then split storage only through a versioned migration if necessary.

## 8. Session isolation and lifecycle

### 8.1 Resolution

Every context hook, tool, and session-targeted RPC resolves:

```text
session ID -> validated session -> catalog -> binding -> workspace revision
```

Never use a module-level `activeWorkspace`, current tab, native Location alone,
or the terminal's most recently viewed session to resolve an agent operation.

- Session A selecting workspace X does not change session B's selection of Y.
- Restarting the service restores bindings from storage.
- Detaching a workspace removes the binding, not the definition or files.
- With no binding, preserve ordinary OpenCode behavior.
- Two terminals viewing the same session see the same binding.

### 8.2 Children and forks

Desired contract: a child/fork inherits the parent's selection at creation,
then has an independent binding. Later parent switches do not retarget the child.
Implement this only using verified public parent/fork metadata and event ordering.
Do not infer ancestry from titles, matching directories, or temporal proximity.
The phase-zero check must resolve the first-request race; looking up the parent's
current selection long after child creation is not snapshot inheritance.

### 8.3 Running operations

- Read-only management/status may remain available while an agent is working.
- Binding changes require an idle/safe session boundary.
- Definition edits/removal must account for every bound running session, not
  just the session whose menu initiated the operation.
- Commands and dialogs show a clear busy state; backend enforcement is mandatory.
- Use request snapshots, revisions, and operation leases/serialization to reject
  stale operations. A disabled button alone does not solve a race.
- Revalidate before side effects. Never change alias meaning in the middle of a
  multi-file patch or silently replay an operation against a newer definition.

If the public API cannot provide an atomic host boundary, document and test the
conservative protocol used to detect and reject races before claiming this gate.

## 9. TUI interaction contract

### 9.1 Command behavior

| Entry | Handler |
| --- | --- |
| `/workspace` | Open the management menu |
| `/workspace-add` | Open Add Folder for the current binding, or select/create first |
| `/workspace-switch` | Select a saved workspace for the current session |
| Palette equivalents | Call the exact same controllers |

Do not register conflicting Markdown commands with the same names. Do not impose
global keybindings; expose stable command IDs that users can bind themselves.

Administrative handlers must not call `session.prompt`, `session.command`,
`session.generate`, `generate.text`, `question`, or synthetic chat messages.
Registry mutations and feedback are RPC plus UI, not conversation turns.

### 9.2 Main menu

Preserve the user's menu intent while using genuine OpenCode dialogs:

```text
Workspace                         Active in this session: research-xyz

  Switch workspace
  Create new
  Add folder to current
  Remove folder
  Show status
```

Deletion of a whole workspace and detachment are secondary, clearly named actions.
Display the current name and root count without an unsolicited chat transcript.
Prefer built-in dialog widgets first; implement custom JSX only when the native
widgets cannot meet a tested interaction requirement.

### 9.3 Create and switch

- Name entry is a normal text prompt widget, not a model's custom-answer question.
- Validate duplicate/invalid names inline or with a concise error dialog.
- Creating a definition does not overwrite an existing one.
- In a session, creation can attach the new definition after the same explicit
  user action; offer Add Folder next without an endless wizard.
- Switching lists real saved names and root counts; labels are never identifiers.
- Cancel does not change selection or create partial definitions.

On the home screen, opening a menu must not create a session. Catalog management
can operate without a binding. Attaching from home uses an explicit **Open in new
session** action: create an empty session with a supplied title, bind it, and
navigate to it without sending a prompt. Never invent a sentinel session ID.

### 9.4 Folder browser

```text
Add folder to research-xyz
Current path: C:/data

  docs/                         directory
  examples/                     directory
  ..                            parent

  Add current folder
  Paste path manually
  Cancel
```

- A directory list contains children of **one** current directory, not unrelated
  paths from different drives presented as if they were its children.
- Parent navigation uses the canonical parent returned by the server.
- Switching drives is supported through manual path input; a drive list is an
  optional later improvement, not fabricated filesystem information.
- Pasting `C:\My data\specs`, `C:/...`, `~`, or `$HOME` works as documented.
- Browse does not register anything. Add requires an explicit action, followed
  by alias choice with an automatic-name default.
- Duplicate paths show Already added; unavailable/denied paths show real errors.
- Keep the current path visible; support long paths, scrolling, and cancellation.
- Use explicit browser states and handle the host's dialog-replacement semantics:
  replacing a dialog must not accidentally resolve the entire flow as cancelled.
- Cancel stale requests when navigating; ignore late replies for previous paths.

Metadata-only user-initiated home-screen browsing must be distinguished from
agent filesystem access. Root instruction/content reads are deferred until a real
session can enforce its permissions. Document the exact metadata policy.

### 9.5 Status, removal, and feedback

Status shows name, aliases, canonical paths, root availability, and instruction
load state. File count is optional and computed asynchronously/on demand; never
scan every repository merely to open a menu or render a badge.

Removal asks a second confirmation naming the registration. Whole-workspace
deletion explains that other session bindings will be cleared. No files are deleted.

Emit success feedback only after committed storage. A toast failure must not
report that a committed mutation failed or cause a duplicate retry.

### 9.6 Indicator and visual quality

- Render `[ws:research-xyz]` or a similarly compact label through a documented
  slot such as `prompt.footer.status`.
- The original header placement was a mockup, not proof of a public header API.
  Do not patch host internals to reproduce that exact coordinate.
- Reflect the displayed session's binding, including no selection and degraded state.
- Use semantic theme tokens; support narrow terminals and ellipsized names.
- No giant metadata blocks, permanent debug counters, or nonfunctional controls.
- Menus must work with the model/provider disconnected and must leave the
  user's draft prompt intact.

### 9.7 UI states and synchronization

Use explicit states: loading, ready, browsing, confirming, saving, error, cancelled.
Prevent double submissions and make recovery preserve the user's entered path.
Filter events by Location, catalog, and target session as applicable. Definition
updates may require refreshing several sessions; a binding event targets one.

RPC subscriptions are live-only. Re-fetch authoritative state on reconnect,
session changes, and reopening the menu. Re-establish ended subscriptions and
clean up dialogs, listeners, layers, and pending requests on reload/unload.

## 10. Agent context and `AGENTS.md`

### 10.1 Base context

Before each ordinary model request, build one fresh block from the invoking
session's workspace snapshot. It contains:

- Workspace identity/revision and the complete root mapping.
- Canonical absolute paths and aliases for display/search disambiguation.
- Availability and instruction status of each root.
- A rule to scope edits/tests/Git to an explicit root.
- Applicable instruction sources with source path, directory scope, and content.

Do not append mapping text into the prompt composer or accumulate old mappings
as synthetic chat messages. The block informs a real development request; it
does not start a new request itself.

Example outline:

```text
Multi-root workspace: research-xyz (revision 3)
src:/  -> D:/proj/src
docs:/ -> C:/data/docs

These are independent folders/repositories. Native file tools use absolute
paths; shell calls require an explicit workdir. Search may cover both roots.
Instructions below apply only to their stated directory scopes.

Source: D:/proj/src/AGENTS.md
Scope: D:/proj/src/**
<actual validated instruction content>
```

### 10.2 Instruction discovery and scope

1. At activation/first request, discover `AGENTS.md` at **each root**, not only
   at OpenCode's native launch directory.
2. Root instructions are eligible for every request while that root is attached.
3. For a target path, resolve `AGENTS.md` files from its registered root down
   through the target's containing directory. For directory operations, include
   that directory's applicable instructions.
4. Nested instructions apply only to their subtree. Repository A's testing rules
   must not silently become repository B's rules.
5. Stop upward traversal at the registered root. Do not read unrelated parent
   directories or claim that a subfolder root includes its entire parent repo.
6. Do not recursively concatenate every nested instruction file into each prompt.
   Discover on demand; a bounded metadata index is optional, not a startup full scan.
7. Canonicalize sources and deduplicate overlapping-root references. Use the most
   specific registered root to identify a target; do not load the same physical
   instruction twice. Preserve all applicable ancestor scopes within the roots.
8. Missing `AGENTS.md` is valid. Permission denial, unreadable content, invalid
   encoding, or an oversized file is a visible instruction error, not "no rules".

Use `AGENTS.md` as the first-release contract. Do not silently treat `CLAUDE.md`
or Copilot-specific formats as equivalent. OpenCode V2 documents `AGENTS.md`
only, without a `CLAUDE.md` fallback.

### 10.3 Delivery before a mutation

Discovery is not delivery. Loading an instruction in a pre-tool hook **after**
the model has already generated an edit does not make that edit instruction-aware.

Implement an observable instruction fingerprint per scope, associated with the
model-request snapshot that included the content:

- Reads/listing and an explicit `workspace_instructions` helper can prepare
  scopes and make their instruction content model-visible.
- Native read discovery can be reused only where phase-zero tests prove its
  external-root behavior. Do not rely on native discovery for arbitrary wrappers.
- For a first-touch edit/write/patch in an undisclosed nested scope, reject before
  side effects with `INSTRUCTIONS_REQUIRED` and an actionable path. Load the rules
  into the next context/tool result and let the model generate the edit again.
- Apply the check to **every** target of a multi-file patch and both sides of a
  rename. Validate all targets before the first mutation; never partially patch
  one repository and then discover instructions for another.
- A parallel read plus write cannot count as prior instruction delivery.
- If rules change after a model request, block stale mutations until the updated
  scope has been delivered. A filesystem cache hit is not delivery evidence.

Known native schemas need explicit adapters; generic searching for a `path`
property is insufficient for patches and renames. Unknown third-party tools are
outside this enforcement contract and must not be advertised as covered.

Arbitrary shell commands cannot be perfectly mapped to affected files. Require
an explicit workdir and root instructions; ask the agent to prepare nested scopes
before scoped mutations. Do not claim complete nested-rule enforcement for shell
or replace permission scanning with an ad-hoc shell parser.

### 10.4 Freshness, conflicts, trust, and budgets

- Refresh source fingerprints before requests and relevant side effects. Detect
  updates/deletions explicitly; do not preserve removed instructions as current.
- Track source path, scope, content hash, availability, and delivery status for
  diagnostics. Do not log raw instruction bodies by default.
- Root registration requires an explicit human choice and explanation that its
  instruction files may guide the agent. This is not blanket tool approval.
- Preserve platform/global/user policies. Repository text cannot change plugin
  permissions, authorize destructive actions, or activate another root's plugins.
- Label file contents as source material; do not interpolate their text into an
  unescaped markup protocol that can forge plugin scope metadata.
- Do not claim deterministic compliance by the model. The guarantee is correct,
  scoped, observable delivery plus covered-tool preflight, not obedience proof.
- OpenCode combines native instructions and does not resolve their conflicts.
  Retain native global/Location instructions; do not silently remove them.
  Explain that launch-project guidance still exists, and recommend a neutral
  launcher Location when it would be inappropriate for the chosen repositories.
- Within our scoped sources, a narrower scope refines its ancestor only for that
  subtree; unresolved contradictions require clarification, not arbitrary last-wins.
- Use configurable byte/context budgets, with a proposed starting cap of 32 KiB
  per file and 64 KiB aggregate instruction text, reduced for smaller model contexts.
  Validate the defaults against actual model limits in phase zero.
- Never silently truncate an instruction file and mark it fully applied. Show
  overflow/source details and block affected mutations until the instructions can
  be supplied in full under an explicit supported policy.

### 10.5 Compaction and switching

Rebuild the mapping and required instruction state after compaction, restart,
revert, and workspace changes. The registry is authoritative, not an old summary.
Compaction context can mention sources/scopes, but a summary is not a substitute
for the current instruction content. Preserve an earlier plugin's custom summary
when contributing through the compaction hook.

Invalidate plugin delivery fingerprints when model-visible context is removed.
Do not claim the old workspace's source text was erased from conversation history;
explicitly supersede it in current context and require a fresh session when strict
historical separation is needed.

## 11. Full development across independent roots

### 11.1 Native file operations first

- Reuse native `read`, `edit`, `write`, and `patch` with canonical absolute paths.
- Resolve aliases through a small helper such as `workspace_resolve`, or provide
  canonical paths directly in context. Native tools do not inherently understand
  `alias:/`; do not pass those strings unconverted.
- Preserve native edit permissions, output formats, formatting hooks, cancellation,
  and normal errors. Avoid a second inferior editing implementation.
- Remove the current blanket `USE_WORKSPACE_TOOLS` guard for built-in reads only
  after permission and instruction adapters cover the intended path.
- Keep workspace-specific search helpers where they add genuine multi-root behavior.

### 11.2 Search

- `workspace_glob` and `workspace_grep` default to all roots in the invoking
  session's binding and accept a single-root filter.
- Honor root/nested `.gitignore`, exclusions, result limits, and cancellation.
- Report the root alias with each result; disambiguate duplicate relative paths.
- Avoid starvation where the first huge root hides every later root. Use a
  deterministic bounded per-root allocation before merging results.
- Report truncation, unavailable roots, and partial-result status explicitly.
- Keep the current wrapper's 200 KiB direct-read/grep-input bound unless versioned
  deliberately. Native paginated reads retain the host's own documented limits.
- Do not equate search exclusions with access permissions: a direct read of an
  ignored, non-sensitive file can still be an explicitly authorized operation.

### 11.3 Commands and Git

Use native shell with an explicit per-call `workdir` inside the selected root.
Never change process cwd or repurpose OpenCode's single Location as a global
mutable current repository.

```text
shell { command: "bun test", workdir: "D:/proj/src" }
shell { command: "git status --short", workdir: "C:/data/docs" }
```

- If the agent has not selected a root for a command, do not guess the first root.
- Build/test commands come from actual repository instructions/configuration.
- A cross-repo task may require separate test runs and separate commits.
- Non-Git roots are fully valid; do not initialize a repository automatically.
- Avoid `cd` prefixes, shell-string interpolation of filesystem paths, and
  PowerShell-specific assumptions in server internals.
- Preserve the host shell tool's scanner, approvals, foreground/background behavior,
  timeouts, cancellation, and output handling. Do not add a filesystem RPC that
  doubles as an unapproved shell or edit backdoor.

### 11.4 References are not the binding store

OpenCode `references` are useful named external directories, but reference
transforms are Location-scoped, not session-scoped. Two sessions can share one
Location while using different workspace bindings.

Therefore the baseline design does **not** rewrite Location references whenever
one session switches workspaces. Investigate optional native reference/attachment
integration only after proving isolation. Do not replace session-specific context
with a shared reference registry or auto-refreshing remote reference checkouts.

## 12. RPC and compatibility tool contracts

The following method names are proposed **plugin RPC**, not built-in OpenCode APIs.
Define all schemas in `src/rpc.ts`, infer types, and validate on the server.

| Proposed method | Purpose |
| --- | --- |
| `list` | List definitions and revision; no global active value |
| `status` | Binding/root/instruction state for a validated session |
| `create` | Create a definition; optional explicit session attachment |
| `attach` / `detach` | Change one session's binding at a safe boundary |
| `addRoot` / `removeRoot` | Change a definition with revision validation |
| `remove` | Delete a definition and clear affected bindings after confirmation |
| `browse` | Metadata-only directory browser, never file contents |
| `refresh` | Recheck selected definition/root/instruction metadata |

Mutations carry an expected revision and an idempotency/request ID where a
transport retry could duplicate a committed operation. A transport timeout must
lead to status reconciliation, not blind creation of another workspace.

- Validate a provided session ID using server state; reject catalog/Location mismatch.
- Obtain the session's actual agent/permission context on the server; do not trust
  client-supplied agent IDs or forged tool-source metadata.
- Model-independent UI calls may use permission assertions without inventing
  message/tool IDs. Direct metadata administration and agent file access need
  explicitly separate policies.
- Events contain IDs, revisions, affected sessions, and bounded status metadata.
  Never broadcast file contents, instruction bodies, credentials, or permission replies.
- Do not expose generic read/write/execute RPC merely to support a folder menu.

Retain useful existing `workspace_*` tools as thin service adapters during
migration. Their session comes from native tool context, never from model input.
`workspace_create`/`workspace_switch` change only the caller's binding.
`workspace_list` can retain a computed `active` name for compatibility, but it
must clearly be session-derived, not the old on-disk field.

Old exact-schema tests must be revised deliberately for versioned changes.
Management through natural language may remain possible, but is optional and is
never the implementation of the TUI menu.

## 13. Security and failure behavior

Preserve the existing path hardening: canonical paths, Windows case handling,
UNC policy, device/ADS rejection, traversal checks, denied names, and junction/link
escape detection. Validate creation targets through the nearest existing parent;
`realpath` of an existing file alone does not protect writes to a new path.

- Keep the current sensitive-path deny set by default, including `.env.*` and
  `.ssh`/`.aws` components; document that it is stricter than native defaults.
- Apply workspace path policy to covered plugin tools and native-tool adapters
  inside the selected roots, without hijacking unrelated normal sessions.
- Approving `external_directory` does not override an edit denial or a plugin
  path denial. Never auto-reply to permissions or downgrade a configured deny.
- Paths outside the selected roots are not implicitly trusted by the workspace;
  native OpenCode's normal policy still applies to separate explicit operations.
- A deny must not be worked around through shell, MCP, another alias, or RPC.
- Shell/MCP/unknown tool isolation is not guaranteed. Do not describe this plugin
  as a filesystem sandbox or promise perfect instruction enforcement there.
- Missing roots remain manageable: show/remove/switch must still work.
- Registry corruption fails closed for workspace operations, without overwriting
  data or making unrelated no-workspace sessions unusable.
- An unavailable bound registry must not produce a guessed or stale mapping;
  covered workspace operations stop with an actionable error.

Use typed domain errors such as `INVALID_PATH`, `ROOT_UNAVAILABLE`,
`INVALID_REGISTRY`, `REGISTRY_BUSY`, `REVISION_CONFLICT`, `SESSION_BUSY`,
`INSTRUCTIONS_REQUIRED`, and `INSTRUCTIONS_UNAVAILABLE`. Permission rejection and
cancellation propagate as host control flow, not fake success JSON.

## 14. Implementation sequence and exit criteria

Do the work in an isolated feature branch. Do not modify real user registries,
global plugin configuration, or the shared service merely to run tests.

### Phase 0 — Capability proof and recorded decisions

**Status: complete for the reduced scope in Section 0.** Original metadata CAS and
automatic inheritance requirements are deferred, not satisfied.

- Pin a coherent SDK/runtime baseline and run the existing tests/typecheck.
- Build an isolated throwaway vertical slice: direct slash -> dialog -> typed RPC.
- Complete the capability checks in section 5.1, especially external edits,
  instruction preflight, session lifecycle, and safe boundaries.
- Record native limitations and finalize any adapters before broader refactoring.

**Exit:** model-independent UI is demonstrated in the real TUI and no essential
requirement rests on an invented or unverified host capability.

### Phase 1 — Extract services without weakening behavior

**Status: partial.** New catalog/path/instruction services exist; full legacy
service extraction and search reuse remain unfinished.

- Extract storage, schemas, path policy, browsing, and search from the monolith.
- Introduce transport-independent service methods and structured domain errors.
- Keep existing security/ignore/cancellation regression tests passing.

**Exit:** RPC and tools can share services; there is no fake native tool context.

### Phase 2 — Session bindings and versioned storage

**Status: reduced binding implemented.** SQLite persistence, explicit empty-session
binding, sealing, pinned roots, and private-server restart are verified. V1 migration
and automatic child/fork inheritance are deferred by Section 0.

- Implement v2 schema, revisions, stable IDs, migration, and backups.
- Route every existing tool/context path through the invoking session's binding.
- Add lifecycle, concurrency, same-session/multi-terminal, and restart tests.

**Exit:** two sessions at the same Location can select different workspaces.

### Phase 3 — Real management UI

**Status: core flow and footer indicator implemented and exercised in the real TUI.**
Legacy command retirement and full reconnect/package acceptance remain pending.

- Register the three commands and palette entries using direct handlers.
- Implement the main menu, creation, switching, folder browser, removal, and status.
- Add the session indicator and robust event/reconnect handling.
- Retire conflicting prompt-driven commands in the repository only after parity.

**Exit:** the whole management flow works with no model connection and does not
create chat messages, consume tokens, or destroy the user's draft input.

### Phase 4 — Instruction-aware agent context

**Status: working scoped delivery/preflight slice.** Real root/nested request
delivery and covered native edits are demonstrated; comprehensive lifecycle restoration
and real tokenizer-budget support remain open.

- Implement root and nested instruction resolution, permissions, budgets, and diagnostics.
- Build fresh per-session context and compaction restoration.
- Implement delivery fingerprints and covered mutation preflight.
- Test external/native overlap without duplicate or cross-root instruction leakage.

**Exit:** actual model-request assembly contains the expected scoped source
content; first-touch nested mutations cannot outrun instruction delivery.

### Phase 5 — Full multi-repository development

**Status: CURRENT — IN PROGRESS.** Cross-root native edit, test, and Git operations
are demonstrated. Implement safe bounded multi-root search/ignore adapters next.

- Enable native file operations in external roots and remove obsolete read guards.
- Add alias resolution, fair cross-root search, explicit-workdir shell guidance/preflight.
- Verify a coordinated feature change, two test suites, and independent Git status.
- Document native review/revert/LSP/formatter limitations observed in phase zero.

**Exit:** an agent can make and verify changes in both repos, not merely read them.

### Phase 6 — Packaging, migration acceptance, and documentation

**Status: pending.** Safe v1 import/backup, default catalog installation, published
package acceptance, and retirement of legacy entrypoints remain.

- Ship one package with server/TUI/RPC exports and one supported install path.
- Test package installation, not only source-linked development.
- Remove repository-owned obsolete notification entrypoints after their replacement
  is verified. Do not blindly remove global copies or user-edited files.
- Document how to prevent global/local duplicate plugin registration and how to
  roll back storage migration safely.
- Update README examples to show real UI, per-session selection, instructions,
  native edits, explicit command directories, and honest platform limitations.

**Exit:** the complete acceptance matrix below passes on a real Windows V2 TUI.

## 15. Verification matrix

| Area | Required cases |
| --- | --- |
| No-model UI | Main menu, create, browse, add, switch, remove, status with provider unavailable; no model/prompt APIs called |
| Input integrity | Existing draft preserved; Escape and dialog replacement; double-click/Enter; stale browser responses |
| Session isolation | A/B at same Location; same session in two clients; restart; child/fork; no binding; moved session/catalog mismatch |
| Shared definitions | Definition edit/removal affects only its bound sessions; running sessions and revision conflicts handled |
| Migration | v1 populated/empty; old active suggestion; interruption; backup collision; corrupt/future schema; concurrent writers |
| Paths | Spaces, quotes, slashes, home expansion, drive changes, case, duplicate canonical paths, missing directories, UNC policy |
| Security | Traversal, alias escape, junction retarget, new-file parent links, sensitive paths, native permission deny, no alternate-tool bypass |
| Root instructions | Both roots' real content delivered, absent file, unreadable/denied, change/delete, overlap deduplication |
| Nested instructions | Read then edit, edit-before-read, multi-file patch/rename, parallel read/write, stale fingerprint, no cross-root scope leakage |
| Context lifecycle | Compaction, revert, restart, switch/detach, stale summary, no duplicate composer/history injection |
| Context budgets | Large file/aggregate budget, small model context, visible error, no silent partial-rule success |
| Search | All roots and scoped root; duplicate relative names; ignore rules; fairness; cancellation; truncated/partial results |
| Development | Read/edit/write/patch in two external repos; independent tests; explicit workdir; separate Git status; non-Git folder |
| Host behavior | Permission source fidelity; formatting; review/snapshot/revert limitations; other plugins' context/compaction hooks preserved |
| Lifecycle | Plugin reload/unload; reconnect; missed event recovery; no listener/layer leaks or duplicate IDs |
| Installation | Global vs local single registration; packaged export loading; existing registry retained; no system-plugin modifications |

### 15.1 Test layers

1. **Unit:** domain/storage/path/instruction services with isolated fixtures.
2. **Adapter:** mocked host APIs, asserting forbidden prompt/generation methods
   are never called by administrative handlers.
3. **Real server:** isolated service, temp registries and two fixture repos;
   actual native tool hooks and permissions rather than mocks alone.
4. **TUI:** keyboard-driven real runtime checks for commands/dialogs/indicator.
5. **Agent acceptance:** a controlled actual request or test provider capturing
   assembled instructions plus a small cross-repo change and test run.

Keep automated fixtures under approved `Temp/opencode` paths. Use `registryPath`
to isolate persistence. A smoke test that only lists plugins does not establish
UI, instruction delivery, external editing, or session isolation correctness.

### 15.2 Manual end-to-end acceptance script

1. Prepare two disposable Git repos outside the launch Location, one with spaces,
   and one ordinary non-Git folder. Put distinguishable `AGENTS.md` instructions
   in both repos and a different nested rule in one subtree.
2. Disconnect/disable model access. Open `/workspace`, create a definition, add
   the folders through real UI, inspect status, switch/detach/reattach.
3. Confirm no assistant turn or generation was created by those actions.
4. Open sessions A and B at the same Location and select different definitions.
   Switch A and verify B's context and badge are unchanged.
5. Restore model access. Ask for a change spanning both repos. Inspect actual
   instruction-source diagnostics/request assembly, not just the agent's claims.
6. Verify the nested rule is delivered before its first mutation, both repos can
   be edited, and tests/Git inspection execute in their explicit directories.
7. Exercise a denied sensitive read, missing root, and a multi-file instruction
   preflight failure; confirm no partial mutation or bypass.
8. Compact, restart, and revisit both sessions. Verify persisted selections and
   refreshed instruction content, including a changed/deleted instruction file.
9. Remove a root/definition. Verify only registrations/bindings change and no
   repository files are deleted.

## 16. Definition of done and non-negotiable review rules

The implementation is complete only when:

- Typecheck, regression tests, server integration, and real TUI acceptance pass.
- Management never delegates to an AI model or `question`.
- Per-session selection survives restart and cannot leak through Location globals.
- Instruction source content is actually delivered with correct scopes and freshness.
- Cross-repository edits and test execution work under native permissions.
- Migration, concurrency, cancellation, and degraded states are covered.
- README distinguishes verified support from native host limitations.

Reject these shortcuts during review:

- "The command tells the agent to open a menu."
- "It uses `question`, so it is a UI plugin."
- "The alias mapping is in context, so `AGENTS.md` support is done."
- "Every `AGENTS.md` is concatenated globally, so scoped rules are supported."
- "The pre-tool hook read the rules, so the model already knew them."
- "The UI button is disabled, so concurrent switching is safe."
- "References changed, so only this session's roots changed."
- "Read/search tools work, so full development works."
- "Tests mocked the SDK, so the installed TUI must work."
- "Path checks make arbitrary shell execution sandboxed."

## 17. Sources and research boundaries

Official documentation, checked on 2026-10-18:

### OpenCode V2

- [Server plugins and hooks](https://opencode.ai/v2/docs/build/plugins/)
- [CLI/TUI plugin API](https://opencode.ai/v2/docs/build/plugins/cli/)
- [Plugin RPC](https://opencode.ai/v2/docs/build/plugins/rpc/)
- [CLI plugin discovery](https://opencode.ai/v2/docs/cli/plugins/)
- [Client RPC location and event behavior](https://opencode.ai/v2/docs/build/client/)
- [Instructions and native discovery](https://opencode.ai/v2/docs/instructions/)
- [Native tools, external edits, and shell workdir](https://opencode.ai/v2/docs/tools/)
- [Permission semantics](https://opencode.ai/v2/docs/permissions/)
- [References and their limitations](https://opencode.ai/v2/docs/references/)
- [API reference](https://opencode.ai/v2/docs/api/)

### VS Code and Copilot

- [Multi-root workspaces](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces)
- [Workspace context and selective retrieval](https://code.visualstudio.com/docs/agents/reference/workspace-context)
- [Custom instructions and harness-specific AGENTS.md behavior](https://code.visualstudio.com/docs/agent-customization/custom-instructions)

### Version-specific evidence

- [Published plugin 2.0.30 manifest](https://unpkg.com/@opencode/plugin@2.0.30/package.json)
- [Published plugin 2.0.30 TUI context types](https://unpkg.com/@opencode/plugin@2.0.30/dist/tui/context.d.ts)
- Existing repository implementation and tests referenced in section 2.

VS Code behavior here was researched from official documentation, not verified
through a local instrumented Copilot session or an audit of its implementation.
OpenCode API availability was checked against documentation and published types;
phase-zero live integration checks are still required. No feature in this plan
should be reported as implemented merely because its API exists.
