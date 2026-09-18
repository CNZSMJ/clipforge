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

  it("prefers the analysis over keywords, and reports an unknown instead of guessing", () => {
    expect(
      resolveProductCategory({ stored: "other", productName: "神秘礼盒", analysis: "- 所属品类：食品零食" })
    ).toEqual({ category: "food", source: "analysis" });
    // no stored value, no analysis answer and no keyword hit: the answer is "not identified" —
    // NOT 美妆护肤, which is what previously mis-scripted a tea product with the beauty template.
    expect(resolveProductCategory({ stored: "other", productName: "神秘礼盒" })).toEqual({
      category: null,
      source: "unknown",
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

  it("also accepts the English label and a bare enum key", () => {
    // the model is asked in prose, so it may answer in either language or with the bare key
    expect(categoryFromAnalysis("- 所属品类：Food & snacks")).toBe("food");
    expect(categoryFromAnalysis("- 所属品类：Beauty & skincare")).toBe("beauty");
    expect(categoryFromAnalysis("- 所属品类：food")).toBe("food");
    expect(categoryFromAnalysis("- 所属品类：FOOD.")).toBe("food");
    expect(categoryFromAnalysis("- 所属品类：Electronics & 3C")).toBe("tech");
  });

  it("still returns null for an out-of-enum answer (safe, not a wrong category)", () => {
    // 饮料 / 保健食品 / 母婴用品 are not categories the engine can render a template for;
    // the caller falls through to keywords rather than getting a wrong template.
    expect(categoryFromAnalysis("- 所属品类：饮料")).toBeNull();
    expect(categoryFromAnalysis("- 所属品类：保健食品")).toBeNull();
    expect(categoryFromAnalysis("- 所属品类：母婴用品")).toBeNull();
    // an English sentence that merely mentions home is not an answer
    expect(categoryFromAnalysis("- 所属品类：suitable for the home")).toBeNull();
  });
});

describe("structured analysis answer and the unclassified path", () => {
  const JSON_REPLY = [
    "{",
    '  "productName": "菊花普洱茶礼盒",',
    '  "category": "food",',
    '  "sellingPoints": ["冷热3秒即溶"],',
    '  "targetAudience": "办公室人群"',
    "}",
  ].join("\n");

  it("reads the JSON category field the analysis prompt already specifies", async () => {
    const { categoryFromAnalysis, categoryFromAnalysisJson, PRODUCT_CATEGORIES } = await import(
      "@/lib/product-category"
    );
    expect(categoryFromAnalysisJson(JSON_REPLY)).toBe("food");
    expect(categoryFromAnalysis(JSON_REPLY)).toBe("food");
    // the enum pinned in the prompt's JSON contract is derived from PRODUCT_CATEGORIES, so the
    // prompt can never ask for a key the parser would reject
    const { PRODUCT_ANALYSIS_PROMPT } = await import("@/lib/script-engine/prompts");
    expect(PRODUCT_ANALYSIS_PROMPT).toContain(`"category": "${PRODUCT_CATEGORIES.join("|")}"`);
  });

  it("does not mistake the echoed JSON placeholder for an answer", async () => {
    const { categoryFromAnalysisJson, categoryFromAnalysis } = await import("@/lib/product-category");
    expect(categoryFromAnalysisJson('{"category": "beauty|food|home|fashion|tech"}')).toBeNull();
    expect(categoryFromAnalysis('{"category": "beauty|food|home|fashion|tech"}')).toBeNull();
    expect(categoryFromAnalysisJson('{"category": "母婴用品"}')).toBeNull();
    // a label instead of a key is tolerated, but only as an exact answer
    expect(categoryFromAnalysisJson('{"category": "Food & snacks"}')).toBe("food");
  });

  it("prefers the structured field over a prose line", async () => {
    const { resolveProductCategory } = await import("@/lib/product-category");
    expect(
      resolveProductCategory({ productName: "茶", analysis: JSON_REPLY + "\n- 所属品类：美妆护肤" })
    ).toEqual({ category: "food", source: "analysis" });
  });

  it("injects no category block and says so when nothing identified the product", async () => {
    const { buildUserPrompt } = await import("@/lib/script-engine/prompts");
    const prompt = buildUserPrompt({
      productName: "神秘礼盒",
      category: null,
      productDescription: "未知商品",
      styleType: "pain_point",
      targetDuration: 25,
      videoMode: "product_closeup",
    });
    expect(prompt).toContain("商品品类：未识别");
    // no category's visual evidence and no category's preferred hooks leak in
    expect(prompt).not.toContain("【品类视觉证据】");
    expect(prompt).not.toContain("品类优选以下钩子机制");
    expect(prompt).toContain("商品品类未识别，从下列通用钩子机制中选择");
    expect(prompt).not.toMatch(/商品品类：(美妆护肤|食品零食|家居日用|服饰鞋包|数码3C)/);
  });

  it("selects only universal hooks for an unclassified product", async () => {
    const { selectHookPatterns, HOOK_PATTERNS } = await import("@/lib/script-engine/hook-patterns");
    const picked = selectHookPatterns(null, 5);
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.every((p) => !p.categories)).toBe(true);
    // a known category still gets its preferred patterns first
    expect(selectHookPatterns("beauty", 5)[0].categories).toContain("beauty");
    expect(HOOK_PATTERNS.length).toBeGreaterThan(picked.length);
  });
});
