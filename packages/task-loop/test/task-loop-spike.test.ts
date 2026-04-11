import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = path.resolve(import.meta.dir, "../../..")
const model = {
  providerID: "test",
  modelID: "test-model",
}

const cfg = (url: string, plugin: string) => ({
  model: "test/test-model",
  small_model: "test/test-model",
  plugin: [plugin],
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: url,
      },
    },
  },
})

type Item =
  | { type: "text"; text: string; wait?: number }
  | { type: "tool"; name: string; input: unknown; wait?: number }
  | { type: "hang"; wait?: number }

type Msg = { info: { role: string; time?: { completed?: number }; error?: { name?: string } }; parts: Array<any> }
type Log = Record<string, unknown>

function text(value: string) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ delta: { content: value } }],
  }
}

function role() {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ delta: { role: "assistant" } }],
  }
}

function finish(reason: string) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ delta: {}, finish_reason: reason }],
  }
}

function toolStart(name: string, args: string) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: {
                name,
                arguments: args,
              },
            },
          ],
        },
      },
    ],
  }
}

function lines(item: Item) {
  if (item.type === "text") return [role(), text(item.text), finish("stop")]
  if (item.type === "tool") return [role(), toolStart(item.name, JSON.stringify(item.input)), finish("tool_calls")]
  return [role()]
}

function stream(item: Item) {
  return new ReadableStream({
    start(ctrl) {
      for (const part of lines(item)) {
        ctrl.enqueue(`data: ${JSON.stringify(part)}\n\n`)
      }
      if (item.type === "hang") return
      ctrl.enqueue("data: [DONE]\n\n")
      ctrl.close()
    },
  })
}

async function llm(items: Item[]) {
  const hits: Array<Record<string, unknown>> = []
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response("not found", { status: 404 })
      const body = (await req.json()) as Record<string, unknown>
      hits.push(body)
      if (JSON.stringify(body).includes("Generate a title for this conversation")) {
        return new Response(stream({ type: "text", text: "Spike title" }), {
          headers: { "content-type": "text/event-stream" },
        })
      }
      const msgs = Array.isArray(body.messages) ? body.messages : []
      const last = msgs[msgs.length - 1] as Record<string, unknown> | undefined
      if (last?.role === "tool") {
        return new Response(stream({ type: "text", text: "ok" }), {
          headers: { "content-type": "text/event-stream" },
        })
      }
      const item = items.shift() ?? { type: "text", text: "ok" }
      if (item.wait) await Bun.sleep(item.wait)
      return new Response(stream(item), {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  return {
    url: `http://127.0.0.1:${srv.port}/v1`,
    stop() {
      srv.stop(true)
    },
    hits,
  }
}

async function temp() {
  return mkdtemp(path.join(os.tmpdir(), "task-loop-spike-"))
}

async function plugin(dir: string, log: string) {
  const file = path.join(dir, "plugin.ts")
  await writeFile(
    file,
    [
      'import { appendFile } from "node:fs/promises"',
      'import { tool } from "@opencode-ai/plugin"',
      'import { z } from "zod"',
      "",
      'const model = { providerID: "test", modelID: "test-model" }',
      `const log = ${JSON.stringify(log)}`,
      "",
      "function text(res) {",
      "  if (res.error) throw new Error(JSON.stringify(res.error))",
      '  return (res.data.parts ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\\n")',
      "}",
      "",
      'async function mark(row) { await appendFile(log, JSON.stringify(row) + "\\n") }',
      "",
      "export default async (input) => ({",
      "  tool: {",
      "    spike_loop: tool({",
      '      description: "Validate same-child sequential prompts",',
      "      args: { prompt: z.string() },",
      "      async execute(args, ctx) {",
      "        const child = await input.client.session.create({",
      '          body: { parentID: ctx.sessionID, title: "Task loop spike" },',
      "        })",
      "        if (child.error) throw new Error(JSON.stringify(child.error))",
      "        const id = child.data.id",
      '        ctx.metadata({ title: "task-loop-spike", metadata: { child: id } })',
      '        await mark({ phase: "created", child: id })',
      "        const first = await input.client.session.prompt({",
      "          path: { id },",
      '          body: { agent: "build", model, parts: [{ type: "text", text: `${args.prompt} 1` }] },',
      "        })",
      '        await mark({ phase: "after-first", child: id })',
      "        const second = await input.client.session.prompt({",
      "          path: { id },",
      '          body: { agent: "build", model, parts: [{ type: "text", text: `${args.prompt} 2` }] },',
      "        })",
      '        await mark({ phase: "after-second", child: id })',
      "        return JSON.stringify({ child: id, first: text(first), second: text(second) })",
      "      },",
      "    }),",
      "    spike_abort: tool({",
      '      description: "Validate abort cleanup for active child",',
      "      args: { prompt: z.string() },",
      "      async execute(args, ctx) {",
      "        const child = await input.client.session.create({",
      '          body: { parentID: ctx.sessionID, title: "Task loop abort spike" },',
      "        })",
      "        if (child.error) throw new Error(JSON.stringify(child.error))",
      "        const id = child.data.id",
      '        ctx.metadata({ title: "task-loop-abort", metadata: { child: id } })',
      "        const run = await input.client.session.promptAsync({",
      "          path: { id },",
      '          body: { agent: "build", model, parts: [{ type: "text", text: args.prompt }] },',
      "        })",
      "        if (run.error) throw new Error(JSON.stringify(run.error))",
      '        await mark({ phase: "started", child: id })',
      "        await new Promise((resolve) => {",
      "          ctx.abort.addEventListener(",
      '            "abort",',
      "            () => {",
      "              void (async () => {",
      "                const out = await input.client.session.abort({ path: { id } })",
      '                await mark({ phase: "aborted", child: id, ok: !out.error, reason: String(ctx.abort.reason ?? "") })',
      "                resolve(undefined)",
      "              })()",
      "            },",
      "            { once: true },",
      "          )",
      "        })",
      "        return JSON.stringify({ child: id, aborted: true })",
      "      },",
      "    }),",
      "  },",
      "})",
      "",
    ].join("\n"),
  )
  return pathToFileURL(file).href
}

function client(url: string) {
  const base = new URL(url)
  const headers = {
    "content-type": "application/json",
    "x-opencode-directory": encodeURIComponent(root),
  }
  const req = async (input: string, init?: RequestInit) => {
    const res = await fetch(new URL(input, base), {
      ...init,
      headers: {
        ...headers,
        ...(init?.headers ?? {}),
      },
    })
    if (res.status === 204) return { error: undefined, data: undefined }
    const data = await res.json()
    if (res.ok) return { error: undefined, data }
    return { error: data, data: undefined }
  }
  return {
    session: {
      create: (body?: unknown) => req("/session", { method: "POST", body: JSON.stringify(body ?? {}) }),
      status: () => req("/session/status", { method: "GET", headers: {} }),
      prompt: (id: string, body: unknown) =>
        req(`/session/${id}/message`, { method: "POST", body: JSON.stringify(body) }),
      promptAsync: (id: string, body: unknown) =>
        req(`/session/${id}/prompt_async`, { method: "POST", body: JSON.stringify(body) }),
      children: (id: string) => req(`/session/${id}/children`, { method: "GET", headers: {} }),
      messages: (id: string) => req(`/session/${id}/message`, { method: "GET", headers: {} }),
      abort: (id: string) => req(`/session/${id}/abort`, { method: "POST", headers: {} }),
    },
  }
}

async function server(port: number, config: unknown) {
  const proc = Bun.spawn(["opencode", "serve", `--hostname=127.0.0.1`, `--port=${port}`], {
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const end = Date.now() + 10_000
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/session/status?directory=${encodeURIComponent(root)}`)
      if (res.ok) {
        return {
          url: `http://127.0.0.1:${port}`,
          close() {
            proc.kill()
          },
        }
      }
    } catch {}
    if (proc.exitCode !== null) break
    await Bun.sleep(50)
  }
  throw new Error(`Failed to start server\n${await new Response(proc.stderr).text().catch(() => "")}`)
}

