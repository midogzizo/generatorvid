// منسّق التوليد — التبديل التسلسلي الصارم للمفاتيح مع استئناف نفس المهمة بنفس task_id
// القواعد الذهبية المطبقة هنا:
// - تسجيل المهمة في Turso قبل أي نداء خارجي.
// - تجربة المرشحين بالترتيب؛ أول نجاح يربط المهمة بالمزود والمفتاح.
// - عند فشل منتصف المهمة بسبب مفتاح/رصيد: إعادة إنشاء نفس المهمة على المفتاح التالي بصمت.
// - فشل على كل المفاتيح → المهمة تبقى processing وتُعاد المحاولة مع كل get_task (تهدئة 45 ثانية).
import {
  insertTask, getTask, updateTask,
  type TaskRow, type AttemptEntry,
} from "./turso";
import { classifyProviderError, getKeyPool, markKeyForErrorClass, recordAttempt, isKeyRelatedFailure, ProviderError } from "./keys";
import { resolveModel, type ModelDef } from "./models";
import { kieAdapter } from "./providers/kie";
import { cometapiAdapter } from "./providers/cometapi";
import type { ProviderInput } from "./providers/types";
import { refreshMergeTask } from "./merger";

const COOLDOWN_MS = 45_000; // هدوء قبل إعادة المحاولة مع كل استدعاء get_task
const POLL_INTERVAL_MS = 3_000;

function adapterOf(provider: string) {
  return provider === "cometapi" ? cometapiAdapter : kieAdapter;
}

export interface ProgressCb {
  (progress: number, message: string): Promise<void>;
}

export interface GenerationArgs {
  type: "image" | "video";
  input: ProviderInput;
  providerModelName?: string; // اسم الموديل كما أرسله العميل (يُوحَّد)
  waitSeconds: number;
  onProgress?: ProgressCb;
}

export type GenerationResult =
  | { kind: "no_keys"; modelCanonical: string }
  | { kind: "bad_model"; given: string }
  | { kind: "task"; task: TaskRow };

// إنشاء مهمة توليد جديدة وفق التدفق الموصوف
export async function runGeneration(args: GenerationArgs): Promise<GenerationResult> {
  // 1) توحيد اسم الموديل — غير معروف → خطأ معطيات فوري
  const m = resolveModel(args.providerModelName);
  if (!m) {
    return { kind: "bad_model", given: args.providerModelName || "(فارغ)" };
  }

  // 2) تجمع المفاتيح بالترتيب التسلسلي الصارم
  const pool = await getKeyPool(m.providers);
  if (pool.length === 0) {
    return { kind: "no_keys", modelCanonical: m.canonical };
  }

  // 3) تسجيل المهمة في Turso قبل أي نداء خارجي
  const taskId = crypto.randomUUID();
  const task = await insertTask({
    id: taskId,
    provider: null,
    provider_task_id: null,
    key_id: null,
    model: m.canonical,
    type: args.type,
    prompt: args.input.prompt,
    params_json: JSON.stringify({ ...args.input, requestedModel: args.providerModelName }),
    status: "processing",
    progress: 5,
    result_urls_json: null,
    error_message: null,
    attempts_json: "[]",
  });

  // 4) تجربة المرشحين بالترتيب حتى نجاح الإنشاء
  const created = await tryCreateOnPool(task.id, m, args.input, null, args.onProgress);
  if (!created.ok) {
    if (created.errorClass === "params") {
      // خطأ معطيات — تبديل المفاتيح لن يحله
      await updateTask(task.id, { status: "failed", error_message: created.error || "خطأ في معطيات الطلب" });
      return { kind: "task", task: (await getTask(task.id))! };
    }
    // فشل على كل المفاتيح → processing مع رسالة داخلية
    await updateTask(task.id, { progress: 0, error_message: "بانتظار توفر مفتاح صالح…" });
    return { kind: "task", task: (await getTask(task.id))! };
  }

  // صور متزامنة اكتملت فورًا (CometAPI)
  if (created.syncUrls) {
    await updateTask(task.id, { status: "completed", progress: 100, result_urls_json: JSON.stringify(created.syncUrls) });
    return { kind: "task", task: (await getTask(task.id))! };
  }

  // 5) نافذة الانتظار: استعلام كل 3 ثوان مع بث تقدم
  const finalTask = await pollUntilDone(task.id, m, args.waitSeconds, args.onProgress);
  return { kind: "task", task: finalTask };
}

