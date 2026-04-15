import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

import { getTaskLoopRun, listTaskLoopRecords, stopTaskLoopRun } from "../loop/state.js"
import { TaskLoopRoute } from "./routes/task-loop.js"

function current(api: Parameters<TuiPlugin>[0]) {
  if (api.route.current.name !== "task-loop") return
  const value = api.route.current.params?.child_session_id
  if (typeof value === "string" && value) return value
}

function pick(api: Parameters<TuiPlugin>[0]) {
  const rows = listTaskLoopRecords()
  const id = current(api)
  if (id && rows.some((row) => row.child_session_id === id)) return id
  return rows[0]?.child_session_id
}

function open(api: Parameters<TuiPlugin>[0], id: string) {
  api.route.navigate("session", { sessionID: id })
}

async function stop(api: Parameters<TuiPlugin>[0], id: string) {
  const out = stopTaskLoopRun({
    child_session_id: id,
    updated_at: Date.now(),
  })
  if (!out.row) {
    api.ui.toast({ variant: "warning", message: `Task loop not found: ${id}` })
    return
  }
  if (!out.run) {
    api.ui.toast({ variant: "info", message: `Stop recorded for ${id}` })
    return
  }
  const res = await api.client.session.abort({ sessionID: id })
  api.ui.toast({
    variant: res.error ? "warning" : "success",
    message: res.error ? `Stop requested for ${id}; child abort failed` : `Stop requested for ${id}`,
  })
}

export const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: "task-loop",
      render(props) {
        return <TaskLoopRoute api={api} params={props.params} />
      },
    },
  ])

  api.command.register(() => {
    const id = pick(api)
    const row = id ? listTaskLoopRecords().find((item) => item.child_session_id === id) : undefined
    return [
      {
        title: "Task loops",
        value: "task-loop.monitor",
        category: "Task loop",
        suggested: api.route.current.name === "task-loop",
        onSelect() {
          api.route.navigate("task-loop", id ? { child_session_id: id } : undefined)
        },
      },
      ...(id
        ? [
            {
              title: "Open selected task loop child session",
              value: `task-loop.open.selected.${id}`,
              category: "Task loop",
              description: row?.summary ?? row?.status,
              onSelect() {
                open(api, id)
              },
            },
          ]
        : []),
      ...listTaskLoopRecords().flatMap((row) => [
        {
          title: `Open task loop child session ${row.child_session_id}`,
          value: `task-loop.open.${row.child_session_id}`,
          category: "Task loop",
          description: row.summary ?? row.status,
          onSelect() {
            open(api, row.child_session_id)
          },
        },
        ...(getTaskLoopRun({ child_session_id: row.child_session_id })
          ? [
              {
                title: `Stop task loop run ${row.child_session_id}`,
                value: `task-loop.stop.${row.child_session_id}`,
                category: "Task loop",
                description: row.summary ?? row.status,
                onSelect() {
                  void stop(api, row.child_session_id)
                },
              },
            ]
          : []),
      ]),
    ]
  })
}

const mod: TuiPluginModule & { id: string } = {
  id: "opencode-task-loop",
  tui,
}

export default mod
