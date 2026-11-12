// تعريف واجهة المزودات المشتركة
import { ProviderError } from "../keys";
// نعيد تصدير ProviderError ليصل عبر مسار موحد لكل المزودات
export { ProviderError };

export interface ProviderInput {
  prompt: string;
  imageUrl?: string;
  aspectRatio?: string;
  resolution?: string;
  background?: string;
  outputFormat?: string;
  enableAudio?: boolean;
  duration?: number;
}

export interface ProviderTaskHandle {
  providerTaskId: string;
}

export interface ProviderCheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  // مهمة غير متزامنة (فيديو وبعض الصور): تعيد معرّف المهمة لدى المزود
  createTask(apiKey: string, providerModel: string, input: ProviderInput): Promise<ProviderTaskHandle>;
  // صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا)
  createImageSync?(apiKey: string, providerModel: string, input: ProviderInput): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(apiKey: string, providerTaskId: string): Promise<ProviderCheckResult>;
}

// مساعد fetch موحّد: مهلة 30 ثانية وتحويل كل فشل إلى ProviderError ليُصنَّف لاحقًا
export async function providerFetch(url: string, init: RequestInit, timeoutMs = 30000): Promise<{ status: number; json: any; text: string }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e: any) {
    // انقطاع شبكة/مهلة → مؤقت
    throw new ProviderError(undefined, `network error: ${e?.message || e}`);
  }
  const text = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg =
      json?.error?.message || json?.error?.code || json?.error || json?.message || json?.msg || text?.slice(0, 300) || `HTTP ${res.status}`;
    throw new ProviderError(res.status, typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return { status: res.status, json, text };
}
