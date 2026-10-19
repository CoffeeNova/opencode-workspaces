# Opt-In Multi-Folder Workspaces: Implementation Plan

Status: planned; implementation is not authorized by creation of this document.
Date: 2026-10-19.
Baseline: commit `2fa5eea2658cddabca00e8670f20f3823af76030`, branch
`feat/multi-root-phase-zero`; recheck the checkout before implementation.
Target: OpenCode V2 2.0.32 with `@opencode/plugin` 2.0.30.

## 1. Goal and scope

Deliver an ordinary OpenCode plugin, installed once, that leaves normal
single-folder work unchanged until the user explicitly selects a workspace.
The normal entrypoint is `opencode` launched from the user's chosen directory,
not a wrapper that changes the execution directory to an AppData launcher.

Product acceptance sentence:

> I install the plugin and continue using OpenCode normally in my project.
> When I enter `/workspaces`, a deterministic menu opens. Opening or cancelling
> the menu does not activate anything. After I explicitly choose a workspace,
> I can work across its folders in a workspace-bound session without changing
> another session or the launch directory.

This plan governs the opt-in behavior and installation change. Read
[AGENTS.md](../AGENTS.md), the [existing development contract](DEVELOPMENT_PLAN.md),
and the [handoff](PHASE_ZERO_HANDOFF.md) first. This plan supersedes their
unconditional unbound-session sealing, permanent no-selection indicator, and
launcher-first installation assumptions only. It does not replace the existing
storage, permission, instruction-delivery, or pinned-session safety contracts.

Implement the feature after the user explicitly starts the implementation task.
Creating this plan is documentation work, not approval to change production code,
install globally, or run a test suite.

## 2. Mandatory working constraints

- Do not create, edit, delete, reformat, or run tests or test harnesses until the
  user explicitly approves test coverage. This includes smoke, capability, private
  runtime, and `check:workspaces` scripts. Do not add a replacement probe suite.
- Production-only typechecking, compilation, packaging, editor diagnostics,
  archive inspection, and documentation checks are permitted.
- Do not start OpenCode, create model requests, restart the shared service, modify
  real catalogs, or edit global/user configuration without separate authorization.
- Preserve unrelated changes. Do not stage, commit, push, or create branches
  unless requested. Recheck Git status rather than assuming the baseline is clean.
- Keep repository code and documentation in English. Keep changes focused on the
  owning production modules; reuse current RPC, catalog, path, and instruction code.
- Do not invent session-scoped host transforms, an atomic idle/attach API, or
  automatic inheritance. Use the public pinned API and report a real limitation.
- Implement first, with short static feedback loops. Do not reopen broad host
  research or expand earlier phases instead of delivering this feature.

## 3. Required behavior

### 3.1 Passive mode

An ordinary session with no workspace binding remains ordinary OpenCode:

- Keep its native Location, current directory, agents, providers, and permissions.
- Do not add workspace system text, root mappings, instruction sources, notices,
  synthetic messages, or composer content to its model requests or compaction.
- Do not expose this plugin's workspace helper schemas to that session's model,
  including indirect exposure through the host's Code Mode/tool namespace.
- Do not intercept, reject, redirect, or add workspace approvals to native tools.
- Do not show `[ws:none]`, loading dots, unavailable labels, or an empty footer
  contribution that reserves visible space.
- Do not run recurring selection RPC, metadata reconciliation, instruction reads,
  directory scans, or repository watchers for that passive session.
- Do not create a catalog or binding row merely because OpenCode starts, a normal
  request occurs, or an ordinary session is viewed.

The plugin must still load to register its command and restore previously
activated sessions. Small lifecycle hooks and bounded read-only binding discovery
are acceptable overhead; "no impact" means no changes to native user/model
behavior, not literally zero CPU, imports, listeners, or metadata reads.

### 3.2 Menu and activation

- `/workspaces` is the primary command and palette entry for the existing menu.
- Preserve `/workspace` as a compatibility alias to the same handler. Keep the
  existing add/switch entrypoints compatible; they must not activate implicitly.
- Opening the menu enables administration only. Listing, creating, editing,
  importing, or cancelling a saved definition does not select it for a session.
