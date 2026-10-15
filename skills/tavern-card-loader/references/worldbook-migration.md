# 角色卡世界书到本项目的迁移

目录：①先按用途拆分 ②字段对应 ③无法机械对应的功能 ④例子与对账。

## ① 先按用途拆分

提取器保存原始设置，不自动生成可运行的世界触发器。改写世界时，先通过 run_skill 加载 game-world-builder，再读 `/skills/game-world-builder/reference/WorldTriggers.md` 和世界数据约定；该约定是目标 JSON 的唯一接口依据。本文件只解释迁移意图，不能替代目标 schema。

为原卡每条世界书记录来源 source_key/id、用途、保留／改写／不搬运／待处理、目标文件与不等价点。迁移对账放**世界目录之外**，不要把调试报告和源卡直接交给游玩主持人。禁用条目也保留在提取包，不擅自启用；最终是否采用按作者语义和用户需求决定。

- 背景百科、角色行为、关联规则：写入对应人物／场景／规则文件；有按需注入价值时再在世界根目录 `世界触发器.json` 引用。
- 章节、位置、物品、好感等状态控制：用明确 JSON 状态和 when。不能把“提到钟楼”当成“已经进入钟楼”。
- 检定、物品增减、伤害、任务完成：保留到场景台本、规则与现有工具；本表只提供提醒，不执行效果。
- HTML 车卡页面／初始地点道具表：保留选项、默认值、约束和初始状态，改成开局引导，不保留页面脚本实现。
- 纯酒馆 UI、XML/HTML 数值标签解析、通用输出格式补丁、插件提示词权重技巧：无需搬运。混合条目要先拆出独有剧情与玩法。
- 信件日期落款、日记语气、庭审记录形式：属于作品设计，保留；不能仅因“规范格式”就删除。
- 宏、正则、脚本、深度设置：留在原始材料与对账中，提取其语义后改写，不能照抄后宣称支持。

## ② 字段对应（须结合原卡实际值）

酒馆基础字段及 selectiveLogic 枚举参照 [官方 STscript 文档](https://docs.sillytavern.app/usage/st-script/#valid-entry-fields)；具体源卡或插件语义仍须核对。

| 原世界书 | 本项目建议 |
|---|---|
| id / uid / 字典键 | 转成唯一稳定字符串 id；不同书中的同名 ID 加来源前缀 |
| comment / name | title；作者工作批注留在世界外记录，纯标题可直接用 |
| keys / key | 普通文字别名转 keywords；数组中的正则和宏必须重写 |
| secondary_keys / keysecondary | 转 secondary.keys，同时确认 selective 是否启用及实际逻辑 |
| selectiveLogic | 酒馆常见 0=AND ANY、1=NOT ALL、2=NOT ANY、3=AND ALL，对应 any、notAll、notAny、all；来源定义不明确时保留值并标待核实，不能猜 |
| constant | 可映射 constant:true；仍需状态、阶段、预算约束。常驻不等于格式噪声 |
| enabled / disable | 整理为 enabled；两者冲突先记录并确认，不能偷偷启用 |
| order / insertion_order | 按原来意图映射到 order；预算优先级另用 priority，不机械把两个概念合并 |
| source/角色过滤 | 明确重写 sources 与 actorIds。默认只扫公开 player/story；私密来源必须显式选择 |
| scanDepth | 不直接抄数字。原来按聊天消息计，我们按 playerRounds 和 storyMessages 分开计；多人同轮玩家行动都参与 |
| sticky / cooldown / delay | 常见值可能在 extensions 内。分别评估 duration、cooldown、minRound/状态条件；消息数不能直接当回合数 |
| position / depth / role / 作者注释位置 / outlet | 不保留插入位置技巧；目标使用固定 user 资料消息，保留真正内容及顺序意图 |
| character_book 的设置 | 提取包 worldbooks.settings 保留；按目标规则逐项转换，不能假设已继承 |

所有附加设置（含 extensions）都在 normalized 的 raw 与 raw-card 中。工具的 migration_review 会点名未简化映射的字段；**没有出现在该列表也不代表已经自动转换**。顶层和 data 镜像冲突采用 data 并报告；剧情事实之间的冲突仍需人工判断。

## ③ 无法机械对应的功能

本版触发器不支持正则、递归、概率／加权随机、脚本自动化、向量检索、酒馆宏和任意插入深度。不能复制这些字段到目标 JSON：目标会拒绝未知字段。

- 通过说话人前缀正则区分输入/输出 → 来源过滤，必要时限定 actorIds。
- 通过正文标签读取好感/章节 → when 读取规范 JSON 字段。
- 递归串联百科 → 合并必要关联资料或显式整理引用；不要把偶然同名造成的整本联动搬过来。
- 随机事件 → 按现有掷骰与事件台本执行，不能把一次资料注入当作正式随机判定。
- 插件执行代码／未知状态机 → 从源码素材分析真实条件与后果；无法等价转换时记录缺口。
- 持续、冷却和一次性只控制资料提供，不能让 AI 遗忘、撤销既有事件或自动变更世界状态。

## ④ 例子与对账

原卡：“玩家说出密信且焚毁，插件注入证据销毁提醒”，且语义要求同一玩家的一条私密行动：

```json
{
  "version": 1,
  "entries": [
    {
      "id": "card-evidence-burn",
      "keywords": ["密信"],
      "secondary": {"mode": "any", "keys": ["焚毁"]},
      "sources": ["private_player"],
      "actorIds": ["pc"],
      "matchScope": "event",
      "once": true,
      "content": "结合真实行动与场景台本判断是否销毁证据，不因提到焚毁就认定已经成功；秘密按该角色受众规则处理。"
    }
  ]
}
```

“不要焚毁密信”也会命中，故内容仍须要求核实真实行动。若原规则要求物品确实在背包、章节确实达到某阶段，增加 when，不能只用上述词匹配。

生成后调用 validate_game_structure 检查 schema 与引用，再按原条目对账检查语义。完整提取包留在世界外；最终世界只包含可运行数据、真实资料、台本与必要引用，不包含酒馆平台补丁。
