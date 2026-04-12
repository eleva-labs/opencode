import { tool, type Plugin } from "@opencode-ai/plugin"
import { z } from "zod"

import { evaluateTaskLoopStop, formatTaskLoopOutput, formatTaskLoopSummary, getTaskLoopStatus } from "./loop/logic.js"
import { finishTaskLoopRun, getTaskLoopRecord, setTaskLoopRecord, startTaskLoopRun } from "./loop/state.js"
import {
  classifyTaskLoop,
  getTaskLoopMetaView,
  getTaskLoopTitle,
  parseTaskLoopArgs,
  taskLoopArgs,
} from "./tool/task-loop.js"

export * from "./tool/task-loop.js"

export const id = "opencode-task-loop"

function fail(category: string, message: string) {
  return new Error(JSON.stringify({ category, message }))
}

function text(input: unknown) {
  const parts = z
    .object({
      data: z
        .object({
          parts: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
        })
        .optional(),
    })
    .parse(input)

  return (
    parts.data?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n") ?? ""
  )
}

export const server: Plugin = async (input) => ({
  tool: {
    task_loop: tool({
      description: "Run a bounded child-session task loop",
      args: taskLoopArgs.shape,
      async execute(raw, ctx) {
        const args = parseTaskLoopArgs(raw)
        const mode = classifyTaskLoop(args)
        const title = getTaskLoopTitle(args)
        const created = !args.child_session_id
          ? await input.client.session.create({
              body: {
                parentID: ctx.sessionID,
                title,
              },
            })
          : undefined

        if (created?.error) throw fail("session_create_failed", JSON.stringify(created.error))

        const id = args.child_session_id ?? created?.data?.id
        if (!id) throw fail("session_create_failed", "Missing child session id")

        const run = crypto.randomUUID()
        const now = Date.now()

        const start = startTaskLoopRun({
          run_id: run,
          child_session_id: id,
          started_at: now,
        })
        if (!start.ok) throw fail("loop_conflict", start.error)

        const row = getTaskLoopRecord({ child_session_id: id })
        setTaskLoopRecord({
          child_session_id: id,
          parent_session_id: ctx.sessionID,
          parent_message_id: ctx.messageID,
          status: "running",
          iteration: 0,
          max_iterations: args.max_iterations,
          updated_at: now,
          summary: undefined,
          last_text: undefined,
          last_error: undefined,
          stop_requested: false,
          recent_runs: row?.recent_runs ?? [],
        })

        ctx.metadata(
          getTaskLoopMetaView({
            child_session_id: id,
            status: "running",
            iteration: 0,
            max_iterations: args.max_iterations,
            summary: args.description ?? mode.mode,
          }),
        )

        let out = {
          run_id: run,
          parent_session_id: ctx.sessionID,
          parent_message_id: ctx.messageID,
          child_session_id: id,
          status: "failed",
          iteration: 0,
          max_iterations: args.max_iterations,
          updated_at: now,
          summary: undefined as string | undefined,
          last_text: undefined as string | undefined,
          last_error: undefined as string | undefined,
        }

        const stop = () => {
          void input.client.session.abort({ path: { id } })
        }

        ctx.abort.addEventListener("abort", stop)

        try {
          for (let i = 1; i <= args.max_iterations; i++) {
            if (ctx.abort.aborted) {
              const err = out.last_error ?? "Parent session aborted"
              out = {
                ...out,
                status: "aborted",
                updated_at: Date.now(),
                last_error: err,
              }
              ctx.metadata(
                getTaskLoopMetaView({
                  child_session_id: id,
                  status: out.status,
                  iteration: out.iteration,
                  max_iterations: args.max_iterations,
                  summary: out.summary ?? out.last_error ?? out.status,
                }),
              )
              throw fail("aborted", err)
            }

            const res = await input.client.session.prompt({
              path: { id },
              body: {
                agent: args.subagent_type ?? ctx.agent,
                parts: [
                  {
                    type: "text",
                    text: i === 1 ? args.initial_prompt : args.continuation_prompt,
                  },
                ],
              },
            })

            if (res.error) {
              const status = ctx.abort.aborted ? "aborted" : "failed"
              const err = JSON.stringify(res.error)
              out = {
                ...out,
                status,
                iteration: Math.max(0, i - 1),
                updated_at: Date.now(),
                summary: out.summary,
                last_error: err,
              }
              ctx.metadata(
                getTaskLoopMetaView({
                  child_session_id: id,
                  status,
                  iteration: out.iteration,
                  max_iterations: args.max_iterations,
                  summary: out.summary ?? err,
                }),
              )
              throw fail(ctx.abort.aborted ? "aborted" : "session_prompt_failed", err)
            }

            const last = text(res)
            const summary = formatTaskLoopSummary(last)
            const row = getTaskLoopRecord({ child_session_id: id })
            const step = evaluateTaskLoopStop({
              iteration: i,
              max_iterations: args.max_iterations,
              assistant_text: last,
              completion: args.completion,
              stop_requested: row?.stop_requested ?? false,
            })
            const status = getTaskLoopStatus(step.reason)

            out = {
              ...out,
              status,
              iteration: i,
              updated_at: Date.now(),
              summary,
              last_text: last,
              last_error: undefined,
            }

            setTaskLoopRecord({
              child_session_id: id,
              parent_session_id: ctx.sessionID,
              parent_message_id: ctx.messageID,
              status,
              iteration: i,
              max_iterations: args.max_iterations,
              updated_at: out.updated_at,
              summary,
              last_text: last,
              last_error: undefined,
              stop_requested: row?.stop_requested ?? false,
              recent_runs: [],
            })

            ctx.metadata(
              getTaskLoopMetaView({
                child_session_id: id,
                status,
                iteration: i,
                max_iterations: args.max_iterations,
                summary,
              }),
            )

            if (!step.should_stop) continue

            return formatTaskLoopOutput({
              child_session_id: id,
              status,
              iteration: i,
              max_iterations: args.max_iterations,
              summary,
            })
          }

          out = {
            ...out,
            status: "max_iterations",
            iteration: args.max_iterations,
            updated_at: Date.now(),
          }

          return formatTaskLoopOutput({
            child_session_id: id,
            status: out.status,
            iteration: out.iteration,
            max_iterations: args.max_iterations,
            summary: out.summary ?? "-",
          })
        } finally {
          ctx.abort.removeEventListener("abort", stop)
          finishTaskLoopRun(out)
        }
      },
    }),
  },
})

const mod = {
  id,
  server,
}

export default mod