interface CreateOutcome {
  ok: boolean;
  provider?: string;
  keyId?: string;
  syncUrls?: string[];
  errorClass?: string;
  error?: string;
}

// تجربة مفاتيح المجمع بالترتيب بدءًا من المفتاح التالي لـ afterKeyId (أو من البداية)
async function tryCreateOnPool(
  taskId: string,
  m: ModelDef,
  input: ProviderInput,
  afterKeyId: string | null,
  onProgress?: ProgressCb
): Promise<CreateOutcome> {
  const pool = await getKeyPool(m.providers);
  const startIdx = afterKeyId ? pool.findIndex((k) => k.id === afterKeyId) + 1 : 0;
  let lastError: CreateOutcome = { ok: false, errorClass: "temporary", error: "لا يوجد مرشحون" };

  for (let i = startIdx; i < pool.length; i++) {
    const key = pool[i];
    const provider = key.provider;
    const adapter = adapterOf(provider);
    const providerModel = m.providerModel[provider as "kie" | "cometapi"];
    const attempt: AttemptEntry = { provider, keyId: key.id, keyLabel: key.label || maskOf(key.api_key), ok: false, at: "" };
    try {
      if (m.type === "image" && adapter.createImageSync) {
        const { urls } = await adapter.createImageSync(key.api_key, providerModel, input);
        await recordAttempt({ ...attempt, ok: true });
        await updateTask(taskId, { provider, key_id: key.id, provider_task_id: null, status: "processing", progress: 60 }, { ...attempt, ok: true });
        return { ok: true, provider, keyId: key.id, syncUrls: urls };
      }
      const { providerTaskId } = await adapter.createTask(key.api_key, providerModel, input);
      await recordAttempt({ ...attempt, ok: true });
      await updateTask(taskId, { provider, key_id: key.id, provider_task_id: providerTaskId, status: "processing", progress: 15 }, { ...attempt, ok: true });
      await onProgress?.(15, "تم إسناد المهمة للمزود وبدأ التوليد…");
      return { ok: true, provider, keyId: key.id };
    } catch (e: any) {
      const status = e instanceof ProviderError ? e.status : (e?.status ?? undefined);
      const msg = e?.message || String(e);
      const cls = classifyProviderError(status, msg);
      await recordAttempt({ ...attempt, ok: false, errorClass: cls, error: msg });
      await updateTask(taskId, {}, { ...attempt, ok: false, errorClass: cls, error: msg });
      await markKeyForErrorClass(key.id, cls, msg);
      lastError = { ok: false, errorClass: cls, error: msg };
      if (cls === "params") {
        // توقف فورًا — مشكلة معطيات لا يعالجها تبديل المفاتيح
        return lastError;
      }
      // disabled/exhausted/provider/temporary → انتقل للمفتاح التالي
      continue;
    }
  }
  return lastError;
}

function maskOf(key: string): string {
  return key.length > 10 ? `${key.slice(0, 7)}…${key.slice(-4)}` : `${key.slice(0, 3)}…`;
}

// استعلام دوري حتى اكتمال المهمة أو انتهاء نافذة الانتظار
async function pollUntilDone(taskId: string, m: ModelDef, waitSeconds: number, onProgress?: ProgressCb): Promise<TaskRow> {
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const task = await getTask(taskId);
    if (!task) break;
    if (task.status === "completed" || task.status === "failed") return task;
    if (!task.provider_task_id || !task.key_id) {
      // لم يُنشأ لدى المزود بعد — أعد المحاولة على المفتاح التالي المتاح
      const res = await tryCreateOnPool(taskId, m, JSON.parse(task.params_json || "{}"), task.key_id, onProgress);
      if (res.ok && res.syncUrls) {
        await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: JSON.stringify(res.syncUrls) });
        return (await getTask(taskId))!;
      }
      continue;
    }
    const taskAfter = await checkAndUpdate(taskId, m, onProgress);
    if (taskAfter.status === "completed" || taskAfter.status === "failed") return taskAfter;
    await onProgress?.(taskAfter.progress, `قيد التوليد… ${taskAfter.progress}%`);
  }
  // انتهت النافذة — المهمة تبقى processing والعميل يتابع بـ get_task
  const t = await getTask(taskId);
  await onProgress?.(t?.progress ?? 10, "لا تزال قيد المعالجة — تابع بـ get_task");
  return t!;
}

