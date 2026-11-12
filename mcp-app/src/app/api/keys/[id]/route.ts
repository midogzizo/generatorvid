// تعطيل/تنشيط يدوي وحذف المفاتيح
import { NextRequest, NextResponse } from "next/server";
import { deleteKey, getKeyById, setKeyStatus } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const status = String(body?.status || "");
    if (status !== "active" && status !== "disabled") {
      return NextResponse.json({ error: "status يجب أن يكون active أو disabled" }, { status: 400 });
    }
    const key = await getKeyById(id);
    if (!key) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
    // التفعيل اليدوي يعيد المفتاح إلى active من أي حالة (بما فيها exhausted بعد شحن الرصيد)
    await setKeyStatus(id, status as "active" | "disabled");
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "خطأ في تحديث المفتاح" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const key = await getKeyById(id);
    if (!key) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
    await deleteKey(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "خطأ في حذف المفتاح" }, { status: 500 });
  }
}
