# Codebase refactor: readable architecture, identical behavior

Date: 2026-10-20
Status: approved by owner

## Intent

The plugin works, but its code was written by AI for compactness rather than for
people. The owner is not a TypeScript expert and wants a codebase that a human can
open and follow: a clear architecture, visually tidy files, and current TypeScript
practice. This is a pure refactor. The owner will re-test the plugin manually
afterward.

The owner delegated every technical decision (architecture, layout, naming,
tooling) to the builder. Decisions recorded below as "builder's call" were made on
their behalf and accepted without detailed review.

## Goals

- A structure where each folder and file has one obvious job, and a newcomer can
  find the owner of any behavior from the file tree alone.
- Short files and short functions. One statement per line. No line that packs a
  conditional, a `try/catch`, and a return together.
- Shared logic exists once. Limits are named constants in one place. Long
  user-facing and model-facing text lives apart from control flow.
- Strict, idiomatic TypeScript, following `.agents/rules/best-practices.mdc` and
  `.agents/skills/typescript-best-practices/SKILL.md`: discriminated unions,
  exhaustive switches, narrowing over casts, Zod at trust boundaries, explicit
  resource ownership.
- `src/`, `tests/` and `scripts/` all get the same treatment.

## Non-goals

- No functional change of any kind. No new features, no bug fixes that alter
  behavior, no "while I'm here" improvements to user-visible output.
- No change to compiler options in `tsconfig*.json`, runtime dependencies, or the
  supported baseline (Bun, OpenCode SDK, OpenTUI, Solid, Zod versions).
- Reconciling `scripts/check-workspaces.ts`'s stale pre-opt-in expectations (for
  example `[ws:none]`) is out of scope; the script is reshaped, not re-specified.

## Anti-goals (failure even if it "works")

- Any observable behavior drift: a reworded message, a changed error code, a
  different ordering of permission prompts, a changed tool schema or description,
  a different SQLite layout.
- Swapping AI-dense code for AI-ceremonial code: needless abstraction layers,
  interfaces with one implementation "for testability", dependency-injection
  frameworks, or class hierarchies. The result must be smaller in spirit, not just
  spread across more files.
- Losing a safety property because a refactor moved an `await` (see Constraints).

## What "behaves exactly the same" means

Frozen, byte-for-byte or semantically identical:

- Every user-visible string: dialog titles and messages, toasts, error messages
  including their `CODE: message` prefix, footer labels, `console.warn` text.
- Every model-visible string: the context-hook system text, the
  `WORKSPACE_INSTRUCTIONS` block and its JSON shape, tool names, tool
  descriptions, tool input JSON schemas, tool result JSON shapes.
- Plugin IDs (`workspace-manager.v2`, `workspace-manager.v2.tui`), RPC ID, RPC
  method names and input/output/error/event schemas.
- Slash commands and palette entries (`/workspace`, `/workspace-add`,
  `/workspace-switch`) and their command IDs and titles.
- `WorkspaceErrorCode` values and when each is raised.
- Catalog storage: default path, `.sqlite` requirement, application ID, storage
  version, table DDL, pragmas, transaction modes, receipt retention (256), and
  every validation rule applied to stored rows.
- All limits listed in `.agents/CONTEXT.md#limits-and-boundaries`, plus the
  internal ones (2048-entry inactive cache, 10,000 admission markers, 10,000
  bindings, 1000 workspaces, 100 browse entries, 2000-char grep line clip, regex
  timeout 1s, indicator retry 2s→10s and 5s request timeout, label budget 8–28).
- Order and timing of side effects: permission assertions, filesystem checks,
  catalog writes, event emission, and toast/indicator refresh.
- Package surface: `dist/index.js`, `dist/tui.js`, `dist/rpc.js`, the generated
  `dist/package.json`, and the external/bundled split in `scripts/build.ts`.

## Constraints

- **Await-free critical sections.** In the `change` RPC handler, no `await` may
  separate the admission check from `catalog.change(...)`. Hooks (`context`,
  `compaction`, `tool execute.before`) must call `requestStarted` synchronously
  before their first `await`. Instruction `preflight` must pin the message
  snapshot before its first `await`. Comments in the current code mark these;
  keep an equivalent comment at each site.
- **Permission control flow.** Native permission rejection and cancellation must
  keep propagating as errors. Every place that currently re-throws instead of
  mapping (`failure()` rethrowing non-unavailable errors, `permissionRejected`
  in search, `authorize` outside the filesystem `catch` in instruction sources,
  swallowed event-emit failures) keeps its exact semantics.
- **Module direction.** `src/tui/**` imports only `src/shared/**` and host UI
  packages, never `src/server/**`. The build uses code splitting, so a stray
  import would pull `bun:sqlite` and filesystem code into the TUI bundle.
  `src/shared/**` imports nothing from `server` or `tui`.
