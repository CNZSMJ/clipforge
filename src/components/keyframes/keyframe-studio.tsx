"use client";
/* eslint-disable @next/next/no-img-element -- Local, user-selected project assets must remain unproxied and available offline. */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/lib/i18n";
import { FRAME_MEDIA, REFERENCE_ROLES, type FrameWorkspace, type FrameReferenceRole, type FrameSpec } from "@/lib/keyframe-direction";
import type { FrameWorkspaceView } from "@/lib/keyframe-types";
import type { LLMConfig } from "@/lib/script-engine/generator";
import type { FrameCompilation } from "@/lib/keyframe-direction";

interface Target { provider: string; model: string; apiKey: string; baseUrl?: string }
interface Preview { compilation: FrameCompilation; planKey: string; options: { modelId: string }; sourceKey: string }
interface Props { onReviewState?: (state: { enabled: boolean; complete: boolean }) => void; projectId: string; target: Target | null; options: Record<string, unknown>; llm: LLMConfig; onChanged: () => Promise<void>; onAnimate: (shotId: number, url: string) => Promise<void> }
const field = "w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";
const thumb = "h-24 w-full rounded-md object-contain bg-muted/30";
export function KeyframeStudio({ projectId, target, options, llm, onChanged, onAnimate, onReviewState }: Props) {
  const locale = useLocale(), en = locale === "en";
  const tr = (zh: string, english: string) => en ? english : zh;
  const [view, setView] = useState<FrameWorkspaceView | null>(null);
  const [draft, setDraft] = useState<FrameWorkspace | null>(null);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [shotId, setShotId] = useState<number | null>(null), [takeId, setTakeId] = useState("");
  const [correction, setCorrection] = useState(""), [preview, setPreview] = useState<Preview | null>(null);
  const [confirm, setConfirm] = useState<"generate" | "plan" | "check" | "batch" | null>(null);
  const [riskAccepted, setRiskAccepted] = useState(false), [syntheticAccepted, setSyntheticAccepted] = useState(false);
  const [role, setRole] = useState<FrameReferenceRole>("style"), [identity, setIdentity] = useState("");
  const [reconcileId, setReconcileId] = useState("");
  const [reconcileChecked, setReconcileChecked] = useState(false);
  const [batchLimit, setBatchLimit] = useState(6);
  const [busyShot, setBusyShot] = useState<number | null>(null);
  const stop = useRef(false), busyRef = useRef(false), confirmRef = useRef<HTMLDivElement>(null);
  const optionsKey = JSON.stringify(options);
  const endpoint = `/api/project/${encodeURIComponent(projectId)}/keyframes`;
  const api = useCallback(async (method = "GET", body?: unknown) => {
    const res = await fetch(endpoint, { method, headers: { "Content-Type": "application/json", "Accept-Language": locale }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }, [endpoint, locale]);
  const refresh = useCallback(async () => {
    const next = await api() as FrameWorkspaceView;
    setView(next); setDraft(next.workspace); setDirty(false);
    setShotId(prev => next.shots.some(s => s.shotId === prev) ? prev : next.shots[0]?.shotId ?? null);
    return next;
  }, [api]);
  useEffect(() => { let active = true; api().then((data: FrameWorkspaceView) => {
    if (!active) return; setView(data); setDraft(data.workspace); setShotId(data.shots[0]?.shotId ?? null); setDirty(false);
  }).catch(e => { if (active) setError(String(e.message)); }); return () => { active = false; }; }, [api]);
  useEffect(() => {
    const select = (event: Event) => { if (busyRef.current) return; const id = (event as CustomEvent<{ shotId?: number }>).detail?.shotId; if (Number.isSafeInteger(id)) setShotId(id!); document.getElementById("keyframe-studio")?.scrollIntoView({ behavior: "smooth", block: "start" }); };
    window.addEventListener("clipforge:keyframe-select", select);
    return () => window.removeEventListener("clipforge:keyframe-select", select);
  }, []);
  useEffect(() => { setPreview(null); setConfirm(null); setRiskAccepted(false); setSyntheticAccepted(false); setCorrection(""); setTakeId(""); }, [shotId]);
  useEffect(() => { setPreview(null); setConfirm(null); }, [target?.model, target?.provider, target?.baseUrl, optionsKey]);
  useEffect(() => { if (confirm) confirmRef.current?.focus(); }, [confirm]);
  useEffect(() => {
    if (!view) return;
    onReviewState?.({ enabled: view.revision > 0, complete: view.shots.every(shot =>
      (shot.visualSource !== "ai_generate" && !view.takes.some(t => t.shotId === shot.shotId && t.renderId)) ||
      view.workspace.approvals.some(a => a.shotId === shot.shotId && a.sourceKey === view.shotKeys[shot.shotId])) });
  }, [view, onReviewState]);
  const run = async (name: string, action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(name); setError(""); setNotice("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { busyRef.current = false; setBusy(null); setBusyShot(null); }
  };
  const change = (next: FrameWorkspace) => { setDraft(next); setDirty(true); setPreview(null); setConfirm(null); };
  const save = async () => {
    if (!view || !draft) return;
    const saved = await api("PATCH", { action: "save", revision: view.revision, sourceKey: view.sourceKey, workspace: draft }) as FrameWorkspaceView;
    setView(saved); setDraft(saved.workspace); setDirty(false); setPreview(null);
    setNotice(tr("已保存。设定改变后旧图需重新确认；不会删除或自动重生。", "Saved. Changed direction requires rechecking old frames; nothing is deleted or regenerated."));
  };
  const shot = view?.shots.find(s => s.shotId === shotId), spec = draft?.specs.find(s => s.shotId === shotId);
  const takes = view?.takes.filter(t => t.shotId === shotId) ?? [];
  const take = takes.find(t => t.id === takeId) ?? takes[0];
  const approved = !!take && view?.workspace.approvals.some(a => a.assetId === take.id && a.sourceKey === view.shotKeys[a.shotId]);
  const stale = !!take?.sourceKey && take.sourceKey !== view?.shotKeys[take.shotId] && !approved;
  const cast = [...(view?.context.characters ?? []).map(c => ({ id: c.id, name: c.name })),
    ...(view?.context.characterId && !view.context.characters?.some(c => c.id === view.context.characterId) ? [{ id: view.context.characterId, name: tr("项目出镜人物", "Project presenter") }] : []),
    ...(draft?.references.filter(r => r.role === "character" && r.characterId && !view?.context.characters?.some(c => c.id === r.characterId)).map(r => ({ id: r.characterId!, name: r.label })) ?? [])]
    .filter((c, i, all) => all.findIndex(x => x.id === c.id) === i);
  const roleLabel = (r: string) => { const i = REFERENCE_ROLES.indexOf(r as FrameReferenceRole); return i < 0 ? tr("待修正图", "Edit target") : tr(["商品", "人物", "场景", "画风", "构图"][i], ["Product", "Identity", "Scene", "Style", "Layout"][i]); };
  const editSpec = (patch: Partial<FrameSpec>) => { if (draft) change({ ...draft, specs: draft.specs.map(s => s.shotId === shotId ? { ...s, ...patch } : s) }); };
  const generateInput = (id: number, edit = false) => ({ shotId: id, provider: target?.provider, model: target?.model, baseUrl: target?.baseUrl || "", options,
    ...(edit && take && correction.trim() && { editAssetId: take.id, correction: correction.trim() }) });
  const prepare = () => run("preview", async () => {
    if (!target || !shot) return;
    setPreview(await api("POST", { action: "preview", ...generateInput(shot.shotId, true) })); setConfirm("generate");
  });
  const pending = view?.pending.filter(p => p.shotId === shotId) ?? [];
  const batchShots = view?.shots.filter(s => s.visualSource === "ai_generate" && !view.takes.some(t => t.shotId === s.shotId) && !view.pending.some(p => p.shotId === s.shotId)).slice(0, batchLimit) ?? [];
  const batchAnchored = batchShots.length > 0 && batchShots.every(s => draft?.references.some(r => r.role === "scene" && r.sceneId === draft.specs.find(x => x.shotId === s.shotId)?.sceneId));
  async function submitConfirmed() {
    const action = confirm; setConfirm(null);
    await run(action || "generate", async () => {
      if (!view) return;
      if (action === "plan") {
        const result = await api("POST", { action: "plan", sourceKey: view.sourceKey, llmConfig: llm, confirmPaid: true });
        setDraft(result.workspace); setDirty(true); setPreview(null);
        setNotice(tr("方案草稿已整理。检查场景分组和操作关系，保存后才会用于生图。", "Draft prepared. Review scene grouping and physical staging, then save to use it."));
      } else if (action === "check" && take?.renderId) {
        await api("POST", { action: "check", renderId: take.renderId, llmConfig: llm, confirmPaid: true }); await refresh();
      } else if (action === "generate" && shot && target && preview) {
        try {
          const result = await api("POST", { action: "generate", ...generateInput(shot.shotId, true), expectedPlanKey: preview.planKey, apiKey: target.apiKey,
            requestId: crypto.randomUUID(), confirmPaid: true, allowSynthetic: syntheticAccepted });
          await refresh(); setTakeId(result.asset?.id ?? ""); setPreview(null); setCorrection("");
          setNotice(tr("候选图已保存，尚未用于视频。请检查后确认，或描述要修正的问题。", "Candidate saved, not sent to video. Review and approve it, or describe a specific correction."));
        } catch (e) { await refresh(); throw e; }
      } else if (action === "batch" && target) {
        stop.current = false;
        let completed = 0;
        for (const s of batchShots) {
          if (stop.current) break;
          setBusyShot(s.shotId);
          const input = generateInput(s.shotId);
          const p = await api("POST", { action: "preview", ...input });
          if (p.sourceKey !== view.sourceKey) throw new Error(tr("设定在批量生成中发生变化，已停止后续提交。", "Direction changed during the batch; later submissions stopped."));
          try { await api("POST", { action: "generate", ...input, expectedPlanKey: p.planKey, apiKey: target.apiKey, requestId: crypto.randomUUID(), confirmPaid: true }); }
          catch (e) { await refresh(); throw e; }
          completed++; await refresh();
        }
        setNotice(tr(`已生成 ${completed} 张待审图，未自动确认或生成视频。`, `${completed} review candidates saved. No auto-approval or video generation.`));
      }
    });
  }
  const uploadReference = async (file: File) => {
    if (!view || !draft || !spec) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > 20 * 1024 * 1024) throw new Error(tr("请选择20MB以内的PNG/JPEG/WebP图片", "Choose a PNG/JPEG/WebP up to 20 MB"));
    const characterId = identity || cast[0]?.id || `person-${crypto.randomUUID()}`;
    const form = new FormData(); form.append("files", file); form.append("projectId", projectId);
    const res = await fetch("/api/upload", { method: "POST", body: form }); const data = await res.json();
    if (!res.ok || !data.paths?.[0]) throw new Error(data.error || tr("上传失败", "Upload failed"));
    change({ ...draft, references: [...draft.references, { id: crypto.randomUUID(), role, label: file.name, url: data.paths[0],
      ...(role === "scene" && { sceneId: spec.sceneId }), ...(role === "layout" && { shotId: spec.shotId }), ...(role === "character" && { characterId }) }] });
    setNotice(tr("参考图已上传；保存设定后使用。姿态/构图图只控制空间关系，不会作为画风。", "Reference uploaded; save to use it. Layout/pose guides control structure, not rendering style."));
  };
  return <section id="keyframe-studio" aria-label={tr("画面工作台", "Keyframe workspace")} className="mb-8 min-w-0 scroll-mt-6 rounded-2xl border border-primary/25 bg-card p-4 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-lg font-semibold">{tr("先把画面做对，再生成视频", "Approve the frame before buying video")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{tr("1 统一设定 → 2 确认场景样片 → 3 逐镜检查 → 4 生成视频", "1 Set direction → 2 Approve a scene sample → 3 Review shots → 4 Animate")}</p></div>
      <Button size="sm" variant="outline" disabled={!!busy || dirty} onClick={() => void run("refresh", async () => { await refresh(); })}>{tr("刷新", "Refresh")}</Button>
    </header>
    {error && <p role="alert" className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm break-words">{error}</p>}
    {notice && <p role="status" className="mt-3 rounded-lg bg-primary/5 p-3 text-sm">{notice}</p>}
    {busy && <p role="status" aria-live="polite" className="mt-3 text-sm">{tr("处理中", "Working")}{busyShot != null ? ` · ${tr("镜头", "Shot")} ${busyShot}` : ""} · {tr("不会自动重复提交。关闭页面后可回来恢复生图任务。", "No automatic resubmission. Image tasks can be recovered after returning.")}</p>}
    {!view || !draft || !shot || !spec ? <p className="py-6 text-sm text-muted-foreground">{error ? tr("确认脚本后刷新重试。", "Select a script and refresh.") : tr("正在读取分镜与参考…", "Loading storyboard and references…")}</p> : <>
      <div className="my-4 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full bg-muted px-3 py-1">{tr("已确认", "Approved")} {view.workspace.approvals.filter(a => a.sourceKey === view.shotKeys[a.shotId]).length}/{view.shots.length}</span>
        <span>{tr("生图每次1张；整理方案/智能检查另行确认。价格以供应商账单为准。", "One image per click. Planning and visual checks require separate confirmation. Provider billing applies.")}</span>
      </div>
      <details className="rounded-xl border border-border p-3" open={dirty || view.revision === 0 || undefined}>
        <summary className="cursor-pointer font-medium text-sm">{tr("全片画面设定与参考图", "Project direction & references")}</summary>
        <div className="mt-3 flex flex-wrap gap-2" aria-label={tr("画风快捷设定", "Style shortcuts")}>
          {([
            ["自然生活", "Natural lifestyle", "photography", "自然中性色，低饱和", "柔和窗光，主光固定在场景一侧", "真实生活材质，保留自然细节"],
            ["产品棚拍", "Product studio", "photography", "中性底色，商品原色准确", "柔和主光与克制轮廓光，清楚的接触阴影", "忠于商品原有材质，不增加金属或玻璃质感"],
            ["极简三维", "Minimal 3D", "3d", "白为主、灰为辅、少量红色强调", "柔和展陈布光，低对比", "哑光白模型、高透亚克力与克制铝材，非写实重工业"],
            ["平面插画", "Illustration", "illustration", "统一的有限色板", "统一的简化明暗，不混入摄影光效", "一致线宽、几何形状和着色方法"],
          ] as const).map(([zh, eng, medium, palette, lighting, texture]) => <Button key={medium + zh} size="sm" variant="outline" disabled={!!busy} onClick={() => change({ ...draft, style: { medium, palette, lighting, texture } })}>{tr(zh, eng)}</Button>)}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs">{tr("视觉媒介（不会被单镜风格词覆盖）", "Medium (wins over legacy shot style)")}<select className={field} value={draft.style.medium} disabled={!!busy} onChange={e => change({ ...draft, style: { ...draft.style, medium: e.target.value as FrameWorkspace['style']['medium'] } })}>
            {FRAME_MEDIA.map((m, i) => <option key={m} value={m}>{en ? ['Inherit approved project style', 'Photography', '3D / exhibition models', 'Illustration', 'Animation / anime', 'Stop motion'][i] : ['沿用项目已定风格', '写实摄影', '三维动画 / 展陈模型', '插画', '动画 / 动漫', '定格 / 微缩模型'][i]}</option>)}
          </select></label>
          {(['palette', 'lighting', 'texture'] as const).map((key, i) => <label className="text-xs" key={key}>{tr(['色板', '全局光线', '材质与画风'][i], ['Palette', 'Default lighting', 'Materials & treatment'][i])}<input className={field} value={draft.style[key]} maxLength={key === 'texture' ? 600 : 400} disabled={!!busy} placeholder={tr(['如白为主、灰为辅、红色强调', '如左侧柔和窗光，低对比', '如高透亚克力、哑光白模型；不要写实工业风'][i], ['e.g. white dominant, grey support, red accents', 'e.g. soft window light from left', 'e.g. translucent acrylic and matte white models'][i])} onChange={e => change({ ...draft, style: { ...draft.style, [key]: e.target.value } })}/></label>)}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs">{tr("上传参考的用途", "Reference role")}<select className={field} aria-label={tr("上传参考的用途", "Reference role")} value={role} disabled={!!busy} onChange={e => setRole(e.target.value as FrameReferenceRole)}>{REFERENCE_ROLES.map((r, i) => <option key={r} value={r}>{tr(['商品外观', '人物身份', '当前镜所属场景', '全片画风', '当前镜姿态 / 构图草图'][i], ['Product', 'Identity', 'Current scene', 'Global style', 'Current shot pose / sketch'][i])}</option>)}</select></label>
          <label className="text-xs">{role === 'character' ? tr("这是谁的定妆图？", "Whose identity reference?") : tr("PNG / JPEG / WebP，最大20MB", "PNG / JPEG / WebP, up to 20 MB")}
            {role === 'character' && <select className={field} value={identity || cast[0]?.id || ''} disabled={!!busy} onChange={e => setIdentity(e.target.value)}>{cast.length ? cast.map(c => <option key={c.id} value={c.id}>{c.name}</option>) : <option value="">{tr("添加人物，随后勾选其出镜镜头", "Add a person, then select their visible shots")}</option>}</select>}
            <input type="file" accept="image/png,image/jpeg,image/webp" disabled={!!busy} className="block w-full min-w-0 py-2 text-xs" aria-label={tr("上传参考图", "Upload reference image")} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void run('upload', () => uploadReference(f)); }}/>
          </label>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{tr("商品原图会按镜头是否展示商品自动加入。人物参考只绑定实际出镜身份；场景参考只用于对应场景；构图草图可标注站位、手部与注视方向。", "Original product photos follow product visibility. Identity references bind visible cast, scene references bind a scene, and sketches can specify pose, hands and gaze.")}</p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">{draft.references.map(r => <div key={r.id} className="min-w-0 rounded-lg border p-2">
          <img src={r.url} alt={`${r.role}: ${r.label}`} className={thumb}/><p className="mt-1 truncate text-xs" title={r.label}>{roleLabel(r.role)} · {r.label}</p><p className="truncate text-xs text-muted-foreground">{r.sceneId || r.characterId || (r.shotId != null ? `Shot ${r.shotId}` : tr('全片', 'Global'))}</p>
          <button className="mt-1 text-xs underline" disabled={!!busy} onClick={() => change({ ...draft, references: draft.references.filter(x => x.id !== r.id) })}>{tr('移除参考', 'Remove reference')}</button>
        </div>)}</div>
      </details>
      <div className="sticky top-2 z-10 mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-card/95 p-2 shadow-sm">
        <Button size="sm" variant="outline" disabled={!!busy || dirty || !llm.apiKey || !llm.model} onClick={() => setConfirm('plan')}>{tr('整理全片画面方案（1次文本调用）', 'Prepare shot plan (1 text call)')}</Button>
        {dirty && <><span role="status" className="text-xs text-amber-700 dark:text-amber-400">{tr('有未保存设定，保存后才能生成。', 'Unsaved direction; save before generating.')}</span><Button size="sm" disabled={!!busy} onClick={() => void run('save', save)}>{tr('保存设定（免费）', 'Save direction (free)')}</Button><Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { setDraft(view.workspace); setDirty(false); }}>{tr('撤销未保存修改', 'Discard unsaved changes')}</Button></>}
      </div>
      {!llm.apiKey && <p className="mt-2 text-xs text-muted-foreground">{tr("未配置文本模型，可先手动填写下方画面时刻，或", "No text model configured. Enter the still moment below manually, or ")} <Link href="/settings" className="underline">{tr("前往设置", "open settings")}</Link></p>}
      <nav aria-label={tr('选择分镜', 'Choose a shot')} className="my-4 flex gap-2 overflow-x-auto pb-2">{view.shots.map(s => {
        const latest = view.takes.find(t => t.shotId === s.shotId); const accepted = view.workspace.approvals.some(a => a.shotId === s.shotId && a.sourceKey === view.shotKeys[a.shotId]);
        return <button key={s.shotId} disabled={!!busy} aria-pressed={shotId === s.shotId} className={`w-24 shrink-0 rounded-lg border p-2 text-left text-xs focus-visible:ring-2 focus-visible:ring-primary ${shotId === s.shotId ? 'border-primary bg-primary/5' : 'border-border'}`} onClick={() => setShotId(s.shotId)}>
          {latest ? <><img src={latest.url} alt={tr(`镜头${s.shotId}`, `Shot ${s.shotId}`)} className="mb-1 h-16 w-full object-contain"/></> : <div className="mb-1 flex h-16 items-center justify-center bg-muted/30">{s.shotId}</div>}
          {tr('镜头', 'Shot')} {s.shotId}<span className="block text-muted-foreground">{accepted ? tr('已确认', 'Approved') : latest ? tr('待检查', 'Review') : tr('未生成', 'Not generated')}</span>
        </button>;
      })}</nav>
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{tr('镜头', 'Shot')} {shot.shotId} · {shot.duration}s</h3><p className="my-2 text-sm leading-relaxed">{shot.description}</p>
          <label className="text-xs">{tr('所属场景（同场景共用参考与布局）', 'Scene (shared layout and reference)')}<select className={field} disabled={!!busy} value={spec.sceneId} onChange={e => editSpec({ sceneId: e.target.value })}>{draft.scenes.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <details className="mt-3 rounded-lg border p-3"><summary className="cursor-pointer text-sm">{tr('画面时刻、空间与操作细节', 'Frame moment, layout & physical staging')}</summary>
            {(['moment', 'framing', 'blocking', 'gaze', 'hands', 'contacts', 'state'] as const).map((key, i) => <label key={key} className="mt-3 block text-xs">{tr(['单帧时刻', '景别与初始机位', '身体 / 物件朝向', '注视目标（无人可留空）', '左右手分工（无人可留空）', '接触与支撑关系', '当前状态 / 连续性'][i], ['Exact still moment', 'Framing', 'Body / object orientation', 'Gaze target', 'Actor-left/right hand duties', 'Contact / support', 'Current state / continuity'][i])}<textarea className={field} rows={2} value={spec[key]} maxLength={key === 'moment' ? 1400 : 800} disabled={!!busy} onChange={e => editSpec({ [key]: e.target.value })}/></label>)}
            <label className="mt-3 flex items-center gap-2 text-xs"><input type="checkbox" checked={spec.productVisible} disabled={!!busy} onChange={e => editSpec({ productVisible: e.target.checked })}/>{tr('本镜出现商品（加入商品参考）', 'Product visible (attach product reference)')}</label>
            <fieldset className="mt-3"><legend className="text-xs">{tr("本镜实际出镜的人物（不勾选画外配音）", "People visible in this frame (not voiceover)")}</legend>{cast.map(c => <label className="mr-3 mt-2 inline-flex gap-2 text-xs" key={c.id}><input type="checkbox" checked={spec.characterIds.includes(c.id)} disabled={!!busy} onChange={e => editSpec({ characterIds: e.target.checked ? [...spec.characterIds, c.id] : spec.characterIds.filter(id => id !== c.id) })}/>{c.name}</label>)}{!cast.length && <p className="mt-1 text-xs text-muted-foreground">{tr("上传人物参考后可指定出镜镜头。无人模式不会增加人物。", "Upload an identity reference to bind visible shots. People-free modes stay people-free.")}</p>}</fieldset>
            <label className="mt-3 block text-xs">{tr('本场景固定布局（世界坐标，不是每镜左右）', 'Scene layout (world positions, not changing screen sides)')}<textarea className={field} rows={2} maxLength={1200} value={draft.scenes.find(s => s.id === spec.sceneId)?.layout || ''} disabled={!!busy} onChange={e => change({ ...draft, scenes: draft.scenes.map(s => s.id === spec.sceneId ? { ...s, layout: e.target.value } : s) })}/></label>
          </details>
          {!spec.moment.trim() && <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">{tr("先点击“整理全片画面方案”，或展开画面细节填写一个单帧时刻；未细化时不会扣费生图。", "Prepare the shot plan, or specify one still moment in the details. Unspecified frames cannot be purchased.")}</p>}
          <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" disabled={!!busy || dirty || !target || pending.length > 0} onClick={() => void prepare()}>{take ? tr('预览重做 / 修正方案', 'Preview retake / correction') : tr('预览本镜生图方案', 'Preview this frame')}</Button>
            {!target && <Link href="/settings?tab=image" className="text-xs underline">{tr('先配置 Fal 生图模型', 'Configure a Fal image model')}</Link>}
          </div>
          {take && <label className="mt-3 block text-xs">{tr('只修哪里？留空表示重新生成；填写后以当前候选图为编辑底图。', 'What needs fixing? Empty = new take; text = edit the current candidate.')}<textarea className={field} rows={3} value={correction} maxLength={1200} disabled={!!busy || dirty} placeholder={tr('例如：身体和视线朝咖啡机，杯子在出液口下由托盘支撑；保持脸、衣服和背景不变。', 'e.g. Face the coffee machine, look at the outlet, rest the cup on the drip tray. Preserve identity, outfit and background.')} onChange={e => { setCorrection(e.target.value); setPreview(null); setConfirm(null); }}/></label>}
          {pending.map(p => <div key={p.id} className="mt-3 rounded-lg border border-amber-500/30 p-3 text-xs"><p>{tr('已有待恢复任务，不会再次提交', 'Existing task; no new generation')} · {p.status}</p><p className="break-all text-muted-foreground">{p.id}</p><Button size="sm" variant="outline" className="mt-2" disabled={!!busy || !target?.apiKey || !p.taskId} onClick={() => void run('resume', async () => { try { const result = await api('POST', { action: 'resume', renderId: p.id, apiKey: target?.apiKey }); setTakeId(result.asset?.id || ''); } finally { await refresh(); } })}>{tr('恢复已有结果', 'Recover result')}</Button>{!p.taskId && <details className="mt-2"><summary className="cursor-pointer">{tr("回执丢失：核对 Fal 后处理", "Lost acknowledgement: reconcile in Fal")}</summary><p className="mt-2">{tr("按模型、提示词和提交时间核对控制台历史。有记录请绑定 request_id；只有确认未受理，才解除阻塞。不是再买一次。", "Match model, prompt and time in provider history. Attach its request_id; release only when confirmed not accepted. This does not buy another image.")}</p><label className="mt-2 block">Fal request_id<input className={field} value={reconcileId} disabled={!!busy} onChange={e => setReconcileId(e.target.value)}/></label><label className="mt-2 flex gap-2"><input type="checkbox" checked={reconcileChecked} disabled={!!busy} onChange={e => setReconcileChecked(e.target.checked)}/>{tr("我已核对供应商历史并确认上述对应关系", "I checked provider history and verified the match")}</label><div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!!busy || !reconcileChecked || !reconcileId.trim()} onClick={() => void run('reconcile', async () => { await api('POST', { action: 'reconcile', renderId: p.id, requestId: reconcileId.trim(), apiKey: target?.apiKey, confirmReconciled: true }); setReconcileId(''); setReconcileChecked(false); await refresh(); })}>{tr("绑定已有云任务（不重提）", "Attach existing task")}</Button><Button size="sm" variant="outline" disabled={!!busy || !reconcileChecked || !!reconcileId.trim()} onClick={() => void run('reconcile', async () => { await api('POST', { action: 'reconcile', renderId: p.id, notAccepted: true, confirmReconciled: true }); setReconcileChecked(false); await refresh(); })}>{tr("确认未受理，解除阻塞", "Confirmed not accepted: release")}</Button></div></details>}</div>)}
        </div>
        <div className="min-w-0">
          {take ? <><label className="text-xs">{tr('候选历史（不删除旧图）', 'Candidate history (old takes preserved)')}<select className={field} value={take.id} disabled={!!busy} onChange={e => { setTakeId(e.target.value); setPreview(null); setConfirm(null); setRiskAccepted(false); }}>
            {takes.map((t, i) => <option value={t.id} key={t.id}>{tr('候选', 'Take')} {takes.length - i}{t.selected ? tr(' · 当前选中', ' · Selected') : ''}</option>)}
          </select></label>
            <a href={take.url} target="_blank" rel="noreferrer" aria-label={tr('打开大图检查', 'Open full-size image')}>
              <img src={take.url} alt={tr(`镜头${shot.shotId}候选画面`, `Candidate for shot ${shot.shotId}`)} className="mt-3 max-h-[480px] w-full rounded-xl bg-muted/20 object-contain"/>
            </a>
            <p className="mt-2 text-xs text-muted-foreground">{tr('检查：主体是否相同 · 画风是否一致 · 手/朝向/接触是否合理 · 是否为正确动作时刻。', 'Check identity, medium, hands/orientation/contact, and the exact action moment.')}</p>
            {take.review && <div className="mt-3 rounded-lg border p-3 text-xs"><strong>{tr('智能检查（辅助，不是保证）', 'AI check (advisory)')} · {take.review.verdict}</strong><p>{take.review.summary}</p>{take.review.issues.map((issue, i) => <p key={i} className="mt-2">{issue.severity}: {issue.summary} — {issue.suggestedFix}</p>)}</div>}
            {(stale || take.review?.verdict === 'reject') && <label className="mt-3 flex items-start gap-2 text-xs"><input type="checkbox" checked={riskAccepted} disabled={!!busy} onChange={e => setRiskAccepted(e.target.checked)}/>{tr('此图对应旧设定或检查发现问题。我已人工复核，仍接受该图。', 'This take is stale or has failed checks. I have personally reviewed and accept it.')}</label>}
            <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" disabled={!!busy || dirty || approved || ((stale || take.review?.verdict === 'reject') && !riskAccepted)} onClick={() => void run('approve', async () => { const next = await api('PATCH', { action: 'approve', assetId: take.id, sourceKey: view.sourceKey, revision: view.revision, acceptRisk: riskAccepted }); setView(next); setDraft(next.workspace); await onChanged(); })}>{approved ? tr('已确认用于视频', 'Approved for video') : tr('确认这张（免费）', 'Approve frame (free)')}</Button>
              <Button size="sm" variant="outline" disabled={!!busy || dirty || ((stale || take.review?.verdict === 'reject') && !riskAccepted)} onClick={() => void run('pin', async () => { const next = await api('PATCH', { action: 'approve', assetId: take.id, sourceKey: view.sourceKey, revision: view.revision, pinScene: true, acceptRisk: riskAccepted }); setView(next); setDraft(next.workspace); setPreview(null); await onChanged(); setNotice(tr('已设为本场景参考。其他旧图需复核；仅同场景后续生图使用它。', 'Scene sample pinned. Recheck older frames; only this scene will use it.')); })}>{tr('确认并设为场景样片', 'Approve & pin scene sample')}</Button>
              {take.renderId && !take.review && <Button size="sm" variant="outline" disabled={!!busy || dirty || stale || !llm.apiKey} onClick={() => setConfirm('check')}>{tr('智能检查（1次视觉调用）', 'Visual check (1 vision call)')}</Button>}
              {approved && <Button size="sm" variant="outline" disabled={!!busy || dirty} onClick={() => void run('animate', () => onAnimate(shot.shotId, take.url))}>{tr('生成本镜视频（收费）', 'Animate this shot (paid)')}</Button>}
            </div>
          </> : <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed p-6 text-center"><p className="font-medium">{tr('先做一张代表画面', 'Start with one representative frame')}</p><p className="mt-2 text-sm text-muted-foreground">{tr('不满意就定向修正。确认后设为场景样片，其他同场景镜头才沿用它。', 'Correct specific issues, approve the sample, then reuse it for other shots in the same scene.')}</p></div>}
        </div>
      </div>
      {confirm && <div ref={confirmRef} tabIndex={-1} className="mt-5 rounded-xl border-2 border-primary/35 bg-primary/5 p-4 focus:outline-none" aria-label={tr('确认本次操作', 'Confirm operation')}>
        <h3 className="text-sm font-semibold">{tr('确认本次调用', 'Confirm this call')}</h3>
        <p className="mt-2 text-sm">{confirm === 'generate' ? tr(`生成1张图片；模型 ${preview?.options.modelId}。不自动检查、重抽或生成视频。`, `Generate 1 image with ${preview?.options.modelId}. No automatic checks, retries or video.`) : confirm === 'plan' ? tr(`使用 ${llm.model} 一次整理全片画面方案，不生图。`, `One ${llm.model} call to prepare the entire plan; no images.`) : confirm === 'check' ? tr(`使用 ${llm.visionModel || llm.model} 检查当前图和参考，不重生。`, `Use ${llm.visionModel || llm.model} to inspect this frame and references; no regeneration.`) : tr(`最多生成 ${batchShots.length} 张候选，逐镜顺序执行；失败即停。`, `Generate up to ${batchShots.length} candidates sequentially; stop on failure.`)}</p>
        <p className="mt-1 text-xs text-muted-foreground">{tr('费用随模型、尺寸、质量和参考图变化，系统未取得精确报价；以供应商账单为准。', 'Exact price is unavailable; model, size, quality and references affect provider billing.')}</p>
        {confirm === 'generate' && preview && <><div className="my-3 flex flex-wrap gap-2">{preview.compilation.references.map((r, i) => <div key={`${r.url}-${i}`} className="w-24 min-w-0">
          <img src={r.url} alt={`${i + 1}: ${r.role}`} className="h-16 w-24 object-contain rounded bg-muted/30"/><p className="truncate text-[11px]">{i + 1} · {roleLabel(r.role)}</p></div>)}</div>
          {preview.compilation.warnings.map(w => <p key={w} className="mt-1 text-xs text-amber-700 dark:text-amber-400">{w}</p>)}
          <details className="mt-3"><summary className="cursor-pointer text-xs">{tr('查看实际生图提示词', 'Inspect actual render prompt')}</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{preview.compilation.prompt}</pre></details>
          {shot.visualSource !== 'ai_generate' && <label className="mt-3 flex items-start gap-2 text-xs"><input type="checkbox" checked={syntheticAccepted} onChange={e => setSyntheticAccepted(e.target.checked)}/>{tr('原计划使用原图/真实素材，我确认生成AI替代图；不会将它当实拍证据。', 'I approve an AI alternative to the original/real-footage shot; it is not documentary evidence.')}</label>}
        </>}
        <div className="mt-3 flex gap-2"><Button size="sm" disabled={!!busy || dirty || (confirm === 'generate' && (!preview?.compilation.spec.moment.trim() || (shot.visualSource !== 'ai_generate' && !syntheticAccepted)))} onClick={() => void submitConfirmed()}>{tr('确认费用并执行', 'Confirm charge & run')}</Button><Button size="sm" variant="outline" disabled={!!busy} onClick={() => setConfirm(null)}>{tr('取消', 'Cancel')}</Button></div>
      </div>}
      <details className="mt-5 rounded-lg border p-3"><summary className="cursor-pointer text-sm">{tr('沿用已确认样片，生成剩余分镜', 'Expand approved scenes into remaining shots')}</summary>
        <p className="mt-2 text-xs text-muted-foreground">{tr('只处理没有候选的AI镜头，不重做已有图片。每个目标场景先确认一张样片；可在上方调整场景分组。生成结果仍需逐张确认。', 'Only AI shots without candidates. Pin one sample per target scene first; use scene grouping above. Every result still requires review.')}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2"><label className="text-xs">{tr('本次最多张数', 'Maximum images this run')} <input type="number" min={1} max={12} value={batchLimit} className="ml-2 w-16 rounded border bg-background p-1" disabled={!!busy} onChange={e => setBatchLimit(Math.max(1, Math.min(12, Number(e.target.value) || 1)))}/></label>
          <Button size="sm" variant="outline" disabled={!!busy || dirty || !batchAnchored || !target} onClick={() => setConfirm('batch')}>{tr(`预览生成 ${batchShots.length} 张`, `Review ${batchShots.length}-image batch`)}</Button>
          {busy === 'batch' && <Button size="sm" variant="outline" onClick={() => { stop.current = true; setNotice(tr('当前任务完成后停止，不会提交后续镜头。', 'Stopping after the current task; no later shots will be submitted.')); }}>{tr('停止后续生成', 'Stop after current')}</Button>}
        </div>{!batchAnchored && <p className="mt-2 text-xs">{tr('请先为目标场景确认样片，或所有分镜已有候选。', 'Pin target scene samples first, or all shots already have candidates.')}</p>}
      </details>
    </>}
  </section>;
}
