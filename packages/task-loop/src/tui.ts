import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

export const id = "opencode-task-loop"

export const tui: TuiPlugin = async (api, opts, meta) => {
  await import("@opentui/solid/scripts/runtime-plugin-support")
  const mod = await import("./tui/index.js")
  return mod.tui(api, opts, meta)
}

const mod: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default mod
