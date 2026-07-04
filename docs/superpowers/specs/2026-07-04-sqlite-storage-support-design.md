# Design: SQLite Storage Support

**Date:** 2026-07-04
**Status:** Approved (pending user spec review)
**Goal:** Replace opencode-replay's JSON file-based storage reader with a SQLite reader, to support modern OpenCode (v1.15+) which stores sessions in `~/.local/share/opencode/opencode.db`.

## Background & Problem

OpenCode migrated its session storage from flat JSON files
(`storage/project/*.json`, `storage/session/.../*.json`, etc.) to a single
SQLite database (`opencode.db`). opencode-replay v1.1.0 only reads the JSON
format, so on any modern OpenCode install the CLI fails with:

```
Error: OpenCode storage not found at: ~/.local/share/opencode/storage
The directory exists but is not a valid OpenCode storage.
Missing 'project/' subdirectory.
```

The user's database confirmed the new schema with `project`, `session`,
`message`, `part`, and `todo` tables containing 4 projects, 103 sessions, and
1635 messages.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| JSON format support | **Drop entirely** | Single backend; avoids dual-mode complexity |
| `--storage` semantics | **Reuse: point at `opencode.db`** (file or dir) | One path concept; intuitive |
| `session_diff` | **Drop** | `getSessionDiff` is unused in the rendering pipeline and the new DB has no corresponding table |
| New session-level fields (`cost`/`tokens`/`model`) | **Surface in output** | DB stores authoritative totals; enriches the stats display |
| Architecture | **New `db.ts` + rewritten `reader.ts`** | Separates raw SQL from domain type mapping; both independently testable |

## Architecture & Module Boundaries

```
src/storage/
├── db.ts          # NEW: SQLite connection + prepared queries, returns raw rows
├── reader.ts      # REWRITTEN: calls db.ts, maps rows -> domain types, keeps public API
├── types.ts       # EXTENDED: Session gains cost/tokens/model; SessionSummary gains diffs
└── index.ts       # exports adjusted (remove getSessionDiff/getDefaultStoragePath)
```

### Public API (unchanged names; `storagePath` param renamed to `dbPath`)

Consumers (`index.ts`, `render/html.ts`, `render/markdown`) change minimally:

- `getDefaultDbPath()` (replaces `getDefaultStoragePath`) -> `~/.local/share/opencode/opencode.db`
- `listProjects(dbPath)` / `getProject` / `findProjectByPath`
- `listSessions(dbPath, projectId)` / `getSession` / `listAllSessions`
- `listMessages` / `getMessagesWithParts`
- `listParts`
- `getTodoList(dbPath, sessionId)`
- **Removed:** `getSessionDiff`
- **New:** `resolveDbPath(input?)` and `validateDb(path)` (pure, testable helpers in `db.ts`)

### `db.ts` responsibilities

- Open the DB with `bun:sqlite` in **read-only** mode: `new Database(path, { readonly: true })`. The user's production DB is large (~2.7 GB); read-only guarantees no mutation.
- Hold all prepared statements (`prepare()`).
- Return raw row arrays; no domain logic.
- Expose `resolveDbPath(input?)` and `validateDb(path)` for CLI path validation.

### `reader.ts` responsibilities

- Call `db.ts` query helpers.
- Map rows to `Project`/`Session`/`Message`/`Part`/`TodoItem` domain types.
- Preserve all existing sort orders.

## Data Mapping (Row -> Domain Type)

The critical insight: `message.data` and `part.data` are JSON text columns whose
parsed shape matches the existing `Message`/`Part` TypeScript types minus the
`id`/`sessionID`/`messageID` keys (which are stored as separate columns). So
mapping is a spread-plus-merge.

| Table | Row -> Type | Mapping rule |
|---|---|---|
| `project` | `Project` | `time_created`/`time_updated` -> `time.{created,updated}`; `vcs` column -> `vcs`; `vcsDir` absent in new format -> `undefined` (optional in type) |
| `session` | `Session` | `project_id` -> `projectID`; `parent_id` -> `parentID`; `share_url` -> `share.url`; `summary_*` -> `summary`; `time_*` -> `time`; `revert` (JSON text) parsed; new `cost`/`model`/`tokens_*` columns populate new fields. `agent` column captured on the type for completeness but **not displayed** in this iteration |
| `message` | `Message` | `{ id: row.id, sessionID: row.session_id, ...JSON.parse(row.data) }` |
| `part` | `Part` | `{ id: row.id, sessionID: row.session_id, messageID: row.message_id, ...JSON.parse(row.data) }` |
| `todo` | `TodoItem` | Composite PK `(session_id, position)`, no `id` column -> synthesize `id` as `String(position)` |

