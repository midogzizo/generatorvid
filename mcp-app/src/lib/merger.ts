// عميل خدمة دمج الفيديو — Video Merger API v2 (بلا مفاتيح أو توثيق)
// قواعد إلزامية:
// - أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري بلا إعادة محاولة.
// - أخطاء شبكتنا (timeout/fetch) = مؤقتة → تستمر بالاستعلام حتى انتهاء النافذة.
// - قد يرد الجسم فيه error بدون حقل status → تعامل معه كفشل فوري.
// - progress قد يأتي كسرًا 0..1 → اضربه في 100.
import { insertTask, getTask, updateTask, type TaskRow } from "./turso";

export const MERGER_BASE = (process.env.MERGER_API_BASE || "https://xxxxxxxx").replace(/\/+$/, "");

// قفل في الذاكرة يمنع تزامن نداء POST /process مع get_task على نفس المهمة
const processInFlight = new Set<string>();

const COMPLETED_STATES = /done|completed|complete|success|succeeded|finished/i;
const FAILED_STATES = /error|failed|failure|cancelled|canceled/i;

export interface MergerJobResponse {
  jobId: string;
  status: string;
  statusUrl?: string;
  processUrl?: string;
  expiresAt?: string;
  progress?: number;
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
  size?: number;
  duration?: number;
  resolution?: string;
}

