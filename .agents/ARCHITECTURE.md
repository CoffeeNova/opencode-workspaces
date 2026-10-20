# Architecture

## Runtime boundaries

The plugin has separate OpenCode server, TUI, and RPC entrypoints. The server
owns filesystem access and persistent state. The TUI uses typed RPC and native
dialogs; it never opens the catalog or asks a model to manage workspaces.

```text
OpenCode server
  src/index.ts
    domain.ts + rpc.ts
    infrastructure/catalog.ts -> SQLite
    infrastructure/paths.ts
    infrastructure/search.ts -> paths + isolated regex worker
    instructions/delivery.ts -> scoped AGENTS.md snapshots

OpenCode TUI
  src/tui.ts -> rpc.ts -> server
    tui/indicator.ts -> selection RPC + host UI runtime
```

## Source map

| Module | Responsibility |
| --- | --- |
| [domain.ts](../src/domain.ts) | Zod schemas and inferred types for definitions, bindings, actions, changes, and selection metadata. |
| [index.ts](../src/index.ts) | Server composition, catalog lifecycle, session admission, RPC handlers, context hooks, native-tool preflight, and helper tools. |
| [rpc.ts](../src/rpc.ts) | Shared `WorkspaceRPC` contract: `state`, `selection`, `change`, `browse`, and the `changed` event. |
| [catalog.ts](../src/infrastructure/catalog.ts) | SQLite format validation, transactions, revisions, request receipts, and pinned session bindings. |
| [paths.ts](../src/infrastructure/paths.ts) | Server-side path expansion, canonicalization, root containment, sensitive-path checks, and folder browsing. |
| [search.ts](../src/infrastructure/search.ts) | Ignore-aware traversal, bounded UTF-8 reads, regex worker isolation, and multi-root search results. |
| [delivery.ts](../src/instructions/delivery.ts) | Scoped instruction discovery, request snapshots, content fingerprints, mutation preflight, compaction invalidation, and patch target parsing. |
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