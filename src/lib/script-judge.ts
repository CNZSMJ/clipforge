/**
 * Judge panel — a five-judge adversarial pass over script lines and shot visuals,
 * run BEFORE any money is spent on generation.
 *
 * The UGC methodology this encodes: video models render a bad script exactly as
 * pretty as a good one, so the script must be torn apart first — by narrow,
 * bad-tempered specialists, not one generalist reviewer. Five judges, each
 * owning exactly one axis (retention pacing / spoken-not-written voice /
 * freshness / structure / visible-action visuals), one LLM call for all five,
 * plus rewrites that keep meaning, selling points and — critically — line
 * LENGTH (voiceover duration is pinned to shot duration by TTS).
 *
 * v2 additions:
 *  - visual judge: "who does what in THIS second" — purpose-sentences
 *    ("shows product quality") are not frames; they get rewritten into visible
 *    actions via descriptionRewrites.
 *  - three-tier adoption grades: hands-off chains auto-apply invariant/default
 *    rewrites only; taste-tier stays display-only (protects creative choices
 *    while still catching hard defects). Invalid tiers clamp to "taste" —
 *    when in doubt, show, never auto-change.
 *  - evidence rule: every issue must quote the offending fragment; rewrites
 *    must preserve the original line's numeric fact tokens (price/spec/count),
 *    enforced server-side — a rewrite that loses a number is dropped.
 *
 * Pure functions: prompt building + response parsing/clamping. The route does I/O.
 */
import { SPOKEN_VOICE_RULES } from "@/lib/presenters";
import { COMMERCE_DIRECTION, TOPIC_DIRECTION } from "@/lib/script-engine/storyboard-direction";
import { sequenceContinuity, renderModeDirection, projectVisualDirection, type StoryboardRenderContext } from "@/lib/storyboard-render-direction";
import { extractJSON } from "@/lib/script-engine/generator";

export const JUDGE_IDS = ["pace", "voice", "idea", "structure", "visual"] as const;
export type JudgeId = (typeof JUDGE_IDS)[number];

/** Judge display metadata (zh/en) for the report UI. */
export const JUDGE_META: Record<JudgeId, { zh: string; en: string }> = {
  pace: { zh: "节奏官", en: "Pacing judge" },
  voice: { zh: "口语官", en: "Voice judge" },
  idea: { zh: "创意官", en: "Freshness judge" },
  structure: { zh: "结构官", en: "Structure judge" },
  visual: { zh: "画面官", en: "Visual judge" },
};

/** Adoption tiers: what automation may act on vs. what stays a suggestion. */
export const JUDGE_TIERS = ["invariant", "default", "taste"] as const;
export type JudgeTier = (typeof JUDGE_TIERS)[number];

export interface JudgeIssue {
  shotId?: number;
  issue: string;
  /** Adoption grade (display); invalid model output clamps to "taste" */
  tier: JudgeTier;
}
export interface JudgeVerdict {
  judge: JudgeId;
  issues: JudgeIssue[];
}
export interface JudgeRewrite {
  shotId: number;
  voiceover: string;
  /** Adoption grade: hands-off chains only auto-apply invariant/default */
  tier: JudgeTier;
}
/** Visual judge's shot-description rewrite (function sentence → visible action). */
export interface JudgeDescriptionRewrite {
  shotId: number;
  description: string;
  tier: JudgeTier;
}
export interface JudgeReport {
  verdicts: JudgeVerdict[];
  rewrites: JudgeRewrite[];
  descriptionRewrites: JudgeDescriptionRewrite[];
  summary?: string;
}

/** Minimal shot view the judges need (id + spoken line + what the frame shows). */
export interface JudgeShotInput {
  shotId: number;
  voiceover: string;
  /** Shot visual description — feeds the visual judge; optional for line-only callers */
  description?: string;
  duration?: number;
  camera?: string;
  characterId?: string;
  speakerVisible?: boolean;
}

/** True when the text contains CJK characters (rewrite-language pick). */
function hasCjk(s: string): boolean {
  return /[一-鿿぀-ヿ가-힯]/.test(s);
}

/**
 * Build the single-call judge-panel prompt. All five judges rule in one
 * response; rewrites must keep meaning/claims and stay within ±20% of the
 * original length so TTS timing still fits the shot slots.
 */
