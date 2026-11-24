import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { sendNotification, sendLinuxNotification } from "./notify.ts"
import type { NotifyActionResult } from "./notify.ts"

// We mock the NotificationCenter constructor so tests don't pop a real
// notification. The mock invokes the `notify` callback synchronously with
// whatever the test scenario requires.
vi.mock("node-notifier", () => {
  const NotificationCenter = vi.fn()
  return {
    default: { NotificationCenter },
    NotificationCenter,
  }
})

vi.mock("node:child_process", () => ({ execFile: vi.fn() }))

import nn from "node-notifier"
import { execFile } from "node:child_process"

type NotifyArgs = {
  title: string
  message: string
  sound?: boolean
  actions?: string | string[]
  closeLabel?: string
  timeout?: number | false
  wait?: boolean
}
type NotifyCallback = (
  err: Error | null,
  response: string,
  metadata?: { activationType?: string; activationValue?: string },
) => void

/**
 * Capture the last NotificationCenter instance constructed so tests can
 * assert on constructor calls and invoke the captured callback.
 */
function installMockScenario(scenario: {
  callback?: (cb: NotifyCallback, options: NotifyArgs) => void
}) {
  const MockCtor = (nn as unknown as { NotificationCenter: unknown })
    .NotificationCenter as ReturnType<typeof vi.fn>

  const instances: {
    notify: ReturnType<typeof vi.fn>
    lastOptions?: NotifyArgs
  }[] = []

  MockCtor.mockImplementation(() => {
    const self: {
      notify: ReturnType<typeof vi.fn>
      lastOptions?: NotifyArgs
    } = {
      notify: vi.fn((options: NotifyArgs, cb: NotifyCallback) => {
        self.lastOptions = options
        scenario.callback?.(cb, options)
      }),
    }
    instances.push(self)
    return self
  })

  return instances
}

const realPlatform = process.platform

beforeEach(() => {
  vi.clearAllMocks()
  // The NotificationCenter tests below exercise the macOS backend.
  Object.defineProperty(process, "platform", { value: "darwin" })
})

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform })
})

describe("sendNotification", () => {
  it("resolves with { type: 'action', label } when user clicks a button", async () => {
    installMockScenario({
      callback: (cb, _options) => {
        cb(null, "activate", {
          activationType: "actionClicked",
          activationValue: "Approve",
        })
      },
    })

    const result = await sendNotification({
      title: "Test",
      message: "hi",
      actions: ["Approve", "Reject"],
      timeoutSec: 30,
    })

    expect(result).toEqual<NotifyActionResult>({
      type: "action",
      label: "Approve",
    })
  })

  it("resolves with { type: 'cancel' } when user dismisses / closes", async () => {
    installMockScenario({
      callback: (cb) => {
        cb(null, "closed", { activationType: "closed" })
      },
    })

    const result = await sendNotification({
      title: "t",
      message: "m",
      actions: ["Approve", "Reject"],
    })

    expect(result.type).toBe("cancel")
  })

  it("resolves with { type: 'timeout' } when the notification times out", async () => {
    installMockScenario({
      callback: (cb) => {
        cb(null, "timeout", { activationType: "timeout" })
      },
    })

    const result = await sendNotification({ title: "t", message: "m" })
    expect(result.type).toBe("timeout")
  })

  it("resolves with { type: 'click' } when user clicks the notification body", async () => {
    installMockScenario({
      callback: (cb) => {
        cb(null, "activate", { activationType: "contentsClicked" })
      },
    })

    const result = await sendNotification({ title: "t", message: "m" })
    expect(result.type).toBe("click")
  })

  it("resolves with { type: 'error' } on notifier error", async () => {
    installMockScenario({
      callback: (cb) => {
        cb(new Error("broke"), "")
      },
    })

    const result = await sendNotification({ title: "t", message: "m" })
    expect(result.type).toBe("error")
    if (result.type === "error") {
      expect(result.error.message).toBe("broke")
    }
  })

  it("passes the actions and closeLabel through to node-notifier", async () => {
    const instances = installMockScenario({
      callback: (cb) =>
        cb(null, "timeout", { activationType: "timeout" }),
    })

    await sendNotification({
      title: "t",
      message: "m",
      actions: ["A", "B"],
      closeLabel: "Dismiss",
      timeoutSec: 42,
      sound: false,
    })

    expect(instances.length).toBe(1)
    const lastOpts = instances[0]?.lastOptions
    expect(lastOpts?.actions).toEqual(["A", "B"])
    expect(lastOpts?.closeLabel).toBe("Dismiss")
    expect(lastOpts?.timeout).toBe(42)
    expect(lastOpts?.sound).toBe(false)
  })

  it("defaults sound to true when not specified", async () => {
    const instances = installMockScenario({
      callback: (cb) =>
        cb(null, "timeout", { activationType: "timeout" }),
    })

    await sendNotification({ title: "t", message: "m" })
    expect(instances[0]?.lastOptions?.sound).toBe(true)
  })

  it("passes wait: true so that the callback fires on user action", async () => {
    const instances = installMockScenario({
      callback: (cb) =>
        cb(null, "timeout", { activationType: "timeout" }),
    })

    await sendNotification({ title: "t", message: "m" })
    expect(instances[0]?.lastOptions?.wait).toBe(true)
  })
})

describe("sendLinuxNotification", () => {
  type ExecCb = (err: Error | null, stdout: string) => void
  const execMock = execFile as unknown as ReturnType<typeof vi.fn>

  function answer(err: Error | null, stdout: string) {
    execMock.mockImplementation((_cmd: string, _argv: string[], cb: ExecCb) =>
      cb(err, stdout),
    )
  }

  it("is selected by sendNotification on linux", async () => {
    Object.defineProperty(process, "platform", { value: "linux" })
    answer(null, "")
    await sendNotification({ title: "T", message: "m" })
    expect(execMock).toHaveBeenCalledTimes(1)
  })

  it("passes indexed actions, timeout, and wait to notify-send", async () => {
    answer(null, "1\n")
    const result = await sendLinuxNotification({
      title: "T",
      message: "m",
      actions: ["Approve", "Reject"],
      timeoutSec: 30,
    })
    expect(execMock.mock.calls[0]?.[0]).toBe("notify-send")
    expect(execMock.mock.calls[0]?.[1]).toEqual([
      "--app-name=opencode",
      "--expire-time=30000",
      "--wait",
      "--action=0=Approve",
      "--action=1=Reject",
      "--",
      "T",
      "m",
    ])
    expect(result).toEqual({ type: "action", label: "Reject" })
  })

  it("treats an early close as cancel, never timeout", async () => {
    answer(null, "")
    const result = await sendLinuxNotification({
      title: "T",
      message: "m",
      timeoutSec: 30,
    })
    expect(result).toEqual({ type: "cancel" })
  })

  it("treats a close after the timeout as timeout", async () => {
    answer(null, "")
    const result = await sendLinuxNotification({
      title: "T",
      message: "m",
      timeoutSec: 0,
    })
    expect(result).toEqual({ type: "timeout" })
  })

  it("returns error when notify-send fails", async () => {
    const err = new Error("ENOENT")
    answer(err, "")
    const result = await sendLinuxNotification({ title: "T", message: "m" })
    expect(result).toEqual({ type: "error", error: err })
  })
})
