> 历史质量优先方案。用户随后要求兼顾费用；当前默认已调整，见 [均衡选型](llm-model-selection.md)。本页不再代表当前默认配置。

# 文本与视觉默认模型选型（2026-09-17）

适用仓库：CNZSMJ/clipforge，feat/fal-migration。目标为成片质量优先，不是最低成本或最低延迟。

## 决策

- 文本/脚本：Claude Fable 5.1，OpenRouter ID `anthropic/claude-fable-5.1`。
- 视觉/质检：GPT-6 Astra，OpenRouter ID `openai/gpt-6-astra`。
- 维持 Fal OpenRouter 聊天网关及 `Authorization: Key`；不改生图、生视频、配音模型或密钥。

这是依据公开证据和当前代码形态作出的默认推荐，并非在本仓库真实素材上已经证明的全局最优。

## 为什么这样选

仓库文本模型负责编写结构化脚本、镜头描述、营销文案、翻译等。视觉模型负责商品图分析、视频抽帧/联系表分析，以及生成图与参考图的质量对比。当前视觉接口传 `image_url`，不是原生视频文件；不能将 Gemini 的原生视频优势直接等同于本仓库现有收益。

Towards AI 自建 ToneBench 使用真实 YouTube 脚本 brief、风格指南和研究资料，由三个不同模型家族的评审盲评。其当前榜首为 Fable 5.1 **max effort**，89.7/100，人工参考线90.2。指标包括叙事结构、开场、节奏、风格保持和视觉提示，比代码/数学成绩更贴近脚本任务。但它测的是特定英文频道长脚本，不是中文带货分镜，评分也不是全由人类完成。我们采用 high effort 的有界运行配置，不冒用 max effort 的测评分数作为该配置实测成绩。

xbench 2026-09-09 的自测更新中，GPT-6 Astra 在 BabyVision 得分88.92，Gemini 3.7 Flash为73.45，Gemini 3.8 Flash为71.60，Fable5.1为46.39。这支持选择 Astra 做图像观察/视觉推理的候选；BabyVision不是商业片美学、人物身份一致性或商品Logo验收测试，不证明这些任务必然达到某一准确率。

备选：Opus5用于更看重成本与交互速度的脚本；Gemini3.8 Flash用于高吞吐多模态/后续原生视频分析；Gemini3.1 Pro仍为preview，不因“Pro”名称而默认优于更晚模型；Astra也可作为脚本的A/B候选。不同任务的榜首可以不同，未据此声称Claude或GPT在一切任务中更好。

## 兼容与默认生效

1. 新的一键接入及Fal/OpenRouter快速预设使用上述不同的文本/视觉模型。快速预设不得将visionModel重新覆盖为文本模型。
2. 设置版本7仅迁移官方Fal聊天地址上的旧默认 `google/gemini-2.5-flash` 字段。保留不同的手动模型、其他供应商、自建代理、密钥、图/视频模型、配音、预算和项目数据。旧文本默认使用隐式视觉回退时一并迁移。升级后用户主动改回的设置不反复迁移。
3. 仅在官方Fal/OpenRouter聊天地址、且实际请求模型是上述两个ID时，去掉不支持的temperature/top_p/logprob控制，默认high reasoning，隐藏reasoning文本但不禁用推理。
4. 内部旧max_tokens预算提高到至少32,768总completion token，为必需推理留空间；这是上限而非目标输出长度，不能保证永不截断。显式max_completion_tokens和显式reasoning设置保留。
5. 连接测试使用low reasoning及2,048预算，而非完整生成预算。不新增自动付费健康检查，不调用真实账户。
6. 已经要求JSON对象的调用在官方路由开启json_object模式；这不等于严格JSON Schema保证，保留现有解析验证及错误处理。不把应返回数组/普通文字的调用强行转成对象。
7. HTTP/SSE响应原样透传；适配器不重试、不偷偷降级模型、不修改参考图片或提示词。

## 成本与限制

截至调研日，Fable5.1与Astra标准价均约为每百万输入token $10、输出token $50；长上下文、缓存、路由和服务档位另计。Astra的OpenRouter页面存在Flex低价路由，不能当作所有请求的标准价格。两者显著贵于旧Flash默认值；推理token属于计费输出，即使不返回reasoning文本仍会收费。举例：10,000输入+4,000输出按上述标准价为$0.30，尚未计入额外推理等费用。以Fal实际账单为准，仓库原有视频单次spendCap不自动成为LLM的美元硬上限。

模型目录可见、官方API支持、模拟测试通过，与用户Fal账户实际开通和收费实测是四件不同的事。本次未做真实付费推理，也未声称看过改动后的成片。更强LLM不能修复未被抽取的帧、已经丢失的图像细节或生成模型本身的时间漂移。

## 验证

新增回归覆盖默认值、一键配置、快速预设、旧配置迁移、代理隔离、共享SDK的真实请求体、视觉模型路由、推理预算、连接探测、JSON模式及响应透传。最终GitHub Actions对发布的精确源码树执行类型检查、lint、全量测试和生产构建；结果以运行记录为准，不用历史测试数量代替本次结果。

## 一手资料

- Anthropic 当前模型与Fable5.1： https://platform.claude.com/docs/en/models/overview ; https://platform.claude.com/docs/en/models/fable-5-1/overview
- OpenAI Astra能力/输入模态： https://developers.openai.com/api/docs/models/gpt-6-astra
- Google模型目录： https://ai.google.dev/gemini-api/docs/models
- ToneBench发布者与方法： https://benchmark.towardsai.com/
- xbench发布者自测： https://xbench.substack.com/p/leaderboard-update-sept-2026
- Fal兼容网关： https://fal.ai/models/openrouter/router/openai/v1/chat/completions
- OpenRouter模型与价格： https://openrouter.ai/anthropic/claude-fable-5.1 ; https://openrouter.ai/openai/gpt-6-astra ; https://openrouter.ai/api/v1/models
- 推理token与结构化输出： https://openrouter.ai/docs/guides/best-practices/reasoning-tokens ; https://openrouter.ai/docs/guides/features/structured-outputs
