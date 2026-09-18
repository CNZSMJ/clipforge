/**
 * LLM Prompt templates
 * System prompts and structured templates for generating e-commerce short-video scripts
 */

import { categoryNameMap, type ProductCategory } from "./templates";
import { categoryOptionsText, resolveProductCategory } from "@/lib/product-category";
import { buildHookGuidance } from "./hook-patterns";
import { COMMERCE_DIRECTION, TOPIC_DIRECTION, TOPIC_HOOK_DIRECTION, buildStoryboardDirection, buildCategoryVisualDirection, buildPlatformDirection } from "./storyboard-direction";
import { cameraPresetGuide } from "@/lib/camera-presets";

// ==================== System Role Prompt ====================

/** System role prompt: professional e-commerce short-video director */
export const SYSTEM_PROMPT = `你是为实际制作负责的短视频编导，目标是创意、信息有效性与可执行画面同时成立。
先理解观众、观看目的和输入事实，再按指定类型组织脚本。让可见细节、因果进展和视觉记忆点承担创意，不以夸张形容词、虚假证言或强促销代替创意。
事实与参考素材是边界：不编造价格、库存、销量、认证、采访、回购、测试、效果或用户经历；图像只能证明可见外观，不能推断未提供的功效。演绎和比喻不能冒充真实证据。
视频模式与用户明确的媒介/人物限制优先于默认套路；保持主体身份、状态递进及场景逻辑。只输出指定 JSON；不添加未消费的策划字段或推理草稿。`;

// ==================== Style Structure Templates ====================

/** Script style type */
export type ScriptStyleType =
  | "pain_point"
  | "scene"
  | "comparison"
  | "story"
  | "drama"
  | "reversal"
  | "interview"
  | "unboxing"
  | "product_pov"
  | "talking_head"
  | "custom";

/** Display name mapping for script styles */
export const styleNameMap: Record<ScriptStyleType, string> = {
  pain_point: "痛点种草",
  scene: "场景安利",
  comparison: "对比测评",
  story: "剧情故事",
  drama: "情景短剧",
  reversal: "反转剧场",
  interview: "街头采访",
  unboxing: "开箱测评",
  product_pov: "物品拟人",
  talking_head: "达人口播",
  custom: "自定义",
};

/**
 * Style form groups (剧情形/物品形/口播形/场景形) — the four mainstream commerce-video forms.
 * Used by pickers to present the style system by form instead of a flat list.
 */
export const styleFormGroups: { form: string; formEn: string; styles: ScriptStyleType[] }[] = [
  { form: "剧情形", formEn: "Drama forms", styles: ["drama", "reversal", "interview", "story"] },
  { form: "物品形", formEn: "Product forms", styles: ["unboxing", "product_pov", "comparison"] },
  { form: "口播形", formEn: "Talking-head forms", styles: ["talking_head", "pain_point"] },
  { form: "场景形", formEn: "Scene forms", styles: ["scene"] },
];

/** Structured prompt directives keyed by style */
export const stylePrompts = COMMERCE_DIRECTION;

// ==================== Video Mode Directives ====================

