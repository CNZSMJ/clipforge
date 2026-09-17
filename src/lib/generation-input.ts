import type { AIProvider } from "./providers/types";
import { toProviderImage } from "./remote-image";

/** Do not silently filter/truncate identity anchors: that changes the approved shot. */
export function mediaReferences(value: unknown, maximum: number, label: string): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > maximum || value.some(u => typeof u !== "string" || !u.trim())) {
    throw new Error(`${label}: expected at most ${maximum} nonempty media URLs`);
  }
  return value.length ? value as string[] : undefined;
}

export function generationOptions(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("options must be an object");
  return value as Record<string, unknown>;
}

export async function stageReferences(value: unknown, maximum: number, label: string, provider: AIProvider) {
  const urls = mediaReferences(value, maximum, label);
  return urls ? Promise.all(urls.map(async u => {
    const staged = await toProviderImage(u, provider);
    if (!staged) throw new Error(`${label}: media upload returned no URL`);
    return staged;
  })) : undefined;
}