export function buildJudgePrompt(
  shots: JudgeShotInput[],
  opts: StoryboardRenderContext & { styleLabel?: string; narrationStyle?: keyof typeof TOPIC_DIRECTION } = {}
): string {
  const lines = shots.map((s) => {
    const desc = (s.description ?? "").trim();
    const meta = [s.duration ? `${s.duration}s` : "", s.camera, s.characterId ? `voice=${s.characterId}` : "", s.speakerVisible === false ? "offscreen" : s.speakerVisible === true ? "speaker-visible" : ""].filter(Boolean).join(" / ");
    const suffix = meta ? `｜${meta}` : "";
    return desc
      ? `- shotId ${s.shotId}：台词「${s.voiceover}」｜画面「${desc}」${suffix}`
      : `- shotId ${s.shotId}：「${s.voiceover}」${suffix}`;
  });
  const english = shots.length > 0 && shots.every((s) => !hasCjk(`${s.voiceover}${s.description ?? ""}`));
  const styleExtra = opts.contentType === "topic"
    ? (opts.narrationStyle ? TOPIC_DIRECTION[opts.narrationStyle] : "主题内容专项：根据脚本目的检查解释是否清楚、故事因果、过程可用或地点可信；不要求所有类型都有反转、推销或金句。")
    : COMMERCE_DIRECTION[opts.styleType as keyof typeof COMMERCE_DIRECTION];
  return [
    `你是一支短视频「判官团」，由五位分工明确、依据具体证据的审稿人组成。任务：检查下面这条${opts.styleLabel ? `（${opts.styleLabel}风格）` : ""}视频的逐镜台词与画面，只修实际问题，保护已成立的创意。`,
    ``,
    `五位判官（每位只从自己的角度检查，允许没有问题）：`,
    `1. 节奏官（pace）：检查首镜是否建立观看理由、主承诺是否兑现、台词是否适配实际时长；允许无声镜头、结果停留和情绪呼吸，不要求句句重新制造悬念。`,
    `2. 口语官（voice）：只管「说的不是写的」。判准如下（铁律）：`,
    opts.contentType === "topic"
      ? "主题旁白按所选体裁检查可听性：知识解释清楚、故事声音连贯；允许已铺垫的诗性/抒情短句，不把商业口播的语气当所有类型的铁律。"
      : SPOKEN_VOICE_RULES,
    `3. 创意官（idea）：只管新鲜感。检查观察视角、揭示顺序、声画关系或视觉回声是否针对本素材；只换同义词不算新意，创意不等于更夸张。不同的合理风格不要判错。`,
    `4. 结构官（structure）：检查该类型的因果链、证据链或空间/情绪进展与结尾回扣。主题视频不要求商业转化；已经铺垫的短句收尾允许，不能因未制造中段悬念就判硬伤。另加两条全局检查：`,
    `   - 信息密度均匀不必然是错误：检查是否缺少关键结果/变化，停留镜有观看价值就保留`,
    `   - 「不成立的钩子替代品」负例清单：无来源的新悬念（前文没铺垫突然抛问题）、藏结果式吊胃口（黑屏/"结果你们猜"却不兑现）、把同一句威胁复读得更大声——这三种都不算钩子，点名`,
    `5. 画面官（visual）：只管「这一秒画面里谁做了什么」。判准：`,
    `   - description 必须是可见事实：主体/物件 + 起始状态 + 一个主动作/静置细节 + 结束状态；无需出现人或手，静物微距也可成立`,
    `   - 功能句不是画面：「展示产品效果」「建立信任感」「体现品质」这类目的描述=没写画面，invariant 级点名并给出可见动作重写（写进 descriptionRewrites）`,
    `   - 重写保持原镜意图与场景，只把"目的"翻译成"动作"，长度与原句相当`,
    styleExtra ? `类型专项（遵守人物/素材限制，不盲套结构）：\n${styleExtra}` : "",
    sequenceContinuity("zh"),
    renderModeDirection(opts, "zh"),
    projectVisualDirection(opts, "zh"),
    "连续性加审：服装/商品标识、屏幕方向、开合与持物状态、场景切换、声音归属是否冲突；描述重写不能更换身份、媒介、色板、动作结果或预埋线索。无法在单镜安全修正的跨镜矛盾标 taste 并说明整组建议，不局部自动破坏其他镜头。",
    ``,
    `证据规则（对所有判官生效）：每条 issue 必须包含两个要素——①用「」引出原句/原描述里出问题的片段；②一句话说清什么没有成立。没有引文的挑刺视为无效。`,
    ``,
    `采纳分级（每条 issue 与每条重写都必须标 tier）：`,
    `- invariant：硬伤，不改必翻车（明确的事实矛盾、功能句无画面、时长不可行或状态穿帮；不能将主观的“不够抓人”判成硬伤）`,
    `- default：默认应改（口语铁律违规、套路化表达、结构断裂）`,
    `- taste：品味之争（换个说法也成立）——只提出，不强求；自动化流程不会采纳 taste 级重写`,
    ``,
    `逐镜内容：`,
    ...lines,
    ``,
    `只输出 JSON，格式：`,
    `{"verdicts":[{"judge":"pace","issues":[{"shotId":1,"issue":"「原句片段」——什么没有成立","tier":"default"}]},{"judge":"voice","issues":[]},{"judge":"idea","issues":[]},{"judge":"structure","issues":[]},{"judge":"visual","issues":[]}],"rewrites":[{"shotId":1,"voiceover":"重写后的台词","tier":"default"}],"descriptionRewrites":[{"shotId":2,"description":"重写后的画面描述（可见动作）","tier":"invariant"}],"summary":"一句话总评"}`,
    ``,
    `重写规则：`,
    `- 保留已确认原意与事实，只改「怎么说」；不新增任何功效/价格承诺；未获证实的事实只标注待核实，不以另一条编造的事实替换（广告合规红线）`,
    `- 重写句必须原样保留原句里出现的所有数字、价格与规格（服务端会逐个校验数字 token，丢一个整条弃用）`,
    `- 重写后的台词必须像「说出来的」，且长度与原句相当（字数差控制在 ±20%，配音时长钉死在分镜槽里）`,
    `- 空 voiceover 表示有意无声，不填入新旁白；保留关键视觉线索、左右关系、动作起止与人物锚，不能为了新鲜感偷换创意`,
    `- 没毛病的镜头不要出现在 rewrites/descriptionRewrites 里；判官没意见就各自给空 issues`,
    english ? `- All issues and rewrites in English (the script is English).` : ``,
  ]
    .filter((l) => l !== undefined && l !== "")
    .join("\n");
}

