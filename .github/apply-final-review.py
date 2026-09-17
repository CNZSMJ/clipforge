"""Apply the reviewed final integration changes, preserving unrelated concurrent work.
This temporary authoring utility deletes itself and its workflow from the verified tree.
"""
import json
import pathlib
import subprocess

p = pathlib.Path('src/app/project/[id]/script/page.tsx')
expected = '2ff250ab9fcdeb6c613282dc7523af22a4895fb8'
actual = subprocess.check_output(['git', 'hash-object', str(p)], text=True).strip()
if actual != expected:
    raise SystemExit('Script page changed concurrently; reconcile before applying final review')
s = p.read_text()
def replace_once(old, new):
    global s
    if s.count(old) != 1:
        raise SystemExit('Expected one reviewed replacement: ' + old[:100])
    s = s.replace(old, new, 1)
replace_once('import { ProjectHeader }', 'import { runPaidStage } from "@/lib/paid-stage";\nimport { ProjectHeader }')
replace_once('        model: useSettingsStore.getState().defaultVideoModel,\n', '        model: useSettingsStore.getState().defaultVideoModel,\n        options: buildVideoOptions({ ...useSettingsStore.getState().videoParams, aspectRatio: "9:16" }),\n')
replace_once('if (fresh.prompt !== filmPreview.prompt)', 'if (fresh.prompt !== filmPreview.prompt || fresh.model !== filmPreview.model || fresh.seconds !== filmPreview.seconds || fresh.referenceImages !== filmPreview.referenceImages)')
replace_once('      const presenter = presenterLib.find((c) => c.id === presenterParam);\n      let sheet = presenter?.referenceImages?.[0];', '      const presenter = useCharacterStore.getState().characters.find((c) => c.id === presenterParam);\n      let sheet = presenter?.referenceImages?.[0];')
start = s.index('      // 1) storyboard grid: ONE image')
end = s.index('      // 3) the film landed', start)
s = s[:start] + '''      // Checkpoint every paid stage. Retrying a film MUST NOT regenerate the grid, and a
      // known pending handle must be finalized through the task endpoint, not submitted again.
      const recoverStage = (target: typeof imgTarget, taskId: string) => fetch("/api/ai/video/task", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: target.provider, apiKey: target.apiKey, baseUrl: target.baseUrl, taskId, wait: true }),
      });
      const gridModel = sheet || productRef ? toEditVariant(imgTarget.model) : imgTarget.model;
      const imageOptions = buildImageOptions({ ...s.imageParams, aspectRatio: "9:16", count: 1 });
      const videoOptions = buildVideoOptions({ ...s.videoParams, aspectRatio: "9:16" });
      // No credentials in these browser checkpoints. Changing the confirmed content invalidates
      // completed work; pending/ambiguous old work is never silently discarded.
      const gridSignature = JSON.stringify([currentScript.id, fresh.prompt, sheet, productRef,
        imgTarget.provider, imgTarget.baseUrl, gridModel, imageOptions]);
      setAiFilmStage(t("aiFilmGrid"));
      await runPaidStage({
        storage: localStorage, key: `clipforge:film:${id}:grid`, signature: gridSignature,
        submit: () => fetch(`/api/project/${id}/storyboard-grid`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scriptId: currentScript.id, provider: imgTarget.provider, model: gridModel,
            apiKey: imgTarget.apiKey, baseUrl: imgTarget.baseUrl,
            ...(sheet && { characterSheetUrl: sheet }), ...(productRef && { productImageUrl: productRef }), options: imageOptions }),
        }),
        recover: (taskId) => recoverStage(imgTarget, taskId),
        isComplete: (data) => typeof data.gridPath === "string" || (data.status === "completed" && Boolean(data.grid)),
      });
      setAiFilmStage(t("aiFilmRender"));
      await runPaidStage({
        storage: localStorage, key: `clipforge:film:${id}:render`,
        signature: JSON.stringify([gridSignature, vidTarget.provider, vidTarget.baseUrl, filmPreview.model, videoOptions]),
        submit: () => fetch(`/api/project/${id}/storyboard-film`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scriptId: currentScript.id, provider: vidTarget.provider, model: filmPreview.model,
            spendCapUsd: s.spendCapUsd, acknowledgeOverCap: overCapAck, apiKey: vidTarget.apiKey,
            baseUrl: vidTarget.baseUrl, ...(sheet && { characterSheetUrl: sheet }), options: videoOptions }),
        }),
        recover: (taskId) => recoverStage(vidTarget, taskId),
        isComplete: (data) => typeof data.compositionId === "string" && Boolean(data.compositionId),
      });
''' + s[end:]
p.write_text(s)
if subprocess.check_output(['git', 'hash-object', str(p)], text=True).strip() != 'd8ae7d27dcaee569215b1573411f2a0e5db2deda':
    raise SystemExit('Final script-page bytes differ from the locally typechecked and tested revision')

platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm', 'linux-arm64', 'linux-ia32', 'linux-x64', 'win32-ia32', 'win32-x64']
p = pathlib.Path('package.json')
data = json.loads(p.read_text())
allowed = data['pnpm']['onlyBuiltDependencies']
for platform in platforms:
    name = '@ffprobe-installer/' + platform
    if name not in allowed:
        allowed.append(name)
p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
p = pathlib.Path('pnpm-workspace.yaml')
s = p.read_text()
for platform in platforms:
    name = '@ffprobe-installer/' + platform
    if name not in s:
        s += '  - "' + name + '"\n'
p.write_text(s)

p = pathlib.Path('docs/fal-migration-review.md')
s = p.read_text()
pos = s.index('\n## Business invariants now enforced')
s = s[:pos] + '''
| F15 | P1 | Retrying the confirmed film workflow regenerated a paid storyboard grid and could resubmit an already acknowledged film. | Persist per-project grid/film stage intents before POST, recover known handles, reuse completed stages and reject ambiguous or changed unfinished plans. Fourteen additional failure/concurrency regressions cover this path. Checkpoints contain no API keys; they supplement, not replace, server journals. |
| F16 | P1 | Test setup preferred an executable static FFmpeg without the `drawtext` filter; the latest CI had two real-render failures despite a passing build. | Select a binary only after verifying `drawtext`, `subtitles` and `showwavespic`; retain real-render assertions and use system FFmpeg when the bundled build is incomplete. Allow the explicit platform ffprobe packages to run their required install step. |
| F17 | P1 | Film dry-run did not receive the options used by the actual request and reconfirmation checked only the prompt. | Send the same video options to preview, verify model/duration/reference count as well as prompt, and bind stage checkpoints to confirmed content/model/options. Read the latest presenter store before deciding whether another identity sheet is needed. |
''' + s[pos:]
s = s.replace('For a task in `unknown` or `download_pending`, recover it rather than generating another take.', 'For a task in `unknown` or `download_pending`, recover it rather than generating another take. The confirmed film workflow also retains browser checkpoints under `clipforge:film:<project>:grid` and `:render`; preserve these until pending tasks are reconciled. An unknown acknowledgement without a task ID intentionally blocks another paid submit. Browser checkpoints coordinate this workflow within a page, not every tab or independent client.')
p.write_text(s)
for name in ['apply-fal-review.yml', 'review-snapshot.yml', 'final-fal-verification.yml']:
    pathlib.Path('.github/workflows', name).unlink(missing_ok=True)
pathlib.Path(__file__).unlink()
