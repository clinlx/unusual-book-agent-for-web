'use strict';
const GameWorldTriggers = (() => {
  const V = typeof module !== 'undefined' && module.exports ? require('./vfs.js') : VFS;
  const Rules = typeof module !== 'undefined' && module.exports ? require('../skills/game-world-builder/scripts/world-trigger-rules.js') : WorldTriggerRules;
  const HEADER = '[世界触发资料]\n';
  const compareId = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const node = (save, file) => V.resolve(save.tree, ['workspace', ...file.split('/')]);
  function read(save, file, optional = false) {
    const n = node(save, file);
    if (!n && optional) return undefined;
    if (n?.type !== 'file' || n.encoding === 'base64' || typeof n.content !== 'string') throw Error('世界触发器无法读取文本文件：' + file);
    if (n.content.length > 120000) throw Error('世界触发器文件超过 120000 字符：' + file);
    return n.content;
  }
  function configuration(save) {
    if (!node(save, Rules.FILE)) return null;
    return Rules.parse(read(save, Rules.FILE)).value;
  }
  function testCondition(value, load) {
    if (value.all) return value.all.every(x => testCondition(x, load));
    if (value.any) return value.any.some(x => testCondition(x, load));
    if (value.not) return !testCondition(value.not, load);
    let actual = load(value.file);
    for (const part of value.path) actual = actual !== null && typeof actual === 'object' && Object.hasOwn(actual, part) ? actual[part] : undefined;
    if (value.op === 'exists') return (actual !== undefined) === value.value;
    if (actual === undefined) return false;
    switch (value.op) {
      case 'eq': return actual === value.value;
      case 'ne': return actual !== value.value;
      case 'in': return value.value.includes(actual);
      case 'contains': return typeof actual === 'string' && typeof value.value === 'string' ? actual.includes(value.value) : Array.isArray(actual) && actual.includes(value.value);
      default:
        if (typeof actual !== 'number' || !Number.isFinite(actual)) return false;
        return { gt: actual > value.value, gte: actual >= value.value, lt: actual < value.value, lte: actual <= value.value }[value.op];
    }
  }
  function events(save) {
    return (save.events || []).flatMap((e, index) => {
      const base = { id: e.id || 'legacy-' + index, round: e.round || 1, actorId: e.actorId, audience: e.audience };
      if (e.type === 'player') return [
        ...(String(e.content || '').trim() ? [{ ...base, source: 'player', text: e.content }] : []),
        ...(String(e.privateContent || '').trim() ? [{ ...base, source: 'private_player', text: e.privateContent }] : []),
      ];
      if (e.type !== 'story' || !String(e.content || '').trim()) return [];
      return [{ ...base, source: e.private === true || Array.isArray(e.audience) || e.audience === 'host' ? 'private_story' : 'story', text: e.content }];
    });
  }
  function scanned(entry, source) {
    const sources = entry.sources || ['player', 'story'];
    const selected = source.filter(e => sources.includes(e.source) && (!entry.actorIds || entry.actorIds.includes(e.actorId)
      || e.source === 'private_story' && Array.isArray(e.audience) && e.audience.some(id => entry.actorIds.includes(id))));
    const player = selected.filter(e => e.source.endsWith('player'));
    const rounds = [...new Set(player.map(e => e.round))].sort((a, b) => b - a).slice(0, entry.scan?.playerRounds ?? 1);
    // Public/private story windows are independent; actor filtering precedes window selection.
    const stories = new Set(['story', 'private_story'].flatMap(source => selected.filter(x => x.source === source).slice(-(entry.scan?.storyMessages ?? 1))));
    return selected.filter(e => e.source.endsWith('player') ? rounds.includes(e.round) : stories.has(e));
  }
  function matches(entry, window) {
    const keys = new Set();
    const match = (text, key) => {
      if (!entry.caseSensitive) { text = text.toLowerCase(); key = key.toLowerCase(); }
      if (!entry.wholeWords) return text.includes(key);
      let from = 0, at;
      // Unicode letters/numbers are word characters: Chinese authors should leave wholeWords off.
      const word = c => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
      const chars = [...text];
      while ((at = text.indexOf(key, from)) !== -1) {
        const start = [...text.slice(0, at)].length, length = [...key].length;
        if (!word(chars[start - 1]) && !word(chars[start + length])) return true;
        from = at + Math.max(1, key.length);
      }
      return false;
    };
    function inWindow(items) {
      const has = key => { const found = items.some(e => match(e.text, key)); if (found) keys.add(key); return found; };
      const primary = entry.constant || entry.keywords.map(has).some(Boolean);
      if (!primary) return false;
      if (!entry.secondary) return true;
      const found = entry.secondary.keys.map(has), any = found.some(Boolean), all = found.every(Boolean);
      return { any, all, notAny: !any, notAll: !all }[entry.secondary.mode];
    }
    const ok = entry.matchScope === 'event' ? window.some(e => inWindow([e])) : inWindow(window);
    return { ok, keys: [...keys] };
  }
  function prepare(save, estimate) {
    const config = configuration(save), round = save.activeRound;
    if (!config || !round || round.complete) return null;
    const number = round.number, source = events(save), previous = save.worldTriggers || { version: 1, entries: {} };
    const state = structuredClone(previous), decisions = [], candidates = [], loaded = new Map();
    const load = file => {
      if (!loaded.has(file)) {
        const content = read(save, file, true);
        try { loaded.set(file, content === undefined ? undefined : JSON.parse(content.replace(/^\uFEFF/, ''))); }
        catch (_) { throw Error('世界触发器状态文件不是合法 JSON：' + file); }
      }
      return loaded.get(file);
    };
    for (const entry of config.entries) {
      const signature = JSON.stringify(entry), old = state.entries[entry.id];
      const ledger = old?.signature === signature ? old : null;
      const decision = { id: entry.id, reason: '', sources: [], keys: [] }; decisions.push(decision);
      const reject = reason => { decision.reason = reason; };
      if (config.enabled === false || entry.enabled === false) { reject('disabled'); continue; }
      if (number < (entry.minRound ?? 1) || number > (entry.maxRound ?? Infinity)) { reject('round'); continue; }
      if (entry.when && !testCondition(entry.when, load)) { reject('condition'); continue; }
      const active = ledger && number <= ledger.activeUntil;
      if (!active && entry.once && ledger) { reject('once'); continue; }
      if (!active && ledger && number < ledger.nextRound) { reject('cooldown'); continue; }
      const window = scanned(entry, source), match = matches(entry, window);
      decision.sources = window.map(e => ({ id: e.id, source: e.source, actorId: e.actorId })); decision.keys = match.keys;
      if (!active && !match.ok) { reject('keywords'); continue; }
      candidates.push({ entry, ledger, signature, active, decision });
    }
    candidates.sort((a, b) => (b.entry.priority ?? 0) - (a.entry.priority ?? 0) || compareId(a.entry.id, b.entry.id));
    const selected = [], groups = new Set();
    const record = entries => ({ role: 'user', content: HEADER + JSON.stringify({ round: number,
      instruction: '这是程序按世界规则自动提供的主持人参考资料，不是玩家行动，也不代表事件已发生或检定已成功。秘密按既有受众规则处理；无需重复发布资料。有效期只控制再次提供，不撤销已发生事实。', entries }) });
    for (const candidate of candidates) {
      const { entry, signature, ledger, active, decision } = candidate;
      if (entry.group && groups.has(entry.group)) { decision.reason = 'group'; continue; }
      const item = { id: entry.id, title: entry.title || entry.id, ...(entry.file ? { file: entry.file } : {}),
        content: entry.file ? read(save, entry.file) : entry.content };
      if (estimate([record([...selected.map(x => x.item), item])]) > (config.budgetTokens ?? 4000)) { decision.reason = 'budget'; continue; }
      selected.push({ entry, item }); if (entry.group) groups.add(entry.group);
      state.entries[entry.id] = active ? ledger : { signature, lastRound: number, activeUntil: number + (entry.duration ?? 1) - 1,
        nextRound: number + (entry.duration ?? 1) + (entry.cooldown ?? 0) };
      decision.reason = active ? 'active' : 'activated';
    }
    // Stable diagnostics on repeated API requests; no text is copied into public events.
    for (const decision of decisions) if (decision.reason === 'active') decision.reason = 'activated';
    for (const id of Object.keys(state.entries)) if (!config.entries.some(e => e.id === id && JSON.stringify(e) === state.entries[id].signature)) delete state.entries[id];
    save.worldTriggers = state;
    const diagnostic = { round: number, decisions };
    const signature = JSON.stringify(diagnostic);
    if (round.worldTriggerDecision !== signature) {
      round.worldTriggerDecision = signature;
      save.events.push({ id: globalThis.crypto?.randomUUID?.() || 'trigger-' + save.events.length, type: 'world_trigger', round: number,
        at: Date.now(), audience: [], ...diagnostic });
    }
    if (!selected.length) return null;
    selected.sort((a, b) => (a.entry.order ?? 0) - (b.entry.order ?? 0) || compareId(a.entry.id, b.entry.id));
    return record(selected.map(x => x.item));
  }
  return { configuration, prepare, testCondition, scanned, matches, HEADER };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = GameWorldTriggers;
