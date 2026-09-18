// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAL_LLM_BASE_URL } from "../fal-onekey";
import { balancedChatBody, balancedChatFetch, usesBalancedLlmPolicy } from "../llm-balanced";
import { createLLMClient, tokenCapRetryFetch } from "../llm-error";
import { probeLLMEndpoint } from "../llm-probe";
import { analyzeProduct } from "../script-engine/generator";

const model = "google/gemini-3.8-flash";
const old = "google/gemini-2.5-flash";
const endpoint = `${FAL_LLM_BASE_URL}/chat/completions`;
const completion = () => Response.json({ id: "test", choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }] });
afterEach(() => vi.unstubAllGlobals());

describe("model-specific cost and compatibility policy", () => {
  it("gives scripts medium reasoning, removes retired sampling knobs and retains the existing cap", () => {
    const body = { model, temperature: 0.8, top_p: 0.9, top_k: 40, max_tokens: 16000, messages: [{ role: "user", content: "JSON storyboard" }] };
    const next = balancedChatBody(FAL_LLM_BASE_URL, body);
    expect(next).toMatchObject({ model, max_tokens: 16000, reasoning: { effort: "medium" } });
    expect(next).not.toHaveProperty("temperature"); expect(next).not.toHaveProperty("top_p"); expect(next).not.toHaveProperty("top_k");
    expect(body.temperature).toBe(0.8); expect(next.messages).toBe(body.messages);
  });
  it("visual requests retain ordered high-detail image references and get low reasoning", () => {
    const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/product.png", detail: "high" } }, { type: "image_url", image_url: { url: "https://example.com/character.png", detail: "high" } }] }];
    const next = balancedChatBody(FAL_LLM_BASE_URL, { model, messages, max_tokens: 2000, temperature: 0.1 });
    expect(next).toMatchObject({ max_tokens: 4096, reasoning: { effort: "low" } });
    expect(next.messages).toBe(messages);
  });
  it("short text utilities use low reasoning; unbounded script calls receive a ceiling", () => {
    expect(balancedChatBody(FAL_LLM_BASE_URL, { model, max_tokens: 1200 })).toMatchObject({ max_tokens: 4096, reasoning: { effort: "low" } });
    expect(balancedChatBody(FAL_LLM_BASE_URL, { model })).toMatchObject({ max_tokens: 16000, reasoning: { effort: "medium" } });
  });
  it("preserves explicit reasoning, alternate caps, streaming and structured-output schemas", () => {
    const body = { model, max_completion_tokens: 1024, reasoning: { effort: "high" }, stream: true, response_format: { type: "json_schema", json_schema: { name: "result" } } };
    const next = balancedChatBody(FAL_LLM_BASE_URL, body);
    expect(next).toEqual(body); expect(next).not.toHaveProperty("max_tokens");
    expect(balancedChatBody(FAL_LLM_BASE_URL, { model, reasoning_effort: "high" })).not.toHaveProperty("reasoning");
  });
  it.each(["https://api.openai.com/v1", "https://example.com/v1", "https://openrouter.ai.evil.invalid/api/v1", `${FAL_LLM_BASE_URL}?proxy=1`])(
    "leaves unrelated gateways unchanged: %s", (baseUrl) => {
      const body = { model, temperature: 0.3, max_tokens: 50 };
      expect(balancedChatBody(baseUrl, body)).toBe(body);
    });
  it("supports the direct OpenRouter endpoint but leaves other models unchanged", () => {
    expect(usesBalancedLlmPolicy("https://openrouter.ai/api/v1/", model)).toBe(true);
    const body = { model: old, temperature: 0.3, max_tokens: 2000 };
    expect(balancedChatBody(FAL_LLM_BASE_URL, body)).toBe(body);
  });
  it("does not touch non-chat calls, malformed bodies, abort signals or successful SSE responses", async () => {
    const response = new Response("data: [DONE]\n\n");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const wrapped = balancedChatFetch(FAL_LLM_BASE_URL, fetcher);
    const signal = new AbortController().signal;
    const init = { method: "POST", body: JSON.stringify({ model, stream: true }), signal };
    expect(await wrapped(endpoint, init)).toBe(response);
    expect(fetcher.mock.calls[0][1]?.signal).toBe(signal);
    await wrapped(`${FAL_LLM_BASE_URL}/models`, init);
    expect(fetcher.mock.calls[1][1]).toBe(init);
    const malformed = { method: "POST", body: "{" };
    await wrapped(endpoint, malformed); expect(fetcher.mock.calls[2][1]).toBe(malformed);
  });
  it("does not retry the balanced model with an unlimited cap after rejection", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("max_tokens rejected", { status: 400 }));
    const result = await tokenCapRetryFetch(fetcher)(endpoint, { method: "POST", body: JSON.stringify({ model, max_tokens: 4096 }) });
    expect(result.status).toBe(400); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("real SDK and actual product-analysis caller select the vision model and keep Fal authentication", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => completion()); vi.stubGlobal("fetch", fetcher);
    await analyzeProduct(["https://example.com/a.png", "https://example.com/b.png"], { baseUrl: FAL_LLM_BASE_URL, apiKey: "FAL_TEST", model: "different-script-model", visionModel: model });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(endpoint);
    expect(new Headers(init?.headers).get("authorization")).toBe("Key FAL_TEST");
    const sent = JSON.parse(init?.body as string);
    expect(sent).toMatchObject({ model, max_tokens: 4096, reasoning: { effort: "low" } });
    // the analysis prompt specifies a JSON object, so the call runs in JSON mode (Plan A)
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(sent.messages[0].content.filter((p: { type: string }) => p.type === "image_url").map((p: { image_url: { url: string } }) => p.image_url.url)).toEqual(["https://example.com/a.png", "https://example.com/b.png"]);
  });
  it("real SDK applies medium reasoning to script requests without changing the prompt", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => completion()); vi.stubGlobal("fetch", fetcher);
    await createLLMClient({ baseUrl: FAL_LLM_BASE_URL, apiKey: "TEST" }).chat.completions.create({ model, temperature: 0.85, max_tokens: 16000, messages: [{ role: "user", content: "write a JSON storyboard" }] });
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toMatchObject({ model, reasoning: { effort: "medium" }, max_tokens: 16000 });
  });
  it("connection test uses the same model policy with a bounded low-cost probe", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => completion());
    expect((await probeLLMEndpoint({ baseUrl: FAL_LLM_BASE_URL, apiKey: "TEST", model, fetchImpl: fetcher })).ok).toBe(true);
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toMatchObject({ max_tokens: 512, reasoning: { effort: "low" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
