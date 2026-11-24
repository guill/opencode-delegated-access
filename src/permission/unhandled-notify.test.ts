import { describe, it, expect, vi } from "vitest"
import { notifyUnhandled } from "./unhandled-notify.ts"

describe("notifyUnhandled", () => {
  const send = vi.fn(async () => ({ type: "timeout" as const }))

  it("notifies with the permission kind and subject", () => {
    send.mockClear()
    notifyUnhandled({
      config: { notifyOnUnhandled: true, notificationSound: false },
      kind: "edit",
      subject: ["src/a.ts", "src/b.ts"],
      sendNotification: send,
    })
    expect(send).toHaveBeenCalledWith({
      title: "opencode: edit needs approval",
      message: "src/a.ts src/b.ts",
      sound: false,
      timeoutSec: 60,
    })
  })

  it("stays silent when notifyOnUnhandled is false", () => {
    send.mockClear()
    notifyUnhandled({
      config: { notifyOnUnhandled: false, notificationSound: false },
      kind: "edit",
      subject: "src/a.ts",
      sendNotification: send,
    })
    expect(send).not.toHaveBeenCalled()
  })
})
