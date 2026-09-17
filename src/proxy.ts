import { NextRequest, NextResponse } from "next/server";
import { applyLocalCors, localCorsPreflight, rejectUntrustedWrite } from "@/lib/local-cors";

export function proxy(req: NextRequest) {
  if (req.method === "OPTIONS") return localCorsPreflight(req);
  const rejected = rejectUntrustedWrite(req);
  if (rejected) return rejected;
  return applyLocalCors(req, NextResponse.next());
}

export const config = {
  // Next clones/buffers matched request bodies and truncates them above its proxy limit.
  // ALL binary/multipart entrypoints bypass it and apply identical CORS within their handlers.
  // Do not replace this with a larger global buffer: media routes already enforce streaming limits.
  matcher: ["/api/((?!upload(?:/|$)|products/upload(?:/|$)|media/analyze(?:/|$)|replicate/analyze(?:/|$)|project/[^/]+/(?:materials|media|bgm)(?:/|$)).*)"],
};
