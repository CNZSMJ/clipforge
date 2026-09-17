/** Render-time continuity rules: conserve the approved storyboard, do not re-direct its genre. */
import type { CreativeIntent, VisualBible } from "@/lib/production-system";

export interface StoryboardRenderContext {
  videoMode?: string | null;
  contentType?: string | null;
  styleType?: string | null;
  creativeIntent?: CreativeIntent | null;
  visualBible?: VisualBible | null;
}

export function isOffscreenNarration(context?: StoryboardRenderContext): boolean {
  return context?.contentType === "topic" || context?.styleType === "product_pov" ||
    ["product_closeup", "graphic_montage", "scene_demo"].includes(context?.videoMode ?? "");
}

/** Explicit new-shot flag wins; legacy scripts retain their cast fallback within mode limits. */
export function shotSpeakerVisible(shot: { characterId?: string; speakerVisible?: boolean } | undefined, context?: StoryboardRenderContext): boolean {
  return Boolean(shot?.characterId) && shot?.speakerVisible !== false && !isOffscreenNarration(context);
}

/** Shared art direction must not overwrite an approved shot's own action or camera. */
export function shotScopedIntent(intent: CreativeIntent, shot?: { description?: string; camera?: string }): CreativeIntent {
  if (!shot?.description?.trim()) return intent;
  return { ...intent, action: undefined, motion: undefined, ...(shot.camera?.trim() && { camera: undefined }) };
}

export function sequenceContinuity(language: "zh" | "en"): string {
  return language === "zh"
    ? "全局一致性：同一人物的身份、发型与服装锚、商品几何/配色/原有标识稳定；同一场景内保持布局、光线方向和画面左右关系。以逐镜脚本与关键帧为准，明确换景/换时段时建立新场景，不能把全片强制改成同一房间。动作起止、开合、液面、持物与数量逐镜衔接，已完成的动作不复原；揭示只改变观众理解，不偷换对象。"
    : "Global consistency: preserve the identity, hair and wardrobe of the same person, product geometry/colors/existing marks; maintain layout, lighting direction and screen direction WITHIN each scene. Follow each approved shot and its keyframe. Establish explicitly scripted changes of place/time instead of forcing every shot into the same room. Carry opening/closing, liquid level, held props and counts across consecutive actions; never reset a completed action or swap the object during a reveal.";
}

export function renderModeDirection(context: StoryboardRenderContext | undefined, language: "zh" | "en"): string {
  const zh = language === "zh";
  // Topic projects inherit a commerce DB default; it is not an intentional people restriction.
  const videoMode = context?.contentType === "topic" ? undefined : context?.videoMode;
  const productVoice = context?.contentType !== "topic" && context?.styleType === "product_pov";
  const noPeople = ["product_closeup", "graphic_montage"].includes(videoMode ?? "") || productVoice;
  if (noPeople) return zh
    ? "人物边界：画面只保留脚本中的物品与环境，不添加真人、脸、手或代言人。拟人仅在画外声音中表达，商品不长眼睛、嘴唇或四肢，口型指令不适用。"
    : "People boundary: only the scripted objects and environment, no added human, face, hand or presenter. Personification is offscreen voice only; the product has no added eyes, lips or limbs, and no lip-sync direction applies.";
  if (videoMode === "scene_demo") return zh
    ? "人物边界：按分镜仅呈现手部/背影或物件，脸不可见；不能因有配音就加对镜头讲话的人。"
    : "People boundary: use only the scripted hands/back view or objects, with faces out of view; narration never creates an on-camera presenter.";
  return zh
    ? "出镜边界：只出现逐镜脚本明确指定的人物，不因旁白或人物表就把人加进所有镜头。"
    : "Cast boundary: include people only where the individual shot calls for them; a narrator, cast list or identity sheet never inserts a person into every shot.";
}

/** Fixed existing bible values, not newly inferred visuals or another paid planning step. */
export function projectVisualDirection(context: StoryboardRenderContext | undefined, language: "zh" | "en"): string {
  const intent = context?.creativeIntent;
  const bible = context?.visualBible;
  const values = [intent?.lighting, intent?.palette, intent?.composition,
    ...(intent?.continuity ?? []), ...(intent?.productConstraints ?? []),
    ...(bible?.characterAnchors ?? []), ...(bible?.productAnchors ?? []),
    ...(bible?.wardrobeAnchors ?? []), ...(bible?.environmentAnchors ?? []), ...(bible?.lightingAnchors ?? [])]
    .filter((v): v is string => typeof v === "string" && !!v.trim());
  const forbidden = bible?.forbiddenChanges ?? [];
  if (!values.length && !forbidden.length) return "";
  return `${language === "zh" ? "项目已批准视觉约束（不改变逐镜动作）" : "Approved project visual constraints (do not replace shot actions)"}: ${JSON.stringify({ anchors: [...new Set(values)], forbiddenChanges: forbidden })}`;
}
