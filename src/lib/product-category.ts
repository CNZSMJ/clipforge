/**
 * Product category — THE single source of truth.
 *
 * Why this module exists: the category used to be defined and parsed in five places that drifted
 * apart (templates/index.ts held the type + one label map, script-engine/category.ts grew a second
 * label map, three i18n namespaces carried their own Chinese labels, prompts.ts hardcoded the label
 * list inside the analysis prompt, and four different normalizers disagreed on what "other" meant).
 * A project created from an uploaded photo stored "other", one normalizer turned that into beauty,
 * and a tea product was scripted with the beauty template.
 *
 * Rules for this file:
 *  - the key union lives here, once
 *  - the Chinese label list lives here, once; anything that needs it derives from CATEGORY_LABELS
 *  - parsers are exported from here; no other module may define its own category normalizer
 *  - an unknown category is null, never a silent guess
 */

/** Canonical engine keys, in display order. */
export const PRODUCT_CATEGORIES = ["beauty", "food", "home", "fashion", "tech"] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

/** Canonical Chinese labels. Derived by the analysis prompt, the UI options and the i18n guard. */
export const CATEGORY_LABELS: Record<ProductCategory, string> = {
  beauty: "美妆护肤",
  food: "食品零食",
  home: "家居日用",
  fashion: "服饰鞋包",
  tech: "数码3C",
};

/** English labels for logs and docs. User-facing English lives in i18n and must agree (test-guarded). */
export const CATEGORY_LABELS_EN: Record<ProductCategory, string> = {
  beauty: "Beauty & Skincare",
  food: "Food & Snacks",
  home: "Home & Living",
  fashion: "Fashion & Accessories",
  tech: "Electronics & 3C",
};

export function isProductCategory(value: unknown): value is ProductCategory {
  return typeof value === "string" && (PRODUCT_CATEGORIES as readonly string[]).includes(value);
}

/** Options for a UI select (one entry per canonical key). */
export const PRODUCT_CATEGORY_OPTIONS: ReadonlyArray<{ value: ProductCategory; label: string }> =
  PRODUCT_CATEGORIES.map((value) => ({ value, label: CATEGORY_LABELS[value] }));

/** The \"美妆护肤/食品零食/…\" string used by the analysis prompt — built from the labels above. */
export function categoryOptionsText(): string {
  return PRODUCT_CATEGORIES.map((c) => CATEGORY_LABELS[c]).join("/");
}

/**
 * Values other layers may legitimately hold for the same category. Deliberately NOT including
 * \"other\": unknown is represented as null so there is exactly one way to say \"unknown\".
 */
const STORED_ALIASES: ReadonlyArray<[string, ProductCategory]> = [
  ...PRODUCT_CATEGORIES.map((c) => [c, c] as [string, ProductCategory]),
  ["digital", "tech"], // an older frontend used \"digital\" for 3C
  ["3c", "tech"],
  ["electronics", "tech"],
];

/** Map a stored/raw value to a canonical key, or null when it is not a category. */
export function storedCategoryKey(raw: unknown): ProductCategory | null {
  const key = String(raw ?? "").trim().toLowerCase();
  if (!key) return null;
  return STORED_ALIASES.find(([alias]) => alias === key)?.[1] ?? null;
}

/** label -> key, derived from CATEGORY_LABELS so a new label can never be a separate list. */
const LABEL_TO_KEY: ReadonlyArray<[string, ProductCategory]> = PRODUCT_CATEGORIES.map((c) => [
  CATEGORY_LABELS[c],
  c,
]);

/**
 * Read the 所属品类 answer out of the vision analysis.
 * Line-scoped and colon-scoped on purpose: the prompt prints the option list before the colon, so
 * matching the whole line would return 美妆护肤 for every model that echoes the choices back.
 */
export function categoryFromAnalysis(analysis?: string): ProductCategory | null {
  if (!analysis) return null;
  for (const line of analysis.split(/\r?\n/)) {
    if (!/(所属)?品类/.test(line)) continue;
    const value = line.split(/[:：]/).pop() ?? "";
    for (const [label, key] of LABEL_TO_KEY) if (value.includes(label)) return key;
  }
  return null;
}

/**
 * Keyword fallback over the product text. Order is priority: a tea set that mentions 杯 must still
 * land on food rather than home. This table is intentionally the only heuristic list in the codebase.
 */
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

export type CategorySource = "stored" | "analysis" | "keywords" | "fallback";

export interface ResolvedCategory {
  category: ProductCategory;
  source: CategorySource;
}

/**
 * The one resolution chain: stored value -> the 所属品类 line the vision analysis already produced ->
 * product-text keywords -> explicit fallback (reported to the caller, never silent).
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

  return { category: "beauty", source: "fallback" };
}
