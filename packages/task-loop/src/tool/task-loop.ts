import { z } from "zod"

export const taskLoopCompletion = z.object({
  marker: z.string().min(1),
})

export const taskLoopArgs = z.object({
  initial_prompt: z.string().min(1),
  continuation_prompt: z.string().min(1),
  max_iterations: z.number().int().min(1).max(25).default(5),
  completion: taskLoopCompletion,
  child_session_id: z.string().min(1).optional(),
  subagent_type: z.string().min(1).optional(),
  description: z.string().min(3).max(120).optional(),
})

export const taskLoopStatus = z.enum(["running", "completed", "max_iterations", "stopped", "aborted", "failed"])

export const taskLoopStep = z.object({
  iteration: z.number().int().min(1),
  child_session_id: z.string().min(1),
  assistant_text: z.string().default(""),
  should_stop: z.boolean(),
  reason: z.enum(["completion_reported", "max_iterations_reached", "operator_stop", "aborted", "error"]),
})

export const taskLoopRun = z.object({
  run_id: z.string().min(1),
  parent_session_id: z.string().min(1),
  parent_message_id: z.string().min(1),
  child_session_id: z.string().min(1),
  status: taskLoopStatus,
  iteration: z.number().int().min(0),
  max_iterations: z.number().int().min(1),
  updated_at: z.number().int().nonnegative(),
  summary: z.string().optional(),
  last_text: z.string().optional(),
  last_error: z.string().optional(),
})

export const taskLoopRouteParams = z.object({
  run_id: z.string().min(1).optional(),
  child_session_id: z.string().min(1).optional(),
})

export const taskLoopErr = z.enum([
  "invalid_args",
  "unknown_agent",
  "session_create_failed",
  "session_not_found",
  "session_prompt_failed",
  "loop_conflict",
  "aborted",
])

export const taskLoopError = z.object({
  category: taskLoopErr,
  message: z.string().min(1),
})

export const taskLoopMeta = z.object({
  mode: z.enum(["new_run_on_new_session", "new_run_on_existing_session"]),
  child_session_id: z.string().min(1).optional(),
})

export function parseTaskLoopArgs(input: unknown) {
  return taskLoopArgs.parse(input)
}

export function classifyTaskLoop(input: unknown) {
  const args = taskLoopArgs.parse(input)
  return taskLoopMeta.parse({
    mode: args.child_session_id ? "new_run_on_existing_session" : "new_run_on_new_session",
    child_session_id: args.child_session_id,
  })
}
