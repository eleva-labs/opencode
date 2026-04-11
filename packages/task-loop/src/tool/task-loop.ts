import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"

export const taskLoopStopWhen = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("explicit_text"),
    value: z.string().min(1),
  }),
  z.object({
    type: z.literal("model_signal"),
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
  if (a.type === "model_signal") return true
  if (b.type === "model_signal") return false
  return a.value === b.value
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

  if (row.stop_locked || row.status === "stopped") {
    return {
      ok: false as const,
      error: taskLoopError.parse({
        category: "stop_locked",
        message: "Stopped task loops cannot be resumed",
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

export const taskLoopTool = tool({
  description: "Run one task-loop step",
  args: taskLoopShape,
  async execute(args) {
    const hit = validateTaskLoopBoundary(args)
    if (!hit.ok) return JSON.stringify(hit.error)
    return JSON.stringify({
      ok: true,
      status: "needs_resume",
      task_id: hit.value.resume ? hit.value.task_id : "pending-create",
    })
  },
})
