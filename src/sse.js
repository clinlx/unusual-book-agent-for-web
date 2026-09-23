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

  // Decode one string field from an incomplete JSON object. This is used for
  // preview only: the complete tool arguments are still parsed with JSON.parse
  // before the tool is executed.
  function partialJsonString(source, key) {
    source = String(source || '');
    const safeTail = value => /[\ud800-\udbff]$/.test(value) ? value.slice(0, -1) : value;
    const skipSpace = i => { while (i < source.length && /\s/.test(source[i])) i++; return i; };
    function readString(start, partial) {
      if (source[start] !== '"') return null;
      let value = '';
      for (let i = start + 1; i < source.length; i++) {
        const ch = source[i];
        if (ch === '"') return { value, end: i + 1, closed: true };
        if (ch !== '\\') {
          if (ch.charCodeAt(0) < 0x20) return partial ? { value: safeTail(value), end: i, closed: false } : null;
          value += ch; continue;
        }
        if (++i >= source.length) return partial ? { value: safeTail(value), end: source.length, closed: false } : null;
        const esc = source[i];
        const simple = {'"':'"', '\\':'\\', '/':'/', b:'\b', f:'\f', n:'\n', r:'\r', t:'\t'};
        if (Object.hasOwn(simple, esc)) { value += simple[esc]; continue; }
        if (esc === 'u') {
          if (i + 4 >= source.length) return partial ? { value: safeTail(value), end: source.length, closed: false } : null;
          const hex = source.slice(i + 1, i + 5);
          if (!/^[0-9a-f]{4}$/i.test(hex)) return partial ? { value: safeTail(value), end: i, closed: false } : null;
          value += String.fromCharCode(parseInt(hex, 16)); i += 4; continue;
        }
        return partial ? { value: safeTail(value), end: i, closed: false } : null;
      }
      return partial ? { value: safeTail(value), end: source.length, closed: false } : null;
    }
    for (let i = 0; i < source.length;) {
      if (source[i] !== '"') { i++; continue; }
      const token = readString(i, false);
      if (!token) break;
      let next = skipSpace(token.end);
      if (token.value === key && source[next] === ':') {
        next = skipSpace(next + 1);
        if (source[next] !== '"') return null;
        return readString(next, true)?.value ?? null;
      }
      i = token.end;
    }
    return null;
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
            if (tc.function.name) {
              const next = String(tc.function.name), current = calls[i].name;
              calls[i].name = !current ? next : next === current ? current :
                next.startsWith(current) ? next : current.endsWith(next) ? current : current + next;
            }
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

  return { createParser, createAccumulator, readReasoning, partialJsonString };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SSE;
