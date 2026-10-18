# Phase Zero: Capability Evidence and Open Gates

Date: 2026-10-18. Status: **historical research evidence; first-release scope revised**.
Contract: [development plan](DEVELOPMENT_PLAN.md#5-verified-opencode-api-surface-and-capability-gates).

The user subsequently delegated scope decisions and requested working plugin code
instead of more pre-implementation probes. Follow the
[revised decision](DEVELOPMENT_PLAN.md#0-implementation-decision-after-capability-research)
and [current implementation handoff](PHASE_ZERO_HANDOFF.md#current-decision-and-implementation).
The original inheritance/metadata limitations below remain real. They no longer
block the reduced release, which uses no metadata mirror, no automatic inheritance,
and immutable session root snapshots after first request. Later statements that
Phase 0 remains open describe the original contract, not the revised work order.

This is a disposable capability probe, not the new workspace implementation.
The existing plugin, v1 registry, notification companion, and `/workspace`
Markdown commands have not been replaced. No real registry was migrated.

## Tested baseline

| Component | Exact version |
| --- | --- |
| Installed Windows x64 CLI/private server | `2.0.32` |
| Plugin SDK and Promise client | `2.0.30` |
| Bun | `1.4.3` |
| Zod | `4.1.8` |
| Effect (development dependency; host supplies the plugin runtime) | `4.0.1` |
| Headless VT parser (test process only) | `@xterm/headless@5.5.0` |

Keep this explicitly tested SDK/runtime pair for the probe. The runner rejects
other CLI versions and currently requires Windows rather than treating API drift
or unverified machine-config isolation as a successful capability check.
`package.json` pins the SDK/client and Bun package manager; `bun.lock`
pins dependencies. The CLI installation itself was not changed.

Baseline: typecheck and **49 existing tests** passed. The existing native loader
smoke check passed for both current workspace plugins. After adding the probe,
typecheck and **114 tests** pass, including the journal, boundary, TUI controller,
native-dialog flow, VT-parser, and 15 instruction-probe checks. The focused UI run
has **19 passing tests**; the earlier journal/boundary/pause run had 31. Negative
controls deliberately reproduce unsupported behavior; passing them is not proof
that the binding contract is satisfied. Unit tests do not replace runtime evidence.
An earlier parallel verification run returned HTTP 503 from the existing loader
smoke check and passed on standalone rerun. In this journal increment, the first
standalone smoke attempt also returned HTTP 503 (`tests/opencode-smoke.ts:61`);
one further standalone invocation passed for both current plugins. The intermittent
503's cause remains unverified. No shared service restart, configuration change,
or automatic retry logic was used to hide either failure.
The TUI continuation also saw one standalone 503, followed by one passing standalone
rerun. This remains an intermittent loader-smoke limitation, not a fixed issue.
The instruction continuation's standalone loader smoke passed on its first attempt;
this does not diagnose or fix the earlier intermittent failures.

The expanded combined TUI/server probe passes (`workspace-phase-zero-a2a6BU`):
11 UI check groups, four view targets, two source-watch reloads, three listener
deliveries, 37 journal checks, and two journal-specific restarts. The combined run
has 15 scripted provider requests, none during UI or journal administration. The
provider-disabled UI-only run (`workspace-phase-zero-0FPtFy`) has **zero** requests
in total. The updated server-only probe also passes (`workspace-phase-zero-VfWGyy`),
retaining all 37 journal checks and both journal restarts.

The instruction continuation also passes in the combined TUI/server probe
(`workspace-phase-zero-ttueyu`): 11 instruction check groups, 34 additional scripted
requests (49 total), unchanged UI/journal checks, and both journal restarts. The separate
provider-disabled UI-only rerun (`workspace-phase-zero-g4rMxZ`) still has **zero**
requests. See the scoped-instruction evidence below for the limits of this proof.
The final instruction-only run (`workspace-phase-zero-RowHOy`) passes all 11 groups
with 34 scripted requests, including the explicit native permission-failure check.

## Reproduce safely

From the repository root, with the tested CLI and Bun available:

```powershell
bun install --frozen-lockfile
bun run bun-typecheck
bun test
bun run test:opencode
bun run test:capabilities
bun run test:capabilities:tui
# Independent scoped-instruction iteration, without the lifecycle/journal checks:
bun run test:capabilities:instructions
# Faster TUI-only checks, with no scripted provider replies:
bun run tests/opencode-tui-capabilities.ts --keep
```

To retain runtime artifacts (also retained automatically on failure):

```powershell
bun run tests/opencode-capabilities.ts --tui --keep
```

The TUI check is keyboard-driven through the **private server's authenticated
public PTY API**, including its single-use connect ticket. It starts an actual
Windows TUI, not a mock or a render of a standalone component. PTY failures fail
the opt-in check; they are not silently skipped. The ordinary `bun test` suite
does not start a server, model request, or TUI.

The runner creates a uniquely named `Temp/opencode/workspace-phase-zero-*`
directory, a neutral launch Git repository, two external Git repositories (one
with spaces), a non-Git folder, and a second Location. It builds a separate
package with `.`, `./tui`, and `./rpc` exports. The fixture uses only disposable
config, database, home, cache, state, and machine-config paths. It does not inherit
provider credentials or arbitrary `OPENCODE_*` overrides. Plugin inventory is
checked for unexpected third-party registrations. Only the spawned private
process tree is stopped; the shared service is never restarted.

The fixture package resolves the pinned SDK through a development dependency
junction/link. This proves package-directory export loading, **not published
tarball installation**. Installation acceptance still belongs to Phase 6.
The server entrypoint now uses the public Effect API, composing the original
Promise probe through its published adapter. `effect` and `@opencode/plugin`
remain external to the fixture bundle so OpenCode supplies its runtime instances.

The provider is a deterministic loopback HTTP responder. It emits fixed tool
calls, not AI output. No paid provider is contacted. Before scripted development
starts, the runner asserts **zero provider requests** after RPC/TUI administration.
Native tools receive real host session/message/call IDs, native permission
checks, and their original executors. No executor is called with a fabricated
tool context. The test makes the five native tools directly visible by changing
only their Code Mode exposure; it does not replace their implementations.

Example successful Windows run: `workspace-phase-zero-ttueyu` (real TUI, scoped
instructions, journal, and two journal-specific private-server restarts); subsequent runs receive
different names. Retained artifacts include:

- `capability-results.json`: versions, checked layers, and remaining gates.
- `observations.jsonl`: ordered server hooks, permission sources, and lifecycle events.
- `provider-requests.json`: actual assembled requests received by the fixture provider.
- `transcript.json`: actual native tool results, errors, and snapshot metadata.
- `tui-output.ansi`: real terminal output when `--tui` is used.
- `tui-session-a.ansi`, `tui-session-b.ansi`, `tui-other-location.ansi`, and
  `tui-*-screens.json`: per-client real output and current-screen snapshots.
- `tui-results.json`: draft/routing/dialog/reload checks and event-delivery IDs;
  `tui-capability-results.json` additionally records zero provider requests for the
  provider-disabled UI-only runner, including diagnostics if that runner fails.
- `formatter-runs.jsonl`: formatter target and actual working directory.
- `server-output.log`: the private server's captured stdout/stderr.
- `binding-journal.sqlite` (and any SQLite sidecars): the separate disposable
  probe catalog, never the native OpenCode database or a production registry.
- `journal-results.json`: ordered fault/recovery checks and explicitly labelled
  negative controls; the successful run records 37 checks and two journal restarts.
- `instruction-results.json`, `instruction-transcripts.json`: fixed-root instruction
  check outcomes and native tool results. Provider requests contain the actual
  scoped source bodies; `instructions.capture` telemetry contains only source
  paths/status/byte counts/hashes and snapshot IDs, not the bodies.

Only synthetic fixture content is captured. Do not adapt this trace recorder to
real sessions without a separate redaction/consent design. Successful fixtures
are removed unless `--keep` is supplied. Remove retained fixtures only after
reviewing their exact generated paths; never delete a broad Temp directory.

## Section 5.1 capability results

| Gate | Evidence | Result / remaining work |
| --- | --- | --- |
| 1. Server package and `./tui` | Package-directory load; real local-source watch; idle and owned-menu reload; one command per generation; old event listeners removed | Proved for the isolated package and these reload cases. Published installation, reconnect, and foreign-dialog ownership remain open. |
| 2. Direct slash, dialog, RPC | Slash and palette; draft retained; native select/prompt replacement and cancellation; home, two same-Location sessions, foreign Location; 110/64-column viewports | Proved for `/workspace-probe` in the real Windows TUI with no provider requests or implicit sessions. Not the Phase 3 management UI. |
| 3. Location/session validation | Explicit RPC Location; two valid sessions; foreign/missing/malformed session rejection; public child/fork fields; source-free `permission.assert` | Proved for canonical directory identity. Catalog ownership is a later service responsibility. |
| 4. External development | Native read/edit/write in both roots, one patch across both, new parent directories, two passing `node --test` runs, independent `git status --short` calls | Proved in the isolated host, without the old workspace guard. Does not enable native access in the existing plugin. |
| 5. External `AGENTS.md` | Native external reads still omit root/nested markers. The activated throwaway adapter delivers both roots, discovers targeted nested scopes, and deduplicates overlap in actual provider requests | **Native discovery is insufficient.** Explicit delivery is proved only for fixed fixture sessions; the production instruction service is not implemented. |
| 6. Ordering/preflight | Native hook ordering plus fixed-root snapshot fingerprints; parallel read/write, first-touch and stale multi-target patches, and rename destination checks | Rejection before mutation and regenerated success are proved for the scripted cases. Full production schema/path coverage, lifecycle integration, permission-wait freshness, and model budgets remain open. |
| 7. Children/forks | Native snapshots; disposable SQLite prepare/publish/mirror recovery; delayed child/fork resolution, detachment, grandchild, and restarts | Cooperative recovery proved. **Blocked for production:** no native metadata CAS; an explicit same-ancestry override can forge an older selection. |
| 8. Safe boundaries/concurrency | Effect-native idle deadline; serialized context/tool/counter gate; a genuinely running native shell is interrupted and its permit released | Conservative single-host/Location primitive proved. Production catalog/session derivation, cross-instance serialization, and integration are still open. |
| 9. Host formatting/review/revert | Custom launch formatter runs on an external write; session diff is empty; staged file revert leaves both external files unchanged | External formatting works using **launch-Location configuration/cwd**. Native snapshots/revert do **not** cover external edits. Multi-root review/LSP support is not claimed. |

## Decisions supported by these results

### Native schemas and model-dependent tools

On this runtime, `read`, `edit`, and `write` use **`path`**, not the legacy
`filePath` field. `patch` takes `patchText`; `shell` uses `workdir`.
The captured request schemas in `observations.jsonl` are the evidence for future
explicit adapters. The monolith's generic field probing is not suitable for
multi-file patch/rename preflight.

A GPT-labelled request exposes `patch` and does not expose `edit`/`write`.
A non-GPT fixture request exposes `edit`/`write` instead. The runner uses both
request types and a real `session.switchModel`, rather than forcing unavailable
tools into a model request. This does not test a commercial GPT model.

### Hooks are not instruction delivery or a transaction boundary

The second context hook sees the first hook's system contribution. The fixture
provider receives it alongside native launch instructions on every request.
Native external reads do not deliver either external root's or nested
`AGENTS.md`. A parallel read/write from one provider reply therefore cannot be
treated as evidence that the write was generated with newly read instructions.

A `Tool.Error` thrown by the first before hook prevents later before hooks,
native permission evaluation, and mutation for that call. **The after hook does
not run for that preflight failure.** Any future lease design must handle this
explicitly; unconditional before/acquire + after/release would leak a lease.

The sentinel patch intentionally puts an otherwise valid edit before a rejected
second target; neither target changes. This proves that a whole-call preflight
can reject a native patch. It is not an implementation of secure patch-target
parsing, instruction fingerprints, rename validation, or filesystem rollback.

### Permissions remain separate

The fixture allows external-directory access but denies a specific edit and
sensitive read through native session rules. Both tools fail with structured
`Permission.BlockedError`, the denied file is absent, and the secret never reaches
the provider. These configured denies short-circuit `permission.evaluate`; that
hook is not a complete denial audit trail. Diagnose the real tool failure rather
than requiring a callback the host does not emit. An `inspect` RPC also invokes
`permission.assert` using a validated real session, without agent IDs or fake
message/tool sources. Its configured denial rejects the RPC.

This establishes the mechanism, not the final browsing policy. The probe only
returns server/session metadata. Production folder browsing and root registration
still need the plan's separate human-initiated metadata policy; instruction/file
reads still require a real session's permissions.

### Native host scope is not a multi-root scope

The custom formatter gets the external file's absolute path but runs from the
launch directory. Registering another root must not imply loading its formatter,
LSP, plugins, or `.opencode` configuration. Snapshot diffs stay empty for these
external-only edits, and staging native undo does not restore them. Preserve
repository-specific Git/backups; do not advertise cross-repository undo.

### Lifecycle follow-up: native metadata snapshots

The native host copies parent metadata during ordinary child creation and during
forking. The probe writes a namespaced immutable `{catalogID, token}` marker,
creates a child/fork, then changes the parent's marker **before the child's first
inspection**. The child/fork retains the original token. A grandchild inherits its
own parent's token, not the root session's latest value. Both snapshots survive a
private-server restart. No live-event timing or first-prompt parent lookup is used.

This supplies a potential **inheritance carrier**, not an authoritative binding:
the future registry must validate the token, its catalog, and native ancestry.
The marker does not approve roots, permissions, instructions, or tool execution.
Two limitations are independently reproduced:

- Explicit `metadata` passed to child creation replaces inherited metadata and
  can omit the marker. Malformed markers are reported as invalid, not accepted.
- Session metadata updates replace the whole object. A deterministic stale
  read/second-writer/stale-write sequence drops the second writer's new field.
  Naive read/merge/write is therefore not concurrency-safe for other plugins.

The v2 registry remains the intended authority. The disposable journal below now
tests prepare/commit and reconciliation, but cannot make this carrier atomic or
authenticate explicit overrides. Missing/invalid markers cannot be repaired by
guessing the parent's current selection.

### Lifecycle follow-up: cancellation and a conservative boundary

The published Promise API accepts a `RequestOptions.signal`, but the installed
host's Promise adapter ignores it for `ctx.session.wait`. The negative-control
RPC remains pending beyond its deadline and settles only after the held model
request is released. This is reproduced without interrupting the agent or using
a real model. The version-specific adapter source confirms that its generic API
bridge accepts only the input argument and does not pass request options through.

The public **Effect plugin API** does not have this problem:
`ctx.session.wait(...).pipe(Effect.timeoutOption(...))` times out while the same
session remains running, and distinguishes a different idle session. The probe
uses this native, scoped operation; it does not abandon uncancellable waiters via
`Promise.race`, invent a host method, or open a separate HTTP connection.

A disposable `boundaryGate` prototype now demonstrates this conservative protocol
within **one host/Location**:

1. Context snapshot capture, covered native executors, and a stand-in epoch commit
   share one scoped semaphore.
2. Management attempts a non-waiting acquisition. A held executor makes it return
   busy without committing. Otherwise it checks every **provided** affected
   session with the cancellable native idle deadline while holding the gate.
3. A concurrently admitted request cannot capture context through that gate during
   the check/commit interval. If it prevents the host becoming idle, management
   conservatively times out instead of committing.
4. Expected epochs reject stale mutations. The counter is persisted before
   reporting success. Stale/missing request snapshots reject before calling the
   executor. Snapshot state itself is not restored after a restart.
5. The permit surrounds the real executor with Effect-scoped cleanup, rather than
   pairing before/after hooks. Native shell interruption, executor errors, and
   cancelled management checks release it without relying on lifecycle events.

The real-server test holds a native `shell` call through a disposable loopback
fixture, verifies management is rejected, interrupts that actual session, and
then commits successfully. Unit tests also exercise context/commit ordering,
stale snapshots, revisions, all-session checks, failed persistence, and unload.
The epoch survives a private-server restart; old runtime snapshots do not.

**This is not the production safe-switch service.** The fixture advances a counter
and accepts its test session list explicitly. Production must derive all affected
sessions from the authoritative catalog, share the gate across every instance
that can use that catalog, protect the complete model-request snapshot, and
revalidate catalog/Location ownership before committing. A caller-supplied session
list or an instance-local semaphore alone does not satisfy the product contract.

### Lifecycle follow-up: disposable binding journal

The new journal RPC is now exercised in the real private server, not only through
the fake atomic publisher in unit tests. `tests/helpers/journal-capability.ts`
uses public APIs for fixture-session metadata and **read-only** SQLite inspection
of the probe's own file. The journal adapter opens only `binding-journal.sqlite` beneath
its validated disposable fixture. This does not implement or migrate the v2 store.

Verified cases:

| Case | Observed result |
| --- | --- |
| Commit and request retry | One immutable issued token; retry leaves journal and native metadata unchanged; another unbound session stays unbound. |
| Interruption after `prepared` | After restart, recovery aborts without publishing. A separately paused live publisher also observes the durable abort when resumed and cannot publish. |
| Interruption after `publishing`, old marker still visible | Recovery, retry, resolution, and a new change return `PUBLICATION_PENDING`. The operation stays pending through both restarts; no guessed rollback or blind republication. |
| Interruption after native `mirror` publication | Journal still says publishing. A child's first resolution validates the issuer's exact marker and finalizes the operation without republishing. |
| Children, forks, and grandchild | Descendants created before the first restart retain their creation-time tokens. A fork's delayed first resolution still uses its token after another parent switch. |
| Detachment | A committed immutable null-selection token is recovered through a child; the child/fork stay detached after the parent reattaches elsewhere and after restart. |
| Pre-existing conflicts | Malformed/foreign/unknown markers, copied unrelated tokens, aborted tokens, lost/stale registered markers, omitted child markers, request/revision conflicts, unknown workspace/request IDs, and another Location reject without changing journal or native metadata. A conflicting published mirror remains pending and rejected after restart. |
| Second restart | Already resolved states are unchanged; unresolved publication/conflict errors persist; `PRAGMA integrity_check` returns `ok`; test-pause state does not survive. |

The fault injections throw at named durable stages, then the runner forcibly stops
and restarts **only its private process tree**. They are not a claim of physical
power-loss testing, atomicity between stores, or exhaustive interruption inside a
native metadata write. A read/merge/write gap is intentionally exposed by an
in-memory test pause, not hidden by a fixture lock.

OpenCode rejects `session.fork` on an empty session (`InvalidRequestError: Cannot
fork empty session`). The first journal integration run stopped at that fixture
assumption (`workspace-phase-zero-uQ9SvC`). The corrected fixture forks an existing
scripted transcript; it does not generate or synthesize administrative messages.
All journal checks and restarts leave provider request count unchanged and compare
each fixture session's conversation history before/after. The final TUI run has
15 scripted provider requests, all outside journal administration.

Two **negative controls** confirm why this prototype must not become the binding
service:

1. **The actual native metadata adapter is not CAS.** Pause after its `session.get`;
   a different authenticated public client writes both an unrelated field and a
   foreign journal marker; confirm those values are visible; resume the adapter's
   whole-object `session.update`. The adapter loses the field, overwrites the
   intervening marker conflict, and still reports a committed journal operation.
   The loss survives restart. The pre-existing-conflict checks above therefore
   do **not** establish fail-closed behavior for a concurrent writer in this gap.
   SQLite transactions protect only the probe journal, not the native mirror.
2. **Ancestry cannot authenticate the creation snapshot.** Attach a parent to X,
   retain its issued X token, switch it to Y, then create a child with explicit
   metadata containing that old X token. The probe accepts X because the token is
   genuine and its issuer is a native ancestor. This is a reproduced violation of
   creation-time selection, not successful inheritance. A missing override fails
   closed, but a valid-looking older token from the same ancestry is indistinguishable
   to this adapter. A unit negative control records the same limitation.

The pinned public `SessionUpdateInput` exposes `sessionID`, optional `title`,
`metadata`, and `permissions`, with no expected metadata/revision/CAS parameter.
The native metadata operation replaces the whole object. The public session hook
types have no awaited creation hook; `session.created` is a live event, not an
atomic admission boundary. These are host capability limitations, not storage
errors that a local lock/retry can repair for arbitrary other writers.

**Conclusion:** cooperative journal recovery is verified; authoritative production
binding publication and creation-time inheritance are not. Keep Sections 7–8 of
the development contract unchanged. Do not promote the adapter, use metadata as
the binding store, or proceed to the affected Phase 1/2 implementation on this
evidence.

### TUI follow-up: drafts, native dialog transitions, and source reload

The provider-disabled real-TUI runner now verifies more than the original empty
home-screen menu. Successful retained fixture: `workspace-phase-zero-0FPtFy`, with
**zero provider requests**, four real clients exercised sequentially, and eleven
recorded check groups:

- Invoke the same direct handler through slash completion and `command.palette.show`.
  Type an ASCII draft, open/close/cancel the probe through the palette, then append
  text to prove the restored composer is still editable. Compare actual current
  terminal cells, not old text retained in a raw ANSI transcript.
- Inspect a sessionless home view, sessions A and B at the same Location, and a
  session in the second Location. Assert the exact case-sensitive session ID and
  server-returned directory. `--session` is used only after validating an existing
  fixture session, because the CLI can create a missing supplied session ID.
- Replace a select with a native prompt using a dialog-local footer action, submit
  a label, return to the select, and finish. Escape in the replacement prompt cancels
  without a completion dialog or saved data. The controller explicitly awaits the
  replacement promise instead of mistaking the old select's `undefined` for cancellation.
- Repeat metadata inspection at 64 columns, keeping the draft intact. Normal-width
  checks use 110 columns. These are functional viewport checks, not proof that the
  future workspace indicator or every long-name/Unicode layout is correct.
- Append a comment to **only the generated fixture `tui.js`**. Native local-source
  watch unloads/setup a new generation both while idle and while its own menu is
  open. Observe distinct instance IDs, cleanup, a single registered command, a
  working replacement handler, and the original draft after each reload.
- Trigger three explicit fixture `session.created` events before/between reloads.
  Each reaches exactly one current-generation listener; none reaches an unloaded
  generation. All seeded and sentinel session histories stay empty, and inventory
  contains only sessions explicitly created by test setup, never by opening a menu.

The disposable TUI controller also rejects an action/result/error when the viewed
session or its Location changes. Unit tests exercise view changes during a menu
and during an RPC, plus listener cleanup on failed setup. Those stale-view cases
are **unit evidence**, not yet keyboard-driven in-session navigation or live RPC
reconnect acceptance.

`@xterm/headless@5.5.0` is pinned only in the test process. It parses the authenticated
private PTY's real frames and handles terminal cursor reports; it does not render
a standalone fake component or change the host UI. The driver ignores the PTY's
NUL/JSON cursor control frame. It waits for dialogs to disappear before subsequent
input: a draft can remain visible behind an alert, so draft visibility alone is
not proof the composer has focus. Early harness attempts exposed this timing
assumption, the absence of the home placeholder in empty session views, and the
need to preserve session-ID case while comparing wrapped Windows paths. No host
behavior or assertions were weakened to hide them.

The bounded test telemetry records only instance/event/session IDs and command
counts. No composer text, instruction bodies, file contents, or binding authority
is sent through that diagnostic RPC. Synthetic draft/output capture remains
confined to approved disposable fixtures.

**Remaining UI limits:** no public composer-state getter was found, so the checks
do not cover attachments, cursor/selection, or multiline draft state. Native
dialogs expose global `clear()` but no ownership token/query; safe handling of a
different plugin replacing the dialog during unload is not established by the
owned-menu reload test. Full workspace administration, the indicator, simultaneous
clients, true RPC disconnect/reconnect, plugin disable/re-enable, and published
package installation remain unverified. These results do not resolve either
binding blocker or authorize Phase 1.

### Instruction follow-up: scoped delivery and native mutation fingerprints

This proof is independent of the unsafe binding journal. A metadata-only test RPC
activates **fixed disposable roots** for a validated, empty fixture session. It
cannot select arbitrary directories, read file bodies through RPC, persist a
binding, or authorize inheritance. Unactivated sessions retain the original native
discovery negative control. No production entrypoint or registry was changed.

`tests/fixtures/phase-zero-plugin/instructions.ts` reads bounded UTF-8 sources,
records SHA-256 fingerprints, and builds one fresh JSON-framed context block per
ordinary request. Directory scopes, source paths, and source bodies are separate
JSON values, so instruction text cannot syntactically forge another scope record.
This does not prove that a model obeys the text or prevent semantic prompt injection.
Native launch/global guidance is retained. The plugin's newest block explicitly
supersedes earlier plugin snapshots; old text is not erased from conversation history.

`instruction-server.ts` uses the public context/before-tool hooks and real session
permissions. It prepares a nested scope on native read or rejected first touch;
only a later context capture can count that content as delivered. Native executors
and permission control flow are preserved. Successful preflights are correlated
by the real tool-call ID with the exact generating request received by the
loopback provider, not merely a trace of an earlier filesystem read.

Verified real-server cases:

| Case | Observed result |
| --- | --- |
| Both roots and session isolation | Both external root bodies, paths, aliases, and scopes reach the actual request. Another fixed A-only session receives no B source or undiscovered nested source. |
| Parallel read/write | The read succeeds but the same-reply nested write returns `INSTRUCTIONS_REQUIRED`, without creating its file. The next request contains the nested body; regenerated native write/edit calls succeed. |
| First-touch multi-root patch | An allowed first target and undisclosed second target reject as a whole; neither file changes. |
| Stale multi-root patch | The provider response is held after request assembly; the second target's rules change; releasing the generated patch rejects before changing even its otherwise-valid first target. |
| Rename | An undisclosed destination scope rejects before source removal or destination creation. The regenerated native patch succeeds after delivery. |
| Changed/deleted rules | A held generated write rejects after a hash change or deletion. The next request contains the replacement text or explicit missing-source status, and regenerated writes succeed. |
| Overlapping roots | Registered ancestor guidance remains present; the shared nested source occurs once. |
| Native permission denial | A configured read deny on root `AGENTS.md` prevents provider dispatch. It is not converted into a successful tool result or treated as a missing file. |
| Byte overflow | A source above 32 KiB, or discovered aggregate above 64 KiB, produces visible errors and `INSTRUCTIONS_UNAVAILABLE` on writes. No partial instruction bodies are marked delivered. |
| Declared small context | An 8,192-token fixture model is rejected by the unverified-budget guard; source bodies are withheld. This is a fail-closed negative case, not validation of support for a real small model. |

The 15 isolated unit tests additionally cover new instruction creation after
absence, invalid UTF-8/binary/nonregular sources, permission-control-flow identity,
invalidation, linked new-file parents, parent traversal boundaries, escaped source
framing, and rejected unsupported patch framing.

**Limits:** the adapter is a sequential primary-loop, single-host fixture proof,
not a production delivery ledger or authoritative session binding. The patch
adapter accepts an explicit conservative subset of the pinned native grammar and
rejects unsupported framing. It is not a complete production patch/path adapter.
Instruction-source filesystem changes after preflight, including during a native
permission wait, concurrent request replay, and other plugins changing later
request/hook input are not covered by these cases. There is no filesystem
transaction or general shell/MCP enforcement guarantee. The shell adapter requires
an explicit workdir but does not parse arbitrary command effects; its instruction
behavior has not received separate live acceptance in this increment.

The raw-byte caps do not account for JSON framing, tools, transcript, output reserve,
or tokenizer behavior. The declared 128k fixture does not establish a production
budget policy for real models. Smaller contexts deliberately fail closed rather
than applying an invented byte-to-token conversion. Compaction invalidation has
unit evidence only; native compaction/revert/restart, instruction-denial UI,
instruction-helper delivery, complete native schemas, and integration with catalog
boundaries remain acceptance work. Neither lifecycle blocker is resolved.

## Unresolved gates and next work

For an ordered continuation checklist and the verified journal's host blockers,
see the [Phase-zero handoff](PHASE_ZERO_HANDOFF.md).

1. **Creation-time inheritance.** The native metadata carrier is now verified,
   including delayed first inspection and restart. The disposable journal verifies
   token validation and conservative interruption recovery, but **native publication
   atomicity and override authentication are verified blockers for this candidate**.
   `session.created` is still not an awaited creation hook. Do not silently replace
   the contract with first-request parent lookup, assume that ancestry authenticates
   a snapshot, or treat mutable metadata as the binding store.
2. **Busy/safe-boundary protocol.** The client has `session.active` and the TUI has
   a cached status, but neither is an atomic server-side check-and-mutate API.
   `Plugin.Context.session` does not expose `active`, a lifecycle creation hook,
   or a plugin-defined safe-boundary control. Execution events contain a session
   ID, not a workspace lease epoch. Observed event delivery can lag context
   assembly. An event-only busy boolean is therefore not an acceptable lock.
   The Effect-native boundary primitive above now proves cancellable host waits
   and scoped executor cleanup, without an event-only busy flag. Integrate its
   protocol with complete catalog-derived affected-session sets, cross-instance
   serialization, and request snapshots before calling gate 8 satisfied. Do not
   use unauthenticated HTTP to reach missing plugin APIs.
3. **Instruction delivery and budgets.** Actual scoped root/nested delivery and
   covered preflight are now proved for the fixed-root scripted cases above, not
   a production binding/context service. The declared 128k provider and fail-closed
   8k negative case do not validate the byte caps on real models. Token/context-aware
   budgeting, lifecycle restoration, broader adapters, and permission-wait freshness
   remain acceptance gates for Phase 4.
4. **Broader UI acceptance.** The probe's real draft/routing/dialog/source-reload
   cases above are now established. Full administrative flows, indicator layout,
   simultaneous clients, RPC reconnect, arbitrary dialog ownership, multiline/input
   attachments, and packaged installation remain open. Unit stale-view/late-reply
   checks are not substitutes for live navigation and reconnect acceptance.

Phase 0's exit criterion is **not met yet**. No production service extraction,
registry schema migration, global configuration change, or removal of the old
commands is included in this increment. Keep the product contract unchanged;
resolve the two lifecycle gates before proceeding to the affected implementation.

## Sources checked

- [V2 plugins](https://opencode.ai/v2/docs/build/plugins/), [TUI](https://opencode.ai/v2/docs/build/plugins/cli/), [RPC](https://opencode.ai/v2/docs/build/plugins/rpc/), [client](https://opencode.ai/v2/docs/build/client/).
- [Effect plugins and runtime-provided dependencies](https://opencode.ai/v2/docs/build/plugins/effect/); installed public `effect` Semaphore/timeout types.
- [Instructions](https://opencode.ai/v2/docs/instructions/), [tools](https://opencode.ai/v2/docs/tools/), [permissions](https://opencode.ai/v2/docs/permissions/), [formatters](https://opencode.ai/v2/docs/formatters/), [snapshots](https://opencode.ai/v2/docs/snapshots/).
- Installed `@opencode/plugin@2.0.30`: `dist/promise/{plugin,session,tool,rpc,permission}.d.ts`, `dist/tui/context.d.ts`; installed client request/response types.
- Version-specific isolation mechanism: [CLI fixture environment](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/cli/test/fixture/environment.ts), [Global](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/util/src/global.ts), [XDG roots](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/util/src/global-roots.ts), [config discovery](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/core/src/config/discovery.ts).
- Public PTY connection protocol: [handler](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/server/src/handlers/pty.ts), [ticket header and routes](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/protocol/src/groups/pty.ts).
- Native metadata copying and replacement: [Session implementation](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/core/src/session.ts), [metadata operations](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/core/src/session/session.ts), [upstream creation/fork tests](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/core/test/session-create.test.ts).
- Promise cancellation limitation: [published adapter implementation](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/plugin/src/promise/adapter.ts), specifically `adaptApiMethod`; the isolated negative control is runtime evidence, not a type-only inference.
- Public session input/hook evidence: installed `@opencode/client@2.0.30`
  `dist/effect/api/api.d.ts` (`SessionCreateInput`, `SessionForkInput`,
  `SessionUpdateInput`) and `@opencode/plugin@2.0.30` `dist/effect/session.d.ts`.
  These expose no metadata CAS or awaited session-creation hook; the journal's
  public-client interleaving is the corresponding runtime counterexample.
- Public TUI command/route/dialog APIs: installed plugin `dist/tui/context.d.ts`
  and [V2 keybind reference](https://opencode.ai/v2/docs/cli/keybinds/).
  Versioned [TUI source watching](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/tui/src/plugin/watch.ts),
  [generation reconciliation/cleanup](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/tui/src/plugin/context.tsx),
  and [dialog bridge](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/tui/src/plugin/api.tsx).
  The runtime source-watch checks, not these source links alone, establish the cases above.

Runtime assertions, rather than type availability or documentation alone, support
the proved rows above. Open rows intentionally remain requirements, not features.
