// فحص الروابط العامة المباشرة (http/https) — تُستخدم في الدمج
export function isPublicHttpUrl(u: string): boolean {
  try {
    const p = new URL(u);
    if (p.protocol !== "http:" && p.protocol !== "https:") return false;
    const h = p.hostname.toLowerCase();
    // نرفض النطاقات الداخلية/المحلية — الروابط يجب أن تكون عامة
    if (h === "localhost" || h.endsWith(".local") || h === "0.0.0.0" || h === "::1") return false;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}
