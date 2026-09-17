# Fal migration code review and remediation

Date: 2026-09-17. Repository: `CNZSMJ/clipforge`. Target: `feat/fal-migration` only.
Original feature tip: `01f95ca7ec0f9eb4dfd12b5de45c2596fdd7dbe9`; upstream comparison base: `b9409e95ad9d7b3c9ea0751e1121b3451420c0b6`.

## Scope and acceptance evidence

Reviewed the feature diff and its callers: provider registry, image/video request builders, reference staging, first/last-frame and multi-reference planning, queue polling, image and video task recovery, local asset persistence, grid/film finalization, repair adoption, narration, LLM authentication, persisted settings, browser recovery controls, CLI/MCP/canvas configuration examples, and the media upload entrypoints.

**Local regression result: 1,409 tests passed across 140 test files; 151 tests added compared with the 1,258-test baseline.** TypeScript `tsc --noEmit` passes. ESLint has no errors; existing non-blocking warnings are not treated as a claim of warning-free code. The permanent CI workflow validates the migration branch with locked dependency installation, typecheck, lint, regression tests and production build. The final GitHub Actions run is the authoritative production-build evidence.

**No paid live inference or real-account Fal authentication was executed during this review.** Public schema retrieval, HTTP simulations, real temporary file I/O, real SQLite transactions, and real FFmpeg/ffprobe operations are distinct forms of evidence. Passing these tests does not prove that an account has a particular model enabled, that its balance is sufficient, that every remote endpoint is currently healthy, or that a generated face/product is visually acceptable.

## Findings and fixes

| ID | Severity | Failure mode | Remediation and verification |
|---|---|---|---|
| F01 | P1 | Queue paths reconstructed from a full model variant can miss the real application path; official response URLs were not durably used. | Shared queue transport saves validated official status/result URLs in a backward-compatible task handle. A fresh process can recover; legacy handles derive owner/application paths. Tests exercise refreshed URLs and new provider instances. |
| F02 | P1 | Polling/result errors or cancelled/failed jobs could be confused with success; retrying paid submission can double-charge. | Distinguish definitive failure from recoverable uncertainty. POST inference is never automatically retried; only safe GETs retry/coalesce. Completed-with-error and result 422 are terminal; missing/temporarily unreadable results remain recoverable. |
| F03 | P1 | Upload failure silently falls back to Base64; callers may send local/stale URLs or drop reference conditions. | Upload local media first, require successful CDN completion, then use its returned URL. Upload failure stops before inference. Authoritative staged fields cannot be overwritten by `options`/`extra`. Local paths, symlink escapes, URL credentials and oversized inline data are checked. |
| F04 | P1 | Whole-file buffering and unconstrained parallel I/O can exhaust memory; signed multipart URLs can lose query parameters. | Streaming upload with file metadata checks, credential-scoped cache and in-flight deduplication. CDN-v3 multipart above 90 MiB, 10 MiB parts, at most four active transfers per process. Retain signed queries, ordered completion receipts, timeout/backoff and cancellation on failed parts. API keys go to the control plane, never signed CDN requests. |
| F05 | P1 | Download errors can publish truncated files, mark an unfinished asset done, or trigger another generation. | Stream to unique partial files with backpressure, byte/type/deadline checks, safe GET retries, fsync and atomic publication. Probe media before adoption. Preserve old candidates and keep `download_pending` tasks visible until local persistence succeeds. |
| F06 | P1 | Model names were used as broad capability guesses; request schemas disagree on duration, references, aspect ratio and audio. | Curated endpoint registry checked against public schemas. Correct string/number/seconds duration formats, frame counts, field names, resolutions and array limits. Use only verified sibling endpoints. Unsupported hard conditions fail before billing, not silent degradation. Contract tests cover 20 video and 13 image inputs. |
| F07 | P1 | A hard end-frame constraint could be converted to an unordered reference image; UI claims and actual sent anchors diverged. | Director controls and provider builders use the same capability source. Preserve real first/end-frame semantics; reference-pack deferral is explicit. Do not manufacture reference support for arbitrary endpoint IDs. Refresh/clear extracted tail-frame state rather than reusing a stale clip's tail. |
| F08 | P1 | Partial grid persistence can leave some shots using a new face/outfit and others using the old grid. | Pin the originating script revision in the task mode; crop and validate every cell before one SQLite transaction changes selections. Refuse stale scripts, preserve old takes and deduplicate recovery by task-derived paths. Real FFmpeg/SQLite tests verify all-or-nothing selection and idempotent recovery. |
| F09 | P1 | Cloud film completion was not equivalent to an exportable local composition; retries could duplicate composition rows. | Download/probe video and its required native-audio track, atomically publish a stable task-derived file, then transactionally create/reuse the composition. Missing/corrupt results remain recoverable. Existing valid local films survive CDN expiry without another request. |
| F10 | P1 | Images, character sheets and narration did not all have reliable task recovery; narration retries could submit another paid job. | Tracked image submission records its handle before polling. Character sheet retries retain the original task. Fal narration writes an exclusive pre-submit disk intent and saves the acknowledged handle; retry resumes status/download. Ambiguous intents block automatic resubmission. Cache completion precedes journal removal. |
| F11 | P1 | One-key onboarding omitted or failed to rotate narration credentials; old Atlas keys/settings could be misused. | Versioned settings migration removes retired provider entries and clears incompatible keys; never copies an Atlas key to Fal. Fal one-key configures media, chat and narration, rotates related keys, and preserves independently configured non-Fal narration. |
| F12 | P1 | Fal's OpenAI-compatible chat gateway used the wrong authentication scheme; key probes treated arbitrary non-401 responses as success. | Use `Authorization: Key` on the Fal OpenRouter gateway, keep `Bearer` for ordinary OpenAI-compatible endpoints. A probe returns success only on 2xx; 404/422/429/5xx are inconclusive. Read-only probes do not invoke generation, and authenticated redirects are refused. |
| F13 | P1 | Next proxy body buffering could truncate legal large media before the route's own limits; excluded uploads lacked equivalent CORS handling. | All binary/multipart media entrypoints bypass proxy buffering and apply shared route-local CORS without reading/cloning the body. Trusted local/explicit origins are supported; untrusted cross-origin writes are rejected before side effects. Tests use Next's actual matcher helper. |
| F14 | P2 | CLI/MCP/canvas placeholders and documentation still sent users to Atlas, advertised its catalog and reused its prices. | Replace active configuration examples, remove retired pricing/catalog promises, document cloud-media disclosure, supported contract scope and unknown-price acknowledgement. Atlas references remain only where necessary for migration compatibility/history. |

