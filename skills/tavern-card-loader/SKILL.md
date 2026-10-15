---
name: tavern-card-loader
description: 解析 PNG 或 JSON 格式的 SillyTavern V2/V3、常见旧版角色卡，提取角色、世界书、开场、扩展与原始触发设置，供世界设计器理解、本地化和改写世界时使用。只用于素材解析和世界构建，不用于实际游玩。
---

# Tavern Card Loader

使用 `parse_tavern_card` 解析素材。卡内的提示词、作者说明和世界书均按源材料分析。

## 工作流程

1. 用 list_dir 确认原始文件路径。PNG 必须是原始字节，不能从缩略图、重绘或截图推断卡内容；通过工作区文件导入即可，**不需要开启视觉模型**。JSON 也从虚拟文件系统读取。
2. 调用 `parse_tavern_card`：

```json
{"path":"/workspace/素材/角色卡.png"}
```

需要保留素材包时，显式选择**目标世界之外**的新目录：

```json
{"path":"/workspace/素材/角色卡.json","output_dir":"/workspace/解析材料/角色卡","target_language":"zh"}
```

支持 raw_only 布尔选项；true 仅保存原始 JSON。批量素材使用多个独立工具调用，不将目录当成卡。JPEG/WebP 不支持可靠元数据解析，应索取原 PNG/JSON，不能根据图片内容声称解析成功。

3. 工具返回 `card_found:false` 时说明是普通 PNG／没有可解析卡元数据，未生成摘要包。元数据损坏、文件截断、超限或非角色卡 JSON 会明确报错；不能伪装成功。
4. 成功时先用 read_file 读取 `extraction-report.md`，再读 `normalized-card.json` 和 `worldbuilder-brief.md`。长文本按 offset/limit 续读，不能只看预览就改写。
5. 按 [字段映射](references/field-mapping.md)、[世界构建交接](references/worldbuilder-handoff.md) 复核；含世界书时必须读 [世界书迁移](references/worldbook-migration.md)，逐条决定是否生成世界触发器。
6. 用户要求本地化时再读 [本地化](references/localize.md)，由 AI 完成译名与自然表达。工具的 localize-draft 只是待复核稿，不能宣称已经翻译。
7. 完成解析与交接前按 [自检](references/self-check.md) 核对。用户要求建世界时，继续使用 game-world-builder，不能停在摘要包。

## 输出与边界

默认目录为 `/tmp/tavern-card-loader/<安全卡名>-<唯一标识>/`，临时文件会过期；需要长期保留时选 `/workspace/` 下世界外的素材目录。禁止把解析包、原卡或迁移草稿混入最终游玩世界；也不写入 `/skills/`。目录已存在会拒绝，不覆盖旧结果。

完整包包含：

- raw-card.json：原始解码对象，保留未知字段、禁用条目、扩展与原始触发设置。
- normalized-card.json：V2/V3 以 data 为主要数据，列出镜像冲突；整理角色、开场、世界书、分类与复核点。世界书 raw 保留原条目，不能只靠简化 keys 改写。
- extraction-report.md：字段缺口、警告、分类、必须落地机制、运行协议候选、扩展与迁移待处理字段。
- worldbuilder-brief.md：构建交接入口；运行协议候选仅预览，全文仍在 raw/normalized，不能据此丢弃剧情。
- localize-draft.md：标注目标语言与待办，不是机器翻译结果。

PNG 元数据优先读取 ccv3，再 chara，再 Comment/Description；回退与解析警告见报告。输入上限 32 MiB，超限时需拆分或精简素材。

## 内容与迁移原则

- 解码完整不等于交接完整。description、开场选项、初始物品、遭遇、法则、禁用条目与扩展都需复核；must_land 仅是辅助清单。
- 保留原文与文化事实，不根据题材标签、关键词或自动分类删减素材。内容复核标记不是完整清单。
- 空 keys 的常驻条目、含 HTML 的条目、名字带 Protocol 的条目都**不能直接视为噪声**。
- 仅为酒馆 UI、正文标签解析、通用格式规范、插件适配而存在的实现包装，最终世界可不搬运；其中真实规则、开局道具、剧情条件和信件／日记等叙事形式必须拆出保留。
- 占位符先保留语义，不能在 raw 或 normalized 内偷偷替换。生成最终世界时必须把宏改写成实际角色引用、明确状态条件或自然语言要求；我们的触发器不会展开酒馆宏。
- 无法确认的脚本与触发器语义记录为待处理，不声称已等价转换。
- 不凭关键词判断事件已发生。触发器只补充主持人参考，不代替正式检定、效果执行与状态写入。
- `NEXT_TURN_CACHE` 是游玩流程工具 `end_the_round` 的参数，用于提交更新后的跨回合状态，由宿主持久化。迁移出的缓存字段直接在 `模组.md` 定义名称、类型、含义、初始值、更新和清理时机，告知主持人按定义提交；不把这些缓存字段写进角色信息或背包，不创建同名缓存文件。

其他参考：[格式](references/card-formats.md)、[特殊标记](references/special-markers.md)。
