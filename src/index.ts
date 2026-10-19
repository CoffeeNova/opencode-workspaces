import { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import * as fs from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { Alias, WorkspaceError, type Selection } from "./domain.ts"
import { Catalog } from "./infrastructure/catalog.ts"
import { importLegacy, previewLegacy } from "./infrastructure/legacy-import.ts"
import { absolute, browse, canonicalDirectory, checkedTarget, expanded, inside, overlapsRoots, pathKey, slash } from "./infrastructure/paths.ts"
import { searchWorkspace } from "./infrastructure/search.ts"
import { instructionBlock, instructionDelivery, InstructionError, patchTargets } from "./instructions/delivery.ts"
import { WorkspaceRPC } from "./rpc.ts"

function failure(error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error
  const code = (error as NodeJS.ErrnoException)?.code
  if (code && ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EBUSY", "SQLITE_BUSY"].includes(code)) return new WorkspaceError(code, "Workspace path or catalog is unavailable; reopen the menu after correcting it")
  throw error // Preserve native permission rejection and cancellation.
}

export default Plugin.define({
  id: "workspace-manager.v2",
  async setup(ctx) {
    if (ctx.options.catalogPath !== undefined && (typeof ctx.options.catalogPath !== "string" || !ctx.options.catalogPath.trim())) throw new Error("options.catalogPath must be a non-empty .sqlite path")
    if ((await ctx.tool.list()).some((tool) => tool.id === "workspace_read")) throw new Error("Do not load the legacy workspace-manager alongside the new package in one Location")
    const directory = slash(await fs.realpath(ctx.location.directory))
    const catalogPath = ctx.options.catalogPath ?? path.join(homedir(), ".config", "opencode", "workspace-manager", "workspaces-v2.sqlite")
    const catalog = await Catalog.open(catalogPath, directory)
    const deliveries = new Map<string, ReturnType<typeof instructionDelivery>>()
    const instructionStates = new Map<string, Selection["instructions"]>()
    async function compatible() {
      if ((await ctx.tool.list()).some((tool) => tool.id === "workspace_read")) throw new WorkspaceError("CONFLICTING_PLUGIN", "Disable the legacy workspace-manager and its Markdown commands in this Location before using this package")
    }
    async function session(sessionID: string) {
      await compatible()
      const session = await ctx.session.get({ sessionID })
      if (pathKey(await fs.realpath(session.location.directory)) !== pathKey(directory)) throw new WorkspaceError("LOCATION_MISMATCH", "Reopen workspace management in the session's own Location")
      const bound = catalog.selection(sessionID).binding
      if (bound?.workspace && pathKey(bound.directory) !== pathKey(directory)) throw new WorkspaceError("LOCATION_MISMATCH", "This binding belongs to the session's original Location")
      return session
    }
    try {
      const rpc = await ctx.rpc.register(WorkspaceRPC, {
        selection: async (input, call) => {
          try {
            await session(input.sessionID)
            const { binding, ...meta } = catalog.selection(input.sessionID)
            const workspace = binding?.workspace
            return { ...meta, workspace: workspace ? { id: workspace.id, name: workspace.name, revision: workspace.revision, rootCount: workspace.roots.length } : null, sealed: binding?.sealed ?? false, instructions: instructionStates.get(input.sessionID) ?? "not-loaded" }
          } catch (error) {
            const problem = failure(error)
            return call.error("workspace", problem.message, { code: problem.code })
          }
        },
        state: async (input, call) => {
          try {
            await compatible()
            if (input.sessionID) await session(input.sessionID)
            // A session created before plugin installation/reload can already
            // have history without a catalog row. Do not offer a dead attach UI.
            if (input.sessionID && !catalog.state(input.sessionID).binding?.sealed && (await ctx.session.context({ sessionID: input.sessionID })).length) catalog.capture(input.sessionID, directory)
            return catalog.state(input.sessionID)
          } catch (error) {
            const problem = failure(error)
            return call.error("workspace", problem.message, { code: problem.code })
          }
        },
        change: async (input, call) => {
          try {
            call.signal.throwIfAborted()
            await compatible()
            if (input.sessionID) await session(input.sessionID)
            const binding = input.sessionID ? catalog.state(input.sessionID).binding : null
            const bindingChange = input.action.kind === "attach" || input.action.kind === "detach"
            const empty = bindingChange && input.sessionID && !binding?.sealed ? (await ctx.session.context({ sessionID: input.sessionID })).length === 0 : false
            const root = input.action.kind === "addRoot" ? await canonicalDirectory(input.action.path, directory) : undefined
            call.signal.throwIfAborted()
            await compatible()
            const result = catalog.change(input, directory, empty, root)
            // Notification failure cannot change a committed result. Other
            // clients also reconcile through cheap authoritative selection reads.
            try { await rpc.events.emit("changed", { catalogID: result.catalogID, revision: result.revision, ...(bindingChange && input.sessionID ? { sessionID: input.sessionID } : {}) }) } catch {}
            return result
          } catch (error) {
            const problem = failure(error)
            return call.error("workspace", problem.message, { code: problem.code })
          }
        },
        legacyPreview: async (input, call) => {
          try {
            await compatible()
            return await previewLegacy(input.path, directory, call.signal)
          } catch (error) {
            const problem = failure(error)
            return call.error("workspace", problem.message, { code: problem.code })
          }
        },
        importLegacy: async (input, call) => {
          try {
            await compatible()
            const result = await importLegacy(catalog, input, directory, call.signal)
            try {
              const meta = catalog.state()
              await rpc.events.emit("changed", { catalogID: meta.catalogID, revision: meta.revision })
            } catch {}
            return result
          } catch (error) {
            const problem = failure(error)
            return call.error("workspace", problem.message, { code: problem.code })
          }
        },
        browse: async (input, call) => {
          try {
            call.signal.throwIfAborted()
            // Authenticated human administration: directory metadata only, even
            // at home. No instruction/content reads or invented tool context.
            const result = await browse(input.path ?? directory, directory)
            call.signal.throwIfAborted()
            return result
          } catch (error) {
            const problem = failure(error)
            return call.error("workspace", problem.message, { code: problem.code })
          }
        },
      })
      await ctx.session.hook("context", async (event) => {
        await session(event.sessionID)
        // The SQLite transaction seals selection before the model can generate
        // tools. Concurrent attach either commits first or is rejected as sealed.
        const binding = catalog.capture(event.sessionID, directory)
        if (!binding.workspace) {
          event.system.push({ type: "text", text: "No plugin workspace is selected in this session. Workspace selections are explicit and do not inherit from parents/forks. Ordinary OpenCode behavior and permissions are unchanged. Open a new workspace session through /workspace when needed." })
          return
        }
        let delivery = deliveries.get(event.sessionID)
        if (!delivery) {
          delivery = instructionDelivery(binding.workspace.roots, async (source) => {
            await ctx.permission.assert({ sessionID: event.sessionID, action: "external_directory", resources: [slash(path.dirname(source))], save: [] })
            await ctx.permission.assert({ sessionID: event.sessionID, action: "read", resources: [slash(source)], save: [] })
          })
          deliveries.set(event.sessionID, delivery)
        }
        const models = await ctx.model.list()
        const model = models.data.find((model) => model.providerID === event.model.providerID && model.id === event.model.id)
        instructionStates.set(event.sessionID, "not-loaded")
        let snapshot: Awaited<ReturnType<typeof delivery.capture>>
        try {
          snapshot = await delivery.capture(model?.limit.context ?? 0)
          instructionStates.set(event.sessionID, snapshot.errors.length ? "blocked" : "ready")
        } catch (error) {
          instructionStates.set(event.sessionID, "blocked")
          throw error
        } finally {
          try {
            const meta = catalog.selection(event.sessionID)
            await rpc.events.emit("changed", { catalogID: meta.catalogID, revision: meta.revision, sessionID: event.sessionID })
          } catch {} // A notification must never mask native permission control flow.
        }
        event.system.push({ type: "text", text: `Workspace ${JSON.stringify(binding.workspace.name)}, pinned revision ${binding.workspace.revision}. Saved-definition changes do not retarget this session. Native tools use absolute paths; shell requires an explicit workdir. Use workspace_glob/workspace_grep for safe multi-root search, optionally filtered by alias. Results include alias-qualified paths and per-root partial/truncation status; narrow the query when incomplete.\n${instructionBlock(snapshot)}` })
      })
      await ctx.session.hook("compaction", (event) => { deliveries.get(event.sessionID)?.invalidate(); instructionStates.delete(event.sessionID) })
      await ctx.tool.hook("execute.before", async (event) => {
        if (!["read", "edit", "write", "patch", "shell", "glob", "grep"].includes(event.tool)) return
        const bound = catalog.state(event.sessionID).binding?.workspace
        if (!bound) return
        try {
          await session(event.sessionID)
          const input = event.input as { path?: unknown; patchText?: unknown; workdir?: unknown }
          if (event.tool === "glob" || event.tool === "grep") {
            const searchDirectory = typeof input.path === "string" ? absolute(input.path, directory) : directory
            if (await overlapsRoots(searchDirectory, bound.roots)) throw new WorkspaceError("USE_WORKSPACE_SEARCH", "Use workspace_glob or workspace_grep for bound roots; native search cannot enforce workspace ignore and sensitive-path policy")
            return
          }
          const targets = event.tool === "patch" && typeof input.patchText === "string" ? patchTargets(input.patchText)
            : event.tool === "shell" && typeof input.workdir === "string" ? [input.workdir]
            : event.tool !== "shell" && typeof input.path === "string" ? [input.path] : []
          if (!targets.length) throw new WorkspaceError("INVALID_PATH", "An explicit native path or shell workdir is required")
          const covered: string[] = []
          for (const target of targets) {
            if (expanded(target).split("/").includes("..")) await ctx.permission.assert({ sessionID: event.sessionID, agent: event.agent, source: { type: "tool", messageID: event.messageID, id: event.id }, action: "workspace_escape", resources: [target], save: [], metadata: { workspaceManager: true } })
            const checked = await checkedTarget(target, bound.roots)
            if (checked) covered.push(checked)
          }
          if (!covered.length) return
          const delivery = deliveries.get(event.sessionID)
          if (!delivery) throw new WorkspaceError("INSTRUCTIONS_REQUIRED", "A fresh workspace request is required before native tools")
          if (event.tool === "read") await delivery.discover(covered)
          else await delivery.preflight(event.messageID, covered)
        } catch (error) {
          const problem = error instanceof InstructionError ? error : failure(error)
          throw new ToolError({ message: problem.message })
        }
      })
      await ctx.permission.hook("evaluate", (event) => {
        if (event.action === "workspace_escape" && event.metadata?.workspaceManager === true && event.effect !== "deny") event.effect = "ask"
      })
      await ctx.tool.transform((editor) => {
        for (const kind of ["glob", "grep"] as const) {
          const Search = z.object({
            pattern: z.string().min(1).max(4096), alias: Alias.optional(),
            ...(kind === "grep" ? { include: z.string().min(1).max(4096).optional() } : {}),
            exclude: z.array(z.string().min(1).max(4096)).max(32).optional(),
          }).strict()
          editor.add({
            name: `workspace_${kind}`,
            description: `Search this session's pinned workspace ${kind === "glob" ? "file paths by relative glob (also alias:/glob)" : "UTF-8 content by JavaScript regex, optionally filtered by include glob"}. Defaults to all roots; optional alias narrows to one. Honors nested .gitignore and exclude globs; skips sensitive paths and links. Deterministic per-root quotas share ${kind === "glob" ? 200 : 100} results. Reports partial/truncated/unavailable roots. Grep skips binary and >200 KiB files; scan/byte budgets and cancellation apply.`,
            input: z.toJSONSchema(Search), options: { codemode: false },
            execute: async (raw, context) => {
              context.signal.throwIfAborted()
              await session(context.sessionID)
              const parsed = Search.safeParse(raw)
              if (!parsed.success) throw new ToolError({ message: "INVALID_PATTERN: invalid workspace search arguments" })
              const binding = catalog.selection(context.sessionID).binding?.workspace
              if (!binding) throw new ToolError({ message: "NO_WORKSPACE: select a workspace in a new session through /workspace" })
              const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
              try {
                const result = await searchWorkspace(binding.roots, { kind, pattern: parsed.data.pattern, alias: parsed.data.alias, exclude: parsed.data.exclude, include: typeof parsed.data.include === "string" ? parsed.data.include : undefined }, {
                  signal: context.signal,
                  assert: (action, resource) => ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent, source, action, resources: [resource], save: [] }),
                })
                return { content: JSON.stringify(result) }
              } catch (error) {
                context.signal.throwIfAborted()
                if (error instanceof WorkspaceError) throw new ToolError({ message: error.message })
                throw error
              }
            },
          })
        }
        editor.add({
          name: "workspace_status", description: "Show this session's explicit pinned workspace selection. No global active selection; saved-definition edits do not retarget running sessions.",
          input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false },
          execute: async (_input, context) => {
            await session(context.sessionID)
            const binding = catalog.state(context.sessionID).binding
            return { content: JSON.stringify(binding ?? { workspace: null, sealed: false, directory }) }
          },
        })
        const Resolve = z.object({ path: z.string().min(1) }).strict()
        editor.add({
          name: "workspace_resolve", description: "Resolve alias:/relative/path to a canonical absolute native-tool path in this session. Prepares scoped instructions for the next model request; never reads file contents or changes files.",
          input: z.toJSONSchema(Resolve), options: { codemode: false },
          execute: async (raw, context) => {
            await session(context.sessionID)
            const input = Resolve.parse(raw)
            const binding = catalog.state(context.sessionID).binding?.workspace
            if (!binding) throw new ToolError({ message: "NO_WORKSPACE: select a workspace in a new session through /workspace" })
            const prefix = /^([a-z0-9_-]+):\/(.*)$/s.exec(input.path)
            const root = prefix ? binding.roots.find((root) => root.alias === prefix[1]) : undefined
            if (!root || !prefix || prefix[2]!.startsWith("/") || /^[a-z]:/i.test(prefix[2]!)) throw new ToolError({ message: "INVALID_PATH: use a registered alias:/relative/path" })
            const candidate = absolute(prefix[2] || ".", root.path)
            if (!inside(root.path, candidate)) throw new ToolError({ message: "OUTSIDE_ROOT: alias traversal is not allowed" })
            const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
            if (prefix[2]!.replaceAll("\\", "/").split("/").includes("..")) await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent, source, action: "workspace_escape", resources: [candidate], save: [], metadata: { workspaceManager: true } })
            await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent, source, action: "external_directory", resources: [root.path], save: [] })
            const checked = await checkedTarget(candidate, binding.roots)
            if (!checked) throw new ToolError({ message: "OUTSIDE_ROOT" })
            await deliveries.get(context.sessionID)?.discover([checked])
            return { content: JSON.stringify({ path: checked, alias: root.alias }) }
          },
        })
      })
    } catch (error) { catalog.close(); throw error }
    return () => { deliveries.clear(); instructionStates.clear(); catalog.close() }
  },
})