async function mergerFetch(path: string, init?: RequestInit, timeoutMs = 60000): Promise<{ status: number; json: any }> {
  // مهلة الشبكة تُرمى كخطأ مؤقت (بدون status) — أما HTTP غير ok فيُعاد كما هو للتحليل الدفاعي
  let res: Response;
  try {
    res = await fetch(`${MERGER_BASE}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e: any) {
    throw Object.assign(new Error(`merger network error: ${e?.message || e}`), { isNetworkError: true });
  }
  const text = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// إنشاء مهمة دمج لدى الخدمة
export async function mergerCreateJob(videos: string[]): Promise<MergerJobResponse> {
  const { status, json } = await mergerFetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos }),
  });
  if (status !== 200 && status !== 201) {
    const err = json?.error || `HTTP ${status}`;
    throw Object.assign(new Error(`merger create failed: ${err}`), { isHttpError: true, httpStatus: status });
  }
  if (!json?.jobId) {
    throw Object.assign(new Error("merger: unexpected create response (no jobId)"), { isHttpError: true, httpStatus: status });
  }
  return json as MergerJobResponse;
}

// تنفيذ الدمج — يُطلق مرة واحدة فقط لكل مهمة (قفل في الذاكرة)
export async function mergerFireProcess(jobId: string): Promise<void> {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  void (async () => {
    try {
      // يستغرق ~10–15 ثانية (blocking)؛ نتركه يعمل في الخلفية
      await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" }, 280000);
    } catch {
      // أخطاء العملية تُكتشف عبر استعلام الحالة لاحقًا
    } finally {
      processInFlight.delete(jobId);
    }
  })();
}

// تحليل دفاعي لحالة المهمة من الخدمة
export function parseMergerStatus(json: MergerJobResponse): { status: "processing" | "completed" | "failed"; progress?: number; videoUrl?: string; error?: string } {
  // جسم فيه error بدون status → فشل فوري
  if (json.error && !json.status) {
    return { status: "failed", error: json.error };
  }
  const st = String(json.status || "");
  if (FAILED_STATES.test(st)) {
    return { status: "failed", error: json.error || `merger status: ${st}` };
  }
  if (COMPLETED_STATES.test(st) || json.videoUrl || json.downloadUrl) {
    // رابط النتيجة: فضّل videoUrl ثم downloadUrl، وإلا اضبط رابط الملف المباشر
    const videoUrl = json.videoUrl || json.downloadUrl || `${MERGER_BASE}/api/jobs/${json.jobId}/video`;
    let progress = normalizeProgress(json.progress);
    if (progress < 100) progress = 100;
    return { status: "completed", progress, videoUrl };
  }
  return { status: "processing", progress: normalizeProgress(json.progress) };
}

function normalizeProgress(p: unknown): number {
  const n = Number(p);
  if (!Number.isFinite(n)) return 0;
  const pct = n > 1 ? n : n * 100; // كسر 0..1 → اضرب في 100
  return Math.max(0, Math.min(100, Math.round(pct)));
}

// استعلام حالة مهمة الدمج — 404 = فشل نهائي (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)
export async function mergerCheckJob(jobId: string): Promise<{ status: "processing" | "completed" | "failed"; progress?: number; videoUrl?: string; error?: string }> {
  const { status, json } = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "GET" }, 30000);
  if (status === 404) {
    return { status: "failed", error: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" };
  }
  if (!json) {
    if (status >= 400) return { status: "failed", error: `فشل نهائي من خدمة الدمج (HTTP ${status})` };
    // جسم غير مقروء مع 2xx → مؤقت، نعتبرها معالجة
    return { status: "processing" };
  }
  if (status >= 400) {
    // أي خطأ HTTP معلن = فشل نهائي فوري
    return { status: "failed", error: json?.error || `فشل نهائي من خدمة الدمج (HTTP ${status})` };
  }
  return parseMergerStatus(json);
}

// تدفق runMerge: تسجيل المهمة أولًا ثم إنشاء الدمج لدى الخدمة وإطلاق process خلفيًا
export async function startMergeJob(taskId: string, urls: string[]): Promise<TaskRow> {
  await updateTask(taskId, { status: "processing", progress: 5 });
  try {
    const job = await mergerCreateJob(urls);
    await updateTask(taskId, { provider: "merger", provider_task_id: job.jobId, progress: 10 });
    // إطلاق process خلفيًا وبمرة واحدة فقط — محمي بقفل الذاكرة
    await mergerFireProcess(job.jobId);
    return (await getTask(taskId))!;
  } catch (e: any) {
    if (e?.isHttpError) {
      // خطأ معلن من الخدمة عند الإنشاء = فشل نهائي (مثل مصدر يرفض التحميل)
      await updateTask(taskId, { status: "failed", error_message: e.message, completed_at: undefined });
    } else {
      // خطأ شبكة عند الإنشاء → تبقى معالجة وتُعاد عبر get_task
      await updateTask(taskId, { error_message: e.message });
    }
    return (await getTask(taskId))!;
  }
}

// تحديث مهمة دمج من الخدمة (يُستدعى من get_task وأثناء نافذة الانتظار)
export async function refreshMergeTask(task: TaskRow): Promise<TaskRow> {  const jobId = task.provider_task_id;
  if (!jobId) {
    // لم تُنشأ مهمة الدمج بعد (فشل إنشاء مؤقت) → أعد الإنشاء
    const params = JSON.parse(task.params_json || "{}");
    const urls: string[] = params.mergedUrls || [];
    if (urls.length >= 2) {
      return startMergeJob(task.id, urls);
    }
    return task;
  }
  // إن كانت قيد المعالجة ولم يُنفَّذ process بعد فنفّذه الآن (يحميه القفل)
  if (task.status === "processing" && task.progress < 10) {
    await mergerFireProcess(jobId);
  }
  let chk: Awaited<ReturnType<typeof mergerCheckJob>>;
  try {
    chk = await mergerCheckJob(jobId);
  } catch {
    // خطأ شبكتنا (مهلة/انقطاع) = مؤقت → تبقى المهمة معالجة وتُعاد عبر استعلام لاحق
    return task;
  }
  if (chk.status === "completed" && chk.videoUrl) {
    await updateTask(task.id, { status: "completed", progress: 100, result_urls_json: JSON.stringify([chk.videoUrl]) });
  } else if (chk.status === "failed") {
    // أخطاء الخدمة المعلنة حتمية — لا إعادة محاولة
    await updateTask(task.id, { status: "failed", error_message: chk.error || "فشل الدمج لدى الخدمة" });
  } else {
    await updateTask(task.id, { progress: Math.max(task.progress, chk.progress ?? 0) });
  }
  return (await getTask(task.id))!;
}

// نافذة انتظار الدمج: استعلام كل 3 ثوان مع بث تقدم — الإرسال الحي للسجل في كل مرة
export async function pollMergeUntilDone(taskId: string, waitSeconds: number, onProgress?: (p: number, msg: string) => Promise<void>): Promise<TaskRow> {
  const deadline = Date.now() + waitSeconds * 1000;
  let last = 10;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const task = await getTask(taskId);
    if (!task) break;
    if (task.status === "completed" || task.status === "failed") return task;
    let chk: { status: "processing" | "completed" | "failed"; progress?: number; videoUrl?: string; error?: string };
    try {
      chk = task.provider_task_id ? await mergerCheckJob(task.provider_task_id) : { status: "processing" as const };
    } catch {
      // خطأ شبكتنا = مؤقت → استمر بالاستعلام حتى انتهاء النافذة
      continue;
    }
    if (chk.status === "completed" && chk.videoUrl) {
      await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: JSON.stringify([chk.videoUrl]) });
    } else if (chk.status === "failed") {
      // أي خطأ HTTP معلن من الخدمة = فشل نهائي فوري بلا إعادة محاولة
      await updateTask(taskId, { status: "failed", error_message: chk.error || "فشل الدمج لدى الخدمة" });
      return (await getTask(taskId))!;
    } else {
      const p = Math.max(last, chk.progress ?? 0);
      last = p;
      await updateTask(taskId, { progress: p });
      await onProgress?.(p, `جارٍ دمج المقاطع… ${p}%`);
    }
  }
  return (await getTask(taskId))!;
}
