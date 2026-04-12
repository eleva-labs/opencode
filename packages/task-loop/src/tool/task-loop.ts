import { z } from "zod"

export { taskLoopCompletion, taskLoopRun, taskLoopStatus, taskLoopStep, taskLoopStopReason } from "../loop/schema.js"

import { taskLoopCompletion } from "../loop/schema.js"

export const taskLoopArgs = z.object({
  initial_prompt: z.string().min(1),
  continuation_prompt: z.string().min(1),
  max_iterations: z.number().int().min(1).max(25).default(5),
  completion: taskLoopCompletion,
  subagent_type: z.string().min(1).optional(),
  description: z.string().min(3).max(120).optional(),
})

export const taskLoopRouteParams = z.object({
  run_id: z.string().min(1).optional(),
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
  mode: z.enum(["new_run_on_new_session"]),
})

export const taskLoopView = z.object({
  child_session_id: z.string().min(1),
  status: z.string().min(1),
  iteration: z.number().int().min(0),
  max_iterations: z.number().int().min(1),
  summary: z.string().default(""),
})

export function parseTaskLoopArgs(input: unknown) {
  return taskLoopArgs.parse(input)
}

export function classifyTaskLoop(input: unknown) {
  return taskLoopMeta.parse({
    mode: "new_run_on_new_session",
  })
}

export function getTaskLoopTitle(input: unknown) {
  const args = taskLoopArgs.parse(input)
  return args.description ?? "Task loop"
}

export function getTaskLoopMetaView(input: unknown) {
  const args = taskLoopView.parse(input)
  const title = `Task loop · ${args.status}`
  return {
    title,
    metadata: {
      sessionId: args.child_session_id,
      child_session_id: args.child_session_id,
      iteration: args.iteration,
      max_iterations: args.max_iterations,
      status: args.status,
      title,
      description: args.summary || title,
    },
  }
}
