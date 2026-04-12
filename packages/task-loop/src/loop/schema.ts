import { z } from "zod"

export const taskLoopCompletion = z.object({
  marker: z.string().min(1),
})

export const taskLoopStopReason = z.enum([
  "completion_reported",
  "max_iterations_reached",
  "operator_stop",
  "aborted",
  "error",
])

export const taskLoopStatus = z.enum(["running", "completed", "max_iterations", "stopped", "aborted", "failed"])

export const taskLoopStep = z.object({
  iteration: z.number().int().min(1),
  child_session_id: z.string().min(1),
  assistant_text: z.string().default(""),
  should_stop: z.boolean(),
  reason: taskLoopStopReason,
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
