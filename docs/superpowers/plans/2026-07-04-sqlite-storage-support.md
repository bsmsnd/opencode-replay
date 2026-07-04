# SQLite Storage Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace opencode-replay's JSON file-based storage reader with a SQLite reader so it works against modern OpenCode (v1.15+) which stores sessions in `~/.local/share/opencode/opencode.db`, and surface session-level cost/tokens/model in the output.

**Architecture:** New `src/storage/db.ts` opens the DB read-only (`bun:sqlite`) and exposes path resolution/validation plus row-returning query helpers. `src/storage/reader.ts` is rewritten to map those rows into the existing domain types (`Project`/`Session`/`Message`/`Part`/`TodoItem`), preserving the public function names so renderers change minimally. `Session` gains `cost`/`tokens`/`model` fields; `calculateSessionStats` takes an optional `session` and reconciles session-level authoritative values over message-level aggregation. The JSON-file code path and `getSessionDiff` are removed.

**Tech Stack:** Bun, `bun:sqlite` (built-in), TypeScript, `bun:test`.

## Global Constraints

- Runtime: Bun. Use `bun:sqlite` (NOT `better-sqlite3`). Use `bun test`, `bun run typecheck` (tsc --noEmit).
- Open the user DB **read-only** at all times: `new Database(path, { readonly: true })`. Never write to it.
- The DB is large (~2.7 GB); open once per path (module-level cache) and reuse.
- `message.data` / `part.data` are JSON text columns authoritative for the domain object; map by spreading parsed data and merging `id`/`sessionID`/`messageID` from row columns.
- Do not add comments to code unless asked.
- Sole acceptance command: `bun test` (currently 711 tests green). Target: all green plus ~15 new tests.

---

### Task 1: Extend storage types with session-level cost/tokens/model

**Files:**
- Modify: `src/storage/types.ts:37-63` (SessionSummary, Session)

**Interfaces:**
- Produces: `SessionSummary.diffs?: FileDiff[]`; `Session.cost?`, `Session.tokens?`, `Session.model?`, `Session.agent?`. `FileDiff` already exists at `src/storage/types.ts:89`.

- [ ] **Step 1: Add `diffs` to `SessionSummary`**

In `src/storage/types.ts`, change the `SessionSummary` interface (currently lines 37-41) to:

```ts
export interface SessionSummary {
  additions?: number
  deletions?: number
  files?: number
  diffs?: FileDiff[]
}
```

- [ ] **Step 2: Add new optional fields to `Session`**

In the `Session` interface (currently lines 52-63), add the four fields after `summary?`:

```ts
export interface Session {
  id: string // "ses_{timestamp}{random}"
  projectID: string // References Project.id
  directory: string // Working directory
  title: string // Auto-generated or user-set
  version: string // OpenCode version (e.g., "1.0.207")
  time: SessionTime
  parentID?: string // For branched sessions
  share?: SessionShare
  revert?: SessionRevert
  summary?: SessionSummary
  cost?: number
  model?: string
  agent?: string
  tokens?: TokenUsage
}
```

`TokenUsage` already exists at `src/storage/types.ts:79-87`.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS (no errors). These are additive optional fields.

- [ ] **Step 4: Commit**

```bash
git add src/storage/types.ts
git commit -m "feat(types): add session-level cost/tokens/model fields"
```

---

### Task 2: Create db.ts with connection, path resolution, and validation

**Files:**
- Create: `src/storage/db.ts`
- Create: `src/storage/db.test.ts`

**Interfaces:**
- Consumes: `getDefaultStoragePath` pattern from legacy reader (we replace it).
- Produces:
  - `getDefaultDbPath(): string`
  - `resolveDbPath(input?: string): string`
  - `validateDb(path: string): DbValidation`
  - `openDb(path: string): Database` (from `bun:sqlite`)
  - `DbValidation = { ok: true; path: string } | { ok: false; path: string; reason: "ENOENT" | "NOT_SQLITE" | "MISSING_TABLES" }`

- [ ] **Step 1: Write the failing test file**

Create `src/storage/db.test.ts`:

```ts
import { describe, test, expect, afterAll } from "bun:test"
import { rm, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "bun:sqlite"
import { getDefaultDbPath, resolveDbPath, validateDb, openDb } from "./db"

const tmpRoot = join(tmpdir(), `opencode-db-test-${Date.now()}`)
let validDbPath: string
let emptyDbPath: string
let notSqlitePath: string
let dirPath: string

beforeAll(async () => {
  await mkdir(tmpRoot, { recursive: true })

  // Valid DB with required tables
  validDbPath = join(tmpRoot, "valid.db")
  const db = new Database(validDbPath)
  db.run("CREATE TABLE project (id TEXT)")
  db.run("CREATE TABLE session (id TEXT)")
  db.run("CREATE TABLE message (id TEXT)")
  db.run("CREATE TABLE part (id TEXT)")
  db.close()

  // Valid SQLite but missing required tables
  emptyDbPath = join(tmpRoot, "empty.db")
  const empty = new Database(emptyDbPath)
  empty.run("CREATE TABLE unrelated (id TEXT)")
  empty.close()

  // Not a SQLite file
  notSqlitePath = join(tmpRoot, "notsqlite.db")
  await Bun.write(notSqlitePath, "this is not a database")

  // A directory containing opencode.db
  dirPath = join(tmpRoot, "opencode")
  await mkdir(dirPath, { recursive: true })
  const dirDb = new Database(join(dirPath, "opencode.db"))
  dirDb.run("CREATE TABLE project (id TEXT)")
  dirDb.run("CREATE TABLE session (id TEXT)")
  dirDb.run("CREATE TABLE message (id TEXT)")
  dirDb.run("CREATE TABLE part (id TEXT)")
  dirDb.close()
})

import { beforeAll } from "bun:test"

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe("getDefaultDbPath", () => {
  test("points at opencode.db under the share dir", () => {
    const p = getDefaultDbPath()
    expect(p).toContain("opencode")
    expect(p.endsWith("opencode.db")).toBe(true)
  })
})

describe("resolveDbPath", () => {
  test("returns default when input is undefined", () => {
    expect(resolveDbPath(undefined)).toBe(getDefaultDbPath())
  })

  test("passes a file path through unchanged (resolved absolute)", () => {
    const resolved = resolveDbPath(validDbPath)
    expect(resolved).toBe(validDbPath)
  })

  test("appends opencode.db when input is a directory", () => {
    const resolved = resolveDbPath(dirPath)
    expect(resolved).toBe(join(dirPath, "opencode.db"))
  })
})

describe("validateDb", () => {
  test("ok for valid OpenCode DB", () => {
    const result = validateDb(validDbPath)
    expect(result.ok).toBe(true)
  })

  test("ENOENT when file missing", () => {
    const result = validateDb(join(tmpRoot, "nope.db"))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("ENOENT")
  })

  test("NOT_SQLITE for non-database file", () => {
    const result = validateDb(notSqlitePath)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("NOT_SQLITE")
  })

  test("MISSING_TABLES when required tables absent", () => {
    const result = validateDb(emptyDbPath)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("MISSING_TABLES")
  })
})

describe("openDb", () => {
  test("returns a read-only connection reused across calls", () => {
    const a = openDb(validDbPath)
    const b = openDb(validDbPath)
    expect(a).toBe(b) // same cached instance
  })
})
```

Note: move the `import { beforeAll } from "bun:test"` to the top of the file with the other imports (the two import lines are shown split for clarity; merge them).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/storage/db.test.ts`
Expected: FAIL — `Cannot find module "./db"`.

- [ ] **Step 3: Write the implementation**

Create `src/storage/db.ts`:

```ts
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { homedir } from "node:os"
import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"

export type DbValidation =
  | { ok: true; path: string }
  | { ok: false; path: string; reason: "ENOENT" | "NOT_SQLITE" | "MISSING_TABLES" }

const REQUIRED_TABLES = ["project", "session", "message", "part"]
const cache = new Map<string, Database>()

export function getDefaultDbPath(): string {
  return join(homedir(), ".local", "share", "opencode", "opencode.db")
}

export function resolveDbPath(input?: string): string {
  if (!input) return getDefaultDbPath()
  const abs = resolve(input)
  try {
    if (statSync(abs).isDirectory()) return join(abs, "opencode.db")
  } catch {
    // does not exist; return resolved path, validateDb reports ENOENT
  }
  return abs
}

export function openDb(path: string): Database {
  let db = cache.get(path)
  if (!db) {
    db = new Database(path, { readonly: true })
    cache.set(path, db)
  }
  return db
}

