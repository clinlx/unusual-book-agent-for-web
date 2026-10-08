'use strict';
/* ═══════════════════ 扩展配置区（改代码即可定制，GUI 无入口） ═══════════════════ */
const AGENT_CONFIG = {
  name: '世界设计者',
  maxToolLoops: 50,
  // 单次 read_file 的默认返回上限。参考资料动辄几千字，上限太小会逼模型
  // 反复 offset 续读——每次续读都是一轮完整的 API 往返，很快吃光 maxToolLoops。
  readCharLimit: 32000,
  // /skills/ 下的参考资料按整篇理解才有意义，截断会让流程读到一半就下判断，
  // 故单独给更高的默认上限。
  skillReadCharLimit: 64000,
  // 模型显式传 limit 时允许的绝对上限（防止一次把上下文塞满）
  readCharLimitMax: 120000,
  writeCharLimit: 16000,
  searchResultLimit: 100,
  // 超长用户输入：≥ 该字数则转存 /tmp/{uuid}.txt，注入时改为「头尾预览 + 文件引用」
  longInputChars: 16384,
  // 注入给 AI 的折叠格式：保留开头与结尾各多少字
  longInputHeadChars: 512,
  longInputTailChars: 512,
  // 对话气泡（UI 侧）折叠阈值与折叠后预览长度
  bubbleFoldChars: 4096,
  bubblePreviewChars: 1024,
  // 临时文件在连续 N 个轮次未被读取后清理；被读取则重新计时
  tmpTTLTurns: 10,
  tmpMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  tmpMaxBytes: 100 * 1024 * 1024,
  // 【用户可编辑的部分】只写人设与工作方式，不含任何占位符。
  // 工具说明、目录约定、Skill 清单由程序自动追加在其后，用户无需（也不该）操心。
  systemPrompt: [
    '你在浏览器里的工作台中，通过工具读写虚拟文件系统，帮用户完成任务。',
    '',
    '## 工作方式',
    '',
    '改已有文件前先读一遍；新建内容前先看目录里已有什么、如何命名。',
    '任务大时先说清分几步、这次做到哪一步，再开始做。',
    '能从上下文推断的直接做，用一句话说明选择和理由。',
    '',
    '## 判断与反馈',
    '',
    '始终把正确、符合逻辑、实事求是的判断传递给用户。',
    '不谄媚，不用鼓励和夸赞去照顾用户情绪；每一句肯定都要先经过逻辑审视，站不住就不要说。',
    '用户的认知往往有明显局限：容易片面，抓不住重心，也很难从第三方视角看出自己作品的',
    '无趣与漏洞——他会把问题误认成巧思，陷入自嗨式创作。你的价值正在于替他看见这些。',
    '用户不是需要哄的孩子，而是一知半解的求知者，在等着被指导和纠正。',
    '所以：具体情形具体分析，从多个创作颗粒度给出优化建议，把经过判断的知识和确实成立的经验倾囊相授，',
    '与他达成真正的共识——而不是附和他现有的想法。',
    '',
    '## 输出规范',
    '',
    '不做自我介绍，不列举自身能力，直接回应用户所说的事。',
    '不复述用户的提问，不重复 Skill 内容。',
    '遇到需要跨语言理解的地方，可以按需意译或音译，绝不要多语言夹杂。',
    '文件内容是成品：不写中间结论、推理过程、括号注释、口语式提问，',
    '也不写「（对应问题1）」「（用户原话）」这类注释性文字。',
    '',
    '## 完成标准',
    '',
    '交付物是可用的成品，不是对成品的描述。写了骨架、提纲、占位内容就停下，不算完成。',
    '写完文件后再读一遍确认内容完整、没有半截段落，然后才报告完成。',
    '在任务真正做完之前不要停下来。不要写完一部分就交回给用户问「要继续吗」——',
    '除非需要用户拍板，否则一路做到底。剩下的步骤自己接着做，不要留给下一轮。',
    '工具报错或某条路走不通时，先换个办法再试——换工具、换写法、换切入点；',
    '确实都走不通，才说明卡在哪、已经试过什么、需要什么才能继续。',
    '绝不编造工具输出、文件内容或未经确认的结果来填补空缺——工具报错、内容不符预期、',
    '任务只做了一半，都必须直说当前状态。如实报告受阻，永远好过编一个看起来合理的结果。',
    '',
    '说结果，不逐条罗列文件变更。有取舍时说清选了哪个、为什么。',
    '出错、未完成、未验证的事直接讲明，不用模糊措辞掩盖。',
  ].join('\n'),

  // 【程序自动追加的部分】用户改不到，也不必改。内容固定，故仍可被提示缓存命中。
  toolGuide: [
    '',
    '## 文件系统',
    '',
    '- `/workspace/` 唯一可写目录，用户的工作成果在此。',
    '- `/skills/` 只读，存放 Skill 的参考资料。',
    '- `/tmp/` 存放用户超长输入的暂存文件，提示词引用到时用 read_file 读完再继续。',
    '- read_file / search 只能读取文本。PDF、DOCX 使用 parse_document，按参数选择纯文字或页图，以及直接返回或保存到指定路径。纯文字模式不做 OCR，扫描件请用页图；直接返回图片需要开启多模态。图片文件可用 view_image 查看。其他非文本类型没有解析器，不得声称读过其内容。',
    '- 粘贴图片只在首次讨论的轮次自动附带；历史保留图片路径，需再次确认细节时用 view_image。预览可能缩小，长截图和小字可按工具返回的原图尺寸裁剪查看。',
    '- /tmp/ 文件连续 10 轮未使用或 7 天未使用会过期，容量达到上限时也会清理。文件过期后说明需要用户重新提供，不得假装仍能看到原图。/workspace/ 文件不会自动过期。',
    '',
    '## 工具要点',
    '',
    '- 需要多个互不依赖的信息时，一次返回多个工具调用，不要一个一个来回问——',
    '  每来回一次都要重发整个上下文。只有后一个调用依赖前一个结果时才分开。',
    '- 覆盖已有文件前必须先 read_file 读到最新内容；读过之后文件若再被改动，需重新读一次才能写。',
    '- 局部修改用 apply_patch，不整文件重写。old_str 须在文件中唯一，多给几行上下文即可。',
    '- 非空 JSON 文件每次修改后须完整合法；大型 JSON 可先分段写入 .txt，完成后 move 为 .json。写入、补丁、移动和复制失败时按错误修正，原文件保留。',
    '- 背包与场景物品列表的 ID 必须唯一；多件同类物品使用数量/余量，不同实例使用不同 ID。玩家姓名、性别、年龄、职业、身份只填当前值，历史与解释写入日志或相应隐藏字段。',
    '- 读长文件被截断时用 offset 续读，不要基于半截内容下判断。',
    '- search 的正则区分大小写，需忽略时写 `[Tt]odo`。',
    '- 只要有 Skill 与当前任务相关，哪怕只是部分相关，都必须先 run_skill 加载再动手。',
    '  宁可加载了用不上，也不要漏掉其中的关键步骤与坑。它的参考资料在自己的根目录下，用 read_file 取。',
    '  加载后把其中的知识当作自己的，直接按流程执行，不在回复中提及「Skill」「框架」「文件」等来源。',
    '- 需要多轮才能完成的任务，用 goal set 设立目标：此后每轮结束会自动继续推进，',
    '  直到你用 goal end finished（已达成）或 goal end break（需用户介入）结束。',
    '',
    '需要了解工作区内容时用 list_dir / search 查，不凭记忆假设文件存在。',
  ].join('\n'),

  // Skill 清单：内容相对稳定（用户很少增删 Skill），放在 system 末尾不影响缓存；
  // 文件树则每写一个文件就变，一旦放进 system 会让整段前缀每轮失效，
  // 因此不注入——模型需要时用 list_dir / search 现查即可。
  skillsSection: [
    '',
    '## 可用 Skill',
    '',
    '{{skills}}',
  ].join('\n'),
};

