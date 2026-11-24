import notifier from "node-notifier"
import { execFile } from "node:child_process"

/**
 * The outcome of showing an interactive notification.
 *
 * - `action`: user clicked one of the buttons specified in `actions`; `label`
 *   is the button text they clicked.
 * - `cancel`: user dismissed / closed the notification (including the
 *   close-label / X button).
 * - `click`: user clicked the notification body rather than a specific
 *   action button.
 * - `timeout`: the notification closed without any user interaction.
 * - `error`: the notifier itself errored before a decision could be reached
 *   (typically a platform-level issue — OS doesn't support notifications,
 *   binary missing, etc.). Callers should treat this as "no decision".
 */
export type NotifyActionResult =
  | { type: "action"; label: string }
  | { type: "cancel" }
  | { type: "click" }
  | { type: "timeout" }
  | { type: "error"; error: Error }

export type NotifyArgs = {
  /** Notification title (first line). */
  title: string
  /** Notification body (second line). */
  message: string
  /**
   * Button labels. macOS supports ~2 direct buttons; more become a dropdown.
   * On platforms without button support these are ignored and the user gets
   * a plain click-or-dismiss notification.
   */
  actions?: string[]
  /** Label for the close button (macOS). Defaults to the system default. */
  closeLabel?: string
  /** Whether the notification plays its sound. */
  sound?: boolean
  /**
   * How long the notification remains visible before auto-timing-out. On
   * macOS this is seconds; on platforms that don't support a custom timeout
   * this is ignored. Default: 10.
   */
  timeoutSec?: number
}

// node-notifier has no published TypeScript types on its options/metadata in
// a way that's convenient here, so we keep a small local shape.
type NotifierCtor = new () => {
  notify: (
    options: Record<string, unknown>,
    cb: (
      err: Error | null,
      response: string,
      metadata?: { activationType?: string; activationValue?: string },
    ) => void,
  ) => void
}

/**
 * Show an OS notification with optional action buttons and await the user's
 * response. Resolves to one of the {@link NotifyActionResult} variants — never
 * rejects.
 */
export function sendNotification(args: NotifyArgs): Promise<NotifyActionResult> {
  if (process.platform === "linux") return sendLinuxNotification(args)
  const {
    title,
    message,
    actions,
    closeLabel,
    sound = true,
    timeoutSec = 10,
  } = args

  return new Promise((resolve) => {
    try {
      const NC = (notifier as unknown as { NotificationCenter: NotifierCtor })
        .NotificationCenter
      const instance = new NC()

      instance.notify(
        {
          title,
          message,
          sound,
          wait: true,
          timeout: timeoutSec,
          ...(actions !== undefined ? { actions } : {}),
          ...(closeLabel !== undefined ? { closeLabel } : {}),
        },
        (err, _response, metadata) => {
          if (err) {
            resolve({ type: "error", error: err })
            return
          }
          const activation = metadata?.activationType
          if (activation === "actionClicked") {
            resolve({
              type: "action",
              label: metadata?.activationValue ?? "",
            })
            return
          }
          if (activation === "closed") {
            resolve({ type: "cancel" })
            return
          }
          if (activation === "contentsClicked") {
            resolve({ type: "click" })
            return
          }
          // Fall through: treat as timeout (most likely "timeout" but could
          // be an unrecognised activationType on older OS versions).
          resolve({ type: "timeout" })
        },
      )
    } catch (e) {
      resolve({
        type: "error",
        error: e instanceof Error ? e : new Error(String(e)),
      })
    }
  })
}

/**
 * Linux backend: node-notifier's NotificationCenter is macOS-only, so shell
 * out to libnotify's `notify-send`, which talks to whatever
 * org.freedesktop.Notifications server is running. `--wait` keeps it alive
 * until the notification closes; a clicked action's index is printed on
 * stdout. `closeLabel` and `sound` have no notify-send equivalent.
 */
export function sendLinuxNotification(
  args: NotifyArgs,
): Promise<NotifyActionResult> {
  const { title, message, actions = [], timeoutSec = 10 } = args
  const timeoutMs = timeoutSec * 1000
  const argv = [
    "--app-name=opencode",
    `--expire-time=${timeoutMs}`,
    "--wait",
    ...actions.map((label, i) => `--action=${i}=${label}`),
    "--",
    title,
    message,
  ]
  const started = Date.now()

  return new Promise((resolve) => {
    execFile("notify-send", argv, (err, stdout) => {
      if (err) {
        resolve({ type: "error", error: err })
        return
      }
      const label = actions[Number.parseInt(stdout.trim(), 10)]
      if (label !== undefined) {
        resolve({ type: "action", label })
        return
      }
      // simplification: notify-send doesn't report the close reason, so a
      // close before the timeout elapsed counts as a user dismissal. Erring
      // toward "cancel" keeps a dismissed safe-path countdown from
      // auto-approving. Upgrade path: listen for NotificationClosed over D-Bus.
      resolve(
        Date.now() - started >= timeoutMs - 250
          ? { type: "timeout" }
          : { type: "cancel" },
      )
    })
  })
}