/** Asset generation strategy keyed by video mode */
export const VIDEO_MODE_DIRECTIVES: Record<string, string> = {
  product_closeup: `
【视频模式：产品特写】
这是一条以商品本身为主角的视频，全程不出现真人。

素材策略（极其重要，严格遵守）：
1. 所有分镜的 visualSource 优先使用 "product_image"（商品原图最真实）
2. 需要场景背景时才用 "ai_generate"，但画面主体必须是产品，绝对不要生成人脸
3. 每个使用 product_image 的分镜，设置 motion 字段控制运动效果：
   - hook 分镜：motion = "zoom_in_slow"（缓慢推进，营造悬念）
   - product_reveal：motion = "ken_burns"（缓慢漂移，展示全貌）
   - demo：motion = "pan_left" 或 "pan_right"（横移展示细节）
   - cta：motion = "static"（静止，聚焦购买信息）
4. 需生成的 prompt 重述商品稳定外观锚、镜头起始构图与环境/光线，不描述人物；以下句式仅为示意，不能覆盖用户媒介
   - 好的 prompt："Premium tissue box on a clean marble surface, soft studio lighting, bokeh background, product photography"
   - 差的 prompt："A woman holding tissue paper"（不要出现人）
5. 可使用 textOverlay 在关键帧上叠加文字（卖点、价格等）

适合的商品：高客单价护肤品、食品、数码产品、家居用品等`,

  graphic_montage: `
【视频模式：图文混剪】
这是一条快节奏的图文混剪视频，用商品图+文字卡片+转场动画吸引注意力。

素材策略：
1. 以 "product_image" 为主，穿插文字卡片
2. 需要准确文字时设置 textOverlay 字段，叠加关键信息：
   - hook：textOverlay.style = "title"，文字大而醒目
   - pain_point：textOverlay.style = "highlight"，强调痛点
   - demo：textOverlay.style = "subtitle"，描述功能
   - cta：有已确认价格时 textOverlay.style = "price"；否则用 "title" 显示真实行动建议
3. 转场要快速密集（建议 ffmpeg_fade 或 direct_concat，不用 AI 转场）
4. 分镜时长要短（每个 2-4 秒），节奏紧凑
5. prompt 中描述简洁的背景和排版风格，不要人物
6. motion 只对现有图片进行平移缩放；允许结果镜 static，不虚构静态图片未拍到的动作

适合的商品：快消品、日用品、零食、平价美妆等`,

  scene_demo: `
【视频模式：场景演示】
这是一条展示产品使用场景的视频，用 AI 生成使用环境，但不生成人脸。

素材策略：
1. product_reveal 和 cta 分镜使用 "product_image"（确保商品真实）
2. hook 和 demo 分镜使用 "ai_generate"，生成使用场景
3. AI 生成的画面必须避免人脸！可以出现：
   - 手部特写（涂抹、使用、操作）
   - 背影/侧影（模糊处理）
   - 只有物品的场景（桌面、浴室、厨房等）
4. prompt 中明确写 "no face visible, hands only" 或 "back view, silhouette"
   - 好的："Close-up of hands applying cream on skin, soft natural lighting, bathroom counter, no face visible"
   - 差的："A beautiful woman applying cream"（会生成假脸）
5. 默认生活使用场景；用户明确指定动画/模型/展陈等媒介时服从该媒介，人物边界不变

适合的商品：护肤品、化妆品、厨房用品、健身器材等`,

  live_presenter: `
【视频模式：真人出镜】
这是一条有真人出镜讲解的视频。

素材策略：
1. 如果提供了出镜人物信息，所有含人物的分镜 prompt 必须包含人物外貌描述
2. product_reveal 和 cta 依然建议使用 "product_image"
3. hook 和 demo 可以使用 "ai_generate" 生成人物场景
4. 也可将 visualSource 设为 "user_upload"，让用户上传自己拍摄的真人素材
5. 如果没有真人素材，建议只在中景/远景使用 AI 人物，避免面部特写（容易失真）

建议：如果用户没有真人素材，优先考虑切换到"产品特写"或"场景演示"模式`,
};

// ==================== Platform SEO Strategy ====================

/** Algorithm optimization directives keyed by distribution platform */
export const PLATFORM_SEO_DIRECTIVES: Record<string, string> = Object.fromEntries(
  ["douyin", "kuaishou", "xiaohongshu", "shipinhao", "tiktok", "reels", "shorts", "youtube"]
    .map((platform) => [platform, buildPlatformDirection(platform, "product")])
);

/** Platform code → human-readable label used in the prompt's "target platform" line. */
const PLATFORM_LABELS: Record<string, string> = {
  douyin: "抖音",
  kuaishou: "快手",
  xiaohongshu: "小红书",
  shipinhao: "视频号",
  tiktok: "TikTok",
  reels: "Instagram Reels",
  shorts: "YouTube Shorts",
  youtube: "YouTube Shorts",
};

/**
 * Derive a readable "target platform" label from the comma-separated platform codes.
 * Falls back to the common domestic default (抖音/快手) when unset or unrecognized, so the
 * commerce prompt no longer tells the LLM "target: Douyin/Kuaishou" while a TikTok directive is
 * injected — a contradiction that degraded overseas / TikTok Shop output. Pure function.
 */
export function platformTargetLabel(platforms?: string): string {
  if (!platforms) return "抖音/快手";
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const raw of platforms.split(",")) {
    const label = PLATFORM_LABELS[raw.trim().toLowerCase()];
    if (label && !seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  }
  return labels.length ? labels.join(" / ") : "抖音/快手";
}

// ==================== Golden-3-Second Strategy ====================

