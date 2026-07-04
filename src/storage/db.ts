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
