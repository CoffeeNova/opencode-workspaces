import { afterEach, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs/promises"
import path from "node:path"
import { WorkspaceError } from "../../src/shared/errors.ts"
import type { Change } from "../../src/shared/schemas.ts"
import { Catalog } from "../../src/server/catalog/catalog.ts"
import { workspaceServer } from "../helpers/workspace-server.ts"

const hosts: Awaited<ReturnType<typeof workspaceServer>>[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose()
})
async function fixture(configured = true) {
  const host = await workspaceServer(configured)
  hosts.push(host)
  return host
}

type Host = Awaited<ReturnType<typeof workspaceServer>>
type EntryKind = "context" | "tool" | "compaction"

// Starts the session-entry hook for `kind` without awaiting its metadata lookup.
function startEntry(h: Host, kind: EntryKind, event: ReturnType<Host["request"]>) {
  if (kind === "context") return h.context(event)
  if (kind === "tool") return h.before("read", { path: "native-path" })
  return Promise.resolve(h.compact(event))
}

test("startup, passive requests and menu reads leave native behavior and missing storage untouched", async () => {
  const h = await fixture()
  expect(await fs.exists(path.dirname(h.catalogPath))).toBe(false)
  const opened = spyOn(fs, "open")
  try {
    const event = h.request()
    const nativeSystem = structuredClone(event.system)
    const nativeTools = Object.fromEntries(
      Object.entries(event.tools).filter(([name]) => !h.tools.has(name)),
    )
    await h.context(event)
    await h.before("read", { path: "alias:/.env" })
    await h.before("shell", {})
    await h.before("glob", { path: "../unrelated" })
    await h.compact({
      ...h.request(),
      result: { summary: "Another plugin's summary", metadata: { retained: true } },
    })
    expect(event.system).toEqual(nativeSystem)
    expect(event.tools).toEqual(nativeTools)
    expect(h.permissions).toEqual([])
    expect(h.modelCalls).toBe(0)
    expect(opened).not.toHaveBeenCalled()
    const state = await h.rpc.state({ sessionID: "ses_b" })
    expect(state).toEqual({
      catalogID: null,
      revision: 0,
      workspaces: [],
      binding: null,
      canAttach: true,
    })
    expect(await h.rpc.selection({ sessionID: "ses_b" })).toMatchObject({
      catalogID: null,
      workspace: null,
      sealed: false,
      instructions: "not-loaded",
    })
    expect(await fs.exists(path.dirname(h.catalogPath))).toBe(false)
  } finally {
    opened.mockRestore()
  }
})

test("passive helpers are absent from request schemas, excluded from Code Mode and independently reject execution", async () => {
  const h = await fixture()
  expect([...h.tools.keys()].sort()).toEqual([
    "workspace_glob",
    "workspace_grep",
    "workspace_resolve",
    "workspace_status",
  ])
  for (const [name, tool] of h.tools) {
    expect(tool.options?.codemode).toBe(false)
    await expect(h.execute(name)).rejects.toThrow("NO_WORKSPACE")
  }
  const event = await h.evaluate({
    sessionID: h.toolContext().sessionID,
    action: "workspace_escape",
    resources: ["outside"],
    effect: "allow",
    metadata: { workspaceManager: true },
  })
  expect(event.effect).toBe("allow")
  expect(await fs.exists(h.catalogPath)).toBe(false)
  expect(h.permissions).toEqual([])
})

test("definition administration and repeated eligibility reads never select or seal a session", async () => {
  const h = await fixture()
  const opened = spyOn(fs, "open")
  try {
    const created = await h.change({ kind: "create", name: "alpha" }, "ses_a")
    const workspace = created.workspaces[0]!
    await fs.writeFile(path.join(h.root, "AGENTS.md"), "MUST_NOT_LOAD_DURING_ADMIN")
    opened.mockClear()
    await h.change(
      { kind: "addRoot", workspaceID: workspace.id, path: h.root, alias: "docs" },
      "ses_a",
    )
    for (let index = 0; index < 3; index++)
      expect(await h.rpc.state({ sessionID: "ses_a" })).toMatchObject({
        binding: null,
        canAttach: true,
      })
    expect(h.bindingCount()).toBe(0)
    expect(h.modelCalls).toBe(0)
    expect(h.permissions).toEqual([])
    expect(opened).not.toHaveBeenCalled()
    await h.change({ kind: "remove", workspaceID: workspace.id }, "ses_a")
    expect(h.bindingCount()).toBe(0)
    expect(await fs.readFile(path.join(h.root, "AGENTS.md"), "utf8")).toBe(
      "MUST_NOT_LOAD_DURING_ADMIN",
    )
  } finally {
    opened.mockRestore()
  }
})