/** Golden-3-second opening strategy library */
export const goldenThreeSecondsStrategies = `【黄金3秒开头策略】
从真实问题、可见细节、可验证对比或有动机的视角选择一个入口；一镜建立与观众的关系，后续镜头兑现。禁止虚构价格差、功效、热度与个人经历。`;

/** Conversion follows the creative promise and production mode, not a compulsory sales stunt. */
export const RETENTION_CONVERSION_RULES = `【留人与转化约束】
- 开头尽早让商品或它解决的任务可识别，不为了藏品牌而藏掉理解线索。
- 中段用新证据、动作后果或视角揭示推进；不强制插一句悬念话，不为了留人扣住答案。
- 先兑现核心承诺再提出一个清晰行动，行动须匹配真实承接入口；无人物模式不添加指向入口的人或手。
- 没有已确认价格、库存、折扣或时间资料就省略促销细节，不编造“个人体感式”紧迫感。
- 台词与画面互补，不把所有镜头变成同一卖点的重复口播；不同风格可以有停顿、安静细节与克制收尾。`;

// ==================== Output Format Constraints ====================

/** JSON output format constraint prompt */
export const OUTPUT_FORMAT_PROMPT = `
【输出格式要求】
请严格按照以下 JSON 格式输出，不要包含任何 markdown 代码块标记或额外文字：

{
  "title": "脚本标题（10字以内，抓人眼球）",
  "totalDuration": 25,
  "characters": [
    {
      "id": "char_a",
      "name": "角色名（如：小美）",
      "gender": "female",
      "persona": "一句话性格（如：毒舌闺蜜，嘴狠心软）",
      "appearance": "稳定外观锚：人物写年龄段/发型/服装/固定饰物；物品声音角色写商品形状/配色/标识位置，不写人类外貌。遵循用户指定媒介；开合、液面、手持等变化状态写进逐镜description，不塞进固定外观锚"
    }
  ],
  "shots": [
    {
      "shotId": 1,
      "type": "hook",
      "duration": 3,
      "description": "画面描述：要足够具体，包含场景布置、人物动作、物品位置、光线氛围等细节",
      "camera": "镜头运动描述（从下方运镜词表中选择或微调，如：镜头围绕主体缓慢环绕半圈，高光沿表面流动）",
      "visualSource": "ai_generate",
      "transition": "direct_concat",
      "voiceover": "配音文案：口语化的播音文案，控制字数与duration匹配（约3字/秒）",
      "prompt": "英文首帧定格：稳定外观锚、场景、光线、构图和主动作开始前状态，不描述完成后的结果",
      "searchTerms": ["english keyword", "alt keyword"],
      "characterId": "声音角色ID（可选，必须在characters中定义；不意味着人物必须入画）",
      "speakerVisible": false
    }
  ],
  "seo": {
    "title": "视频标题（含核心关键词，15字以内）",
    "hashtags": ["#话题标签1", "#话题标签2", "#话题标签3"],
    "coverText": "封面文案（8字以内，吸引点击）",
    "interactionGuide": "互动引导语（引导评论/收藏/关注）",
    "description": "视频描述文案（含关键词，50字以内）"
  }
}

字段规则：
- shotId: 从1开始递增的整数
- type: 只能是 "hook" | "pain_point" | "product_reveal" | "demo" | "social_proof" | "cta" 之一
- duration: 该分镜时长（秒），所有分镜 duration 之和应等于 totalDuration
- description: 中文画面描述，要具体到可以直接拍摄或让AI生成；只写"这一秒画面里谁在做什么"的可见事实（详见下方可生成性判据）
- camera: ${cameraPresetGuide()}
- visualSource: "ai_generate"（AI生成）| "product_image"（使用商品图）| "user_upload"（用户上传）
- transition: "ai_start_end" | "ai_reference" | "direct_concat" | "ffmpeg_fade"
- voiceover: 中文配音文案，字数约等于 duration x 3；可在一处自然换气点写 [pause]（每镜至多 1 处，可不用）——它只做配音气口，不会出现在字幕里，不占字数
- prompt: 英文首帧定格，与 description 的起始状态一致，含本镜所需稳定外观锚、场景、光线与构图；动作进展写在 description，主运镜写在 camera，不能把整个动作过程画成一张拼图
- searchTerms: 1-3 个英文检索词，描述该分镜画面主体（用于从免费素材库自动搜画面，无商品主题成片时尤其关键），如 ["coffee morning", "cozy cafe"]
- characterId: 有具名角色台词时填该声音角色ID，并在 characters 定义；画外旁白可省略。人物入画与发声是两个判断
- speakerVisible: 每镜填布尔值；只有该镜确实显示正在说话的角色才为 true，B-roll/画外音/物品拟人及禁止露脸模式为 false。不因 characterId 存在就设为 true
- characters: 有具名说话角色或跨镜人物时输出；商品声音角色也可定义；gender 只能是 "female" | "male"（声音分配字段）。没有角色则省略或输出空数组
- seo.title: 包含商品名和核心卖点的短标题
- seo.hashtags: 3-5个相关话题标签，第一个为品类大标签
- seo.coverText: 封面上叠加的大字文案
- seo.interactionGuide: 自然的互动引导话术
- seo.description: 发布时的视频描述

【画面动作可生成性（description/prompt 硬判据——AI 视频模型拍不出的动作，写了就是废镜）】
禁四类写法：
1. 两个主体同时做精确配合的交互（对抛接物、击掌碰杯特写）→ 拆成两镜，或改成一方主导另一方静态
2. 内部心理状态（"想起了""意识到""犹豫要不要"）→ 换成可见的外化动作（动作停住、视线移开、手指敲了两下桌面）
3. 否定式动作（"没接住""不理他"）→ 写实际发生的画面（手停在半空、转头看向窗外）
4. 一拍内三步以上的手部动作链（拧盖-倒出-涂抹-拍打）→ 只保留一步主动作，其余拆镜或交给台词/音效交代
改写顺序（发现拍不出时依次尝试）：换动作承担者 → 拆成两镜 → 改成停留/定格 → 交给台词或音效

【分镜设计三硬规则】
1. 商品关键动作只允许一个"主落实镜"：动作只在这一镜完整发生，前面的分镜不得提前出现动作完成后的状态（前一镜出现拆开的包装、后一镜再拍拆包装=穿帮）
2. 相邻镜头以信息进展决定景别/机位；允许同构图的证据对比与首尾回声，不为变化随意改变人物位置
3. 景别由信息决定：这一镜必须被看清的信息在哪个尺度，景别就选哪个尺度（看质地→微距特写；看动作→中景；看氛围→全景）

注意事项：
1. 第一个分镜的 type 必须是 "hook"，最后一个必须是 "cta"
2. totalDuration 服从本次目标总时长，不复制示例中的25
3. 镜数由动作与信息量决定，通常5-8个；有明确参考节奏时保留其镜数，不为凑镜拆碎句子
4. prompt 字段要用英文，风格描述要专业（如 cinematic, soft lighting, macro shot 等）
5. visualSource 为 "product_image" 时，prompt 字段可省略
`;

