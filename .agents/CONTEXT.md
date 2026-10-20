# Project context

## Purpose

`opencode-workspaces` is an unreleased OpenCode V2 plugin for working across
independent project roots in one explicitly bound session. Administration uses
native TUI dialogs and typed RPC without model calls. File edits, shell commands,
tests, and Git operations continue through OpenCode's native tools and permissions.

The repository's AI development library lives in `.agents`. Start at
[AGENTS.md](../AGENTS.md); use [architecture](ARCHITECTURE.md) to locate owners and
follow runtime flows. The [README](../README.md) is for plugin users.

## Technical baseline

| Component | Current baseline |
| --- | --- |
| Runtime | Bun `>=1.4.3`; package-manager pin `bun@1.4.3`. |
| Host | OpenCode V2 CLI `2.0.32`. |
| SDK | `@opencode/plugin`, `@opencode/client`, and `@opencode/schema` `2.0.30`. |
| Language | TypeScript `5.8.3`, ES modules, strict checking, no emit during typechecks. |
| UI | OpenTUI `0.5.17` and host Solid `1.9.15`. |
| Validation/storage | Zod `4.1.8` and Bun SQLite. |

The OpenTUI Solid peer declares Solid `1.9.12`, while this host uses `1.9.15`.
The known peer warning is not a reason to bundle another Solid runtime or change
the host's pin. Check [package.json](../package.json) and
[tsconfig.json](../tsconfig.json) before changing the baseline.

## Product contracts

- `/workspace` is the single management-menu command; `/workspace-add` and
  `/workspace-switch` remain dedicated entrypoints. There is no `/workspaces`
  alias.
- Opening/cancelling menus or editing definitions does not activate a workspace.
  Attachment requires an explicit action in an empty or new native session.
- Ordinary sessions receive no workspace system text, instruction reads,
  workspace permission decisions, native-tool restrictions, or footer label.
  Their request tool maps exclude workspace helpers; helpers also reject direct
  calls without an active binding.
- Each active session owns its persisted selection and pinned definition
  snapshot. Saved-definition changes do not retarget existing conversations.
  Started conversations switch/detach by creating another session.
- New sessions, children, and forks do not inherit a workspace automatically.
  The catalog is the only binding authority; do not mirror it into native
  session metadata or add a global active-workspace variable.
- A binding belongs to its original Location. Moving it to another Location
  must not silently rebase its roots.
- Launch-project/global instructions, agents, providers, and permissions remain
  native. Registering a root does not load that root's OpenCode plugins/config.
- Only the current SQLite format is supported. Do not reintroduce old plugins,
  JSON import, schema upgrades, automatic catalog moves, or launcher repair.

## Storage

All platforms default to
`~/.config/opencode/workspace-manager/workspaces-v2.sqlite`. On Windows this is
`%USERPROFILE%\.config\opencode\workspace-manager\workspaces-v2.sqlite`.
`LOCALAPPDATA` does not select catalog storage.

An explicit `options.catalogPath` ending in `.sqlite` takes precedence. The
resolved catalog location stays fixed for the plugin lifetime. Startup, passive
requests, status reads, and menu opening do not create missing storage.

Definitions, bindings, revisions, and receipts belong to the current catalog.
Changing its path selects another catalog; it does not transfer records. The
plugin never searches, migrates, merges, or overwrites earlier catalogs.
Unsupported application IDs and storage versions are rejected.

Catalogs contain machine-specific paths and session state. Do not commit them,
sync live SQLite/WAL files, or touch real user storage for tests. A deliberate
transfer requires all using servers to stop and a SQLite-consistent backup;
never copy only a live database's main file.

## Limits and boundaries

| Concern | Current limit or behavior |
| --- | --- |
| Workspace roots | At most 20 roots per definition. |
| Instruction sources | 32 KiB per file, 64 KiB aggregate; declared model context must be at least 128k. |
| Glob/grep results | 200 paths or 100 matching lines, divided into fixed per-root shares. |
| Traversal | 10,000 entries per root; nested ignore rules, sensitive-path and link exclusions. |
| Grep input | 8 MiB per root; binary, invalid UTF-8, and files over 200 KiB excluded. |
| Regex engine | Isolated JavaScript regex worker with a one-second per-file deadline, not ripgrep syntax. |
| Admission | At most 10,000 started-session markers per plugin lifetime; saturation disables further attachment without evicting safety markers. |

Request admission is a single-server boundary, not distributed coordination or
an atomic host idle/attach API. Do not claim automatic inheritance, native
metadata transactions, atomic filesystem snapshots, instruction freshness across
native permission waits, or arbitrary shell/MCP sandboxing.

Known active sessions fail closed when their binding cannot be confirmed.
Startup has an unavoidable discovery ambiguity if storage is unreadable before
a binding is known: that resolution is logged as unavailable, while undiscovered
sessions retain native behavior. Do not describe them as confirmed passive or
silently fabricate an empty binding. Restore access and rediscover through the
menu/navigation before continuing a possibly bound conversation.

Helpers request Code Mode exclusion and are removed from passive request tool
maps. Complete indirect schema invisibility in the pinned host's internal Code
Mode inventory still lacks fresh live acceptance.

## Verification

Run commands from the repository root. Use the smallest relevant check and
isolated fixtures. Install dependencies only when needed, using the existing
lockfile.

| Change/check | Command or validation |
| --- | --- |
| Markdown or agent customization only | Validate local links/anchors, skill/rule/command metadata, provenance, and `git diff --check`; no build or tests required. |
| Production source/release scripts | `bun run typecheck`. |
| All TypeScript, including tests | `bun run bun-typecheck`. |
| Formatting | `bun run format:check` (Prettier over `src`, `tests`, and `scripts`); `bun run format` rewrites. |
| Unit/adapter regressions | `bun test`, or a focused existing test file during iteration. |
| Distribution | `bun run build`; `bun run pack` when packaging changes. Neither runs tests. |

Automated unit/adapter tests and typechecking are permitted. Running OpenCode,
`bun run start`, `bun run check:workspaces`, or any live TUI script requires
separate user approval. Never restart a shared service, modify global
configuration, make real provider requests, or touch user catalogs as part of
routine validation.

The actual-package harness still expects pre-opt-in behavior such as
`[ws:none]`. Reconcile it with the current contract before using it for fresh
acceptance. Mocked regressions and a passing build are not proof of the current
package's live behavior. The live harness support in `tests/live` has
Windows-specific executable and shell handling.

For normal installation register the absolute `dist` directory, not the checkout
root: the pinned host probes local entrypoint files rather than following the
root manifest's compiled exports. Build outputs and dependencies are ignored by
Git; do not edit them as source.