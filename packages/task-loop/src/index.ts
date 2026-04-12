import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { createTaskLoopTool } from "./tool/task-loop.js"

const id = "opencode-task-loop"

export const server: Plugin = async (input) => ({
  tool: {
    task_loop: createTaskLoopTool(input.client),
  },
})

const mod: PluginModule & { id: string } = {
  id,
  server,
}

export default mod
