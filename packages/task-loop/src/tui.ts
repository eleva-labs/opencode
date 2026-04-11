import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const id = "opencode-task-loop"

export const tui: TuiPlugin = async () => {}

const mod: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default mod
