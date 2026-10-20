# Development Handoff — Working Plugin First

Updated: 2026-10-20. Branch: `feat/multi-root-phase-zero`.

## Current phase: reviewed implementation and automated regressions; live acceptance pending

**Implementation reviewed; automated regressions passed.** On 2026-10-19 the user
requested completion without touching tests until approval. This increment adds
default catalog storage, compiled exports, standalone archive, optional neutral
launcher, and installation guidance. The later
[opt-in plan](OPT_IN_WORKSPACES_PLAN.md) has now been implemented in production:
ordinary plugin installation is primary, and ordinary sessions remain native
until explicit selection. Production-only checks are permitted.
No test files/harnesses were changed or executed in those initial increments,
and no OpenCode runtime was launched. Fresh opt-in/packaged/lifecycle acceptance awaits approval.
Earlier adapter/budget/lifecycle limits remain documented, not marked passed.
The user subsequently reported successful manual testing and requested a single
`/workspace` command plus LocalAppData storage on Windows. That follow-up is now
implemented with production-only verification; that approval did not yet cover
automated tests or a new agent runtime pass.
The user then requested complete retirement of earlier unreleased workspace
versions and explicitly approved deleting obsolete tests and related harness
sections without executing them. That cleanup removes the old plugin/commands,
JSON import, schema-1 upgrade, old Windows default-path fallback, and launcher
registration repair. Shared filesystem/search/PowerShell cases are preserved in
`tests/filesystem.test.ts`. That cleanup used production-only verification.
The user subsequently reviewed the result and approved related automated
unit/adapter updates and runs without OpenCode; the current scope is recorded below.
On 2026-10-20 the user requested moving the default catalog location alongside
OpenCode's global configuration on Windows too. This supersedes the LocalAppData
default above, without automatic data migration or changes to the SQLite format.
Explicit overrides remain supported; no real user catalog or configuration is touched.
Cross-root native reads/edits, independent test suites,
and explicit-workdir Git/shell are demonstrated in the real package. The Phase 3
management flow and session-aware footer indicator are also implemented and exercised.
Bounded multi-root `workspace_glob`/`workspace_grep` now use hardened
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
were added to the existing regression file, not a new capability suite. That
historical acceptance also exercised JSON import, which has since been removed
with its dedicated tests and is no longer a product or acceptance requirement.
Historical verification: **139 tests**, actual-package acceptance, and loader smoke
passed. The packaging increment used production-only typecheck, build, archive
inventory, and editor diagnostics. Subsequent approved automated verification
passed **112 tests with 507 assertions** and both typechecks, not live runtime acceptance.

## Current decision and implementation

