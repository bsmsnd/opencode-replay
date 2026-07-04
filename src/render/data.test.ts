import { describe, test, expect } from "bun:test"
import { calculateSessionStats } from "./data"
import { createConversation, BASE_TIMESTAMP } from "../../tests/fixtures"
import type { Session } from "../storage/types"

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_x",
    projectID: "proj_x",
    directory: "/p",
    title: "T",
    version: "1.0",
    time: { created: BASE_TIMESTAMP, updated: BASE_TIMESTAMP + 1000 },
    ...overrides,
  }
}

describe("calculateSessionStats", () => {
  test("aggregates tokens and cost from assistant messages", () => {
    const msgs = createConversation([
      { userText: "hi", assistantText: "hello" },
    ])
    const stats = calculateSessionStats(msgs)
    expect(stats.totalTokensInput).toBe(1500)
    expect(stats.totalTokensOutput).toBe(500)
    expect(stats.totalCost).toBe(0.0125)
  })

  test("session-level cost overrides message aggregation (even when 0)", () => {
    const msgs = createConversation([{ userText: "hi", assistantText: "hello" }])
    const stats = calculateSessionStats(msgs, session({ cost: 0 }))
    expect(stats.totalCost).toBe(0)
  })

  test("session-level tokens override and populate reasoning/cache", () => {
    const msgs = createConversation([{ userText: "hi", assistantText: "hello" }])
    const stats = calculateSessionStats(
      msgs,
      session({
        tokens: { input: 9, output: 8, reasoning: 7, cache: { read: 6, write: 5 } },
      })
    )
    expect(stats.totalTokensInput).toBe(9)
    expect(stats.totalTokensOutput).toBe(8)
    expect(stats.totalTokensReasoning).toBe(7)
    expect(stats.totalTokensCacheRead).toBe(6)
    expect(stats.totalTokensCacheWrite).toBe(5)
  })

  test("session-level model fills model when messages lack one", () => {
    const msgs = [
      {
        message: { id: "u1", sessionID: "s", role: "user", time: { created: BASE_TIMESTAMP }, model: { providerID: "p", modelID: "" } } as never,
        parts: [],
      },
    ]
    const stats = calculateSessionStats(msgs as never, session({ model: "gpt-x" }))
    expect(stats.model).toBe("gpt-x")
  })

  test("message-level model wins over session-level when both present", () => {
    const msgs = createConversation([{ userText: "hi", assistantText: "hello" }])
    const stats = calculateSessionStats(msgs, session({ model: "gpt-x" }))
    expect(stats.model).toBe("claude-sonnet-4-20250514")
  })
})
