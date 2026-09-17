import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPicker } from "@/components/settings/model-picker";

vi.mock("@/lib/i18n", () => ({ useT: () => (key: string) => key }));
let root: Root;
let container: HTMLDivElement;
const fetchMock = vi.fn();
const pick = vi.fn();
const reply = (models: unknown[], status = 200) => new Response(JSON.stringify({ ok: true, models }), { status });
async function render(baseUrl = "http://service-a/v1", apiKey = "test-a") {
  await act(async () => root.render(createElement(ModelPicker, { baseUrl, apiKey, onPick: pick })));
}
async function load() { await act(async () => container.querySelector("button")!.click()); }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset(); pick.mockReset();
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); vi.unstubAllGlobals();
});

describe("模型目录配置隔离", () => {
  it("切换地址或密钥立即清空旧目录，返回原配置也不能复用旧目录", async () => {
    fetchMock.mockResolvedValue(reply(["model-a", "model-a", 7, null]));
    await render(); await load();
    expect(container.querySelectorAll("button")).toHaveLength(2);
    await act(async () => (container.querySelectorAll("button")[1] as HTMLButtonElement).click());
    expect(pick).toHaveBeenCalledWith("model-a");
    await render("http://service-a/v1", "test-b");
    expect(container.textContent).not.toContain("model-a");
    await load();
    await render("http://service-b/v1", "test-b");
    expect(container.textContent).not.toContain("model-a");
    await render();
    expect(container.textContent).not.toContain("model-a");
  });

  it("旧目录慢响应在切换配置后被取消，即使迟到也不能覆盖新目录", async () => {
    let finish!: (response: Response) => void;
    let signal!: AbortSignal;
    fetchMock.mockImplementationOnce((_url, options) => { signal = options.signal; return new Promise((resolve) => { finish = resolve; }); });
    await render(); await load();
    await render("http://service-b/v1", "test-b");
    expect(signal.aborted).toBe(true);
    fetchMock.mockResolvedValueOnce(reply(["model-b"]));
    await load();
    await act(async () => finish(reply(["model-a"])));
    expect(container.textContent).toContain("model-b");
    expect(container.textContent).not.toContain("model-a");
  });

  it("错误响应不显示可选模型，重试成功后恢复", async () => {
    fetchMock.mockResolvedValueOnce(reply(["unavailable-model"], 503));
    await render(); await load();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("modelListFailed");
    expect(container.textContent).not.toContain("unavailable-model");
    fetchMock.mockResolvedValueOnce(reply(["available-model"]));
    await load();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("available-model");
  });
});

describe("Fal public catalogue UI", () => {
  const falBase = "https://fal.run/openrouter/router/openai/v1";
  it("loads/selects names, labels the public source, and never changes a model just by loading", async () => {
    fetchMock.mockResolvedValueOnce(reply(["google/gemini-2.5-flash", "anthropic/example"]));
    await render(falBase, "fal-key");
    expect(container.textContent).toContain("modelListPublicButton");
    expect(container.textContent).toContain("modelListPublicNote");
    await load();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("google/gemini-2.5-flash");
    expect(pick).not.toHaveBeenCalled();
    await act(async () => (container.querySelectorAll("button")[1] as HTMLButtonElement).click());
    expect(pick).toHaveBeenCalledWith("google/gemini-2.5-flash");
  });

  it("a catalogue outage is not presented as an invalid Fal key; retry works", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, models: [], source: "openrouter-public", errorCode: "MODEL_LIST_UNAVAILABLE" })));
    await render(falBase, "fal-key"); await load();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("modelListPublicFailed");
    expect(pick).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(reply(["recovered"]));
    await load();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("recovered");
  });

  it.each([["MODEL_LIST_AUTH", "modelListAuthFailed"], ["MODEL_LIST_UNSUPPORTED", "modelListUnsupported"], ["MODEL_LIST_TIMEOUT", "modelListTimedOut"]])("renders %s without exposing upstream error text", async (errorCode, expected) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, models: [], errorCode, error: "sensitive upstream text" })));
    await render(); await load();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(expected);
    expect(container.textContent).not.toContain("sensitive upstream text");
  });

  it("empty success renders the empty state, not a false error", async () => {
    fetchMock.mockResolvedValueOnce(reply([]));
    await render(falBase, "fal-key"); await load();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("modelListEmpty");
  });
});
