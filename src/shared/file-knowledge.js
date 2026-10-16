'use strict';
// File-level evidence: partial reads count as reads; edits keep their original basis.
const FileKnowledge = (() => {
  const VERSION = 2;
  const validTurn = turn => Number.isSafeInteger(turn) && turn >= 0;
  const create = (turn = 0) => ({ version: VERSION, turn: validTurn(turn) ? turn : 0, entries: {} });
  function prepare(state) {
    if (state.version !== VERSION) { state.version = VERSION; state.entries = {}; }
    if (!state.entries || typeof state.entries !== 'object') state.entries = {};
    if (!validTurn(state.turn)) state.turn = 0;
    return state;
  }
  function setTurn(state, turn) {
    prepare(state);
    if (validTurn(turn)) state.turn = turn;
  }
  function fresh(state, path) {
    prepare(state);
    const entry = state.entries[path];
    return !!entry && validTurn(entry.turn) && Array.isArray(entry.dependencies);
  }
  function canOverwrite(state, path) {
    return fresh(state, path) && state.turn >= state.entries[path].turn && state.turn - state.entries[path].turn <= 1;
  }
  function record(state, path, callId, kind = 'read') {
    prepare(state);
    if (kind === 'weak') {
      if (!fresh(state, path)) return;
      const entry = state.entries[path];
      if (callId != null && !entry.dependencies.includes(callId)) entry.dependencies.push(callId);
      return;
    }
    state.entries[path] = { turn: state.turn, baseCallId: callId ?? null, dependencies: callId == null ? [] : [callId] };
  }
  function transfer(state, from, to, callId, source = state) {
    prepare(state);
    if (!fresh(source, from)) return false;
    const entry = source.entries[from];
    state.entries[to] = { ...entry, dependencies: [...new Set([...entry.dependencies, ...(callId == null ? [] : [callId])])] };
    return true;
  }
  function retain(state, messages, forget) {
    prepare(state);
    const calls = new Set(messages.flatMap(m => m.role === 'assistant' ? (m.tool_calls || []).map(c => c.id) : []));
    const visible = new Set(messages.filter(m => {
      if (m.role !== 'tool' || !calls.has(m.tool_call_id)) return false;
      try { const result = JSON.parse(m.content); if (result?.archived || result?.ok === false) return false; }
      catch (_) { if (/^错误[:：]/.test(m.content)) return false; }
      return true;
    }).map(m => m.tool_call_id));
    // Startup reads are projected as ordinary user data with the original receipts.
    for (const m of messages) if (m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[开局预读资料]\n')) {
      try { for (const op of JSON.parse(m.content.slice(m.content.indexOf('\n') + 1)).operations || [])
        if (op.result?.ok === true && !op.result.archived) visible.add(op.call_id); } catch (_) {}
    }
    for (const [path, entry] of Object.entries(state.entries))
      if (!fresh(state, path) || !visible.has(entry.baseCallId) || !entry.dependencies.every(id => visible.has(id))) {
        delete state.entries[path]; forget(path);
      }
  }
  return { VERSION, create, setTurn, record, fresh, canOverwrite, transfer, retain };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = FileKnowledge;
