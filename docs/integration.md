# 世界设计者集成记录

日期：2026-10-02。

## 实现范围

世界设计者是独立的第二个 HTML 页面，业务源码位于 `src/world-designer/`。共用模块位于 `src/shared/`；VFS 通过配置保留不同权限，租约通过配置保留原有续约和过期时间，其他共用模块使用同一实现。原 `src/*.js` 接口保留，兼容既有 Node 调用和测试。

两页各自使用原数据库，保留原有数据结构；没有合并 API 设置、会话或存档。切换页面前检查任务与编辑状态，并等待草稿落库。

世界设计者的唯一内置技能清单是 write-novel、desire-analysis、grilling、game-world-builder。最后一个技能直接取自本项目 `skills/game-world-builder/`。自 2026-10-03 起，仅输出单文件 `dist/designer.html`，四个技能及附件 manifest 直接从源码打包内嵌，在线与 file 模式均使用此快照。构建会清理旧的两个设计页面及 `dist/world-designer/` 外置产物；源码目录保留。两页导航、试玩返回与部署流程统一使用新文件名。旧的额外用户技能不会参与提示词、工具或补全，旧的 VFS 技能挂载在载入时重建。

game-world-builder 具有 special/required 标记，始终置顶启用，忽略并清理旧禁用记录。系统提示词末尾完整注入其正文；其 `validate_game_structure` 工具通过只读 VFS 适配器共用原 CLI 的校验规则，支持工作区根目录与子目录。工具声明与执行均检查所属技能，脚本采用构建时固定打包，不执行用户编辑或上传的 JS。错误由 AI 使用已有文件工具修复。

世界设计者固定使用哑黑金属与鎏金配色，在边框、标题栏和主要按钮使用金色渐变与几何角饰。标题左侧新增书本环抱地球的原创线条 SVG。标题、居中返回按钮和操作按钮同排显示，会话名与上下文用量共用下方一排；窄屏缩小字号和间距，保持紧凑。项目按钮支持再次点击收起列表。默认助手头像仍为 SVG 眼睛；系统提示词和聊天附件功能保留，设置页提供 GitHub 链接。

