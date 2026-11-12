// مسار خادم MCP — نقل Streamable HTTP عبر SDK الرسمي
// runtime nodejs + force-dynamic إلزاميان للبث الحي (SSE) وعدم الكاش.
// وضع stateless (sessionIdGenerator: undefined): لا خريطة جلسات في الذاكرة —
// الخيار الصحيح لبيئات الـ serverless حيث تُقتل المثيلات وتعاد، ويبقى كل نداء مكتفٍ ذاتيًا
// حسب مواصفة MCP Streamable HTTP. إشعارات التقدم تُبث عبر بث SSE الخاص بالطلب نفسه.
import { NextRequest } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMediaServer } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // نافذة الانتظار قد تصل 240 ثانية (تُقيَّد حسب خطة الاستضافة)

function checkAuth(req: NextRequest): Response | null {
  const expected = process.env.MCP_ACCESS_TOKEN;
  if (!expected) return null; // بلا توكن → مفتوح للجميع
  const header = req.headers.get("authorization") || "";
  if (header !== `Bearer ${expected}`) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" } }), {
      status: 401,
      headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
    });
  }
  return null;
}

// خادم ووسيط جديد لكل طلب — لا حالة مشتركة بين الطلبات
async function handle(req: NextRequest, parsedBody?: unknown): Promise<Response> {
  const server = createMediaServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(req as unknown as Request, parsedBody ? { parsedBody } : undefined);
}

export async function POST(req: NextRequest) {
  const denied = checkAuth(req);
  if (denied) return denied;
  let parsedBody: unknown;
  try {
    parsedBody = await req.json();
  } catch {
    parsedBody = undefined; // يترك SDK يعالج الجسم التالف برد JSON-RPC صحيح
  }
  try {
    return await handle(req, parsedBody);
  } catch (e) {
    console.error("[mcp] POST error:", e);
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// GET يفتح بث SSE مستقلًا للإشعارات — في وضع stateless يُعاد 405 من SDK إن لم يكن مدعومًا للعميل
export async function GET(req: NextRequest) {
  const denied = checkAuth(req);
  if (denied) return denied;
  try {
    return await handle(req);
  } catch (e) {
    console.error("[mcp] GET error:", e);
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// DELETE لإنهاء الجلسة — في وضع stateless لا جلسات ينهيها، يُرد 200 دائمًا
export async function DELETE(req: NextRequest) {
  const denied = checkAuth(req);
  if (denied) return denied;
  try {
    return await handle(req);
  } catch (e) {
    console.error("[mcp] DELETE error:", e);
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
