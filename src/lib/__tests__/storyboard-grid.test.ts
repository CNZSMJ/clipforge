import { describe, it, expect } from "vitest";
import { buildStoryboardGridPrompt, computeGridCells, GRID_MAX_SHOTS } from "@/lib/storyboard-grid";
import type { Shot, ScriptCharacter } from "@/lib/db/schema";

const shot = (shotId: number, type: string, description: string) =>
  ({ shotId, type, duration: 3, description, voiceover: "词", visualSource: "ai_generate", transition: "cut" }) as unknown as Shot;

describe("buildStoryboardGridPrompt", () => {
  const shots = [shot(1, "hook", "女生对镜头惊讶"), shot(2, "demo", "上手使用产品"), shot(3, "cta", "举起产品推荐")];
  const cast: ScriptCharacter[] = [
    { id: "char_a", name: "小美", gender: "female", persona: "活泼", appearance: "22 岁高马尾白 T 恤" } as ScriptCharacter,
  ];

  it("场景内一致性与原有标识保留，媒介由批准脚本决定", () => {
    const p = buildStoryboardGridPrompt(shots, cast);
    expect(p).toContain("同一场景内保持布局");
    expect(p).toContain("明确换景/换时段时建立新场景");
    expect(p).toContain("小美：22 岁高马尾白 T 恤");
    expect(p).toContain("第 1 格（钩子镜）：女生对镜头惊讶");
    expect(p).toContain("第 3 格（转化镜）：举起产品推荐");
    expect(p).not.toContain("不是精修网红脸");
    expect(p).toContain("质感服从已批准脚本的媒介");
    expect(p).toContain("画面不新增文字");
    expect(p).toContain("商品原有包装文字与标识按参考保留");
  });

  it("超过 9 镜截断到 9 格；无角色时不输出人物设定行", () => {
    const many = Array.from({ length: 12 }, (_, i) => shot(i + 1, "demo", `镜头${i + 1}`));
    const p = buildStoryboardGridPrompt(many);
    expect(p).toContain(`第 ${GRID_MAX_SHOTS} 格`);
    expect(p).not.toContain("第 10 格");
    expect(p).not.toContain("人物设定");
  });

  it("参考图约定：定妆照+商品图按序编号；只有商品图时商品是第 1 张", () => {
    const both = buildStoryboardGridPrompt(shots, cast, { characterSheet: true, productImage: true });
    expect(both).toContain("第 1 张参考图是出镜人物的四视图定妆照");
    expect(both).toContain("第 2 张参考图是商品实拍图");
    const productOnly = buildStoryboardGridPrompt(shots, cast, { productImage: true });
    expect(productOnly).toContain("第 1 张参考图是商品实拍图");
    expect(productOnly).not.toContain("定妆照");
    const none = buildStoryboardGridPrompt(shots, cast);
    expect(none).not.toContain("参考图");
  });
});

describe("computeGridCells", () => {
  it("9 格行主序等分 + inset 内缩几何正确", () => {
    const cells = computeGridCells(900, 1600, { insetRatio: 0 });
    expect(cells.length).toBe(9);
    expect(cells[0]).toEqual({ x: 0, y: 0, w: 300, h: 533 });
    expect(cells[1].x).toBe(300); // 行主序：第二格在右侧
    expect(cells[3].y).toBe(533); // 第四格进入第二行
    expect(cells[8]).toEqual({ x: 600, y: 1067, w: 300, h: 533 });
  });

  it("整图 9:16 时每格也是 9:16（竖屏关键帧免二次裁）", () => {
    const [cell] = computeGridCells(1080, 1920, { insetRatio: 0 });
    expect(cell.w / cell.h).toBeCloseTo(9 / 16, 2);
  });

  it("默认 2% 内缩裁掉格间缝残留", () => {
    const cells = computeGridCells(900, 1600);
    expect(cells[0].x).toBeGreaterThan(0);
    expect(cells[0].w).toBeLessThan(300);
    // 内缩对称：格宽 = 原格宽 - 2*内缩
    expect(cells[0].w).toBe(300 - 2 * Math.round(300 * 0.02));
  });
});
