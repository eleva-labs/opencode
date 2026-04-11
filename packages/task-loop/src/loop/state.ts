import { z } from "zod"
import { taskLoopError, taskLoopRecord } from "../tool/task-loop.js"

const task = new Map<string, z.infer<typeof taskLoopRecord>>()
const child = new Map<string, string>()
const loop = new Map<string, string>()
const active = new Map<string, z.infer<typeof taskLoopRun>>()

export const taskLoopRun = z.object({
  run_id: z.string().min(1),
  task_id: z.string().min(1),
  child_session_id: z.string().min(1),
  started_at: z.number().int().nonnegative(),
})

const taskLoopRef = z
  .object({
    task_id: z.string().min(1).optional(),
    child_session_id: z.string().min(1).optional(),
    loop_id: z.string().min(1).optional(),
  })
  .refine((input) => Boolean(input.task_id || input.child_session_id || input.loop_id), {
    message: "A task_id, child_session_id, or loop_id is required",
  })

const taskLoopRunStart = z.object({
  run_id: z.string().min(1),
  task_id: z.string().min(1),
  child_session_id: z.string().min(1),
  started_at: z.number().int().nonnegative(),
})

const taskLoopRunStop = z.object({
  run_id: z.string().min(1),
  child_session_id: z.string().min(1),
})

const taskLoopSummary = z.object({
  task_id: z.string().min(1),
  summary: z.string().optional(),
  updated_at: z.number().int().nonnegative(),
})

const taskLoopStop = z.object({
  task_id: z.string().min(1),
  updated_at: z.number().int().nonnegative(),
  summary: z.string().optional(),
})

function fail(category: z.infer<typeof taskLoopError>["category"], message: string) {
  return {
    ok: false as const,
    error: taskLoopError.parse({ category, message }),
  }
}

function guard(row: z.infer<typeof taskLoopRecord>) {
  const kid = child.get(row.child_session_id)
  if (kid && kid !== row.task_id) {
    return fail("conflict", "child_session_id cannot be rebound to a different task_id without teardown")
  }

  const lid = loop.get(row.loop_id)
  if (lid && lid !== row.task_id) {
    return fail("conflict", "loop_id cannot be rebound to a different task_id without teardown")
  }

  return null
}

function unbind(row: z.infer<typeof taskLoopRecord>) {
  child.delete(row.child_session_id)
  loop.delete(row.loop_id)
}

function sync(row: z.infer<typeof taskLoopRecord>) {
  const err = guard(row)
  if (err) return err
  const prev = task.get(row.task_id)
  if (prev) unbind(prev)
  task.set(row.task_id, row)
  child.set(row.child_session_id, row.task_id)
  loop.set(row.loop_id, row.task_id)
  if (prev && prev.child_session_id !== row.child_session_id) {
    const run = active.get(prev.child_session_id)
    if (run && run.task_id === row.task_id) {
      active.delete(prev.child_session_id)
      active.set(
        row.child_session_id,
        taskLoopRun.parse({
          ...run,
          child_session_id: row.child_session_id,
        }),
      )
    }
  }
  return {
    ok: true as const,
    value: row,
  }
}

function load(ref: z.infer<typeof taskLoopRef>) {
  const task_id = ref.task_id ?? child.get(ref.child_session_id ?? "") ?? loop.get(ref.loop_id ?? "")
  if (!task_id) return null
  return task.get(task_id) ?? null
}

export function setTaskLoopRecord(input: unknown) {
  const next = taskLoopRecord.parse(input)
  const row = load({ task_id: next.task_id })
  const out =
    row && (row.stop_locked || row.status === "stopped")
      ? taskLoopRecord.parse({
          ...next,
          status: "stopped",
          stop_locked: true,
        })
      : next
  return sync(out)
}

export function getTaskLoopRecord(input: unknown) {
  return load(taskLoopRef.parse(input))
}

export function listTaskLoopRecords() {
  return [...task.values()].sort((a, b) => b.updated_at - a.updated_at)
}

export function getTaskLoopRun(input: unknown) {
  return active.get(z.object({ child_session_id: z.string().min(1) }).parse(input).child_session_id) ?? null
}

export function startTaskLoopRun(input: unknown) {
  const run = taskLoopRunStart.parse(input)
  const row = load({ task_id: run.task_id })
  if (!row) return fail("resume_mismatch", "No cached loop record exists for the supplied task_id")
  if (row.child_session_id !== run.child_session_id) {
    return fail("resume_mismatch", "Cached loop record does not match the supplied child_session_id")
  }
  if (row.stop_locked || row.status === "stopped") {
    return fail("stop_locked", "Stopped task loops cannot start a new active run")
  }

  const runhit = active.get(run.child_session_id)
  if (runhit && runhit.run_id !== run.run_id) {
    return fail("conflict", "Only one active controller may own a child session in MVP")
  }

  active.set(run.child_session_id, taskLoopRun.parse(run))
  const rowhit = sync(
    taskLoopRecord.parse({
      ...row,
      status: "running",
      updated_at: run.started_at,
    }),
  )
  if (!rowhit.ok) {
    active.delete(run.child_session_id)
    return rowhit
  }

  return {
    ok: true as const,
    value: active.get(run.child_session_id)!,
  }
}

export function finishTaskLoopRun(input: unknown) {
  const run = taskLoopRunStop.parse(input)
  const hit = active.get(run.child_session_id)
  if (!hit || hit.run_id !== run.run_id) return false
  active.delete(run.child_session_id)
  return true
}

export function setTaskLoopSummary(input: unknown) {
  const args = taskLoopSummary.parse(input)
  const row = load({ task_id: args.task_id })
  if (!row) return null
  return sync(
    taskLoopRecord.parse({
      ...row,
      summary: args.summary,
      updated_at: args.updated_at,
    }),
  )
}

export function lockTaskLoopStop(input: unknown) {
  const args = taskLoopStop.parse(input)
  const row = load({ task_id: args.task_id })
  if (!row) return null
  return sync(
    taskLoopRecord.parse({
      ...row,
      status: "stopped",
      stop_locked: true,
      summary: args.summary ?? row.summary,
      updated_at: args.updated_at,
    }),
  )
}

export function clearTaskLoopRecord(input: unknown) {
  const row = load(taskLoopRef.parse(input))
  if (!row) return false
  task.delete(row.task_id)
  child.delete(row.child_session_id)
  loop.delete(row.loop_id)
  active.delete(row.child_session_id)
  return true
}
