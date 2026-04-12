import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
import {
  evaluateTaskLoopStop,
  formatTaskLoopEnvelope,
  formatTaskLoopResult,
  formatTaskLoopSummary,
  reconstructTaskLoopState,
} from "../loop/logic.js"
import {
  getTaskLoopRecord,
  setTaskLoopError,
  setTaskLoopRecord,
  setTaskLoopStatus,
  startTaskLoopRun,
  finishTaskLoopRun,
} from "../loop/state.js"

const clientShape = z.custom<{
  session: {
    create: (input: { body: { parentID: string; title: string } }) => Promise<unknown>
    prompt: (input: {
      path: { id: string }
      body: { agent: string; parts: Array<{ type: "text"; text: string }> }
    }) => Promise<unknown>
    messages: (input: { path: { id: string }; query?: { limit?: number } }) => Promise<unknown>
    abort: (input: { path: { id: string } }) => Promise<unknown>
  }
}>()

export const taskLoopStopWhen = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("explicit_text"),
    value: z.string().min(1),
  }),
])

export const taskLoopBase = z.object({
  agent: z.string().min(1),
  description: z.string().min(1),
  max_iterations: z.number().int().min(1).max(25).default(5),
  stop_when: taskLoopStopWhen.optional(),
})

const taskLoopShape = {
  agent: z.string().min(1),
  description: z.string().min(1),
  max_iterations: z.number().int().min(1).max(25).default(5),
  stop_when: taskLoopStopWhen.optional(),
  resume: z.boolean().default(false),
  task_id: z.string().min(1).optional(),
  child_session_id: z.string().min(1).optional(),
}

export const taskLoopArgs = z.union([
  taskLoopBase.extend({
    resume: z.literal(false).default(false),
    task_id: z.undefined().optional(),
    child_session_id: z.undefined().optional(),
  }),
  taskLoopBase.extend({
    resume: z.literal(true),
    task_id: z.string().min(1),
    child_session_id: z.string().min(1),
  }),
])

const taskLoopResumeArgs = taskLoopBase.extend({
  resume: z.literal(true),
  task_id: z.string().min(1),
  child_session_id: z.string().min(1),
})

export const taskLoopStatus = z.enum(["running", "completed", "stopped", "aborted", "needs_resume", "failed"])

export const taskLoopStep = z.object({
  iteration: z.number().int().min(1),
  child_session_id: z.string().min(1),
  assistant_text: z.string().default(""),
  should_stop: z.boolean(),
  reason: z.enum(["stop_condition_met", "max_iterations_reached", "operator_stop", "model_requested_stop", "error"]),
})

export const taskLoopRouteParams = z.object({
  task_id: z.string().min(1).optional(),
  loop_id: z.string().min(1).optional(),
  child_session_id: z.string().min(1).optional(),
})

export const taskLoopErrorCategory = z.enum([
  "invalid_args",
  "resume_mismatch",
  "stop_locked",
  "missing_transcript",
  "conflict",
  "child_error",
  "internal_error",
])

export const taskLoopError = z.object({
  category: taskLoopErrorCategory,
  message: z.string().min(1),
})

export const taskLoopRecord = z.object({
  task_id: z.string().min(1),
  loop_id: z.string().min(1),
  parent_session_id: z.string().min(1),
  parent_message_id: z.string().min(1),
  child_session_id: z.string().min(1),
  agent: z.string().min(1),
  status: taskLoopStatus,
  iteration: z.number().int().min(0),
  max_iterations: z.number().int().min(1),
  description: z.string().min(1),
  stop_when: taskLoopStopWhen.optional(),
  updated_at: z.number().int().nonnegative(),
  summary: z.string().optional(),
  last_error: z.string().optional(),
  stop_locked: z.boolean().default(false),
})

function sameStop(a?: z.infer<typeof taskLoopStopWhen>, b?: z.infer<typeof taskLoopStopWhen>) {
  if (!a && !b) return true
  if (!a || !b) return false
  if (a.type !== b.type) return false
  return a.value === b.value
}

function terminal(status: z.infer<typeof taskLoopStatus>, locked: boolean) {
  return locked || ["stopped", "completed", "aborted", "failed"].includes(status)
}

export function parseTaskLoopArgs(input: unknown) {
  return taskLoopArgs.parse(input)
}