### `data` column is authoritative

For `message`/`part`, the row-level `time_created`/`time_updated` columns are
denormalized extractions. Rendering trusts the `data` JSON's internal fields
only (consistent with the legacy format's "whole object is one JSON" semantics).

### Sort orders (match legacy implementation)

- `project`: `ORDER BY time_updated DESC`
- `session`: `ORDER BY time_updated DESC`
- `message`: `ORDER BY time_created ASC, id ASC`
- `part`: `ORDER BY id ASC` (id is sequential `prt_*`; legacy used `localeCompare`)

### `todo.id` synthesis

The legacy `TodoItem.id` (a string) does not exist as a column. We synthesize
`id = String(position)`. The `todowrite` renderer uses `id` only as a React-style
key/display; a positional value is sufficient. (To be confirmed against the
renderer during implementation, but type-compatible.)

### Type extensions (`types.ts`)

```ts
export interface Session {
  // ...existing fields...
  cost?: number
  model?: string         // session.model column (model ID)
  agent?: string
  tokens?: TokenUsage    // tokens_input/output/reasoning + cache.{read,write}
}

export interface SessionSummary {
  additions?: number
  deletions?: number
  files?: number
  diffs?: FileDiff[]     // new: from session.summary_diffs JSON column
}
```

## New Field Display & Data Flow

### Current behavior

Session-level cost/tokens/model are currently **aggregated from assistant
messages** in `calculateSessionStats` (`render/data.ts:168`). The session page
stats bar (`render/templates/session.ts:153`) already renders Model/Tokens/Cost
rows from these aggregated stats.

### New behavior

The DB stores authoritative session-level totals (OpenCode computes them
server-side). Two sources must be reconciled:

**Priority:** session-row DB columns are authoritative; message-level
aggregation is a fallback (for zero/missing values).

### Changes

1. **`Session` type** gains `cost?` / `tokens?` / `model?` / `agent?` (above),
   filled by the reader from DB columns.

2. **`SessionStats` extension** (`data.ts:156`) - add optional reasoning and
   cache fields, since the new DB token columns are more complete:
   ```ts
   export interface SessionStats {
     // ...existing...
     totalTokensReasoning?: number
     totalTokensCacheRead?: number
     totalTokensCacheWrite?: number
   }
   ```

3. **`buildSessionData` reconciliation** (`data.ts:224`) - stats still aggregate
   from messages first, then session-level authoritative values override when
   present:
   ```ts
   const stats = calculateSessionStats(messages)
   // Column is `cost real DEFAULT 0 NOT NULL`, so check !== undefined, not truthiness:
   // a session-level 0 is authoritative and must override a nonzero message sum.
   if (session.cost !== undefined) stats.totalCost = session.cost
   if (session.tokens) {
     stats.totalTokensInput = session.tokens.input
     stats.totalTokensOutput = session.tokens.output
     stats.totalTokensReasoning = session.tokens.reasoning
     // cache read/write
   }
   if (session.model && !stats.model) stats.model = session.model
   ```

4. **Rendering layer - zero structural change.** `renderSessionStats`
   (`session.ts:153`) already emits Model/Tokens/Cost rows. Append a new row
   when `totalTokensReasoning` (and cache) is present, mirroring the
   message-level cache display pattern (`components/message.ts:58`).

### Why this layering

`calculateSessionStats` stays a pure function over messages (testable in
isolation). The session-level override lives in one place
(`buildSessionData`), easy to test and revert. Templates/CSS barely move.

### Out of scope

Cross-session cost aggregation on the index page
(`render/templates/index-page.ts` currently aggregates only
additions/deletions). Per-session display only, to keep scope focused.

## Path Resolution, CLI Validation & Error Handling

### Default path

`getDefaultDbPath()` -> `~/.local/share/opencode/opencode.db`

### `--storage` flexible resolution

```
input                              -> resolved
/path/to/opencode.db               -> use directly (file)
/path/to/opencode/                 -> look for dir/opencode.db
undefined                          -> default path
```

Implemented in `resolveDbPath(input?)` (pure, unit-testable).

### Validation flow (replaces `index.ts:395-429`)

1. Resolve DB file path via `resolveDbPath`.
2. File does not exist -> ENOENT error.
3. Open with `bun:sqlite` read-only: `new Database(path, { readonly: true })`.
4. Sanity query `sqlite_master`: confirm `project`, `session`, `message`,
   `part` core tables all present.
5. Any missing -> "not valid OpenCode storage" error.

Implemented in `validateDb(path)` returning a discriminated result.

### Error messages (reuse existing colored output style, reworded for DB)

```
Error: OpenCode database not found at: <resolved>
The file does not exist.                                   # ENOENT
The file is not a valid SQLite database.                   # open failure
The file is a SQLite database but not valid OpenCode       # tables missing
storage (missing 'project' table).
Solutions:
  - Run OpenCode at least once to create the database
  - Use --storage <path-to-opencode.db>
Expected path: <default>
```

### Safety

Open the DB **read-only** at all times. Never write to the user's production DB.

### Variable/help-text rename

- Main flow: `storagePath` -> `dbPath` (in `index.ts`).
- `getDefaultStoragePath()` -> `getDefaultDbPath()`.
- `--storage` help text (`index.ts:202-205`, `:292`) updated to reference the DB.
- `getAutoOutputDir` signature takes `dbPath`; internal logic unchanged.

### `--json` export

Still emits `session.json` containing the reader's typed objects. No extra
changes.

## Testing Strategy

### Core principle

The reader's public-API tests are storage-mechanism-agnostic (they assert on
sorted lists, message-with-parts shape, path matching). So most test bodies
stay; only the `beforeAll` fixture changes from "build JSON tree" to "build
SQLite DB".

