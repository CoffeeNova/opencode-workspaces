# Architecture

## Runtime boundaries

The plugin has separate OpenCode server, TUI, and RPC entrypoints. The server
owns filesystem access and persistent state. The TUI uses typed RPC and native
dialogs; it never opens the catalog or asks a model to manage workspaces.

[index.ts](../src/index.ts), [tui.ts](../src/tui.ts), and [rpc.ts](../src/rpc.ts)
are one-line entry files that re-export the server plugin, the TUI plugin, and the
RPC contract. The code lives under `src/shared`, `src/server`, and `src/tui`.

```text
src/shared/   schemas, errors, limits, rpc-contract      (imports no other src folder)
    ^                                      ^
    |                                      |
src/tui/                               src/server/
  plugin.ts, target.ts, messages.ts,     plugin.ts -> runtime.ts (owners below)
  client.ts (typed RPC client)
  menu/       MenuSession + one          rpc-handlers.ts, hooks/, tools/
              module per flow            sessions/, catalog/ -> SQLite
  indicator/  footer + SelectionPoller   filesystem/, search/ -> isolated regex worker
                                         instructions/ -> scoped AGENTS.md snapshots
```

Module direction is one way: `tui -> shared <- server`. `src/shared` imports
nothing from `server` or `tui`, and the TUI imports only `src/shared` and host UI
packages. The TUI reaches the server only through the `WorkspaceRPC` contract.
Production modules must not import test fixtures.

### Server owners

`createRuntime` in [runtime.ts](../src/server/runtime.ts) builds one
`ServerRuntime` per plugin instance and passes it to the RPC handlers, hooks, and
tools. `disposeRuntime` clears every owner on unload.

| Owner | Job |
| --- | --- |
| `CatalogAccess` | Resolves the catalog path once and lazily opens a read-only catalog for discovery or a writable one on demand. Concurrent callers share one open; unload closes both. |
| `SessionAdmission` | Synchronous started-session markers. A session that has started a request can never be attached. |
| `BindingResolver` | Resolves and caches each session's pinned binding. Sessions once seen active fail closed; inactive results are cached with a bound. |
| `SessionInstructions` | Per-session instruction delivery and the instruction status reported to the footer. |

### TUI owners

| Owner | Job |
| --- | --- |
| `MenuSession` | One open menu: its pinned target, the last loaded state, validity checks against navigation or disposal, and the guarded `change` call. Each menu flow receives it as its context. |
| `SelectionPoller` | Keeps one displayed session's selection current: one request at a time, queued refreshes, a per-request timeout, and backoff polling only while a workspace is active. It is private; the indicator starts one through the exported `watchSelection()`, which returns the cleanup function. |

## Source map