export function validateTaskLoopBoundary(input: unknown, record?: unknown) {
  const args = taskLoopArgs.safeParse(input)
  if (!args.success) {
    return {
      ok: false as const,
      error: taskLoopError.parse({
        category: "invalid_args",
        message: args.error.message,
      }),
    }
  }

  if (!record) {
    return {
      ok: true as const,
      value: args.data,
    }
  }

  const row = taskLoopRecord.parse(record)

  if (!args.data.resume) {
    return {
      ok: true as const,
      value: args.data,
    }
  }

  if (terminal(row.status, row.stop_locked)) {
    return {
      ok: false as const,
      error: taskLoopError.parse({
        category: "stop_locked",
        message: "Terminal task loops cannot be resumed",
      }),
    }
  }

  if (row.task_id !== args.data.task_id || row.child_session_id !== args.data.child_session_id) {
    return {
      ok: false as const,
      error: taskLoopError.parse({
        category: "resume_mismatch",
        message: "Resume requires the original task_id and child_session_id pair",
      }),
    }
  }

  if (
    row.agent !== args.data.agent ||
    row.description !== args.data.description ||
    row.max_iterations !== args.data.max_iterations ||
    !sameStop(row.stop_when, args.data.stop_when)
  ) {
    return {
      ok: false as const,
      error: taskLoopError.parse({
        category: "resume_mismatch",
        message: "Resume args must match the original loop behavior fields",
      }),
    }
  }

  return {
    ok: true as const,
    value: args.data,
  }
}

function fail(category: z.infer<typeof taskLoopErrorCategory>, message: string) {
  return JSON.stringify(
    taskLoopError.parse({
      category,
      message,
    }),
  )
}

