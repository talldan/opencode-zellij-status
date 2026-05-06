import type { Plugin } from "@opencode-ai/plugin"

const MAX_MESSAGE_LENGTH = 160

interface StatusMarkers {
  idle: string
  busy: string
  retry: string
  waiting: string
  error: string
}

const DEFAULT_STATUS_MARKERS: StatusMarkers = {
  idle: "✓",
  busy: "●",
  retry: "…",
  waiting: "?",
  error: "!",
}

const NERD_STATUS_MARKERS: StatusMarkers = {
  idle: "󰸞",
  busy: "󰔟",
  retry: "",
  waiting: "",
  error: "󰛉",
}

interface ZellijPaneInfo {
  pane_id?: string | number
  paneId?: string | number
  id?: string | number
  tab_id?: string | number
  tabId?: string | number
  tab_name?: string
  tabName?: string
  name?: string
}

interface CurrentTabInfo {
  id: string
  name: string
}

const baseTabNames = new Map<string, string>()

const inZellij = (): boolean => !!process.env.ZELLIJ || !!process.env.ZELLIJ_SESSION_NAME

const desktopNotificationsEnabled = (): boolean =>
  process.env.OPENCODE_ZELLIJ_NOTIFY_DESKTOP === "1"

const clean = (value: string): string =>
  value.replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_LENGTH)

const applescriptString = (value: string): string => clean(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')

const markerOverride = (envName: string, fallback: string): string => {
  const value = process.env[envName]
  return value ? clean(value) || fallback : fallback
}

const statusMarkers = (): StatusMarkers => {
  const preset = process.env.OPENCODE_ZELLIJ_STATUS_STYLE === "nerd"
    ? NERD_STATUS_MARKERS
    : DEFAULT_STATUS_MARKERS

  return {
    idle: markerOverride("OPENCODE_ZELLIJ_STATUS_IDLE", preset.idle),
    busy: markerOverride("OPENCODE_ZELLIJ_STATUS_BUSY", preset.busy),
    retry: markerOverride("OPENCODE_ZELLIJ_STATUS_RETRY", preset.retry),
    waiting: markerOverride("OPENCODE_ZELLIJ_STATUS_WAITING", preset.waiting),
    error: markerOverride("OPENCODE_ZELLIJ_STATUS_ERROR", preset.error),
  }
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const suffixesToStrip = (markers: StatusMarkers): string[] =>
  Array.from(new Set([
    ...Object.values(DEFAULT_STATUS_MARKERS),
    ...Object.values(NERD_STATUS_MARKERS),
    ...Object.values(markers),
  ]))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)

const stripStatusSuffix = (name: string, markers: StatusMarkers): string => {
  const suffixPattern = suffixesToStrip(markers).map(escapeRegExp).join("|")
  const pattern = new RegExp(`\\s*(?:${suffixPattern})\\s*$`, "u")
  return name.replace(pattern, "").trimEnd() || "OpenCode"
}

const tabNameWithSuffix = (baseName: string, suffix: string): string =>
  clean(`${baseName} ${suffix}`)

const paneID = (pane: ZellijPaneInfo): string | undefined => {
  const value = pane.pane_id ?? pane.paneId ?? pane.id
  return value === undefined ? undefined : String(value)
}

const tabID = (pane: ZellijPaneInfo): string | undefined => {
  const value = pane.tab_id ?? pane.tabId
  return value === undefined ? undefined : String(value)
}

const tabName = (pane: ZellijPaneInfo): string | undefined =>
  pane.tab_name ?? pane.tabName ?? pane.name

const normalizePaneID = (value: string): string => {
  const digits = value.match(/\d+$/)?.[0]
  return digits ?? value
}

const paneMatchesCurrentProcess = (pane: ZellijPaneInfo, currentPaneID: string): boolean => {
  const candidate = paneID(pane)
  if (!candidate) return false
  return candidate === currentPaneID || normalizePaneID(candidate) === normalizePaneID(currentPaneID)
}

const panesFromListOutput = (output: string): ZellijPaneInfo[] => {
  try {
    const parsed = JSON.parse(output)
    if (Array.isArray(parsed)) return parsed
    if (Array.isArray(parsed?.panes)) return parsed.panes
  } catch {}
  return []
}

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

const idleMessage = (): string => clean("OpenCode idle")

const sessionStatusType = (event: { properties?: unknown }): string | undefined => {
  const properties = event.properties as { status?: { type?: string } } | undefined
  return properties?.status?.type
}

export const ZellijStatusPlugin: Plugin = async ({ $ }) => {
  const markers = statusMarkers()

  const currentTab = async (): Promise<CurrentTabInfo | undefined> => {
    const currentPaneID = process.env.ZELLIJ_PANE_ID
    if (!currentPaneID) return undefined

    const output = await $`zellij action list-panes --json --tab --command --state`.quiet().nothrow().text()
    const pane = panesFromListOutput(output).find((candidate) =>
      paneMatchesCurrentProcess(candidate, currentPaneID)
    )
    if (!pane) return undefined

    const id = tabID(pane)
    const name = tabName(pane)
    if (!id || !name) return undefined

    return { id, name }
  }

  const renameCurrentTab = async (suffix: string): Promise<void> => {
    const tab = await currentTab()
    if (!tab) return

    const baseName = baseTabNames.get(tab.id) ?? stripStatusSuffix(tab.name, markers)
    baseTabNames.set(tab.id, baseName)

    const nextName = tabNameWithSuffix(baseName, suffix)
    if (tab.name === nextName) return

    await $`zellij action rename-tab-by-id ${tab.id} ${nextName}`.quiet().nothrow()
  }

  const notifyDesktop = async (message: string): Promise<void> => {
    if (!desktopNotificationsEnabled()) return
    await $`osascript -e ${`display notification "${applescriptString(message)}" with title "OpenCode"`}`.quiet().nothrow()
  }

  return {
    event: async ({ event }) => {
      if (!inZellij()) return

      const eventType = event.type as string

      switch (eventType) {
        case "session.status": {
          const status = sessionStatusType(event)
          if (status === "busy") {
            await renameCurrentTab(markers.busy)
          } else if (status === "idle") {
            await renameCurrentTab(markers.idle)
            await notifyDesktop(idleMessage())
          } else if (status === "retry") {
            await renameCurrentTab(markers.retry)
            await notifyDesktop(retryMessage(event))
          }
          break
        }

        case "session.idle":
          await renameCurrentTab(markers.idle)
          await notifyDesktop(idleMessage())
          break

        case "session.error":
          await renameCurrentTab(markers.error)
          await notifyDesktop(errorMessage(event))
          break

        case "permission.asked":
          await renameCurrentTab(markers.waiting)
          await notifyDesktop(permissionMessage(event))
          break

        case "permission.replied":
          await renameCurrentTab(markers.idle)
          break

        case "question.asked":
          await renameCurrentTab(markers.waiting)
          await notifyDesktop(questionMessage(event))
          break
      }
    },
  }
}

export default ZellijStatusPlugin
