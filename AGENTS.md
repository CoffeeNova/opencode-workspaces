# AI development guide

This is the entry point for agents working on `opencode-workspaces`.
The repository's development knowledge lives in [.agents](.agents); source and
tests remain the authority for implemented behavior.

## Start here

1. Read [project context](.agents/CONTEXT.md) for the product contracts, runtime
   baseline, storage rules, limits, and validation permissions.
2. Use [architecture](.agents/ARCHITECTURE.md) to locate the owning modules and
   follow the relevant server/TUI/RPC flow.
3. Inspect Git status, the actual source/tests, and any nested `AGENTS.md` before
   editing. Preserve existing user changes.
4. For TypeScript work, load the [rules](.agents/rules/best-practices.mdc) and
   [TypeScript skill](.agents/skills/typescript-best-practices/SKILL.md).

Read task-relevant resources rather than loading the entire library. If this
guide and the implementation disagree, investigate and surface the mismatch;
do not invent a host capability or silently change the product contract.

## Find the right owner

| Task | Start with |
| --- | --- |
| Install or explain the plugin | [README](README.md) |
| Understand behavior and constraints | [Context](.agents/CONTEXT.md), [architecture](.agents/ARCHITECTURE.md) |
| Change schemas or the RPC contract | [domain.ts](src/domain.ts), [rpc.ts](src/rpc.ts) |
| Change storage, selection, or request admission | [index.ts](src/index.ts), [catalog.ts](src/infrastructure/catalog.ts), [catalog tests](tests/catalog.test.ts), [server tests](tests/workspaces.test.ts) |
| Change paths, permissions, or multi-root search | [paths.ts](src/infrastructure/paths.ts), [search.ts](src/infrastructure/search.ts), [filesystem tests](tests/filesystem.test.ts) |
| Change instruction delivery or native mutation preflight | [delivery.ts](src/instructions/delivery.ts), [index.ts](src/index.ts), [instruction tests](tests/instructions-probe.test.ts) |
| Change menus, browsing, or session navigation | [tui.ts](src/tui.ts), [TUI tests](tests/workspace-tui.test.ts) |
| Change the footer indicator | [indicator.ts](src/tui/indicator.ts), [TUI tests](tests/workspace-tui.test.ts) |
| Change building, packaging, or the optional launcher | [build.ts](scripts/build.ts), [pack.ts](scripts/pack.ts), [start.ts](scripts/start.ts), [package.json](package.json) |
| Work on actual-package acceptance | [check-workspaces.ts](scripts/check-workspaces.ts), [verification boundaries](.agents/CONTEXT.md#verification) |
| Work on historical host probes | [Fixtures](tests/fixtures/phase-zero-plugin), [architecture notes](.agents/ARCHITECTURE.md#build-and-verification-surfaces) |

## Skills, commands, and rules

| Resource | When to use |
| --- | --- |
| [typescript-best-practices](.agents/skills/typescript-best-practices/SKILL.md) | Writing, reviewing, or refactoring TypeScript: narrowing, strict types, unions, `satisfies`, and resource ownership. |
| [audit](.agents/commands/audit.md) | A requested TypeScript best-practices audit. Read the skill first and report findings; do not turn an audit into unrequested edits. |
| [TypeScript rules](.agents/rules/best-practices.mdc) | Concise checks to apply during TypeScript changes. |
| [Third-party notices](.agents/THIRD_PARTY_NOTICES.md) | Upstream source, pinned revision, license, and import maintenance. |

Skills use the standard `.agents/skills/<name>/SKILL.md` layout. Commands and rules
are linked development resources; their folders do not register OpenCode runtime
slash commands.

Claude Code discovers only `.claude/`, so thin adapters there register the same
resources: [`/audit`](.claude/commands/audit.md), the
[skill](.claude/skills/typescript-best-practices/SKILL.md), and a
[rule](.claude/rules/typescript-best-practices.md) scoped to `**/*.ts`. Adapters
only point at `.agents`; keep content there and update an adapter's name,
description, or scope when the source changes. [CLAUDE.md](CLAUDE.md) imports
this guide.

Imported examples are guidance, not authorization to change unrelated compiler
options, replace existing domain schemas, or refactor working code. Prefer this
project's existing helpers and validated boundaries.

## Working rules

- Keep code and repository documentation in English. Follow the existing
  TypeScript style: two-space indentation, double quotes, and no semicolons.
- Keep changes within the requested scope. Reuse Zod schemas, path checks,
  instruction delivery, and catalog transactions instead of duplicating them.
- Preserve explicit opt-in activation, per-session pinned selections,
  deterministic model-free administration, and native tool permissions.
- Do not add automatic inheritance, a global active selection, native metadata
  mirrors, old-format import/upgrade paths, or unverified OpenCode APIs.
- Keep errors explicit. Preserve native permission rejection and cancellation;
  do not substitute empty state or a success-shaped fallback for unavailable
  storage, instruction failure, or denied access.
- Test with isolated fixtures. Never alter real catalogs/global configuration,
  restart a shared OpenCode service, or make real provider requests to validate
  a routine change.
- Do not edit generated `dist`, dependency folders, or archives as source.
  Do not stage, commit, push, or discard unrelated work unless requested.

## Verification

For code changes, run the relevant existing checks from the repository root:

```powershell
bun run bun-typecheck
bun test
```

Use focused tests while iterating. Production-only checking is `bun run
typecheck`; build/package changes also use `bun run build` and, when relevant,
`bun run pack`. See [the verification matrix](.agents/CONTEXT.md#verification).

Documentation-only work needs link/anchor and customization-metadata validation
plus `git diff --check`, not a build or tests.

OpenCode, the optional launcher, actual-package acceptance, and live capability
scripts require separate user approval. Build or unit-test success is not proof
of live TUI, instruction, or cross-root behavior.

## Keep the library current

Update context when a product constraint or supported baseline changes, and
architecture when an owner, boundary, or flow changes. Update this index when
adding or moving a library resource. Keep the README focused on what the plugin
does and how to install it; do not put plans, audit logs, or agent instructions
there.
