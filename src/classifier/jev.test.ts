import { describe, expect, it } from "vitest"
import { buildJevRequest, combineSafety, judgeWithJev } from "./jev.ts"

describe("combineSafety", () => {
  it("is high only when no risk applies and the action is routine or requested", () => {
    expect(combineSafety({ a: 0, routine: 1, requested: 0 }, ["a"])).toBe(1)
    expect(combineSafety({ a: 0, routine: 0, requested: 0.9 }, ["a"])).toBeCloseTo(0.9)
    expect(combineSafety({ a: 0.5, routine: 1, requested: 1 }, ["a"])).toBeCloseTo(0.5)
  })

  it("excuses the destructive risk when the command only deletes agent-created files", () => {
    const rm = { destructive: 1, other: 0, routine: 0, requested: 0 }
    expect(combineSafety({ ...rm, cleanup: 0 }, ["destructive", "other"])).toBe(0)
    expect(combineSafety({ ...rm, cleanup: 0.95 }, ["destructive", "other"])).toBeCloseTo(0.95)
    expect(combineSafety({ ...rm, other: 1, cleanup: 1 }, ["destructive", "other"])).toBe(0)
  })

  it("lets a prior approval or the pinned PR stand in for a request, but never excuse a risk", () => {
    const base = { a: 0, routine: 0, requested: 0 }
    expect(combineSafety({ ...base, prior_approved: 0.9 }, ["a"])).toBeCloseTo(0.9)
    expect(combineSafety({ ...base, advances_pr: 0.9 }, ["a"])).toBeCloseTo(0.9)
    expect(combineSafety({ ...base, a: 1, prior_approved: 1, advances_pr: 1 }, ["a"])).toBe(0)
  })

  it("treats a missing risk answer as certain risk", () => {
    expect(combineSafety({ routine: 1, requested: 1 }, ["a"])).toBe(0)
  })
})

describe("buildJevRequest", () => {
  const pr = (number: number) => ({ number, title: `PR ${number}`, baseBranch: "main" })
  const cmd = { subjectLabel: "command" as const, subject: "gh pr comment 7", userMessages: [] }

  it("grants PR trust only when the pinned PR still matches the live branch", () => {
    const pinned = { branch: "feat", openPR: pr(7) }
    const trusted = buildJevRequest({ ...cmd, repoContext: { pinned, current: pinned } })
    expect(trusted.questions).toHaveProperty("advances_pr")
    expect(trusted.riskKeys).toContain("other_pr")
    expect(trusted.state.repo).toMatchObject({ session_pr: { number: 7, branch: "feat" } })

    const moved = buildJevRequest({
      ...cmd,
      repoContext: { pinned, current: { branch: "other", openPR: pr(8) } },
    })
    expect(moved.questions).not.toHaveProperty("advances_pr")
    expect(moved.state.repo).toEqual({
      branch: "other",
      pull_requests: [
        { number: 8, title: "PR 8" },
        { number: 7, title: "PR 7" },
      ],
    })
  })

  it("asks no repo or prior questions when there is no such state", () => {
    const req = buildJevRequest({ ...cmd, repoContext: null, priorApprovals: [] })
    expect(req.state).not.toHaveProperty("repo")
    expect(req.state).not.toHaveProperty("prior_human_decisions")
    expect(Object.keys(req.questions)).not.toEqual(
      expect.arrayContaining(["other_pr", "prior_approved"]),
    )
  })

  it("sends only prior decisions for the same subject type", () => {
    const entry = (subject: string, subjectLabel: "command" | "path", response: "once" | "reject") =>
      ({ subject, subjectLabel, response, classifierVerdict: "RISKY", classifierReason: "", timestamp: 0 }) as const
    const req = buildJevRequest({
      ...cmd,
      priorApprovals: [entry("gh pr comment 7 -b x", "command", "once"), entry("/tmp/*", "path", "reject")],
    })
    expect(req.state.prior_human_decisions).toEqual([
      { decision: "approved", command: "gh pr comment 7 -b x" },
    ])
    expect(req.riskKeys).toContain("prior_rejected")
  })
})

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch
}

const base = {
  apiKey: "k",
  subjectLabel: "path" as const,
  subject: "/tmp/x",
  userMessages: ["look in /tmp/x"],
  timeoutMs: 1000,
}

describe("judgeWithJev", () => {
  it("combines the directory answers", async () => {
    const noul = (n: number) => ({ type: "noul", noul: n })
    const res = await judgeWithJev({
      ...base,
      fetchImpl: fakeFetch(200, {
        answers: {
          secrets: noul(0.1),
          system_config: noul(0.05),
          outside_home: noul(0),
          routine: noul(0.95),
          requested: noul(0.5),
        },
      }),
    })
    expect(res.pSafe).toBeCloseTo(0.9 * 0.95)
  })

  it("throws on HTTP errors and missing answers instead of guessing", async () => {
    await expect(judgeWithJev({ ...base, fetchImpl: fakeFetch(500, {}) })).rejects.toThrow(/500/)
    await expect(
      judgeWithJev({ ...base, fetchImpl: fakeFetch(200, { answers: {} }) }),
    ).rejects.toThrow(/missing/)
  })
})
