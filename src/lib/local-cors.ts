import { NextRequest, NextResponse } from "next/server";

/** Local workbenches may access the API; arbitrary websites may not initiate writes. */
export function allowedLocalOrigin(origin: string | null): string | null {
  if (!origin) return null;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return origin;
  const extra = (process.env.CLIPFORGE_CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return extra.includes(origin) ? origin : null;
}

export function rejectUntrustedWrite(req: NextRequest): NextResponse | undefined {
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin && !allowedLocalOrigin(origin)
    && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return NextResponse.json({ error: "Untrusted cross-origin request" }, { status: 403 });
  }
}

export function applyLocalCors(req: NextRequest, res: Response): Response {
  const origin = allowedLocalOrigin(req.headers.get("origin"));
  if (!origin) return res;
  res.headers.set("Access-Control-Allow-Origin", origin);
  const vary = res.headers.get("Vary");
  if (!vary?.split(",").some(v => v.trim().toLowerCase() === "origin")) res.headers.set("Vary", vary ? `${vary}, Origin` : "Origin");
  res.headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", req.headers.get("access-control-request-headers") || "Content-Type");
  res.headers.set("Access-Control-Max-Age", "86400");
  return res;
}

export function localCorsPreflight(req: NextRequest): Response {
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin && !allowedLocalOrigin(origin)) return new NextResponse(null, { status: 403 });
  return applyLocalCors(req, new NextResponse(null, { status: 204 }));
}

/** No request clone, read, or buffering: large media stays under the route's streaming limits. */
export function withLocalCors<Args extends unknown[]>(handler: (req: NextRequest, ...args: Args) => Promise<Response>) {
  return async (req: NextRequest, ...args: Args): Promise<Response> => {
    const rejected = rejectUntrustedWrite(req);
    if (rejected) return rejected;
    return applyLocalCors(req, await handler(req, ...args));
  };
}
