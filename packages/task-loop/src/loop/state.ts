import { z } from "zod"

import { taskLoopRun, taskLoopStatus } from "./schema.js"

const keep = 10

export const taskLoopRecord = z.object({
  child_session_id: z.string().min(1),
  parent_session_id: z.string().min(1),
  parent_message_id: z.string().min(1),
  status: taskLoopStatus,
  iteration: z.number().int().min(0),
  max_iterations: z.number().int().min(1),
  updated_at: z.number().int().nonnegative(),
  summary: z.string().optional(),
  last_text: z.string().optional(),
  last_error: z.string().optional(),
  stop_requested: z.boolean().default(false),
  recent_runs: z.array(taskLoopRun).default([]),
})

export const taskLoopActive = z.object({
  run_id: z.string().min(1),
  child_session_id: z.string().min(1),
  started_at: z.number().int().nonnegative(),
})

const ref = z.object({
  child_session_id: z.string().min(1),
})

const start = z.object({
  run_id: z.string().min(1),
  child_session_id: z.string().min(1),
  started_at: z.number().int().nonnegative(),
})

const finish = taskLoopRun.extend({
  stop_requested: z.boolean().optional(),
})

const stop = z.object({
  child_session_id: z.string().min(1),
  updated_at: z.number().int().nonnegative(),
})

const rows = new Map<string, z.infer<typeof taskLoopRecord>>()
const runs = new Map<string, z.infer<typeof taskLoopActive>>()

function fail(message: string) {
  return {
    ok: false as const,
    error: message,
  }
}

function sort(list: z.infer<typeof taskLoopRun>[]) {
  return [...list].sort((a, b) => b.updated_at - a.updated_at).slice(0, keep)
}

function patch(input: z.infer<typeof taskLoopRecord>, prev?: z.infer<typeof taskLoopRecord>) {
  return taskLoopRecord.parse({
    ...prev,
    ...input,
    child_session_id: input.child_session_id,
    recent_runs: input.recent_runs.length ? sort(input.recent_runs) : (prev?.recent_runs ?? []),
  })
}

export function setTaskLoopRecord(input: unknown) {
  const next = taskLoopRecord.parse(input)
  const prev = rows.get(next.child_session_id)
  const row = patch(next, prev)
  rows.set(row.child_session_id, row)
  return row
}

export function getTaskLoopRecord(input: unknown) {
  return rows.get(ref.parse(input).child_session_id) ?? null
}

export function listTaskLoopRecords() {
  return [...rows.values()].sort((a, b) => b.updated_at - a.updated_at)
}

export function listTaskLoopRuns(input: unknown) {
  return getTaskLoopRecord(input)?.recent_runs ?? []
}

export function getTaskLoopRun(input: unknown) {
  return runs.get(ref.parse(input).child_session_id) ?? null
}

export function startTaskLoopRun(input: unknown) {
  const next = start.parse(input)
  const hit = runs.get(next.child_session_id)
  if (hit && hit.run_id !== next.run_id) {
    return fail("Only one active controller may own a child session in MVP")
  }

  const active = taskLoopActive.parse(next)
  runs.set(active.child_session_id, active)
  return {
    ok: true as const,
    value: active,
  }
}

export function finishTaskLoopRun(input: unknown) {
  const next = finish.parse(input)
  const hit = runs.get(next.child_session_id)
  if (!hit || hit.run_id !== next.run_id) return false
  runs.delete(next.child_session_id)
  const row = rows.get(next.child_session_id)
  rows.set(
    next.child_session_id,
    taskLoopRecord.parse({
      child_session_id: next.child_session_id,
      parent_session_id: next.parent_session_id,
      parent_message_id: next.parent_message_id,
      status: next.status,
      iteration: next.iteration,
      max_iterations: next.max_iterations,
      updated_at: next.updated_at,
      summary: next.summary,
      last_text: next.last_text,
      last_error: next.last_error,
      stop_requested: next.stop_requested ?? false,
      recent_runs: sort([next, ...(row?.recent_runs ?? [])]),
    }),
  )
  return true
}

export function requestTaskLoopStop(input: unknown) {
  const next = stop.parse(input)
  const row = rows.get(next.child_session_id)
  if (!row) return null
  const out = taskLoopRecord.parse({
    ...row,
    stop_requested: true,
    updated_at: next.updated_at,
  })
  rows.set(out.child_session_id, out)
  return out
}

export function clearTaskLoopRecord(input: unknown) {
  const id = ref.parse(input).child_session_id
  runs.delete(id)
  return rows.delete(id)
}
