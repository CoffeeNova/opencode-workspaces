# Codebase Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `src/`, `tests/` and `scripts/` into a readable `shared/` + `server/` + `tui/` architecture with zero observable behavior change, and remove the phase-zero research probe.

**Architecture:** Thin entry files (`src/index.ts`, `src/tui.ts`, `src/rpc.ts`) re-export real modules. `shared/` holds schemas, errors, limits and the RPC contract. `server/` splits the 370-line plugin closure into small owners (`CatalogAccess`, `SessionAdmission`, `BindingResolver`, `SessionInstructions`) passed around in one `ServerRuntime` object. `tui/` splits the 200-line menu closure into a `MenuSession` plus one function per flow. A golden "surface" snapshot test, written before any move, is the tripwire for drift.

**Tech Stack:** Bun 1.4.3 (runtime, test, SQLite, build), TypeScript 5.8.3 strict, Zod 4.1.8, OpenCode plugin SDK 2.0.30, OpenTUI 0.5.17 + Solid 1.9.15, Prettier (new, dev only).

**Spec:** `docs/superpowers/specs/2026-10-20-codebase-refactor-design.md`. Read it before starting; it defines "behaves exactly the same".

## Global Constraints

- No functional change. Every user-visible and model-visible string, error code, tool name/description/schema, RPC/plugin ID, slash command, SQLite DDL/pragma and limit stays identical (spec § "What behaves exactly the same means").
- Starting commit for all comparisons: `38da5bf`.
- No `await` between the admission check and `catalog.change(...)` in the `change` RPC; hooks call `admission.markStarted(sessionID)` synchronously before their first `await`; instruction `preflight` pins the message snapshot before its first `await`. Keep a comment at each site.
- Permission rejection/cancellation keeps propagating; every current rethrow/swallow keeps its exact semantics.
- `src/tui/**` imports only `src/shared/**` and host UI packages. `src/shared/**` imports nothing from `server`/`tui`.
- **Spy compatibility:** tests patch `Catalog.existing`, `Catalog.defaultPath`, `Catalog.prototype.selection`, and `fs.open`/`fs.realpath`/`fs.lstat`/`fs.mkdir`. Keep these as static/instance members of `Catalog`, always call them through `Catalog.` / the instance, and always use `import * as fs from "node:fs/promises"` with `fs.x(...)` calls (never destructured imports) in production code.
- No changes to `tsconfig*.json` or runtime dependencies. Dev dependency changes: add `prettier` (exact pin, no caret), remove `effect` only if unused after Task 1.
- Style: English, two-space indent, double quotes, no semicolons, Prettier `printWidth: 100`. One statement per line. No multi-statement one-liners, no single-line `try { } catch { }` with logic.
- Each file has one job; target under ~150 lines. Stateless logic is plain functions; stateful owners are small classes.
- Do not edit `dist/`, `node_modules/`, or archives. Do not run OpenCode, `bun run start`, `check:workspaces`, or live capability scripts.
- Commit after every task, message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Windows path case and separators.** `C:\Repo` vs `c:/repo/x`: containment, dedupe and "already registered" checks must match as before. `pathKey` and the instruction `resolvedKey` must not be swapped. Pinned in Task 5.
2. **Footer label fitting** for wide/grapheme names (emoji, CJK, combining marks) at 8–28 columns, with and without the `!` mark. Pinned in Task 11.
3. **Event-emit failure after a committed change.** `rpc.events.emit` throwing must not fail `change` or the context hook. Pinned in Task 9.
4. **Catastrophic regex in `workspace_grep`.** It must still reject with `REGEX_TIMEOUT` and the same message, and the worker must be terminated. Pinned in Task 6.
5. **Instruction source read failures.** Invalid UTF-8, NUL bytes and oversize files must keep their exact stage-specific error text in the model-visible block. Pinned in Task 7.

---

## Prerequisite (owner or executor, before Task 1)

- [x] Bun 1.4.3 is installed at `~/.bun/bin/bun.exe` but is **not** on the Git Bash `PATH`, and shell state does not persist between commands. Prefix every command with `export PATH="$HOME/.bun/bin:$PATH";`.
- [x] Baseline at `08d37ea` is green: `bun run bun-typecheck` exits 0, and `bun test` gives **112 pass, 0 fail across 11 files**.

---

### Task 1: Remove the phase-zero research probe

**Files:**
- Delete: `tests/fixtures/phase-zero-plugin/` (whole folder), `tests/binding-journal.test.ts`, `tests/boundary-probe.test.ts`, `tests/capability-probe.test.ts`, `tests/dialog-flow.test.ts`, `tests/journal-pause.test.ts`, `tests/helpers/instruction-capability.ts`, `tests/helpers/journal-capability.ts`, `tests/helpers/tui-capability.ts`, `tests/helpers/lifecycle-capability.ts`, `tests/opencode-capabilities.ts`, `tests/opencode-instruction-capabilities.ts`, `tests/opencode-tui-capabilities.ts`
- Move: `tests/helpers/capability-fixture.ts` → `tests/live/fixture.ts`; `tests/helpers/private-tui.ts` → `tests/live/private-tui.ts`; `tests/helpers/scripted-provider.ts` → `tests/live/scripted-provider.ts`; `tests/helpers/terminal-screen.ts` → `tests/live/terminal-screen.ts`; `tests/terminal-screen.test.ts` → `tests/live/terminal-screen.test.ts`
- Move + re-point: `tests/instructions-probe.test.ts` → `tests/instructions.test.ts`
- Modify: `scripts/check-workspaces.ts` (imports), `package.json` (remove the `test:capabilities`, `test:capabilities:tui` and `test:capabilities:instructions` scripts; remove `effect` if `grep -r '"effect' src tests scripts` finds nothing)

