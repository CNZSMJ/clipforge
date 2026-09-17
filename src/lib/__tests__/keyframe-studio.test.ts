import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyframeStudio } from "@/components/keyframes/keyframe-studio";
import { compileFrame, defaultFrameWorkspace } from "@/lib/keyframe-direction";
import type { FrameWorkspaceView } from "@/lib/keyframe-types";
import type { Shot } from "@/lib/db/schema";
vi.mock("@/lib/i18n", () => ({ useLocale: () => "en" }));
let root: Root, container: HTMLDivElement, current: FrameWorkspaceView;
const fetchMock = vi.fn(), animate = vi.fn(), changed = vi.fn();
const target = { provider: "fal-ai", model: "openai/gpt-image-2.5/sunburst/edit", apiKey: "test-key" };
const llm = { model: "balanced-text", visionModel: "balanced-vision", baseUrl: "https://example.test/v1", apiKey: "test-llm-key" };
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const calls = () => fetchMock.mock.calls.filter(([, init]) => init?.body).map(([, init]) => JSON.parse(init.body));
const bought = () => calls().filter(b => ["plan", "generate", "check"].includes(b.action));
function button(text: string): HTMLButtonElement { const b = [...container.querySelectorAll("button")].find(b => b.textContent?.includes(text)); expect(b, text).toBeTruthy(); return b!; }
async function click(text: string) { await act(async () => button(text).click()); }
async function render(override = {}) { await act(async () => root.render(createElement(KeyframeStudio, { projectId: "project", target, options: { width: 1024, height: 1024 }, llm, onAnimate: animate, onChanged: changed, ...override }))); }
async function type(label: string, value: string) {
  const field = [...container.querySelectorAll("label")].find(l => l.textContent?.includes(label))?.querySelector("textarea,input");
  expect(field).toBeTruthy();
  await act(async () => { const proto = field!.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value); field!.dispatchEvent(new Event("input", { bubbles: true })); });
}
function addTake(approved = false, stale = false) {
  current.takes = [{ id: "take-1", shotId: 1, url: "/api/files/project/one.png", selected: approved, status: "done", sourceKey: stale ? "old" : "shot-one", renderId: "render-1" }];
  if (approved) current.workspace.approvals = [{ shotId: 1, assetId: "take-1", sourceKey: "shot-one" }];
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset(); animate.mockReset().mockResolvedValue(undefined); changed.mockReset().mockResolvedValue(undefined);
  const shots: Shot[] = [1, 2].map(shotId => ({ shotId, description: `Coffee step ${shotId}`, duration: 4, type: "demo", camera: "fixed", voiceover: "", visualSource: "ai_generate", transition: "direct_concat" }));
  const context = { contentType: "product", videoMode: "scene_demo", productName: "Coffee machine" };
  const workspace = defaultFrameWorkspace(shots, context); workspace.specs.forEach(s => { s.moment = "An empty cup rests beneath the outlet"; });
  current = { revision: 1, sourceKey: "plan-one", shotKeys: { 1: "shot-one", 2: "shot-two" }, scriptId: "script", shots, context, workspace, takes: [], pending: [] };
  fetchMock.mockImplementation(async (_url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (init?.method === "GET") return reply(current);
    if (body.action === "preview") return reply({ compilation: compileFrame({ shot: current.shots.find(s => s.shotId === body.shotId)!, shots, context, workspace: current.workspace }), options: { modelId: target.model }, planKey: "confirmed-plan", sourceKey: current.sourceKey });
    if (body.action === "generate") { addTake(); return reply({ asset: { id: "take-1" }, renderId: "render-1" }); }
    if (body.action === "plan") return reply({ workspace: current.workspace, revision: current.revision, sourceKey: current.sourceKey });
    if (body.action === "save") { current.workspace = body.workspace; current.revision++; return reply(current); }
    if (body.action === "approve") { addTake(true); current.revision++; return reply(current); }
    if (body.action === "resume") { addTake(); current.pending = []; return reply({ asset: { id: "take-1" } }); }
    return reply({});
  });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("keyframe product UX and billing boundaries", () => {
  it("names the reference selector independently from its option labels", async () => {
    await render();
    const role = container.querySelector<HTMLSelectElement>('select[aria-label="Reference role"]');
    expect(role).toBeTruthy();
    expect([...role!.options].map(option => option.value)).toEqual(["product", "character", "scene", "style", "layout"]);
    await act(async () => { role!.value = "layout"; role!.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(role!.value).toBe("layout");
    expect(bought()).toEqual([]);
  });
  it("starts with a read-only workspace, clear steps and no automatic paid call", async () => {
    await render(); expect(container.textContent).toContain("Approve the frame before buying video"); expect(bought()).toEqual([]); expect(animate).not.toHaveBeenCalled();
  });
  it("free preview shows actual model, one-image cost boundary and focusable confirmation; cancel is free", async () => {
    await render(); await click("Preview this frame"); expect(container.textContent).toContain("No automatic checks, retries or video");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Confirm operation"); expect(bought()).toEqual([]);
    await click("Cancel"); expect(container.querySelector('[aria-label="Confirm operation"]')).toBeNull(); expect(bought()).toEqual([]);
  });
  it("one explicit confirmation buys one candidate, no auto-approval, vision check or video", async () => {
    await render(); await click("Preview this frame"); await click("Confirm charge & run");
    expect(bought()).toHaveLength(1); expect(bought()[0]).toMatchObject({ action: "generate", confirmPaid: true, expectedPlanKey: "confirmed-plan" });
    expect(container.textContent).toContain("Candidate saved, not sent to video"); expect(animate).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  });
  it("retains a single pending submission under double click and prevents switching shots during submission", async () => {
    let finish!: () => void;
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => {
      if (init?.body && JSON.parse(init.body).action === "generate") return new Promise<Response>(resolve => { finish = () => { addTake(); resolve(reply({ asset: { id: "take-1" } })); }; });
      return base(url, init);
    });
    await render(); await click("Preview this frame");
    await act(async () => { const b = button("Confirm charge & run"); b.click(); b.click(); });
    expect(bought()).toHaveLength(1); expect(container.querySelector<HTMLButtonElement>('nav button')!.disabled).toBe(true);
    await act(async () => finish()); expect(bought()).toHaveLength(1);
  });
  it("changed global style blocks generation until save, and free save persists without a paid call", async () => {
    await render(); await click("Minimal 3D"); expect(button("Preview this frame").disabled).toBe(true);
    expect(button("Prepare shot plan").disabled).toBe(true); await click("Save direction (free)");
    expect(calls().find(b => b.action === "save")?.workspace.style.medium).toBe("3d"); expect(bought()).toEqual([]);
  });
  it("changed model clears a cost confirmation instead of submitting a different model under old consent", async () => {
    await render(); await click("Preview this frame"); await render({ target: { ...target, model: "changed-model" } });
    expect(container.querySelector('[aria-label="Confirm operation"]')).toBeNull(); expect(bought()).toEqual([]);
  });
  it("a missing concrete still moment cannot be paid for", async () => {
    current.workspace.specs[0].moment = ""; await render(); await click("Preview this frame");
    expect(button("Confirm charge & run").disabled).toBe(true); expect(container.textContent).toContain("Unspecified frames cannot be purchased"); expect(bought()).toEqual([]);
  });
  it("a textual correction binds the actual selected take rather than drawing an unreferenced image", async () => {
    addTake(); await render(); await type("What needs fixing?", "Turn the torso toward the machine; keep the clothes."); await click("Preview retake"); await click("Confirm charge & run");
    expect(bought()[0]).toMatchObject({ editAssetId: "take-1", correction: "Turn the torso toward the machine; keep the clothes." });
  });
  it("approval is free and animation remains a separate explicit action", async () => {
    addTake(); await render(); await click("Approve frame (free)"); expect(bought()).toEqual([]); expect(animate).not.toHaveBeenCalled();
    await click("Animate this shot (paid)"); expect(animate).toHaveBeenCalledWith(1, "/api/files/project/one.png");
  });
  it("stale takes require a visible human recheck and do not silently adopt a former scene", async () => {
    addTake(false, true); await render(); expect(button("Approve frame (free)").disabled).toBe(true);
    const check = [...container.querySelectorAll("label")].find(l => l.textContent?.includes("personally reviewed"))!.querySelector<HTMLInputElement>("input")!;
    await act(async () => check.click()); await click("Approve frame (free)"); expect(calls().find(b => b.action === "approve")?.acceptRisk).toBe(true);
  });
  it("planning returns an unsaved editable draft, not an automatic image pipeline", async () => {
    await render(); await click("Prepare shot plan"); expect(bought()).toEqual([]); await click("Confirm charge & run");
    expect(bought().map(b => b.action)).toEqual(["plan"]); expect(container.textContent).toContain("Draft prepared"); expect(button("Preview this frame").disabled).toBe(true);
  });
  it("an unfinished provider task blocks a new purchase and offers no-cost recovery", async () => {
    current.pending.push({ id: "pending-1", shotId: 1, status: "unknown", taskId: "existing", provider: "fal-ai", model: target.model, error: "poll timeout" });
    await render(); expect(button("Preview this frame").disabled).toBe(true); await click("Recover result"); expect(bought()).toEqual([]); expect(calls()[0]).toMatchObject({ action: "resume", renderId: "pending-1" });
  });
});
