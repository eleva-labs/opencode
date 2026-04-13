import { afterEach, describe, expect, test } from "bun:test"

import { server } from "../src/index.js"
import {
  clearTaskLoopRecord,
  getTaskLoopRecord,
  getTaskLoopRun,
  setTaskLoopRecord,
  startTaskLoopRun,
} from "../src/loop/state.js"
import { evaluateTaskLoopStop, formatTaskLoopSummary, hasTaskLoopCompletion } from "../src/loop/logic.js"
import { getTaskLoopMetaView } from "../src/tool/task-loop.js"
import { readFile } from "node:fs/promises"

const ids = new Set<string>()

function mark(...list: string[]) {
  for (const id of list) ids.add(id)
}

function text(value: string) {
  return {
    data: {
      parts: [{ type: "text", text: value }],
    },
  }
}

function fail(value: unknown) {
  if (value instanceof Error) {
    return JSON.parse(value.message) as {
      category: string
      message: string
    }
  }
  return JSON.parse(String((value as Error).message)) as {
    category: string
    message: string
  }
}

function ctx() {
  const ctrl = new AbortController()
  const meta: Array<Record<string, unknown>> = []
  return {
    ctrl,
    meta,
    value: {
      sessionID: "parent-1",
      messageID: "msg-1",
      agent: "build",
      abort: ctrl.signal,
      metadata(value: Record<string, unknown>) {
        meta.push(value)
      },
    },
  }
}

function client(opts: {
  create?: (input: { body: { parentID: string; title: string } }) => Promise<any>
  prompt?: (input: {
    path: { id: string }
    body: { agent: string; parts: Array<{ type: string; text: string }> }
  }) => Promise<any>
  abort?: (input: { path: { id: string } }) => Promise<any>
}) {
  return {
    session: {
      create:
        opts.create ??
        (async () => ({
          data: { id: "child-new" },
        })),
      prompt:
        opts.prompt ??
        (async () => ({
          data: { parts: [{ type: "text", text: "done [COMPLETE]" }] },
        })),
      abort:
        opts.abort ??
        (async () => ({
          data: {},
        })),
    },
  }
}

async function tool(input = client({})) {
  const mod = await server({ client: input } as never)
  return mod.tool.task_loop
}

afterEach(() => {
  for (const id of ids) clearTaskLoopRecord({ child_session_id: id })
  ids.clear()
})

describe("task-loop logic", () => {
  test("detects completion markers", () => {
    expect(
      hasTaskLoopCompletion({
        assistant_text: "work complete [DONE]",
        completion: { marker: "[DONE]" },
      }),
    ).toBe(true)
    expect(
      hasTaskLoopCompletion({
        assistant_text: "still working",
        completion: { marker: "[DONE]" },
      }),
    ).toBe(false)
  })

  test("enforces max iterations and stop transitions", () => {
    expect(
      evaluateTaskLoopStop({
        iteration: 2,
        max_iterations: 4,
        assistant_text: "done [DONE]",
        completion: { marker: "[DONE]" },
        stop_requested: false,
      }),
    ).toEqual({ should_stop: true, reason: "completion_reported" })

    expect(
      evaluateTaskLoopStop({
        iteration: 4,
        max_iterations: 4,
        assistant_text: "no marker",
        completion: { marker: "[DONE]" },
        stop_requested: false,
      }),
    ).toEqual({ should_stop: true, reason: "max_iterations_reached" })

    expect(
      evaluateTaskLoopStop({
        iteration: 2,
        max_iterations: 4,
        assistant_text: "no marker",
        completion: { marker: "[DONE]" },
        stop_requested: true,
      }),
    ).toEqual({ should_stop: true, reason: "operator_stop" })
  })

  test("formats summaries compactly", () => {
    expect(formatTaskLoopSummary("  alpha\n\n beta\t gamma  ")).toBe("alpha beta gamma")
    expect(formatTaskLoopSummary(" ")).toBe("")
    expect(formatTaskLoopSummary("x".repeat(400))).toHaveLength(280)
  })

  test("rejects concurrent controllers and preserves stop state", () => {
    mark("child-conflict")
    setTaskLoopRecord({
      child_session_id: "child-conflict",
      parent_session_id: "parent-1",
      parent_message_id: "msg-1",
      status: "running",
      iteration: 1,
      max_iterations: 3,
      updated_at: 1,
      summary: "busy",
      stop_requested: false,
      recent_runs: [],
    })

    expect(
      startTaskLoopRun({
        run_id: "run-1",
        child_session_id: "child-conflict",
        started_at: 1,
      }),
    ).toEqual({
      ok: true,
      value: {
        run_id: "run-1",
        child_session_id: "child-conflict",
        started_at: 1,
      },
    })

    expect(
      startTaskLoopRun({
        run_id: "run-2",
        child_session_id: "child-conflict",
        started_at: 2,
      }),
    ).toEqual({
      ok: false,
      error: "Only one active controller may own a child session in MVP",
    })

    setTaskLoopRecord({
      child_session_id: "child-conflict",
      parent_session_id: "parent-1",
      parent_message_id: "msg-1",
      status: "stopped",
      iteration: 1,
      max_iterations: 3,
      updated_at: 3,
      summary: "stopped",
      stop_requested: true,
      recent_runs: [],
    })

    expect(getTaskLoopRecord({ child_session_id: "child-conflict" })?.stop_requested).toBe(true)
    expect(getTaskLoopRun({ child_session_id: "child-conflict" })?.run_id).toBe("run-1")
  })
})