| Module | Responsibility |
| --- | --- |
| [schemas.ts](../src/shared/schemas.ts) | Zod schemas and inferred types for definitions, bindings, actions, changes, and selection metadata. |
| [errors.ts](../src/shared/errors.ts) | `WorkspaceError`, error codes, `errorCode`/`isNotFound` readers, and unavailable-storage code classification. |
| [limits.ts](../src/shared/limits.ts) | Named catalog, session, search, instruction, browse, and indicator-timing limits. |
| [rpc-contract.ts](../src/shared/rpc-contract.ts) | Shared `WorkspaceRPC` contract (re-exported by [rpc.ts](../src/rpc.ts)): `state`, `selection`, `change`, `browse`, and the `changed` event. |
| [plugin.ts](../src/server/plugin.ts) | Server composition: option validation, runtime creation, registration order, and disposal ([index.ts](../src/index.ts) re-exports it). |
| [runtime.ts](../src/server/runtime.ts) | The `ServerRuntime` owners passed to handlers, hooks, and tools. |
| [sessions/](../src/server/sessions) | `SessionAdmission` (`admission.ts`), `BindingResolver` (`bindings.ts`), and Location/attachment/active-binding guards (`guards.ts`). |
| [rpc-handlers.ts](../src/server/rpc-handlers.ts) | `state`, `selection`, `change`, and `browse` handlers and the `changed` emitter. |
| [hooks/](../src/server/hooks) | Context delivery (`context.ts`), compaction (`compaction.ts`), native-tool preflight (`tool-preflight.ts`), and `workspace_escape` evaluation (`permission.ts`). |
| [tools/](../src/server/tools) | Helper tool registration (`index.ts`) and the search, status, and resolve tools. |
| [prompts.ts](../src/server/prompts.ts) | Model-visible system text, helper tool names (`HELPER_TOOLS`), and helper tool descriptions. |
| [failures.ts](../src/server/failures.ts) | Mapping of storage/filesystem outages to `WorkspaceError`; other failures propagate. |
| [catalog/](../src/server/catalog) | `CatalogAccess` (`catalog-access.ts`); transactions, revisions, request receipts, and pinned session bindings (`catalog.ts`); SQLite format validation for read-only and writable opens, schema, and pragmas (`storage.ts`); row decoding and metadata checks (`codec.ts`); per-action handlers (`actions.ts`). |
| [filesystem/](../src/server/filesystem) | Path keys, containment, and expansion (`paths.ts`); sensitive-path denial, canonicalization, root overlap, and native target checks (`policy.ts`); no-follow cancellable bounded reads with UTF-8 decoding (`safe-read.ts`); folder browsing for the RPC `browse` method (`browse.ts`). |
| [search/](../src/server/search) | Glob/regex validation (`patterns.ts`), ignore-aware traversal (`walk.ts`), regex worker isolation (`regex-worker.ts`), and multi-root search results with bounded UTF-8 reads (`search.ts`). |
| [instructions/](../src/server/instructions) | Shared types and `InstructionError` (`types.ts`), `SessionInstructions` (`session-instructions.ts`), snapshot lifecycle and mutation preflight (`delivery.ts`), target-to-scope mapping (`scopes.ts`), bounded `AGENTS.md` reads (`sources.ts`), the delivered block (`render.ts`), and patch target parsing (`patch-targets.ts`). |
| [plugin.ts](../src/tui/plugin.ts) | TUI composition: the three slash/palette commands, the one-menu-at-a-time guard, indicator registration, and disposal ([tui.ts](../src/tui.ts) re-exports it). |
| [target.ts](../src/tui/target.ts) | The displayed session and Location a menu is pinned to, and target equality. |
| [messages.ts](../src/tui/messages.ts) | User-facing menu, dialog, and status text. |
| [client.ts](../src/tui/client.ts) | The typed `WorkspaceRPC` client shared by the menu and the indicator. |
| [menu/](../src/tui/menu) | `MenuSession` (`session.ts`), the main menu and entry dispatch (`main-menu.ts`), and one module per flow: create, delete, add/remove folder, switch/attach, status, and new-session navigation (`open-session.ts`). |
| [indicator/](../src/tui/indicator) | Session-aware footer rendering (`indicator.ts`), `watchSelection()` and the private `SelectionPoller` with coalescing, backoff, cancellation, and listener cleanup (`selection-poller.ts`), and grapheme-safe label fitting (`label.ts`). |

Keep domain schemas independent of the host UI and storage. Server modules own
filesystem/database mechanics, native permissions, and session identity. TUI code
depends on the RPC contract, not server internals.

## Workspace administration

1. The TUI captures the displayed session and Location. Navigation or disposal
   invalidates that target and prevents later dialog results from changing it.
2. `state` reads definitions and attachment eligibility without selecting a
   workspace. `browse` returns directory metadata for authenticated human
   administration; it does not read project instructions or file contents.
3. `change` validates its action, request ID, expected catalog revision, session
   identity, and any new root's canonical path.
4. Attachment checks native history, then rechecks synchronous request-admission
   markers immediately before the SQLite transaction. No `await` separates that
   final check from the commit.
5. The catalog commits the action and receipt together. A binding stores a
   snapshot of the definition rather than a live reference to its current roots.
6. The server returns authoritative state and emits a change notification.
   Notification failure does not roll back a committed mutation or justify
   blindly retrying it. Clients reconcile through metadata reads.

Opening a workspace from home creates an empty native session, binds it, confirms
the result, then navigates. No synthetic prompt is sent. Switching or detaching
after work has started opens a new session instead of rewriting existing history.

## Persistence

The catalog has four tables:

| Table | Stored data |
| --- | --- |
| `catalog` | Catalog UUID and global optimistic-concurrency revision. |
| `workspaces` | Saved definitions, each with its own UUID, revision, name, and roots. |
| `bindings` | Session ID, original Location directory, pinned definition snapshot, and sealed flag. |
| `receipts` | Request IDs and fingerprints used to reject conflicting reuse and duplicate mutations. |

Only the current application ID `0x57534d32` and storage version `2` are accepted.
Writes use immediate transactions, WAL, and full synchronization. Existing
catalogs can be opened read-only for discovery; a missing catalog is created only
by an explicit administrative write. Selection polling reads metadata without
walking roots.

