import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import {
  getDefaultDbPath,
  listProjects,
  getProject,
  findProjectByPath,
  listSessions,
  getSession,
  listAllSessions,
  listMessages,
  getMessage,
  listParts,
  getMessagesWithParts,
  getTodoList,
} from "./reader"
import { createTestDb, removeTestDb } from "../../tests/fixtures/db"

let testDbPath: string

beforeAll(async () => {
  testDbPath = await createTestDb()
})

afterAll(async () => {
  await removeTestDb(testDbPath)
})

// =============================================================================
// getDefaultDbPath
// =============================================================================

describe("getDefaultDbPath", () => {
  test("returns path ending in opencode.db", () => {
    expect(getDefaultDbPath().endsWith("opencode.db")).toBe(true)
  })
  test("returns absolute path", () => {
    const path = getDefaultDbPath()
    expect(path.startsWith("/") || path.match(/^[A-Z]:\\/)).toBeTruthy()
  })
})

// =============================================================================
// listProjects
// =============================================================================

describe("listProjects", () => {
  test("lists all projects", async () => {
    const projects = await listProjects(testDbPath)
    expect(projects).toHaveLength(2)
  })

  test("sorts projects by most recently updated", async () => {
    const projects = await listProjects(testDbPath)
    expect(projects[0]?.id).toBe("proj_002") // More recently updated
    expect(projects[1]?.id).toBe("proj_001")
  })

  test("returns empty array for non-existent directory", async () => {
    const projects = await listProjects("/non/existent/path")
    expect(projects).toEqual([])
  })
})

// =============================================================================
// getProject
// =============================================================================

describe("getProject", () => {
  test("returns project by ID", async () => {
    const project = await getProject(testDbPath, "proj_001")
    expect(project).not.toBeNull()
    expect(project?.id).toBe("proj_001")
    expect(project?.name).toBe("project-one")
  })

  test("returns null for non-existent project", async () => {
    const project = await getProject(testDbPath, "non_existent")
    expect(project).toBeNull()
  })
})

// =============================================================================
// findProjectByPath
// =============================================================================

describe("findProjectByPath", () => {
  test("finds project by exact worktree match", async () => {
    const project = await findProjectByPath(
      testDbPath,
      "/home/user/project-one"
    )
    expect(project).not.toBeNull()
    expect(project?.id).toBe("proj_001")
  })

  test("finds project by subdirectory", async () => {
    const project = await findProjectByPath(
      testDbPath,
      "/home/user/project-one/src/components"
    )
    expect(project).not.toBeNull()
    expect(project?.id).toBe("proj_001")
  })

  test("returns null for unmatched path", async () => {
    const project = await findProjectByPath(
      testDbPath,
      "/home/user/other-project"
    )
    expect(project).toBeNull()
  })

  test("does not match partial directory names", async () => {
    // /home/user/project-one-extended should NOT match /home/user/project-one
    const project = await findProjectByPath(
      testDbPath,
      "/home/user/project-one-extended"
    )
    expect(project).toBeNull()
  })
})

// =============================================================================
// listSessions
// =============================================================================

describe("listSessions", () => {
  test("lists sessions for a project", async () => {
    const sessions = await listSessions(testDbPath, "proj_001")
    expect(sessions).toHaveLength(2)
  })

  test("sorts sessions by most recently updated", async () => {
    const sessions = await listSessions(testDbPath, "proj_001")
    expect(sessions[0]?.id).toBe("ses_002") // More recently updated
    expect(sessions[1]?.id).toBe("ses_001")
  })

  test("returns empty array for project with no sessions", async () => {
    const sessions = await listSessions(testDbPath, "non_existent_project")
    expect(sessions).toEqual([])
  })

  test("populates session-level cost/tokens/model from DB columns", async () => {
    const sessions = await listSessions(testDbPath, "proj_001")
    const first = sessions.find((s) => s.id === "ses_001")
    expect(first?.cost).toBe(0.05)
    expect(first?.model).toBe("claude-sonnet-4-20250514")
    expect(first?.tokens?.input).toBe(1000)
    expect(first?.tokens?.cache?.read).toBe(200)
  })
})

// =============================================================================
// getSession
// =============================================================================

