// مصنع خادم MCP — الأدوات الخمس بمخططات مطابقة للمواصفة حرفيًا
// الردود بالعربية؛ أوصاف الأدوات بالإنجليزية لأنها تُقرأ من نموذج الذكاء الاصطناعي.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runGeneration, refreshTask } from "../generation";
import { startMergeJob, pollMergeUntilDone } from "../merger";
import { getTask, insertTask, listRecentTasks } from "../turso";
import { isPublicHttpUrl } from "../urlcheck";
import {
  fmtTaskResult, fmtNoKeys, fmtBadModel, fmtMergeTooFew, fmtMergeTooMany, fmtMergeBadUrl, fmtListMedia,
} from "./format";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

// بث تقدم حي إذا زوّد العميل الطلب بـ _meta.progressToken
type ExtraLike = { sendNotification: (n: unknown) => Promise<void>; _meta?: { progressToken?: unknown } };
function progressCbFrom(extra: unknown) {
  const e = (extra || {}) as ExtraLike;
  const token = e?._meta?.progressToken;
  return async (progress: number, message: string): Promise<void> => {
    if (!token) return;
    try {
      await e.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total: 100, message },
      });
    } catch {
      // إشعارات التقدم ليست حرجة — نتجاهل فشلها
    }
  };
}

const waitImage = z.number().int().min(0).max(240).default(90).describe("Max seconds to wait for the image in this call (0-240). If not finished in time, a task_id is returned.");
const waitVideo = z.number().int().min(0).max(240).default(25).describe("Short wait with live progress, then task_id — keep polling get_task.");

export function createMediaServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // ---------- 1) generate_image ----------
  server.registerTool(
    "generate_image",
    {
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active API keys). Returns the finished image URL if completed within the wait window; otherwise returns a task_id — call get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image")
          .describe("Image model (both spellings are unified)."),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: waitImage,
      },
    },
    async (args, extra) => {
      const cb = progressCbFrom(extra);
      const res = await runGeneration({
        type: "image",
        input: {
          prompt: args.prompt,
          aspectRatio: args.aspect_ratio,
          resolution: args.resolution,
          background: args.background,
          outputFormat: args.output_format,
        },
        providerModelName: args.model,
        waitSeconds: args.wait_seconds,
        onProgress: cb,
      });
      if (res.kind === "no_keys") return { content: [{ type: "text", text: fmtNoKeys(res.modelCanonical) }] };
      if (res.kind === "bad_model") return { content: [{ type: "text", text: fmtBadModel(res.given) }], isError: true };
      const { text, isError } = fmtTaskResult(res.task);
      return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
    }
  );

  // ---------- 2) generate_video ----------
  server.registerTool(
    "generate_video",
    {
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio, optional image-to-video). Videos take minutes: short wait with live progress, then a task_id is returned — poll get_task every ~10 seconds until completed, then show the URL.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview")
          .describe("Video model (both spellings are unified)."),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: waitVideo,
      },
    },
    async (args, extra) => {
      const cb = progressCbFrom(extra);
      const res = await runGeneration({
        type: "video",
        input: {
          prompt: args.prompt,
          imageUrl: args.image_url,
          aspectRatio: args.aspect_ratio,
          resolution: args.resolution,
          enableAudio: args.enable_audio,
          duration: args.duration,
        },
        providerModelName: args.model,
        waitSeconds: args.wait_seconds,
        onProgress: cb,
      });
      if (res.kind === "no_keys") return { content: [{ type: "text", text: fmtNoKeys(res.modelCanonical) }] };
      if (res.kind === "bad_model") return { content: [{ type: "text", text: fmtBadModel(res.given) }], isError: true };
      const { text, isError } = fmtTaskResult(res.task);
      return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
    }
  );

  // ---------- 3) merge_videos ----------
  server.registerTool(
    "merge_videos",
    {
      description:
        "Merge several clips into one final video in the given order. Pass 'urls' (public direct video URLs — e.g. from generate_video) or 'task_ids' (COMPLETED video tasks; their result URLs are resolved from the database in this order). Merging is usually fast: short wait with live progress, then a merge task_id — track it with get_task. The merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z.array(z.string())
          .min(2, "الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.")
          .max(10, "أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).")
          .optional().describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z.array(z.string())
          .min(2, "الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.")
          .max(10, "أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).")
          .optional().describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).default(60).describe("Max seconds to wait for the merge in this call (0-240)."),
      },
    },
    async (args, extra) => {
      const cb = progressCbFrom(extra);
      const resolved: string[] = [];
      const failedDetails: string[] = [];

      // روابط task_ids أُولًا ثم urls المباشرة بنفس ترتيبها
      for (const tid of args.task_ids || []) {
        const t = await getTask(tid);
        if (!t || t.status !== "completed" || !t.result_urls_json) {
          failedDetails.push(`${tid}: ${!t ? "مهمة غير موجودة" : t.status !== "completed" ? `الحالة ${t.status} — ليست مكتملة` : "بلا روابط نتيجة"}`);
          continue;
        }
        try {
          const urls = JSON.parse(t.result_urls_json) as string[];
          if (urls.length > 0) resolved.push(urls[0]);
        } catch {
          failedDetails.push(`${tid}: روابط النتيجة تالفة`);
        }
      }
      for (const u of args.urls || []) {
        if (!isPublicHttpUrl(u)) {
          return { content: [{ type: "text", text: fmtMergeBadUrl(u) }], isError: true };
        }
        resolved.push(u);
      }

      if (resolved.length < 2) {
        return { content: [{ type: "text", text: fmtMergeTooFew(failedDetails.join("\n")) }], isError: true };
      }
      if (resolved.length > 10) {
        return { content: [{ type: "text", text: fmtMergeTooMany() }], isError: true };
      }

      // تسجيل مهمة الدمج في Turso أولًا ثم التنفيذ لدى الخدمة
      const taskId = crypto.randomUUID();
      await insertTask({
        id: taskId,
        provider: "merger",
        provider_task_id: null,
        key_id: null,
        model: "video-merger",
        type: "merge",
        prompt: `دمج ${resolved.length} مقاطع`,
        params_json: JSON.stringify({ mergedUrls: resolved }),
        status: "processing",
        progress: 5,
        result_urls_json: null,
        error_message: null,
        attempts_json: "[]",
      });
      await startMergeJob(taskId, resolved);
      const task = await pollMergeUntilDone(taskId, args.wait_seconds ?? 60, cb);
      const { text, isError } = fmtTaskResult(task);
      return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
    }
  );

  // ---------- 4) get_task ----------
  server.registerTool(
    "get_task",
    {
      description:
        "Track any task by its id — image/video generation AND merging (reads Turso and refreshes live from the provider/merging service when still processing). Poll every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().min(1).describe("The task_id returned by generate_image / generate_video / merge_videos."),
      },
    },
    async (args, extra) => {
      const cb = progressCbFrom(extra);
      const task = await refreshTask(args.task_id, cb);
      if (!task) {
        return { content: [{ type: "text", text: `❌ لا توجد مهمة بهذا المعرّف: ${args.task_id}` }], isError: true };
      }
      const { text, isError } = fmtTaskResult(task);
      return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
    }
  );

  // ---------- 5) list_media ----------
  server.registerTool(
    "list_media",
    {
      description:
        "Most recent images/videos/merges stored with their links from the database (no regeneration) — for recalling previous results.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const tasks = await listRecentTasks(args.limit ?? 10, { type: args.type, status: args.status });
      return { content: [{ type: "text", text: fmtListMedia(tasks) }] };
    }
  );

  return server;
}