Deleting or editing a saved definition does not alter its existing session
snapshots. First active capture seals a binding. Native session metadata is not
a second binding store. See [storage constraints](CONTEXT.md#storage) before
changing catalog discovery or lifecycle.

## Request and instruction flow

The context, tool, and compaction hooks mark request admission synchronously
before their first asynchronous operation.

An ordinary session returns from the context hook without workspace text,
instruction reads, or helper schemas. Direct helper execution independently
requires a persisted active binding.

For an active session, the server:

1. Validates the session's original Location and captures its pinned binding.
2. Seals the binding in the existing catalog.
3. Checks the declared model context budget and captures applicable root and
   previously discovered nested `AGENTS.md` sources under native read permissions.
4. Adds the pinned root mapping and scoped instruction snapshot to system context.
5. Uses native read/resolve operations to discover additional scopes for a later
   request. Mutation preflight checks the generating message's snapshot before
   allowing covered writes or shell work.

Instruction changes or newly required scopes can require a fresh model request.
Compaction invalidates delivery state. Limits and unsupported guarantees are
listed in [context](CONTEXT.md#limits-and-boundaries).

## Paths, permissions, and search

Native `read`, `edit`, `write`, `patch`, and `shell` executors remain native.
The server preflights explicit paths/workdirs, including every patch target and
both rename endpoints. Checks cover supplied paths and resolved filesystem
locations, including nearest existing parents for new files. Outside links into
selected roots cannot bypass the workspace policy.

Root registration grants no tool permission. Native external-directory and read
permissions still apply. Permission denial and cancellation remain errors.
The adapter does not parse arbitrary paths embedded in shell commands or sandbox
MCP tools.

Native glob/grep overlapping selected roots are redirected to `workspace_glob`
and `workspace_grep`. These helpers search pinned roots, preserve alias-qualified
paths, honor nested ignore rules, and exclude sensitive paths and links. Results
report per-root completion, partial output, truncation, and fixed limits. Quotas
are shared deterministically rather than transferred from one root to another.

## TUI lifecycle

The menu commands are `/workspace`, `/workspace-add`, and `/workspace-switch`.
There is no plural management alias. The menu is independent of model requests.

The footer contributes text only for the displayed active session. Names are
clipped by grapheme and terminal width. `!` marks blocked instruction loading;
`[ws:unavailable]` is reserved for a previously known active selection that can
no longer be confirmed. Passive sessions have no recurring selection timer.
Navigation, session deletion, and disposal cancel pending requests and detach
listeners.

OpenTUI and Solid imports stay external to the build so the host supplies its own
runtime instances.

## Build and verification surfaces

- [build.ts](../scripts/build.ts) bundles the three entrypoints into `dist`,
  writes its standalone manifest, and copies the human-facing README. The
  entrypoint list and the host packages that must stay external are shared with
  `check-workspaces.ts` through [externals.ts](../scripts/lib/externals.ts).
- [pack.ts](../scripts/pack.ts) builds and archives that distribution using its
  manifest's file list. Source, tests, and the AI library are not plugin payload.
- [start.ts](../scripts/start.ts) is an optional isolated demo launcher. Normal
  installation registers `dist` and launches OpenCode from the user's project.
- [check-workspaces.ts](../scripts/check-workspaces.ts) exercises the actual
  package with an isolated server/provider/TUI, using the support code in
  [tests/live](../tests/live) (private TUI driver, scripted provider, terminal
  screen). It still has pre-opt-in expectations that need reconciliation before
  fresh acceptance.
- Tests mirror the source folders: [tests/server](../tests/server) and
  [tests/tui](../tests/tui) hold the unit/adapter suites.
  [surface.test.ts](../tests/surface.test.ts) compares the observable surface
  (tool schemas, system text, SQLite DDL, dialogs) with a golden snapshot in
  [tests/__snapshots__](../tests/__snapshots__); a snapshot diff is a behavior
  change, so fix the code instead of updating the snapshot. The snapshot is
  recorded on Windows; on other OSes the path separators in a few
  instruction-source keys differ, so compare it on Windows only.
  [readme.test.ts](../tests/readme.test.ts) checks the README's install snippets.
- [tests/helpers](../tests/helpers) is shared test support. In particular
  [workspace-server.ts](../tests/helpers/workspace-server.ts) hosts the production
  server against mocked native APIs and [tui-host.ts](../tests/helpers/tui-host.ts)
  fakes the TUI host.
- Formatting is Prettier over `src`, `tests`, and `scripts`: `bun run format`
  rewrites and `bun run format:check` verifies.

See [verification and approval boundaries](CONTEXT.md#verification) before
running commands.