export function validateDb(path: string): DbValidation {
  if (!existsSync(path)) return { ok: false, path, reason: "ENOENT" }
  let probe: Database
  try {
    probe = new Database(path, { readonly: true })
  } catch {
    return { ok: false, path, reason: "NOT_SQLITE" }
  }
  try {
    const rows = probe
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>
    const names = new Set(rows.map((r) => r.name))
    if (!REQUIRED_TABLES.every((t) => names.has(t))) {
      return { ok: false, path, reason: "MISSING_TABLES" }
    }
    return { ok: true, path }
  } finally {
    probe.close()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/storage/db.test.ts`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/db.ts src/storage/db.test.ts
git commit -m "feat(storage): add SQLite db connection, path resolution, validation"
```

---

### Task 3: Add row-returning query helpers to db.ts

**Files:**
- Modify: `src/storage/db.ts` (append query helpers + row types)
- Test: covered transitively by reader tests (Task 5); this task verifies via typecheck.

**Interfaces:**
- Produces (exported, used by reader.ts): row types `ProjectRow`, `SessionRow`, `MessageRow`, `PartRow`, `TodoRow` and query functions:
  - `queryProjects(db): ProjectRow[]`
  - `queryProjectById(db, id): ProjectRow | null`
  - `querySessionsByProject(db, projectId): SessionRow[]`
  - `queryAllSessions(db): Array<SessionRow & { worktree: string }>`
  - `querySessionById(db, id): SessionRow | null`
  - `queryMessagesBySession(db, sessionId): MessageRow[]`
  - `queryPartsByMessage(db, messageId): PartRow[]`
  - `queryTodosBySession(db, sessionId): TodoRow[]`

- [ ] **Step 1: Append row types and query helpers to `src/storage/db.ts`**

Append to `src/storage/db.ts`:

```ts
export interface ProjectRow {
  id: string
  worktree: string
  vcs: string | null
  name: string | null
  time_created: number
  time_updated: number
}

export interface SessionRow {
  id: string
  project_id: string
  parent_id: string | null
  directory: string
  title: string
  version: string
  share_url: string | null
  summary_additions: number | null
  summary_deletions: number | null
  summary_files: number | null
  summary_diffs: string | null
  revert: string | null
  time_created: number
  time_updated: number
  time_compacting: number | null
  time_archived: number | null
  cost: number
  model: string | null
  agent: string | null
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  tokens_cache_write: number
}

export interface MessageRow {
  id: string
  session_id: string
  data: string
}

export interface PartRow {
  id: string
  session_id: string
  message_id: string
  data: string
}

export interface TodoRow {
  session_id: string
  content: string
  status: string
  priority: string
  position: number
}

const PROJECT_COLS =
  "id, worktree, vcs, name, time_created, time_updated"

const SESSION_COLS =
  "id, project_id, parent_id, directory, title, version, share_url, " +
  "summary_additions, summary_deletions, summary_files, summary_diffs, revert, " +
  "time_created, time_updated, time_compacting, time_archived, " +
  "cost, model, agent, tokens_input, tokens_output, tokens_reasoning, " +
  "tokens_cache_read, tokens_cache_write"

export function queryProjects(db: Database): ProjectRow[] {
  return db
    .prepare(`SELECT ${PROJECT_COLS} FROM project ORDER BY time_updated DESC`)
    .all() as ProjectRow[]
}

export function queryProjectById(db: Database, id: string): ProjectRow | null {
  return (
    (db
      .prepare(`SELECT ${PROJECT_COLS} FROM project WHERE id = ?`)
      .get(id) as ProjectRow | undefined) ?? null
  )
}

export function querySessionsByProject(
  db: Database,
  projectId: string
): SessionRow[] {
  return db
    .prepare(
      `SELECT ${SESSION_COLS} FROM session WHERE project_id = ? ORDER BY time_updated DESC`
    )
    .all(projectId) as SessionRow[]
}

const SESSION_JOIN_COLS =
  "s.id AS id, s.project_id AS project_id, s.parent_id AS parent_id, " +
  "s.directory AS directory, s.title AS title, s.version AS version, " +
  "s.share_url AS share_url, s.summary_additions AS summary_additions, " +
  "s.summary_deletions AS summary_deletions, s.summary_files AS summary_files, " +
  "s.summary_diffs AS summary_diffs, s.revert AS revert, " +
  "s.time_created AS time_created, s.time_updated AS time_updated, " +
  "s.time_compacting AS time_compacting, s.time_archived AS time_archived, " +
  "s.cost AS cost, s.model AS model, s.agent AS agent, " +
  "s.tokens_input AS tokens_input, s.tokens_output AS tokens_output, " +
  "s.tokens_reasoning AS tokens_reasoning, " +
  "s.tokens_cache_read AS tokens_cache_read, s.tokens_cache_write AS tokens_cache_write, " +
  "p.worktree AS worktree"

export function queryAllSessions(db: Database): Array<SessionRow & { worktree: string }> {
  return db
    .prepare(
      `SELECT ${SESSION_JOIN_COLS} FROM session s JOIN project p ON s.project_id = p.id ORDER BY s.time_updated DESC`
    )
    .all() as Array<SessionRow & { worktree: string }>
}

export function querySessionById(
  db: Database,
  id: string
): SessionRow | null {
  return (
    (db
      .prepare(`SELECT ${SESSION_COLS} FROM session WHERE id = ?`)
      .get(id) as SessionRow | undefined) ?? null
  )
}

export function queryMessagesBySession(
  db: Database,
  sessionId: string
): MessageRow[] {
  return db
    .prepare(
      "SELECT id, session_id, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC"
    )
    .all(sessionId) as MessageRow[]
}

export function queryPartsByMessage(
  db: Database,
  messageId: string
): PartRow[] {
  return db
    .prepare(
      "SELECT id, session_id, message_id, data FROM part WHERE message_id = ? ORDER BY id ASC"
    )
    .all(messageId) as PartRow[]
}

export function queryTodosBySession(
  db: Database,
  sessionId: string
): TodoRow[] {
  return db
    .prepare(
      "SELECT session_id, content, status, priority, position FROM todo WHERE session_id = ? ORDER BY position ASC"
    )
    .all(sessionId) as TodoRow[]
}
```

Note: `queryAllSessions` builds `s.<col>` aliases. If `bun:sqlite` does not return aliased columns as bare names (i.e. `s.id` comes back as `id`), this works. Verify in Task 5; if keys come back prefixed, switch to an explicit column list with `AS`. Keep it simple first.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/storage/db.ts
git commit -m "feat(storage): add SQLite row query helpers"
```

---

### Task 4: Create the test-DB fixture

**Files:**
- Create: `tests/fixtures/db.ts`

**Interfaces:**
- Produces: `createTestDb(): Promise<string>` — builds a temp SQLite DB with the OpenCode schema and seeded sample data semantically identical to the legacy JSON fixture, returns the dbPath. The seeded IDs match those used in the rewritten reader tests (Task 5): projects `proj_001`/`proj_002`, sessions `ses_001`/`ses_002`/`ses_003`, messages `msg_001`/`msg_002`/`msg_003`, parts `prt_001a`/`prt_002a`/`prt_002b`, todos for `ses_001`.

- [ ] **Step 1: Write the fixture**

Create `tests/fixtures/db.ts`:

```ts
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

function strip<T extends Record<string, unknown>>(obj: T, keys: string[]): string {
  const out: Record<string, unknown> = { ...obj }
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
```

- [ ] **Step 2: Smoke-verify the fixture builds**

Create a temporary check script `tests/fixtures/__smoke.ts`:

```ts
import { Database } from "bun:sqlite"
import { createTestDb, removeTestDb } from "./db"

const p = await createTestDb()
const db = new Database(p, { readonly: true })
console.log("sessions:", (db.query("SELECT count(*) AS c FROM session").get() as { c: number }).c)
console.log("messages:", (db.query("SELECT count(*) AS c FROM message").get() as { c: number }).c)
db.close()
await removeTestDb(p)
```

Run: `bun run tests/fixtures/__smoke.ts`
Expected output: `sessions: 3` and `messages: 3`. Then delete the temp file: `rm tests/fixtures/__smoke.ts`

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/db.ts
git commit -m "test(fixtures): add SQLite test-database factory"
```

---

### Task 5: Rewrite reader.ts (SQLite-backed) and reader.test.ts

**Files:**
- Modify: `src/storage/reader.ts` (full rewrite)
- Modify: `src/storage/reader.test.ts` (rewrite setup; keep assertion bodies)

**Interfaces:**
- Consumes: `openDb`, `queryProjects`, `queryProjectById`, `querySessionsByProject`, `queryAllSessions`, `querySessionById`, `queryMessagesBySession`, `queryPartsByMessage`, `queryTodosBySession` from `./db`; types from `./types`.
- Produces (public API, `dbPath` replaces `storagePath`):
  - `getDefaultDbPath()` (re-exports from db.ts)
  - `listProjects(dbPath): Promise<Project[]>`
  - `getProject(dbPath, projectId): Promise<Project | null>`
  - `findProjectByPath(dbPath, workdir): Promise<Project | null>`
  - `listSessions(dbPath, projectId): Promise<Session[]>`
  - `getSession(dbPath, projectId, sessionId): Promise<Session | null>`
  - `listAllSessions(dbPath): Promise<Array<{ project: Project; session: Session }>>`
  - `listMessages(dbPath, sessionId): Promise<Message[]>`
  - `getMessage(dbPath, sessionId, messageId): Promise<Message | null>`
  - `listParts(dbPath, messageId): Promise<Part[]>`
  - `getMessagesWithParts(dbPath, sessionId): Promise<MessageWithParts[]>`
  - `getTodoList(dbPath, sessionId): Promise<TodoList | null>`
  - **Removed:** `getSessionDiff`, `getDefaultStoragePath`.

- [ ] **Step 1: Rewrite `src/storage/reader.ts`**

Replace the entire file contents with:

```ts
import type {
  Project,
  Session,
  Message,
  Part,
  MessageWithParts,
  TodoList,
  TokenUsage,
  FileDiff,
  SessionRevert,
} from "./types"
import {
  openDb,
  queryProjects,
  queryProjectById,
  querySessionsByProject,
  queryAllSessions,
  querySessionById,
  queryMessagesBySession,
  queryPartsByMessage,
  queryTodosBySession,
  getDefaultDbPath,
  type ProjectRow,
  type SessionRow,
  type MessageRow,
  type PartRow,
  type TodoRow,
} from "./db"

export { getDefaultDbPath }

function mapProject(r: ProjectRow): Project {
  return {
    id: r.id,
    worktree: r.worktree,
    vcs: r.vcs ?? undefined,
    name: r.name ?? undefined,
    time: { created: r.time_created, updated: r.time_updated },
  }
}

function mapSession(r: SessionRow): Session {
  const tokens: TokenUsage | undefined =
    r.tokens_input || r.tokens_output || r.tokens_reasoning || r.tokens_cache_read || r.tokens_cache_write
      ? {
          input: r.tokens_input,
          output: r.tokens_output,
          reasoning: r.tokens_reasoning,
          cache: { read: r.tokens_cache_read, write: r.tokens_cache_write },
        }
      : undefined
  let summary = r.summary_additions ?? r.summary_deletions ?? r.summary_files
    ? { additions: r.summary_additions ?? undefined, deletions: r.summary_deletions ?? undefined, files: r.summary_files ?? undefined }
    : undefined
  if (r.summary_diffs) {
    try {
      const diffs = JSON.parse(r.summary_diffs) as FileDiff[]
      summary = { ...(summary ?? {}), diffs }
    } catch {
      // ignore malformed diffs
    }
  }
  let revert: SessionRevert | undefined
  if (r.revert) {
    try {
      revert = JSON.parse(r.revert) as SessionRevert
    } catch {
      // ignore malformed revert
    }
  }
  return {
    id: r.id,
    projectID: r.project_id,
    directory: r.directory,
    title: r.title,
    version: r.version,
    time: {
      created: r.time_created,
      updated: r.time_updated,
      ...(r.time_compacting != null ? { compacting: r.time_compacting } : {}),
      ...(r.time_archived != null ? { archived: r.time_archived } : {}),
    },
    ...(r.parent_id != null ? { parentID: r.parent_id } : {}),
    ...(r.share_url != null ? { share: { url: r.share_url } } : {}),
    ...(revert ? { revert } : {}),
    ...(summary ? { summary } : {}),
    ...(r.cost !== 0 ? { cost: r.cost } : {}),
    ...(r.model != null ? { model: r.model } : {}),
    ...(r.agent != null ? { agent: r.agent } : {}),
    ...(tokens ? { tokens } : {}),
  }
}

function mapMessage(r: MessageRow): Message {
  const data = JSON.parse(r.data) as Record<string, unknown>
  return { id: r.id, sessionID: r.session_id, ...data } as unknown as Message
}

function mapPart(r: PartRow): Part {
  const data = JSON.parse(r.data) as Record<string, unknown>
  return {
    id: r.id,
    sessionID: r.session_id,
    messageID: r.message_id,
    ...data,
  } as unknown as Part
}

export async function listProjects(dbPath: string): Promise<Project[]> {
  return queryProjects(openDb(dbPath)).map(mapProject)
}

export async function getProject(
  dbPath: string,
  projectId: string
): Promise<Project | null> {
  const row = queryProjectById(openDb(dbPath), projectId)
  return row ? mapProject(row) : null
}

export async function findProjectByPath(
  dbPath: string,
  workdir: string
): Promise<Project | null> {
  const projects = await listProjects(dbPath)
  return (
    projects.find(
      (p) => workdir === p.worktree || workdir.startsWith(p.worktree + "/")
    ) ?? null
  )
}

export async function listSessions(
  dbPath: string,
  projectId: string
): Promise<Session[]> {
  return querySessionsByProject(openDb(dbPath), projectId).map(mapSession)
}

export async function getSession(
  dbPath: string,
  _projectId: string,
  sessionId: string
): Promise<Session | null> {
  const row = querySessionById(openDb(dbPath), sessionId)
  return row ? mapSession(row) : null
}

export async function listAllSessions(
  dbPath: string
): Promise<Array<{ project: Project; session: Session }>> {
  const rows = queryAllSessions(openDb(dbPath))
  return rows.map((r) => ({
    project: mapProject({ ...r, vcs: null, name: null }),
    session: mapSession(r),
  }))
}

export async function listMessages(
  dbPath: string,
  sessionId: string
): Promise<Message[]> {
  return queryMessagesBySession(openDb(dbPath), sessionId).map(mapMessage)
}

export async function getMessage(
  dbPath: string,
  _sessionId: string,
  messageId: string
): Promise<Message | null> {
  const rows = queryMessagesBySession(openDb(dbPath), _sessionId)
  const row = rows.find((r) => r.id === messageId)
  return row ? mapMessage(row) : null
}

export async function listParts(
  dbPath: string,
  messageId: string
): Promise<Part[]> {
  return queryPartsByMessage(openDb(dbPath), messageId).map(mapPart)
}

export async function getMessagesWithParts(
  dbPath: string,
  sessionId: string
): Promise<MessageWithParts[]> {
  const messages = await listMessages(dbPath, sessionId)
  const result: MessageWithParts[] = []
  for (const message of messages) {
    const parts = await listParts(dbPath, message.id)
    result.push({ message, parts })
  }
  return result
}

export async function getTodoList(
  dbPath: string,
  sessionId: string
): Promise<TodoList | null> {
  const rows = queryTodosBySession(openDb(dbPath), sessionId)
  if (rows.length === 0) return null
  return rows.map((r) => ({
    id: String(r.position),
    content: r.content,
    priority: r.priority as TodoList[number]["priority"],
    status: r.status as TodoList[number]["status"],
  }))
}
```

Note on `listAllSessions`: `queryAllSessions` returns session rows joined with `worktree`. `mapProject` expects a `ProjectRow`; spreading `r` plus explicit `vcs: null, name: null` satisfies the shape (worktree comes from the join).

- [ ] **Step 2: Rewrite the test setup in `src/storage/reader.test.ts`**

Replace the import block and the entire `TEST SETUP` section (lines 1-199) with a DB-backed setup. Keep all assertion describe/test blocks from line 201 onward, EXCEPT:
- Rename `getDefaultStoragePath` import + describe block to `getDefaultDbPath` (assert path ends with `opencode.db`).
- Rename the `testStoragePath` variable to `testDbPath` throughout.
- Remove the `getSessionDiff` import and its entire describe block (lines 461-479).
- In `listSessions`, add a new test asserting cost/tokens/model are populated (see Step 2b).

Step 2a — new imports and setup (top of file):

```ts
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
```

Step 2b — replace `getDefaultStoragePath` describe with:

```ts
describe("getDefaultDbPath", () => {
  test("returns path ending in opencode.db", () => {
    expect(getDefaultDbPath().endsWith("opencode.db")).toBe(true)
  })
  test("returns absolute path", () => {
    const path = getDefaultDbPath()
    expect(path.startsWith("/") || path.match(/^[A-Z]:\\/)).toBeTruthy()
  })
})
```

Step 2c — every call site using `testStoragePath` becomes `testDbPath`. For `getSession`/`getMessage`, the middle `projectId`/`sessionId` arg is now ignored (`_`-prefixed) but still passed by tests; leave test call sites as-is (`getSession(testDbPath, "proj_001", "ses_001")`) — they still work because the arg is accepted but unused.

Step 2d — add to the `listSessions` describe block:

```ts
  test("populates session-level cost/tokens/model from DB columns", async () => {
    const sessions = await listSessions(testDbPath, "proj_001")
    const first = sessions.find((s) => s.id === "ses_001")
    expect(first?.cost).toBe(0.05)
    expect(first?.model).toBe("claude-sonnet-4-20250514")
    expect(first?.tokens?.input).toBe(1000)
    expect(first?.tokens?.cache?.read).toBe(200)
  })
```

- [ ] **Step 3: Run the reader tests**

Run: `bun test src/storage/reader.test.ts`
Expected: PASS for all retained tests plus the new cost/tokens/model test.

- [ ] **Step 4: Run the full suite to surface dependent breakage**

Run: `bun test`
Expected: failures only in files importing the removed `getSessionDiff`/`getDefaultStoragePath` (e.g. `src/storage/index.ts` re-exports, possibly `src/test-reader.ts`). Fix those imports/exports next in Task 6.

- [ ] **Step 5: Commit**

```bash
git add src/storage/reader.ts src/storage/reader.test.ts
git commit -m "feat(storage): rewrite reader on SQLite backend"
```

---

### Task 6: Update storage index exports and remove dead references

**Files:**
- Modify: `src/storage/index.ts`
- Modify: `src/test-reader.ts` (or delete if unused dev script)

**Interfaces:**
- Produces: `src/storage/index.ts` exports the new reader API + db helpers; no longer exports `getSessionDiff`/`getDefaultStoragePath`.

- [ ] **Step 1: Inspect current exports**

Run: `rg -n "getSessionDiff|getDefaultStoragePath" src`
Fix every match: replace `getDefaultStoragePath` with `getDefaultDbPath` and remove `getSessionDiff` references.

- [ ] **Step 2: Update `src/storage/index.ts`**

Read the file, then ensure it re-exports from `./reader` (new names) and `./db`. Remove the `getSessionDiff` export. Example target shape (adapt to whatever the current file lists):

```ts
export * from "./reader"
export * from "./db"
export * from "./types"
```

- [ ] **Step 3: Handle `src/test-reader.ts`**

This is a dev smoke script. Update its import to `getDefaultDbPath` and remove `getSessionDiff` usage, OR delete the file if it is not referenced anywhere (`rg -n "test-reader"` should be empty). Prefer updating it to keep the smoke tool.

- [ ] **Step 4: Typecheck + test**

Run: `bun run typecheck && bun test`
Expected: storage-layer tests pass; remaining failures (if any) confined to render/CLI layers addressed in later tasks.

- [ ] **Step 5: Commit**

```bash
git add src/storage/index.ts src/test-reader.ts
git commit -m "refactor(storage): update exports for SQLite reader"
```

---

### Task 7: Reconcile session-level stats in calculateSessionStats

**Files:**
- Modify: `src/render/data.ts:156-204` (SessionStats + calculateSessionStats)
- Modify: `src/render/data.ts:224-242` (buildSessionData passes session)
- Create: `src/render/data.test.ts`

**Interfaces:**
- Produces: `calculateSessionStats(messages, session?)` returns `SessionStats` with new optional fields `totalTokensReasoning`, `totalTokensCacheRead`, `totalTokensCacheWrite`; session-level values override aggregation when present.

- [ ] **Step 1: Write the failing test**

Create `src/render/data.test.ts`:

```ts
import { describe, test, expect } from "bun:test"
import { calculateSessionStats } from "./data"
import { createConversation, createAssistantMessage, BASE_TIMESTAMP } from "../../tests/fixtures"
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/render/data.test.ts`
Expected: FAIL — `totalTokensReasoning` etc. do not exist; session override not applied.

- [ ] **Step 3: Update `SessionStats` and `calculateSessionStats`**

In `src/render/data.ts`, extend the interface (lines 156-163) to add the three optional fields:

```ts
export interface SessionStats {
  messageCount: number
  pageCount: number
  totalTokensInput: number
  totalTokensOutput: number
  totalTokensReasoning?: number
  totalTokensCacheRead?: number
  totalTokensCacheWrite?: number
  totalCost: number
  model?: string
}
```

Replace `calculateSessionStats` (lines 168-204) with:

```ts
export function calculateSessionStats(
  messages: MessageWithParts[],
  session?: Session
): SessionStats {
  let totalTokensInput = 0
  let totalTokensOutput = 0
  let totalCost = 0
  let model: string | undefined
  let userMessageCount = 0

  for (const msg of messages) {
    if (msg.message.role === "assistant") {
      const asst = msg.message as AssistantMessage
      if (asst.tokens) {
        totalTokensInput += asst.tokens.input
        totalTokensOutput += asst.tokens.output
      }
      if (asst.cost) {
        totalCost += asst.cost
      }
      if (!model && asst.modelID) {
        model = asst.modelID
      }
    } else if (msg.message.role === "user") {
      userMessageCount++
    }
  }

  const pageCount = userMessageCount > 0 ? Math.ceil(userMessageCount / PROMPTS_PER_PAGE) : 0

  const stats: SessionStats = {
    messageCount: messages.length,
    pageCount,
    totalTokensInput,
    totalTokensOutput,
    totalCost,
    model,
  }

  if (session?.cost !== undefined) stats.totalCost = session.cost
  if (session?.tokens) {
    stats.totalTokensInput = session.tokens.input
    stats.totalTokensOutput = session.tokens.output
    if (session.tokens.reasoning) stats.totalTokensReasoning = session.tokens.reasoning
    if (session.tokens.cache) {
      if (session.tokens.cache.read) stats.totalTokensCacheRead = session.tokens.cache.read
      if (session.tokens.cache.write) stats.totalTokensCacheWrite = session.tokens.cache.write
    }
  }
  if (session?.model && !stats.model) stats.model = session.model

  return stats
}
```

You must also import `Session` in `data.ts`. The current import (line 6) is:
```ts
import type { Session, MessageWithParts, TextPart, AssistantMessage } from "../storage/types"
```
`Session` is already imported — no change needed.

Then update `buildSessionData` (lines 224-242) to pass `session`:

```ts
  const stats = calculateSessionStats(messages, session)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/render/data.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/render/data.ts src/render/data.test.ts
git commit -m "feat(render): reconcile session-level stats from DB columns"
```

---

### Task 8: Wire session-level stats into HTML and extend the session stats display

**Files:**
- Modify: `src/render/html.ts:162` (pass session) and `:166-180` (extend totalTokens wiring)
- Modify: `src/render/templates/session.ts:35-56` (SessionPageData.totalTokens type) and `:153-198` (append reasoning/cache rows)
- Modify: `src/render/templates/session.test.ts` (add a test for reasoning/cache rows)

**Interfaces:**
- Produces: `SessionPageData.totalTokens?: { input: number; output: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }`; the stats bar renders extra rows when those fields are present.

- [ ] **Step 1: Write the failing test**

Add to `src/render/templates/session.test.ts` (inside a new describe or alongside the existing "displays cost when provided" test at ~line 179):

```ts
  test("displays reasoning and cache token rows when present", () => {
    const data: SessionPageData = {
      session: {
        id: "ses_1",
        projectID: "proj_1",
        directory: "/p",
        title: "T",
        version: "1.0",
        time: { created: 0, updated: 0 },
      },
      timeline: [],
      messageCount: 1,
      pageCount: 1,
      totalTokens: { input: 1000, output: 500, reasoning: 300, cacheRead: 200, cacheWrite: 50 },
    }
    const html = renderSessionPage(data)
    expect(html).toContain("Reasoning")
    expect(html).toContain("Cache")
  })
```

Ensure `renderSessionPage` and `SessionPageData` are imported (they already are at top of the file).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/render/templates/session.test.ts`
Expected: FAIL — "Reasoning" not found.

- [ ] **Step 3: Extend `SessionPageData.totalTokens`**

In `src/render/templates/session.ts`, change line 45:

```ts
  totalTokens?: { input: number; output: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }
```

- [ ] **Step 4: Append reasoning/cache rows in `renderSessionStats`**

In `src/render/templates/session.ts`, inside `renderSessionStats` (around line 176-179 where the Tokens row is pushed), replace the tokens block with:

```ts
  if (totalTokens) {
    const tokenStr = `${formatTokens(totalTokens.input)} in / ${formatTokens(totalTokens.output)} out`
    stats.push({ label: "Tokens", value: tokenStr })
  }

  if (totalTokens.reasoning) {
    stats.push({ label: "Reasoning", value: formatTokens(totalTokens.reasoning) })
  }

  if (totalTokens.cacheRead || totalTokens.cacheWrite) {
    const parts: string[] = []
    if (totalTokens.cacheRead) parts.push(`${formatTokens(totalTokens.cacheRead)} read`)
    if (totalTokens.cacheWrite) parts.push(`${formatTokens(totalTokens.cacheWrite)} write`)
    stats.push({ label: "Cache", value: parts.join(" / ") })
  }
```

The `model` and `totalCost` blocks already present (lines 172-183) stay as-is.

- [ ] **Step 5: Wire session into `generateSessionHtml`**

In `src/render/html.ts`, change line 162 to pass `session`:

```ts
  const stats = calculateSessionStats(messages, session)
```

And extend the `totalTokens` construction (lines 171-174) to carry reasoning/cache:

```ts
    totalTokens:
      stats.totalTokensInput > 0 || stats.totalTokensOutput > 0 || stats.totalTokensReasoning || stats.totalTokensCacheRead || stats.totalTokensCacheWrite
        ? {
            input: stats.totalTokensInput,
            output: stats.totalTokensOutput,
            reasoning: stats.totalTokensReasoning,
            cacheRead: stats.totalTokensCacheRead,
            cacheWrite: stats.totalTokensCacheWrite,
          }
        : undefined,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test src/render/templates/session.test.ts src/render/html.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/render/html.ts src/render/templates/session.ts src/render/templates/session.test.ts
git commit -m "feat(render): display reasoning/cache tokens on session page"
```

---

### Task 9: Update CLI path resolution, validation, and help text

**Files:**
- Modify: `src/index.ts:128-165` (getAutoOutputDir param rename)
- Modify: `src/index.ts:202-205,292` (--storage help text)
- Modify: `src/index.ts:341,347,395-429` (path resolution + validation block)
- Modify: `src/index.ts:440` (getAutoOutputDir call)

**Interfaces:**
- Consumes: `resolveDbPath`, `validateDb` from `./storage/db`; reader functions now take `dbPath`.

- [ ] **Step 1: Rename `storagePath` to `dbPath` in the main flow**

In `src/index.ts`:
- Line 341: `const storagePath = values.storage ?? getDefaultStoragePath()` becomes:
```ts
import { resolveDbPath, validateDb } from "./storage/db"
const dbPath = resolveDbPath(values.storage)
```
(Remove the `getDefaultStoragePath` import that was used here; `resolveDbPath(undefined)` returns the default.)
- Line 347: `debug(\`Storage path: ${storagePath}\`)` → `debug(\`DB path: ${dbPath}\`)`.
- Every later reference to `storagePath` (search/generate calls, getAutoOutputDir call at line 440, logging at line 536, html.ts invocation at line 566) becomes `dbPath`. Use `rg -n "storagePath" src/index.ts` to find all and replace.

- [ ] **Step 2: Replace the validation block (lines 395-429)**

Replace the whole `// Validate storage path exists` block with:

```ts
const validation = validateDb(dbPath)
if (!validation.ok) {
  console.error(color("Error:", colors.red, colors.bold) + ` OpenCode database not found at: ${dbPath}`)
  console.error("")
  if (validation.reason === "ENOENT") {
    console.error(color("The file does not exist.", colors.yellow))
  } else if (validation.reason === "NOT_SQLITE") {
    console.error(color("The file is not a valid SQLite database.", colors.yellow))
  } else {
    console.error(color("The file is a SQLite database but not valid OpenCode storage (missing core tables).", colors.yellow))
  }
  console.error("")
  console.error(color("This could mean:", colors.dim))
  console.error("  1. OpenCode has not been used on this machine yet")
  console.error("  2. The database path is incorrect")
  console.error("")
  console.error(color("Solutions:", colors.green))
  console.error("  - Run OpenCode at least once to create the database")
  console.error("  - Use --storage <path-to-opencode.db>")
  console.error("")
  console.error(color("Default path:", colors.dim) + ` ${resolveDbPath()}`)
  process.exit(1)
}
```

- [ ] **Step 3: Rename `getAutoOutputDir` param**

In `src/index.ts:128-165`, rename the first parameter `storagePath` → `dbPath` and update its three internal reader calls (`listProjects(dbPath)`, `listSessions(dbPath, project.id)`, `findProjectByPath(dbPath, cwd)`). Update the call site at line 440 to pass `dbPath`.

- [ ] **Step 4: Update `--storage` help text**

At `src/index.ts:202-205`, change the `storage` option description to:
```ts
      description: "Path to opencode.db (or its parent directory)",
```
At the help usage block near line 292, change:
```
  --storage <path>       Custom storage path (default: ~/.local/share/opencode/storage)
```
to:
```
  --storage <path>       Path to opencode.db (default: ~/.local/share/opencode/opencode.db)
```

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Run full test suite**

Run: `bun test`
Expected: all green (711 prior + new tests from Tasks 2/5/7/8).

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat(cli): SQLite path resolution and validation"
```

---

### Task 10: Manual end-to-end verification against the real database

**Files:** none (verification only)

- [ ] **Step 1: Run against the user's real DB**

Run: `bun run dev -- --open`
Expected: generates `./opencode-replay-output/` with HTML for the current project's sessions and opens the browser. No "storage not found" error.

- [ ] **Step 2: Spot-check a session page**

Open a generated `sessions/<id>/index.html` in a browser. Confirm:
- The stats bar shows Model, Tokens, and (where applicable) Reasoning and Cache rows.
- Tool renderers (bash/read/edit/etc.) render correctly.
- Cost appears on sessions that have nonzero cost.

- [ ] **Step 3: Verify `--all` and a specific `--session`**

Run: `bun run dev -- --all -o ./tmp-all`
Run: `bun run dev -- -s <some-ses-id> -o ./tmp-one`
Expected: both succeed; `--all` produces a projects index; the single-session export matches.

- [ ] **Step 4: Verify error path**

Run: `bun run dev -- --storage /tmp/does-not-exist.db`
Expected: the new ENOENT error message with solutions.

- [ ] **Step 5: Clean up temp outputs**

```bash
rm -rf ./tmp-all ./tmp-one ./opencode-replay-output
```

No commit (verification only). If any check fails, return to the relevant task and fix before declaring done.

---

## Verification Summary

- Final gate: `bun run typecheck && bun test` — all green.
- Manual gate: `bun run dev -- --open` works against `~/.local/share/opencode/opencode.db`.