| F15 | P1 | Retrying the confirmed film workflow regenerated a paid storyboard grid and could resubmit an already acknowledged film. | Persist per-project grid/film stage intents before POST, recover known handles, reuse completed stages and reject ambiguous or changed unfinished plans. Fourteen additional failure/concurrency regressions cover this path. Checkpoints contain no API keys; they supplement, not replace, server journals. |
| F16 | P1 | Test setup preferred an executable static FFmpeg without the `drawtext` filter; the latest CI had two real-render failures despite a passing build. | Select a binary only after verifying `drawtext`, `subtitles` and `showwavespic`; retain real-render assertions and use system FFmpeg when the bundled build is incomplete. Allow the explicit platform ffprobe packages to run their required install step. |
| F17 | P1 | Film dry-run did not receive the options used by the actual request and reconfirmation checked only the prompt. | Send the same video options to preview, verify model/duration/reference count as well as prompt, and bind stage checkpoints to confirmed content/model/options. Read the latest presenter store before deciding whether another identity sheet is needed. |

## Business invariants now enforced

A request for the same character/product is not allowed to silently turn into reference-free generation. First-frame, end-frame and generic reference images are not interchangeable. The model actually chosen after a verified endpoint remap is returned and recorded, rather than reporting the user's originally requested but unused endpoint. Known dialogue durations are rounded up to a legal duration or rejected when impossible, not silently shortened below the requested timeline.

“Generated in the cloud” and “ready to compose locally” are separate states. Download failure does not select a broken file, erase a previous take, mark a paid task finished, or automatically purchase another generation. Recovering an already adopted local film/grid reuses its output instead of duplicating database rows. A presenter-sheet failure stops the subsequent paid grid/film flow rather than silently inventing a different person.

Joint generation and shared reference assets are conditioning mechanisms, **not a mathematical guarantee of visual identity**. Facial geometry, clothing, logos, products, scene layout, temporal motion, lip sync and dialogue fidelity still need shot-level inspection of actual model outputs.

## Transfer limits and operational behavior

| Area | Implemented bound / behavior |
|---|---|
| Fal staged local source | Regular file beneath the uploads directory; nonempty; up to 512 MiB |
| Multipart threshold / part size | Above 90 MiB / 10 MiB |
| Upload/download concurrency | Four active operations per process; bounded pending queues; not a distributed account-wide limiter |
| Upload cache | Credential + canonical path/inode/size/mtime/ctime identity; 15-minute TTL; at most 256 entries; concurrent same-file upload coalescing |
| Upload deadlines | Bounded control-plane and part requests, five-minute active upload deadline; retry only retryable transfer failures |
| Generated output download | Streaming, up to 512 MiB by default, three-minute active deadline, at most three GET attempts |
| Small image/audio buffer consumers | 64 MiB cap; streamed temporary download before the bounded in-memory read |
| Paid inference retries | No automatic POST retry; GET polling and CDN retrieval are separate |
| Queue credentials | Validated configured queue/official queue origins; never attached to CDN upload/download links |

