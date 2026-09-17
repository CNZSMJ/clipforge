import { NextRequest, NextResponse } from "next/server";

/**
 * AI 平台 Key 连通性校验（生图/生视频平台）。
 * 各平台用最便宜的「鉴权先过」端点探针：
 * - 2xx → ok（Key 有效）
 * - 401/403 → invalid（Key 无效）
 * - 其它(404/400/5xx/网络) → unknown（无法判定，可直接试生成）
 * 走服务端发起，绕开浏览器 CORS；只读探针，不产生计费生成。
 */

const DEFAULT_BASE: Record<string, string> = {
  "fal-ai": "https://queue.fal.run",
  replicate: "https://api.replicate.com/v1",
  volcengine: "https://ark.cn-beijing.volces.com/api/v3",
  alibaba: "https://dashscope.aliyuncs.com/api/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  openai: "https://api.openai.com/v1",
};

type Probe = { url: string; headers: Record<string, string>; method?: "GET" | "POST"; body?: string };

function buildProbe(name: string, apiKey: string, baseUrl?: string): Probe {
  const base = (baseUrl || DEFAULT_BASE[name] || "").replace(/\/$/, "");
  if (name === "fal-ai") {
    // Only a successful read proves access; 404/422/429/5xx never establish key validity.
    return {
      url: `${base}/fal-ai/flux/requests/00000000-0000-0000-0000-000000000000/status`,
      headers: { Authorization: `Key ${apiKey}` },
    };
  }
  if (name === "replicate") {
    return { url: `${base}/account`, headers: { Authorization: `Bearer ${apiKey}` } };
  }
  if (name === "alibaba") {
    // dashscope 原生无 /models，用 OpenAI 兼容模式的 /models 验 Key
    return { url: `https://dashscope.aliyuncs.com/compatible-mode/v1/models`, headers: { Authorization: `Bearer ${apiKey}` } };
  }
  // siliconflow / volcengine / 自定义 OpenAI 兼容：GET /models
  return { url: `${base}/models`, headers: { Authorization: `Bearer ${apiKey}` } };
}

export async function POST(req: NextRequest) {
  let body: { name?: string; apiKey?: string; baseUrl?: string } = {};
  try {
    const parsed: unknown = await req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed;
  } catch {
    /* 空 body */
  }
  const { name, apiKey, baseUrl } = body;
  if (typeof name !== "string" || !name.trim() || typeof apiKey !== "string" || !apiKey.trim() || (baseUrl != null && typeof baseUrl !== "string")) {
    return NextResponse.json({ status: "unknown", message: "缺少平台或 Key" }, { status: 400 });
  }

  const probe = buildProbe(name, apiKey, baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(probe.url, { method: probe.method ?? "GET", headers: probe.headers, body: probe.body, signal: controller.signal, redirect: "error" });
    if (r.status === 401 || r.status === 403) {
      return NextResponse.json({ status: "invalid", message: "Key 无效或无权限" });
    }
    if (r.ok) {
      return NextResponse.json({ status: "ok", message: "连接正常" });
    }
    return NextResponse.json({ status: "unknown", message: `无法判定（HTTP ${r.status}），可直接试生成` });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return NextResponse.json({ status: "unknown", message: aborted ? "超时，无法判定" : "网络异常，无法判定" });
  } finally {
    clearTimeout(timer);
  }
}