- **Entry points stay put.** `src/index.ts`, `src/tui.ts` and `src/rpc.ts` remain
  the build entrypoints, each a thin re-export of its real module, so
  `scripts/build.ts` and the package exports need no semantic change.
- **Repository conventions** from `AGENTS.md`: English, two-space indentation,
  double quotes, no semicolons, no edits to `dist` or dependencies.
- **Verification permissions** from `.agents/CONTEXT.md#verification`: routine
  checks only (`bun run bun-typecheck`, `bun run typecheck`, `bun test`,
  `bun run build`, `bun run pack`). Running OpenCode, `bun run start`, or
  `check:workspaces` needs separate approval from the owner.

## Architecture (builder's call)

```
src/
  index.ts                 entry: export { default } from "./server/plugin.ts"
  tui.ts                   entry: export { default } from "./tui/plugin.ts"
  rpc.ts                   entry: re-exports WorkspaceRPC from shared
  shared/
    schemas.ts             Zod schemas + inferred types (Name, Alias, Workspace,
                           Binding, State, Selection, Action, Change, ...)
    errors.ts              WorkspaceError, WorkspaceErrorCode, errorCode(),
                           unavailable-code helpers, errorText(), unreachable()
    limits.ts              every numeric limit, named and grouped
    rpc-contract.ts        WorkspaceRPC definition (schemas named, not inline)
  server/
    plugin.ts              Plugin.define: validate options, build the runtime,
                           register RPC, hooks and tools, return disposer
    runtime.ts             the per-plugin object holding the owners below and
                           the plugin's Location directory; passed to features
    catalog/
      catalog.ts           Catalog: state, selection, capture, change
      storage.ts           locate/open/validate SQLite, DDL, pragmas
      codec.ts             decode and validate stored workspaces and bindings
      actions.ts           one function per Action kind used inside change()
      catalog-access.ts    lazy read-only/writable lifecycle and disposal
    sessions/
      admission.ts         SessionAdmission: started markers and capacity
      bindings.ts          BindingResolver: knownActive, inactive cache,
                           resolve(), remember(), location checks
    filesystem/
      paths.ts             slash, pathKey, inside, expand, absolute
      policy.ts            sensitive paths, canonical directory/target,
                           checkedTarget, overlapsRoots
      safe-read.ts         the single no-follow, identity-checked bounded read
      browse.ts            directory browsing for the add-folder dialog
    search/
      patterns.ts          glob parsing, alias scoping, regex validation
      walk.ts              ignore-aware traversal
      regex-worker.ts      isolated RegExp worker
      search.ts            searchWorkspace and per-root quotas/statuses
    instructions/
      delivery.ts          snapshot lifecycle: capture, discover, preflight,
                           invalidate
      scopes.ts            target → applicable instruction directories
      sources.ts           reading one AGENTS.md (uses filesystem/safe-read)
      render.ts            WORKSPACE_INSTRUCTIONS block
      patch-targets.ts     native patch target parsing
    hooks/
      context.ts  tool-preflight.ts  compaction.ts  permission.ts
    tools/
      search-tools.ts  status-tool.ts  resolve-tool.ts
    rpc-handlers.ts        state/selection/change/browse with one shared
                           failure → call.error wrapper
    prompts.ts             system text and tool descriptions
  tui/
    plugin.ts              registers commands, indicator, disposal
    target.ts              capture displayed session/Location; validity guard
    menu/
      session.ts           per-open menu state: refresh, change, state()
      main-menu.ts         the loop and option list
      create.ts  switch.ts  add-folder.ts  remove-folder.ts
      delete.ts  status.ts  open-session.ts
    indicator/
      indicator.ts         slot registration and rendering
      selection-poller.ts  refresh, backoff, event and reconnect wiring
      label.ts             grapheme-aware label fitting
    messages.ts            dialog wording
```

The tree is the intended shape, not a contract on every file name. The builder may
merge files that turn out trivially small or split ones that stay large, as long
as the module direction and "one job per file" hold.

### Design rules

- **State has owners.** Stateful concerns become small classes or closures with a
  narrow API (`SessionAdmission`, `BindingResolver`, `CatalogAccess`,
  `InstructionDelivery`, the menu session, the selection poller). Stateless logic
  is plain exported functions.
- **Composition by passing the runtime.** `server/plugin.ts` constructs a runtime
  object once and passes it to `registerRpcHandlers`, `registerHooks` and
  `registerTools`. No globals, no DI container.