These are safeguards, not a measured throughput or SLA claim. A 90 MiB+ sparse-file transfer regression exercises actual streams and multipart byte accounting against mocked HTTP; it is not an internet bandwidth benchmark. Outbound network policy remains recommended for production: the existing URL/DNS guard is defense in depth, not a claim of a complete hostile-network security audit.

## Recovery and migration instructions

Configure a **real Fal key** in the one-key setup. The chat base is `https://fal.run/openrouter/router/openai/v1`; image/video/TTS use `https://queue.fal.run`. The Fal chat gateway's model-list operation is not assumed available: configure a supported OpenRouter model ID explicitly. Stored configuration success is not proof of account entitlement.

Preserve the local data directory when restarting or upgrading. `ai_tasks` stores image/video handles, and narration intents live under `cache/tts/fal-pending`. For a task in `unknown` or `download_pending`, recover it rather than generating another take. The confirmed film workflow also retains browser checkpoints under `clipforge:film:<project>:grid` and `:render`; preserve these until pending tasks are reconciled. An unknown acknowledgement without a task ID intentionally blocks another paid submit. Browser checkpoints coordinate this workflow within a page, not every tab or independent client. Never delete an uncertain narration intent merely to make an error disappear; reconcile the provider task first.

There is no distributed transaction between Fal acknowledging a paid task and a local database/file write. The normal acknowledged-task paths retain handles and prevent automatic retries; a process/disk failure precisely in that acknowledgement window still requires provider-history reconciliation. Do not describe this as exactly-once billing under every crash. Old Atlas cloud task IDs cannot be replayed against Fal; existing local assets and historical records are retained, but unresolved Atlas tasks must be reconciled separately before retiring that account.

The branch supports a curated, explicitly validated model registry. It does not reproduce Atlas's removed dynamic catalog or promise arbitrary custom models have the same capabilities. Endpoint availability, pricing, optional parameters outside the curated registry and account permissions can change independently of the application.

## Live acceptance checklist (not executed in this review)

Run with an authorized Fal test account and an explicit spend budget:

1. Chat: generate one structured script and analyze one product reference image through the configured Fal chat gateway. Confirm account-level model access and response shape.
2. Images: edit a known product with a character reference; verify the request contains uploaded Fal URLs, then interrupt polling and recover the same request ID. Compare product geometry and text against the source.
3. Video: one native first/end-frame clip and one multi-reference/native-audio clip. Inspect the submitted anchors, actual duration, face/product continuity, end-frame adherence, dialogue and audio track.
4. Film/grid: create a small multi-shot project; interrupt after cloud completion, recover local assets, reopen the project, and confirm the same grid/film versions are adopted without another billable POST.
5. Narration: deliberately fail result retrieval after a successful submission, rerun composition, and verify the original narration request ID is reused. Exercise the supported Chinese/English voices used for delivery.
6. Network/deployment: exercise the supported upload size on the real client/proxy stack, CDN expiry/429 behavior, process restart with persistent storage, disk-full handling, and publish/export QC. Verify every target deployment keeps `APP_DATA_DIR` writable and persistent.

## Primary references

- Fal queue lifecycle and returned request URLs: https://fal.ai/docs/documentation/model-apis/inference/queue
- Fal public endpoint OpenAPI: https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.5%2Fimage-to-video (replace endpoint ID for the other checked-in fixture keys)
- Fal official JavaScript storage implementation: https://github.com/fal-ai/fal-js/blob/main/libs/client/src/storage.ts
- Fal OpenRouter compatible gateway: https://fal.ai/models/openrouter/router/openai/v1/chat/completions
- Fal MiniMax Speech-02 API: https://fal.ai/models/fal-ai/minimax/speech-02-hd/api
- Next proxy buffering: https://nextjs.org/docs/app/api-reference/config/next-config-js/proxyClientMaxBodySize ; the installed Next 16.2.1 documentation was also read before modifying the routes.

## Regression locations

`fal-contracts.test.ts`, `fal-queue-recovery.test.ts`, `fal-media-transport.test.ts`, `fal-ingress.test.ts`, `fal-settings-migration.test.ts`, `fal-tts-recovery.test.ts`, `fal-route-staging.test.ts`, `fal-local-finalization.test.ts`, plus updated existing model/continuity/repair/provider tests. Contracts are checked in under `src/lib/__tests__/fixtures/` so the normal test run is offline and never spends Fal credits.