function toolPart(list: Msg[], name: string) {
  return list.flatMap((msg) => msg.parts).find((part) => part.type === "tool" && part.tool === name)
}

function state(list: Record<string, { type: string }>, id: string) {
  return list[id]?.type ?? "idle"
}

function done(list: Msg[]) {
  return list.filter((msg) => msg.info.role === "assistant" && !!msg.info.time?.completed).length
}

function textParts(list: Msg[]) {
  return list
    .filter((msg) => msg.info.role === "user")
    .flatMap((msg) => msg.parts)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
}

async function status(sdk: ReturnType<typeof client>) {
  return sdk.session.status()
}

function rows(value: string) {
  return value
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Log)
}

async function waitFor(fn: () => Promise<boolean>, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return
    await Bun.sleep(50)
  }
  throw new Error("Timed out waiting for condition")
}

async function createSession(sdk: ReturnType<typeof client>, title: string) {
  return sdk.session.create({ title })
}

async function prompt(sdk: ReturnType<typeof client>, id: string, value: string) {
  return sdk.session.prompt(id, {
    agent: "build",
    model,
    parts: [{ type: "text", text: value }],
  })
}

async function promptAsync(sdk: ReturnType<typeof client>, id: string, value: string) {
  return sdk.session.promptAsync(id, {
    agent: "build",
    model,
    parts: [{ type: "text", text: value }],
  })
}

const clean: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (clean.length) {
    await clean.pop()?.()
  }
})

