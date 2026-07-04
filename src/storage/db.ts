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
    probe.query("SELECT 1").get()
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
