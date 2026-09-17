import "server-only";

import type OpenAI from "openai";
import { createLLMClient, jsonModeParams, withLLMErrors } from "@/lib/llm-error";
import type { LLMConfig } from "@/lib/script-engine/generator";
import {
  buildQualityEvaluationPrompt,
  parseGenerationQuality,
  type GenerationQualityReport,
  type ShotQualityContract,
} from "@/lib/generation-quality";

/** Evaluate one generated output through the user's configured OpenAI-compatible vision model. */
export async function evaluateGenerationQuality(input: {
  contract: ShotQualityContract;
  outputImageDataUrl: string;
  referenceImageUrls?: string[];
  locale: "zh" | "en";
  config: LLMConfig;
  sampleContext?: string;
  maxRetries?: number;
}): Promise<GenerationQualityReport> {
  if ((input.referenceImageUrls?.length ?? 0) > 8) throw new Error("At most 8 review references are supported; none may be silently dropped");
  const model = input.config.visionModel || input.config.model;
  const baseClient = createLLMClient({ ...input.config, model });
  const client = input.maxRetries === undefined ? baseClient : baseClient.withOptions({ maxRetries: input.maxRetries });
  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: "text", text: buildQualityEvaluationPrompt(input.contract, input.locale, input.sampleContext) },
    { type: "image_url", image_url: { url: input.outputImageDataUrl, detail: "high" } },
    ...(input.referenceImageUrls ?? []).map((url): OpenAI.Chat.Completions.ChatCompletionContentPart => ({
      type: "image_url",
      image_url: { url, detail: "high" },
    })),
  ];
  const response = await withLLMErrors(
    () => client.chat.completions.create({
      model,
      messages: [{ role: "user", content }],
      temperature: 0.1,
      max_tokens: 3500,
      ...jsonModeParams(input.config.baseUrl),
    }),
    { ...input.config, model },
  );
  return parseGenerationQuality(response.choices[0]?.message?.content || "", input.contract);
}
