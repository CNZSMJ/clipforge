import { nearestFalAspectRatio } from "@/lib/providers/fal-video-params";
import { persistGeneratedFilm } from "@/lib/storyboard-film-persistence";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { scripts, assets, projects } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { createProvider } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/base";
import { GRID_MAX_SHOTS } from "@/lib/storyboard-grid";
import {
  buildStoryboardFilmPrompt,
  dialogueDensityWarnings,
  filmTotalSeconds,
  filmDurationFit,
  referenceQuotaCheck,
  resolveFilmModel,
  estimateFilmSpend,
  FILM_MAX_SECONDS,
} from "@/lib/storyboard-film";
import { toProviderImage } from "@/lib/remote-image";
import { recordAiTask, updateAiTask } from "@/lib/ai-tasks";
import { apiError, errText } from "@/lib/api-error";

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;

/** A shot's usable keyframe IMAGE: an image asset's filePath, or a video asset's preserved keyframe */
function shotKeyframe(asset: { filePath?: string | null; thumbnailPath?: string | null } | undefined): string | undefined {
  if (!asset) return undefined;
  if (asset.filePath && IMAGE_EXT_RE.test(asset.filePath)) return asset.filePath;
  if (asset.thumbnailPath && IMAGE_EXT_RE.test(asset.thumbnailPath)) return asset.thumbnailPath;
  return undefined;
}

