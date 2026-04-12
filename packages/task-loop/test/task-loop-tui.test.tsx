/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"

import { getTaskLoopRecord, setTaskLoopRecord, startTaskLoopRun, clearTaskLoopRecord } from "../src/loop/state.js"
import mod from "../src/tui/index.js"
import { TaskLoopRoute } from "../src/tui/routes/task-loop.js"

const ids = new Set<string>()

function mark(...list: string[]) {
  for (const id of list) ids.add(id)
}

function theme() {
  return {
    text: "white",
    textMuted: "gray",
    accent: "blue",
    borderSubtle: "darkgray",
    warning: "yellow",
  }
}

function seed(
  id: string,
  input: { status?: string; summary?: string; active?: boolean; iteration?: number; max?: number } = {},
) {
  mark(id)
  setTaskLoopRecord({
    child_session_id: id,
    parent_session_id: "parent-1",
    parent_message_id: "msg-1",
    status: input.status ?? "completed",
    iteration: input.iteration ?? 1,
    max_iterations: input.max ?? 3,
    updated_at: Date.now(),
    summary: input.summary ?? "summary",
    stop_requested: false,
    recent_runs: [
      {
        run_id: `run-${id}`,
        parent_session_id: "parent-1",
        parent_message_id: "msg-1",
        child_session_id: id,
        status: (input.status ?? "completed") as never,
        iteration: input.iteration ?? 1,
        max_iterations: input.max ?? 3,
        updated_at: Date.now(),
        summary: input.summary ?? "summary",
      },
    ],
  })
  if (!input.active) return
  startTaskLoopRun({
    run_id: `active-${id}`,
    child_session_id: id,
    started_at: Date.now(),
  })
}

function api(input: {
  current?: { name: string; params?: Record<string, unknown> }
  abort?: (id: string) => Promise<{ error?: unknown }>
}) {
  const routes: Array<{ name: string; render: (props: { params?: Record<string, unknown> }) => unknown }> = []
  let cmd: (() => Array<Record<string, unknown>>) | undefined
  const nav: Array<{ name: string; params?: Record<string, unknown> }> = []
  const toast: Array<{ variant: string; message: string }> = []
  return {
    routes,
    nav,
    toast,
    value: {
      theme: { current: theme() },
      route: {
        register(list: Array<{ name: string; render: (props: { params?: Record<string, unknown> }) => unknown }>) {
          routes.push(...list)
        },
        navigate(name: string, params?: Record<string, unknown>) {
          nav.push({ name, params })
        },
        get current() {
          return input.current ?? { name: "home" }
        },
      },
      command: {
        register(fn: () => Array<Record<string, unknown>>) {
          cmd = fn
        },
      },
      ui: {
        toast(item: { variant: string; message: string }) {
          toast.push(item)
        },
      },
      client: {
        session: {
          abort: async ({ sessionID }: { sessionID: string }) =>
            input.abort ? input.abort(sessionID) : { error: undefined },
        },
      },
    },
    commands() {
      return cmd?.() ?? []
    },
  }
}

afterEach(() => {
  for (const id of ids) clearTaskLoopRecord({ child_session_id: id })
  ids.clear()
})

describe("task-loop tui", () => {
  test("registers command and route entries", async () => {
    seed("child-a", { status: "completed", summary: "done" })
    seed("child-b", { status: "running", summary: "busy", active: true })
    const host = api({ current: { name: "task-loop", params: { child_session_id: "child-b" } } })

    await mod.tui(host.value as never)

    expect(host.routes.map((item) => item.name)).toEqual(["task-loop"])
    const list = host.commands()
    expect(list.some((item) => item.value === "task-loop.monitor")).toBe(true)
    expect(list.some((item) => item.value === "task-loop.open.selected.child-b")).toBe(true)
    expect(list.some((item) => item.value === "task-loop.stop.child-b")).toBe(true)
  })

  test("renders the monitor and opens the selected child session", async () => {
    seed("child-open", { status: "running", summary: "watching", active: true })
    const host = api({ current: { name: "task-loop", params: { child_session_id: "child-open" } } })
    const app = await testRender(() => (
      <TaskLoopRoute api={host.value as never} params={{ child_session_id: "child-open" }} />
    ))

    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("Task loop monitor")
      expect(frame).toContain("child-open")
      expect(frame).toContain("watching")

      await app.mockInput.pressEnter()
      expect(host.nav.at(-1)).toEqual({
        name: "session",
        params: { sessionID: "child-open" },
      })
    } finally {
      app.renderer.destroy()
    }
  })

  test("stops the selected active run from the route", async () => {
    seed("child-stop", { status: "running", summary: "active", active: true })
    const hit: string[] = []
    const host = api({
      current: { name: "task-loop", params: { child_session_id: "child-stop" } },
      abort: async (id) => {
        hit.push(id)
        return { error: undefined }
      },
    })
    const app = await testRender(() => (
      <TaskLoopRoute api={host.value as never} params={{ child_session_id: "child-stop" }} />
    ))

    try {
      await app.renderOnce()
      await app.mockInput.pressKey("s")
      await Bun.sleep(20)
      expect(hit).toEqual(["child-stop"])
      expect(getTaskLoopRecord({ child_session_id: "child-stop" })?.stop_requested).toBe(true)
      expect(host.toast.at(-1)).toEqual({
        variant: "success",
        message: "Stop requested for child-stop",
      })
    } finally {
      app.renderer.destroy()
    }
  })
})