describe("task-loop spike", () => {
  test("proves one tool call can send two sequential prompts into one child session", async () => {
    const dir = await temp()
    clean.push(() => rm(dir, { recursive: true, force: true }))
    const log = path.join(dir, "branch.log")
    await mkdir(path.dirname(log), { recursive: true })
    const mod = await plugin(dir, log)
    const mock = await llm([
      { type: "tool", name: "spike_loop", input: { prompt: "probe" } },
      { type: "text", text: "child-1", wait: 150 },
      { type: "text", text: "child-2", wait: 150 },
    ])
    clean.push(() => mock.stop())
    const srv = await server(4301, cfg(mock.url, mod))
    clean.push(() => srv.close())
    const sdk = client(srv.url)

    const parent = await createSession(sdk, "parent")
    if (parent.error) throw new Error(JSON.stringify(parent.error))
    const run = await prompt(sdk, parent.data.id, "run the spike")
    expect(run.error).toBeUndefined()

    let child = ""
    await waitFor(async () => {
      const kids = await sdk.session.children(parent.data.id)
      if (kids.error) throw new Error(JSON.stringify(kids.error))
      child = kids.data[0]?.id ?? ""
      return child.length > 0
    })

    await waitFor(async () => {
      const childMsgs = await sdk.session.messages(child)
      if (childMsgs.error) throw new Error(JSON.stringify(childMsgs.error))
      return textParts(childMsgs.data).join("|") === "probe 1|probe 2"
    })

    const parentMsgs = await sdk.session.messages(parent.data.id)
    if (parentMsgs.error) throw new Error(JSON.stringify(parentMsgs.error))
    const part = toolPart(parentMsgs.data, "spike_loop")
    expect(child.length > 0).toBe(true)
    expect(part?.metadata?.child).toBe(child)
    expect(part?.state.status).toBe("completed")
    if (part?.state.status !== "completed") throw new Error("Expected completed spike_loop tool state")
    expect(JSON.parse(part.state.output)).toEqual({
      child,
      first: "child-1",
      second: "child-2",
    })

    const childMsgs = await sdk.session.messages(child)
    if (childMsgs.error) throw new Error(JSON.stringify(childMsgs.error))
    expect(textParts(childMsgs.data)).toEqual(["probe 1", "probe 2"])
    expect(done(childMsgs.data)).toBe(2)

    const out = await status(sdk)
    if (out.error) throw new Error(JSON.stringify(out.error))
    expect(state(out.data, child)).toBe("idle")

    const logRows = rows(await readFile(log, "utf8"))
    expect(logRows).toEqual([
      { phase: "created", child },
      { phase: "after-first", child },
      { phase: "after-second", child },
    ])

    expect(logRows[1]?.child).toBe(child)
    expect(logRows[2]?.child).toBe(child)
  }, 20000)

  test("exercises abort while a child prompt is active and records teardown expectations", async () => {
    const dir = await temp()
    clean.push(() => rm(dir, { recursive: true, force: true }))
    const log = path.join(dir, "abort.log")
    const mod = await plugin(dir, log)
    const mock = await llm([
      { type: "tool", name: "spike_abort", input: { prompt: "hang" } },
      { type: "hang", wait: 150 },
    ])
    clean.push(() => mock.stop())
    const srv = await server(4302, cfg(mock.url, mod))
    clean.push(() => srv.close())
    const sdk = client(srv.url)

    const parent = await createSession(sdk, "parent abort")
    if (parent.error) throw new Error(JSON.stringify(parent.error))
    const start = await promptAsync(sdk, parent.data.id, "run the abort spike")
    expect(start.error).toBeUndefined()

    let child = ""
    await waitFor(async () => {
      const msgs = await sdk.session.messages(parent.data.id)
      if (msgs.error) throw new Error(JSON.stringify(msgs.error))
      const part = toolPart(msgs.data, "spike_abort")
      if (part?.state.status !== "running") return false
      if (typeof part.metadata?.child !== "string") return false
      child = part.metadata.child
      return true
    })

    const stop = await sdk.session.abort(parent.data.id)
    expect(stop.error).toBeUndefined()

    await waitFor(async () => {
      try {
        const out = await readFile(log, "utf8")
        return out.includes('"phase":"aborted"')
      } catch {
        return false
      }
    })

    await waitFor(async () => {
      const out = await status(sdk)
      if (out.error) throw new Error(JSON.stringify(out.error))
      return state(out.data, parent.data.id) === "idle" && state(out.data, child) === "idle"
    })

    await waitFor(async () => {
      const msgs = await sdk.session.messages(parent.data.id)
      if (msgs.error) throw new Error(JSON.stringify(msgs.error))
      return toolPart(msgs.data, "spike_abort")?.state.status === "error"
    })

    const logRows = rows(await readFile(log, "utf8"))
    expect(logRows).toEqual([
      { phase: "started", child },
      expect.objectContaining({ phase: "aborted", child, ok: true }),
    ])

    const parentMsgs = await sdk.session.messages(parent.data.id)
    if (parentMsgs.error) throw new Error(JSON.stringify(parentMsgs.error))
    const part = toolPart(parentMsgs.data, "spike_abort")
    expect(part?.metadata?.child).toBe(child)
    expect(part?.state.status).toBe("error")
    if (part?.state.status === "error") expect(part.state.error).toBe("Cancelled")

    const childMsgs = await sdk.session.messages(child)
    if (childMsgs.error) throw new Error(JSON.stringify(childMsgs.error))
    expect(textParts(childMsgs.data)).toEqual(["hang"])
    const last = childMsgs.data.findLast((msg) => msg.info.role === "assistant")
    expect(last?.info.error?.name).toBe("MessageAbortedError")
    expect(last?.info.time.completed).toBeDefined()
  }, 20000)
})