/**
 * POST /api/project/[id]/storyboard-film — grid to full film (九宫格→一键整片).
 *
 * Feeds every shot's keyframe (typically the storyboard grid's cropped cells) as
 * reference images into a single reference-to-video generation with a timecoded
 * multi-shot prompt: native cuts between shots, person/product locked across
 * cuts, dialogue spoken verbatim with continuous audio. The result lands in the
 * compositions table, so the export page picks it up like any composed video.
 *
 * body: { scriptId, provider, apiKey, model?, baseUrl?, options? }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!/^[a-zA-Z0-9-]+$/.test(id)) {
      return apiError(req, "无效的项目ID", "Invalid project id", 400);
    }
    const body = await req.json();
    const { scriptId, provider: providerName, model, apiKey, baseUrl, options, characterSheetUrl, dryRun, spendCapUsd, acknowledgeOverCap } = body as {
      scriptId?: string;
      provider?: string;
      model?: string;
      apiKey?: string;
      baseUrl?: string;
      options?: Record<string, unknown>;
      /** Presenter's multi-view sheet — leads reference_images as the identity anchor (@Image1) */
      characterSheetUrl?: string;
      /** Preview only: return the full film prompt + counts + warnings, submit nothing, spend nothing */
      dryRun?: boolean;
      /** Refuse to submit when the estimate exceeds this many USD (0/omitted = no cap) */
      spendCapUsd?: number;
      /** Explicit go-ahead for a generation the cap would otherwise block */
      acknowledgeOverCap?: boolean;
    };
    if (!scriptId) {
      return apiError(req, "缺少 scriptId", "Missing scriptId", 400);
    }

    const db = getDb();
    const [script] = await db
      .select()
      .from(scripts)
      .where(and(eq(scripts.id, scriptId), eq(scripts.projectId, id)));
    if (!script) return apiError(req, "脚本不存在", "Script not found", 404);
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    const renderContext = { videoMode: project?.videoMode, contentType: project?.contentType,
      styleType: script.styleType, creativeIntent: project?.creativeIntent, visualBible: project?.visualBible };
    const shots = Array.isArray(script.shots) ? script.shots : [];
    if (shots.length < 2) {
      return apiError(req, "分镜太少，一键整片至少需要 2 个分镜", "Too few shots — the film pass needs at least 2", 400);
    }
    if (shots.length > GRID_MAX_SHOTS) {
      return apiError(
        req,
        `一键整片最多 ${GRID_MAX_SHOTS} 个分镜（当前 ${shots.length} 个）——长脚本请用逐镜生成+成片合成`,
        `The film pass holds at most ${GRID_MAX_SHOTS} shots (this script has ${shots.length}) — use per-shot generation + compose for longer scripts`,
        400
      );
    }
    const totalSec = filmTotalSeconds(shots);
    if (totalSec > FILM_MAX_SECONDS) {
      return apiError(
        req,
        `脚本总时长 ${Math.round(totalSec)} 秒超过单次生成上限 ${FILM_MAX_SECONDS} 秒——请缩短脚本，或用逐镜生成+成片合成`,
        `Total script duration ${Math.round(totalSec)}s exceeds the ${FILM_MAX_SECONDS}s single-generation cap — shorten the script or use per-shot generation + compose`,
        400
      );
    }

    // the model that will actually be billed — resolved identically on both branches, so the
    // preview names the same model the paid submit uses (issue #28)
    const choice = resolveFilmModel(model);
    const fit = filmDurationFit(shots, choice.model);

    if (dryRun) {
      const prompt = buildStoryboardFilmPrompt(shots, script.characters, { characterSheet: !!characterSheetUrl }, { context: renderContext, seconds: fit.seconds, aspectRatio: nearestFalAspectRatio(Number(options?.width) || 720, Number(options?.height) || 1280) });
      const previewOpts = (options ?? {}) as { width?: number; height?: number };
      const estimate = estimateFilmSpend(await unitPriceUsd(), fit.seconds, previewOpts);
      // planned reference count: one keyframe per shot (+ the identity sheet when present) —
      // computable before the grid pass has actually rendered the keyframes
      const plannedRefs = shots.length + (characterSheetUrl ? 1 : 0);
      return NextResponse.json({
        dryRun: true,
        prompt,
        shotCount: shots.length,
        seconds: fit.seconds,
        model: choice.model,
        ...(choice.swappedFrom && { swappedFrom: choice.swappedFrom }),
        scriptSeconds: fit.scriptSeconds,
        modelMaxSeconds: fit.cap,
        durationOverflow: fit.overflow,
        referenceImages: plannedRefs,
        referenceQuota: referenceQuotaCheck(plannedRefs, choice.model),
        dialogueWarnings: dialogueDensityWarnings(shots),
        // undefined when the platform publishes no price — the UI must say "unknown", not "free"
        ...(estimate && { estimate }),
      });
    }

    // pre-spend duration gate: a script longer than the chosen model can render comes back
    // silently truncated (the provider snaps the request down to its own ceiling), so refuse
    // rather than bill for a film that loses its tail
    if (fit.overflow) {
      return apiError(
        req,
        `脚本总时长 ${fit.scriptSeconds} 秒超过 ${choice.model} 的单次上限 ${fit.cap} 秒——继续会把后半段截掉。请缩短脚本，或换一个支持更长时长的模型`,
        `The ${fit.scriptSeconds}s script exceeds ${choice.model}'s ${fit.cap}s single-generation ceiling — generating would silently cut the tail. Shorten the script or pick a longer-form model`,
        400
      );
    }

    // past the dryRun branch money moves — provider and key become mandatory
    // (dryRun spends nothing, so it needs neither)
    if (!providerName) {
      return apiError(req, "缺少 provider", "Missing provider", 400);
    }
    if (!apiKey) {
      return apiError(req, "缺少 API Key，请先在设置中配置视频平台", "Missing API key — configure a video provider in settings first", 400);
    }

    // every shot needs a keyframe IMAGE (grid cells or per-shot stills) to cite as @ImageN
    const assetRows = await db.select().from(assets).where(and(eq(assets.projectId, id), eq(assets.selected, true)));
    const byShot = new Map(assetRows.map((a) => [a.shotId, a]));
    const keyframes: string[] = [];
    const missing: number[] = [];
    for (const shot of shots) {
      const kf = shotKeyframe(byShot.get(shot.shotId));
      if (kf) keyframes.push(kf);
      else missing.push(shot.shotId);
    }
    if (missing.length > 0) {
      return apiError(
        req,
        `分镜 ${missing.join("、")} 还没有关键帧图——先跑「九宫格分镜」或逐镜生图`,
        `Shots ${missing.join(", ")} have no keyframe image yet — run the storyboard grid or per-shot generation first`,
        400
      );
    }
    // remote providers can't reach localhost: local /api/files keyframes travel as Base64.
    // With a character sheet it leads the array (@Image1 = identity anchor, shots shift to @Image2..)
    const refInputs = [...(characterSheetUrl ? [characterSheetUrl] : []), ...keyframes];
    // pre-spend quota gate: a reference count over the model's schema limit is a guaranteed
    // upstream rejection — block BEFORE the paid submit instead of paying to find out
    const quota = referenceQuotaCheck(refInputs.length, choice.model);
    if (!quota.ok) {
      return apiError(
        req,
        `参考图 ${quota.count} 张超过该模型上限 ${quota.limit} 张——减少分镜数${characterSheetUrl ? "，或去掉定妆照（少一张参考位）" : ""}后再试`,
        `${quota.count} reference images exceed this model's limit of ${quota.limit} — reduce the shot count${characterSheetUrl ? " or drop the presenter sheet (frees one slot)" : ""} and retry`,
        400
      );
    }
    // spend gate: refuse a run whose estimate blows the caller's cap unless they said go anyway.
    // Runs before the submit, so an over-cap generation costs nothing (issue #28).
    const cap = Number(spendCapUsd);
    if (Number.isFinite(cap) && cap > 0 && !acknowledgeOverCap) {
      // compare the HIGH end: a floor-priced estimate is exactly what hid the real bill (issue #28)
      const capOpts = (options ?? {}) as { width?: number; height?: number };
      const estimate = estimateFilmSpend(await unitPriceUsd(), fit.seconds, capOpts);
      if (!estimate) {
        return apiError(req, "当前模型价格未知，无法保证花费上限；请先确认未知价格风险", "The model price is unknown; acknowledge the unknown cost before submitting", 400);
      }
      if (estimate.maxUsd > cap) {
        return apiError(
          req,
          `预估花费最高 $${estimate.maxUsd.toFixed(2)}（${choice.model} $${estimate.unitUsd}/秒 × ${estimate.seconds} 秒；当前分辨率档实测约为基准价的 ${estimate.tierMultiplier} 倍）超过你设置的单次上限 $${cap}——请调高上限、调低分辨率、换更便宜的模型，或缩短脚本`,
          `Estimated up to $${estimate.maxUsd.toFixed(2)} (${choice.model} at $${estimate.unitUsd}/s x ${estimate.seconds}s; this resolution tier measured about ${estimate.tierMultiplier}x the base rate) exceeds your per-run cap of $${cap} — raise the cap, lower the resolution, pick a cheaper model, or shorten the script`,
          400
        );
      }
    }

    const provider = createProvider({ name: providerName, apiKey, baseUrl: baseUrl ?? "" });
    const referenceImageUrls = (await Promise.all(refInputs.map((u) => toProviderImage(u, provider)))).filter(
      (u): u is string => !!u
    );

    const prompt = buildStoryboardFilmPrompt(shots, script.characters, { characterSheet: !!characterSheetUrl }, { context: renderContext, seconds: fit.seconds, aspectRatio: nearestFalAspectRatio(Number(options?.width) || 720, Number(options?.height) || 1280) });
    const duration = fit.seconds;
    // lip-sync guardrail (advisory, never blocks): overstuffed lines drift out of sync near the
    // end of a segment — surfaced so the UI/CLI can suggest trimming before the paid generation
    const dialogueWarnings = dialogueDensityWarnings(shots);

    const opts = (options ?? {}) as { width?: number; height?: number };
    const videoOptions = {
      ...(options ?? {}),
      modelId: choice.model,
      mode: "video-to-video" as const,
      prompt,
      referenceImageUrls,
      duration,
      // portrait 720p unless the caller asked otherwise — maps to resolution+ratio provider-side
      width: opts.width ?? 720,
      height: opts.height ?? 1280,
      // native speech IS the feature: dialogue lives in the prompt, audio must be on
      audioEnabled: true,
    };

    // legacy single-phase path for providers without two-phase task support
    if (!provider.submitVideoTask || !provider.waitForTask) {
      const result = await provider.generateVideo(videoOptions);
      const saved = await persistGeneratedFilm(id, result.videoUrls?.[0], choice.model, result.taskId);
      return NextResponse.json({ ...saved, taskId: result.taskId, modelId: result.modelId, seconds: duration, dialogueWarnings });
    }

    // Phase 1: submit, then persist the paid task ID before polling (issue #16)
    const { taskId, modelId } = await provider.submitVideoTask(videoOptions);
    const rowId = await recordAiTask({
      projectId: id,
      provider: providerName,
      model: modelId,
      mediaType: "video",
      mode: "storyboard-film",
      prompt,
      taskId,
    });

    // Phase 2: wait; a lost poll marks the row "unknown" but never drops the paid task
    try {
      const finalStatus = await provider.waitForTask(taskId, { interval: 5000 });
      const result = finalStatus.result;
      const videoUrl = result && "videoUrls" in result ? result.videoUrls?.[0] : undefined;
      if (!videoUrl) {
        await updateAiTask(rowId, { status: "unknown", error: "任务完成但未返回视频地址" });
        return NextResponse.json(
          { error: errText(req, "任务完成但未返回视频地址", "Task completed but returned no video URL"), taskId, modelId, recoverable: true },
          { status: 502 }
        );
      }
      await updateAiTask(rowId, { status: "download_pending", resultUrls: [videoUrl], error: null });
      const saved = await persistGeneratedFilm(id, videoUrl, modelId, taskId);
      await updateAiTask(rowId, { status: "completed", resultUrls: [saved.url], error: null });
      return NextResponse.json({ ...saved, taskId, modelId, seconds: duration, dialogueWarnings });
    } catch (error) {
      const failed = error instanceof ProviderError && error.code === "TASK_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      await updateAiTask(rowId, { status: failed ? "failed" : "unknown", error: message });
      return NextResponse.json(
        {
          error: failed
            ? message
            : errText(
                req,
                `${message}。任务 ID ${taskId} 已保存，请勿重复提交`,
                `${message}. Task ID ${taskId} has been saved — do not resubmit`
              ),
          taskId,
          modelId,
          recoverable: !failed,
        },
        { status: failed ? 500 : 504 }
      );
    }
  } catch (error) {
    console.error("一键整片生成失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "一键整片生成失败", "Storyboard film failed") },
      { status: 500 }
    );
  }
}

/**
 * Published per-second price for a model, or undefined when we have no price source.
 *
 * Unknown pricing is never a fabricated quote: configured spend caps require explicit
 * acknowledgement before generation. We no longer ship a catalog to read it from, so this reports "unknown".
 */
function unitPriceUsd(): number | undefined {
  return undefined;
}
