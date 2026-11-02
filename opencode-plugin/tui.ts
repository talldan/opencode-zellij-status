import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Plugin } from "@opencode/plugin/tui"

const execFileAsync = promisify(execFile)

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

const desktopNotificationsEnabled = (options: Readonly<Record<string, unknown>>): boolean =>
  options.desktopNotifications !== false &&
  (options.desktopNotifications === true || process.env.OPENCODE_ZELLIJ_NOTIFY_DESKTOP === "1")

const clean = (value: string): string =>
  value.replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_LENGTH)

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

const tabCacheKey = (tabID: string): string =>
  `${process.env.ZELLIJ_SESSION_NAME ?? "unknown"}:${tabID}`

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

const errorMessage = (error: { message?: string } | undefined): string =>
  clean(error?.message ?? "OpenCode error")

const permissionMessage = (action: string, resources: string[]): string => {
  const patterns = resources.length ? ` (${resources.join(", ")})` : ""
  return clean(`Permission requested: ${action}${patterns}`)
}

const questionMessage = (form: { title: string; fields: Array<{ title?: string; description?: string }> }): string =>
  clean(form.title || form.fields[0]?.title || form.fields[0]?.description || "OpenCode question")

const retryMessage = (attempt: number, message: string): string =>
  clean(attempt ? `Retrying (${attempt}): ${message}` : message)

const idleMessage = (): string => clean("task complete")

const withTabName = (tabName: string | undefined, message: string): string =>
  clean(tabName ? `${tabName}: ${message}` : message)

const runCommand = async (command: string, args: string[]): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync(command, args, { encoding: "utf8" })
    return stdout
  } catch {
    return undefined
  }
}

export default Plugin.define({
  id: "opencode-zellij-status.tui",
  setup(context) {
    const markers = statusMarkers()

    const currentTab = async (): Promise<CurrentTabInfo | undefined> => {
      const currentPaneID = process.env.ZELLIJ_PANE_ID
      if (!currentPaneID) return undefined

      const output = await runCommand("zellij", ["action", "list-panes", "--json", "--tab", "--command", "--state"])
      if (output === undefined) return undefined

      const pane = panesFromListOutput(output).find((candidate) =>
        paneMatchesCurrentProcess(candidate, currentPaneID)
      )
      if (!pane) return undefined

      const id = tabID(pane)
      const name = tabName(pane)
      if (!id || !name) return undefined

      return { id, name }
    }

    const renameCurrentTab = async (suffix: string): Promise<string | undefined> => {
      const tab = await currentTab()
      if (!tab) return undefined

      const currentBaseName = stripStatusSuffix(tab.name, markers)
      const cacheKey = tabCacheKey(tab.id)
      const cachedBaseName = baseTabNames.get(cacheKey)
      const baseName = cachedBaseName === currentBaseName ? cachedBaseName : currentBaseName
      baseTabNames.set(cacheKey, baseName)

      const nextName = tabNameWithSuffix(baseName, suffix)
      if (tab.name === nextName) return baseName

      await runCommand("zellij", ["action", "rename-tab-by-id", tab.id, nextName])
      return baseName
    }

    const notifyDesktop = async (message: string): Promise<void> => {
      if (!desktopNotificationsEnabled(context.options) || process.platform !== "darwin") return
      const result = await context.attention.notify({
        title: "OpenCode",
        message,
        notification: { when: "always" },
      })
      if (!result.notification) {
        console.warn("OpenCode Zellij Status notification skipped", result.skipped ?? "unknown reason")
      }
    }

    const initialRoute = context.ui.router.current()
    let selectedSessionID = initialRoute.type === "session" ? initialRoute.sessionID : undefined

    const currentSession = (sessionID: string): boolean => {
      if (!inZellij()) return false
      return selectedSessionID === sessionID
    }

    const handle = (action: () => Promise<unknown>): void => {
      void action().catch((error: unknown) => {
        console.error("OpenCode Zellij Status event handler failed", error)
      })
    }

    const stopListening = [
      context.data.on("tui.session.select", (event) => {
        selectedSessionID = event.data.sessionID
        if (!inZellij()) return
        const marker = context.data.session.status(selectedSessionID) === "running" ? markers.busy : markers.idle
        handle(() => renameCurrentTab(marker))
      }),
      context.data.on("session.execution.started", (event) => {
        if (currentSession(event.data.sessionID)) handle(() => renameCurrentTab(markers.busy))
      }),
      context.data.on("session.retry.scheduled", (event) => {
        if (!currentSession(event.data.sessionID)) return
        handle(async () => {
          const tabName = await renameCurrentTab(markers.retry)
          await notifyDesktop(withTabName(tabName, retryMessage(event.data.attempt, event.data.error.message)))
        })
      }),
      context.data.on("session.idle", (event) => {
        if (!currentSession(event.data.sessionID)) return
        handle(async () => {
          await notifyDesktop(withTabName(await renameCurrentTab(markers.idle), idleMessage()))
        })
      }),
      context.data.on("session.execution.failed", (event) => {
        if (!currentSession(event.data.sessionID)) return
        handle(async () => {
          await notifyDesktop(withTabName(await renameCurrentTab(markers.error), errorMessage(event.data.error)))
        })
      }),
      context.data.on("permission.asked", (event) => {
        if (!currentSession(event.data.sessionID)) return
        handle(async () => {
          await notifyDesktop(withTabName(
            await renameCurrentTab(markers.waiting),
            permissionMessage(event.data.action, event.data.resources),
          ))
        })
      }),
      context.data.on("permission.replied", (event) => {
        if (currentSession(event.data.sessionID)) handle(() => renameCurrentTab(markers.idle))
      }),
      context.data.on("form.created", (event) => {
        if (!currentSession(event.data.form.sessionID)) return
        handle(async () => {
          await notifyDesktop(withTabName(await renameCurrentTab(markers.waiting), questionMessage(event.data.form)))
        })
      }),
    ]

    if (selectedSessionID && inZellij()) {
      const marker = context.data.session.status(selectedSessionID) === "running" ? markers.busy : markers.idle
      handle(() => renameCurrentTab(marker))
    }

    return () => stopListening.forEach((stop) => stop())
  },
})
