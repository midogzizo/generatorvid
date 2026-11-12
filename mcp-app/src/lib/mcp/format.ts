// صياغة الردود العربية لأدوات MCP — المصطلحات التقنية وأسماء الأدوات تبقى بالإنجليزية
import { sanitizeErrorForClient } from "../keys";
import type { TaskRow } from "../turso";

export function fmtCompletedImage(urls: string[]): string {
  const url = urls[0];
  const more = urls.length > 1 ? `\n\nروابط إضافية:\n${urls.slice(1).map((u) => `- ${u}`).join("\n")}` : "";
  return `✅ تم توليد الصورة بنجاح\n\n![image](${url})\n\nالرابط المباشر: ${url}${more}`;
}

export function fmtCompletedVideo(urls: string[]): string {
  const list = urls.map((u) => `- ${u}`).join("\n");
  return `✅ تم توليد الفيديو بنجاح\n\nالروابط المباشرة:\n${list}`;
}

export function fmtCompletedMerge(urls: string[]): string {
  const list = urls.map((u) => `- ${u}`).join("\n");
  return `✅ تم دمج المقاطع بنجاح\n\nالروابط المباشرة:\n${list}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
}

export function fmtProcessing(taskId: string): string {
  return `⏳ المهمة قيد المعالجة — task_id: ${taskId}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

export function fmtFailed(reason: string | null): string {
  return `❌ فشلت المهمة: ${reason || "سبب غير معروف"}`;
}

export function fmtNoKeys(modelCanonical: string): string {
  return `❌ لا توجد مفاتيح نشطة لخدمة ${modelCanonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`;
}

export function fmtBadModel(given: string): string {
  return `❌ موديل غير مدعوم: ${given}. المتاح: gpt-image-2-6/flare-text-to-image (صور) و grok-imagine-video-1-5-preview (فيديو).`;
}

export function fmtMergeTooFew(details?: string): string {
  return `❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.${details ? `\n\nتفاصيل المعرّفات غير الصالحة:\n${details}` : ""}`;
}

export function fmtMergeTooMany(): string {
  return "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).";
}

export function fmtMergeBadUrl(bad: string): string {
  return `❌ روابط الدمج يجب أن تكون روابط فيديو مباشرة عامة (http/https) — الرابط التالي غير صالح: ${bad}`;
}

export function fmtListMedia(tasks: TaskRow[]): string {
  if (tasks.length === 0) return "لا توجد وسائط مخزنة بعد — ابدأ بـ generate_image أو generate_video.";
  const lines = tasks.map((t) => {
    const urls: string[] = (() => {
      try { return t.result_urls_json ? JSON.parse(t.result_urls_json) : []; } catch { return []; }
    })();
    const state = t.status === "completed" ? "مكتملة" : t.status === "failed" ? "فاشلة" : "جارية";
    const head = `- [${state}] (${t.type}) ${t.model} — ${t.id} — ${t.created_at}`;
    if (t.status === "completed" && urls.length) return `${head}\n  روابط:\n${urls.map((u) => `  - ${u}`).join("\n")}`;
    if (t.status === "failed") return `${head}\n  السبب: ${sanitizeErrorForClient(t.error_message) || "غير معروف"}`;
    return `${head}\n  الحالة: قيد المعالجة ${t.progress}% — تابع بـ get_task`;
  });
  return `أحدث الوسائط المخزنة (${lines.length}):\n\n${lines.join("\n\n")}`;
}

// تحويل صف مهمة إلى نص رد عربي حسب حالتها
export function fmtTaskResult(task: TaskRow): { text: string; isError?: boolean } {
  const urls: string[] = (() => {
    try { return task.result_urls_json ? JSON.parse(task.result_urls_json) : []; } catch { return []; }
  })();
  if (task.status === "completed" && urls.length) {
    if (task.type === "image") return { text: fmtCompletedImage(urls) };
    if (task.type === "merge") return { text: fmtCompletedMerge(urls) };
    return { text: fmtCompletedVideo(urls) };
  }
  if (task.status === "failed") {
    return { text: fmtFailed(sanitizeErrorForClient(task.error_message)), isError: true };
  }
  return { text: fmtProcessing(task.id) };
}
