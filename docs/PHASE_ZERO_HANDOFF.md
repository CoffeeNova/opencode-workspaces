# Development Handoff — Working Plugin First

Updated: 2026-10-19. Branch: `feat/multi-root-phase-zero`.

## Current phase: Phase 6 - implementation ready for review

**First-release implementation is ready for user review.** On 2026-10-19 the user
requested completion without touching tests until approval. This increment adds
default catalog storage, compiled exports, standalone archive, neutral launcher,
and installation/rollback guidance. Production-only typecheck/build/pack pass.
No test files/harnesses were changed or executed, and no OpenCode runtime was
launched in this increment. Fresh packaged/lifecycle acceptance awaits approval.
Earlier adapter/budget/lifecycle limits remain documented, not marked passed.
Cross-root native reads/edits, independent test suites,
and explicit-workdir Git/shell are demonstrated in the real package. The Phase 3
management flow and session-aware footer indicator are also implemented and exercised.
Bounded multi-root `workspace_glob`/`workspace_grep` now reuse shared legacy
ignore/path/read/regex primitives without changing native behavior for unrelated
sessions. Native preflight now also rejects outside directory links into pinned
roots, including new-file parents, rename endpoints, and native search overlap.
Earlier Phase 5 follow-ups are adapter/schema compatibility coverage, instruction
budget policy, and diagnostics.

Latest real-package acceptance **before the packaging changes** is
`workspace-phase-zero-nJTZjP`; it retains the
indicator/menu/draft/native-development checks and adds actual pinned-root search,
alias scoping, fair truncation, ignore/sensitive filtering, independent sessions,
configured native read denial, and unchanged unbound native search. It also verifies
nine linked-path rejections across read/edit/write/patch/rename/shell/glob/grep,
with unchanged source files and no partial cross-root patch. The retained
`working-plugin-path-checks.json` records the actual native failures. Focused cases
were added to the existing regression file, not a new capability suite. Import now
also passes real preview/cancel/confirm, exact backup, unchanged JSON/selections,
former-active suggestion, and retry after private-server restart with zero
administrative provider requests. `tests/catalog-import.test.ts` covers the real
production catalog/importer rather than another probe implementation.
Historical verification: **139 tests**, actual-package acceptance, and loader smoke
passed. Current packaging changes have production-only typecheck, build, archive
inventory, and editor diagnostics, not a new runtime/test pass.

## Current decision and implementation

