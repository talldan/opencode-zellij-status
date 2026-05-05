import type { Plugin } from "@opencode-ai/plugin"

const STATUS_PIPE = "pipe_opencode"
const MAX_PAYLOAD_LENGTH = 160

const inZellij = (): boolean => !!process.env.ZELLIJ || !!process.env.ZELLIJ_SESSION_NAME

const desktopNotificationsEnabled = (): boolean =>
  process.env.OPENCODE_ZELLIJ_NOTIFY_DESKTOP === "1"

const clean = (value: string): string =>
  value.replace(/\s+/g, " ").trim().slice(0, MAX_PAYLOAD_LENGTH)

const applescriptString = (value: string): string => clean(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')

const errorMessage = (event: { properties?: unknown }): string => {
  const properties = event.properties as { error?: { data?: { message?: string }; message?: string } } | undefined
  return clean(properties?.error?.data?.message ?? properties?.error?.message ?? "OpenCode error")
}

const permissionMessage = (event: { properties?: unknown }): string => {
  const properties = event.properties as { permission?: string; patterns?: string[] } | undefined
  const permission = properties?.permission ? `Permission requested: ${properties.permission}` : "Permission requested"
  const patterns = properties?.patterns?.length ? ` (${properties.patterns.join(", ")})` : ""
  return clean(`${permission}${patterns}`)
}

const questionMessage = (event: { properties?: unknown }): string => {
  const properties = event.properties as { questions?: Array<{ header?: string; question?: string }> } | undefined
  const firstQuestion = properties?.questions?.[0]
  return clean(firstQuestion?.header ?? firstQuestion?.question ?? "OpenCode question")
}

const retryMessage = (event: { properties?: unknown }): string => {
  const properties = event.properties as { status?: { message?: string; attempt?: number } } | undefined
  const attempt = properties?.status?.attempt
  const message = properties?.status?.message ?? "OpenCode retrying"
  return clean(attempt ? `Retrying (${attempt}): ${message}` : message)
}

const sessionStatusType = (event: { properties?: unknown }): string | undefined => {
  const properties = event.properties as { status?: { type?: string } } | undefined
  return properties?.status?.type
}

export const ZellijStatusPlugin: Plugin = async ({ $ }) => {
  const pipeStatus = async (status: string): Promise<void> => {
    const payload = `zjstatus::pipe::${STATUS_PIPE}::${clean(status)}`
    await $`zellij pipe ${payload}`.quiet().nothrow()
  }

  const notifyZellij = async (message: string): Promise<void> => {
    await $`zellij pipe ${`zjstatus::notify::${clean(message)}`}`.quiet().nothrow()
  }

  const notifyDesktop = async (message: string): Promise<void> => {
    if (!desktopNotificationsEnabled()) return
    await $`osascript -e ${`display notification "${applescriptString(message)}" with title "OpenCode"`}`.quiet().nothrow()
  }

  const notify = async (message: string): Promise<void> => {
    await notifyZellij(message)
    await notifyDesktop(message)
  }

  const clearStatus = async (): Promise<void> => {
    await pipeStatus("")
  }

  return {
    event: async ({ event }) => {
      if (!inZellij()) return

      const eventType = event.type as string

      switch (eventType) {
        case "session.status": {
          const status = sessionStatusType(event)
          if (status === "busy") {
            await pipeStatus("OpenCode: working")
          } else if (status === "idle") {
            await clearStatus()
          } else if (status === "retry") {
            await pipeStatus("OpenCode: retrying")
            await notify(retryMessage(event))
          }
          break
        }

        case "session.idle":
          await clearStatus()
          break

        case "session.error": {
          const message = errorMessage(event)
          await pipeStatus("OpenCode: error")
          await notify(message)
          break
        }

        case "permission.asked": {
          const message = permissionMessage(event)
          await pipeStatus("OpenCode: waiting")
          await notify(message)
          break
        }

        case "permission.replied":
          await clearStatus()
          break

        case "question.asked": {
          const message = questionMessage(event)
          await pipeStatus("OpenCode: question")
          await notify(message)
          break
        }
      }
    },
  }
}

export default ZellijStatusPlugin
