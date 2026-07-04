import { Database } from "bun:sqlite"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  createProject,
  createSession,
  createUserMessage,
  createAssistantMessage,
  createTextPart,
  createToolPart,
  BASE_TIMESTAMP,
} from "./index"
import type { Session, Part } from "../../src/storage/types"

const SCHEMA = `
CREATE TABLE project (
  id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
);
CREATE TABLE session (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
  directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL,
  share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER,
  summary_files INTEGER, summary_diffs TEXT, revert TEXT,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  time_compacting INTEGER, time_archived INTEGER,
  cost REAL NOT NULL DEFAULT 0, model TEXT, agent TEXT,
  tokens_input INTEGER NOT NULL DEFAULT 0, tokens_output INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0, tokens_cache_write INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE message (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE part (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE todo (
  session_id TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
  priority TEXT NOT NULL, position INTEGER NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  PRIMARY KEY (session_id, position)
);
`

function strip(obj: object, keys: string[]): string {
  const out = { ...obj } as Record<string, unknown>
  for (const k of keys) delete out[k]
  return JSON.stringify(out)
}

export async function createTestDb(): Promise<string> {
  const dir = join(tmpdir(), `opencode-reader-test-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  const dbPath = join(dir, "opencode.db")
  const db = new Database(dbPath)
  db.run(SCHEMA)

  // Projects
  const project1 = createProject({
    id: "proj_001",
    name: "project-one",
    worktree: "/home/user/project-one",
    time: { created: BASE_TIMESTAMP, updated: BASE_TIMESTAMP + 1000 },
  })
  const project2 = createProject({
    id: "proj_002",
    name: "project-two",
    worktree: "/home/user/project-two",
    time: { created: BASE_TIMESTAMP, updated: BASE_TIMESTAMP + 2000 },
  })
  for (const p of [project1, project2]) {
    db.run(
      "INSERT INTO project (id, worktree, vcs, name, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
      [p.id, p.worktree, p.vcs ?? null, p.name ?? null, p.time.created, p.time.updated]
    )
  }

  // Sessions
  const session1 = createSession({
    id: "ses_001",
    projectID: "proj_001",
    title: "First Session",
    cost: 0.05,
    model: "claude-sonnet-4-20250514",
    tokens: { input: 1000, output: 400, reasoning: 10, cache: { read: 200, write: 50 } },
    time: { created: BASE_TIMESTAMP, updated: BASE_TIMESTAMP + 5000 },
  })
  const session2 = createSession({
    id: "ses_002",
    projectID: "proj_001",
    title: "Second Session",
    time: { created: BASE_TIMESTAMP + 1000, updated: BASE_TIMESTAMP + 6000 },
  })
  const session3 = createSession({
    id: "ses_003",
    projectID: "proj_002",
    title: "Third Session",
    time: { created: BASE_TIMESTAMP + 2000, updated: BASE_TIMESTAMP + 7000 },
  })
  for (const s of [session1, session2, session3]) insertSession(db, s)

  // Messages for ses_001
  const msg1 = createUserMessage({
    id: "msg_001",
    sessionID: "ses_001",
    time: { created: BASE_TIMESTAMP },
  })
  const msg2 = createAssistantMessage({
    id: "msg_002",
    sessionID: "ses_001",
    parentID: "msg_001",
    time: { created: BASE_TIMESTAMP + 1000, completed: BASE_TIMESTAMP + 2000 },
  })
  const msg3 = createUserMessage({
    id: "msg_003",
    sessionID: "ses_001",
    time: { created: BASE_TIMESTAMP + 3000 },
  })
  for (const m of [msg1, msg2, msg3]) {
    db.run(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      [m.id, m.sessionID, m.time.created, m.time.created, strip(m, ["id", "sessionID"])]
    )
  }

  // Parts
  const part1 = createTextPart({
    id: "prt_001a",
    messageID: "msg_001",
    sessionID: "ses_001",
    text: "Hello, world!",
  })
  const part2 = createTextPart({
    id: "prt_002a",
    messageID: "msg_002",
    sessionID: "ses_001",
    text: "Hi there!",
  })
  const part3 = createToolPart({
    id: "prt_002b",
    messageID: "msg_002",
    sessionID: "ses_001",
    tool: "bash",
  })
  for (const p of [part1, part2, part3]) {
    db.run(
      "INSERT INTO part (id, session_id, message_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      [
        p.id,
        p.sessionID,
        p.messageID,
        (p as Part & { time?: { start?: number } }).time?.start ?? BASE_TIMESTAMP,
        BASE_TIMESTAMP,
        strip(p, ["id", "sessionID", "messageID"]),
      ]
    )
  }

  // Todos for ses_001
  const todos = [
    { content: "Fix bug", priority: "high", status: "pending", position: 0 },
    { content: "Add tests", priority: "medium", status: "completed", position: 1 },
  ]
  for (const t of todos) {
    db.run(
      "INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["ses_001", t.content, t.status, t.priority, t.position, BASE_TIMESTAMP, BASE_TIMESTAMP]
    )
  }

  db.close()
  return dbPath
}

function insertSession(db: Database, s: Session): void {
  db.run(
    `INSERT INTO session (id, project_id, parent_id, directory, title, version,
       share_url, summary_additions, summary_deletions, summary_files, summary_diffs, revert,
       time_created, time_updated, time_compacting, time_archived,
       cost, model, agent, tokens_input, tokens_output, tokens_reasoning,
       tokens_cache_read, tokens_cache_write)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      s.id, s.projectID, s.parentID ?? null, s.directory, s.title, s.version,
      s.share?.url ?? null,
      s.summary?.additions ?? null, s.summary?.deletions ?? null,
      s.summary?.files ?? null,
      s.summary?.diffs ? JSON.stringify(s.summary.diffs) : null,
      s.revert ? JSON.stringify(s.revert) : null,
      s.time.created, s.time.updated, s.time.compacting ?? null, s.time.archived ?? null,
      s.cost ?? 0, s.model ?? null, s.agent ?? null,
      s.tokens?.input ?? 0, s.tokens?.output ?? 0, s.tokens?.reasoning ?? 0,
      s.tokens?.cache?.read ?? 0, s.tokens?.cache?.write ?? 0,
    ]
  )
}

export async function removeTestDb(dbPath: string): Promise<void> {
  await rm(join(dbPath, ".."), { recursive: true, force: true })
}
