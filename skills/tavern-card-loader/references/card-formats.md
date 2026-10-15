# 角色卡格式参考

## 图片角色卡

SillyTavern 图片角色卡通常是 PNG 图片，角色卡 JSON 被写入 PNG 文本元数据。常见字段包括 `chara`、`ccv3`、`Comment`、`Description`。

- `chara`：常见 V2 字段，通常是 base64 编码后的 JSON。
- `ccv3`：较新的角色卡字段，通常优先级高于 `chara`。
- `tEXt`：未压缩文本块。
- `zTXt`：zlib 压缩文本块。
- `iTXt`：国际文本块，可能压缩，也可能未压缩。

如果图片只有生成参数、模型信息或普通描述，没有 `chara`/`ccv3` 等可解码字段，应报告为普通图片或无可解析卡数据。

## JSON 角色卡

SillyTavern V2 常见结构：

- `spec: "chara_card_v2"`
- `spec_version: "2.0"`
- 顶层字段和 `data` 内镜像字段。
- `character_book.entries` 存放世界书条目。

常见文本字段：

- `name`
- `description`
- `personality`
- `scenario`
- `first_mes`
- `mes_example`
- `creator_notes`
- `system_prompt`
- `post_history_instructions`
- `alternate_greetings`

## 世界书

世界书条目常见字段：

- `keys`：触发关键词。
- `secondary_keys`：辅助关键词。
- `comment`：条目名或备注。
- `content`：稳定世界事实、规则、地点、组织、关系或触发设定。
- `constant`：是否常驻注入。
- `enabled`：是否启用。
- `position` 与 `insertion_order`：注入位置和顺序。

世界书经常比 `description` 更接近世界构建材料，解析时不能忽略。
