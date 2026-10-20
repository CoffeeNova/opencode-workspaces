# Architecture

## Runtime boundaries

The plugin has separate OpenCode server, TUI, and RPC entrypoints. The server
owns filesystem access and persistent state. The TUI uses typed RPC and native
dialogs; it never opens the catalog or asks a model to manage workspaces.

```text
OpenCode server
  src/index.ts -> server/plugin.ts
    server/runtime.ts -> sessions/, catalog-access.ts, session-instructions.ts
    server/rpc-handlers.ts, server/hooks/, server/tools/
    shared/{schemas,errors,limits,rpc-contract}.ts + rpc.ts
    server/catalog/{catalog,storage,codec,actions}.ts -> SQLite
    server/filesystem/{paths,policy,safe-read,browse}.ts
    server/search/ -> server/filesystem + isolated regex worker
    server/instructions/ -> scoped AGENTS.md snapshots

OpenCode TUI
  src/tui.ts -> rpc.ts -> server
    tui/indicator.ts -> selection RPC + host UI runtime
```

## Source map

| Module | Responsibility |
| --- | --- |
| [schemas.ts](../src/shared/schemas.ts) | Zod schemas and inferred types for definitions, bindings, actions, changes, and selection metadata. |
| [plugin.ts](../src/server/plugin.ts) | Server composition: option validation, runtime creation, registration order, and disposal ([index.ts](../src/index.ts) re-exports it). |
| [runtime.ts](../src/server/runtime.ts) | The `ServerRuntime` owners passed to handlers, hooks, and tools. |
| [sessions/](../src/server/sessions) | Request admission markers (`admission.ts`), binding resolution and caching (`bindings.ts`), and Location/attachment/active-binding guards (`guards.ts`). |
| [catalog-access.ts](../src/server/catalog/catalog-access.ts) | Lazy catalog path resolution and shared read/write catalog opening with unload handling. |
| [rpc-handlers.ts](../src/server/rpc-handlers.ts) | `state`, `selection`, `change`, and `browse` handlers and the `changed` emitter. |
| [hooks/](../src/server/hooks) | Context delivery (`context.ts`), compaction (`compaction.ts`), native-tool preflight (`tool-preflight.ts`), and `workspace_escape` evaluation (`permission.ts`). |
| [tools/](../src/server/tools) | Helper tool registration (`index.ts`) and the search, status, and resolve tools. |
| [prompts.ts](../src/server/prompts.ts) | Model-visible system text and helper tool descriptions. |
| [failures.ts](../src/server/failures.ts) | Mapping of storage/filesystem outages to `WorkspaceError`; other failures propagate. |
| [rpc-contract.ts](../src/shared/rpc-contract.ts) | Shared `WorkspaceRPC` contract (re-exported by [rpc.ts](../src/rpc.ts)): `state`, `selection`, `change`, `browse`, and the `changed` event. |
| [catalog/](../src/server/catalog) | Transactions, revisions, request receipts, and pinned session bindings (`catalog.ts`); SQLite format validation, schema, and pragmas (`storage.ts`); row decoding and metadata checks (`codec.ts`); per-action handlers (`actions.ts`). |
| [paths.ts](../src/server/filesystem/paths.ts) | Path keys, containment checks, and path expansion/resolution. |
| [policy.ts](../src/server/filesystem/policy.ts) | Sensitive-path denial, canonicalization, root overlap, and native target checks. |
| [safe-read.ts](../src/server/filesystem/safe-read.ts) | No-follow open flags, the cancellable fill-buffer loop, bounded reads, and UTF-8 decoding. |
| [browse.ts](../src/server/filesystem/browse.ts) | Folder browsing for the RPC `browse` method. |
| [search/](../src/server/search) | Glob/regex validation (`patterns.ts`), ignore-aware traversal (`walk.ts`), regex worker isolation (`regex-worker.ts`), and multi-root search results with bounded UTF-8 reads (`search.ts`). |
| [instructions/](../src/server/instructions) | Shared types and `InstructionError` (`types.ts`), per-session delivery and status (`session-instructions.ts`), snapshot lifecycle and mutation preflight (`delivery.ts`), target-to-scope mapping (`scopes.ts`), bounded `AGENTS.md` reads (`sources.ts`), the delivered block (`render.ts`), and patch target parsing (`patch-targets.ts`). |
| [tui.ts](../src/tui.ts) | Native management menus, folder selection, explicit attachment, new-session navigation, and user-facing errors. |
| [indicator.ts](../src/tui/indicator.ts) | Session-aware footer rendering, selection reconciliation, cancellation, and listener cleanup. |

Keep domain schemas independent of the host UI and storage. Infrastructure owns
its filesystem/database mechanics; server composition owns native permissions and
session identity. TUI code depends on the RPC contract, not server internals.
Production modules must not import test fixtures.

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
  writes its standalone manifest, and copies the human-facing README.
- [pack.ts](../scripts/pack.ts) builds and archives that distribution using its
  manifest's file list. Source, tests, and the AI library are not plugin payload.
- [start.ts](../scripts/start.ts) is an optional isolated demo launcher. Normal
  installation registers `dist` and launches OpenCode from the user's project.
- [check-workspaces.ts](../scripts/check-workspaces.ts) exercises the actual
  package with an isolated server/provider/TUI, but still has pre-opt-in
  expectations that need reconciliation before fresh acceptance.
- [workspace-server.ts](../tests/helpers/workspace-server.ts) hosts the production
  server against mocked native APIs for unit/adapter regressions.
- [Phase-zero fixtures](../tests/fixtures/phase-zero-plugin) are research support,
  not production entrypoints. Some helpers and instruction regressions still
  depend on them; do not delete them based on the directory name.

See [verification and approval boundaries](CONTEXT.md#verification) before
running commands.