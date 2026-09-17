import type { Shot } from "@/lib/db/schema";
import type { ImageOptions } from "@/lib/providers/types";
import type { FrameContext, FrameWorkspace, FrameCompilation } from "@/lib/keyframe-direction";
import type { GenerationQualityReport } from "@/lib/generation-quality";
/** No API keys or staged/signed provider URLs are persisted in the direction contract. */
export interface FrameRenderRequest {
  compilation: FrameCompilation; options: ImageOptions; planKey: string; baseUrl: string;
}
export interface FrameTake {
  id: string; shotId: number; url: string; selected: boolean; status: string;
  sourceKey?: string; renderId?: string; review?: GenerationQualityReport | null;
}
export interface FrameWorkspaceView {
  revision: number; sourceKey: string; shotKeys: Record<number, string>; workspace: FrameWorkspace; context: FrameContext;
  shots: Shot[]; scriptId: string; takes: FrameTake[];
  pending: Array<{ id: string; shotId: number; status: string; taskId: string | null; provider: string; model: string; error: string | null }>;
}
