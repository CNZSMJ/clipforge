import { NextRequest, NextResponse } from "next/server";
import { errText } from "@/lib/api-error";
import { discoverModels } from "@/lib/llm-models";

/** Server-side catalogue lookup, separate from the model-level connection probe. */
export async function POST(req: NextRequest) {
  const reply = (body: unknown, status = 200) => NextResponse.json(body, {
    status, headers: { "Cache-Control": "no-store" },
  });
  let body;
  try { body = await req.json(); }
  catch { return reply({ ok: false, models: [], errorCode: "INVALID_REQUEST", error: errText(req, "无效 JSON", "Invalid JSON") }, 400); }
  const { baseUrl, apiKey = "" } = body ?? {};
  let validUrl = false;
  if (typeof baseUrl === "string" && baseUrl.trim() && baseUrl.length <= 2048) {
    try {
      const url = new URL(baseUrl.trim());
      // Local Ollama/custom HTTP endpoints are intentional; never allow embedded credentials.
      validUrl = ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch { /* invalid endpoint */ }
  }
  if (!validUrl || typeof apiKey !== "string" || apiKey.length > 4096) {
    return reply({ ok: false, models: [], errorCode: "INVALID_REQUEST", error: errText(req, "无效服务地址或密钥格式", "Invalid endpoint or key format") }, 400);
  }
  const result = await discoverModels(baseUrl, apiKey);
  return reply(result.ok ? result : {
    ...result,
    // Only stable, local text is returned. Upstream errors may contain URLs or credentials.
    error: errText(req, "暂时无法读取模型目录，可重试或手动填写模型名。", "Could not read the model catalogue; retry or enter a model name manually."),
  });
}