const SEED_FILES = {
  'README.md': [
    '# 欢迎来到世界设计者', '', '每一个世界，都可以从一个念头开始。', '',
    '## 让故事成为世界', '',
    '在这里，你可以和 AI 一起打磨心仪的故事与设定，从零构建一个世界，或为已有的世界补充人物、拓展剧情、完善规则。', '',
    '你也可以上传一份文本文件，把故事片段、背景资料或已有设定交给 AI，作为创作的参考。', '',
    '## 分享，也去探索', '',
    '欢迎把你创造的世界与故事分享给其他人，也欢迎走进他人的世界，体验不同的冒险。准备好后，点击右上角的手柄按钮，即可前往「异闻手记」试玩。', '',
    '## 认识你的工作区', '',
    '- **左侧**：管理项目与会话，让不同的创作各有归处。',
    '- **中间**：与 AI 讨论想法，逐步推进世界构建。',
    '- **右侧**：查看、编辑和下载世界文件。', '',
    '> **请记得备份**\n> 数据保存在当前浏览器中，不会自动同步到其他设备或浏览器。清理浏览器数据可能导致内容丢失，请定期下载并保存你的世界。', '',
  ].join('\n'),
};

// 内置 Skill：优先从同级 skills/ 目录按 skill_enable_list.json 自动加载（见 skill-loader.js）。
// 此处仅作为「硬编码兜底」——单文件模式（file:// 直接打开）下无法读取外部目录时使用。
// 通常留空即可；要新增 Skill 请在 skills/ 下建目录并写进 skill_enable_list.json。
const BUILTIN_SKILLS = [];