test("explicit attachment invalidates a passive lookup, preserves native instructions and isolates other sessions", async () => {
  const h = await fixture()
  await fs.writeFile(path.join(h.root, "AGENTS.md"), "REGISTERED_ROOT_RULE")
  const workspace = (await h.change({ kind: "create", name: "alpha" })).workspaces[0]!
  await h.change({ kind: "addRoot", workspaceID: workspace.id, path: h.root, alias: "docs" })
  expect((await h.rpc.state({ sessionID: "ses_a" })).binding).toBeNull()
  await h.change({ kind: "attach", workspaceID: workspace.id }, "ses_a")
  const active = h.request()
  await h.context(active)
  expect(active.system[0]).toEqual({ type: "text", text: "Native project/global instructions" })
  expect(JSON.stringify(active.system)).toContain("REGISTERED_ROOT_RULE")
  expect(active.system).toContainEqual(
    expect.objectContaining({
      type: "text",
      text: expect.stringContaining('Workspace "alpha", pinned revision'),
    }),
  )
  expect(Object.keys(active.tools)).toContain("workspace_status")
  expect(await h.rpc.selection({ sessionID: "ses_a" })).toMatchObject({
    workspace: { id: workspace.id },
    sealed: true,
    instructions: "ready",
  })
  const passive = h.request("ses_b")
  await h.context(passive)
  await h.before("write", { path: path.join(h.root, ".env") }, "ses_b")
  expect(passive.system).toHaveLength(1)
  expect(Object.keys(passive.tools)).not.toContain("workspace_status")
  expect(h.modelCalls).toBe(1)
  expect(h.bindingCount()).toBe(1)
  expect((await h.rpc.selection({ sessionID: "ses_child" })).workspace).toBeNull()
  await h.reload()
  const restored = h.request()
  await h.context(restored)
  expect(JSON.stringify(restored.system)).toContain("REGISTERED_ROOT_RULE")
  expect((await h.rpc.selection({ sessionID: "ses_b" })).workspace).toBeNull()
})

test("active sessions keep independent instruction sources and compaction invalidates only its session", async () => {
  const h = await fixture()
  const otherRoot = path.join(h.base, "independent root")
  await fs.mkdir(otherRoot)
  await Promise.all([
    fs.writeFile(path.join(h.root, "AGENTS.md"), "ONLY_ALPHA_RULE"),
    fs.writeFile(path.join(otherRoot, "AGENTS.md"), "ONLY_BETA_RULE"),
  ])
  const alpha = (await h.change({ kind: "create", name: "alpha" })).workspaces[0]!
  const beta = (await h.change({ kind: "create", name: "beta" })).workspaces.find(
    (workspace) => workspace.name === "beta",
  )!
  await h.change({ kind: "addRoot", workspaceID: alpha.id, path: h.root, alias: "alpha" })
  await h.change({ kind: "addRoot", workspaceID: beta.id, path: otherRoot, alias: "beta" })
  await h.change({ kind: "attach", workspaceID: alpha.id }, "ses_a")
  await h.change({ kind: "attach", workspaceID: beta.id }, "ses_b")
  const a = h.request("ses_a")
  const b = h.request("ses_b")
  await Promise.all([h.context(a), h.context(b)])
  expect(JSON.stringify(a.system)).toContain("ONLY_ALPHA_RULE")
  expect(JSON.stringify(a.system)).not.toContain("ONLY_BETA_RULE")
  expect(JSON.stringify(b.system)).toContain("ONLY_BETA_RULE")
  expect(JSON.stringify(b.system)).not.toContain("ONLY_ALPHA_RULE")
  await h.compact({ ...h.request("ses_a"), result: { summary: "Alpha compaction", metadata: {} } })
  expect((await h.rpc.selection({ sessionID: "ses_a" })).instructions).toBe("not-loaded")
  expect((await h.rpc.selection({ sessionID: "ses_b" })).instructions).toBe("ready")
  await h.before("write", { path: path.join(otherRoot, "new.txt") }, "ses_b")
  expect(h.bindingCount()).toBe(2)
})

