/**
 * 3x3 storyboard grid — single-image consistency anchoring for multi-shot videos.
 *
 * Shared reference conditioning reduces drift; it is not a guarantee of identical pixels.
 * Each cell remains the approved shot's starting state, including intentional scene changes.
 *
 * Geometry trick: a 3x3 grid at 9:16 overall yields cells that are each exactly
 * 9:16 — the cropped cells drop straight into our vertical pipeline.
 *
 * Pure functions (prompt building + crop geometry); the route does the I/O.
 */
import type { Shot, ScriptCharacter } from "@/lib/db/schema";
import { sequenceContinuity, renderModeDirection, projectVisualDirection, type StoryboardRenderContext } from "@/lib/storyboard-render-direction";

export const GRID_ROWS = 3;
export const GRID_COLS = 3;
export const GRID_MAX_SHOTS = GRID_ROWS * GRID_COLS;

/** Shot-type label used in per-cell prompt lines (bilingual not needed: grid prompt is zh-first). */
const SHOT_TYPE_LABELS: Record<string, string> = {
  hook: "钩子镜",
  pain_point: "痛点镜",
  product_reveal: "商品镜",
  demo: "演示镜",
  social_proof: "背书镜",
  cta: "转化镜",
};

/**
 * Build the one-shot 3x3 storyboard-grid image prompt: global consistency block
 * (same person / outfit / room / light) + one numbered line per cell + realism
 * rules + hard grid-layout constraints (equal cells, thin gutters, no text —
 * cells get cropped into keyframes, so any text or borders would poison them).
 */
export function buildStoryboardGridPrompt(
  shots: Shot[],
  characters?: ScriptCharacter[] | null,
  refs?: { characterSheet?: boolean; productImage?: boolean },
  context?: StoryboardRenderContext,
): string {
  const cells = shots.slice(0, GRID_MAX_SHOTS);
  const cast = (characters ?? [])
    .filter((c) => c.name?.trim())
    .map((c) => `${c.name}：${c.appearance ?? ""}`)
    .filter(Boolean)
    .join("；");

  const cellLines = cells.map((s, i) => {
    const label = SHOT_TYPE_LABELS[String(s.type)] ?? "分镜";
    return `第 ${i + 1} 格（${label}）：${s.description}${s.camera ? `；景别与机位：${s.camera}（仅画初始定格，不把运镜轨迹画进画面）` : ""}${s.prompt ? `；已批准首帧描述：${s.prompt}` : ""}${s.speakerVisible === false ? "；该镜配音在画外，不新增说话人物或口型" : ""}`;
  });

  // reference-image contract: the images array order is [character sheet?, product photo?],
  // so the prompt cites them by position (field-proven with gpt-image-2/edit)
  const refLines: string[] = [];
  if (refs?.characterSheet || refs?.productImage) {
    let n = 0;
    if (refs.characterSheet) {
      n += 1;
      refLines.push(
        `第 ${n} 张参考图是出镜人物的四视图定妆照——九格中的人物脸型、发型、体型与服装必须与其完全一致（定妆照只作人物参考，不作为分镜画面）。人物需自然融入各格自身的场景与光线，不得把定妆照的浅灰影棚背景、四格分格或边框带进任何一格。`
      );
    }
    if (refs.productImage) {
      n += 1;
      refLines.push(`第 ${n} 张参考图是商品实拍图——九格中的商品外观、配色与包装必须与其完全一致。`);
    }
  }

  return [
    `一张 ${GRID_ROWS}x${GRID_COLS} 等分九宫格分镜图，整图 9:16 竖版，格与格之间只留极细的白色分隔缝。`,
    sequenceContinuity("zh"),
    renderModeDirection(context, "zh"),
    projectVisualDirection(context, "zh"),
    ...refLines,
    cast ? `人物设定：${cast}。` : "",
    `各格内容（每格是一个独立镜头的画面，构图按竖屏 9:16 设计；每格都是该镜动作即将开始前一瞬的定格，姿态里留着正要发生的势能）：`,
    ...cellLines,
    `质感服从已批准脚本的媒介、主色、材质与光源，不自动改成手机UGC、真人摄影或重金属风。每格仅一个时刻，起始状态与后续主动作相容，不能把动作结束状态提前画入首帧。`,
    cells.length < GRID_MAX_SHOTS ? `只讲前 ${cells.length} 格的故事；剩余格重复最后一格的中性环境，不增加角色、事件或文字，裁切流程不会使用它们。` : "",
    `硬性要求：严格等分九宫格；画面不新增文字、字幕、编号、水印或边框装饰；商品原有包装文字与标识按参考保留；每格都是完整可独立使用的镜头画面。`,
  ]
    .filter(Boolean)
    .join("\n");
}

export interface GridCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Crop rectangles for the grid cells, inset by `insetRatio` of the cell size on
 * every edge — generated grids never have pixel-perfect gutters, so a small
 * inset (default 2%) trims the seam residue instead of keeping it as a border.
 * Row-major order (left→right, top→bottom) matching the prompt's cell numbering.
 */
export function computeGridCells(
  width: number,
  height: number,
  opts: { rows?: number; cols?: number; insetRatio?: number } = {}
): GridCell[] {
  const rows = opts.rows ?? GRID_ROWS;
  const cols = opts.cols ?? GRID_COLS;
  const inset = opts.insetRatio ?? 0.02;
  const cellW = width / cols;
  const cellH = height / rows;
  const dx = cellW * inset;
  const dy = cellH * inset;
  const cells: GridCell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        x: Math.round(c * cellW + dx),
        y: Math.round(r * cellH + dy),
        w: Math.round(cellW - 2 * dx),
        h: Math.round(cellH - 2 * dy),
      });
    }
  }
  return cells;
}
