// طبقة المفاتيح — قلب سياسة التبديل التسلسلي الصارم
// قواعد جوهرية:
// 1) ترتيب التجربة تسلسلي بحسب أمر الإضافة (created_at ASC, id ASC) — ليس round-robin.
// 2) المفتاح المستنزف (exhausted) يبقى في القائمة؛ الاستثناء الوحيد هو disabled اليدوي.
// 3) العميل (نموذج الذكاء الاصطناعي) لا يرى أبدًا أخطاء المفاتيح أو الرصيد.
import { getKeyById, listKeys, setKeyStatus, bumpKeyStats, type ApiKeyRow, type AttemptEntry } from "./turso";

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

// خطأ مزود موحّد — status اختياري (انقطاع شبكة/مهلة)
export class ProviderError extends Error {
  status?: number;
  constructor(status: number | undefined, message: string) {
    super(message);
    this.status = status;
    this.name = "ProviderError";
  }
}

// تصنيف موحّد للأخطاء وفق الجدول الإلزامي في المواصفة
export function classifyProviderError(status: number | undefined, message: string): ErrorClass {
  const m = (message || "").toLowerCase();
  // نفاد الرصيد يُفحص أولًا لأن بعض المزودين يعيدونه بحالة 400
  if (status === 402 || /(insufficient|quota|balance|credit|out of credits|exhausted|充值|欠费|arrears|payment required)/.test(m)) {
    return "exhausted";
  }
  if (status === 401 || status === 403 || /(invalid api key|invalid_key|unauthorized|forbidden|authentication|api key)/.test(m)) {
    return "disabled";
  }
  if (
    /(model not found|unsupported model|model does not exist|unknown model|not found model|invalid model)/.test(m) &&
    (status === 400 || status === 404 || status === 422 || status === undefined)
  ) {
    return "provider";
  }
  if (status === 400 || status === 422) {
    return "params";
  }
  // 429، 5xx، انقطاع شبكة، مهلة — كلها مؤقتة
  return "temporary";
}

// سجل محاولة موحّد مع تحديث عدّادات المفتاح دائمًا (نجاح أو فشل)
export async function recordAttempt(entry: AttemptEntry): Promise<void> {
  if (!entry.ok) {
    await bumpKeyStats(entry.keyId, false, entry.error);
  } else {
    await bumpKeyStats(entry.keyId, true);
  }
}

// تعليم المفتاح حسب فئة الخطأ — لا شيء يُكتب عند provider/params/temporary
export async function markKeyForErrorClass(keyId: string, cls: ErrorClass, error: string): Promise<void> {
  if (cls === "disabled") {
    await setKeyStatus(keyId, "disabled", error);
  } else if (cls === "exhausted") {
    await setKeyStatus(keyId, "exhausted", error);
  }
}

// تجمع المفاتيح غير المعطّلة لهذه المزودات بترتيب تسلسلي صارم حسب الإضافة
export async function getKeyPool(providers: string[]): Promise<ApiKeyRow[]> {
  const all = await listKeys();
  const set = new Set(providers);
  // listKeys مرتبة أصلاً بـ created_at ASC, id ASC — نحتفظ بالترتيب نفسه
  return all.filter((k) => set.has(k.provider) && k.status !== "disabled");
}

// إخفاء المفتاح إلزاميًا في كل استجابة واجهة أو سجل
export function maskKey(key: string): string {
  if (key.length > 10) {
    return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
  }
  return `${key.slice(0, 3)}••••`;
}

// تعقيم رسائل الأخطاء الواردة للعميل: أي ذكر لمفاتيح/رصيد يُستبدل برسالة عامة
const LEAK_PATTERNS = /(api key|apikey|مفتاح|المفتاح|balance|رصيد|الرصيد|credit|quota|unauthorized|forbidden|401|402|exhausted|insufficient|token|authenticat)/i;
export function sanitizeErrorForClient(error: string | null | undefined): string | null {
  if (!error) return null;
  if (LEAK_PATTERNS.test(error)) {
    return "تعذّر إكمال المهمة حاليًا بسبب ظرف مؤقت في خدمة التوليد — ستُعاد المحاولة تلقائيًا عند الاستعلام بـ get_task";
  }
  return error;
}

// فحص رسالة فشل منتصف المهمة: هل تشير لمشكلة مفتاح/رصيد تستوجب إعادة الإنشاء على مفتاح آخر؟
export function isKeyRelatedFailure(msg: string): boolean {
  return /(insufficient|balance|credit|quota|402|401|unauthorized|invalid api key|exhausted|充值|forbidden|payment)/i.test(msg || "");
}

// إعادة التحقق من حالة المفتاح عند القفل (مثلاً بعد شحن الرصيد) — تُستخدم عند إعادة المحاولة
export async function reactivateKeyIfActiveProvider(keyId: string): Promise<void> {
  const k = await getKeyById(keyId);
  if (k && k.status === "exhausted") {
    // نُبقيه exhausted حتى ينجح استدعاء فعلي؛ لا تحويل تلقائي عشوائي
  }
}
