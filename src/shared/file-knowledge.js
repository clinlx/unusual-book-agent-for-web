'use strict';
// Evidence expires with context or after a long gap, independently of content checks.
const FileKnowledge = (() => {
  const MAX_GAP = 32;
  const create = () => ({ sequence: 0, entries: {} });
  function tick(state) { state.sequence++; }
  function record(state, path, callId) {
    state.entries[path] = { sequence: state.sequence, callId: callId ?? state.entries[path]?.callId ?? null };
  }
  const fresh = (state, path) => Object.hasOwn(state.entries,path) && state.sequence - state.entries[path].sequence <= MAX_GAP;
  function retain(state, messages, forget) {
    const calls = new Set(messages.flatMap(m => m.role === 'assistant' ? (m.tool_calls || []).map(c => c.id) : []));
    const visible = new Set(messages.filter(m => {
      if(m.role !== 'tool' || !calls.has(m.tool_call_id))return false;
      try { if(JSON.parse(m.content)?.archived)return false; } catch (_) { /* Designer returns text. */ }
      return true;
    }).map(m => m.tool_call_id));
    // Startup reads are projected as an ordinary message, with their real receipts.
    for(const m of messages)if(m.role==='user'&&typeof m.content==='string'&&m.content.startsWith('[开局预读资料]\n')){
      try {for(const op of JSON.parse(m.content.slice(m.content.indexOf('\n')+1)).operations||[])if(op.result?.ok===true&&!op.result.archived)visible.add(op.call_id);}catch(_){}
    }
    for(const [path,entry] of Object.entries(state.entries))if(!fresh(state,path)||!visible.has(entry.callId)){
      delete state.entries[path];forget(path);
    }
  }
  return { MAX_GAP, create, tick, record, fresh, retain };
})();
if(typeof module !== 'undefined' && module.exports)module.exports = FileKnowledge;
