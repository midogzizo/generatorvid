// مزود CometAPI — صور متزامنة عبر نقطة متوافقة مع OpenAI تعيد الرابط/ب64 فورًا،
// وفيديو عبر نقطة مهام غير متزامنة بنمط create/check. نتبع الشكل المتوافق مع OpenAI
// defensively لأن المستخدم لا يملك بعد مفتاح CometAPI — التصنيف الموحد يغطي الأخطاء.
import { ProviderError, providerFetch, type ProviderAdapter, type ProviderCheckResult, type ProviderInput, type ProviderTaskHandle } from "./types";

const COMETAPI_BASE = "https://api.cometapi.com";

export const cometapiAdapter: ProviderAdapter = {
  // صور متزامنة: POST /v1/images/generations → { data: [{ url | b64_json }] }
  async createImageSync(apiKey: string, providerModel: string, input: ProviderInput): Promise<{ urls: string[] }> {
    const { json } = await providerFetch(`${COMETAPI_BASE}/v1/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: providerModel,
        prompt: input.prompt,
        // 1K→1024x1024 تقريبي؛ القيم الدقيقة حسب توثيق CometAPI الحالي
        size: input.resolution === "4K" ? "4096x4096" : input.resolution === "2K" ? "2048x2048" : "1024x1024",
      }),
    }, 60000);
    const data = json?.data;
    if (!Array.isArray(data) || data.length === 0) {
      throw new ProviderError(400, json?.error?.message || json?.message || "cometapi: no image data returned");
    }
    const urls: string[] = [];
    for (const item of data) {
      if (typeof item?.url === "string" && /^https?:\/\//i.test(item.url)) {
        urls.push(item.url);
      } else if (typeof item?.b64_json === "string") {
        // b64 لا يُخزَّن ملفًا — نرفضه لأن سياستنا روابط فقط، مع رسالة واضحة
        throw new ProviderError(400, "cometapi: b64_json only response is unsupported (links-only policy)");
      }
    }
    if (urls.length === 0) throw new ProviderError(400, "cometapi: no usable image URL in response");
    return { urls };
  },

  async createTask(apiKey: string, providerModel: string, input: ProviderInput): Promise<ProviderTaskHandle> {
    const { json } = await providerFetch(`${COMETAPI_BASE}/v1/video/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: providerModel,
        prompt: input.prompt,
        ...(input.imageUrl ? { image_url: input.imageUrl } : {}),
        ...(input.aspectRatio && input.aspectRatio !== "auto" ? { aspect_ratio: input.aspectRatio } : {}),
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.duration ? { duration: input.duration } : {}),
        ...(input.enableAudio !== undefined ? { enable_audio: input.enableAudio } : {}),
      }),
    }, 60000);
    const taskId = json?.task_id || json?.taskId || json?.data?.task_id || json?.data?.taskId || json?.id;
    if (!taskId) {
      throw new ProviderError(400, json?.error?.message || json?.message || "cometapi: unexpected createTask response");
    }
    return { providerTaskId: String(taskId) };
  },

  async checkTask(apiKey: string, providerTaskId: string): Promise<ProviderCheckResult> {
    const { json } = await providerFetch(`${COMETAPI_BASE}/v1/video/tasks/${encodeURIComponent(providerTaskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const st = String(json?.status || json?.data?.status || "").toLowerCase();
    const pickUrls = (obj: any): string[] => {
      const out = obj?.video_url || obj?.videoUrl || obj?.url || obj?.data?.video_url || obj?.data?.url;
      if (typeof out === "string" && /^https?:\/\//i.test(out)) return [out];
      if (Array.isArray(obj?.videos)) {
        const arr = obj.videos.map((v: any) => v?.url || v?.video_url).filter((u: any) => typeof u === "string");
        return arr;
      }
      return [];
    };
    if (/(succeed|success|completed|complete|done)/.test(st)) {
      const urls = pickUrls(json);
      if (urls.length === 0) return { status: "failed", error: "cometapi: completed without result URLs" };
      return { status: "completed", urls };
    }
    if (/(fail|failed|error|cancelled|canceled)/.test(st)) {
      return { status: "failed", error: json?.error?.message || json?.message || json?.failure_reason || "cometapi: task failed" };
    }
    const progressNum = Number(json?.progress || json?.data?.progress);
    return { status: "processing", progress: Number.isFinite(progressNum) ? Math.round(progressNum > 1 ? progressNum : progressNum * 100) : 30 };
  },
};