test.each(["context", "tool", "compaction"] as const)(
  "%s entry wins admission before asynchronous metadata resolution",
  async (kind) => {
    const h = await fixture()
    const seeded = await h.seed()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const existing = Catalog.existing.bind(Catalog)
    const lookup = spyOn(Catalog, "existing").mockImplementation(async (raw, base) => {
      entered.resolve()
      await release.promise
      return existing(raw, base)
    })
    const event = h.request()
    const request = startEntry(h, kind, event)
    try {
      if (kind !== "compaction") await entered.promise
      const attach = {
        requestID: crypto.randomUUID(),
        expectedRevision: seeded.revision,
        sessionID: "ses_a",
        action: { kind: "attach", workspaceID: seeded.workspaces[0]!.id },
      } satisfies Change
      await expect(h.rpc.change(attach)).rejects.toThrow("SESSION_STARTED")
      expect(h.bindingCount()).toBe(0)
    } finally {
      release.resolve()
      await request
      lookup.mockRestore()
    }
    expect((await h.rpc.state({ sessionID: "ses_a" })).canAttach).toBe(false)
  },
)

test("the final admission recheck rejects a request starting after native empty-history validation", async () => {
  const h = await fixture()
  const workspace = (await h.change({ kind: "create", name: "alpha" })).workspaces[0]!
  const controller = new AbortController()
  let checks = 0
  const checkpoint = spyOn(controller.signal, "throwIfAborted").mockImplementation(() => {
    if (++checks === 2) void h.compact(h.request())
  })
  try {
    await expect(
      h.rpc.change(
        {
          requestID: crypto.randomUUID(),
          expectedRevision: 1,
          sessionID: "ses_a",
          action: { kind: "attach", workspaceID: workspace.id },
        },
        controller.signal,
      ),
    ).rejects.toThrow("SESSION_STARTED")
    expect(checks).toBe(2)
    expect(h.bindingCount()).toBe(0)
  } finally {
    checkpoint.mockRestore()
  }
})

test("admission retains exactly 10000 markers then disables new attachment without blocking passive work", async () => {
  const h = await fixture()
  const warning = spyOn(console, "warn").mockImplementation(() => {})
  try {
    for (let index = 0; index < 10_000; index++) await h.compact(h.request(`ses_started_${index}`))
    expect((await h.rpc.state({ sessionID: "ses_a" })).canAttach).toBe(true)
    h.addSession("ses_started_0")
    expect((await h.rpc.state({ sessionID: "ses_started_0" })).canAttach).toBe(false)
    await h.compact(h.request("ses_overflow"))
    expect((await h.rpc.state({ sessionID: "ses_a" })).canAttach).toBe(false)
    const workspace = (await h.change({ kind: "create", name: "alpha" })).workspaces[0]!
    await expect(h.change({ kind: "attach", workspaceID: workspace.id }, "ses_a")).rejects.toThrow(
      "SESSION_STARTED",
    )
    const event = h.request("ses_b")
    await h.context(event)
    expect(event.system).toHaveLength(1)
    expect(h.modelCalls).toBe(0)
    expect(warning).toHaveBeenCalledTimes(1)
  } finally {
    warning.mockRestore()
  }
})

test("active budget and native permission failures remain session-scoped instead of weakening preflight", async () => {
  const h = await fixture()
  await fs.writeFile(path.join(h.root, "AGENTS.md"), "ROOT_RULE")
  const workspace = (await h.change({ kind: "create", name: "alpha" })).workspaces[0]!
  await h.change({ kind: "addRoot", workspaceID: workspace.id, path: h.root, alias: "docs" })
  await h.change({ kind: "attach", workspaceID: workspace.id }, "ses_a")
  h.setContextLimit(32_000)
  await h.context(h.request())
  expect((await h.rpc.selection({ sessionID: "ses_a" })).instructions).toBe("blocked")
  await expect(h.before("write", { path: path.join(h.root, "new.txt") })).rejects.toThrow(
    "INSTRUCTIONS_UNAVAILABLE",
  )
  h.setContextLimit(128_000)
  const denied = Object.assign(new Error("native read denied"), { code: "EACCES" })
  h.denyPermission(denied)
  await expect(h.context(h.request())).rejects.toBe(denied)
  const passive = h.request("ses_b")
  await h.context(passive)
  expect(passive.system).toHaveLength(1)
  expect(h.bindingCount()).toBe(1)
})