**Interfaces:**
- Produces: `tests/live/scripted-provider.ts` exports `scriptedProvider()`, `heldReply()`, `type ScriptedCall`, `type ScriptedReply`. These are moved in from `lifecycle-capability.ts` unchanged.
- Produces: `tests/live/fixture.ts` exports `createLiveFixture(providerOrigin)` (renamed from `createCapabilityFixture`), `openCodeExecutable()`, `startLiveServer(executable, fixture)` (renamed from `startCapabilityServer`), `isolatedEnvironment(base)`, `slash`, `CAPABILITY_RUNTIME`, `CAPABILITY_SDK`.

- [ ] **Step 1:** Delete the files listed above and move the live helpers. In `createLiveFixture`, remove the probe `Bun.build`, the `probe-package` directory, its manifest and `node_modules` junction, and the probe `plugins` entry. Write the config into `launch` only (drop the `other` directory's `opencode.json`, but keep creating `other`). Rename the temp-dir prefix from `workspace-phase-zero-` to `workspace-live-`. Leave everything else (provider, formatter, git repos, markers) as is.
- [ ] **Step 2:** In `tests/live/terminal-screen.test.ts`, delete the test `"wrapped Location output preserves the case-sensitive session identity"` (it depends on probe-only `tuiTargetVisible`). Keep the other two.
- [ ] **Step 3:** In `tests/instructions.test.ts`, import `instructionDelivery`, `instructionBlock` and `patchTargets` straight from `../src/instructions/delivery.ts`. Define a local helper `sourceContent(source)` that returns `source.content` when `"content" in source`. Change no assertion. Any assertion that relied on the probe header `WORKSPACE_INSTRUCTION_PROBE` now expects `WORKSPACE_INSTRUCTIONS`. Check with `grep -n PROBE tests/instructions.test.ts`; the planning survey found none.
- [ ] **Step 4:** Point `scripts/check-workspaces.ts` at `../tests/live/*` with the new names.
- [ ] **Step 5: Verify**
  Run: `bun run bun-typecheck && bun test`
  Expected: exit 0. All remaining tests pass, and `grep -rn "phase-zero\|capability-probe\|tuiTargetVisible" src tests scripts package.json` prints nothing.
- [ ] **Step 6: Commit** `test: remove phase-zero research probe and keep live harness helpers`

---

### Task 2: Freeze the observable surface (golden snapshot)

This test is written against the **current** code and must pass unchanged through every later task. A snapshot diff in a later task is a regression, never a reason to update the snapshot. The only exception is an import path the test itself uses.

**Files:**
- Create: `tests/surface.test.ts`, `tests/__snapshots__/surface.test.ts.snap` (generated)
- Create: `tests/helpers/tui-host.ts`, which extracts the `fixture()` function from `tests/workspace-tui.test.ts` so both files can use it
- Modify: `tests/workspace-tui.test.ts` (import `tuiHost` instead of its local `fixture`)

**Interfaces:**
- Produces: `tuiHost(initial?: Route)` in `tests/helpers/tui-host.ts`, returning the same object the current local `fixture()` returns.
- Produces: `normalize(text: string, base: string): string` (local to the test). It replaces the temp `base` path (both slash forms) with `<base>` and every UUID with `<uuid>`.

- [ ] **Step 1: Write `tests/surface.test.ts`** with these snapshot tests, each using `toMatchSnapshot()` on normalized data:
  - `"tool surface"`: after attaching `ses_a` to a workspace with one root, for each tool in `server.tools` in insertion order: `{ name, description, input, options }`.
  - `"system context text"`: the last `event.system` entry text pushed by `server.context(server.request("ses_a"))` for that active session, normalized.
  - `"rpc contract"`: for each method in `WorkspaceRPC.methods` in key order: `z.toJSONSchema` of `input` and `output`. Also `z.toJSONSchema` of `WorkspaceRPC.events.changed.schema`.
  - `"catalog storage"`: after `Catalog.open` on a fresh temp path, `SELECT type, name, sql FROM sqlite_master ORDER BY name`, plus `PRAGMA application_id`, `user_version` and `journal_mode`.
  - `"menu transcript"`: using `tuiHost()`, script one pass that creates `alpha`, adds the server's `root` folder with the default alias, shows status, switches/attaches here, then opens "Delete saved definition" and cancels the confirm. Snapshot every dialog call in order: kind, title, message/placeholder/description, option `{title, description, value, category}`, plus toasts.
  - `"commands"`: the registered keymap commands `{ id, title, group, slash, palette }`.
  - `"error messages"`: for each of these RPC/tool failures, `{ code, message }`. Each comes from an existing scenario in `workspaces.test.ts`.
    - `change` with a stale revision → `REVISION_CONFLICT`
    - reused requestID with a different action → `REQUEST_CONFLICT`
    - create with a duplicate name → `WORKSPACE_EXISTS`
    - addRoot with a duplicate explicit alias → `ALIAS_EXISTS`
    - attach on a started session → `SESSION_STARTED`
    - `workspace_status` on a passive session → `NO_WORKSPACE`
    - `workspace_resolve` with `nope:/x` → `INVALID_PATH`
    - a native `glob` over a bound root → `USE_WORKSPACE_SEARCH`
    - a native `read` with a relative path → `INVALID_PATH`
- [ ] **Step 2: Run to generate and confirm stability**
  Run: `bun test tests/surface.test.ts` twice.
  Expected: PASS both times. The second run writes no snapshot changes (normalization is complete).
- [ ] **Step 3: Verify the whole suite** with `bun test`. Expected: PASS.
- [ ] **Step 4: Commit** `test: snapshot the plugin's observable surface before refactoring`

---

### Task 3: Add Prettier and format everything

**Files:**
- Create: `.prettierrc.json` → `{ "semi": false, "printWidth": 100, "trailingComma": "all" }`
- Create: `.prettierignore` → `dist`, `node_modules`, `coverage`, `*.md`, `bun.lock`, `docs`, `.agents`, `.claude`
- Modify: `package.json`: add `"format": "prettier --write src tests scripts"` and `"format:check": "prettier --check src tests scripts"`, and add `prettier` to `devDependencies`, pinned to the exact latest 3.x version
- Modify: every `.ts` under `src`, `tests` and `scripts` (formatting only)

- [ ] **Step 1:** `bun add --dev --exact prettier`, then add the config files and scripts.
- [ ] **Step 2:** `bun run format`
- [ ] **Step 3: Verify** with `bun run format:check && bun run bun-typecheck && bun test`. Expected: all exit 0, and surface snapshots unchanged.
- [ ] **Step 4: Commit** `style: add Prettier and format src, tests and scripts`

From here on, every task ends with `bun run format` before its verify step.

---

### Task 4: `shared/`: schemas, errors, limits, RPC contract, thin entries

**Files:**
- Create: `src/shared/schemas.ts`, `src/shared/errors.ts`, `src/shared/limits.ts`, `src/shared/rpc-contract.ts`
- Modify: `src/rpc.ts` → `export { WorkspaceRPC } from "./shared/rpc-contract.ts"`
- Delete: `src/domain.ts`
- Modify: every importer of `domain.ts` / `rpc.ts` in src, tests and scripts

**Interfaces:**
- Produces `src/shared/errors.ts`: `UNAVAILABLE_ERROR_CODES` (the current literal list), `type UnavailableCode`, `type WorkspaceErrorCode` (identical union), `class WorkspaceError`, `errorCode(error: unknown): string | undefined`, `isUnavailableCode(code: string | undefined): code is UnavailableCode`, `errorText(error: unknown): string` (moved from `tui.ts`), `unreachable(value: never): never`.
- Produces `src/shared/schemas.ts`: the same exported names as `domain.ts` (`Name`, `Alias`, `SessionID`, `WorkspaceID`, `Root`, `Workspace`, `Binding`, `State`, `Selection`, `Action`, `Change` and their types), plus newly named schemas lifted from `rpc.ts`: `SelectionWorkspace`, `BrowsePage` (+ type), `ChangedEvent`. Format objects one field per line. `Name`'s refine predicate becomes a named function `isPrintableName`, and the reserved names become the constant `RESERVED_NAMES`.
- Produces `src/shared/limits.ts`: grouped `as const` objects with **exactly** the current values:
  - `CATALOG_LIMITS = { roots: 20, workspaces: 1000, bindings: 10_000, receipts: 256, busyTimeoutMs: 5000, nameLength: 100, aliasLength: 100, suggestedAliasLength: 90 }`
  - `SESSION_LIMITS = { admissionMarkers: 10_000, inactiveCache: 2048 }`
  - `SEARCH_LIMITS = { globResults: 200, grepResults: 100, entriesPerRoot: 10_000, grepBytesPerRoot: 8 * 1024 * 1024, readBytes: 200 * 1024, patternLength: 4096, excludes: 32, lineClip: 2000, regexTimeoutMs: 1000 }`
  - `INSTRUCTION_LIMITS = { fileBytes: 32 * 1024, aggregateBytes: 64 * 1024, minContextTokens: 128_000, scopes: 128 }`
  - `BROWSE_LIMITS = { directories: 100 }`
  - `INDICATOR_TIMING = { requestTimeoutMs: 5000, retryMs: 2000, maxRetryMs: 10_000, minColumns: 8, maxColumns: 28 }`
- Produces `src/shared/rpc-contract.ts`: `WorkspaceRPC`, identical to today but referencing the named schemas.

- [ ] **Step 1:** Create the four modules and replace every magic number in `src` that matches a limit above with the constant. The worker source string interpolates `SEARCH_LIMITS.lineClip`. `CATALOG_LIMITS.roots` is used by both `Workspace.roots.max` and `SelectionWorkspace.rootCount.max`.
- [ ] **Step 2:** Update imports everywhere and delete `src/domain.ts`.
- [ ] **Step 3: Verify** with `bun run format && bun run bun-typecheck && bun test`. Expected: exit 0 and surface snapshots unchanged. Also run `grep -rn "server/" src/shared src/tui src/tui.ts`, which should print nothing.
- [ ] **Step 4: Commit** `refactor: introduce shared schemas, errors, limits and RPC contract`

---

### Task 5: `server/filesystem/`

**Files:**
- Create: `src/server/filesystem/paths.ts`, `policy.ts`, `safe-read.ts`, `browse.ts`
- Delete: `src/infrastructure/paths.ts`
- Modify: importers; `src/infrastructure/search.ts` uses `safe-read.ts`; `src/instructions/delivery.ts` uses `paths.ts` resolved-key helpers and `safe-read.ts` primitives
- Test: rename `tests/filesystem.test.ts` → `tests/server/filesystem.test.ts` (path-policy `describe` only); `tests/server/search.test.ts` receives the search `describe`; the README PowerShell test moves to `tests/readme.test.ts`

**Interfaces:**
- `paths.ts`:
  - `slash(value)`, `pathKey(value)` (unchanged semantics)
  - `isInside(root, candidate)` (was `inside`)
  - `expandPath(raw)` (was `expanded`), `resolvePath(raw, base)` (was `absolute`)
  - `resolvedKey(value)` and `isInsideResolved(root, target)`, which are delivery's `key`/`inside` moved verbatim. They stay distinct from `pathKey`/`isInside`.
- `policy.ts`: `assertNotDenied(value)`, `isMissingOrInaccessible(error)` (the current `unavailable` list in paths.ts, verbatim), `canonicalDirectory(raw, base)`, `canonicalTarget(candidate)`, `overlapsRoots(candidate, roots)`, `checkedTarget(raw, roots)`, `suggestedAlias(directory)`.
- `safe-read.ts`:
  - `NO_FOLLOW_READ` (the `O_RDONLY | O_NOFOLLOW` flag expression)
  - `fillBuffer(handle, buffer, signal?)`: the read loop. It checks `signal` each iteration only when given, and returns the bytes read.
  - `boundedRead(file, limit, signal?)` (search's version, same call order)
  - `decodeUtf8(bytes, truncated?)` (was search's `decode`)
- `browse.ts`: `browseDirectory(raw, base): Promise<BrowsePage>` (was `browse`).

- [ ] **Step 1: Characterization tests first (Review Focus 1).** Add to `tests/server/filesystem.test.ts`, gated `test.skipIf(process.platform !== "win32")`. Write them against the current module, run them, and confirm they PASS:
  - `"checkedTarget matches roots case- and separator-insensitively on Windows"`: root `slash(realRoot)`. `checkedTarget(realRoot.toUpperCase().replaceAll("/", "\\") + "\\file.txt", roots)` returns the candidate path (not undefined) and does not throw.
  - `"instruction scopes deduplicate case variants of one directory"`: an `instructionDelivery` whose root is given in lower case and whose discovered target is upper case. `capture()` yields exactly one source for that `AGENTS.md`.
- [ ] **Step 2:** Create the modules, move the code, and update the callers. In `delivery.ts`, replace its local `key`/`inside`/read loop/open flags with the shared ones. Do not change its check order or returned status objects.
- [ ] **Step 3: Verify** with `bun run format && bun run bun-typecheck && bun test`. Expected: PASS, snapshots unchanged.
- [ ] **Step 4: Commit** `refactor: split server filesystem paths, policy, safe reads and browsing`

---

### Task 6: `server/search/`

**Files:**
- Create: `src/server/search/patterns.ts`, `walk.ts`, `regex-worker.ts`, `search.ts`
- Delete: `src/infrastructure/search.ts`
- Test: `tests/server/search.test.ts`

**Interfaces:**
- `patterns.ts`: `compileGlob(raw): Bun.Glob` (was `searchPattern`), `globScope(pattern, alias)`, `assertValidRegex(pattern)` (the two current grep checks, same codes and messages).
- `walk.ts`: `type SearchRoot`, `type FileEntry`, `walk(roots, signal, options)` (same options, same order of checks).
- `regex-worker.ts`: `class RegexMatcher` (`match`, `close`), `type RegexHit`.
- `search.ts`: the `searchWorkspace` overloads and result/input types, unchanged. Its per-root `catch` code list becomes the named constant `ROOT_UNAVAILABLE_CODES` (verbatim). Extract `searchRoot(...)` for the per-root body and `rootQuota(limit, rootCount, index)`.

- [ ] **Step 1: Characterization test (Review Focus 4).** Against the current module, add `"catastrophic regex rejects with REGEX_TIMEOUT"`: one root with a file containing `"a".repeat(40) + "b"`. `searchWorkspace(roots, { kind: "grep", pattern: "^(a+)+$" }, access)` rejects with a `WorkspaceError` whose `code` is `"REGEX_TIMEOUT"` and whose message is exactly `"REGEX_TIMEOUT: Fallback regex exceeded its one-second timeout; simplify the pattern or install ripgrep"`. Run it and confirm PASS.
- [ ] **Step 2:** Move and split the code. Update the imports in `src/index.ts` and the tests.
- [ ] **Step 3: Verify** with `bun run format && bun run bun-typecheck && bun test`. Expected: PASS, snapshots unchanged.
- [ ] **Step 4: Commit** `refactor: split workspace search into patterns, walk, regex worker and search`

---

### Task 7: `server/instructions/`

**Files:**
- Create: `src/server/instructions/delivery.ts`, `scopes.ts`, `sources.ts`, `render.ts`, `patch-targets.ts`
- Delete: `src/instructions/delivery.ts`
- Test: `tests/instructions.test.ts` → `tests/server/instructions.test.ts`

**Interfaces:**
- `delivery.ts`:
  - types `InstructionRoot`, `InstructionSource`, `DeliveredSource`, `InstructionSnapshot`, `InstructionLimits = { file: number; aggregate: number }`
  - `class InstructionError` (same codes)
  - `type InstructionDelivery = { capture(contextLimit?): Promise<InstructionSnapshot>; discover(targets): Promise<void>; preflight(messageID, targets): Promise<string>; invalidate(): void }`
  - `createInstructionDelivery(roots, authorize, limits = { file: INSTRUCTION_LIMITS.fileBytes, aggregate: INSTRUCTION_LIMITS.aggregateBytes }): InstructionDelivery` (was `instructionDelivery`)
- `scopes.ts`: `instructionDirectories(roots, target): Promise<string[]>` (was `targetDirectories`).
- `sources.ts`: `readInstructionSource(directory, authorize, fileLimit): Promise<InstructionSource>` (was `source`). It keeps `authorize` outside the `try`, and keeps every status text verbatim.
- `render.ts`: `instructionBlock(snapshot)`. Drop the `header` parameter, since only the deleted probe used it, and hard-code `WORKSPACE_INSTRUCTIONS`. Move the policy sentence into the constant `INSTRUCTION_POLICY`.
- `patch-targets.ts`: `patchTargets(patchText)`.

- [ ] **Step 1: Characterization tests (Review Focus 5).** Against the current module, add three tests. Each writes a root `AGENTS.md`, calls `capture()`, and asserts `snapshot.errors` equals exactly the current text:
  - invalid UTF-8 bytes `[0xff, 0xfe]` → `["<path>: Invalid UTF-8"]`
  - content `"a\0b"` → `["<path>: Binary instruction source"]`
  - 33 KiB file with default limits → `["<path>: File exceeds 32768 bytes"]`
  Run them and confirm PASS.
- [ ] **Step 2:** Move and split the code. In `src/index.ts`, rename the call sites to `createInstructionDelivery`.
- [ ] **Step 3: Verify** with `bun run format && bun run bun-typecheck && bun test`. Expected: PASS, snapshots unchanged.
- [ ] **Step 4: Commit** `refactor: split instruction delivery into scopes, sources, render and patch parsing`

---

### Task 8: `server/catalog/`

**Files:**
- Create: `src/server/catalog/catalog.ts`, `storage.ts`, `codec.ts`, `actions.ts`
- Delete: `src/infrastructure/catalog.ts` (and the now-empty `src/infrastructure/`)
- Test: `tests/catalog.test.ts` → `tests/server/catalog.test.ts`

**Interfaces:**
- `catalog.ts`: `class Catalog` with **unchanged public API**:
  - statics `defaultPath()`, `existing(raw, base)`, `open(raw, base, create = true)`
  - instance `close()`, `state(sessionID?)`, `selection(sessionID)`, `capture(sessionID, directory)`, `change(input, directory, emptySession, canonicalRoot?)`
  - `change` keeps its receipt check, revision check, revision bump, receipt insert and receipt pruning inline, and delegates the `switch` arms to `actions.ts`.
- `storage.ts`:
  - `APPLICATION_ID = 0x57534d32`, `STORAGE_VERSION = 2`, `SCHEMA_SQL` (the exact DDL text)
  - `locateCatalog(raw, base, create)`
  - `assertCatalogFormat(db, { allowEmpty, exists })`, which covers both the read-only and the writable header checks with identical messages
  - `configureConnection(db)` for the busy timeout
  - `enableDurableWrites(db)` for WAL + `synchronous=FULL`
- `codec.ts`: `type BindingRow`, `type CatalogMeta`, `readMeta(db)`, `decodeWorkspace(raw, expectedID?)`, `decodeBinding(row)`.
- `actions.ts`: `type ActionContext = { db: Database; sessionID: string | undefined; directory: string; emptySession: boolean; canonicalRoot: string | undefined; workspaces(): Workspace[] }`, plus `applyBindingAction`, `applyCreate`, `applyRemove`, `applyAddRoot`, `applyRemoveRoot`. Each has the same checks in the same order with the same codes and messages.

- [ ] **Step 1:** Move and split the code. Keep `Catalog.existing`/`open`/`defaultPath` as statics and `selection` as a prototype method (spy compatibility).
- [ ] **Step 2: Verify** with `bun run format && bun run bun-typecheck && bun test`. Expected: PASS, with the `"catalog storage"` snapshot unchanged.
- [ ] **Step 3: Commit** `refactor: split catalog into storage, codec and per-action handlers`

---

### Task 9: Server composition: runtime, sessions, RPC, hooks, tools, prompts

**Files:**
- Create:
  - `src/server/plugin.ts`, `src/server/runtime.ts`, `src/server/failures.ts`, `src/server/prompts.ts`
  - `src/server/catalog/catalog-access.ts`
  - `src/server/sessions/admission.ts`, `src/server/sessions/bindings.ts`, `src/server/sessions/guards.ts`
  - `src/server/instructions/session-instructions.ts`
  - `src/server/rpc-handlers.ts`
  - `src/server/hooks/context.ts`, `src/server/hooks/tool-preflight.ts`, `src/server/hooks/compaction.ts`, `src/server/hooks/permission.ts`
  - `src/server/tools/index.ts`, `src/server/tools/search-tools.ts`, `src/server/tools/status-tool.ts`, `src/server/tools/resolve-tool.ts`
- Modify: `src/index.ts` → `export { default } from "./server/plugin.ts"`
- Test: `tests/workspaces.test.ts` → `tests/server/plugin.test.ts`; `tests/helpers/workspace-server.ts` updates its imports

**Interfaces:**
- `failures.ts`: `toWorkspaceFailure(error: unknown): WorkspaceError`, which is today's `failure()` verbatim and rethrows non-unavailable errors.
- `catalog-access.ts`: `class CatalogAccess`
  - `constructor(configuredPath: string | undefined, directory: string)`
  - `reader(): Promise<Catalog | undefined>` (today's `metadataCatalog`, same caching and in-flight sharing)
  - `writer(create: boolean): Promise<Catalog>` (today's `writableCatalog`)
  - `dispose(): void`, which sets disposed and closes both catalogs
  - Path resolution calls `Catalog.defaultPath()` lazily, once, with reset on failure.
- `admission.ts`: `class SessionAdmission`
  - `markStarted(sessionID): void`, which warns with the exact current text on saturation
  - `hasStarted(sessionID): boolean`, `get saturated(): boolean`
  - `admits(sessionID: string | undefined): boolean`, equal to `!!sessionID && !saturated && !hasStarted(sessionID)`
  - `clear(): void`
- `bindings.ts`:
  - `type InactiveResolution`, `type Resolution` (same shapes)
  - `class BindingResolver` with `constructor(directory, catalogs: CatalogAccess)`, `remember(sessionID, binding)`, `selection(sessionID)`, `resolve(sessionID): Promise<Resolution>`, `isKnownActive(sessionID)`, `forgetActive(sessionID)`, `clear()`
  - Warning text verbatim; inactive cache bounded by `SESSION_LIMITS.inactiveCache`.
- `session-instructions.ts`: `class SessionInstructions`
  - `deliveryFor(sessionID)`, `ensureDelivery(sessionID, roots, authorize): InstructionDelivery`
  - `status(sessionID): Selection["instructions"]`, `setStatus(sessionID, status)`
  - `invalidate(sessionID)` (compaction: invalidate delivery + delete status), `clear()`
- `runtime.ts`: `type ServerRuntime = { ctx: Plugin.Context; directory: string; catalogs: CatalogAccess; admission: SessionAdmission; bindings: BindingResolver; instructions: SessionInstructions }` and `createRuntime(ctx, directory, configuredPath): ServerRuntime`.
- `guards.ts`:
  - `verifySessionLocation(runtime, sessionID)` (today's `session()`)
  - `canAttach(runtime, sessionID, binding)`
  - `requireActiveBinding(runtime, sessionID)` (today's `workspaceBinding`, same `ToolError` wrapping)
- `rpc-handlers.ts`:
  - `type ChangedEmitter = (payload: z.infer<typeof ChangedEvent>) => Promise<void>`
  - `registerRpcHandlers(runtime): Promise<ChangedEmitter>`
  - One private `handle(call, work)` wrapper replaces the four copied `try/catch → call.error("workspace", …)` blocks.
- `hooks/*`:
  - `registerContextHook(runtime, emitChanged)`, `registerToolPreflight(runtime)`, `registerCompactionHook(runtime)`, `registerPermissionHook(runtime)`
  - Registration order is unchanged: context, compaction, execute.before, evaluate.
  - `NATIVE_GUARDED_TOOLS` is the `["read", …, "grep"]` list.
  - The `NativeTarget` schema lives in `tool-preflight.ts`.
  - `nativeTargets(tool, input)` holds the patch/shell/path selection logic.
- `tools/index.ts`: `registerWorkspaceTools(runtime)` calls `ctx.tool.transform` once and adds glob, grep, status and resolve **in that order**. The other tool files each export a factory returning the tool definition. `GlobSearch`, `GrepSearch` and `parseSearchInput` live in `search-tools.ts`.
- `prompts.ts`: `workspaceSystemText(workspace, block)`, `searchToolDescription(kind)`, `STATUS_TOOL_DESCRIPTION`, `RESOLVE_TOOL_DESCRIPTION`. All text is byte-identical.
- `plugin.ts`: `Plugin.define({ id: "workspace-manager.v2", setup })`. `setup` validates `options.catalogPath` (same message), realpaths the directory, creates the runtime, registers RPC → hooks → tools in today's order, and on failure disposes and rethrows. The returned disposer clears all owners and closes the catalogs.

- [ ] **Step 1: Characterization test (Review Focus 3).** Add `"a failing change notification never fails a committed change or the context hook"` to `tests/server/plugin.test.ts` against the current code. Extend `workspaceServer` with `failEvents(error)`, which makes `events.emit` reject. With it set:
  - `server.change({ kind: "create", name: "alpha" })` resolves, and `rpc.state()` lists `alpha`.
  - After attaching `ses_a`, `server.context(server.request("ses_a"))` resolves and pushes the workspace system text.
  Run it and confirm PASS.
- [ ] **Step 2:** Build the modules above. In the `change` handler, keep the comment and keep `admission.admits(...)` immediately before `catalog.change(...)`, with no `await` between them. Every hook's first statement is `runtime.admission.markStarted(event.sessionID)`.
- [ ] **Step 3: Verify** with `bun run format && bun run bun-typecheck && bun test`. Expected: PASS, with all surface snapshots unchanged (tool surface, system text and error messages especially). `src/index.ts` is one line.
- [ ] **Step 4: Commit** `refactor: compose the server from runtime owners, RPC handlers, hooks and tools`

---

### Task 10: TUI menu

**Files:**
- Create:
  - `src/tui/plugin.ts`, `src/tui/target.ts`, `src/tui/messages.ts`
  - `src/tui/menu/session.ts`, `src/tui/menu/main-menu.ts`
  - `src/tui/menu/create.ts`, `src/tui/menu/switch.ts`, `src/tui/menu/add-folder.ts`, `src/tui/menu/remove-folder.ts`, `src/tui/menu/delete.ts`, `src/tui/menu/status.ts`, `src/tui/menu/open-session.ts`
- Modify: `src/tui.ts` → `export { default } from "./tui/plugin.ts"`
- Test: `tests/workspace-tui.test.ts` → `tests/tui/menu.test.ts`; `tests/helpers/tui-host.ts` imports

**Interfaces:**
- `target.ts`: `type MenuTarget = { sessionID: string | undefined; location: Location }`, `currentTarget(context): MenuTarget` (same error text), `isSameTarget(a, b): boolean`.
- `menu/session.ts`: `class MenuSession`
  - `constructor(context, rpc, indicator, target, signal)`
  - `isValid(): boolean`, `refresh(): Promise<boolean>`, `change(action, sessionID?): Promise<boolean>`
  - `get state(): State`, which throws the same "not loaded" error
  - `currentDefinition(): Workspace | undefined`, `choose(requireFolders?): Promise<Workspace | undefined>`
  - `change` keeps: indicator refresh, then the swallowed toast, then validity.
- Flows, each `(menu: MenuSession, …) => Promise<void>`:
  - `createWorkspace(menu)`
  - `switchWorkspace(menu)`, `attachWorkspace(menu, workspace)`
  - `addFolder(menu, workspace)`
  - `removeFolder(menu)`
  - `deleteWorkspace(menu)`
  - `showStatus(menu)`
  - `openInNewSession(menu, workspace)`, `openOrdinarySession(menu)`, `detach(menu)`
- `main-menu.ts`:
  - `type MenuEntry = "main" | "add" | "switch"`
  - `runMenu(menu, entry): Promise<void>`: entry dispatch, the main loop, option list building, and the outer "Workspace action stopped" alert
  - `menuOptions(state)` builds the option list
- `plugin.ts`: `Plugin.define({ id: "workspace-manager.v2.tui", setup })`. A `MENU_COMMANDS` table holds `[name, entry, title]`, and the `running` guard and target-unavailable alert behave exactly as today.
- `messages.ts`: every dialog title/message/description string longer than a few words, verbatim.

- [ ] **Step 1: Characterization test.** Against the current code, add `"a second open while a menu is running is ignored"` to the TUI tests. Open `/workspace`, hold the first select pending, invoke the command again, and assert that only one `state` RPC call and one select dialog were recorded. Run it and confirm PASS.
- [ ] **Step 2:** Split the code as above. `src/tui/**` imports only `src/shared/**` and host UI packages.
- [ ] **Step 3: Verify** with `bun run format && bun run bun-typecheck && bun test`. Expected: PASS, with the `"menu transcript"` and `"commands"` snapshots unchanged. Also run `grep -rn "server/" src/tui src/tui.ts`, which should print nothing.
- [ ] **Step 4: Commit** `refactor: split the TUI menu into a session object and one module per flow`

---

### Task 11: TUI footer indicator

**Files:**
- Create: `src/tui/indicator/indicator.ts`, `selection-poller.ts`, `label.ts`
- Delete: `src/tui/indicator.ts`
- Test: `tests/tui/label.test.ts`

**Interfaces:**
- `label.ts`: `fitLabel(name: string, columns: number, blocked = false): string` (was `label`), and `labelBudget(columns: number): number`, which clamps `floor(columns / 3)` to `INDICATOR_TIMING.minColumns..maxColumns`.
- `selection-poller.ts`: `watchSelection(options): () => void`. `options` = `{ rpc, context, sessionID, location, knownActive: Set<string>, onSelection(selection | undefined), onUnavailable(boolean), refreshers: Set<() => void> }`. It holds the busy/queued/backoff/timer logic and the `changed`, `server.connected` and `session.deleted` listeners, and returns the cleanup.
- `indicator.ts`: `registerWorkspaceIndicator(context): { refresh(): void; dispose(): void }`, unchanged.

- [ ] **Step 1: Characterization tests (Review Focus 2).** Before moving anything, temporarily export `label` from the current `src/tui/indicator.ts`. Record its output in `tests/tui/label.test.ts` as a `test.each` table with these rows:
  - `("alpha", 28)`
  - `("workspace-beta-very-long-display-name-for-small-terminals", 21)`
  - `("日本語のワークスペース名", 12)`
  - `("👩‍👩‍👧‍👦family", 10)`
  - `("e\u0301tude", 8)`
  - each of the above with `blocked = true`
  - `labelBudget` at 10, 30, 64, 84 and 200 columns
  Paste the observed outputs as literal expectations, run, and confirm PASS.
- [ ] **Step 2:** Split the code. Point the test at `fitLabel`/`labelBudget` and change no expected value.
- [ ] **Step 3: Verify** with `bun run format && bun run bun-typecheck && bun test`. Expected: PASS.
- [ ] **Step 4: Commit** `refactor: split footer indicator into label fitting, selection polling and rendering`

---

### Task 12: Tests and scripts get the same treatment

**Files:**
- Modify:
  - `tests/helpers/workspace-server.ts`: split into small named functions (`createFakeHost`, `createRpcClient`, `createRequest`); keep the returned API
  - `tests/helpers/tui-host.ts`
  - `tests/server/*.test.ts`, `tests/tui/*.test.ts`, `tests/live/*.ts`
  - `scripts/build.ts`, `scripts/pack.ts`, `scripts/start.ts`, `scripts/check-workspaces.ts`
- Create: `scripts/lib/externals.ts`, which exports `HOST_EXTERNALS`, the external list from `build.ts`; `check-workspaces.ts` reuses it instead of its copy

**Rules for this task:**
- Test assertions may be reorganized, but each existing test name's checked behavior stays covered.
- `check-workspaces.ts` is split into named phases (`setUpPackage`, `checkMenuFlow`, `checkNativeTools`, `checkSearch`, `checkPathPreflight`, `checkPermissions`, `checkRestart`). Its assertions and expectations are not changed, including the known-stale `[ws:none]`.
- `start.ts` is split into `findOpenCode`, `ensureLauncherConfig` and `verifyService`, with messages unchanged.

- [ ] **Step 1:** Refactor the files listed above.
- [ ] **Step 2: Verify** with `bun run format:check && bun run bun-typecheck && bun run typecheck && bun test && bun run build && bun run pack`. Expected: all exit 0. `dist/` contains `index.js`, `tui.js`, `rpc.js`, `package.json` and `README.md`, and the `dist/package.json` `exports` are unchanged. Delete the generated `.tgz` afterwards.
- [ ] **Step 3: Commit** `refactor: restructure test helpers and scripts for readability`

---

### Task 13: Documentation and the final drift audit

**Files:**
- Modify: `.agents/ARCHITECTURE.md` (diagram, source map, build/verification surfaces), `.agents/CONTEXT.md` (verification table: drop `test:capabilities*`, the phase-zero mentions and capability-fixture wording; add `format:check`), `AGENTS.md` (owner table paths, plus `format` in Verification), `README.md` only if it references removed files
- Check: `.claude/commands/audit.md`, `.claude/skills/typescript-best-practices/SKILL.md`, `.claude/rules/typescript-best-practices.md` still point at existing `.agents` targets

- [ ] **Step 1:** Update the docs to the new layout.
- [ ] **Step 2: String drift audit.** In a scratch directory outside the repo, write a small `tsc`-API script that lists every string and template-literal text in a `src` tree. Run it on `git worktree add <tmp> 38da5bf` and on the working tree, then diff the sorted lists.
  Expected: the only differences are import specifiers, the removed `header` parameter default, and template literals split for readability whose concatenation equals an original. Explain each difference in the hand-off.
- [ ] **Step 3: Final verification** with `git diff --check && bun run format:check && bun run bun-typecheck && bun run typecheck && bun test && bun run build`. Also check every Markdown link under `.agents/`, `AGENTS.md` and `.claude/` resolves.
  Expected: all pass. Remove the scratch worktree.
- [ ] **Step 4: Commit** `docs: update agent library for the refactored architecture`

**Hand-off must state:** `check:workspaces` was typechecked only and not run. Bun test count before and after. Any string-audit differences. The owner should now do the manual re-test in OpenCode.