// 目标（goal）：设立后每轮回答结束自动追加一条推进消息，直到 AI 主动结束。
// 用户看到的是「继续推进目标」气泡，看不到下面这段注入文本。
const GOAL_MAX_CHARS = 4096;
const GOAL_MAX_ROUNDS = 300;       // 单次发送内自动推进的上限，防跑飞
const GOAL_CHANGED_NOTICE = '[检测到目标已修改，新的目标如下:]';
const GOAL_TEMPLATE = [
  '{{notice}}<GOAL>',
  '{{goal}}',
  '</GOAL>',
  '以上为当前目标，直到目标全部完成前，无法停止运行。',
  '目标描述的是「工作区相对目标设立那一刻应达到的最终状态」，不是每轮都要再做一份的增量任务。',
  '判断是否完成，看当前工作区是否已满足该状态；已经满足就结束，不要重复产出或叠加。',
  '如果有多个决策，自动选择最优最推荐的决策。',
  '',
  '* 若认为目标部分完成或者有变化，使用 goal change 修改',
  '* 若认为目标被打断或无法继续进行，必须用户介入，使用 goal end break 结束循环',
  '* 若认为目标已经达成，使用 goal end finished 结束循环',
].join('\n');

// 用户设立/修改目标时，作为一条独立消息注入。让模型知道目标从何而来、基准在哪。
const GOAL_SET_TEMPLATE = [
  '<GOAL{{action}}>',
  '{{goal}}',
  '</GOAL>',
  '用户{{actionText}}了目标。这描述的是工作区相对现在应达到的最终状态，不是逐轮累加的任务。',
  '现在开始推进；完成后用 goal end finished 结束，无法继续时用 goal end break 交回用户。',
].join('\n');

// 超长输入注入模板：{{head}} 开头预览、{{tail}} 结尾预览、{{path}} 临时文件路径、
// {{total}} 原文总字数、{{headChars}}/{{tailChars}} 预览字数
const LONG_INPUT_TEMPLATE = [
  '<user_input_truncated path="{{path}}" total_chars="{{total}}">',
  '用户本次输入过长（共 {{total}} 字符），已折叠。完整原文见文件：{{path}}',
  '下面仅展示开头 {{headChars}} 字与结尾 {{tailChars}} 字，中间部分被省略。',
  '如需完整内容，请用 read_file 读取上述文件（可用 offset 分段读）。',
  '',
  '--- 开头 {{headChars}} 字 ---',
  '{{head}}',
  '',
  '--- 中间省略 {{midChars}} 字 ---',
  '',
  '--- 结尾 {{tailChars}} 字 ---',
  '{{tail}}',
  '</user_input_truncated>',
].join('\n');