// ==================== Product Analysis Prompt ====================

/** Product image analysis prompt */
export const PRODUCT_ANALYSIS_PROMPT = `你是一位专业的电商选品分析师。请仔细分析提供的商品图片，提取以下信息：

证据规则：只识别看得清的外观与包装信息；看不清的文字/品牌留空，不补全想象。包装上的功效文字是标示而不是已验证效果；不得由外观推断成分含量、性能、疗效、销量、价格或认证。目标用户/场景属于建议，不混入事实卖点。visualFeatures 用简短可复用的形状、配色、材质与标识位置锚，供逐镜保持一致。

1. 【商品识别】
   - 商品名称/类型
   - 所属品类（${categoryOptionsText()}）
   - 品牌（如果可见）

2. 【视觉特征】
   - 主色调和配色方案
   - 包装设计风格（简约/华丽/可爱/科技感等）
   - 产品形态（固体/液体/粉末/组合等）
   - 材质质感（哑光/亮面/透明/磨砂等）

3. 【卖点提取】
   - 仅可见且可确认的设计/规格细节；无法确认的功效不写入 sellingPoints
   - 包装上的营销文案
   - 产品独特的设计亮点
   - 卖点三硬约束：每条不超过15字；一条只讲一个维度（材质/功效/价格/场景不混写）；禁"品质好""性价比高"类空泛词，必须落到可感知的具体细节

4. 【目标用户推断】
   - 根据产品特征推断目标用户群体
   - 适合的使用场景
   - 可能的痛点和需求

5. 【短视频建议】
   - 推荐的拍摄角度和特写镜头
   - 建议突出的视觉元素
   - 适合的脚本风格（痛点种草/场景安利/对比测评/剧情故事）

请用 JSON 格式输出分析结果：
{
  "productName": "商品名称",
  "category": "beauty|food|home|fashion|tech",
  "brand": "品牌名（未知则留空）",
  "visualFeatures": {
    "mainColor": "主色调",
    "designStyle": "设计风格",
    "productForm": "产品形态",
    "texture": "材质质感"
  },
  "sellingPoints": ["卖点1", "卖点2", "卖点3"],
  "targetAudience": "目标用户描述",
  "usageScenarios": ["场景1", "场景2"],
  "painPoints": ["痛点1", "痛点2"],
  "videoSuggestions": {
    "recommendedAngles": ["角度1", "角度2"],
    "keyVisuals": ["视觉元素1", "视觉元素2"],
    "suggestedStyle": "pain_point|scene|comparison|story|drama|reversal|interview|unboxing|product_pov|talking_head"
  }
}`;