// فحص حي واحد من المزود وتحديث المهمة، مع كامل منطق التبديل عند فشل المفتاح
async function checkAndUpdate(taskId: string, m: ModelDef, onProgress?: ProgressCb): Promise<TaskRow> {
  const task = (await getTask(taskId))!;
  if (!task.provider_task_id || !task.key_id) return task;
  try {
    const adapter = adapterOf(task.provider || "kie");
    const chk = await adapter.checkTask((await keySecret(task.key_id)) || "", task.provider_task_id);
    if (chk.status === "completed" && chk.urls?.length) {
      await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: JSON.stringify(chk.urls) });
    } else if (chk.status === "failed") {
      const msg = chk.error || "فشل المزود";
      if (isKeyRelatedFailure(msg)) {
        // فشل منتصف المهمة بسبب مفتاح/رصيد → إعادة إنشاء بنفس task_id على المفتاح التالي
        const res = await tryCreateOnPool(taskId, m, JSON.parse(task.params_json || "{}"), task.key_id, onProgress);
        if (!res.ok && res.errorClass === "params") {
          await updateTask(taskId, { status: "failed", error_message: res.error || "خطأ في معطيات الطلب" });
        }
        // إن لم يوجد مفتاح تالٍ تبقى المهمة processing بانتظار get_task
      } else {
        // فشل حقيقي (سياسة/معطيات) → نهائي
        await updateTask(taskId, { status: "failed", error_message: msg });
      }
    } else {
      await updateTask(taskId, { progress: Math.max(task.progress, Math.min(chk.progress ?? 0, 95)) });
    }
    return (await getTask(taskId))!;
  } catch (e: any) {
    const status = e instanceof ProviderError ? e.status : undefined;
    const msg = e?.message || String(e);
    const cls = classifyProviderError(status, msg);
    if (cls === "disabled" || cls === "exhausted") {
      // مفتاح أصبح غير صالح أثناء المهمة → علّمه وأعد الإنشاء على التالي بصمت
      await markKeyForErrorClass(task.key_id, cls, msg);
      await recordAttempt({ provider: task.provider || "kie", keyId: task.key_id, keyLabel: "active-key", ok: false, errorClass: cls, error: msg, at: "" });
      await tryCreateOnPool(taskId, m, JSON.parse(task.params_json || "{}"), task.key_id, onProgress);
    }
    // temporary → استمر بالاستعلام
    return (await getTask(taskId))!;
  }
}

async function keySecret(keyId: string): Promise<string | null> {
  const { getKeyById } = await import("./turso");
  const k = await getKeyById(keyId);
  return k?.api_key || null;
}

// ---------- get_task: تحديث حي من المزود أو خدمة الدمج ----------
export async function refreshTask(taskId: string, onProgress?: ProgressCb): Promise<TaskRow | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  if (task.status === "completed" || task.status === "failed") return task;

  if (task.type === "merge") {
    return refreshMergeTask(task);
  }

  const m = resolveModel(task.model);
  if (!m) return task;

  if (!task.provider_task_id) {
    // المهمة لم تُسنَد لأي مزود بعد — أعد المحاولة مع كل get_task بعد فترة تهدئة 45 ثانية
    const last = Date.parse(task.updated_at.replace(" ", "T") + "Z");
    if (Number.isFinite(last) && Date.now() - last < COOLDOWN_MS) return task;
    const pool = await getKeyPool(m.providers);
    if (pool.length === 0) return task;
    const res = await tryCreateOnPool(task.id, m, JSON.parse(task.params_json || "{}"), null, onProgress);
    if (res.ok && res.syncUrls) {
      await updateTask(task.id, { status: "completed", progress: 100, result_urls_json: JSON.stringify(res.syncUrls) });
    }
    return (await getTask(task.id))!;
  }

  // جارية لدى المزود — فحص واحد حي مع كامل منطق التبديل
  return checkAndUpdate(task.id, m, onProgress);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