describe("task-loop server", () => {
  test("registers task_loop and runs a new child session with repeated prompts", async () => {
    const creates: string[] = []
    const prompts: Array<{ id: string; text: string }> = []
    let i = 0
    const execute = await tool(
      client({
        create: async ({ body }) => {
          creates.push(body.title)
          return { data: { id: "child-new" } }
        },
        prompt: async ({ path, body }) => {
          prompts.push({ id: path.id, text: body.parts[0]!.text })
          i += 1
          return i === 1 ? text("working") : text("done [DONE]")
        },
      }),
    )
    const run = ctx()
    mark("child-new")

    const out = await execute.execute(
      {
        initial_prompt: "step one",
        continuation_prompt: "continue",
        max_iterations: 3,
        completion: { marker: "[DONE]" },
        description: "Loop test",
      },
      run.value as never,
    )

    expect(creates).toEqual(["Loop test"])
    expect(prompts).toEqual([
      { id: "child-new", text: "step one" },
      { id: "child-new", text: "continue" },
    ])
    expect(out).not.toContain("child_session_id")
    expect(out).toContain("status: completed")
    expect(out).toContain("iteration: 2/3")
    expect(run.meta[0]).toEqual(
      getTaskLoopMetaView({
        child_session_id: "child-new",
        status: "running",
        iteration: 0,
        max_iterations: 3,
        summary: "Loop test",
      }),
    )
    expect(run.meta.at(-1)).toEqual(
      getTaskLoopMetaView({
        child_session_id: "child-new",
        status: "completed",
        iteration: 2,
        max_iterations: 3,
        summary: "done [DONE]",
      }),
    )
    expect(getTaskLoopRecord({ child_session_id: "child-new" })?.recent_runs[0]?.status).toBe("completed")
    expect(getTaskLoopRun({ child_session_id: "child-new" })).toBeNull()
  })

  test("always creates a new child session for each run", async () => {
    const creates: string[] = []
    const prompts: Array<{ id: string; text: string }> = []
    const execute = await tool(
      client({
        create: async ({ body }) => {
          creates.push(body.title)
          return { data: { id: "unexpected" } }
        },
        prompt: async ({ path, body }) => {
          prompts.push({ id: path.id, text: body.parts[0]!.text })
          return text("follow-up [DONE]")
        },
      }),
    )
    const run = ctx()
    mark("unexpected")

    const out = await execute.execute(
      {
        initial_prompt: "resume",
        continuation_prompt: "resume more",
        max_iterations: 2,
        completion: { marker: "[DONE]" },
      },
      run.value as never,
    )

    expect(creates).toEqual(["Task loop"])
    expect(prompts).toEqual([{ id: "unexpected", text: "resume" }])
    expect(out).not.toContain("child_session_id")
    expect(run.meta[0]).toEqual(
      getTaskLoopMetaView({
        child_session_id: "unexpected",
        status: "running",
        iteration: 0,
        max_iterations: 2,
        summary: "new_run_on_new_session",
      }),
    )
  })

  test("rejects a second controller for the created child session", async () => {
    mark("child-busy")
    setTaskLoopRecord({
      child_session_id: "child-busy",
      parent_session_id: "parent-1",
      parent_message_id: "msg-1",
      status: "running",
      iteration: 0,
      max_iterations: 2,
      updated_at: 1,
      stop_requested: false,
      recent_runs: [],
    })
    startTaskLoopRun({
      run_id: "busy-run",
      child_session_id: "child-busy",
      started_at: 1,
    })
    const execute = await tool(
      client({
        create: async () => ({ data: { id: "child-busy" } }),
      }),
    )

    try {
      await execute.execute(
        {
          initial_prompt: "resume",
          continuation_prompt: "continue",
          max_iterations: 2,
          completion: { marker: "[DONE]" },
        },
        ctx().value as never,
      )
      throw new Error("Expected conflict")
    } catch (err) {
      expect(fail(err).category).toBe("loop_conflict")
    }

    expect(getTaskLoopRecord({ child_session_id: "child-busy" })?.status).toBe("running")
    expect(getTaskLoopRun({ child_session_id: "child-busy" })?.run_id).toBe("busy-run")
  })

  test("cleans up active ownership after parent abort", async () => {
    let release = Promise.withResolvers<void>()
    const aborts: string[] = []
    const execute = await tool(
      client({
        create: async () => ({ data: { id: "child-abort" } }),
        prompt: async () => {
          await release.promise
          return { error: { name: "MessageAbortedError" } }
        },
        abort: async ({ path }) => {
          aborts.push(path.id)
          release.resolve()
          return { data: {} }
        },
      }),
    )
    const run = ctx()
    mark("child-abort")
    const pending = execute.execute(
      {
        initial_prompt: "start",
        continuation_prompt: "continue",
        max_iterations: 2,
        completion: { marker: "[DONE]" },
      },
      run.value as never,
    )

    await Bun.sleep(20)
    run.ctrl.abort("stop")

    try {
      await pending
      throw new Error("Expected abort")
    } catch (err) {
      const out = fail(err)
      expect(["aborted", "session_prompt_failed"]).toContain(out.category)
    }

    expect(aborts).toEqual(["child-abort"])
    expect(getTaskLoopRun({ child_session_id: "child-abort" })).toBeNull()
    expect(getTaskLoopRecord({ child_session_id: "child-abort" })?.recent_runs[0]?.status).toBe("aborted")
  })
})

