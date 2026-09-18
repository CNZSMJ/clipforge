import { describe, expect, it } from "vitest";
import { buildUserPrompt } from "@/lib/script-engine/prompts";
import {
  categoryFromAnalysis,
  categoryFromText,
  resolveProductCategory,
  storedCategoryKey,
} from "@/lib/product-category";

describe("product category resolution", () => {
  it("treats the uploaded-photo placeholder as unknown instead of beauty", () => {
    expect(storedCategoryKey("other")).toBeNull();
    expect(storedCategoryKey("")).toBeNull();
    expect(storedCategoryKey(undefined)).toBeNull();
    expect(storedCategoryKey("OTHER")).toBeNull();
    // real values still pass through unchanged
    expect(storedCategoryKey("food")).toBe("food");
    expect(storedCategoryKey("beauty")).toBe("beauty");
    expect(storedCategoryKey("digital")).toBe("tech");
    expect(storedCategoryKey("3c")).toBe("tech");
  });

  it("reads the 所属品类 line the vision analysis already produces", () => {
    const analysis = [
      "1. 【商品识别】",
      "- 商品名称：菊花普洱茶礼盒",
      "- 所属品类（美妆护肤/食品零食/家居日用/服饰鞋包/数码3C）：食品零食",
      "- 品牌：不可见",
    ].join("\n");
    expect(categoryFromAnalysis(analysis)).toBe("food");
  });

  it("does not mistake the echoed option list for an answer", () => {
    const noAnswer = "- 所属品类（美妆护肤/食品零食/家居日用/服饰鞋包/数码3C）：";
    expect(categoryFromAnalysis(noAnswer)).toBeNull();
    // the analysis mentions 美妆护肤 only inside prose, with no 品类 line
    expect(categoryFromAnalysis("商品是茶，不是美妆护肤类产品")).toBeNull();
  });

  it("infers from the product text when there is no analysis", () => {
    const tea = "低温萃取茶晶｜菊花普洱茶 + 人参乌龙茶";
    expect(categoryFromText(tea, "0%添加糖、冷热水3秒即溶")).toBe("food");
    expect(categoryFromText("氨基酸洁面慕斯", "温和不紧绷")).toBe("beauty");
    expect(categoryFromText("蓝牙降噪耳机", "续航40小时")).toBe("tech");
    expect(categoryFromText("纯棉圆领T恤", "不透不勾丝")).toBe("fashion");
    expect(categoryFromText("不粘炒锅", "少油少烟")).toBe("home");
  });

  it("REGRESSION: a tea product saved as \"other\" no longer becomes 美妆护肤", () => {
    const resolved = resolveProductCategory({
      stored: "other",
      productName: "低温萃取茶晶｜菊花普洱茶 + 人参乌龙茶",
      productDescription: "0%添加糖与蔗糖、100%纯植物与茶叶萃取",
    });
    expect(resolved.category).toBe("food");
    expect(resolved.source).toBe("keywords");

    const prompt = buildUserPrompt({
      productName: "低温萃取茶晶｜菊花普洱茶 + 人参乌龙茶",
      category: resolved.category,
      productDescription: "低温萃取茶晶，冷热水3秒即溶",
      styleType: "pain_point",
      targetDuration: 30,
      videoMode: "product_closeup",
    });
    expect(prompt).toContain("商品品类：食品零食");
    expect(prompt).not.toContain("商品品类：美妆护肤");
  });

  it("prefers an explicit stored category over inference", () => {
    const resolved = resolveProductCategory({ stored: "beauty", productName: "菊花普洱茶" });
    expect(resolved).toEqual({ category: "beauty", source: "stored" });
  });

  it("prefers the analysis over keywords, and reports when nothing is identifiable", () => {
    expect(
      resolveProductCategory({ stored: "other", productName: "神秘礼盒", analysis: "- 所属品类：食品零食" })
    ).toEqual({ category: "food", source: "analysis" });
    expect(resolveProductCategory({ stored: "other", productName: "神秘礼盒" })).toEqual({
      category: "beauty",
      source: "fallback",
    });
  });
});

describe("single source of truth", () => {
  it("templates/index.ts re-exports the ONE label table instead of copying it", async () => {
    const { categoryNameMap } = await import("@/lib/script-engine/templates");
    const { CATEGORY_LABELS } = await import("@/lib/product-category");
    // identity, not equality: a copy is how the first two tables drifted apart
    expect(categoryNameMap).toBe(CATEGORY_LABELS);
  });

  it("the analysis prompt prints the canonical option list", async () => {
    const { PRODUCT_ANALYSIS_PROMPT } = await import("@/lib/script-engine/prompts");
    const { categoryOptionsText } = await import("@/lib/product-category");
    expect(PRODUCT_ANALYSIS_PROMPT).toContain(categoryOptionsText());
  });

  it("every i18n namespace that names a category uses the canonical Chinese label", async () => {
    const { CATEGORY_LABELS, CATEGORY_LABELS_EN, PRODUCT_CATEGORIES } = await import(
      "@/lib/product-category"
    );
    const namespaces: Record<string, { zh?: Record<string, string>; en?: Record<string, string> }> = {
      newProject: (await import("@/lib/i18n/messages/newProject")).newProject,
      batch: (await import("@/lib/i18n/messages/batch")).batch,
      products: (await import("@/lib/i18n/messages/products")).products,
    };
    const keys: Record<string, string> = {
      beauty: "categoryBeauty",
      food: "categoryFood",
      home: "categoryHome",
      fashion: "categoryFashion",
      tech: "categoryTech",
    };
    for (const [name, ns] of Object.entries(namespaces)) {
      for (const category of PRODUCT_CATEGORIES) {
        const key = keys[category];
        // both languages, and every namespace must actually offer the option
        expect(ns.zh?.[key], name + ".zh." + key).toBe(CATEGORY_LABELS[category]);
        expect(ns.en?.[key], name + ".en." + key).toBe(CATEGORY_LABELS_EN[category]);
      }
    }
  });
});