- The only transition to multi-folder mode is an explicit attach/open action.
- At home, that action creates an empty session, binds it, and navigates after
  successful binding. It never sends a prompt or invents a session ID.
- For a session with existing conversation history, offer a new workspace
  session; do not retrofit or retarget the ongoing conversation.
- Retain attachment to an empty current session only if the first-request race
  remains safely rejected. Otherwise use the existing open-new-session flow.
- Binding is per session, never global, per Location, or the last open menu.

### 3.3 Active mode and restoration

- After explicit activation, retain all existing multi-root capabilities:
  pinned root mapping, scoped current instructions, covered native preflight,
  bounded fair search, explicit-workdir shell guidance, and the footer indicator.
- Refresh/reconcile an active indicator, including reconnect and degraded states;
  hide it and stop its timers when the displayed session is passive or disappears.
- A previously bound session stays active after restart/reconnect without asking
  the user to type `/workspaces` again. Typing the command is an entrypoint to
  selection, not an ephemeral flag that replaces the persisted binding.
- New unrelated sessions and child/fork sessions do not inherit activation.
- Once work starts, switch or detach via an explicitly created new session.
  Do not erase or reinterpret the current conversation's instruction history.
- Opening an ordinary session does not detach or modify another bound session.

### 3.4 Storage and failure behavior

- Keep the existing SQLite catalog path/override, definitions, IDs, bindings,
  revisions, receipts, and legacy import data. Do not reset or silently migrate
  real user data as part of this feature.
- Avoid create-on-load storage access. If no catalog exists, startup and passive
  sessions must not create its parent directory, SQLite file, sidecars, or rows.
- Reading an existing binding for restoration is not permission to read root
  contents. Defer instructions until an active request can enforce permissions.
- Separate metadata lookup from mutating `capture()` and administrative writes.
  Menu/status reads must not persistently seal an ordinary session.
- Workspace errors are actionable when workspace functionality is requested.
  Do not block all ordinary sessions because an unused catalog is unavailable.
- Never silently downgrade a known active session to passive when its binding
  cannot be confirmed. Its workspace operations must fail closed, with visible
  degraded state and no stale/guessed mapping.
- Startup restoration with an unreadable existing catalog needs an explicit,
  documented resolution policy. Do not equate "lookup failed" with "unbound"
  or add a second authoritative binding store to hide the ambiguity. Report a
  remaining host/storage limitation rather than claiming both guarantees passed.

## 4. Current implementation anchors

These describe the inspected baseline, not the target behavior. Recheck nearby
code before editing; do not infer implementation from this table alone.

| Surface | Current behavior | Required ownership change |
| --- | --- | --- |
| [src/index.ts](../src/index.ts) setup | Opens/creates the SQLite catalog immediately | Separate passive metadata discovery from explicit administrative initialization |
| Context hook in the same file | Calls `capture()` for every request and injects a no-selection message | Resolve mode first; ordinary requests receive no workspace contribution |
| State RPC in the same file | Can seal a session with history during a menu read | Return eligibility without mutating an ordinary binding |
| Tool registration in the same file | Registers search/status/resolve helpers for the Location | Keep model exposure and executable guards session-aware |
| Native-tool hook in the same file | Reads catalog state before returning for an unbound session | Fast passive return; preserve strict active preflight |
| [src/infrastructure/catalog.ts](../src/infrastructure/catalog.ts) | `capture()` seals bound and unbound rows; attach uses an immediate transaction | Preserve bound sealing, add explicit non-mutating lookup and safe activation boundary |
| [src/tui.ts](../src/tui.ts) | Registers `/workspace`; eagerly installs indicator integration | Add plural primary command/alias; separate management from activation |
| [src/tui/indicator.ts](../src/tui/indicator.ts) | Polls each viewed session and renders a no-selection label | Discover bounded state once; poll/render only for confirmed active mode |
| [src/rpc.ts](../src/rpc.ts), [src/domain.ts](../src/domain.ts) | Shared state/selection schemas | Add only metadata/eligibility fields that the passive/active distinction actually needs |
| [scripts/start.ts](../scripts/start.ts), [README.md](../README.md) | Neutral AppData launcher is the primary install path | Make direct plugin installation and ordinary `opencode` primary; wrapper optional |

