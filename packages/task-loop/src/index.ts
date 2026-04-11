import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { taskLoopTool } from "./tool/task-loop.js"

const id = "opencode-task-loop"

export const server: Plugin = async () => ({
  tool: {
    task_loop: taskLoopTool,
  },
})

const mod: PluginModule & { id: string } = {
  id,
  server,
}

export default mod