/** Clamp a tier value; anything unrecognized becomes "taste" (show, never auto-change). */
function clampTier(raw: unknown): JudgeTier {
  return typeof raw === "string" && (JUDGE_TIERS as readonly string[]).includes(raw) ? (raw as JudgeTier) : "taste";
}

/**
 * Numeric fact tokens of a line (prices, specs, counts). Matching is
 * boundary-guarded so "3" never matches inside "13" — a rewrite that changed a
 * number must be dropped, not accepted by substring luck.
 */
export function factTokens(text: string): string[] {
  return Array.from(new Set(text.match(/\d+(?:\.\d+)?/g) ?? []));
}

/** True when every numeric fact token of the original survives verbatim in the rewrite. */
export function preservesFactTokens(original: string, rewrite: string): boolean {
  for (const tok of factTokens(original)) {
    const re = new RegExp(`(?<![\\d.])${tok.replace(".", "\\.")}(?![\\d.])`);
    if (!re.test(rewrite)) return false;
  }
  return true;
}

/** Clamp one issue list: keep only entries with usable text; shotId must exist when given. */
function clampIssues(raw: unknown, validShots: Set<number>): JudgeIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: JudgeIssue[] = [];
  for (const it of raw) {
    const issue = typeof (it as { issue?: unknown })?.issue === "string" ? (it as { issue: string }).issue.trim() : "";
    if (!issue) continue;
    const sid = (it as { shotId?: unknown }).shotId;
    const shotId = typeof sid === "number" && validShots.has(sid) ? sid : undefined;
    const tier = clampTier((it as { tier?: unknown }).tier);
    out.push(shotId === undefined ? { issue, tier } : { shotId, issue, tier });
  }
  return out;
}

