// إدارة المفاتيح — القائمة مقنَّعة دائمًا ولا يُعاد المفتاح الكامل في أي استجابة
import { NextRequest, NextResponse } from "next/server";
import { insertKey, listKeys } from "@/lib/turso";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function masked(k: { id: string; provider: string; label: string; api_key: string; status: string; usage_count: number; success_count: number; fail_count: number; last_used_at: string | null; last_checked_at: string | null; last_error: string | null; created_at: string }) {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    masked: maskKey(k.api_key),
    status: k.status,
    usage_count: k.usage_count,
    success_count: k.success_count,
    fail_count: k.fail_count,
    last_used_at: k.last_used_at,
    last_checked_at: k.last_checked_at,
    last_error: k.last_error,
    created_at: k.created_at,
  };
}

export async function GET() {
  try {
    const keys = await listKeys();
    return NextResponse.json({ keys: keys.map(masked) });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "خطأ في جلب المفاتيح" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const provider = String(body?.provider || "").toLowerCase();
    const apiKey = String(body?.api_key || "").trim();
    const label = String(body?.label || "").trim().slice(0, 80);
    if (provider !== "kie" && provider !== "cometapi") {
      return NextResponse.json({ error: "المزود يجب أن يكون kie أو cometapi" }, { status: 400 });
    }
    if (!apiKey) {
      return NextResponse.json({ error: "المفتاح مطلوب" }, { status: 400 });
    }
    // رفض التكرار لنفس المزود
    const existing = await listKeys();
    if (existing.some((k) => k.provider === provider && k.api_key === apiKey)) {
      return NextResponse.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود" }, { status: 409 });
    }
    const created = await insertKey(provider, apiKey, label);
    return NextResponse.json({ key: masked(created) }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "خطأ في إضافة المفتاح" }, { status: 500 });
  }
}