The installed TUI type supports `slash.aliases`. The public context hook has a
mutable `event.tools` schema map. These are useful local API facts, not proof that
removing a schema also removes every executable or Code Mode exposure path.

## 5. Implementation order

### Step 1. Establish the passive/active boundary

Start with the catalog lookup and context hook, not installation wording.

1. Define mode resolution around the invoking session's persisted binding.
   Keep transient UI state separate from binding authority.
2. Reuse the catalog abstraction for bounded, read-only restoration/discovery.
   Do not duplicate SQL or trust a process-global active-workspace variable.
3. Distinguish missing catalog, unbound session, active binding, and unavailable
   resolution. Keep explicit administrative creation lazy and single-flight.
4. Make ordinary context, native-tool, permission, and compaction paths return
   without workspace mutations or text. Do not enumerate definitions per tool.
5. Keep existing stored bindings readable and active after plugin reload/restart.

Exit: source inspection and production typechecking show a clear passive return
before capture, instruction reads, or workspace-specific permission work.

### Step 2. Preserve first-request and selection safety

Removing unbound `capture()` blindly would reopen a race: an ordinary request
could pass its context hook, then an attach could retarget that same session
before its generated tools execute.

1. Preserve the invariant that explicit selection and first request cannot race
   into a changed root mapping. A SQLite revision alone does not cover native
   history checks performed outside the transaction.
2. Use a small per-session serialization/admission boundary where the pinned
   public hooks support it. Bounded transient started-request markers may be
   necessary; they must not persist an unbound row for every ordinary session.
3. Check actual native history/eligibility when activating after reload. Do not
   trust an empty in-memory cache as evidence that an old session is empty.
4. Prefer opening a fresh workspace session when an existing session has history
   or eligibility is uncertain. Do not advertise a newly created host session as
   private/atomic merely because the TUI has not navigated to it yet.
5. Preserve backend enforcement, cancellation, idempotency, pinned snapshots,
   and both sessions' independence. Disabled menu controls are not sufficient.

Exit: the implementation has an explicit argument for the request/attach ordering
and rejects uncertainty rather than implementing unsafe live mode switching.

### Step 3. Make helper exposure opt-in

1. Hide this plugin's helper schemas in passive model requests using supported
   per-request mechanisms; never remove unrelated/native/other-plugin tools.
2. Inspect the pinned host's Code Mode construction boundary before claiming
   schema filtering removes its indirect helper inventory as well. Keep this
   check local; do not start a new capability research project.
3. Guard registered helper executors independently: an unbound session cannot
   enable workspace mode or obtain another session's roots through a direct call.
4. Reuse existing helper executors and native adapters for active sessions.
   Do not globally register/unregister tools when one session opens a menu.
5. If full passive schema hiding is unsupported, report that exact limitation;
   do not invent a session-scoped tool-transform API or claim full invisibility.

Exit: passive model assembly excludes workspace-only contributions, while active
sessions retain current behavior and an unrelated session remains unaffected.

### Step 4. Make UI activation explicit and the indicator passive-safe

1. Register `/workspaces` as primary and `/workspace` as an alias using the same
   controller. Preserve stable existing command IDs where practical.
2. Keep menu/status reads side-effect-free for ordinary sessions. Derive whether
   attachment is allowed from native session eligibility without creating a row.
3. Show the existing explicit new-session action for conversations already started.
4. On startup/session navigation, allow a bounded metadata lookup to restore an
   existing selection. Do not start a repeated timer for a confirmed passive view.
5. Mount/render the indicator only for active or known-active-degraded sessions;
   cancel pending requests, timers, and stale replies when leaving them.
6. Use existing change events and explicit menu refreshes to notice activation
   in another client. Keep reconnect/missed-event recovery for active sessions.
7. Preserve drafts, cancellation, no-model menu operation, and listener cleanup.

Exit: opening/cancelling the menu changes neither the model context nor session
selection; ordinary views have no workspace label or recurring selection poll.

### Step 5. Make normal installation the primary workflow

