'use strict';
const Agent = (() => {
  const _VFS = (typeof module !== 'undefined') ? require('./vfs.js') : VFS;
  const _SSE = (typeof module !== 'undefined') ? require('./sse.js') : SSE;
  const _Diff = (typeof module !== 'undefined') ? require('./diff.js') : Diff;
  const _BuilderTools = (typeof module !== 'undefined') ? require('./builder-tools.js') : BuilderTools;
  const _ApiUrl = (typeof module !== 'undefined') ? require('../shared/api-url.js') : ApiUrl;
  const _FileWriteValidation = (typeof module !== 'undefined') ? require('../shared/file-write-validation.js') : FileWriteValidation;

  const WRITE_TOOLS = new Set(['write_file', 'apply_patch', 'delete', 'move', 'copy']);
  const _GOAL_MAX = (typeof module !== 'undefined') ? require('./00-config.js').GOAL_MAX_CHARS : GOAL_MAX_CHARS;
  const _TOOL_DEFS = (typeof module !== 'undefined') ? require('./00-config.js').TOOL_DEFS : TOOL_DEFS;

  /* 参数预检。tools 里的 JSON Schema 对大多数服务只是「给模型看的说明书」，
     并不约束解码——模型完全可能漏掉 required 字段、把字符串发成对象。
     与其让错误穿进 VFS 变成「路径必须是字符串」这种没头没尾的报错，
     不如在入口对照工具定义查一遍，把「哪个参数、期望什么、收到什么」
     直白地喂回给模型，它下一轮就知道怎么改。 */
  const _TOOL_SPEC = {};
  for (const t of [..._TOOL_DEFS, ..._BuilderTools.definitions]) {
    const p = t.function.parameters || {};
    _TOOL_SPEC[t.function.name] = { required: p.required || [], props: p.properties || {} };
  }
  function validateToolArgs(name, args) {
    const spec = _TOOL_SPEC[name];
    if (!spec) return null; // 未知工具由 executeTool 兜底
    for (const k of spec.required) {
      if (args[k] === undefined || args[k] === null)
        return '错误: 缺少必填参数 ' + k + '（工具 ' + name + ' 必填: ' + spec.required.join(', ') + '）。请补全参数后重新调用。';
    }
    for (const [k, v] of Object.entries(args)) {
      const decl = spec.props[k];
      if (!decl || v === undefined || v === null) continue;
      if (decl.type === 'string' && typeof v !== 'string')
        return '错误: 参数 ' + k + ' 需要字符串，收到 ' + (Array.isArray(v) ? 'array' : typeof v) + '。请以字符串形式重新调用。';
      if (decl.type === 'integer') {
        // 模型把数字发成 "100" 很常见，语义无歧义就地纠正，不值得打回重试
        const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
        if (!Number.isInteger(n))
          return '错误: 参数 ' + k + ' 需要整数，收到 ' + typeof v + '。请以整数形式重新调用。';
        args[k] = n;
      }
      if (decl.type === 'array' && !Array.isArray(v))
        return '错误: 参数 ' + k + ' 需要数组，收到 ' + typeof v + '。请以数组形式重新调用。';
    }
    return null;
  }

  // 读取文件当前内容用于 diff 前置快照；不存在或为目录时返回 null
  function snapshotFile(tree, path) {
    try {
      const node = _VFS.resolve(tree, _VFS.normalize(path));
      return node && node.type === 'file' && node.encoding !== 'base64' ? node.content : null;
    } catch (_) { return null; }
  }

  // 为一次写操作生成变更记录（供 UI 渲染 diff 按钮）。
  // 返回 { kind:'create'|'modify'|'delete'|'move'|'copy', path, before, after, added, removed, changed }
  function buildChange(name, args, before, tree) {
    const p = args.path || args.to || args.from;
    if (name === 'delete') {
      const stat = { kind: 'delete', path: p, before: before == null ? '' : before, after: '' };
      // 目录删除没有文本内容，before 为 null
      return Object.assign(stat, _Diff.summarize('delete', stat.before, ''), { isDir: before == null });
    }
    if (name === 'move' || name === 'copy') {
      const target = _VFS.resolve(tree, _VFS.normalize(args.to));
      return { kind: name, path: args.to, from: args.from, before: '', after: '', added: 0, removed: 0, changed: 0,
        ...(target && target.encoding === 'base64' ? { binary: true } : {}) };
    }
    const after = snapshotFile(tree, p);
    if (after == null) return null;
    const kind = before == null ? 'create' : 'modify';
    const base = before == null ? '' : before;
    return Object.assign({ kind, path: p, before: base, after },
      _Diff.summarize(kind, base, after));
  }

  // 给部分读取的结果加上边界说明。
  // 只在末尾提一句「已截断」是不够的：从 offset 中间读时，开头省略的部分
  // 模型完全看不见，会把片段当成文件开头来理解。故首尾都显式标出省略量。
  function framePartialRead(r, path) {
    const body = r.content;
    const headOmitted = r.offset;
    const tailOmitted = r.totalLength - (r.offset + r.returned);
    if (!headOmitted && !tailOmitted) return body || '(空文件)';
    const lines = [];
    lines.push(`[文件片段 ${path} —— 共 ${r.totalLength} 字符，本次返回 ${r.offset}–${r.offset + r.returned}]`);
    if (headOmitted) lines.push(`[↑ 前面还有 ${headOmitted} 字符未读，用 offset=0 起读可取回]`);
    lines.push('');
    lines.push(body);
    lines.push('');
    if (tailOmitted) lines.push(`[↓ 后面还有 ${tailOmitted} 字符未读，用 offset=${r.offset + r.returned} 继续读]`);
    else lines.push('[↓ 已到文件末尾]');
    return lines.join('\n');
  }

  // read_file 的实际上限：三层优先级。
  //   1. 模型显式传 limit —— 由它决定要读多少，但不得超过 readCharLimitMax
  //   2. 目标在 /skills/ 下 —— 参考资料按整篇读才有意义，用更高的默认值
  //   3. 其余 —— 常规默认值
  function readCapFor(cfg, path, limit) {
    const hardMax = cfg.readCharLimitMax || 120000;
    if (Number.isFinite(limit) && limit > 0) return Math.min(limit, hardMax);
    const p = String(path || '').replace(/^\.?\//, '/');
    const isSkill = /^\/?skills(\/|$)/.test(p);
    return Math.min(isSkill ? (cfg.skillReadCharLimit || cfg.readCharLimit) : cfg.readCharLimit, hardMax);
  }

  // 内容指纹：mtime 只有毫秒精度，同一毫秒内的两次写入分辨不出来，
  // 用内容本身做判据才可靠——「内容没变」就等于「没人动过」，正是这个机制想问的事。
  function fileStamp(content) {
    let h = 5381;
    for (let i = 0; i < content.length; i++) h = ((h << 5) + h + content.charCodeAt(i)) | 0;
    return content.length + ':' + (h >>> 0).toString(36);
  }
  // 记录某路径「读取/写入时的内容指纹」，写入前据此判断是否被别人改动过
  function recordRead(ctx, path) {
    if (!ctx.readState) return;
    const node = _VFS.resolve(ctx.tree, _VFS.normalize(path));
    if (node && node.type === 'file' && node.encoding !== 'base64') ctx.readState.set(path, fileStamp(node.content));
  }

  // 覆盖已存在文件前的读保护：未读过→拒绝；读过但内容被改动→拒绝。
  // AI 自己的写入会同步更新指纹（见各写工具末尾的 recordRead），
  // 所以连续修改同一个文件不会被自己挡住——只拦真正来自外部的改动。
  function assertReadBeforeWrite(ctx, path) {
    const node = _VFS.resolve(ctx.tree, _VFS.normalize(path));
    if (!node || node.type !== 'file') return; // 新文件不受限
    if (node.encoding === 'base64') throw new Error('非文本文件不能用文本工具覆盖；可移动、复制或删除');
    if (!ctx.readState) return;
    if (!ctx.readState.has(path))
      throw new Error('该文件已存在，写入前必须先用 read_file 读取其最新内容: ' + path);
    if (ctx.readState.get(path) !== fileStamp(node.content))
      throw new Error('该文件的当前内容与你上次读到的不一致（用户手动编辑、拒绝了你的改动、或回滚了工作目录），请先重新 read_file 确认最新内容再写入: ' + path);
  }

  // 规范化 ask_user 的参数：模型偶尔会漏字段或给出畸形结构，这里兜底修正，
  // 避免因参数不合格式就让整个提问失败。
  const ASK_MAX_QUESTIONS = 3, ASK_MAX_OPTIONS = 4;
  // 「其他」由程序统一注入，模型不必也不该自己写。但模型若已经写了一个「其他」，
  // 再加一个就重复了，故先探测再决定。只认语义等价的说法——「都行」「不确定」是
  // 用户对现有选项的表态，与「都不合适，我另外说」不是一回事，不能混为一谈。
  const ASK_OTHER_RE = /^\s*(其他|其它|自定义|other|custom)\s*$/i;
  function hasOtherOption(opts) {
    return opts.some(o => ASK_OTHER_RE.test(o.label));
  }
  function normalizeQuestions(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    // 先过滤再限量：若先 slice，前几个恰好不合法就会把后面合法的题一起截掉
    for (const q of raw) {
      if (out.length >= ASK_MAX_QUESTIONS) break;
      if (!q || typeof q !== 'object') continue;
      const text = String(q.question || '').trim();
      if (!text) continue;
      const opts = [];
      for (const o of (Array.isArray(q.options) ? q.options : []).slice(0, ASK_MAX_OPTIONS)) {
        const label = String((o && (o.label !== undefined ? o.label : o)) || '').trim();
        if (!label) continue;
        opts.push({ label, description: String((o && o.description) || '').trim() });
      }
      if (opts.length < 2) continue;          // 不足两个选项就不成其为选择题
      // 自动补「其他」：模型没给兜底项时才加，避免出现两个语义相同的选项
      if (!hasOtherOption(opts))
        opts.push({ label: '其他', description: '都不合适，我自己说', other: true });
      out.push({
        question: text,
        header: String(q.header || '').trim().slice(0, 12),
        options: opts,
        multiSelect: !!q.multiSelect,
      });
    }
    return out;
  }

  // ctx: { tree, skills, config, readState?, askUser? }
  function executeTool(ctx, name, args) {
    const cfg = ctx.config;
    const writeOptions = { cap: cfg.writeCharLimit, validateContent: _FileWriteValidation.validate };
    const isWrite = WRITE_TOOLS.has(name);
    // 参数不合工具定义时立刻退回，别让脏参数流进 VFS 变成难以归因的报错
    const bad = validateToolArgs(name, args);
    if (bad) return { isWrite: false, result: bad };
    // 写操作前抓取原内容，供成功后计算 diff
    const before = isWrite ? snapshotFile(ctx.tree, args.path || args.from) : null;
    try {
      switch (name) {
        case 'parse_document': {
          if (typeof ctx.parseDocument !== 'function') throw Error('文档解析工具不可用');
          if (args.format === 'images' && args.output === 'return' && typeof ctx.viewImage !== 'function') throw Error('图片发送已关闭，请开启多模态或使用 output=file 保存图片');
          return { isWrite: args.output === 'file', pending: Promise.resolve().then(() => ctx.parseDocument(args)) };
        }
        case 'validate_game_structure': {
          if (!_BuilderTools.enabled(ctx.skills)) throw Error('该工具所需的 game-world-builder 技能未启用');
          return { isWrite: false, result: JSON.stringify(_BuilderTools.validate(ctx.tree, args.path)) };
        }
        case 'view_image': {
          if (typeof ctx.viewImage !== 'function') return { isWrite: false, result: '错误: 图片发送已关闭或看图工具不可用' };
          return { isWrite: false, pending: Promise.resolve().then(() => ctx.viewImage(args)).then(image => ({
            result: '已查看图片: ' + args.path + `（原图 ${image.sourceWidth || image.width}×${image.sourceHeight || image.height}，本次 ${image.width}×${image.height}）`,
            image: { path: args.path, ...image },
          })) };
        }
        case 'list_dir': {
          const ls = _VFS.listDir(ctx.tree, args.path);
          return { isWrite, result: ls.length ? ls.map(e => `${e.type === 'dir' ? '[目录]' : e.binary ? '[非文本文件]' : '[文件]'} ${e.name} (${e.size})`).join('\n') : '(空目录)' };
        }
        case 'read_file': {
          const parts = _VFS.normalize(args.path);
          if (parts[0] === 'workspace' && !_VFS.resolve(ctx.tree, parts)
            && ['开场说明.md', '开场白.md', '样例开场.md', '开场原文.txt', '开场剧情.txt'].includes(parts.at(-1))) {
            return { isWrite, result: '可选开场文件未提供；继续使用模组与当前世界资料。' };
          }
          const r = _VFS.readFile(ctx.tree, args.path, { cap: readCapFor(cfg, args.path, args.limit), offset: args.offset, limit: args.limit });
          recordRead(ctx, args.path);
          return { isWrite, result: framePartialRead(r, args.path) };
        }
        case 'write_file': {
          assertReadBeforeWrite(ctx, args.path);
          _VFS.writeFile(ctx.tree, args.path, args.content, writeOptions);
          recordRead(ctx, args.path);
          const change = buildChange(name, args, before, ctx.tree);
          return { isWrite, change, result: '写入成功: ' + args.path + ' (' + String(args.content).length + ' 字符)' };
        }
        case 'apply_patch': {
          _VFS.applyPatch(ctx.tree, args.path, args.old_str, args.new_str, writeOptions);
          recordRead(ctx, args.path);
          const change = buildChange(name, args, before, ctx.tree);
          return { isWrite, change, result: '补丁应用成功: ' + args.path };
        }
        case 'delete': {
          const source = _VFS.resolve(ctx.tree, _VFS.normalize(args.path));
          const binary = source && source.encoding === 'base64';
          _VFS.deletePath(ctx.tree, args.path);
          // 文件没了，读记录也该作废：同名文件重建后是新内容，不能沿用旧记录放行
          if (ctx.readState) ctx.readState.delete(args.path);
          // 非文本文件由完整工作区快照回滚，不生成会丢失编码信息的文本 diff。
          return { isWrite, change: binary ? null : buildChange(name, args, before, ctx.tree), result: '已删除: ' + args.path };
        }
        case 'move': {
          _VFS.move(ctx.tree, args.from, args.to, writeOptions);
          // 目标文件的内容是自己搬过来的，等于刚读过；源路径已不存在
          if (ctx.readState) ctx.readState.delete(args.from);
          recordRead(ctx, args.to);
          return { isWrite, change: buildChange(name, args, before, ctx.tree), result: '已移动: ' + args.from + ' → ' + args.to };
        }
        case 'copy': {
          _VFS.copy(ctx.tree, args.from, args.to, writeOptions);
          // 同上：副本内容就是自己刚复制的，无须再读一遍才能改
          recordRead(ctx, args.to);
          return { isWrite, change: buildChange(name, args, before, ctx.tree), result: '已复制: ' + args.from + ' → ' + args.to };
        }
        case 'search': {
          const r = _VFS.search(ctx.tree, { pattern: args.pattern, path: args.path, target: args.target, limit: cfg.searchResultLimit });
          if (!r.hits.length) return { isWrite, result: '无匹配结果' };
          const lines = r.hits.map(h => h.kind === 'name' ? `[名称] ${h.path}` : `${h.path}:${h.line}: ${h.text}`);
          if (r.capped) lines.push('[结果已达上限，请收窄模式]');
          return { isWrite, result: lines.join('\n') };
        }
        case 'run_skill': {
          const s = (ctx.skills || []).find(x => x.name === args.name);
          if (!s) throw new Error('Skill 不存在: ' + args.name);
          const root = '/skills/' + s.name;
          const files = Object.keys(s.files || {});
          const header = ['# Skill: ' + s.name, '根目录: ' + root];
          if (files.length) header.push('附件: ' + files.join(', '));
          // 尾注比前置说明更容易被遵守：模型读完流程正文，紧接着看到「按它执行」。
          // 这段是程序固定追加的，不占 Skill 作者的篇幅，也不会被 Skill 内容淹没。
          const footer = [
            '',
            '---',
            '以上流程现已生效，优先于你的临场判断。按它规定的步骤和顺序执行，',
            '需要其中提到的参考资料时用 read_file 从上述根目录读取（只读当前步骤需要的那些）。',
            '不要在回复里提及「Skill」「流程」「文件」等来源，把这些知识当作你自己的。',
          ].join('\n');
          return { isWrite, result: header.join('\n') + '\n\n' + s.instructions + footer };
        }
        case 'goal': {
          // 目标状态存在 ctx.goal（UI 层注入的可变对象），这里只做状态机与校验。
          // 返回 goalEvent 供 UI 更新持久化状态与渲染。
          const g = ctx.goal;
          if (!g) return { isWrite: false, result: '错误: 当前环境不支持目标功能' };
          const act = String(args.action || '').trim();
          if (act === 'set' || act === 'change') {
            const content = String(args.content || '').trim();
            if (!content) throw new Error('content 不能为空');
            if (content.length > _GOAL_MAX) throw new Error('目标过长（' + content.length + ' 字），上限 ' + _GOAL_MAX + ' 字');
            if (act === 'set' && g.content) throw new Error('当前已有目标，如需替换请用 action=change');
            if (act === 'change' && !g.content) throw new Error('当前没有目标，请先用 action=set 设立');
            const prev = g.content;
            g.content = content;
            return { isWrite: false, result: act === 'set' ? '目标已设立。接下来每轮结束会自动继续推进。' : '目标已更新。',
              goalEvent: { kind: act, content, prev } };
          }
          if (act === 'end') {
            if (!g.content) throw new Error('当前没有目标');
            const reason = String(args.reason || '').trim();
            if (reason !== 'break' && reason !== 'finished')
              throw new Error('end 需要 reason=finished（已达成）或 reason=break（需用户介入）');
            // 目标被改过但还没通知模型时，不允许直接结束——先让它看到新目标
            if (g.changedPending)
              return { isWrite: false, result: '目标已被修改，尚未生效于你的判断，无法结束。请先阅读下一条推进消息中的新目标。',
                goalEvent: { kind: 'end-rejected' } };
            const ended = g.content;
            g.content = '';
            return { isWrite: false, result: reason === 'finished' ? '目标已完成，循环结束。' : '已结束循环，等待用户介入。',
              goalEvent: { kind: 'end', reason, content: ended } };
          }
          throw new Error('未知 action: ' + act + '（可用：set / change / end）');
        }
        case 'ask_user': {
          // 唯一的异步工具：返回 Promise，由 runTurn await。
          // ctx.askUser 由 UI 层注入；缺失时（如 Node 测试）直接告知模型不可用。
          const qs = normalizeQuestions(args.questions);
          if (!qs.length) throw new Error('questions 不能为空');
          if (typeof ctx.askUser !== 'function')
            return { isWrite: false, result: '错误: 当前环境不支持向用户提问，请自行决定并说明理由' };
          return { isWrite: false, pending: ctx.askUser(qs) };
        }
        default:
          return { isWrite: false, result: '未知工具: ' + name };
      }
    } catch (e) {
      return { isWrite: false, result: '错误: ' + e.message };
    }
  }

  // transport(messages) → Promise<{content, tool_calls}>
  const abortError = () => Object.assign(new Error('已中止'), { name: 'AbortError' });
  function waitWithAbort(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(abortError()); }
    return new Promise((resolve, reject) => {
      const cancel = () => reject(abortError());
      signal.addEventListener('abort', cancel, { once: true });
      Promise.resolve(promise).then(value => { signal.removeEventListener('abort', cancel); resolve(value); },
        error => { signal.removeEventListener('abort', cancel); reject(error); });
    });
  }
  // hooks: onMessage(每产出一条消息就回调，供逐条落库)/onText/onToolStart/onToolEnd/signal
  async function runTurn(ctx, messages, transport, hooks) {
    const h = hooks || {};
    const msgs = messages.slice();
    const newMessages = [];
    let hadWrite = false;
    // 中止检查点：仅靠 fetch 的 signal 不够——工具循环里可能连续多次调用工具，
    // 每次请求之间也要能停下，否则用户点了中止仍会继续跑完剩余工具。
    const abortErr = () => Object.assign(new Error('已中止'), { name: 'AbortError' });
    const checkAbort = () => { if (h.signal && h.signal.aborted) throw abortErr(); };
    for (let loop = 0; loop < ctx.config.maxToolLoops; loop++) {
      checkAbort();
      const resp = await waitWithAbort(transport(msgs), h.signal);
      checkAbort();
      const asst = { role: 'assistant', content: resp.content || '' };
      // 思考内容用 API 的规范字段名挂回消息。DeepSeek 思考模式的硬性要求：
      // 带 tools 的请求必须在后续所有请求中完整回传 reasoning_content，缺了会 400。
      // 这里 push 进 msgs 的消息就是同轮工具循环里下一次请求的历史，字段名必须对。
      if (resp.reasoning) asst.reasoning_content = resp.reasoning;
      if (resp.tool_calls && resp.tool_calls.length) asst.tool_calls = resp.tool_calls;
      msgs.push(asst); newMessages.push(asst);
      // onMessage 让调用方逐条落库并渲染：若等整轮结束再入库，
      // 流式气泡消失到正式消息出现之间会有空档（看起来像消息丢了）。
      if (h.onMessage) await h.onMessage(asst);
      if (h.onText && asst.content) h.onText(asst.content);
      if (!asst.tool_calls) return { newMessages, hadWrite };
      const imageParts = [];
      for (const tc of asst.tool_calls) {
        checkAbort();
        if (h.onToolStart) h.onToolStart(tc);
        let out;
        try {
          const args = JSON.parse(tc.function.arguments || '{}');
          if (!args || typeof args !== 'object' || Array.isArray(args))
            throw new Error('参数必须是 JSON 对象');
          out = executeTool(ctx, tc.function.name, args);
        } catch (e) {
          // 参数串本身就不是合法 JSON（多为超长内容被截断，或转义写坏）。
          // 把长度报给模型：它能据此判断是不是太长了，改用分次写入。
          const raw = tc.function.arguments || '';
          out = { isWrite: false, result: '错误: 参数解析失败 (' + e.message + ')，收到 '
            + raw.length + ' 字符。若因内容过长被截断，请改为分多次调用（先写一部分，再用 apply_patch 续写）。' };
        }
        // ask_user 返回 pending（Promise），需等用户作答后才有结果
        if (out.pending) {
          try {
            const value = await waitWithAbort(out.pending, h.signal);
            out = { ...out, ...(typeof value === 'string' ? { result: value } : value), pending: undefined };
          }
          catch (e) { out = { isWrite: false, result: '错误: ' + (e && e.message ? e.message : String(e)) }; }
        }
        checkAbort();
        if (out.isWrite && !/^错误/.test(out.result)) hadWrite = true;
        if (out.goalEvent && h.onGoalEvent) await h.onGoalEvent(out.goalEvent);
        const toolMsg = { role: 'tool', tool_call_id: tc.id, content: out.result };
        // change 挂在消息上以便刷新后仍能展开 diff；发往 API 前会被剥离（见 sanitizeForApi）
        if (out.change) toolMsg.change = out.change;
        if (out.image) {
          imageParts.push({ type: 'text', text: '工具 view_image 返回的图片：' + out.image.path },
            { type: 'image_url', image_url: { url: out.image.dataUrl } });
        }
        for (const image of out.images || []) {
          imageParts.push({ type: 'text', text: '工具 ' + tc.function.name + ' 返回的第 ' + image.page + ' 页图片（' + image.width + '×' + image.height + '）' },
            { type: 'image_url', image_url: { url: image.dataUrl } });
        }
        msgs.push(toolMsg); newMessages.push(toolMsg);
        if (h.onMessage) await h.onMessage(toolMsg);
        if (h.onToolEnd) h.onToolEnd(tc, out);
      }
      // Finish the full tool batch before injecting an image-only user message.
      // This adapter is request-local: neither base64 nor synthetic user turns are persisted.
      if (imageParts.length) msgs.push({ role: 'user', content: imageParts });
    }
    const final = { role: 'assistant', content: '(已达最大工具调用次数 ' + ctx.config.maxToolLoops + '，本轮终止)' };
    newMessages.push(final);
    if (h.onMessage) await h.onMessage(final);
    return { newMessages, hadWrite };
  }

  // 真实 HTTP transport（仅浏览器使用；Node 测试不覆盖）
  /* 思考强度 → 请求字段。
     各家字段名互不相同：
       reasoning_effort     OpenAI 官方（none 即关闭，无独立开关）/ DeepSeek
       thinking:{type}      DeepSeek / 智谱（OpenAI 格式）
       enable_thinking      Qwen / 部分自建 vLLM 网关
       reasoning:{effort}   Responses 风格网关
     DeepSeek/vLLM 系对不认识的字段一律忽略，可以全带上；但 OpenAI 官方和 Azure
     会对未知字段直接 400（Unrecognized request argument）。所以按层级降级：
       0 = 全量方言字段；1 = 仅 OpenAI 官方的 reasoning_effort；2 = 什么都不发。
     transport 收到 400/422 且错误文本点名这些字段时自动升层重试，并按
     baseUrl+model 记住可用层级，同一会话内不再重复试错。
     关闭档（none）同样发送 reasoning_effort: 'none'——有的实现只看强度不看开关，
     只发开关会被当成「没指定」而回落到默认开启。 */
  const EFFORT_LEVELS = ['none', 'low', 'high', 'xhigh', 'max'];
  const THINK_FIELDS = ['thinking', 'enable_thinking', 'reasoning_effort', 'reasoning'];
  const _thinkTiers = new Map(); // baseUrl|model → 已探明可用的层级
  function applyThinkingFields(body, effort, tier) {
    const lv = EFFORT_LEVELS.includes(effort) ? effort : 'high';
    const t = tier || 0;
    if (t >= 2) return body;
    body.reasoning_effort = lv;
    if (t >= 1) return body;
    const on = lv !== 'none';
    body.thinking = { type: on ? 'enabled' : 'disabled' };
    body.enable_thinking = on;
    body.reasoning = { effort: lv };
    return body;
  }
  function isThinkFieldError(status, text) {
    if (status !== 400 && status !== 422) return false;
    return THINK_FIELDS.some(f => String(text).includes(f));
  }

  function createHttpTransport(settings, toolDefs, callbacks) {
    return async function transport(messages) {
      const base = _ApiUrl.root(settings.baseUrl);
      const tierKey = base + '|' + settings.model;
      let tier = _thinkTiers.get(tierKey) || 0;
      let resp;
      for (;;) {
        const body = {
          model: settings.model,
          messages: callbacks && callbacks.prepareMessages ? callbacks.prepareMessages(messages) : messages,
          temperature: Number(settings.temperature),
          stream: !!settings.stream,
        };
        applyThinkingFields(body, settings.reasoningEffort, tier);
        if (toolDefs && toolDefs.length) body.tools = toolDefs; // 空 tools（压缩场景）不设该字段
        const imageCount = body.messages.reduce((n, m) => n + (Array.isArray(m.content)
          ? m.content.filter(p => p.type === 'image_url').length : 0), 0);
        if (imageCount > 600) throw new Error('单次请求图片超过 600 张，请减少图片后重试');
        const encoded = JSON.stringify(body);
        if (new TextEncoder().encode(encoded).length > 48 * 1024 * 1024)
          throw new Error('请求超过 48 MiB，请减少图片或压缩上下文后重试');
        resp = await fetch(base + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + settings.apiKey },
          body: encoded,
          signal: callbacks && callbacks.signal,
        });
        if (resp.ok) break;
        const text = await resp.text().catch(() => '');
        // 思考字段不被认（OpenAI/Azure 风格的 400）→ 减字段重试，其余错误照常抛
        if (tier < 2 && isThinkFieldError(resp.status, text)) { tier++; continue; }
        throw new Error('API 错误 ' + resp.status + ': ' + text.slice(0, 300));
      }
      _thinkTiers.set(tierKey, tier);
      if (!settings.stream) {
        const json = await waitWithAbort(resp.json(), callbacks && callbacks.signal);
        const m = json.choices[0].message;
        // 非流式：思考与正文在同一条 message 里一并返回
        return { content: m.content || '', reasoning: _SSE.readReasoning(m), tool_calls: m.tool_calls || [] };
      }
      const parser = _SSE.createParser();
      const acc = _SSE.createAccumulator();
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      const sig = callbacks && callbacks.signal;
      const cancelReader = () => { reader.cancel().catch(() => {}); };
      sig?.addEventListener('abort', cancelReader, { once: true });
      try {
        for (;;) {
          // 中止必须打断等待中的读取，不能等下一段流式内容到达才检查。
          if (sig && sig.aborted) {
            cancelReader();
            throw abortError();
          }
          const { done, value } = await waitWithAbort(reader.read(), sig);
          if (sig?.aborted) throw abortError();
          if (done) break;
          for (const data of parser.push(dec.decode(value, { stream: true }))) {
            try {
              const json = JSON.parse(data);
              acc.add(json);
              const delta = json.choices && json.choices[0] && json.choices[0].delta;
              const think = _SSE.readReasoning(delta);
              if (think && callbacks && callbacks.onReasoningDelta) callbacks.onReasoningDelta(think);
              if (delta && delta.content && callbacks && callbacks.onDelta) callbacks.onDelta(delta.content);
              // 工具参数是逐字流式吐出来的，长内容可能要十几秒。把中间快照抛给界面，
              // 用户才能看到「正在写 xxx」而不是一段莫名其妙的空白。
              if (delta && delta.tool_calls && callbacks && callbacks.onToolDelta)
                callbacks.onToolDelta(acc.partial());
            } catch (_) { /* 忽略无法解析的分片 */ }
          }
        }
        return acc.result();
      } finally {
        sig?.removeEventListener('abort', cancelReader);
        reader.releaseLock();
      }
    };
  }

  function toolDefinitions(skills, { imageSending = true } = {}) {
    return [..._TOOL_DEFS, ...(_BuilderTools.enabled(skills) ? _BuilderTools.definitions : [])]
      .filter(tool => imageSending || tool.function.name !== 'view_image')
      .map(tool => imageSending || tool.function.name !== 'parse_document' ? tool : {
        ...tool, function: { ...tool.function,
          description: tool.function.description + ' 当前模型不支持图片输入：format=images 只允许 output=file；format=text 可直接返回或保存。' },
      });
  }
  return { toolDefinitions, executeTool, runTurn, createHttpTransport, applyThinkingFields, isThinkFieldError, EFFORT_LEVELS, WRITE_TOOLS, recordRead, assertReadBeforeWrite, normalizeQuestions, hasOtherOption, readCapFor };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Agent;
