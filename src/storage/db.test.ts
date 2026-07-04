import { describe, test, expect, afterAll, beforeAll } from "bun:test"
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
