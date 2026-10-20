import { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import * as fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { errorCode, isUnavailableCode, WorkspaceError } from "./shared/errors.ts"
import { SEARCH_LIMITS, SESSION_LIMITS } from "./shared/limits.ts"
import { Alias, type Binding, type Selection, type Workspace } from "./shared/schemas.ts"
import { Catalog } from "./infrastructure/catalog.ts"
import {
  absolute,
  browse,
  canonicalDirectory,
  checkedTarget,
  expanded,
  inside,
  overlapsRoots,
  pathKey,
  slash,
} from "./infrastructure/paths.ts"
import { searchWorkspace, type SearchInput } from "./infrastructure/search.ts"
import {
  instructionBlock,
  instructionDelivery,
  InstructionError,
  patchTargets,
} from "./instructions/delivery.ts"
import { WorkspaceRPC } from "./rpc.ts"

function failure(error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error
  const code = errorCode(error)
  if (isUnavailableCode(code))
    return new WorkspaceError(
      code,
      "Workspace path or catalog is unavailable; reopen /workspace after correcting it",
    )
  throw error // Preserve native permission rejection and cancellation.
}

const helperTools = [
  "workspace_glob",
  "workspace_grep",
  "workspace_status",
  "workspace_resolve",
] as const
// Native tool input is unknown; only these string fields can name a preflight target.
const NativeTarget = z.object({
  path: z.string().optional().catch(undefined),
  patchText: z.string().optional().catch(undefined),
  workdir: z.string().optional().catch(undefined),
})
const SearchFields = {
  pattern: z.string().min(1).max(SEARCH_LIMITS.patternLength),
  alias: Alias.optional(),
}
const SearchExclude = z
  .array(z.string().min(1).max(SEARCH_LIMITS.patternLength))
  .max(SEARCH_LIMITS.excludes)
  .optional()
const GlobSearch = z.object({ ...SearchFields, exclude: SearchExclude }).strict()
const GrepSearch = z
  .object({
    ...SearchFields,
    include: z.string().min(1).max(SEARCH_LIMITS.patternLength).optional(),
    exclude: SearchExclude,
  })
  .strict()
function searchInput(kind: SearchInput["kind"], raw: unknown): SearchInput | undefined {
  if (kind === "glob") {
    const parsed = GlobSearch.safeParse(raw)
    return parsed.success ? { kind, ...parsed.data } : undefined
  }
  const parsed = GrepSearch.safeParse(raw)
  return parsed.success ? { kind, ...parsed.data } : undefined
}
type Inactive = { mode: "passive" } | { mode: "unavailable"; error: WorkspaceError }
type Resolution = Inactive | { mode: "active"; binding: Binding & { workspace: Workspace } }

export default Plugin.define({
  id: "workspace-manager.v2",
  async setup(ctx) {
    if (
      ctx.options.catalogPath !== undefined &&
      (typeof ctx.options.catalogPath !== "string" || !ctx.options.catalogPath.trim())
    )
      throw new Error("options.catalogPath must be a non-empty .sqlite path")
    const directory = slash(await fs.realpath(ctx.location.directory))
    const configuredCatalogPath = ctx.options.catalogPath
    let catalogPath: Promise<string> | undefined
    let catalog: Catalog | undefined
    let reader: Catalog | undefined
    let reading: Promise<Catalog | undefined> | undefined
    let writing: Promise<Catalog> | undefined
    let disposed = false
    const knownActive = new Set<string>()
    const inactive = new Map<string, Inactive>()
    const started = new Set<string>()
    let admissionFull = false
    const deliveries = new Map<string, ReturnType<typeof instructionDelivery>>()
    const instructionStates = new Map<string, Selection["instructions"]>()
    function requestStarted(sessionID: string) {
      if (started.has(sessionID) || admissionFull) return
      if (started.size < SESSION_LIMITS.admissionMarkers) started.add(sessionID)
      else {
        admissionFull = true
        console.warn(
          "[workspace-manager] Session admission capacity reached; further attachment is disabled until plugin reload. Native passive sessions remain unchanged.",
        )
      }
    }
    function cacheInactive(sessionID: string, value: Inactive) {
      inactive.delete(sessionID)
      inactive.set(sessionID, value)
      if (inactive.size > SESSION_LIMITS.inactiveCache)
        inactive.delete(inactive.keys().next().value!)
    }
    function catalogLocation() {
      catalogPath ??= (
        configuredCatalogPath === undefined
          ? Catalog.defaultPath()
          : Promise.resolve(configuredCatalogPath)
      ).catch((error: unknown) => {
        catalogPath = undefined
        throw error
      })
      return catalogPath
    }
    async function metadataCatalog() {
      if (catalog) return catalog
      if (writing) return writing
      if (reader) return reader
      reading ??= catalogLocation()
        .then((file) => Catalog.existing(file, directory))
        .then((value) => {
          if (disposed) {
            value?.close()
            throw new WorkspaceError("PLUGIN_DISPOSED", "Workspace plugin was unloaded")
          }
          reader = value
          return value
        })
        .finally(() => {
          reading = undefined
        })
      return reading
    }
    async function writableCatalog(create: boolean) {
      if (catalog) return catalog
      writing ??= catalogLocation()
        .then((file) => Catalog.open(file, directory, create))
        .then((value) => {
          if (disposed) {
            value.close()
            throw new WorkspaceError("PLUGIN_DISPOSED", "Workspace plugin was unloaded")
          }
          catalog = value
          return value
        })
        .finally(() => {
          writing = undefined
        })
      return writing
    }
    function remember(sessionID: string, binding: Binding | null) {
      if (binding?.workspace) {
        knownActive.add(sessionID)
        if (pathKey(binding.directory) !== pathKey(directory))
          throw new WorkspaceError(
            "LOCATION_MISMATCH",
            "This binding belongs to the session's original Location",
          )
        inactive.delete(sessionID)
      } else {
        if (knownActive.has(sessionID))
          throw new WorkspaceError(
            "BINDING_UNAVAILABLE",
            "This session's active binding cannot be confirmed; restore its catalog before continuing workspace work",
          )
        cacheInactive(sessionID, { mode: "passive" })
      }
    }
    async function selection(sessionID: string) {
      const current = await metadataCatalog()
      const result = current?.selection(sessionID) ?? {
        catalogID: null,
        revision: 0,
        binding: null,
      }
      remember(sessionID, result.binding)
      return result
    }
    async function resolve(sessionID: string): Promise<Resolution> {
      const cached = inactive.get(sessionID)
      if (cached && !knownActive.has(sessionID)) return cached
      try {
        const { binding } = await selection(sessionID)
        return binding?.workspace
          ? { mode: "active", binding: { ...binding, workspace: binding.workspace } }
          : { mode: "passive" }
      } catch (error) {
        const problem = failure(error)
        if (cached?.mode !== "unavailable" || cached.error.message !== problem.message)
          console.warn(
            `[workspace-manager] Binding resolution unavailable for ${sessionID}: ${problem.message}. Known active sessions fail closed; an undiscovered session retains native behavior, not a confirmed passive binding. Reopen /workspace after restoring catalog access.`,
          )
        const result: Inactive = { mode: "unavailable", error: problem }
        cacheInactive(sessionID, result)
        return result
      }
    }
    async function canAttach(sessionID: string | undefined, binding: Binding | null) {
      if (!sessionID || binding?.sealed || started.has(sessionID) || admissionFull) return false
      const empty = (await ctx.session.context({ sessionID })).length === 0
      return empty && !started.has(sessionID) && !admissionFull
    }
    async function session(sessionID: string) {
      const session = await ctx.session.get({ sessionID })
      if (pathKey(await fs.realpath(session.location.directory)) !== pathKey(directory))
        throw new WorkspaceError(
          "LOCATION_MISMATCH",
          "Reopen workspace management in the session's own Location",
        )
      return session
    }
    async function workspaceBinding(sessionID: string) {
      requestStarted(sessionID)
      try {
        const resolved = await resolve(sessionID)
        if (resolved.mode === "unavailable") throw resolved.error
        if (resolved.mode === "passive")
          throw new WorkspaceError(
            "NO_WORKSPACE",
            "Explicitly select a workspace through /workspace in an empty or new session",
          )
        await session(sessionID)
        const binding = (await writableCatalog(false)).capture(sessionID, directory)
        if (!binding?.workspace)
          throw new WorkspaceError(
            "BINDING_UNAVAILABLE",
            "The active workspace binding disappeared; restore its catalog before continuing",
          )
        return { ...binding, workspace: binding.workspace }
      } catch (error) {
        const problem = failure(error)
        throw new ToolError({ message: problem.message })
      }
    }
    try {
      const rpc = await ctx.rpc.register(WorkspaceRPC, {
        selection: async (input, call) => {
          try {
            await session(input.sessionID)
            const { binding, ...meta } = await selection(input.sessionID)
            const workspace = binding?.workspace
            return {
              ...meta,
              workspace: workspace
                ? {
                    id: workspace.id,
                    name: workspace.name,
                    revision: workspace.revision,
                    rootCount: workspace.roots.length,
                  }
                : null,
              sealed: binding?.sealed ?? false,
              instructions: instructionStates.get(input.sessionID) ?? "not-loaded",
            }
          } catch (error) {
            const problem = failure(error)
            return call.error("workspace", problem.message, { code: problem.code })
          }
        },
        state: async (input, call) => {
          try {
            if (input.sessionID) await session(input.sessionID)
            const current = await metadataCatalog()
            const state = current?.state(input.sessionID) ?? {
              catalogID: null,
              revision: 0,
              workspaces: [],
              binding: null,
            }
            if (input.sessionID) remember(input.sessionID, state.binding)
            return { ...state, canAttach: await canAttach(input.sessionID, state.binding) }
          } catch (error) {
            const problem = failure(error)
            return call.error("workspace", problem.message, { code: problem.code })
          }
        },
        change: async (input, call) => {
          try {
            call.signal.throwIfAborted()
            if (input.sessionID) await session(input.sessionID)
            const catalog = await writableCatalog(input.action.kind === "create")
            const binding = input.sessionID ? catalog.selection(input.sessionID).binding : null
            const bindingChange = input.action.kind === "attach" || input.action.kind === "detach"
            const empty = await canAttach(input.sessionID, binding)
            const root =
              input.action.kind === "addRoot"
                ? await canonicalDirectory(input.action.path, directory)
                : undefined
            call.signal.throwIfAborted()
            // No await separates this admission check from the SQLite commit.
            // A context/tool hook marks started synchronously at entry: either
            // attach commits first or that request permanently rejects attach.
            const admitted =
              empty && !admissionFull && !!input.sessionID && !started.has(input.sessionID)
            const result = catalog.change(input, directory, admitted, root)
            if (input.sessionID) {
              if (input.action.kind === "detach" && !result.binding?.workspace)
                knownActive.delete(input.sessionID)
              remember(input.sessionID, result.binding)
            }
            // Notification failure cannot change a committed result. Other
            // clients also reconcile through cheap authoritative selection reads.
            try {
              await rpc.events.emit("changed", {
                catalogID: result.catalogID,
                revision: result.revision,
                ...(bindingChange && input.sessionID ? { sessionID: input.sessionID } : {}),
              })
            } catch {}
            return {
              ...result,
              canAttach:
                admitted &&
                !result.binding?.sealed &&
                !admissionFull &&
                !!input.sessionID &&
                !started.has(input.sessionID),
            }
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
        requestStarted(event.sessionID)
        const resolved = await resolve(event.sessionID)
        if (resolved.mode !== "active") {
          for (const name of helperTools) delete event.tools[name]
          if (resolved.mode === "unavailable" && knownActive.has(event.sessionID))
            throw resolved.error
          return
        }
        await session(event.sessionID)
        const catalog = await writableCatalog(false)
        const binding = catalog.capture(event.sessionID, directory)
        if (!binding?.workspace)
          throw new WorkspaceError(
            "BINDING_UNAVAILABLE",
            "The active workspace binding disappeared; restore its catalog before continuing",
          )
        let delivery = deliveries.get(event.sessionID)
        if (!delivery) {
          delivery = instructionDelivery(binding.workspace.roots, async (source) => {
            await ctx.permission.assert({
              sessionID: event.sessionID,
              action: "external_directory",
              resources: [slash(path.dirname(source))],
              save: [],
            })
            await ctx.permission.assert({
              sessionID: event.sessionID,
              action: "read",
              resources: [slash(source)],
              save: [],
            })
          })
          deliveries.set(event.sessionID, delivery)
        }
        const models = await ctx.model.list()
        const model = models.data.find(
          (model) => model.providerID === event.model.providerID && model.id === event.model.id,
        )
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
            await rpc.events.emit("changed", {
              catalogID: meta.catalogID,
              revision: meta.revision,
              sessionID: event.sessionID,
            })
          } catch {} // A notification must never mask native permission control flow.
        }
        event.system.push({
          type: "text",
          text: `Workspace ${JSON.stringify(binding.workspace.name)}, pinned revision ${binding.workspace.revision}. Saved-definition changes do not retarget this session. Native tools use absolute paths; shell requires an explicit workdir. Use workspace_glob/workspace_grep for safe multi-root search, optionally filtered by alias. Results include alias-qualified paths and per-root partial/truncation status; narrow the query when incomplete.\n${instructionBlock(snapshot)}`,
        })
      })
      await ctx.session.hook("compaction", (event) => {
        requestStarted(event.sessionID)
        deliveries.get(event.sessionID)?.invalidate()
        instructionStates.delete(event.sessionID)
      })
      await ctx.tool.hook("execute.before", async (event) => {
        requestStarted(event.sessionID)
        if (!["read", "edit", "write", "patch", "shell", "glob", "grep"].includes(event.tool))
          return
        try {
          const resolved = await resolve(event.sessionID)
          if (resolved.mode === "passive") return
          if (resolved.mode === "unavailable") {
            if (knownActive.has(event.sessionID)) throw resolved.error
            return
          }
          const bound = resolved.binding.workspace
          await session(event.sessionID)
          const parsed = NativeTarget.safeParse(event.input)
          const input: z.infer<typeof NativeTarget> = parsed.success ? parsed.data : {}
          if (event.tool === "glob" || event.tool === "grep") {
            const searchDirectory =
              input.path !== undefined ? absolute(input.path, directory) : directory
            if (await overlapsRoots(searchDirectory, bound.roots))
              throw new WorkspaceError(
                "USE_WORKSPACE_SEARCH",
                "Use workspace_glob or workspace_grep for bound roots; native search cannot enforce workspace ignore and sensitive-path policy",
              )
            return
          }
          const targets =
            event.tool === "patch" && input.patchText !== undefined
              ? patchTargets(input.patchText)
              : event.tool === "shell" && input.workdir !== undefined
                ? [input.workdir]
                : event.tool !== "shell" && input.path !== undefined
                  ? [input.path]
                  : []
          if (!targets.length)
            throw new WorkspaceError(
              "INVALID_PATH",
              "An explicit native path or shell workdir is required",
            )
          const covered: string[] = []
          for (const target of targets) {
            if (expanded(target).split("/").includes(".."))
              await ctx.permission.assert({
                sessionID: event.sessionID,
                agent: event.agent,
                source: { type: "tool", messageID: event.messageID, id: event.id },
                action: "workspace_escape",
                resources: [target],
                save: [],
                metadata: { workspaceManager: true },
              })
            const checked = await checkedTarget(target, bound.roots)
            if (checked) covered.push(checked)
          }
          if (!covered.length) return
          const delivery = deliveries.get(event.sessionID)
          if (!delivery)
            throw new WorkspaceError(
              "INSTRUCTIONS_REQUIRED",
              "A fresh workspace request is required before native tools",
            )
          if (event.tool === "read") await delivery.discover(covered)
          else await delivery.preflight(event.messageID, covered)
        } catch (error) {
          const problem = error instanceof InstructionError ? error : failure(error)
          throw new ToolError({ message: problem.message })
        }
      })
      await ctx.permission.hook("evaluate", (event) => {
        if (
          knownActive.has(event.sessionID) &&
          event.action === "workspace_escape" &&
          event.metadata?.workspaceManager === true &&
          event.effect !== "deny"
        )
          event.effect = "ask"
      })
      await ctx.tool.transform((editor) => {
        for (const kind of ["glob", "grep"] as const) {
          editor.add({
            name: `workspace_${kind}`,
            description: `Search this session's pinned workspace ${kind === "glob" ? "file paths by relative glob (also alias:/glob)" : "UTF-8 content by JavaScript regex, optionally filtered by include glob"}. Defaults to all roots; optional alias narrows to one. Honors nested .gitignore and exclude globs; skips sensitive paths and links. Deterministic per-root quotas share ${kind === "glob" ? SEARCH_LIMITS.globResults : SEARCH_LIMITS.grepResults} results. Reports partial/truncated/unavailable roots. Grep skips binary and >200 KiB files; scan/byte budgets and cancellation apply.`,
            input: z.toJSONSchema(kind === "glob" ? GlobSearch : GrepSearch),
            options: { codemode: false },
            execute: async (raw, context) => {
              context.signal.throwIfAborted()
              const { workspace: binding } = await workspaceBinding(context.sessionID)
              const input = searchInput(kind, raw)
              if (!input)
                throw new ToolError({
                  message: "INVALID_PATTERN: invalid workspace search arguments",
                })
              const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
              try {
                const result = await searchWorkspace(binding.roots, input, {
                  signal: context.signal,
                  assert: (action, resource) =>
                    ctx.permission.assert({
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source,
                      action,
                      resources: [resource],
                      save: [],
                    }),
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
          name: "workspace_status",
          description:
            "Show this session's explicit pinned workspace selection. No global active selection; saved-definition edits do not retarget running sessions.",
          input: { type: "object", properties: {}, additionalProperties: false },
          options: { codemode: false },
          execute: async (_input, context) => {
            context.signal.throwIfAborted()
            const binding = await workspaceBinding(context.sessionID)
            return { content: JSON.stringify(binding) }
          },
        })
        const Resolve = z.object({ path: z.string().min(1) }).strict()
        editor.add({
          name: "workspace_resolve",
          description:
            "Resolve alias:/relative/path to a canonical absolute native-tool path in this session. Prepares scoped instructions for the next model request; never reads file contents or changes files.",
          input: z.toJSONSchema(Resolve),
          options: { codemode: false },
          execute: async (raw, context) => {
            context.signal.throwIfAborted()
            const { workspace: binding } = await workspaceBinding(context.sessionID)
            const input = Resolve.parse(raw)
            const prefix = /^([a-z0-9_-]+):\/(.*)$/s.exec(input.path)
            const root = prefix ? binding.roots.find((root) => root.alias === prefix[1]) : undefined
            if (!root || !prefix || prefix[2]!.startsWith("/") || /^[a-z]:/i.test(prefix[2]!))
              throw new ToolError({
                message: "INVALID_PATH: use a registered alias:/relative/path",
              })
            const candidate = absolute(prefix[2] || ".", root.path)
            if (!inside(root.path, candidate))
              throw new ToolError({ message: "OUTSIDE_ROOT: alias traversal is not allowed" })
            const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
            if (prefix[2]!.replaceAll("\\", "/").split("/").includes(".."))
              await ctx.permission.assert({
                sessionID: context.sessionID,
                agent: context.agent,
                source,
                action: "workspace_escape",
                resources: [candidate],
                save: [],
                metadata: { workspaceManager: true },
              })
            await ctx.permission.assert({
              sessionID: context.sessionID,
              agent: context.agent,
              source,
              action: "external_directory",
              resources: [root.path],
              save: [],
            })
            const checked = await checkedTarget(candidate, binding.roots)
            if (!checked) throw new ToolError({ message: "OUTSIDE_ROOT" })
            await deliveries.get(context.sessionID)?.discover([checked])
            return { content: JSON.stringify({ path: checked, alias: root.alias }) }
          },
        })
      })
    } catch (error) {
      disposed = true
      catalog?.close()
      reader?.close()
      throw error
    }
    return () => {
      disposed = true
      deliveries.clear()
      instructionStates.clear()
      knownActive.clear()
      inactive.clear()
      started.clear()
      catalog?.close()
      reader?.close()
    }
  },
})