### New fixture `tests/fixtures/db.ts`

- Exports `createTestDb(): Promise<string>` - builds a temp DB in `tmpdir()`,
  runs the real OpenCode schema DDL (extracted from the live DB's `.schema`),
  seeds semantically-identical samples to the existing fixture (2 projects, 3
  sessions, 3 messages, 3 parts, todos). Returns `dbPath`.
- Reuses `tests/fixtures/index.ts` factories (`createProject`, `createSession`,
  etc.), splitting each into "row columns + `data` JSON" on write.

### `reader.test.ts` rewrite

- `beforeAll` calls `createTestDb()`.
- Test bodies largely unchanged: sort orders, `getMessagesWithParts` structure,
  `findProjectByPath`, todo return.
- Remove the `getSessionDiff` describe block (function removed).
- Add: `listSessions` result carries `cost`/`tokens`/`model` fields.

### New `db.test.ts`

Unit-test pure helpers:
- `resolveDbPath()`: file passed through, dir appended `opencode.db`, undefined
  falls back to default.
- `validateDb()`: ENOENT / non-SQLite / missing-tables failure modes + success.

### `data.test.ts` extension

`buildSessionData` reconciliation:
- Session with authoritative cost/tokens -> overrides aggregated.
- Session without (cost = 0) -> falls back to message aggregation.
- New token fields (reasoning/cache) propagate.

### `session.test.ts` extension

Template new token rows: reasoning/cache display when present.

### Failing-test audit (during implementation)

- Any test importing `getDefaultStoragePath` / `getSessionDiff` -> update
  imports.
- `tests/integration/full-render.test.ts` - check whether it self-builds
  storage; if so, switch to the DB fixture.
- `storage/types.test.ts` - unaffected (pure type guards).

### Verification baseline

Current suite: **711 tests, all green**. Target after changes: still all green,
plus ~15 new tests covering SQLite mapping, new fields, and validation.
`bun test` is the sole acceptance command.

## File Change Summary

| File | Change |
|---|---|
| `src/storage/db.ts` | NEW: connection, prepared queries, `resolveDbPath`, `validateDb` |
| `src/storage/reader.ts` | REWRITE: SQLite-backed; remove `getSessionDiff` |
| `src/storage/types.ts` | EXTEND: Session cost/tokens/model; SessionSummary.diffs |
| `src/storage/index.ts` | Update exports |
| `src/render/data.ts` | EXTEND: SessionStats reasoning/cache; `buildSessionData` reconciliation |
| `src/render/templates/session.ts` | Append reasoning/cache stat rows |
| `src/index.ts` | Path resolution, validation block, variable/help-text rename |
| `src/storage/reader.test.ts` | REWRITE setup to DB fixture |
| `src/storage/db.test.ts` | NEW |
| `src/render/data.test.ts` | EXTEND reconciliation tests |
| `src/render/templates/session.test.ts` | EXTEND new token row tests |
| `tests/fixtures/db.ts` | NEW: `createTestDb` fixture |
| `tests/integration/full-render.test.ts` | Audit; switch to DB fixture if needed |