The user delegated scope decisions and explicitly requested implementing the plugin
instead of expanding throwaway probes. Follow
[the revised first-release decision](DEVELOPMENT_PLAN.md#0-implementation-decision-after-capability-research).
The original metadata/inheritance guarantees remain unsupported; they are deferred,
not fixed or silently marked passed. Phase-zero research is concluded for this scope.

The real package now lives in `src/`, exported by the root manifest:

- `src/index.ts`, `src/rpc.ts` — real server hooks, typed management RPC,
  session validation, native-tool preflight, and status/alias helpers.
- `src/tui.ts` — deterministic `/workspace`, `/workspace-add`, `/workspace-switch`,
  native dialogs and server-side folder browser; no prompt/generation administration.
- `src/tui/indicator.ts` — real `prompt.footer.status` contribution, session/Location
  routing, native-theme colors, grapheme-safe label clipping, cancellation/cleanup,
  change notifications and bounded periodic metadata reconciliation.
- `src/infrastructure/catalog.ts` — plugin-owned SQLite catalog; atomic request
  receipts, definition changes, explicit binding, first-request sealing, and
  transactional import receipts with schema-1-to-2 upgrade.
- `src/infrastructure/legacy-import.ts`, `src/infrastructure/registry-lock.ts` —
  strict bounded v1 validation, source fingerprinting, exclusive verified backups,
  and the shared legacy-writer lock protocol. No source JSON rewrite.
- `src/infrastructure/paths.ts` — server path normalization, deny policy, canonical
  roots, linked/new-file checks, and metadata-only browsing.
- `src/infrastructure/search.ts` — shared hardened traversal, bounded UTF-8 reads,
  isolated regex matcher, and production per-root quotas/partial-result reporting.
- `src/instructions/delivery.ts` — the previously verified scoped delivery algorithm
  moved into the real package. The historical fixture re-exports it, avoiding a copy.
- `scripts/build.ts`, `scripts/pack.ts`, `scripts/start.ts` — compiled distribution,
  standalone archive, and neutral OpenCode launcher; no test execution.
- `scripts/check-workspaces.ts` — one end-to-end check of these actual package
  entrypoints through the existing private runtime/TUI transport, not a new fake service.

Core workflow demonstrated: real UI creates a definition and adds two roots, then
explicitly creates/binds/navigates to an empty session with **zero provider requests**.
The actual plugin subsequently delivers nested rules, makes native edits in both
repos, runs both test suites and independent Git commands, blocks a sensitive write,
rejects changing a started session, preserves pinned roots after a saved-definition
edit, and restores the binding/catalog after a private-server restart.
Latest retained actual-package evidence: `workspace-phase-zero-I3p2HF` (five scripted
development requests; zero administrative provider requests),
`working-plugin-results.json`, `working-plugin-transcript.json`, provider requests,
and `tui-workspace-product-screens.json`.

Initial vertical-slice verification, before the UI/search/path continuations:
typecheck and **114 existing tests** passed, alongside actual-package acceptance
and the legacy native-loader smoke. No new unit-test suite was added then.

UI continuation: the footer now shows the actual viewed session's selection, no
selection, unavailable state, and a blocked-instruction marker. Names are clipped
at grapheme boundaries within a terminal-width budget. The selection RPC reads
only one binding/catalog metadata, not every saved definition or any root files.
Changed events contain only bounded IDs/revisions; notification failure cannot
change a committed result or mask permission control flow. Missed events are
reconciled by periodic reads with timeout, backoff, stale-reply rejection, and
clearing of unconfirmed old labels.

The menu no longer offers empty pickers. Add Folder targets the current saved
definition when available and offers an explicit apply/open-new action after saving
changes; it never silently retargets a session. Status distinguishes pinned vs saved
revisions and shows instruction state from the last request. The real-package check
also covers a saved non-Git folder, editable draft preservation, and independent
indicators in two simultaneous clients with a long name at 64 columns. Native
OpenTUI truncation initially shortened the middle of names; the actual indicator
now preserves the recognizable prefix and closing/blocked marker explicitly.

Next action is user review, not more implementation/test expansion:

1. From the checkout run `bun run start` (or the pinned npm Bun command in README).
   It builds and opens a neutral launcher, preserving global settings/providers.
2. Wait for explicit approval before editing/running tests, harnesses, smoke,
   private runtime acceptance, or capability probes. Do not add further test suites.
3. Once approved, complete packaged-install and lifecycle acceptance against the
   documented first-release behavior; do not silently claim deferred gates passed.

Release setup: catalog defaults to
`~/.config/opencode/workspace-manager/workspaces-v2.sqlite`; `catalogPath` is
optional. `bun run pack` emits `opencode-workspaces-0.1.0.tgz` from a standalone
manifest, without source, tests, legacy entrypoints, or build scripts. SDK dependencies
are declared and UI/Solid remain external for the host runtime. Production-only
`bun run typecheck` excludes all tests and harnesses. `bun run start` creates its
own neutral launcher registration, refuses unrelated existing config, and never
restarts the shared service. It registers the built `dist` folder: pinned OpenCode
2.0.32 resolves local directory entrypoints directly instead of following manifest
exports. Older launcher-owned repository-root entries are upgraded atomically to
`dist`, and existing-service activation is checked before opening the TUI.
Legacy source stays for compatibility/rollback only.

Phase 6 import: the real menu previews a user-supplied server JSON and requires
confirmation. A cooperating-writer lock protects reread, exclusive timestamped
backup, byte verification, and final source check. A SQLite transaction commits all
definitions and a durable receipt together; no bindings change. IDs/aliases/paths
survive retry/restart, and old active is only an explicit review suggestion.
Conflicts, malformed/future data, stale previews, cancellation, backup sync failure,
and source changes during backup are covered. Concurrent connections share one
receipt. Schema upgrade preserves saved definitions and sealed pinned bindings;
malformed older catalogs are rejected before changing their version or tables.
Failed/interrupted attempts may leave unverified backup files; they are not
overwritten or restored automatically. Unknown lock owners fail closed. Stop all
external writers: the sidecar lock is cooperative, not an atomic filesystem fence.
Rollback uses the untouched v1 JSON after disabling the new package. Catalog schema
2 is not readable by older development builds. Default catalog storage is now
implemented; fresh packaged runtime acceptance awaits user approval.

Search continuation: fixed per-root shares divide 200 glob paths/100 grep lines;
unused shares are not redistributed. Responses carry root statuses, partial and
truncated flags, and scan/byte limits. Canonical overlapping roots have one owner
per result. Each root has a 10,000-entry enumeration budget and 8 MiB grep-input
budget; files remain limited to 200 KiB and matching uses the shared isolated
JavaScript regex worker. Native file permissions are asserted before ignore/content
reads, with the actual tool source. Permission rejection/cancellation never becomes
an unavailable-root result. Missing roots remain visible as partial results.

Native-path continuation: coverage is decided using both the supplied path and its
resolved target, not lexical containment alone. An outside directory link into a
selected root cannot bypass its sensitive-path or instruction preflight. New paths
resolve through the nearest existing parent. The same rule covers shell workdirs;
native glob/grep checks both lexical and canonical overlap. All patch targets and
rename endpoints are validated before any mutation. Unrelated explicit paths,
including unavailable paths, and unbound sessions retain native behavior. Covered
workspace resolution failures still stop preflight. Shell argument analysis, hard-link identity,
and atomic filesystem retargeting remain outside this guarantee.

The legacy entrypoint now imports shared source helpers. Its documented standalone
installation bundles those helpers before copying; a focused build test verifies
that artifact has no remaining relative `src/` imports. Legacy output/ranking and
security regressions still pass. This is not published-package acceptance.

No real registry, global configuration, or shared service was changed. The legacy
`.opencode/` entrypoints remain available until replacement/install parity is ready.
The package uses its own `.sqlite` catalog by default and cannot be loaded alongside
the legacy guard. No commit was created. Never edit/run tests until the user approves.

## Historical phase-zero handoff (superseded ordering)

The following records research and original-contract blockers. Its old stop/next-work
instructions do not override the revised plan or authorize more probe expansion.

## Start here

1. Read [the development contract](DEVELOPMENT_PLAN.md), especially Sections 7–8 and 14.
2. Read [capability findings](PHASE_ZERO_FINDINGS.md).
3. Resume at **“Next work”** below; both the journal and independent scoped-instruction
   probe have now been runtime-tested.

No contract change was made or requested. Phase 0 remains open: the real journal
probe now documents host limitations blocking this candidate. Do not treat a
passing negative control as authorization to start the affected Phase 1/2 work.

## Work completed and verified

- Baseline was `@opencode/plugin@2.0.30`, CLI/private server `2.0.32`, Bun `1.4.3`.
- An isolated package-only capability fixture proves typed RPC and a real Windows
  `/workspace-probe` → native dialog → RPC TUI path with **zero model calls and no
  home-screen session creation**.
- A deterministic loopback provider exercised native read/edit/write/patch, a
  multi-file preflight rejection, two external repositories, independent tests
  and Git status, native permission denials, formatter cwd, and host snapshot limits.
- Native child/fork metadata copies are verified across delayed inspection,
  parent switches, a grandchild, and private-server restart. This is a carrier,
  not an authoritative workspace binding.
- The Promise adapter ignores `RequestOptions.signal` for the session wait method;
  the public Effect plugin API's `Effect.timeoutOption` is cancellation-safe.
- A throwaway Effect semaphore/epoch protocol gates context snapshots and real
  native executors; it rejects busy/stale updates and releases permits after a
  genuinely interrupted shell call.
- The separate test-only SQLite binding journal now runs through its typed RPC in
  the private server. Prepare abort/fencing, indeterminate publishing, exact-mirror
  recovery, delayed child/fork inheritance, null-token detachment, pre-existing
  conflicts, and two further private-server restarts are verified.
- Two real-runtime negative controls demonstrate that the journal adapter can
  overwrite an intervening metadata field/marker and accept a forged older token
  from the same native ancestry. It is **not a production binding solution**.
- Real TUI checks now cover slash/palette invocation, editable draft preservation
  at home and in three session views, native select/prompt replacement and Escape,
  110/64-column viewports, two local-source reloads (idle and owned-menu pending),
  one command layer, and removal of old event listeners. These are probe flows,
  **not implementation of Phase 3 workspace administration**.
- The probe controller drops stale actions, results, and errors after a view or
  Location change. Unit tests verify these cases and failed-setup listener cleanup;
  live navigation during an RPC remains a separate acceptance case.
- An independent fixed-root instruction adapter now captures real root/nested
  source bodies in provider requests and correlates successful native preflights
  with their generating snapshot. It rejects parallel first-touch writes,
  first-touch/stale multi-root patches, undisclosed rename destinations, and writes
  generated before rules changed/deleted. Regenerated operations succeed after
  fresh delivery. Overlap deduplication, native read denial, byte overflow, and an
  unverified-small-context failure are tested. It uses no journal/binding authority.

Latest verification:

```text
bun run bun-typecheck                         PASS
bun test tests/capability-probe.test.ts tests/dialog-flow.test.ts tests/terminal-screen.test.ts
                                                19 pass
bun test                                        114 pass, 0 fail
bun run test:opencode                            PASS first standalone attempt this increment
bun run tests/opencode-capabilities.ts --keep     PASS, server-only journal cases
bun run tests/opencode-capabilities.ts --tui --keep
                                                PASS, UI + instructions + journal RPC
bun run tests/opencode-tui-capabilities.ts --keep PASS, zero provider requests
bun run tests/opencode-instruction-capabilities.ts --keep
                                                PASS, independent instruction cases
Local Markdown links/anchors and whitespace      PASS (including untracked sources)
```

The successful expanded TUI/journal run is `workspace-phase-zero-a2a6BU`: 11 UI
check groups, four view targets, two source-watch reloads, three listener deliveries,
37 journal checks, two journal-specific restarts, and unchanged fixture histories.
Its 15 scripted requests are all outside administrative UI/journal operations.
The provider-disabled UI-only run is `workspace-phase-zero-0FPtFy`, with zero model
requests. The updated server-only journal run `workspace-phase-zero-VfWGyy` passed.
Both the preceding journal increment and this TUI continuation saw a standalone
loader-smoke HTTP 503 followed by one passing standalone rerun; the issue is not
diagnosed or fixed. No retry logic or shared-service change was added. An earlier
integration attempt
(`workspace-phase-zero-uQ9SvC`) found that OpenCode cannot fork an empty session.
The corrected fixture reuses an already scripted transcript instead of generating
administrative turns. Bun was invoked from the pinned npm `bun@1.4.3` package
because `bun` was absent from this shell's PATH; no global installation was changed.

The instruction continuation's combined run is `workspace-phase-zero-ttueyu`, with
11 instruction groups and 34 additional scripted requests (49 total), alongside
the unchanged UI/journal checks and restarts. The UI-only rerun is
`workspace-phase-zero-g4rMxZ`, still with zero provider requests. The final focused
instruction run is `workspace-phase-zero-RowHOy`: all 11 groups, 34 requests,
including the explicit native permission-failure assertion. The earlier focused
run `workspace-phase-zero-KH2wjK` has nine groups before the stale-patch and
request-correlation additions. Direct invocation of the
cached pinned `bun.exe` preserves `--keep` in this PowerShell environment; the npm
shim invocation did not retain the initial successful instruction fixture.

## Journal probe map

The new files are **experimental, not production-ready**:

- `tests/fixtures/phase-zero-plugin/binding-journal.ts` — validated intent/token
  journal and prepare/publish/reconcile service.
- `tests/fixtures/phase-zero-plugin/journal-store.ts` — separate `bun:sqlite`
  crash-durable test store; it must only open its fixture file.
- `tests/fixtures/phase-zero-plugin/journal-rpc.ts` — metadata-bounded probe RPC.
- `tests/fixtures/phase-zero-plugin/journal-server.ts` — mounts the probe in the
  isolated package. Its native metadata publisher is explicitly cooperative-only.
- `tests/fixtures/phase-zero-plugin/journal-pause.ts` — one-RPC test scheduling
  controls for prepared fencing and the native metadata read/write gap. Not a lock.
- `tests/helpers/journal-capability.ts` — real-server journal RPC cases and negative
  controls; directly reads only the separate probe SQLite file, read-only.
- `tests/binding-journal.test.ts` — 19 isolated SQLite/fake-host tests, including the
  same-ancestry override negative control and independent SQLite connections.
- `tests/journal-pause.test.ts` — scoped release/cancellation of test scheduling.

Artifacts include `journal-results.json`, `capability-results.json`, and
`binding-journal.sqlite` plus the prior trace/provider/TUI artifacts. The complete
case outcomes and fault granularity are recorded in
[the journal findings](PHASE_ZERO_FINDINGS.md#lifecycle-follow-up-disposable-binding-journal).

## TUI probe map

- `tests/opencode-tui-capabilities.ts` — UI-only private runtime; the loopback
  provider is unavailable throughout and any request fails acceptance.
- `tests/helpers/tui-capability.ts` — four real view targets, native widgets,
  current-screen assertions, generated-source reloads, and callback evidence.
- `tests/helpers/private-tui.ts`, `tests/helpers/terminal-screen.ts` — authenticated
  PTY transport and pinned `@xterm/headless@5.5.0`; no host internals are patched.
- `tests/fixtures/phase-zero-plugin/{tui,dialog-flow}.ts` — disposable controller
  with stale-view guards and an explicit native dialog-transition state.
- `tests/{capability-probe,dialog-flow,terminal-screen}.test.ts` — unit checks,
  including case-sensitive session matching and current-frame vs transcript text.

Artifacts include `tui-results.json`, `tui-*-screens.json`, and per-client ANSI
captures. The UI-only runner records provider count and pass/failure diagnostics
in `tui-capability-results.json` even if a check fails. See
[the exact UI evidence and limits](PHASE_ZERO_FINDINGS.md#tui-follow-up-drafts-native-dialog-transitions-and-source-reload).
There is no public composer getter, and foreign dialog ownership during unload is
not established. Do not extend the owned-menu test into a general cleanup claim.

## Instruction probe map

- `tests/fixtures/phase-zero-plugin/instructions.ts` — bounded source reader,
  request-local JSON framing/fingerprints, explicit scope preparation, and
  conservative native patch target subset. Experimental only.
- `tests/fixtures/phase-zero-plugin/instruction-{rpc,server}.ts` — fixed-root setup
  for new fixture sessions and public context/tool/permission adapters. No durable
  binding, arbitrary-path RPC, or metadata publication.
- `tests/instructions-probe.test.ts` — 15 unit checks, including source failures,
  new/change/delete freshness, overlap, parallel preparation, and invalidation.
- `tests/helpers/instruction-capability.ts` — actual request capture, native
  mutation rejection/regeneration, held-request races, and bounded diagnostics.
- `tests/opencode-instruction-capabilities.ts` — isolated instruction-only runner;
  the combined probe invokes the same helper. `scripted-provider.ts` shares the
  original deterministic responder without replacing native tools.

Artifacts: `instruction-results.json`, `instruction-transcripts.json`, provider
requests, and fingerprint/status telemetry. Read
[the exact instruction limits](PHASE_ZERO_FINDINGS.md#instruction-follow-up-scoped-delivery-and-native-mutation-fingerprints)
before claiming coverage. This is sequential fixture evidence, not a complete
native schema/path adapter, compaction/revert/restart integration, permission-wait
freshness, or token-budget policy. The 8k case deliberately blocks; it does not
establish small-model support.

## Confirmed host blockers

OpenCode exposes **no native metadata compare-and-set** through the public plugin
API. `journal-server.ts` currently does `session.get` followed by whole-object
`session.update`; another plugin can update metadata in between and lose a field.
The SQLite fake-host test's `publish(before, after)` behaves atomically, but the
real OpenCode adapter does **not** provide that property. The paused real adapter
now reproduces this loss using another public client's update, including a foreign
marker written in the gap. It still reports journal commit. Do not describe it as
race-safe, enable it for production bindings, or use metadata as the binding store.

An explicit child metadata override can also contain an older, genuinely issued
token from its native parent. The journal accepts the older selection even though
the parent had already switched when the child was created. Catalog/token/ancestry
validation cannot authenticate that creation snapshot. The public API has no
awaited creation hook, and events cannot supply that atomic boundary after the fact.

There is also an unavoidable two-store crash window unless a suitable host primitive
is found. The intended safety rule is fail closed:

- crash in `prepared`: durable phase comparison fences a publisher after recovery
  aborts it (verified with restart and a separately paused live publisher);
- crash in `publishing` while the old marker is visible: outcome is unknown; keep
  the operation pending, do not retry blindly or guess rollback;
- crash after native publication but before journal commit: recovery may finalize
  only after exact marker, token, catalog, session ancestry, and revision validation;
- pre-existing unexpected/invalid metadata: report conflict without overwriting it.
  The current non-CAS adapter cannot preserve this rule for a writer in its gap.

The fixture now verifies these conservative outcomes; it does not close the
two-store race or prove physical power-loss recovery. A `publishing` operation with
the old marker remains indeterminate after both restarts and is deliberately not
automatically aborted or republished.

## Next work

1. Keep this candidate experimental. On the tested API it cannot satisfy the
   unchanged concurrent-writer and creation-time-inheritance contract. Do not begin
   production extraction/migration of the affected binding service.
2. Continue independent Phase 0 instruction work with native compaction/revert/restart
   restoration, real token/context budgeting, complete native schema/path adapters,
   and instruction changes during permission waits. The initial scoped-delivery and
   first-touch/stale multi-target proof is now recorded above. Keep it independent
   of the unsafe journal; fixed fixture roots are not a production binding solution.
3. If continuing lifecycle research, first establish a **supported public host
   primitive** for metadata atomicity and authenticated creation-time inheritance.
   Check exact versioned public types/implementation and prove the primitive in the
   same isolated fixture. Do not patch OpenCode internals or invent a creation/CAS API.
4. Preserve the two negative controls. A proposed replacement must pass the actual
   product invariants under these interleavings, not merely change expected results
   or require all other metadata writers to cooperate. Any requirement change needs
   explicit user approval; none is authorized here.
5. Until those host gates change, retain the remaining acceptance work below as
   requirements. Do not silently substitute parent-current lookup, model-driven
   administration, or an instance-local semaphore for the stated contract.

## Remaining release gates

- Bind the gate to the authoritative catalog: derive **every** affected running
  session server-side and serialize all processes/instances sharing that catalog.
- Resolve inherited child/fork intent across journal interruption and explicit
  child `metadata` overrides without trusting forged/copied markers.
- Production scoped-instruction integration; broader native adapter coverage and
  delivery restoration across compaction/revert/restart. The fixed-root request
  capture/preflight cases above do not complete Phase 4.
- Small-model instruction budgets; full TUI administration and indicator; live
  navigation/RPC reconnect, simultaneous clients, and foreign-dialog ownership;
  package-install acceptance, migration, and all planned phases.

## Boundaries and working tree

- Production `.opencode/plugins/workspace-manager.ts`, commands, and registry schema
  remain unchanged.
- No real global/project registry, user config, or shared server was modified.
- No commit was created. Existing user-authored README/docs/AGENTS changes were
  preserved; inspect `git status` before continuing.
- Disposable retained artifacts (if present) use exact paths under
  `C:\Users\dnmno\AppData\Local\Temp\opencode\workspace-phase-zero-*`.
  Keep them for inspection; never clean the parent Temp directory broadly.
