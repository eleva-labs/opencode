import { z } from "zod"
import { taskLoopError, taskLoopStatus, taskLoopStopWhen } from "../tool/task-loop.js"

const open = "<task_loop>"
const close = "</task_loop>"

export const taskLoopEnvelope = z.object({
  loop_id: z.string().min(1),
  task_id: z.string().min(1),
  iteration: z.number().int().min(1),
})

export const taskLoopTranscriptItem = z.object({
  role: z.string().min(1).optional(),
  text: z.string().default(""),
})

export const taskLoopStop = z.object({
  should_stop: z.boolean(),
  reason: z.enum(["stop_condition_met", "max_iterations_reached", "model_requested_stop"]),
})

const taskLoopContinue = z.object({
  should_stop: z.literal(false),
  reason: z.undefined().optional(),
})

const taskLoopStopInput = z.object({
  iteration: z.number().int().min(1),
  max_iterations: z.number().int().min(1),
  assistant_text: z.string().default(""),
  stop_when: taskLoopStopWhen.optional(),
  model_stop: z.boolean().default(false),
})

export const taskLoopResume = z.object({
  task_id: z.string().min(1),
  child_session_id: z.string().min(1),
  max_iterations: z.number().int().min(1),
  loop_id: z.string().min(1).optional(),
  items: z.array(taskLoopTranscriptItem),
})

export function formatTaskLoopEnvelope(input: unknown) {
  return `${open}${JSON.stringify(taskLoopEnvelope.parse(input))}${close}`
}

export function parseTaskLoopEnvelope(text: string) {
  const start = text.indexOf(open)
  const end = text.indexOf(close)
  if (start === -1 || end === -1 || end <= start) return null
  const json = text.slice(start + open.length, end).trim()
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  const hit = taskLoopEnvelope.safeParse(raw)
  if (!hit.success) return null
  return hit.data
}

function tagged(text: string) {
  return text.includes(open) || text.includes(close)
}

export function formatTaskLoopSummary(text: string) {
  const out = text.replaceAll(/\s+/g, " ").trim().slice(0, 280)
  if (!out) return ""
  return out
}

export function evaluateTaskLoopStop(input: unknown) {
  const args = taskLoopStopInput.parse(input)
  if (args.iteration >= args.max_iterations) {
    return taskLoopStop.parse({
      should_stop: true,
      reason: "max_iterations_reached",
    })
  }

  if (args.stop_when?.type === "model_signal" && args.model_stop) {
    return taskLoopStop.parse({
      should_stop: true,
      reason: "model_requested_stop",
    })
  }

  if (args.stop_when?.type === "explicit_text" && args.assistant_text.includes(args.stop_when.value)) {
    return taskLoopStop.parse({
      should_stop: true,
      reason: "stop_condition_met",
    })
  }

  return taskLoopContinue.parse({
    should_stop: false,
  })
}

function list(items: z.infer<typeof taskLoopTranscriptItem>[], task: string, loop?: string) {
  const rows = items.flatMap((item, index) => {
    const env = parseTaskLoopEnvelope(item.text)
    if (!env || env.task_id !== task) return []
    if (loop && env.loop_id !== loop) return []
    return [{ env, index }]
  })

  if (rows.length) {
    return {
      ok: true as const,
      value: rows,
    }
  }

  if (items.some((item) => tagged(item.text))) {
    return {
      ok: false as const,
      error: taskLoopError.parse({
        category: "missing_transcript",
        message: "Transcript contains malformed task_loop envelope content and cannot prove resume state",
      }),
    }
  }

  return {
    ok: true as const,
    value: rows,
  }
}

function pick(items: z.infer<typeof taskLoopTranscriptItem>[], start: number, end: number) {
  return items.slice(start, end).find((item) => item.role === "assistant" && formatTaskLoopSummary(item.text))
}

export function reconstructTaskLoopState(input: unknown) {
  const args = taskLoopResume.parse(input)
  const rows = list(args.items, args.task_id, args.loop_id)
  if (!rows.ok) {
    return rows
  }
  if (!rows.value.length) {
    return {
      ok: false as const,
      error: taskLoopError.parse({
        category: "missing_transcript",
        message: "Transcript evidence for the supplied task_id was not found in the child session",
      }),
    }
  }

  const ids = [...new Set(rows.value.map((row) => row.env.loop_id))]
  if (ids.length !== 1) {
    return {
      ok: false as const,
      error: taskLoopError.parse({
        category: "resume_mismatch",
        message: "Transcript evidence maps the supplied task_id to more than one loop_id",
      }),
    }
  }

  const summary = rows.value
    .map((row, index) => pick(args.items, row.index + 1, rows.value[index + 1]?.index ?? args.items.length))
    .filter((item): item is z.infer<typeof taskLoopTranscriptItem> => Boolean(item))
    .map((item) => formatTaskLoopSummary(item.text))
    .filter(Boolean)
    .at(-1)

  const iteration = rows.value.length
  const status = taskLoopStatus.parse(iteration >= args.max_iterations ? "completed" : "needs_resume")

  return {
    ok: true as const,
    value: {
      task_id: args.task_id,
      child_session_id: args.child_session_id,
      loop_id: ids[0],
      iteration,
      summary,
      status,
    },
  }
}
