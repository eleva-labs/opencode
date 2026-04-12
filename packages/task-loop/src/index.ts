import type { Plugin } from "@opencode-ai/plugin"

export * from "./tool/task-loop.js"

export const id = "opencode-task-loop"

export const server: Plugin = async () => ({})

const mod = {
  id,
  server,
}

export default mod