// ==================== Assemble Full Prompt ====================

/** Input parameters for script generation */
export interface ScriptGenerationInput {
  /** product name */
  productName: string;
  /** product category */
  category: ProductCategory;
  /** product description / selling points */
  productDescription?: string;
  /** script style */
  styleType: ScriptStyleType;
  /** target duration in seconds */
  targetDuration?: number;
  /** target audience */
  targetAudience?: string;
  /** product image analysis result */
  productAnalysis?: string;
  /** video mode */
  videoMode?: "product_closeup" | "graphic_montage" | "scene_demo" | "live_presenter";
  /** Existing approved project art direction, serialized without secrets by the route. */
  projectDirection?: string;
  /** user-defined custom requirements */
  customRequirements?: string;
  /** reference script structure (shot pacing/type/conversion logic from a viral template, used for "apply template" generation) */
  referenceStructure?: string;
  /** on-screen character info (live_presenter mode only; injected into prompts to maintain character consistency) */
  character?: {
    id: string;
    name: string;
    appearance: string;
    voiceStyle?: string;
  };
  /** price range */
  priceRange?: string;
  /** distribution platforms (comma-separated: douyin,kuaishou,xiaohongshu) */
  platforms?: string;
  /** product usage and advantages */
  usageAdvantage?: string;
  /** performance-feedback directive (data flywheel): pre-rendered hint that biases style/hook toward what historically converts; empty when there is no data */
  performanceHint?: string;
  /** pin the opening hook mechanism (HOOK_PATTERNS id) — anti-homogenization batch rotation assigns a different one per video */
  preferredHookId?: string;
}

/**
 * Assembles the full user prompt
 * Combines all templates, strategies, and constraints into a single generation instruction
 */