- **Duplicates collapse only where they are truly the same.** Exact behavior
  always wins over deduplication (builder's call, following the owner's "no
  functionality changes"). Merge code whose semantics are identical; where two
  copies differ observably, keep both and give each a name that says how it
  differs. Known cases:
  - *Bounded reads.* Search's `boundedRead` (post-read realpath check, reads
    `min(limit, size)`, throws `NOT_FILE`/`PATH_CHANGED`, honors abort) and the
    instruction source reader (pre-open symlink/realpath check, pre-read size
    rejection, reads `limit + 1`, post-read lstat+realpath, returns status
    objects with stage-specific model-visible text) stay two functions. Share
    only identical low-level pieces, such as the open flags and the
    fill-buffer read loop, and only if the call sequence is unchanged.
  - *Path keys.* `paths.ts`'s `pathKey` (slashes, trailing slash stripped, no
    resolve) and `delivery.ts`'s `key` (`path.resolve`, platform separators)
    stay distinct, since `collect()` deduplicates and orders model-visible
    sources by the latter. They may live together in `filesystem/paths.ts`
    under distinct, descriptive names.
  - *Unavailable codes.* The `failure()` set (regex-shaped, includes
    `SQLITE_*`), `overlapsRoots`'s set and search's per-root set stay
    behaviorally distinct, as separate named constants.
- **Text is data.** Long strings move to `server/prompts.ts` and
  `tui/messages.ts` verbatim. Short, single-use error messages may stay inline.
- **Readable control flow.** Prefer early returns, named helpers, and small
  `switch` blocks with `unreachable()` over nested ternaries and one-line
  `if/try` chains. Zod schemas are formatted one field per line.
- **Types.** Export schemas and their inferred types under the same name, as
  today. Prefer `type` aliases for unions, `satisfies` for constant tables,
  `readonly` for inputs that must not be mutated. No `any`, no non-null `!`
  where a narrowing or a checked accessor reads as well.

## Tooling (builder's call)

Add Prettier as a dev dependency with config matching the house style (no
semicolons, double quotes, two-space indent, trailing commas, print width around
100–110). Add `format` and `format:check` scripts. Format `src`, `tests` and
`scripts`; leave Markdown and lockfiles alone. This is the only tooling addition.

## Tests and scripts

- **Remove the phase-zero research probe** (owner's decision): delete
  `tests/fixtures/phase-zero-plugin/`, the tests that exercise only it
  (`binding-journal`, `boundary-probe`, `capability-probe`, `dialog-flow`,
  `instructions-probe`, `journal-pause`), the helpers that exist only for it
  (`instruction-capability`, `journal-capability`, `tui-capability`, and the
  probe-specific parts of `lifecycle-capability`), the runners
  `tests/opencode-*capabilities.ts`, and the `test:capabilities*` scripts in
  `package.json`. Remove the `effect` dev dependency if nothing else uses it.
- **Keep `scripts/check-workspaces.ts` compiling and coherent.** It depends on
  `capability-fixture`, `private-tui`, `scripted-provider`, and through it
  `lifecycle-capability`. Extract what it needs into helpers with no probe
  imports, then refactor the script itself. `createCapabilityFixture()` also
  builds and installs the probe plugin and writes it into the launch and
  `other` `opencode.json` files. Make the smallest change that drops the probe
  build and probe config entries, leaving the rest of the environment setup as
  is. The bar is typechecking only (builder's call): the script is already
  known to fail on stale expectations and needs separate approval to run, so
  the hand-off must state plainly that it was not executed.
- **Preserve instruction-delivery coverage.** Some probe tests were the only
  exercise of the production `delivery.ts`. Port the behaviors they checked that
  apply to production delivery (fresh snapshot contents, first-touch mutation
  block, parallel discovery not leaking into the generating snapshot,
  changed/deleted/new source invalidation, limits) into direct tests of
  `src/server/instructions`. Builder's call on which assertions carry over.
- **Tests are not a constraint on the design** (owner's decision). Unit tests
  follow the code they cover and may be rewritten. The two whole-plugin suites,
  `tests/workspaces.test.ts` and `tests/workspace-tui.test.ts`, should keep
  checking the same behaviors and are the main automated evidence that nothing
  changed; restructure their setup freely.
- Tests and scripts follow the same readability rules as source.

## Documentation

Update `.agents/ARCHITECTURE.md` (diagram, source map, build/verification
surfaces), `.agents/CONTEXT.md` (verification table, phase-zero and capability
references), and the owner table in `AGENTS.md` to the new layout. Check
`.claude/` adapters still point at valid targets. The README changes only if it
references something removed.

## Done means

- `bun run bun-typecheck`, `bun run typecheck`, `bun test`, `bun run build`,
  `bun run pack` and `bun run format:check` all pass.
- `dist/` exports the same three entrypoints and an equivalent `package.json`.
- A side-by-side review of user- and model-visible strings, tool schemas and the
  SQLite DDL against the starting commit (`38da5bf`) shows no differences.
- The owner's manual re-test in OpenCode finds no behavior change.

## Left to the builder

Exact file boundaries within the tree, naming of internal helpers, class versus
closure for each stateful owner, Prettier print width, ordering of the work, and
which unit tests to rewrite versus replace.