视觉参考：[Air & Ember 的 Art Deco 示例](https://airandember.com/pages/designs/artDeco.html) 与 [Ignition Labs 的 Noir Gala 案例](https://ignition-labs.studio/work/elevate-noir-gala/)。采用深浅黑色分层、金属高光与边缘装饰，正文不铺花纹；页面资源完全内嵌，不依赖外部字体或图片请求。

首次欢迎弹窗直接渲染默认 README 的 Markdown，确认后保存 `welcomeAcknowledged`。旧项目仅当 README 与旧默认文案完全一致时自动迁移，自定义内容不改写。浏览器验证覆盖首次显示、确认后刷新不再显示、正文一致、旧文案迁移、自定义 README 保留，以及 320/390/800/1024/1440px 标题与 LOGO 完整显示。

## 验证与历史基线

格式校验窗口新增“发送以修复”：空闲时以最新诊断生成固定修复提示词，沿用现有 AI 请求与文件工具流程；AI 工作期间禁用，校验通过后无需修复。发送保留输入框草稿，消息以默认折叠的“错误报告”胶囊显示，报告标记随会话保存，仅用于界面，不进入模型请求。新增浏览器用例覆盖忙闲状态、实际文件工具修复、完成后重新校验、报告展开和刷新持久化。本轮 298 项集成逻辑测试及六组浏览器脚本通过；浏览器模型响应由本地模拟提供。

异闻手记新增设计者项目导入入口。`DesignerProjects` 通过只读连接读取 `agent-workbench` 的项目与校验摘要，数据库不存在时不创建、不升级。摘要不包含详细错误；设计者用 `DB.putWorkspace` 在同一事务保存 VFS 与 `world-validation:<projectId>` 摘要，生成中的保存标记为尚未完成最新校验。选择前和导入前均检查可用状态，导入时只读取选中的世界快照，通过现有 ZIP/交接流程建立新存档。`designer.html#project=<id>` 编辑入口在启动时优先选择对应项目。

2026-10-03 新增自动格式校验：复用原 builder 规则，以结构化诊断路径支持错误定位，保留原 CLI 文本返回。页面进入、项目切换、完整工具循环结束、中止收尾和手动保存均更新状态灯；试玩弹窗单独检查所选世界与未保存文本的只读快照，保存后再次检查。强制跳转仅在当次选择有效，重开或换目录清零。错误定位在有未保存编辑时保留编辑器；窄屏临时同时显示目录列表与编辑器。

本次验证：295 项集成逻辑测试、27 项原 CLI 校验器测试通过；四组浏览器脚本全部通过，新增覆盖进入页面校验、悬浮详情、错误路径定位、缺失目录回退、手机未保存编辑保护、草稿预检、强制开关重置、模型完整轮次与主动中止。既有 HTTP/file 交接测试通过强制模式，合格世界正常模式自动导入也通过。

试玩交接已实现：独立 `world-play-handoff` IndexedDB 保存 ZIP Blob，`#handoff=<uuid>` 传递领取编号。`GameApp.importHandoff` 复用导入校验和存档存储；确定的存档 ID 配合 `putSave(..., {ifAbsent:true})` 的同一事务检查和写入，防止刷新、并发和“存档提交后、交接清理前”的中断重复导入。事务异常会中止，不能留下半份存档。完成记录清理 ZIP，失败保留下载与重试入口；过期记录七天后清理。

ZIP 打包使用与原导出相同的格式，增加异步分块执行，每 256 KiB CRC 检查点允许让出主线程。文件整理、解包、载入同样分批处理。阶段性进度不伪装成整体耗时百分比。弹窗全为自制 DOM，移除了原生 beforeunload 提示；浏览器自身刷新或关闭不再弹系统确认，已写入的交接数据支持恢复。

本轮验证：290 项集成逻辑测试、14 项原存档/导入专项测试通过；HTTP 与 file 模式均通过实际 UI 交接测试，覆盖确认取消、未保存编辑、嵌套世界、二进制、空目录、旧存档历史排除、进度、独立新存档、刷新去重、并发去重、中断恢复、发送端存储失败、接收端存储失败及重试/下载。现有双页浏览器集成和文件快捷键测试通过。8 MiB 文件的分批打包与同步版本字节一致，执行期间定时器可运行。

- 修改前已有的 116 项本地跑团测试：108 通过，8 失败。
- 原工作台 273 项逻辑测试全部迁入。
- 迁入及新增的 280 项逻辑测试通过；仅包含已跟踪及新增交付文件的独立源码副本，310 项测试全部通过。
- 本轮新增虚拟文件校验、路径边界、嵌套世界引用、技能工具绑定、常驻与全文注入测试后，集成逻辑测试 286 项通过；原 CLI 校验器 27 项测试通过。
- 新增双页构建、四技能白名单与资源路径、离线回退、VFS 权限和共享实现测试。
- 浏览器集成覆盖：模拟跑团回合、模拟模型工具写文件、编辑放弃确认、输入草稿持久化、跨页数据隔离、旧技能清理、设置页四技能、320/390px 页面导航与控件、HTTP 与 file 打开。
- 本轮浏览器验证另覆盖真实工具调度至虚拟世界校验器及其结果回传、完整技能正文进入模型请求、旧 builder 禁用状态清理、固定 SVG 头像、删除的设置和 GitHub 链接，以及 320/390/800/1024/1440px 标题栏居中与不重叠。

现有 8 个失败用例（本次修改前后相同）：

1. flow injection follows recovered tool replies and uses configured context labels
2. 暗骰只在 DEBUG 显示，随机结果按调用 ID 缓存
3. history export excludes all internal events and escapes unsafe content
4. offline archive includes independent panels, native tabs and resource controls
5. play events only expose player story public dice and round end
6. player and dice events carry world time, updated world files beat a stale cache
7. critical dice show possible hints and suppress ordinary comparison
8. overlapping closed critical ranges fail before rolling and emit no dice event

这些历史测试原本被仓库忽略。本次没有修改对应业务逻辑，也没有跳过或隐藏它们。运行完整 `npm test` 时，本地仍会报告这 8 项；本次迁入和新增部分可通过 `npm run test:integration` 单独验证。

浏览器测试使用本地模拟模型响应，没有发送真实 API 请求或验证付费模型服务。

原工作台的文件快捷键浏览器用例已通过。附件浏览器脚本运行到文件夹选择器的 `fileChooser.setFiles(folder)` 时超时；用同一 Playwright/Edge 运行未修改的 web-agent-main 原始页面和原始测试，在相同的第 216 行也复现此超时。图片、ZIP 和普通文件相关断言在该步骤前均已执行通过；文件夹选择器后的断言本轮未完成。