describe("task-loop compatibility helpers", () => {
  test("emits compatibility metadata", () => {
    expect(
      getTaskLoopMetaView({
        child_session_id: "child-meta",
        status: "completed",
        iteration: 2,
        max_iterations: 5,
        summary: "wrapped up",
      }),
    ).toEqual({
      title: "Task loop · completed",
      metadata: {
        sessionId: "child-meta",
        childSessionId: "child-meta",
        iteration: 2,
        max_iterations: 5,
        status: "completed",
        title: "Task loop · completed",
        description: "wrapped up",
      },
    })
  })

  test("keeps narrow task/task_loop renderer branches aligned", async () => {
    const [session, ui, web] = await Promise.all([
      readFile(new URL("../../opencode/src/cli/cmd/tui/routes/session/index.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../ui/src/components/message-part.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../web/src/components/share/part.tsx", import.meta.url), "utf8"),
    ])

    expect(session.includes('typeof metadata.sessionId === "string" && metadata.sessionId')).toBe(true)
    expect(session.includes('typeof metadata.childSessionId === "string" && metadata.childSessionId')).toBe(true)
    expect(session.includes('props.part.tool === "task" || props.part.tool === "task_loop"')).toBe(true)
    expect(ui.includes('case "task_loop"')).toBe(true)
    expect(ui.includes('typeof metadata.sessionId === "string" && metadata.sessionId')).toBe(true)
    expect(ui.includes('typeof metadata.childSessionId === "string" && metadata.childSessionId')).toBe(true)
    expect(web.includes('props.part.tool === "task" || props.part.tool === "task_loop"')).toBe(true)
    expect(web.includes("export function shareTaskTitle")).toBe(true)
    expect(web.includes("export function shareTaskTarget")).toBe(true)
    expect(web.includes('typeof metadata.sessionId === "string" && metadata.sessionId')).toBe(true)
    expect(web.includes('typeof metadata.childSessionId === "string" && metadata.childSessionId')).toBe(true)
  })
})