// 压缩配置：提示词为模板，{{变量}} 在运行时注入，方便扩展。
// 可用变量：{{transcript}} 待压缩对话文本；{{prevSummary}} 上一段摘要（接力压缩时非空）；
//          {{fileTree}} 当前文件树概览；{{maxWords}} 摘要字数上限；
//          {{chunkIndex}}/{{chunkTotal}} 当前段序号与总段数。
const COMPRESS_CONFIG = {
  maxWords: 1500,                // 软上限：防止摘要在多次接力压缩后无限膨胀，装不下时按 systemTemplate 里的优先级取舍
  keepRecentResponses: 20,       // 优先保留最近 N 次 AI 返回；预算允许时至少保留一个完整用户轮次
  inputBudgetRatio: 0.45,        // 单次压缩请求的输入预算 = 上下文上限 × 该比例（超出则分段接力）
  // 转录里单条工具结果/工具调用内容（write_file 的 content、apply_patch 的 old_str/new_str）
  // 超过此长度才截断；截断后保留头尾各若干字，中间省略——摘要要写出真代码片段，
  // 前提是压缩模型本来就得看到真代码，不能一上来就砍到 300 字只剩个文件名的影子。
  transcriptPreviewChars: 3000,
  transcriptHeadChars: 1600,
  transcriptTailChars: 600,
  systemTemplate: [
    '你是对话压缩器。把下面的 Agent 工作对话压缩成一份结构化中文摘要，供后续对话接着用——',
    '效果要求：读完这份摘要就能像读过原始记录一样继续干活，不需要回看原文。',
    '',
    '按顺序输出以下九个二级标题，每节内容如下（某节确实没有内容就写"（无）"，不要跳过标题）：',
    '',
    '## 目标与需求',
    '整个对话中用户提出过的所有明确诉求，按时间顺序列出，不是只留最后一条。',
    '## 关键约定与结论',
    '过程中达成的技术选型、贯穿全程的约定（比如"只用 apply_patch 不整文件重写"这类规则）。',
    '## 文件与改动',
    '涉及到的文件路径 + 关键代码片段原样摘录。不要用"改了一些逻辑"这类空话代替真实代码——',
    '转录里能看到的 write_file 内容、apply_patch 的新旧内容，摘录时就用原文，不要转述。',
    '## 错误与修复',
    '出现过的报错信息、原因、修复方式。',
    '## 排查与决策过程',
    '有分歧或做过取舍的地方，最终选了哪个、为什么。',
    '## 用户原话',
    '逐条列出用户说过的原话，按时间顺序，一字不差地摘抄——不意译、不合并、不省略。',
    '这是最重要的一节：后续对话要靠它理解用户的准确措辞和语气，而不是被改写过的转述。',
    '## 待办事项',
    '明确提出但还没做完的事。',
    '## 当前进展',
    '被打断前正在做的具体事情，做到了哪一步。',
    '## 建议的下一步',
    '续接后第一步该做什么，并说明是哪句用户原话触发了这一步，避免续接后跑偏到别的任务。',
    '',
    '篇幅：总字数尽量不超过 {{maxWords}} 字，这是软上限——装不下全部细节时，',
    '优先保留用户原话、文件路径与代码、错误与结论；可以精简的是被放弃的中间方案和探索过程。',
    '',
    '当前工作区文件树（供对照）：',
    '{{fileTree}}',
  ].join('\n'),
  // 接力压缩（第 2 段及以后）的系统提示：说明前文已压缩过，并要求总结压缩心得
  relaySystemTemplate: [
    '你是对话压缩器，正在做分段接力压缩（第 {{chunkIndex}} 段 / 共 {{chunkTotal}} 段）。',
    '输入包含两部分：',
    '1. 【已压缩摘要】——前 {{prevChunks}} 段对话已被压缩过的结果，本身已是九段式结构，不要再逐句复述；',
    '2. 【本段原始对话】——尚未压缩的新内容。',
    '',
    '请输出一份合并后的完整摘要，覆盖以上两部分的全部要点，仍然是同样的九个二级标题',
    '（某节两边都没内容就写"（无）"）：',
    '',
    '## 目标与需求',
    '## 关键约定与结论',
    '## 文件与改动',
    '## 错误与修复',
    '## 排查与决策过程',
    '## 用户原话',
    '## 待办事项',
    '## 当前进展',
    '## 建议的下一步',
    '',
    '合并规则：',
    '- 「用户原话」两边直接拼接、按时间顺序排列，一字不差，不因为篇幅而删减。',
    '- 其余各节：已压缩部分若与本段内容冲突或被推翻，以本段（更新）为准；不冲突则合并去重。',
    '- 舍弃：寒暄、重复内容、已被推翻的中间方案。',
    '- 总字数尽量不超过 {{maxWords}} 字，装不下时优先级同上（用户原话、代码、错误结论 > 探索过程）。',
    '- 结尾另起一行，以「压缩心得：」开头，用一两句话说明本次合并时你重点保留了什么、舍弃了什么。',
    '',
    '当前工作区文件树（供对照）：',
    '{{fileTree}}',
  ].join('\n'),
  userTemplate: [
    '{{prevSummary}}',
    '',
    '=== 本段原始对话（尚未压缩） ===',
    '{{transcript}}',
  ].join('\n'),
  prevSummaryPrefix: '=== 已压缩摘要（前面若干段的压缩结果，需并入本次摘要） ===',
};
/* ═══════════════════ 扩展配置区结束 ═══════════════════ */

