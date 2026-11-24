import type { DelegatedAccessConfig } from "../config.ts"
import { sendNotification as defaultSendNotification } from "../notify/notify.ts"

/** Upper bound on the subject string embedded in the notification body. */
const SUBJECT_DISPLAY_MAX = 180

/**
 * Fire-and-forget heads-up for a permission the plugin leaves to opencode's
 * TUI prompt without deciding it (unsupported permission type, missing
 * subject, unresolvable session/model, …). The SAFE, RISKY, and
 * classifier-failure paths have their own notifications; this covers every
 * remaining "you need to look at the TUI" case. Gated by
 * `config.notifyOnUnhandled`.
 */
export function notifyUnhandled(args: {
  config: Pick<DelegatedAccessConfig, "notifyOnUnhandled" | "notificationSound">
  kind: string | undefined
  subject: unknown
  sendNotification?: typeof defaultSendNotification
}): void {
  const { config, kind, subject } = args
  if (!config.notifyOnUnhandled) return
  const send = args.sendNotification ?? defaultSendNotification

  const text = Array.isArray(subject)
    ? subject.join(" ")
    : typeof subject === "string"
      ? subject
      : ""
  void send({
    title: `opencode: ${kind ?? "permission"} needs approval`,
    message:
      text.length > SUBJECT_DISPLAY_MAX
        ? text.slice(0, SUBJECT_DISPLAY_MAX) + "…"
        : text,
    sound: config.notificationSound,
    timeoutSec: 60,
  })
}
