'use strict';
const ContextBudget = (() => {
  const T = typeof module !== 'undefined' ? require('./tokens.js') : Tokens;
  const HINT = '手动点击压缩按钮或者在设置中切换上下文处理方式';
  const local = new Set(['attachments', 'change', 'displayOnly', 'displayContent', 'stashPath', 'fullLength', 'at', 'hint', 'count', 'summary', 'msgId', 'goalPush', 'goalSet', 'goalText', 'reasoning', 'validationReport']);
  function project(messages) {
    return T.pruneReasoning(T.sanitizeMessages(messages.filter(m => !m.displayOnly && m.role !== 'system-error').map(m => {
      if (m.role === 'compressed') return { role: 'assistant', content: '[早前对话摘要]\n' + m.summary };
      return Object.fromEntries(Object.entries(m).filter(([k]) => !local.has(k)));
    })));
  }
  function cost(messages, tools = []) {
    const clean = project(messages);
    return T.estimateMessages(clean) + clean.length * 6 + (tools.length ? T.estimateText(JSON.stringify(tools)) : 0);
  }
  function limitError(used, cap) {
    return Object.assign(new Error('上下文已满（估算 ' + Math.ceil(used) + ' / ' + cap + ' tokens）：' + HINT), { code: 'CONTEXT_LIMIT' });
  }
  function isLimitError(e) {
    return e.code === 'CONTEXT_LIMIT' || /context_length_exceeded|maximum context length|context window|context length.{0,80}(exceed|limit|long)|input tokens.{0,80}(exceed|maximum)|上下文.{0,8}(超|满)/is.test(e.message || '');
  }
  function fit(messages, cap, tools = [], mode = 'disabled') {
    let clean = project(messages);
    if (cost(clean, tools) > cap && ['sliding', 'truncate'].includes(mode)) {
      const available = Math.max(0, cap - cost([], tools) - clean.length * 6);
      clean = project(mode === 'sliding' ? T.slidingWindow(clean, available) : T.truncateOldest(clean, available));
    }
    const used = cost(clean, tools);
    if (used > cap) throw limitError(used, cap);
    return clean;
  }
  function fold(messages, out) {
    const keep = new Set(out.keepRecent);
    return [...messages.filter(m => !keep.has(m)).map(m => m.role === 'system-error' ? m : { ...m, displayOnly: true }),
      out.mark, ...out.keepRecent.map(m => m.role === 'compressed' ? { ...m, displayOnly: true } : m)];
  }
  function requireReduction(before, after, tools = []) {
    if (cost(after, tools) >= cost(before, tools)) throw new Error('压缩未减少上下文，已保留原始记录，请重试压缩或在设置中切换上下文处理方式');
  }
  return { HINT, project, cost, fit, fold, requireReduction, limitError, isLimitError };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ContextBudget;
