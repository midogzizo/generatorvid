// فحص الجهوزية العام — قاعدة Turso، سجل الموديلات، خدمة الدمج، وحالة التوثيق
import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { MERGER_BASE } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let database = "turso-disconnected";
  try {
    database = (await dbHealthy()) ? "turso-connected" : "turso-disconnected";
  } catch {
    database = "turso-disconnected";
  }

  // فحص خدمة الدمج بمهلة 4 ثوانٍ — نقطة /api/config للحدود العامة
  let mergerHealthy = false;
  try {
    const r = await fetch(`${MERGER_BASE}/api/config`, { signal: AbortSignal.timeout(4000) });
    mergerHealthy = r.ok;
  } catch {
    mergerHealthy = false;
  }

  return NextResponse.json({
    ok: database === "turso-connected",
    database,
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
    merger: { base: MERGER_BASE, healthy: mergerHealthy },
    authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
  });
}