export function buildUserPrompt(input: ScriptGenerationInput): string {
  const {
    productName,
    category,
    productDescription,
    styleType,
    targetDuration = 25,
    targetAudience,
    productAnalysis,
    videoMode = "product_closeup",
    customRequirements,
    character,
    priceRange,
    platforms,
    usageAdvantage,
    performanceHint,
    preferredHookId,
  } = input;

  const categoryName = categoryNameMap[category];

  // fetch style directive
  const styleDirective = styleType === "custom"
    ? `【脚本风格：自定义】\n请根据用户的自定义要求来确定脚本结构和风格。`
    : stylePrompts[styleType];


  // assemble prompt
  const parts: string[] = [];

  parts.push(`请为以下商品创作一条电商短视频带货脚本：`);
  parts.push(`\n【商品信息】`);
  parts.push(`- 商品名称：${productName}`);
  parts.push(`- 商品品类：${categoryName}`);

  if (productDescription) {
    parts.push(`- 商品描述/卖点：${productDescription}`);
  }

  if (targetAudience) {
    parts.push(`- 目标用户：${targetAudience}`);
  }

  if (priceRange) {
    parts.push(`- 价格区间：${priceRange}`);
  }

  if (usageAdvantage) {
    parts.push(`- 用法与优势：${usageAdvantage}`);
  }

  parts.push(`- 目标总时长：${targetDuration}秒`);
  parts.push(`- 画面比例：9:16 竖屏（手机观看）`);
  // Reflect the actual distribution platforms (defaults to 抖音/快手 when unset) instead of a fixed
  // domestic label — otherwise a TikTok / overseas target contradicts the injected platform strategy.
  parts.push(`- 目标平台：${platformTargetLabel(platforms)}`);

  // append product image analysis result
  if (productAnalysis) {
    parts.push(`\n【商品图片分析结果】`);
    parts.push(productAnalysis);
  }

  // inject on-screen character constraints
  if (character && videoMode === "live_presenter") {
    parts.push(`\n【出镜人物】`);
    parts.push(`- 人物名称：${character.name}`);
    parts.push(`- 外貌特征：${character.appearance}`);
    if (character.voiceStyle) {
      parts.push(`- 声音风格：${character.voiceStyle}`);
    }
    parts.push(`- 重要：所有包含人物出镜的分镜，prompt 中必须包含该人物的外貌描述，确保画面一致性`);
    parts.push(`- 在 characters 中使用该人物原ID "${character.id}"；只有该人物发声的 shot 填这个 characterId，不占用其他说话人的ID`);
  }

  // append video mode directive
  parts.push(`\n${VIDEO_MODE_DIRECTIVES[videoMode]}`);

  // inject platform SEO strategy
  if (platforms) {
    const platformList = platforms.split(",");
    // use the first platform as the primary optimization target
    const primaryPlatform = platformList[0].trim().toLowerCase();
    if (PLATFORM_SEO_DIRECTIVES[primaryPlatform]) {
      parts.push(`\n${PLATFORM_SEO_DIRECTIVES[primaryPlatform]}`);
    }
    if (platformList.length > 1) {
      parts.push(`\n【注意】视频同时投放于：${platformList.join("、")}，脚本要兼顾各平台用户习惯`);
    }
  }

  // append category-specific directive
  parts.push(`\n${buildCategoryVisualDirection(category)}`);

  // append style directive
  parts.push(`\n${styleDirective}`);

  // append performance feedback (data flywheel): real published-video conversion data biases
  // the chosen style + opening hook; empty string when the creator has no metrics yet (cold start)
  if (performanceHint) {
    parts.push(`\n${performanceHint}`);
  }

  // append golden-3-second hook guidance (category-preferred patterns + three-beat structure);
  // a pinned hook id (batch anti-homogenization rotation) narrows it to one mandatory mechanism
  parts.push(`\n${buildHookGuidance(category, 5, preferredHookId)}`);

  // append type-appropriate payoff and truthful conversion rules
  parts.push(`\n${RETENTION_CONVERSION_RULES}`);

  // One shared production protocol; no extra planning call or unpersisted bible fields.
  parts.push(buildStoryboardDirection({ contentType: "product", targetDuration, videoMode }));
  if (input.referenceStructure) {
    parts.push(`\n【参考爆款结构】\n仅借鉴镜数、时长和信息顺序，不假定参考片的效果已验证；内容、台词、道具和视觉构思必须针对本商品重新创作。事实与模式限制优先，禁止照搬证言/数据。\n${input.referenceStructure}`);
  }

  if (input.projectDirection) parts.push(`\n【已批准项目视觉方向】\n将这些约束落实到逐镜描述/首帧；人物与素材边界优先，不把一个全局动作重复套到所有镜头。\n${input.projectDirection}`);

  // append custom requirements
  if (customRequirements) {
    parts.push(`\n【用户额外要求】`);
    parts.push(customRequirements);
  }

  // append output format constraints
  parts.push(`\n${OUTPUT_FORMAT_PROMPT}`);

  // Language follows the product info language: English products (overseas TikTok Shop/Amazon)
  // should produce English scripts/voiceovers; otherwise the OUTPUT_FORMAT's "Chinese voiceover"
  // instruction would cause English products to output Chinese narration (wrong video body).
  // Placed last for maximum prominence, overrides any "中文" wording in the spec above.
  // Same technique used in the topic path (buildTopicPrompt).
  const productText = `${productName || ""} ${productDescription || ""} ${usageAdvantage || ""}`;
  if (productText.trim() && !/[一-鿿]/.test(productText)) {
    parts.push(
      `\n【LANGUAGE — IMPORTANT, overrides any "中文" wording above】The product info is NOT in Chinese. Write every "title" and "voiceover" field in the SAME language as the product (e.g. natural English for an overseas TikTok Shop audience), never Chinese. Keep "searchTerms" in English as usual; "description"/"camera" may be concise English.`
    );
  }

  return parts.join("\n");
}

/**
 * Builds multiple creative treatments within the requested style in one call
 */
