# opencode-zellij-status

Small OpenCode plugin that forwards OpenCode status and attention events to Zellij through `zjstatus`.

The plugin listens for OpenCode session, permission, and question events. It sends persistent in-terminal status updates with `zellij pipe "zjstatus::pipe::pipe_opencode::<status>"` and transient notifications with `zellij pipe "zjstatus::notify::<message>"`.

`zjstatus` is required for the in-terminal status display. Without `zjstatus`, this plugin no-ops harmlessly when the pipe calls fail. Optional macOS desktop notifications can still be enabled separately.

## Install

Add the plugin to your OpenCode config:

```json
{
  "plugin": ["opencode-zellij-status"]
}
```

The plugin only sends Zellij pipe messages when running inside Zellij, detected through `ZELLIJ` or `ZELLIJ_SESSION_NAME`.

## zjstatus

Add this to a Zellij layout, such as `~/.config/zellij/layouts/default.kdl`. The `children` line keeps normal panes in the tab and adds `zjstatus` as a one-line borderless pane:

```kdl
layout {
    default_tab_template {
        children
        pane size=1 borderless=true {
            plugin location="https://github.com/dj95/zjstatus/releases/latest/download/zjstatus.wasm" {
                format_left "{pipe_opencode}"
                format_right "{notifications}"

                pipe_opencode_format " {output} "
                notification_format_unread " {message} "
                notification_show_interval "10"
            }
        }
    }
}
```

If you already use `zjstatus`, add `{pipe_opencode}` and `{notifications}` to your existing format, then add the corresponding `pipe_opencode_*` and `notification_*` options.

Status updates use the `pipe_opencode` pipe name:

```sh
zellij pipe "zjstatus::pipe::pipe_opencode::OpenCode: working"
```

Clearing status sends an empty payload:

```sh
zellij pipe "zjstatus::pipe::pipe_opencode::"
```

## Desktop Notifications

macOS desktop notifications are disabled by default. Enable them with:

```sh
OPENCODE_ZELLIJ_NOTIFY_DESKTOP=1
```

When enabled, attention-worthy events also run:

```sh
osascript -e 'display notification ... with title "OpenCode"'
```

## Event Mapping

The first version intentionally keeps the mapping small and quiet:

| OpenCode event | Zellij status | Notification |
| --- | --- | --- |
| `session.status` busy | `OpenCode: working` | No |
| `session.status` idle | clear status | No |
| `session.status` retry | `OpenCode: retrying` | Yes |
| `session.idle` | clear status | No |
| `session.error` | `OpenCode: error` | Yes |
| `permission.asked` | `OpenCode: waiting` | Yes |
| `permission.replied` | clear status | No |
| `question.asked` | `OpenCode: question` | Yes |

All pipe payloads are sanitized before sending: whitespace is collapsed, newlines are removed, and messages are truncated.

## Design Notes

- This is a focused OpenCode plugin, not a custom Zellij WASM plugin.
- It does not adopt `opencode-zellij` wholesale.
- It does not track todo counts in the first version.
- It fails silently when `zellij`, `zjstatus`, or `osascript` is unavailable.

## Future Ideas

- Port/status display.
- Branch or worktree display.
- Richer agent status.
- Integration with `sesh`.