describe("getSession", () => {
  test("returns session by ID", async () => {
    const session = await getSession(testDbPath, "proj_001", "ses_001")
    expect(session).not.toBeNull()
    expect(session?.id).toBe("ses_001")
    expect(session?.title).toBe("First Session")
  })

  test("returns null for non-existent session", async () => {
    const session = await getSession(testDbPath, "proj_001", "non_existent")
    expect(session).toBeNull()
  })
})

// =============================================================================
// listAllSessions
// =============================================================================

describe("listAllSessions", () => {
  test("lists sessions across all projects", async () => {
    const results = await listAllSessions(testDbPath)
    expect(results).toHaveLength(3)
  })

  test("includes project info with each session", async () => {
    const results = await listAllSessions(testDbPath)
    for (const result of results) {
      expect(result.project).toBeDefined()
      expect(result.session).toBeDefined()
      expect(result.project.id).toBeDefined()
      expect(result.session.projectID).toBe(result.project.id)
    }
  })

  test("sorts by session update time", async () => {
    const results = await listAllSessions(testDbPath)
    // ses_003 has the highest update time
    expect(results[0]?.session.id).toBe("ses_003")
  })
})

// =============================================================================
// listMessages
// =============================================================================

describe("listMessages", () => {
  test("lists messages for a session", async () => {
    const messages = await listMessages(testDbPath, "ses_001")
    expect(messages).toHaveLength(3)
  })

  test("sorts messages chronologically by creation time", async () => {
    const messages = await listMessages(testDbPath, "ses_001")
    expect(messages[0]?.id).toBe("msg_001")
    expect(messages[1]?.id).toBe("msg_002")
    expect(messages[2]?.id).toBe("msg_003")
  })

  test("returns empty array for non-existent session", async () => {
    const messages = await listMessages(testDbPath, "non_existent")
    expect(messages).toEqual([])
  })
})

// =============================================================================
// getMessage
// =============================================================================

describe("getMessage", () => {
  test("returns message by ID", async () => {
    const message = await getMessage(testDbPath, "ses_001", "msg_001")
    expect(message).not.toBeNull()
    expect(message?.id).toBe("msg_001")
    expect(message?.role).toBe("user")
  })

  test("returns null for non-existent message", async () => {
    const message = await getMessage(testDbPath, "ses_001", "non_existent")
    expect(message).toBeNull()
  })
})

// =============================================================================
// listParts
// =============================================================================

describe("listParts", () => {
  test("lists parts for a message", async () => {
    const parts = await listParts(testDbPath, "msg_002")
    expect(parts).toHaveLength(2)
  })

  test("sorts parts by ID (chronologically)", async () => {
    const parts = await listParts(testDbPath, "msg_002")
    expect(parts[0]?.id).toBe("prt_002a")
    expect(parts[1]?.id).toBe("prt_002b")
  })

  test("returns empty array for message with no parts", async () => {
    const parts = await listParts(testDbPath, "non_existent")
    expect(parts).toEqual([])
  })
})

// =============================================================================
// getMessagesWithParts
// =============================================================================

describe("getMessagesWithParts", () => {
  test("returns messages with their parts", async () => {
    const result = await getMessagesWithParts(testDbPath, "ses_001")
    expect(result).toHaveLength(3)
  })

  test("includes parts for each message", async () => {
    const result = await getMessagesWithParts(testDbPath, "ses_001")

    // First message (user) should have 1 text part
    expect(result[0]?.parts).toHaveLength(1)
    expect(result[0]?.parts[0]?.type).toBe("text")

    // Second message (assistant) should have 2 parts
    expect(result[1]?.parts).toHaveLength(2)
  })

  test("message and parts are correctly associated", async () => {
    const result = await getMessagesWithParts(testDbPath, "ses_001")

    for (const { message, parts } of result) {
      for (const part of parts) {
        expect(part.messageID).toBe(message.id)
      }
    }
  })
})

// =============================================================================
// getTodoList
// =============================================================================

describe("getTodoList", () => {
  test("returns todo list for existing session", async () => {
    const todos = await getTodoList(testDbPath, "ses_001")
    expect(todos).not.toBeNull()
    expect(todos).toHaveLength(2)
    expect(todos?.[0]?.content).toBe("Fix bug")
    expect(todos?.[1]?.status).toBe("completed")
  })

  test("returns null for session without todos", async () => {
    const todos = await getTodoList(testDbPath, "ses_002")
    expect(todos).toBeNull()
  })
})
