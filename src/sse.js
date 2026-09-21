'use strict';
const SSE = (() => {
  function createParser() {
    let buf = '';
    return {
      push(chunk) {
        buf += chunk;
        const out = [];
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split('\n')) {
            const m = line.match(/^data:\s?(.*)$/);
            if (m && m[1] !== '[DONE]') out.push(m[1]);
          }
        }
        return out;
      },
    };
  }

  
  
  function readReasoning(o) {
    if (!o) return '';
    const v = o.reasoning_content != null ? o.reasoning_content : o.reasoning;
    return typeof v === 'string' ? v : '';
  }

  function createAccumulator() {
    let content = '', reasoning = '';
    const calls = {}; 
    
    
    const snapshot = () => Object.keys(calls).sort((a, b) => a - b).map(i => ({
      id: calls[i].id,
      type: 'function',
      function: { name: calls[i].name, arguments: calls[i].arguments },
    }));
    return {
      add(json) {
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (!delta) return;
        reasoning += readReasoning(delta);
        if (delta.content) content += delta.content;
        if (delta.tool_calls) for (const tc of delta.tool_calls) {
          const i = tc.index || 0;
          if (!calls[i]) calls[i] = { id: '', name: '', arguments: '' };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function) {
            if (tc.function.name) calls[i].name = tc.function.name;
            if (tc.function.arguments) calls[i].arguments += tc.function.arguments;
          }
        }
      },
      partial: snapshot,
      result() {
        return { content, reasoning, tool_calls: snapshot() };
      },
    };
  }

  return { createParser, createAccumulator, readReasoning };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SSE;