// 名词释义：设置项旁的问号点开后显示。写清原理与优劣，替代选项里的括号注释。
// 结构：{ title, body:[段落], pros:[优点], cons:[代价] }
const GLOSSARY = {
  sliding: {
    title: '滑动窗口',
    body: ['像一扇固定大小的窗口在对话历史上向前滑动：只把最近的若干轮发给模型，' +
      '每次超限就丢掉最早的一轮，丢到刚好装得下为止。本地记录完整保留，丢弃只发生在发送时。'],
    pros: ['始终保留最近的上下文，模型对当前话题最敏感', '实现简单，不会额外消耗 token 或时间'],
    cons: ['每轮都在动最早那部分，导致提示词前缀不断变化，服务端的提示缓存基本无法命中，' +
      '长对话中每次请求都按未缓存计费、首字延迟也更高',
      '早期的关键约定会被悄悄丢掉，模型可能忘记你最初的要求'],
  },
  truncate: {
    title: '切断',
    body: ['触发一次就砍掉前一半轮次，一步到位腾出大片空间，而不是每轮丢一点。'],
    pros: ['腾空间后很久不必再裁，前缀在这段时间内保持稳定，缓存命中率明显好于滑动窗口',
      '裁剪次数少，抖动小'],
    cons: ['一次丢弃的量大，可能连刚刚还有用的上下文一起砍掉', '丢弃时机集中，体感上会“突然失忆”'],
  },
  disabled: {
    title: '禁用',
    body: ['不自动处理。上下文超限时直接拒绝发送并提示你，由你决定是手动压缩、' +
      '新开会话，还是调大上限。'],
    pros: ['绝不擅自丢弃或改写你的对话', '出问题时你一定会知道，不会悄悄降级'],
    cons: ['需要你手动介入才能继续', '长对话中可能反复被打断'],
  },
  compress: {
    title: '自动压缩',
    body: ['把早期对话交给模型总结成一段摘要，之后请求只发送摘要。' +
      '原始消息在界面上完整保留（显示为半透明的折叠区），只是不再随请求发送。'],
    pros: ['信息密度最高，早期的决定与约束不会凭空消失', '压缩后前缀稳定，缓存表现好',
      '原文留在本地，随时可以回看'],
    cons: ['需要额外发一次请求，消耗 token 和时间', '发给模型的摘要是有损的，细节不会进入后续对话',
      '模型总结失误时，错误会被固化进上下文'],
  },
  scopeLast: {
    title: '仅最后一轮的改动',
    body: ['同一个文件被连续多轮修改时，只让你审阅最近一次的改动，' +
      '基准线是上一轮结束时的内容。'],
    pros: ['每次要看的差异小，注意力集中', '不会因为改了很多轮而积累出巨大的 diff'],
    cons: ['中间几轮的改动会被默认接受，不再单独过目', '拒绝时只能退回上一轮，退不到最初状态'],
  },
  scopeAccumulate: {
    title: '累积到我处理为止',
    body: ['保留你上次处理时的原始内容作为基准线，无论 AI 中间改了多少轮，' +
      '差异始终是「相对最初」的，直到你接受或拒绝。'],
    pros: ['能看到完整的净变化，不会有改动在你没注意时溜过去', '拒绝可以一路退回最初状态'],
    cons: ['多轮之后 diff 可能很大，审阅成本高', '中间过程被压平，看不出改动的先后顺序'],
  },
  contextOverflow: {
    title: '满上下文处理',
    body: ['对话累积到超过模型上下文上限时的应对方式。' +
      '前三种只影响本次发送的内容，本地记录始终完整；只有自动压缩会真正改写历史。'],
    pros: [], cons: [],
  },
  changeScope: {
    title: '变更审阅范围',
    body: ['决定「待审阅的改动」以什么为基准计算差异。'],
    pros: [], cons: [],
  },
};

