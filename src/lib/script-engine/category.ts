/**
 * Product category resolution.
 *
 * The product form used to hardcode \"other\" as the category, and the engine mapped \"other\" to
 * beauty — so a tea product was scripted with the beauty template, beauty hook mechanisms and the
 * beauty visual-evidence block. The vision analysis already asks the model for 所属品类; this module
 * reads that answer, falls back to keywords from the product text, and only then falls back.
 */
import type { ProductCategory } from "./templates";

/** Canonical Chinese labels, matching the analysis prompt and categoryNameMap. */
export const CATEGORY_LABELS: Record<ProductCategory, string> = {
  beauty: "美妆护肤",
  food: "食品零食",
  home: "家居日用",
  fashion: "服饰鞋包",
  tech: "数码3C",
};

const LABEL_TO_KEY: ReadonlyArray<[string, ProductCategory]> = [
  ["美妆护肤", "beauty"],
  ["食品零食", "food"],
  ["家居日用", "home"],
  ["服饰鞋包", "fashion"],
  ["数码3C", "tech"],
  ["数码产品", "tech"],
];

/**
 * Keys the frontend/DB may already hold. Deliberately excludes \"other\": an unknown value must be
 * inferred rather than silently becoming beauty.
 */
const STORED_KEYS: ReadonlyArray<[string, ProductCategory]> = [
  ["beauty", "beauty"],
  ["food", "food"],
  ["home", "home"],
  ["fashion", "fashion"],
  ["tech", "tech"],
  ["digital", "tech"],
  ["3c", "tech"],
];

export type CategorySource = "stored" | "analysis" | "keywords" | "fallback";

/** A stored value the engine can use as-is (null for empty/\"other\"/unknown). */
export function storedCategoryKey(raw: unknown): ProductCategory | null {
  const key = String(raw ?? "").trim().toLowerCase();
  if (!key) return null;
  return STORED_KEYS.find(([k]) => k === key)?.[1] ?? null;
}

/**
 * Read the 所属品类 line out of the vision analysis.
 * Line-scoped on purpose: the analysis text may quote the option list elsewhere, and matching the
 * whole document would then return whichever label happens to appear first.
 */
export function categoryFromAnalysis(analysis?: string): ProductCategory | null {
  if (!analysis) return null;
  for (const line of analysis.split(/\r?\n/)) {
    if (!/(所属)?品类/.test(line)) continue;
    // The answer sits after the colon; the option list sits before it. Matching the whole line
    // would return 美妆护肤 for every model that echoes the choices.
    const value = line.split(/[:：]/).pop() ?? "";
    for (const [label, key] of LABEL_TO_KEY) if (value.includes(label)) return key;
  }
  return null;
}

/** Keyword fallback. Order is priority: a tea set mentioning 杯 must still land on food, not home. */
const KEYWORDS: ReadonlyArray<[ProductCategory, RegExp]> = [
  ["food", /茶|咖啡|零食|饮|酒|坚果|巧克力|饼干|糖果|蜂蜜|麦片|food|tea|coffee|snack|drink/i],
  [
    "beauty",
    /护肤|面膜|精华|口红|粉底|香水|防晒|彩妆|洁面|洗面|慕斯|乳液|面霜|爽肤|卸妆|眼霜|身体乳|洗发|沐浴|牙膏|香氛|眉笔|粉饼|遮瑕|beauty|skincare|cosmetic|serum|lipstick|cleanser|moisturi/i,
  ],
  ["tech", /手机|耳机|电脑|数码|充电|相机|键盘|鼠标|平板|音箱|tech|phone|earbud|laptop|camera|keyboard/i],
  ["fashion", /服饰|衣|裤|裙|恤|衫|鞋|包|帽|围巾|内衣|外套|卫衣|牛仔|袜|fashion|apparel|shoe|bag|shirt|dress|hoodie/i],
  ["home", /家居|厨具|清洁|收纳|床品|毛巾|锅|餐具|家具|home|kitchen|cleaning|furniture/i],
];

export function categoryFromText(...parts: Array<string | undefined>): ProductCategory | null {
  const text = parts.filter(Boolean).join(" ");
  if (!text.trim()) return null;
  for (const [key, re] of KEYWORDS) if (re.test(text)) return key;
  return null;
}

export interface ResolvedCategory {
  category: ProductCategory;
  source: CategorySource;
}

/**
 * Resolution order: what the project already holds -> the vision analysis -> product text keywords.
 * \"other\" is not a category, so it falls through to inference instead of becoming beauty.
 */
export function resolveProductCategory(input: {
  stored?: unknown;
  productName?: string;
  productDescription?: string;
  analysis?: string;
}): ResolvedCategory {
  const stored = storedCategoryKey(input.stored);
  if (stored) return { category: stored, source: "stored" };

  const fromAnalysis = categoryFromAnalysis(input.analysis);
  if (fromAnalysis) return { category: fromAnalysis, source: "analysis" };

  const fromText = categoryFromText(input.productName, input.productDescription, input.analysis);
  if (fromText) return { category: fromText, source: "keywords" };

  // Nothing identifiable: keep the historical default, but the caller can now see WHY it happened.
  return { category: "beauty", source: "fallback" };
}
