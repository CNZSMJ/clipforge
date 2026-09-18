/**
 * Unified export for all category templates
 */

import { beautyTemplates, beautyPromptDirective } from "./beauty";
import { foodTemplates, foodPromptDirective } from "./food";
import { homeTemplates, homePromptDirective } from "./home";
import { fashionTemplates, fashionPromptDirective } from "./fashion";
import { techTemplates, techPromptDirective } from "./tech";

export { beautyTemplates, beautyPromptDirective } from "./beauty";
export { foodTemplates, foodPromptDirective } from "./food";
export { homeTemplates, homePromptDirective } from "./home";
export { fashionTemplates, fashionPromptDirective } from "./fashion";
export { techTemplates, techPromptDirective } from "./tech";

export type { ScriptTemplate } from "./beauty";

/**
 * The category union and its labels live in @/lib/product-category (single source of truth).
 * Re-exported here so existing importers keep working and no second table can drift.
 */
import { CATEGORY_LABELS, type ProductCategory } from "@/lib/product-category";
export type { ProductCategory };
export const categoryNameMap = CATEGORY_LABELS;

/** Lookup table mapping each category to its templates and prompt directive */
const categoryMap = {
  beauty: { templates: beautyTemplates, directive: beautyPromptDirective },
  food: { templates: foodTemplates, directive: foodPromptDirective },
  home: { templates: homeTemplates, directive: homePromptDirective },
  fashion: { templates: fashionTemplates, directive: fashionPromptDirective },
  tech: { templates: techTemplates, directive: techPromptDirective },
} as const;

/** Returns templates and prompt directive for a given category; falls back to beauty for unknown categories to avoid crashes */
export function getTemplatesByCategory(category: ProductCategory) {
  return categoryMap[category] ?? categoryMap.beauty;
}
