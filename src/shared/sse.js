'use strict';
const SSE = (() => {
  function createParser() {
    let buf = '';
    return {
      push(chunk) {
        buf = (buf + chunk).replace(/\r\n/g, '\n');
        const out = [];
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split('\n')) {
            const m = line.match(/^data:\s?(.*)$/);
            if (m && m[1].trim() && m[1].trim() !== '[DONE]') out.push(m[1]);
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


  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
  function protocolError(detail) {
    return Object.assign(new Error('模型响应协议异常：' + detail + '。已停止处理本次响应，未执行其中的工具调用。请重试；若反复出现，请检查模型服务的工具调用格式或更换模型。'), { code: 'MODEL_PROTOCOL_ERROR' });
  }
  function checkResponse(json) {
    if (!object(json)) throw protocolError('响应必须是 JSON 对象');
    if (json.error) throw Object.assign(new Error('模型服务返回错误：' + (json.error.message || '未知错误')), { code: 'MODEL_RESPONSE_ERROR' });
    if (!Array.isArray(json.choices)) throw protocolError('响应缺少 choices 数组');
    if (json.choices.some(choice => !object(choice))) throw protocolError('choices 包含无效条目');
    return json;
  }
  function parseData(data) {
    let json;
    try { json = JSON.parse(data); }
    catch (_) { throw protocolError('SSE 数据不是合法 JSON'); }
    return checkResponse(json);
  }
  async function readJSON(response) {
    let json;
    try { json = await response.json(); }
    catch (error) {
      if (error instanceof SyntaxError) throw protocolError('响应体不是合法 JSON');
      throw error;
    }
    return checkResponse(json);
  }
  function checkMessage(message, partial = false) {
    if (!object(message)) throw protocolError(partial ? 'delta 必须是对象' : '响应缺少有效 message');
    if (message.content != null && typeof message.content !== 'string') throw protocolError('content 必须是字符串或 null');
    if (message.tool_calls == null) return message;
    if (!Array.isArray(message.tool_calls)) throw protocolError('tool_calls 必须是数组');
    for (const call of message.tool_calls) {
      if (!object(call)) throw protocolError('工具调用必须是对象');
      if (call.type != null && call.type !== 'function') throw protocolError('工具调用 type 必须是 function');
      if (partial && call.index != null && (!Number.isSafeInteger(call.index) || call.index < 0)) throw protocolError('工具分片 index 必须是非负整数');
      if (call.id != null && typeof call.id !== 'string') throw protocolError('工具调用 id 必须是字符串');
      if (partial && call.function == null) continue;
      if (!object(call.function)) throw protocolError('工具调用缺少 function 对象');
      const fn = call.function;
      if (fn.name != null && typeof fn.name !== 'string' || !partial && (typeof fn.name !== 'string' || !fn.name.trim()))
        throw protocolError('工具调用缺少有效函数名');
      // JSON 字符串内部的语法错误留给工具回执处理，不能与响应结构损坏混为一谈。
      if (Object.hasOwn(fn, 'arguments') && typeof fn.arguments !== 'string') throw protocolError('function.arguments 必须是 JSON 字符串');
      if (!partial && typeof fn.arguments !== 'string') throw protocolError('工具调用缺少 arguments 字符串');
    }
    return message;
  }
  function streamError(error) {
    if (error?.name === 'AbortError') return error;
    return Object.assign(new Error('模型响应流读取失败，已停止处理本次响应，未执行其中的工具调用。请检查连接后重试。'), { code: 'MODEL_STREAM_ERROR', cause: error });
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
        checkResponse(json);
        const delta = json.choices[0]?.delta;
        if (delta == null) {
          if (json.choices[0]?.message != null) throw protocolError('流式响应包含 message 而非 delta');
          return;
        }
        checkMessage(delta, true);
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
        return checkMessage({ content, reasoning, tool_calls: snapshot() });
      },
    };
  }

  return { createParser, createAccumulator, readReasoning, partialJsonString, protocolError, parseData, readJSON, checkMessage, streamError };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SSE;
