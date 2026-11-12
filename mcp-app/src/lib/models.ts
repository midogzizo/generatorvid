// سجل الموديلات — الأسماء الموحدة (canonical) والبدائل المقبولة وما يُرسل لكل مزود
// الأسماء قابلة للتجاوز بمتغيرات البيئة (KIE_IMAGE_MODEL, COMETAPI_VIDEO_MODEL ...)
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string;
  aliases: string[];
  type: MediaType;
  providers: ProviderId[];
  providerModel: Record<ProviderId, string>;
}

const KIE_IMAGE_MODEL = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const COMETAPI_IMAGE_MODEL = process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image";
const KIE_VIDEO_MODEL = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
const COMETAPI_VIDEO_MODEL = process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1-5-preview";

export const MODELS: ModelDef[] = [
  {
    canonical: KIE_IMAGE_MODEL,
    aliases: [
      "gpt-image-2-6/flare-text-to-image",
      "gpt-image-2.6/flare-text-to-image",
      KIE_IMAGE_MODEL,
      COMETAPI_IMAGE_MODEL,
    ],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_IMAGE_MODEL, cometapi: COMETAPI_IMAGE_MODEL },
  },
  {
    canonical: KIE_VIDEO_MODEL,
    aliases: [
      "grok-imagine-video-1-5-preview",
      "grok-imagine-video-1.5-preview",
      KIE_VIDEO_MODEL,
      COMETAPI_VIDEO_MODEL,
    ],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO_MODEL, cometapi: COMETAPI_VIDEO_MODEL },
  },
];

// توحيد الصيغ البديلة: الشرطات/النقاط + مقارنة على الأسماء المقبولة
export function resolveModel(name?: string): ModelDef | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  for (const m of MODELS) {
    for (const a of m.aliases) {
      if (a.toLowerCase() === n) return m;
    }
  }
  // توحيد إضافي: استبدال النقاط بشرطات ثم المقارنة (gpt-image-2.6/... → gpt-image-2-6/...)
  const normalized = n.replace(/\./g, "-");
  for (const m of MODELS) {
    if (m.canonical.toLowerCase().replace(/\./g, "-") === normalized) return m;
    for (const a of m.aliases) {
      if (a.toLowerCase().replace(/\./g, "-") === normalized) return m;
    }
  }
  return null;
}

// الاسم الظاهر للعميل دائمًا هو الاسم الموحد canonical
export function canonicalOf(m: ModelDef): string {
  return m.canonical;
}
