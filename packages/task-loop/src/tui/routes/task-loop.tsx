import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { useKeyboard } from "@opentui/solid"
import { For, createEffect, createMemo, createSignal, onCleanup } from "solid-js"

import {
  getTaskLoopRun,
  getTaskLoopStateVersion,
  listTaskLoopRecords,
  stopTaskLoopRun,
  subscribeTaskLoopState,
} from "../../loop/state.js"

type Row = ReturnType<typeof listTaskLoopRecords>[number]
type Run = Row["recent_runs"][number]

function selected(params?: Record<string, unknown>) {
  const value = params?.child_session_id
  if (typeof value === "string" && value) return value
}

export function TaskLoopRoute(props: { api: TuiPluginApi; params?: Record<string, unknown> }) {
  const [tick, setTick] = createSignal(getTaskLoopStateVersion())
  const [cur, setCur] = createSignal(selected(props.params))
  const rows = createMemo(() => {
    tick()
    return listTaskLoopRecords()
  })
  const item = createMemo<Row | undefined>(() => rows().find((row) => row.child_session_id === cur()) ?? rows()[0])

  const off = subscribeTaskLoopState(() => {
    setTick(getTaskLoopStateVersion())
  })
  onCleanup(off)

  createEffect(() => {
    const id = selected(props.params)
    if (id) {
      setCur(id)
      return
    }
    if (!cur() && rows()[0]) setCur(rows()[0].child_session_id)
  })

  createEffect(() => {
    const id = cur()
    if (id && rows().some((row) => row.child_session_id === id)) return
    setCur(rows()[0]?.child_session_id)
  })

  function move(dir: -1 | 1) {
    const list = rows()
    if (!list.length) return
    const i = Math.max(
      0,
      list.findIndex((row) => row.child_session_id === cur()),
    )
    const next = list[Math.min(list.length - 1, Math.max(0, i + dir))]
    if (!next) return
    setCur(next.child_session_id)
    props.api.route.navigate("task-loop", { child_session_id: next.child_session_id })
  }

  async function stop(id: string) {
    const out = stopTaskLoopRun({
      child_session_id: id,
      updated_at: Date.now(),
    })
    if (!out.row) {
      props.api.ui.toast({ variant: "warning", message: `Task loop not found: ${id}` })
      return
    }
    if (!out.run) {
      props.api.ui.toast({ variant: "info", message: `Stop recorded for ${id}` })
      return
    }
    const res = await props.api.client.session.abort({ sessionID: id })
    props.api.ui.toast({
      variant: res.error ? "warning" : "success",
      message: res.error ? `Stop requested for ${id}; child abort failed` : `Stop requested for ${id}`,
    })
  }

  useKeyboard((evt) => {
    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault()
      evt.stopPropagation()
      move(-1)
    }
    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault()
      evt.stopPropagation()
      move(1)
    }
    if (evt.name === "return" || evt.name === "o") {
      const id = item()?.child_session_id
      if (!id) return
      evt.preventDefault()
      evt.stopPropagation()
      props.api.route.navigate("session", { sessionID: id })
    }
    if (evt.name === "s") {
      const id = item()?.child_session_id
      if (!id || !getTaskLoopRun({ child_session_id: id })) return
      evt.preventDefault()
      evt.stopPropagation()
      void stop(id)
    }
  })

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} gap={1}>
      <text fg={props.api.theme.current.text}>Task loop monitor</text>
      <text fg={props.api.theme.current.textMuted}>
        Monitor active/recent runs. Use ↑/↓ or j/k to choose a row, enter/o to open, and s to stop the selected active
        run.
      </text>
      <For each={rows()}>
        {(row: Row) => {
          const active = createMemo(() => {
            tick()
            return !!getTaskLoopRun({ child_session_id: row.child_session_id })
          })
          const focus = createMemo(() => row.child_session_id === cur())
          return (
            <box
              border={["left"]}
              paddingLeft={1}
              flexDirection="column"
              borderColor={focus() ? props.api.theme.current.accent : props.api.theme.current.borderSubtle}
              onMouseUp={() => {
                setCur(row.child_session_id)
                props.api.route.navigate("task-loop", { child_session_id: row.child_session_id })
              }}
            >
              <text fg={props.api.theme.current.text}>
                {focus() ? "●" : "○"} {row.child_session_id}
              </text>
              <text fg={active() ? props.api.theme.current.warning : props.api.theme.current.textMuted}>
                {active() ? "active" : "recent"} · {row.status} · iteration {row.iteration}/{row.max_iterations}
              </text>
              <text fg={props.api.theme.current.textMuted}>{row.summary ?? row.last_error ?? "-"}</text>
            </box>
          )
        }}
      </For>
      <box flexDirection="column" paddingTop={1}>
        <text fg={props.api.theme.current.text}>Selected run</text>
        <text fg={props.api.theme.current.textMuted}>{item()?.child_session_id ?? "No task loop runs yet."}</text>
        <text fg={props.api.theme.current.textMuted}>
          {item() ? "enter/o: open · s: stop active run" : "No row selected."}
        </text>
        <For each={item()?.recent_runs ?? []}>
          {(run: Run) => (
            <text fg={props.api.theme.current.textMuted}>
              {run.status} · {run.iteration}/{run.max_iterations} · {run.summary ?? run.last_error ?? "-"}
            </text>
          )}
        </For>
      </box>
    </box>
  )
}