const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-flash',
  imageSending: true,
  temperature: 0.7,
  stream: true,
  // 上下文超限时的处理方式：
  //   disabled  拒绝发送，提示用户手动处理
  //   sliding   滑动窗口——逐轮丢弃最早的对话，丢到刚好装得下为止
  //   truncate  切断——一次性砍掉前一半轮次，之后很久不必再裁
  //   compress  把早期对话交给模型总结成摘要（不可恢复）
  // 前三种只影响发给模型的内容，本地对话记录完整保留。
  contextOverflow: 'disabled',
  maxContextK: 240,              // 128 | 240 | 256 | 512 | 1024 | 自定义正整数
  editorPosition: 'right',       // right | center | left | float（窄屏忽略此项）
  panes: null,                   // 桌面三栏宽度 [左, 右]（px），null = 用默认值
  // 变更追踪范围：last=只显示最后一轮的改动（默认）；accumulate=累积到手动接受为止
  changeScope: 'last',
  // 思考过程（reasoning_content）的展示方式：
  //   collapsed        思考时展开直播，正文一开始吐字（或开始调工具）立即折起（默认）
  //   alwaysCollapsed  全程折叠，思考过程中也不展开，只留一行标题
  //   expanded         始终展开
  //   hidden           完全不显示（内容仍然保存，改回来就能看到）
  reasoningDisplay: 'collapsed',
  // 思考强度：none 关闭思考 / low / high（默认，界面显示「中」）/ xhigh / max。
  // 发请求时会同时带上多家 API 的开关与强度字段，见 agent.js applyThinkingFields
  reasoningEffort: 'high',
  // 留空即沿用代码里的默认系统提示词
  systemPromptOverride: '',
  reverseSendNewline: false,
};