The user delegated scope decisions and explicitly requested implementing the plugin
instead of expanding throwaway probes. Follow
[the revised first-release decision](DEVELOPMENT_PLAN.md#0-implementation-decision-after-capability-research).
The original metadata/inheritance guarantees remain unsupported; they are deferred,
not fixed or silently marked passed. Phase-zero research is concluded for this scope.

### Opt-in production increment

- `/workspace` is the sole management-menu command/palette entry and retains the
  stable command ID. The plural entry/alias was removed at the user's request.
  Add/switch entrypoints remain.
  Opening/cancelling management, editing definitions, and viewing status
  do not activate or persistently seal an ordinary session.
- Catalog discovery opens existing storage read-only. A missing catalog yields
  empty metadata with a null catalog ID, not a fabricated persisted identity.
  Missing parents/files/rows are not created on load, passive requests, or reads.
  Explicit administrative writes initialize single-flight; active capture requires
  an existing catalog. Both readers and writers reject schema 1 and other unsupported formats.
- All platforms default to
  `~/.config/opencode/workspace-manager/workspaces-v2.sqlite`, alongside OpenCode's
  global configuration. Windows uses
  `%USERPROFILE%\.config\opencode\workspace-manager\workspaces-v2.sqlite`;
  `LOCALAPPDATA` no longer affects catalog storage.
  There is no lookup or retention of previous paths. The chosen path is
  cached for the plugin lifetime; no catalog is moved, copied, or merged.
  Explicit `catalogPath` takes precedence over the default; a test
  override into a project is why the user's review DB was created there.
  Changing the default or removing/changing an override does not transfer its
  definitions or bindings. Keep an explicit override or deliberately transfer a
  SQLite-consistent backup before selecting another location. The catalog also
  holds local session state and must not be committed or live-synchronized.
- Passive context returns before capture, instruction reads, model-budget gates,
  native-tool preflight, and workspace permission work. Its request tool map loses
  only this plugin's helpers. Independent helper guards reject passive direct calls;
  helpers retain `codemode: false`. Local SDK/installed CLI packaging does not expose
  Code Mode inventory construction, so complete indirect invisibility is not claimed.
- Context/tool/compaction hooks mark a session started synchronously. Native history
  plus the final no-await admission/SQLite boundary reject attach when the first
  request wins. Active rows still seal; ordinary rows are not created. Markers are
  capped at 10,000 per Location/plugin lifetime without eviction; saturation disables
  further attachment until plugin reload. This is not distributed multi-server CAS.
- Menu eligibility is metadata, not a mutating `capture()`. Empty-session attach is
  explicit; started/uncertain sessions offer a new workspace session. Home creates,
  binds, confirms, and only then navigates. Detach after work starts explicitly
  creates a new ordinary session. Existing histories and other sessions stay intact.
- Only confirmed active or known-active-degraded views render a footer node and
  schedule reconciliation. Passive navigation/reconnect discovery is bounded;
  targeted binding events can activate the displayed indicator. Navigation/deletion
  aborts pending requests and clears timers/listeners; no `[ws:none]` remains.
- Storage errors never yield guessed/stale mappings for known active sessions.
  Startup cannot classify undiscovered bindings if an existing catalog is unreadable.
  That resolution remains unavailable and is logged, while native work is left
  enabled to avoid blocking every ordinary session. Restore catalog access and
  rediscover before continuing a possibly bound conversation. Safe restoration
  during this ambiguity cannot be guaranteed without a host/storage capability
  absent from the pinned API; no second authoritative binding store was added.
- Follow the README's one-time absolute `dist` registration and ordinary `opencode`
  workflow. Register globally or locally, never both. The AppData launcher remains
  an optional alternative, not the required install path. Native project/global
  instructions, provider setup, cwd, and per-root configuration boundaries remain.

Related automated unit/adapter tests and full typechecking are now approved,
alongside production checks. OpenCode, acceptance-harness, loader smoke, and live
capability scripts remain unapproved.
Historical tests/runtime results below are not proof of its passive behavior,
activation races, lifecycle, visual layout, or Code Mode inventory.
The retirement-only harness cleanup removes import scenarios, not all pre-opt-in
expectations: `scripts/check-workspaces.ts` still contains a passive `[ws:none]`
wait. Updating that acceptance flow requires separate test-work approval before
it can validate the current plugin.

### Approved automated regression work

- Baseline after review: 76 existing tests passed with 294 assertions; full and
  production-only typechecks passed. VS Code's test integration did not discover
  Bun tests, so verification uses the existing Bun runner.
- `tests/catalog.test.ts` covers current-only formats, non-creating/read-only
  discovery, persistence, pinned independent bindings, idempotency, and defaults.
- `tests/workspaces.test.ts` exercises actual production hooks/RPC/helpers,
  passive native behavior, explicit activation, first-request admission ordering,
  the exact 10,000-marker boundary, scoped instructions/failures, and lazy paths.
- `tests/workspace-tui.test.ts` uses the actual server/catalog with mocked host UI
  APIs for singular commands, cancellation, definition-only edits, explicit empty
  or new-session activation, detach, navigation, and cleanup. It does not render
  the native footer or establish real host Code Mode inventory behavior.
- Targeted new regressions: **36 passed, 0 failed, 213 assertions** across the
  three new test files. Full suite: **112 passed, 0 failed, 507 assertions** across
  11 files, using `bun test`.
- `bun run bun-typecheck` and `bun run typecheck` both passed without diagnostics.
  No production changes were needed in this test increment.
- No real catalogs, user/global settings, shared services, or Git staging are
  modified by this automated test work. No OpenCode or runtime harness was run.

The real package now lives in `src/`, exported by the root manifest:

- `src/index.ts`, `src/rpc.ts` — real server hooks, typed management RPC,
  session validation, native-tool preflight, and status/alias helpers.
- `src/tui.ts` — deterministic `/workspace`, `/workspace-add`, `/workspace-switch`,
  native dialogs and server-side folder browser; no prompt/generation administration.
- `src/tui/indicator.ts` — real `prompt.footer.status` contribution, session/Location
  routing, native-theme colors, grapheme-safe label clipping, cancellation/cleanup,
  change notifications and bounded periodic metadata reconciliation.
- `src/infrastructure/catalog.ts` — current-format-only SQLite catalog; atomic
  request receipts, definition changes, explicit binding, and first-request sealing.
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

UI continuation (updated by the opt-in increment): the footer shows the actual
viewed active session's selection, known-active unavailable state, and a
blocked-instruction marker. Passive sessions contribute no node or recurring poll.
Names are clipped
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

Next action is user review, not test/runtime expansion or live installation:

1. Review the production changes and normal plugin registration instructions in
   README. Do not register globally, modify real catalogs/configuration, launch
   OpenCode, or restart the shared service without separate authorization.
2. Wait for explicit approval before editing/running tests, harnesses, smoke,
   private runtime acceptance, or capability probes. Do not add further test suites.
3. Once approved, complete packaged-install and lifecycle acceptance against the
   documented first-release behavior; do not silently claim deferred gates passed.

Release setup: all platforms default to
`~/.config/opencode/workspace-manager/workspaces-v2.sqlite`; Windows uses
`%USERPROFILE%\.config\opencode\workspace-manager\workspaces-v2.sqlite`. No previous
default is probed or retained; `catalogPath` overrides the default explicitly.
No existing real catalog was moved or
reset in this increment. Missing storage is initialized by an explicit administrative write, not
startup/discovery. `bun run pack` emits `opencode-workspaces-0.1.0.tgz` from a standalone
manifest, without source, tests, or build scripts. SDK dependencies
are declared and UI/Solid remain external for the host runtime. Production-only
`bun run typecheck` excludes all tests and harnesses. Ordinary installation builds
and registers `dist` once, then runs native `opencode` from the chosen project.
The optional alternative `bun run start` creates its
own neutral launcher registration, refuses unrelated existing config, and never
restarts the shared service. It registers the built `dist` folder: pinned OpenCode
2.0.32 resolves local directory entrypoints directly instead of following manifest
exports. Existing-service activation is checked before opening the TUI. Older
checkout-root registrations are no longer accepted or rewritten.

Storage supports only the current SQLite application ID/schema 2; v1 JSON import,
import receipts, sidecar locks, and schema upgrades are removed. Unsupported
versions/foreign databases fail without conversion or reset. The existing filename,
application ID, schema version, and plugin/RPC IDs are unchanged to preserve
current-format definitions and pinned bindings. An unused import table in an
existing current-format database is left untouched; new databases do not create it.
Fresh packaged runtime acceptance awaits user approval.

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

The repository-owned `.opencode/` plugins, notification companion, model-driven
commands, old loader smoke, and import-only regressions are removed. The obsolete
workspace, loader script, and ripgrep-only test dependency are no longer registered
in package metadata. Current path/search cases no longer instantiate an old plugin.
Historical Phase-zero fixtures below remain research evidence, not old production support.

No real catalog, user/global configuration, or shared service was changed. No commit
was created. Related automated unit/adapter updates and runs are approved; do not
run OpenCode or acceptance/capability runtime checks without separate permission.

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
