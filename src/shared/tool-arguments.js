'use strict';
const ToolArguments = (() => {
  const HINT = '工具参数格式异常，可能与模型输出或模型服务兼容性有关；也可能是响应传输、处理异常。';
  const NOTICE = HINT + '已隔离异常参数，正在尝试继续。若反复出现，请尝试更换模型或服务。';
  const PLACEHOLDER = '[历史参数异常] 此调用的参数无法解析为 JSON 对象，发送时已用 {} 占位；占位内容不代表真实参数。执行状态以原始回执为准，不要重复已成功的操作；失败的调用请重新生成合法参数。\n原始回执：\n';
  function parse(raw) {
    try {
      if (typeof raw !== 'string') throw new Error('参数必须是 JSON 字符串');
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数必须是 JSON 对象');
      return value;
    } catch (error) {
      error.code = 'INVALID_TOOL_ARGUMENTS';
      throw error;
    }
  }
  function invalid(call) {
    try { parse(call?.function?.arguments); return false; } catch (_) { return true; }
  }
  const hasInvalid = messages => messages.some(m => m.role === 'assistant' && m.tool_calls?.some(invalid));
  // Repair only the wire copy. Execution must always parse the original arguments.
  function project(messages) {
    if (!Array.isArray(messages) || !hasInvalid(messages)) return messages;
    const changed = new Set();
    const out = messages.map(m => {
      if (m.role !== 'assistant' || !m.tool_calls?.length) return m;
      const tool_calls = m.tool_calls.map(call => {
        if (!invalid(call)) return call;
        changed.add(call.id);
        return { ...call, function: { ...call.function, arguments: '{}' } };
      });
      return tool_calls.every((call, i) => call === m.tool_calls[i]) ? m : { ...m, tool_calls };
    });
    return out.map(m => m.role === 'tool' && changed.has(m.tool_call_id)
      ? { ...m, content: PLACEHOLDER + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')) } : m);
  }
  return { HINT, NOTICE, parse, invalid, hasInvalid, project };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ToolArguments;