export function buildBatchPrompt(input: ScriptGenerationInput, count: number = 3): string {
  const basePrompt = buildUserPrompt(input);

  return `${basePrompt}

【批量生成要求】
请生成 ${count} 个不同切入角度的脚本方案，但保持选定风格、视频模式、事实与人物参考不变。各方案至少改变观察视角、证据顺序、声画关系或视觉记忆点中的两项；不是只换开场近义词。每个方案独立闭合，不把答案留给另一方案。

输出格式改为：
{
  "scripts": [
    { "title": "...", "totalDuration": ..., "characters": [...], "shots": [...], "seo": {...} },
    { "title": "...", "totalDuration": ..., "characters": [...], "shots": [...], "seo": {...} }
  ]
}

请确保输出 ${count} 个脚本方案。`;
}

// ==================== Topic Video (product-free) ====================
//
// "One-line topic video": the user provides only a one-line topic (e.g. "how to brew pour-over
// coffee at home", "the romance of city nights"). No product is involved; the engine produces a
// short-video script with voiceover and shot pacing, each shot carrying English search keywords
// (stockKeywords), which stock-fill then uses to source footage from free libraries → compose video.
// Difference from commerce scripts: no product/selling points/purchase pressure;
// visualSource is ai_generate throughout (backed by free stock footage); expression over conversion.

/** System role for topic videos: general short-video content director (knowledge/lifestyle/story/emotion) */
export const TOPIC_SYSTEM_PROMPT = `你是内容短视频编导。依据知识、故事、生活、励志或旅行的不同观看目的设计可见的分镜，开场与结尾相互兑现。
这条内容没有商业转化任务，不新增商品、优惠、证言或下单引导。保持事实可核对，不伪造研究、地理、个人经历和名人名言。
优先使用真实可检索的画面；searchTerms 必填英文且与画面主体对应。没有同源素材就不假设不同人的脸和不同地点能够保持连续。
每镜一个信息/情绪进展，视觉细节和声画关系承担创意，风格服从用户要求；只输出指定 JSON，不输出推理过程。`;

/** Narration style for topic videos */
export type TopicNarrationStyle = "knowledge" | "story" | "lifestyle" | "inspiration" | "travel";

/** Display name mapping for narration styles */
export const topicNarrationNameMap: Record<TopicNarrationStyle, string> = {
  knowledge: "知识科普",
  story: "情感故事",
  lifestyle: "生活方式",
  inspiration: "励志金句",
  travel: "旅行风光",
};

/** Creative directives for each narration style */
const topicStylePrompts = TOPIC_DIRECTION;

/** Output format constraints for topic videos (reuses the Shot structure but removes product/purchase pressure, and requires searchTerms on every shot) */
const TOPIC_OUTPUT_FORMAT_PROMPT = `
【输出格式要求】
请严格按照以下 JSON 格式输出，不要包含任何 markdown 代码块标记或额外文字：

{
  "title": "脚本标题（10字以内，抓人眼球）",
  "totalDuration": 25,
  "shots": [
    {
      "shotId": 1,
      "type": "hook",
      "duration": 3,
      "description": "中文画面描述：这一镜呈现什么画面（场景/动作/物件/光线），要具体可检索",
      "camera": "镜头运动描述：特写/中景/全景 + 推拉摇移",
      "visualSource": "ai_generate",
      "transition": "direct_concat",
      "voiceover": "中文旁白文案，字数约等于 duration × 3",
      "searchTerms": ["english keyword", "alt keyword"]
    }
  ]
}

字段规则：
- shotId: 从1开始递增的整数
- type: 第一个分镜用 "hook"，中间分镜用 "demo"，最后一个用 "cta"（此处表示内容闭合，不是带货）
- duration: 该分镜时长（秒），所有分镜 duration 之和应等于 totalDuration
- description: 中文画面描述，具体到可以直接检索或拍摄
- camera: 中文镜头运动描述
- visualSource: 固定为 "ai_generate"
- transition: "direct_concat" | "ffmpeg_fade" 之一（主题成片节奏明快，建议这两种）
- voiceover: 中文旁白文案，字数约等于 duration × 3
- searchTerms: 【必填】1-3 个英文检索词，精准描述该分镜画面主体，如 ["pour over coffee", "coffee beans closeup"]。每个分镜都必须有，否则无法自动配画面

注意事项：
1. 第一个分镜 type 必须是 "hook"，最后一个必须是 "cta"（内容闭合）
2. totalDuration 服从本次目标总时长，不复制示例中的25
3. 镜数由内容决定，通常5-9个；让动作与停顿占到必要时间
4. 全程不得出现任何商品、卖点、价格、购买/下单引导
5. 每个分镜的 searchTerms 都不能省略，用常见、具象的英文词以保证素材库能搜到画面
`;