test("known active storage failure is explicit while a previously confirmed passive session stays native", async () => {
  const h = await fixture()
  const workspace = (await h.change({ kind: "create", name: "alpha" })).workspaces[0]!
  await h.change({ kind: "attach", workspaceID: workspace.id }, "ses_a")
  await h.rpc.state({ sessionID: "ses_b" })
  const lookup = spyOn(Catalog.prototype, "selection").mockImplementation(() => {
    throw new WorkspaceError("CATALOG_UNAVAILABLE", "test outage")
  })
  const warning = spyOn(console, "warn").mockImplementation(() => {})
  try {
    await expect(h.context(h.request())).rejects.toThrow("CATALOG_UNAVAILABLE")
    await expect(h.before("write", { path: h.root })).rejects.toThrow("CATALOG_UNAVAILABLE")
    await expect(h.execute("workspace_status")).rejects.toThrow("CATALOG_UNAVAILABLE")
    const passive = h.request("ses_b")
    await h.context(passive)
    expect(passive.system).toHaveLength(1)
    expect(warning).toHaveBeenCalledTimes(1)
  } finally {
    lookup.mockRestore()
    warning.mockRestore()
  }
})

test("undiscovered storage failure preserves native requests but is not reported as confirmed passive", async () => {
  const h = await fixture()
  const lookup = spyOn(Catalog, "existing").mockRejectedValue(
    new WorkspaceError("CATALOG_UNAVAILABLE", "test startup outage"),
  )
  const warning = spyOn(console, "warn").mockImplementation(() => {})
  try {
    const event = h.request()
    await h.context(event)
    await h.before("write", { path: path.join(h.root, ".env") })
    expect(event.system).toEqual([{ type: "text", text: "Native project/global instructions" }])
    expect(Object.keys(event.tools)).not.toContain("workspace_status")
    expect(h.modelCalls).toBe(0)
    expect(h.permissions).toEqual([])
    await expect(h.execute("workspace_status")).rejects.toThrow("CATALOG_UNAVAILABLE")
    await expect(h.rpc.selection({ sessionID: "ses_a" })).rejects.toThrow("CATALOG_UNAVAILABLE")
    expect(warning).toHaveBeenCalledTimes(1)
    expect(warning.mock.calls[0]?.[0]).toContain("not a confirmed passive binding")
    expect(await fs.exists(path.dirname(h.catalogPath))).toBe(false)
  } finally {
    lookup.mockRestore()
    warning.mockRestore()
  }
})

test("default path is lazy/cached and an explicit override bypasses it", async () => {
  const h = await fixture(false)
  const defaultPath = spyOn(Catalog, "defaultPath").mockResolvedValue(h.catalogPath)
  try {
    expect(defaultPath).not.toHaveBeenCalled()
    await h.rpc.state()
    await h.rpc.state({ sessionID: "ses_a" })
    await h.change({ kind: "create", name: "alpha" })
    expect(defaultPath).toHaveBeenCalledTimes(1)
    const explicit = await fixture()
    await explicit.rpc.state()
    await explicit.change({ kind: "create", name: "beta" })
    expect(defaultPath).toHaveBeenCalledTimes(1)
    expect(await fs.exists(explicit.catalogPath)).toBe(true)
  } finally {
    defaultPath.mockRestore()
  }
})

test("aborted administrative writes do not initialize storage", async () => {
  const h = await fixture()
  const controller = new AbortController()
  controller.abort()
  await expect(
    h.rpc.change(
      {
        requestID: crypto.randomUUID(),
        expectedRevision: 0,
        action: { kind: "create", name: "cancelled" },
      },
      controller.signal,
    ),
  ).rejects.toThrow()
  expect(await fs.exists(path.dirname(h.catalogPath))).toBe(false)
  expect(h.events).toEqual([])
})

test("a failing change notification never fails a committed change or the context hook", async () => {
  const h = await fixture()
  h.failEvents(new Error("event channel closed"))
  const created = await h.change({ kind: "create", name: "alpha" })
  expect((await h.rpc.state()).workspaces.map((workspace) => workspace.name)).toEqual(["alpha"])
  await h.change({ kind: "attach", workspaceID: created.workspaces[0]!.id }, "ses_a")
  const event = h.request("ses_a")
  await h.context(event)
  expect(event.system).toContainEqual(
    expect.objectContaining({
      type: "text",
      text: expect.stringContaining('Workspace "alpha", pinned revision'),
    }),
  )
  expect(h.events).toEqual([])
})
