'use strict';
/* 压缩引擎：轮次感知 + 模板化提示词 + 分段接力（双请求）压缩。
   纯逻辑模块：transport 由调用方注入，Node 下可测。 */
const Compress = (() => {
  const _Tokens = (typeof module !== 'undefined') ? require('./tokens.js') : Tokens;
  const _C = (typeof module !== 'undefined') ? require('./00-config.js') : { COMPRESS_CONFIG, renderTemplate };

  // 头尾预览：超过阈值才截断，中间省略但保留头尾——摘要要写出真代码片段，
  // 前提是压缩模型本来就得看到真代码，不能一上来就砍成看不出内容的短片段。
  function previewText(s, cfg) {
    s = String(s == null ? '' : s);
    if (s.length <= cfg.transcriptPreviewChars) return s;
    const head = s.slice(0, cfg.transcriptHeadChars);
    const tail = cfg.transcriptTailChars ? s.slice(-cfg.transcriptTailChars) : '';
    return head + '\n…(中间省略 ' + (s.length - head.length - tail.length) + ' 字)…\n' + tail;
  }

  // 工具调用渲染成转录行：write_file/apply_patch 的实际内容要露出来，
  // 否则压缩模型只看得到文件名，写不出真实的"文件与改动"一节。其余工具保留简要 brief。
  function toolCallLines(tc, cfg) {
    let a = {};
    try { a = JSON.parse(tc.function.arguments || '{}'); } catch (_) { return ['【工具】' + tc.function.name]; }
    const name = tc.function.name;
    if (name === 'write_file' && typeof a.content === 'string')
      return ['【工具】write_file ' + (a.path || ''), '  内容: ' + previewText(a.content, cfg)];
    if (name === 'apply_patch' && (typeof a.old_str === 'string' || typeof a.new_str === 'string'))
      return [
        '【工具】apply_patch ' + (a.path || ''),
        '  - ' + previewText(a.old_str || '', cfg),
        '  + ' + previewText(a.new_str || '', cfg),
      ];
    const brief = a.path || a.from || a.pattern || a.name || '';
    return ['【工具】' + name + (brief ? ' ' + brief : '')];
  }

  // 把消息序列渲染为压缩输入文本。工具调用与结果合并在同一轮文本内，天然不拆分。
  function renderTranscript(msgs, cfg) {
    cfg = cfg || _C.COMPRESS_CONFIG;
    const lines = [];
    for (const m of msgs) {
      if (m.role === 'user') {
        lines.push('【用户】' + _Tokens.contentText(m.content));
        for (const ref of m.attachments || []) lines.push('[图片附件路径: ' + ref.path + '；需要时用 view_image 查看，临时附件可能过期]');
        const count = _Tokens.contentImages(m.content).length;
        if (count) lines.push('[附有 ' + count + ' 张图片；图片内容未纳入文本摘要，请参考后续回答或请用户重新发送]');
      }
      else if (m.role === 'assistant') {
        if (m.content) lines.push('【AI】' + m.content);
        for (const tc of m.tool_calls || []) lines.push(...toolCallLines(tc, cfg));
      } else if (m.role === 'tool') {
        lines.push('【结果】' + previewText(m.content, cfg));
      } else if (m.role === 'compressed') {
        lines.push('【早前摘要】' + m.summary);
      }
    }
    return lines.join('\n');
  }

  // 压缩计划：保留最近 keepRecentTurns 轮原文，其余按输入预算切段（段边界=轮次边界）
  function planCompression(messages, opts) {
    const cfg = { ..._C.COMPRESS_CONFIG, ...(opts || {}) };
    const groups = _Tokens.groupTurns(messages);
    const turnIdx = groups.map((g, i) => g.turn ? i : -1).filter(i => i >= 0);
    const keepFrom = turnIdx.length > cfg.keepRecentTurns
      ? turnIdx[turnIdx.length - cfg.keepRecentTurns] : (turnIdx[0] !== undefined ? turnIdx[0] : groups.length);
    const toCompress = groups.slice(0, keepFrom).flatMap(g => g.msgs);
    const keepRecent = groups.slice(keepFrom).flatMap(g => g.msgs);
    if (!toCompress.length) return { chunks: [], keepRecent, compressCount: 0 };
    const budget = Math.floor((opts && opts.inputBudgetTokens) || 0);
    const chunks = budget > 0 ? _Tokens.chunkByBudget(toCompress, budget) : [toCompress];
    return { chunks, keepRecent, compressCount: toCompress.length };
  }

  // 执行接力压缩：逐段请求，把上一段摘要注入下一段（第 2+ 段即“双请求压缩”）。
  // transport(messages) → Promise<{content}>；onProgress(i, total) 可选。
  async function run(messages, opts, transport, onProgress) {
    const cfg = { ..._C.COMPRESS_CONFIG, ...(opts || {}) };
    const plan = planCompression(messages, opts);
    if (!plan.chunks.length) return null;
    const total = plan.chunks.length;
    let summary = '';
    for (let i = 0; i < total; i++) {
      if (onProgress) onProgress(i + 1, total);
      const isRelay = i > 0;
      const vars = {
        maxWords: cfg.maxWords,
        fileTree: (opts && opts.fileTree) || '(未提供)',
        chunkIndex: i + 1,
        chunkTotal: total,
        prevChunks: i,
      };
      // 第 2 段起改用接力模板：明确告知哪部分已压缩过，并要求给出压缩心得
      const sysTpl = (isRelay && cfg.relaySystemTemplate) ? cfg.relaySystemTemplate : cfg.systemTemplate;
      const sys = _C.renderTemplate(sysTpl, vars);
      const user = _C.renderTemplate(cfg.userTemplate, {
        prevSummary: summary ? cfg.prevSummaryPrefix + '\n' + summary : '',
        transcript: renderTranscript(plan.chunks[i], cfg),
      });
      const resp = await transport([
        { role: 'system', content: sys },
        { role: 'user', content: user.trim() },
      ]);
      summary = (resp.content || '').trim();
      if (!summary) throw new Error('压缩请求返回空内容');
    }
    return {
      mark: { role: 'compressed', count: plan.compressCount, summary, chunks: total },
      keepRecent: plan.keepRecent,
    };
  }

  return { renderTranscript, planCompression, run };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Compress;
