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
  SessionSummary,
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
} from "./db"

export { getDefaultDbPath }

function mapProject(r: ProjectRow): Project {
  return {
    id: r.id,
    worktree: r.worktree,
    vcs: (r.vcs ?? undefined) as "git" | undefined,
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
  let summary: SessionSummary | undefined = r.summary_additions ?? r.summary_deletions ?? r.summary_files
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
    cost: r.cost,
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
  try {
    return queryProjects(openDb(dbPath)).map(mapProject)
  } catch {
    return []
  }
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
    project: mapProject({
      id: r.project_id,
      worktree: r.worktree,
      vcs: null,
      name: null,
      time_created: r.time_created,
      time_updated: r.time_updated,
    }),
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
