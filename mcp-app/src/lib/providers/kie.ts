// مزود kie.ai — Jobs API الموحد (الشكل المقاس فعليًا):
// createTask → {"code":200,"data":{"taskId":"..."}}
// recordInfo → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail","resultJson":"{\"resultUrls\":[...]}","failMsg":"..."}}
// ملاحظة: resultJson نص JSON داخل JSON ويحتاج JSON.parse ثانيًا.
import { ProviderError, providerFetch, type ProviderAdapter, type ProviderCheckResult, type ProviderInput, type ProviderTaskHandle } from "./types";

const KIE_BASE = "https://api.kie.ai/api/v1/jobs";

function buildKieInput(providerModel: string, input: ProviderInput): Record<string, unknown> {
  // موديل الصور (flare) يقبل aspect_ratio/resolution/background/output_format؛ الفيديو يقبل الباقي
  const inp: Record<string, unknown> = { prompt: input.prompt };
  if (input.aspectRatio && input.aspectRatio !== "auto") inp.aspect_ratio = input.aspectRatio;
  else if (providerModel.includes("flare")) inp.aspect_ratio = "auto";
  if (input.resolution) inp.resolution = input.resolution;
  if (input.background && providerModel.includes("flare")) inp.background = input.background;
  if (input.outputFormat) inp.output_format = input.outputFormat;
  if (input.imageUrl) inp.image_url = input.imageUrl;
  if (providerModel.includes("grok-imagine")) {
    if (input.enableAudio !== undefined) inp.enable_audio = input.enableAudio;
    if (input.duration) inp.duration = input.duration;
  }
  return inp;
}

export const kieAdapter: ProviderAdapter = {
  async createTask(apiKey: string, providerModel: string, input: ProviderInput): Promise<ProviderTaskHandle> {
    const { json } = await providerFetch(`${KIE_BASE}/createTask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: providerModel, input: buildKieInput(providerModel, input) }),
    });
    // الشكل الحقيقي المقاس: code=200 عند النجاح
    if (json?.code !== 200 || !json?.data?.taskId) {
      throw new ProviderError(400, json?.msg || json?.message || "kie: unexpected createTask response");
    }
    return { providerTaskId: String(json.data.taskId) };
  },

  async checkTask(apiKey: string, providerTaskId: string): Promise<ProviderCheckResult> {
    const { json } = await providerFetch(
      `${KIE_BASE}/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (json?.code !== 200 || !json?.data) {
      throw new ProviderError(400, json?.msg || json?.message || "kie: unexpected recordInfo response");
    }
    const d = json.data;
    const state = String(d.state || "");
    // waiting|queuing|generating → قيد المعالجة
    if (state === "success") {
      let urls: string[] = [];
      try {
        // resultJson نص JSON داخل JSON — تحليل ثانٍ إلزامي
        const parsed = typeof d.resultJson === "string" ? JSON.parse(d.resultJson) : d.resultJson;
        const raw = parsed?.resultUrls || parsed?.urls || [];
        urls = (Array.isArray(raw) ? raw : [raw]).filter((u: unknown) => typeof u === "string" && /^https?:\/\//i.test(u));
      } catch {
        urls = [];
      }
      if (urls.length === 0) {
        // نجاح دون روابط = فشل فعلي محتمَل
        return { status: "failed", error: "اكتملت المهمة لدى المزود دون روابط نتيجة" };
      }
      return { status: "completed", urls };
    }
    if (state === "fail" || state === "failed") {
      return { status: "failed", error: String(d.failMsg || "فشل المزود دون تفاصيل") };
    }
    // تقدم تقريبي: generating أعلى من queuing أعلى من waiting
    const progress = state === "generating" ? 50 : state === "queuing" ? 20 : 10;
    return { status: "processing", progress };
  },
};