/** Input for topic video script generation */
export interface TopicScriptInput {
  /** one-line topic */
  topic: string;
  /** narration style, defaults to knowledge */
  narrationStyle?: TopicNarrationStyle;
  /** target duration in seconds, defaults to 25 */
  targetDuration?: number;
  /** distribution platforms (comma-separated), used to inject platform SEO strategy (optional) */
  platforms?: string;
  /** Existing approved project art direction (same planning/rendering constraints). */
  projectDirection?: string;
  /** additional user requirements (optional) */
  customRequirements?: string;
}

/** Assembles the user prompt for topic video generation */
export function buildTopicPrompt(input: TopicScriptInput): string {
  const {
    topic,
    narrationStyle = "knowledge",
    targetDuration = 25,
    platforms,
    customRequirements,
  } = input;

  const styleDirective = topicStylePrompts[narrationStyle] ?? topicStylePrompts.knowledge;

  const parts: string[] = [];
  parts.push(`请围绕以下主题创作一条竖屏短视频脚本（这是一条没有商品的内容向视频）：`);
  parts.push(`\n【主题】\n${topic}`);
  parts.push(`\n【基本要求】`);
  parts.push(`- 旁白风格：${topicNarrationNameMap[narrationStyle] ?? "知识科普"}`);
  parts.push(`- 目标总时长：${targetDuration}秒`);
  parts.push(`- 画面比例：9:16 竖屏（手机观看）`);

  // narration style directive
  parts.push(`\n${styleDirective}`);

  parts.push(TOPIC_HOOK_DIRECTION);
  parts.push(buildStoryboardDirection({ contentType: "topic", targetDuration }));
  parts.push(buildPlatformDirection(platforms, "topic"));
  if (input.projectDirection) parts.push(`\n【已批准项目视觉方向】\n${input.projectDirection}`);

  if (customRequirements) {
    parts.push(`\n【用户额外要求】\n${customRequirements}`);
  }

  parts.push(`\n${TOPIC_OUTPUT_FORMAT_PROMPT}`);

  // Language follows the topic language: English topics should produce English voiceovers/titles
  // (otherwise the "Chinese voiceover" wording in the JSON spec above would cause English topics
  // to produce Chinese narration — wrong video body). Placed last for maximum prominence,
  // overrides any "中文" wording in the spec.
  if (!/[一-鿿]/.test(topic)) {
    parts.push(
      `\n【LANGUAGE — IMPORTANT, overrides any "中文" wording above】The topic is NOT in Chinese. Write every "title" and "voiceover" field in the SAME language as the topic (e.g. natural English), never Chinese. Keep "searchTerms" in English as usual; "description"/"camera" may be concise English.`
    );
  }

  return parts.join("\n");
}

/** Batch-generates multiple topic video scripts with different angles */
export function buildTopicBatchPrompt(input: TopicScriptInput, count: number = 3): string {
  const basePrompt = buildTopicPrompt(input);
  return `${basePrompt}

【批量生成要求】
请生成 ${count} 个不同切入角度的脚本方案，每个方案的开头钩子、叙事顺序、画面选择都要有明显差异。

输出格式改为：
{
  "scripts": [
    { "title": "...", "totalDuration": ..., "shots": [...] },
    { "title": "...", "totalDuration": ..., "shots": [...] }
  ]
}

请确保输出 ${count} 个脚本方案，且每个分镜都带 searchTerms。`;
}

// ==================== Backward-Compatible Legacy Interface ====================

/**
 * Legacy script prompt builder (kept for backward compatibility)
 * @deprecated Use buildUserPrompt instead
 */
export function buildScriptPrompt(params: {
  productName: string;
  productCategory?: string;
  productDescription?: string;
  productAnalysis?: string;
  styleType: string;
  duration: number;
  templateHint?: string;
}): string {
  // one resolution chain for the whole codebase - no local "unknown -> beauty" mapper
  const category = resolveProductCategory({
    stored: params.productCategory,
    productName: params.productName,
    productDescription: params.productDescription,
    analysis: params.productAnalysis,
  }).category;

  return buildBatchPrompt({
    productName: params.productName,
    category,
    productDescription: params.productDescription,
    productAnalysis: params.productAnalysis,
    styleType: (params.styleType as ScriptStyleType) || "pain_point",
    targetDuration: params.duration,
    customRequirements: params.templateHint,
  });
}