const TOOL_DEFS = [
  { type: 'function', function: { name: 'parse_document', description: '解析 /workspace/ 或 /tmp/ 中的 PDF、DOCX，仅支持这两种文档。format=text 提取纯文字（不做 OCR），format=images 生成页图。output=return 直接返回文字或真实图片（图片需开启多模态）；output=file 保存文字到 output_path，或保存图片到 output_dir。PDF 页码从 1 开始；DOCX 图片按浏览器排版分页，可能与 Word 不同。每次默认最多 20 页文字或 5 页图片，按 next_page 继续。DOCX 文字不支持页码，可用 offset/limit 分段返回。保存不覆盖已有文件。', parameters: { type: 'object', properties: {
    path: { type: 'string', description: 'PDF 或 DOCX 文件完整路径' },
    format: { type: 'string', enum: ['text', 'images'] },
    output: { type: 'string', enum: ['return', 'file'] },
    output_path: { type: 'string', description: '文字保存时必填：完整输出文件路径，含目录与文件名' },
    output_dir: { type: 'string', description: '图片保存时必填：输出目录；图片按页码命名' },
    start_page: { type: 'integer', description: '起始页码，默认 1' },
    end_page: { type: 'integer', description: '结束页码，文字最多 100 页、图片最多 5 页' },
    offset: { type: 'integer', description: '直接返回文字的起始字符位置，默认 0' },
    limit: { type: 'integer', description: '直接返回文字的最大字符数，默认 32000，上限 120000' },
  }, required: ['path', 'format', 'output'], additionalProperties: false } } },
  { type: 'function', function: { name: 'view_image', description: '查看 /workspace/ 或 /tmp/ 图片，返回真实图片供视觉理解。先看整图；小字或长截图可按原图像素坐标传 crop 放大局部。临时图片可能过期。', parameters: { type: 'object', properties: {
    path: { type: 'string', description: '图片文件完整路径' },
    crop: { type: 'object', description: '可选，按原图像素裁剪', properties: { x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' } }, required: ['x', 'y', 'width', 'height'] },
  }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_dir', description: '列出目录内容（名称、类型、大小）', parameters: { type: 'object', properties: { path: { type: 'string', description: '目录路径，如 /workspace' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'read_file', description: '读取文件内容。默认返回上限 ' + AGENT_CONFIG.readCharLimit + ' 字符（/skills/ 下为 ' + AGENT_CONFIG.skillReadCharLimit + '）。预计文件很长时可传 limit 一次读完，避免反复续读。返回的不是全文时，结果首尾会标出前后各省略了多少字符——看到这类标注说明你手里只是片段，据此判断要不要续读，不要拿半截内容下结论', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', description: '起始字符位置，默认 0' }, limit: { type: 'integer', description: '本次最大字符数，上限 ' + AGENT_CONFIG.readCharLimitMax + '；不传则用默认上限' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: '创建或覆盖写文件（自动创建父目录）。内容上限 ' + AGENT_CONFIG.writeCharLimit + ' 字符，超长文本可分段追加。非空 JSON 内容每次修改后须完整合法，大型 JSON 可先在 .txt 拼接完成再改为 .json。物品列表 ID 唯一，玩家身份字段只填当前值；校验失败不写入。覆盖已存在文件前必须先 read_file 读取其最新内容，否则会被拒绝', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'apply_patch', description: '对现有文件应用搜索替换补丁；old_str 必须在文件中唯一匹配。JSON 校验完整修改结果，失败保留原文件', parameters: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['path', 'old_str', 'new_str'] } } },
  { type: 'function', function: { name: 'delete', description: '删除文件或目录（递归）', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'move', description: '移动或重命名文件/目录', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } } },
  { type: 'function', function: { name: 'copy', description: '复制文件或目录到新路径', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } } },
  { type: 'function', function: { name: 'search', description: '正则搜索（大小写敏感，忽略大小写请用 [Tt] 写法）。target: content=内容 name=文件名 both=两者（默认）', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: '搜索根目录，默认 /workspace' }, target: { type: 'string', enum: ['content', 'name', 'both'] } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'run_skill', description: '加载一个 Skill 的完整操作指令（Skill 清单见系统提示）', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: {
    name: 'goal',
    description: '管理当前的长期目标。设立目标后，每轮回答结束会自动继续推进，直到你用 end 结束。适合需要多轮才能完成的任务——先 set 目标，再逐步推进。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'change', 'end'],
          description: 'set=设立目标（当前无目标时）；change=修改目标（当前有目标时）；end=结束循环并清空目标' },
        content: { type: 'string', description: 'set/change 时必填：目标内容，不超过 ' + GOAL_MAX_CHARS + ' 字' },
        reason: { type: 'string', enum: ['break', 'finished'],
          description: 'end 时必填：finished=目标已达成；break=被打断或无法继续，需用户介入' },
      },
      required: ['action'],
    },
  } },
  { type: 'function', function: {
    name: 'ask_user',
    description: '向用户提问并等待选择。仅用于只有用户能决定的分歧：需求不明、多方案各有取舍、不可逆操作需确认。能从上下文推断或有明显默认答案的，直接做。一次最多 3 个问题。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: '1–3 个问题。每题给 2–4 个互斥选项。',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '完整的问题，说清在问什么' },
              header: { type: 'string', description: '不超过 12 字的短标签，如「存储方案」' },
              options: {
                type: 'array',
                description: '2–4 个选项。推荐项放第一个。不要写「其他」「都行」这类兜底项，程序会自动补。',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: '选项名，1–5 个词' },
                    description: { type: 'string', description: '这个选项意味着什么、有何取舍' },
                  },
                  required: ['label'],
                },
              },
              multiSelect: { type: 'boolean', description: '是否允许多选，默认 false' },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
  } },
];

