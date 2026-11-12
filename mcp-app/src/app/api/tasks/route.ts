// تغذية لوحة المهام بالواجهة — أحدث المهام مع الإحصائيات والروابط مقنّعة المصدر
import { NextRequest, NextResponse } from "next/server";
import { listRecentTasks, taskStats } from "@/lib/turso";
import { sanitizeErrorForClient } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const limit = Math.min(50, Math.max(1, Number(sp.get("limit") || 20)));
    const type = sp.get("type") || undefined;
    const status = sp.get("status") || undefined;
    const [tasks, stats] = await Promise.all([
      listRecentTasks(limit, { type: type || undefined, status: status || undefined }),
      taskStats(),
    ]);
    return NextResponse.json({
      stats,
      tasks: tasks.map((t) => ({
        id: t.id,
        type: t.type,
        model: t.model,
        provider: t.provider,
        status: t.status,
        progress: t.progress,
        prompt: t.prompt.slice(0, 120),
        urls: (() => {
          try { return t.result_urls_json ? JSON.parse(t.result_urls_json) : []; } catch { return []; }
        })(),
        error: t.status === "failed" ? sanitizeErrorForClient(t.error_message) : null,
        attempts: (() => {
          try { return JSON.parse(t.attempts_json || "[]").length; } catch { return 0; }
        })(),
        created_at: t.created_at,
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "خطأ في جلب المهام" }, { status: 500 });
  }
}
