// طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP، متوافقة مع بيئة الـ serverless على Vercel
// لا نستخدم أي ملف SQLite محلي؛ العميل وحيد ومشترك، والمخطط يُنشأ عند أول وصول.
import { createClient, type Client, type InValue } from "@libsql/client";

let client: Client | null = null;

export function getTurso(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("متغيرات TURSO_DATABASE_URL و TURSO_AUTH_TOKEN غير مضبوطة");
    }
    client = createClient({ url, authToken: token });
  }
  return client;
}

let schemaPromise: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getTurso();
      await db.execute(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        provider TEXT,
        provider_task_id TEXT,
        key_id TEXT,
        model TEXT NOT NULL,
        type TEXT NOT NULL,
        prompt TEXT DEFAULT '',
        params_json TEXT DEFAULT '{}',
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        result_urls_json TEXT,
        error_message TEXT,
        attempts_json TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT DEFAULT '',
        api_key TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        usage_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        last_used_at TEXT,
        last_checked_at TEXT,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`);
      // فهارس خفيفة لترتيب المفاتيح والمهام
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_keys_order ON api_keys (provider, created_at)`);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks (created_at DESC)`);
    })();
  }
  return schemaPromise;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await getTurso().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// ---------- أنواع الصفوف ----------
export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: string;
  prompt: string;
  params_json: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface AttemptEntry {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface ApiKeyRow {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

function nowUtc(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// ---------- عمليات المهام ----------
export async function insertTask(t: Omit<TaskRow, "created_at" | "updated_at" | "completed_at">): Promise<TaskRow> {
  await ensureSchema();
  const db = getTurso();
  await db.execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, result_urls_json, error_message, attempts_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [t.id, t.provider, t.provider_task_id, t.key_id, t.model, t.type, t.prompt, t.params_json, t.status, t.progress, t.result_urls_json, t.error_message, t.attempts_json],
  });
  return (await getTask(t.id))!;
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const rs = await getTurso().execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  if (rs.rows.length === 0) return null;
  return rowToTask(rs.rows[0]);
}

export async function updateTask(id: string, patch: Partial<TaskRow>, addAttempt?: AttemptEntry): Promise<void> {
  await ensureSchema();
  const db = getTurso();
  // سجل المحاولات يُدمج على المستخدم النهائي لتفادي فقدان سجلات متزامنة
  if (addAttempt) {
    const cur = await db.execute({ sql: "SELECT attempts_json FROM tasks WHERE id = ?", args: [id] });
    let arr: AttemptEntry[] = [];
    try { arr = JSON.parse((cur.rows[0]?.attempts_json as string) || "[]"); } catch { arr = []; }
    addAttempt.at = addAttempt.at || nowUtc();
    arr.push(addAttempt);
    patch = { ...patch, attempts_json: JSON.stringify(arr) };
  }
  const sets: string[] = [];
  const args: InValue[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    args.push(v as InValue);
  }
  if (sets.length === 0 && !addAttempt) return;
  if (patch.status === "completed" && !patch.completed_at) {
    sets.push("completed_at = ?");
    args.push(nowUtc());
  }
  sets.push("updated_at = ?");
  args.push(nowUtc());
  args.push(id);
  await db.execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function listRecentTasks(limit: number, filter?: { type?: string; status?: string }): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filter?.type) { where.push("type = ?"); args.push(filter.type); }
  if (filter?.status) { where.push("status = ?"); args.push(filter.status); }
  args.push(limit);
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, id DESC LIMIT ?`;
  const rs = await getTurso().execute({ sql, args });
  return rs.rows.map(rowToTask);
}

export async function taskStats(): Promise<{ total: number; completed: number; failed: number; processing: number }> {
  await ensureSchema();
  const rs = await getTurso().execute(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'processing' OR status = 'pending' THEN 1 ELSE 0 END) AS processing
     FROM tasks`
  );
  const r = rs.rows[0] || {};
  return {
    total: Number(r.total || 0),
    completed: Number(r.completed || 0),
    failed: Number(r.failed || 0),
    processing: Number(r.processing || 0),
  };
}

function rowToTask(row: Record<string, unknown>): TaskRow {
  return {
    id: String(row.id),
    provider: (row.provider as string) ?? null,
    provider_task_id: (row.provider_task_id as string) ?? null,
    key_id: (row.key_id as string) ?? null,
    model: String(row.model),
    type: String(row.type),
    prompt: (row.prompt as string) ?? "",
    params_json: (row.params_json as string) ?? "{}",
    status: row.status as TaskRow["status"],
    progress: Number(row.progress ?? 0),
    result_urls_json: (row.result_urls_json as string) ?? null,
    error_message: (row.error_message as string) ?? null,
    attempts_json: (row.attempts_json as string) ?? "[]",
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    completed_at: (row.completed_at as string) ?? null,
  };
}

// ---------- عمليات المفاتيح ----------
export async function insertKey(provider: string, apiKey: string, label: string): Promise<ApiKeyRow> {
  await ensureSchema();
  const id = crypto.randomUUID();
  await getTurso().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key, status) VALUES (?, ?, ?, ?, 'active')`,
    args: [id, provider, label, apiKey],
  });
  return (await getKeyById(id))!;
}

export async function listKeys(): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const rs = await getTurso().execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return rs.rows.map((r) => rowToKey(r));
}

export async function getKeyById(id: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const rs = await getTurso().execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [id] });
  return rs.rows.length ? rowToKey(rs.rows[0]) : null;
}

export async function setKeyStatus(id: string, status: "active" | "exhausted" | "disabled", lastError?: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: "UPDATE api_keys SET status = ?, last_error = COALESCE(?, last_error), last_checked_at = ? WHERE id = ?",
    args: [status, lastError ?? null, nowUtc(), id],
  });
}

export async function bumpKeyStats(id: string, ok: boolean, error?: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `UPDATE api_keys SET
            usage_count = usage_count + 1,
            success_count = success_count + ?,
            fail_count = fail_count + ?,
            last_used_at = ?,
            last_error = COALESCE(?, last_error),
            last_checked_at = ?
          WHERE id = ?`,
    args: [ok ? 1 : 0, ok ? 0 : 1, nowUtc(), error ?? null, nowUtc(), id],
  });
}

export async function deleteKey(id: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}

function rowToKey(row: Record<string, unknown>): ApiKeyRow {
  return {
    id: String(row.id),
    provider: String(row.provider),
    label: (row.label as string) ?? "",
    api_key: String(row.api_key),
    status: String(row.status ?? "active"),
    usage_count: Number(row.usage_count ?? 0),
    success_count: Number(row.success_count ?? 0),
    fail_count: Number(row.fail_count ?? 0),
    last_used_at: (row.last_used_at as string) ?? null,
    last_checked_at: (row.last_checked_at as string) ?? null,
    last_error: (row.last_error as string) ?? null,
    created_at: String(row.created_at ?? ""),
  };
}