// Skill 在虚拟文件系统中的挂载根目录
const SKILLS_ROOT = '/skills';
function skillRoot(name) { return SKILLS_ROOT + '/' + name; }

function renderSkillLines(skills) {
  if (!skills || !skills.length) return '(无)';
  return skills.map(s => {
    const root = skillRoot(s.name);
    // 不注入附件列表：调用 run_skill 时自然可见；注入会让系统提示词随 Skill 文件变化而失效
    return '- ' + s.name + ': ' + s.description + '\n  根目录: ' + root;
  }).join('\n');
}

// 组装完整系统提示词 = 人设段（用户可改） + 工具说明 + Skill 清单。
// 三段都不含高频变化的内容，整段前缀逐字稳定，服务端提示缓存才能命中。
// personaOverride 为设置里自定义的人设段；为空则用代码里的默认值。
function buildSystemPrompt(skills, personaOverride) {
  const persona = (typeof personaOverride === 'string' && personaOverride.trim())
    ? personaOverride.trim() : AGENT_CONFIG.systemPrompt;
  const skillsPart = renderTemplate(AGENT_CONFIG.skillsSection, {
    skills: renderSkillLines(skills),
    skillsRoot: SKILLS_ROOT,
  });
  const base = persona + '\n' + AGENT_CONFIG.toolGuide + '\n' + skillsPart;
  const builder = (skills || []).find(skill => skill.name === 'game-world-builder');
  if (!builder?.instructions) return base;
  return base + '\n\n## 常驻特殊技能：game-world-builder\n'
    + '以下正文已完整加载并持续生效，无需先 run_skill。参考资料根目录：/skills/game-world-builder/。\n'
    + '本网页没有终端。结构校验使用 validate_game_structure 工具，path 指向 /workspace 中的世界目录；修复使用现有虚拟文件工具，然后再次校验。\n\n'
    + builder.instructions;
}

// 模板渲染：{{var}} → 值（值本身可能含代码块/特殊字符，用函数替换避免 $ 展开）
function renderTemplate(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null) ? String(vars[k]) : '');
}

function validateCustomContextK(input) {
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1 || n > 10000) return null;
  return n;
}

if (typeof module !== 'undefined' && module.exports)
  module.exports = { AGENT_CONFIG, SEED_FILES, BUILTIN_SKILLS, COMPRESS_CONFIG, LONG_INPUT_TEMPLATE, GOAL_TEMPLATE, GOAL_SET_TEMPLATE, GOAL_MAX_CHARS, GOAL_MAX_ROUNDS, GOAL_CHANGED_NOTICE, SKILLS_ROOT, skillRoot, GLOSSARY, DEFAULT_SETTINGS, TOOL_DEFS, buildSystemPrompt, renderTemplate, validateCustomContextK };
