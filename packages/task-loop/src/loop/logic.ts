import { z } from "zod"

import { taskLoopCompletion } from "./schema.js"

const stop = z.object({
  iteration: z.number().int().min(1),
  max_iterations: z.number().int().min(1),
  assistant_text: z.string().default(""),
  completion: taskLoopCompletion,
  stop_requested: z.boolean().default(false),
})

export const taskLoopDecision = z.object({
  should_stop: z.boolean(),
  reason: z.enum(["completion_reported", "max_iterations_reached", "operator_stop", "continue"]),
})

export function hasTaskLoopCompletion(input: unknown) {
  const args = z
    .object({
      assistant_text: z.string().default(""),
      completion: taskLoopCompletion,
    })
    .parse(input)
  return args.assistant_text.includes(args.completion.marker)
}

export function evaluateTaskLoopStop(input: unknown) {
  const args = stop.parse(input)
  if (args.stop_requested) {
    return taskLoopDecision.parse({
      should_stop: true,
      reason: "operator_stop",
    })
  }

  if (hasTaskLoopCompletion(args)) {
    return taskLoopDecision.parse({
      should_stop: true,
      reason: "completion_reported",
    })
  }

  if (args.iteration >= args.max_iterations) {
    return taskLoopDecision.parse({
      should_stop: true,
      reason: "max_iterations_reached",
    })
  }

  return taskLoopDecision.parse({
    should_stop: false,
    reason: "continue",
  })
}

export function formatTaskLoopSummary(text: string) {
  const out = text.replaceAll(/\s+/g, " ").trim().slice(0, 280)
  if (!out) return ""
  return out
}