/** Shared clamp for text rewrites: real shot, non-empty, sane length ratio, facts preserved. */
function clampTextRewrites<T>(
  raw: unknown,
  originals: Map<number, string>,
  field: "voiceover" | "description",
  make: (shotId: number, text: string, tier: JudgeTier) => T
): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  const seen = new Set<number>();
  for (const r of raw) {
    const shotId = (r as { shotId?: unknown })?.shotId;
    const text =
      typeof (r as Record<string, unknown>)?.[field] === "string"
        ? ((r as Record<string, string>)[field] as string).trim()
        : "";
    if (typeof shotId !== "number" || !originals.has(shotId) || !text || seen.has(shotId)) continue;
    const original = originals.get(shotId) ?? "";
    const origLen = original.trim().length;
    // Silence is intentional timing, not an empty writing slot for the judge to fill.
    if (field === "voiceover" && origLen === 0) continue;
    if (origLen > 0) {
      // 0.4x–2.5x: beyond that the TTS timing breaks (voiceover) or the shot got re-imagined
      const ratio = text.length / origLen;
      if (ratio < 0.4 || ratio > 2.5) continue;
    }
    // evidence discipline: a rewrite that loses a number lost a fact — drop it
    if (!preservesFactTokens(original, text)) continue;
    seen.add(shotId);
    out.push(make(shotId, text, clampTier((r as { tier?: unknown }).tier)));
  }
  return out;
}

/**
 * Parse + clamp the LLM's judge response. Unknown judges are dropped, missing
 * judges get empty issue lists (the UI renders all five); voiceover and
 * description rewrites are kept only for real shots with non-empty text within
 * a sane length ratio of the original AND with every numeric fact token intact.
 */
export function parseJudgeResponse(content: string, shots: JudgeShotInput[]): JudgeReport {
  const validShots = new Set(shots.map((s) => s.shotId));
  const voiceoverByShot = new Map(shots.map((s) => [s.shotId, s.voiceover]));
  // description rewrites only apply to shots that HAVE a description
  const descriptionByShot = new Map(
    shots.filter((s) => (s.description ?? "").trim()).map((s) => [s.shotId, (s.description ?? "").trim()])
  );
  let raw: unknown;
  try {
    raw = JSON.parse(extractJSON(content));
  } catch {
    throw new Error("判官团返回的不是合法 JSON");
  }

  const rawVerdicts = Array.isArray((raw as { verdicts?: unknown })?.verdicts)
    ? ((raw as { verdicts: unknown[] }).verdicts as unknown[])
    : [];
  const byJudge = new Map<JudgeId, JudgeIssue[]>();
  for (const v of rawVerdicts) {
    const judge = (v as { judge?: unknown })?.judge;
    if (typeof judge !== "string" || !(JUDGE_IDS as readonly string[]).includes(judge)) continue;
    byJudge.set(judge as JudgeId, clampIssues((v as { issues?: unknown }).issues, validShots));
  }
  const verdicts: JudgeVerdict[] = JUDGE_IDS.map((id) => ({ judge: id, issues: byJudge.get(id) ?? [] }));

  const rewrites = clampTextRewrites(
    (raw as { rewrites?: unknown })?.rewrites,
    voiceoverByShot,
    "voiceover",
    (shotId, voiceover, tier): JudgeRewrite => ({ shotId, voiceover, tier })
  );
  const descriptionRewrites = clampTextRewrites(
    (raw as { descriptionRewrites?: unknown })?.descriptionRewrites,
    descriptionByShot,
    "description",
    (shotId, description, tier): JudgeDescriptionRewrite => ({ shotId, description, tier })
  );

  const summary = typeof (raw as { summary?: unknown })?.summary === "string" ? (raw as { summary: string }).summary.trim() : undefined;
  return { verdicts, rewrites, descriptionRewrites, summary: summary || undefined };
}

/**
 * The rewrites automation may apply without a human in the loop: invariant and
 * default tiers only. Taste-tier rewrites are opinions — every hands-off chain
 * (web free / AI / batch / CLI / MCP) displays them but never auto-applies.
 */
export function autoApplicableRewrites(report: JudgeReport): JudgeRewrite[] {
  return report.rewrites.filter((r) => r.tier !== "taste");
}

/** Same gate for the visual judge's description rewrites. */
export function autoApplicableDescriptionRewrites(report: JudgeReport): JudgeDescriptionRewrite[] {
  return report.descriptionRewrites.filter((r) => r.tier !== "taste");
}
