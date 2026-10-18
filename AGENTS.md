# Agent Entry Point

Start here when working in this repository. This file is a navigation guide;
the detailed development contract lives in the documents linked below.

## Read first

1. [Development plan and contract](docs/DEVELOPMENT_PLAN.md) — the intended
   product, architecture, implementation phases, and acceptance criteria. Read
   this before implementation; do not treat it as a list of completed features.
2. [README](README.md) — the current implementation, installation, security
   behavior, and verification commands. Its first section describes the working
   development package; the later legacy section describes `.opencode/`.
3. The relevant source and tests below. Check the actual tree and Git status
   before editing. Follow the plan's Section 0 revision before the older phase order.

If old code, command prompts, or README limitations conflict with the target
design, follow the development contract for new implementation. Surface a genuine
conflict or unsupported host capability rather than silently changing the goal.

## Navigate by task

| Task | Start with |
| --- | --- |
| Understand the goal and boundaries | Plan: [requirements](docs/DEVELOPMENT_PLAN.md#1-purpose-and-confirmed-decisions), [scope](docs/DEVELOPMENT_PLAN.md#4-scope-and-non-goals) |
| Verify OpenCode capabilities | Plan: [API surface and capability gates](docs/DEVELOPMENT_PLAN.md#5-verified-opencode-api-surface-and-capability-gates), [sources](docs/DEVELOPMENT_PLAN.md#17-sources-and-research-boundaries) |
| Understand deferred host limitations | [Historical capability evidence](docs/PHASE_ZERO_FINDINGS.md); do not expand probes instead of implementing the revised release |
| Resume work in a new session | [Working-plugin handoff and exact next steps](docs/PHASE_ZERO_HANDOFF.md) |
| Refactor or choose module boundaries | Plan: [architecture](docs/DEVELOPMENT_PLAN.md#6-architecture) |
| Change storage or workspace selection | Plan: [persistence and migration](docs/DEVELOPMENT_PLAN.md#7-data-model-persistence-and-migration), [session isolation](docs/DEVELOPMENT_PLAN.md#8-session-isolation-and-lifecycle) |
| Build menus, folder browsing, or indicators | Plan: [TUI contract](docs/DEVELOPMENT_PLAN.md#9-tui-interaction-contract), [RPC](docs/DEVELOPMENT_PLAN.md#12-rpc-and-compatibility-tool-contracts) |
| Handle project instructions or compaction | Plan: [agent context and AGENTS.md](docs/DEVELOPMENT_PLAN.md#10-agent-context-and-agentsmd) |
| Enable edits, search, tests, or Git across roots | Plan: [full development](docs/DEVELOPMENT_PLAN.md#11-full-development-across-independent-roots), [security](docs/DEVELOPMENT_PLAN.md#13-security-and-failure-behavior) |
| Select the next implementation step | Plan: [phases and exit criteria](docs/DEVELOPMENT_PLAN.md#14-implementation-sequence-and-exit-criteria) |
| Test or review a change | Plan: [verification matrix](docs/DEVELOPMENT_PLAN.md#15-verification-matrix), [definition of done](docs/DEVELOPMENT_PLAN.md#16-definition-of-done-and-non-negotiable-review-rules) |

## Current repository map

| Path | Responsibility |
| --- | --- |
| [src/index.ts](src/index.ts), [src/rpc.ts](src/rpc.ts), [src/tui.ts](src/tui.ts) | New real server/RPC/TUI package; explicit session binding and native menus |
| [src/tui/indicator.ts](src/tui/indicator.ts) | Session-aware footer label, metadata reconciliation, and UI-runtime integration |
| [src/infrastructure/](src/infrastructure/), [src/instructions/](src/instructions/) | Transactional catalog, server paths/browser, and scoped instruction delivery |
| [scripts/check-workspaces.ts](scripts/check-workspaces.ts) | End-to-end check of the actual package after implementation; real private TUI and native development |
| [.opencode/plugins/workspace-manager.ts](.opencode/plugins/workspace-manager.ts) | Current server plugin: registry, paths, tools, permissions, and context hooks |
| [.opencode/plugins/workspace-manager-notifications/](.opencode/plugins/workspace-manager-notifications/) | Existing notification-only server/TUI package and RPC contract |
| [.opencode/commands/](.opencode/commands/) | Existing prompt-driven slash commands; not the desired UI implementation |
| [tests/workspace-manager.test.ts](tests/workspace-manager.test.ts) | Registry, tools, filesystem/security, and host-adapter regression coverage |
| [tests/notifications.test.ts](tests/notifications.test.ts) | Current toast routing and listener cleanup tests |
| [tests/opencode-smoke.ts](tests/opencode-smoke.ts) | Opt-in real OpenCode loader smoke check |
| [tests/opencode-capabilities.ts](tests/opencode-capabilities.ts), [tests/fixtures/phase-zero-plugin/](tests/fixtures/phase-zero-plugin/) | Isolated Phase-zero server/TUI/RPC and native-tool proof; not production entrypoints |
| [tests/boundary-probe.test.ts](tests/boundary-probe.test.ts) | Throwaway boundary protocol: snapshots, revisions, all-session checks, and scoped cancellation |
| [tests/opencode-tui-capabilities.ts](tests/opencode-tui-capabilities.ts), [tests/helpers/tui-capability.ts](tests/helpers/tui-capability.ts) | Provider-disabled real TUI checks: drafts, session routing, dialogs, source reload, and listener cleanup; not production administration |
| [tests/opencode-instruction-capabilities.ts](tests/opencode-instruction-capabilities.ts), [tests/instructions-probe.test.ts](tests/instructions-probe.test.ts) | Fixed-root scoped instruction delivery, generating-request fingerprints, native mutation rejection, and byte-budget negative cases; not production bindings or a complete instruction service |
| [package.json](package.json), [.opencode/package.json](.opencode/package.json), [tsconfig.json](tsconfig.json), [bun.lock](bun.lock) | Dependencies, scripts, TypeScript configuration, and dependency lock |

## Working rules

- Keep code and repository documentation in English.
- Read any applicable nested `AGENTS.md` before changing files in its scope.
- For implementation, follow the plan's Section 0 revision and working-slice order. Do not
  invent APIs or replace a failed capability check with a model-driven workaround.
- Preserve the core decisions: deterministic TUI administration without model
  calls, per-session workspace selection, scoped instruction delivery, and full
  multi-root development under normal OpenCode permissions.
- Preserve existing storage and security guarantees while refactoring. Revise
  tests that encode superseded product behavior deliberately, not merely to make
  failures disappear.
- Keep changes within the requested task. A plan is not authorization to execute
  every phase. Preserve unrelated user work; do not commit unless asked.
- Use isolated fixtures and registries. Do not edit real user registries/global
  configuration or restart the shared OpenCode service just to test a change.
- Keep this entry point and its links current when documents or modules move.
  Put detailed design in the plan rather than duplicating it here.

## Verification

For code changes, run from the repository root:

```powershell
bun run bun-typecheck
bun test
```

For relevant loader/integration changes, also run the opt-in check when the
installed OpenCode runtime is available:

```powershell
bun run test:opencode
```

The loader smoke check is not proof that TUI interaction, instruction delivery,
or cross-root development works. Use the plan's corresponding acceptance tests.
Actual package acceptance: `bun run check:workspaces`.
Historical Phase-zero probes: `bun run test:capabilities` and `bun run test:capabilities:tui`.
Instruction-only iteration: `bun run test:capabilities:instructions` (scripted provider).
UI-only iteration: `bun run tests/opencode-tui-capabilities.ts --keep` (disabled provider).
Check their findings document before claiming any lifecycle gate is satisfied.
For documentation-only changes, validate links/anchors and run `git diff --check`.
Report what was verified and what still requires live runtime testing.