function text(res: unknown) {
  const hit = z
    .object({
      error: z.unknown().optional(),
      data: z
        .object({
          parts: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
        })
        .optional(),
    })
    .parse(res)
  if (hit.error) return null
  return (hit.data?.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
}

function items(res: unknown) {
  const hit = z
    .array(
      z.object({
        info: z.object({ role: z.string().optional() }).passthrough(),
        parts: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
      }),
    )
    .safeParse(res)
  if (!hit.success) return []
  return hit.data.map((msg) => ({
    role: msg.info.role,
    text: msg.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n"),
  }))
}

async function stop(input: { client: z.infer<typeof clientShape>; child_session_id: string }) {
  await input.client.session.abort({ path: { id: input.child_session_id } }).catch(() => undefined)
}

async function resume(input: { args: z.infer<typeof taskLoopResumeArgs>; client: z.infer<typeof clientShape> }) {
  const row = getTaskLoopRecord({ task_id: input.args.task_id })
  const hit = validateTaskLoopBoundary(input.args, row ?? undefined)
  if (!hit.ok && row) return hit
  if (row) return { ok: true as const, value: row, args: hit.ok ? hit.value : input.args }

  const res = await input.client.session.messages({
    path: { id: input.args.child_session_id },
    query: { limit: 200 },
  })
  const msg = z.object({ error: z.unknown().optional(), data: z.unknown().optional() }).parse(res)
  if (msg.error) {
    return {
      ok: false as const,
      error: taskLoopError.parse({
        category: "child_error",
        message: "Failed to load child session transcript for resume",
      }),
    }
  }

  const state = reconstructTaskLoopState({
    task_id: input.args.task_id,
    child_session_id: input.args.child_session_id,
    max_iterations: input.args.max_iterations,
    items: items(msg.data),
  })
  if (!state.ok) return state

  const next = setTaskLoopRecord({
    task_id: state.value.task_id,
    loop_id: state.value.loop_id,
    parent_session_id: "reconstructed",
    parent_message_id: "reconstructed",
    child_session_id: state.value.child_session_id,
    agent: input.args.agent,
    status: state.value.status,
    iteration: state.value.iteration,
    max_iterations: input.args.max_iterations,
    description: input.args.description,
    stop_when: input.args.stop_when,
    updated_at: Date.now(),
    summary: state.value.summary,
  })
  if (!next.ok) return next
  const out = validateTaskLoopBoundary(input.args, next.value)
  if (!out.ok) return out
  return { ok: true as const, value: next.value, args: out.value }
}

export function createTaskLoopTool(client: unknown) {
  const sdk = clientShape.parse(client)

  return tool({
    description: "Run one task-loop step",
    args: taskLoopShape,
    async execute(args, ctx) {
      const raw = validateTaskLoopBoundary(args)
      if (!raw.ok) return JSON.stringify(raw.error)

      const input = raw.value
      const now = Date.now()
      const task_id = input.resume ? input.task_id : crypto.randomUUID()
      const loop_id = input.resume ? undefined : crypto.randomUUID()
      const run_id = crypto.randomUUID()

      const row = input.resume ? await resume({ args: taskLoopResumeArgs.parse(input), client: sdk }) : null

      if (input.resume && row && !row.ok) return JSON.stringify(row.error)

      let rec = input.resume && row && row.ok ? row.value : null

      if (!rec) {
        const child = await sdk.session
          .create({
            body: {
              parentID: ctx.sessionID,
              title: `Task loop ${task_id}`,
            },
          })
          .catch(() => undefined)
        const made = z
          .object({
            error: z.unknown().optional(),
            data: z.object({ id: z.string().min(1) }).optional(),
          })
          .safeParse(child)
        if (!made.success || made.data.error || !made.data.data) {
          return fail("child_error", "Failed to create child session")
        }

        const next = setTaskLoopRecord({
          task_id,
          loop_id,
          parent_session_id: ctx.sessionID,
          parent_message_id: ctx.messageID,
          child_session_id: made.data.data.id,
          agent: input.agent,
          status: "running",
          iteration: 0,
          max_iterations: input.max_iterations,
          description: input.description,
          stop_when: input.stop_when,
          updated_at: now,
        })
        if (!next.ok) return JSON.stringify(next.error)
        rec = next.value
      }

      const run = startTaskLoopRun({
        run_id,
        task_id: rec.task_id,
        child_session_id: rec.child_session_id,
        started_at: Date.now(),
      })
      if (!run.ok) return JSON.stringify(run.error)

      const off = () => finishTaskLoopRun({ run_id, child_session_id: rec.child_session_id })
      const abort = async () => {
        await stop({ client: sdk, child_session_id: rec.child_session_id })
        setTaskLoopError({
          task_id: rec.task_id,
          status: "aborted",
          last_error: "Parent execution cancelled",
          updated_at: Date.now(),
        })
      }

      ctx.metadata({
        title: "task_loop",
        metadata: {
          task_id: rec.task_id,
          child_session_id: rec.child_session_id,
          iteration: rec.iteration + 1,
        },
      })

      if (ctx.abort.aborted) {
        await abort()
        off()
        return fail("child_error", "Task loop cancelled before child prompt started")
      }

      const onabort = () => {
        void abort()
      }
      ctx.abort.addEventListener("abort", onabort, { once: true })

      try {
        const iteration = rec.iteration + 1
        const prompt = await sdk.session.prompt({
          path: { id: rec.child_session_id },
          body: {
            agent: rec.agent,
            parts: [
              {
                type: "text",
                text: `${formatTaskLoopEnvelope({ loop_id: rec.loop_id, task_id: rec.task_id, iteration })}\n${rec.description}`,
              },
            ],
          },
        })

        if (ctx.abort.aborted) {
          await abort()
          return fail("child_error", "Task loop cancelled during child prompt")
        }

        const out = z.object({ error: z.unknown().optional() }).parse(prompt)
        if (out.error) {
          setTaskLoopError({
            task_id: rec.task_id,
            status: "failed",
            last_error: "Child prompt failed",
            updated_at: Date.now(),
          })
          return fail("child_error", "Child prompt failed")
        }

        const assistant_text = formatTaskLoopSummary(text(prompt) ?? "")
        const stophit = evaluateTaskLoopStop({
          iteration,
          max_iterations: rec.max_iterations,
          assistant_text,
          stop_when: rec.stop_when,
        })
        const status = stophit.should_stop ? "completed" : "needs_resume"
        const next = setTaskLoopRecord({
          ...rec,
          iteration,
          status,
          summary: assistant_text || rec.summary,
          updated_at: Date.now(),
        })
        if (!next.ok) return JSON.stringify(next.error)

        setTaskLoopStatus({
          task_id: rec.task_id,
          status,
          iteration,
          summary: assistant_text || rec.summary,
          updated_at: Date.now(),
        })

        return formatTaskLoopResult({
          task_id: rec.task_id,
          child_session_id: rec.child_session_id,
          iteration,
          status,
          summary: assistant_text || undefined,
          reason: stophit.should_stop ? stophit.reason : undefined,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : "Task loop failed"
        setTaskLoopError({
          task_id: rec.task_id,
          status: ctx.abort.aborted ? "aborted" : "failed",
          last_error: message,
          updated_at: Date.now(),
        })
        if (ctx.abort.aborted) {
          await stop({ client: sdk, child_session_id: rec.child_session_id })
          return fail("child_error", "Task loop cancelled during child prompt")
        }
        return fail("internal_error", message)
      } finally {
        ctx.abort.removeEventListener("abort", onabort)
        off()
      }
    },
  })
}