1. Rewrite the current-package README entry section to describe one-time plugin
   registration followed by ordinary `opencode` from any chosen working folder.
2. For checkout installation, build and register the absolute `dist` directory.
   On pinned OpenCode 2.0.32, local-directory resolution probes root-level
   `index`/`server`, `tui`, and `rpc` files, not package `exports` at checkout root.
3. Document global registration for availability in ordinary projects, or local
   registration for opt-in availability in one project. Use one registration,
   never duplicate global/local entries for the same package.
4. Keep `bun run start` only as an optional isolated development/demo launcher.
   Do not silently change the launch directory in the plugin itself.
5. Do not edit the user's global registration or remove existing launcher files,
   legacy source, catalogs, or conversations during implementation. Installation
   into the real environment is a separate authorized action.
6. Preserve external host UI runtimes, compiled exports, runtime dependencies,
   archive layout, catalog defaults/overrides, and legacy import/rollback behavior.
7. Explain that native launch-project/global instructions still apply. Multi-root
   mode does not erase them or load each root's plugins/configuration.

Exit: the documented normal user path has no mandatory AppData directory, npm/Bun
wrapper, custom OpenCode executable, or new provider authentication workflow.

### Step 6. Deliver with permitted verification only

After each production change, use the cheapest relevant static/compile check.
From the repository root, the allowed final commands are:

```powershell
bun run typecheck
bun run build
bun run pack
git diff --check
```

Use the pinned cached Bun executable or the existing npm Bun bootstrap if Bun is
not on PATH. Do not substitute the older broad typecheck or any test script.
Inspect the archive statically; do not import its plugin or start OpenCode as an
unapproved runtime check. Validate changed Markdown links and relevant editor
diagnostics. Review the diff for unrelated edits and leave Git state unstaged.

Update README and the handoff after implementation so they no longer describe
the old ordinary-session side effects as intentional. Record the affected
contracts in the existing development plan without calling unverified acceptance
complete. Stop at the user review/test-approval boundary.

## 6. Acceptance checklist for later approval

This is a future coverage specification, not permission to implement or run tests.
Old test counts and previous manual success do not establish these new guarantees.

| Scenario | Required result |
| --- | --- |
| First normal launch without an existing catalog | No catalog, directories, sidecars, bindings, workspace prompt text, or recurring poll are created |
| Ordinary request with an existing shared catalog | Native cwd/instructions/tools/permissions unchanged; no new unbound row or workspace model schemas |
| Native and Code Mode tool use in passive session | No helper exposure or alternative activation path; ordinary native operations remain native |
| `/workspaces`, create/edit definition, cancel | No model request, binding change, lost draft, or automatic multi-root activation |
| Explicit select from home | Empty session is bound before navigation; no synthetic user/model turn |
| Select from a started ordinary conversation | Explicit new-session flow; original conversation/cwd remain unchanged |
| First request races with explicit selection | One defined order wins; no tools execute against an unexpected root snapshot |
| Active and ordinary sessions share one Location | Context, helpers, indicator, events, and polling stay session-specific |
| Restart/reconnect and existing active binding | Selection and appropriate indicator return; no repeat command needed |
| Passive view or navigation away from active view | No footer space/label and no recurring selection timer; stale replies discarded |
| Unavailable catalog | Passive work is not globally hijacked; known active work fails closed; restoration ambiguity is reported |
| Model budget unsupported | Active workspace reports the current limitation; ordinary work is not subjected to that workspace gate |
| New normal launch from a different directory | Native project remains that directory; no forced AppData/workspace cwd |
| Old `/workspace` command | Same deterministic controller as `/workspaces`, without duplicate layers |

## 7. Completion report

The implementation agent must report:

- What changed in passive behavior, explicit activation, restoration, and install.
- Which production-only checks actually ran and their outcomes.
- Any SDK/runtime limitation or unresolved failure/activation race, without hiding it.
- That test files/harnesses were not changed or executed and runtime acceptance
  still awaits approval.
- That real user configuration/catalogs, the shared service, and Git history were
  not modified, or identify any separately authorized exception precisely.

Do not end with another broad research plan. Deliver the focused implementation
or a concrete blocker, then wait for the user's review before test work.