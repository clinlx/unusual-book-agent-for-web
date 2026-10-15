'use strict';
// Shared by the offline validator, designer and host. World JSON is data, never code.
const WorldTriggerRules = (() => {
  const FILE = '世界触发器.json';
  const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const fail = message => { throw Error(FILE + '：' + message); };
  function fields(value, allowed, label) {
    if (!object(value)) fail(label + ' 必须是对象');
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(label + ' 不支持字段 ' + key);
  }
  function text(value, label) { if (typeof value !== 'string' || !value.trim()) fail(label + ' 必须是非空文本'); }
  function integer(value, min, max, label) { if (!Number.isSafeInteger(value) || value < min || value > max) fail(label + ` 必须是 ${min}～${max} 的整数`); }
  function boolean(value, label) { if (typeof value !== 'boolean') fail(label + ' 必须是布尔值'); }
  function list(value, label) { if (!Array.isArray(value) || !value.length) fail(label + ' 必须是非空数组'); }
  function strings(value, label) { list(value, label); value.forEach(x => text(x, label)); }
  function filePath(value) {
    text(value, '文件路径');
    if (value !== value.trim() || /[\\:\u0000-\u001f?#]/.test(value) || value.startsWith('/') || value.startsWith('workspace/')
      || value.split('/').some(x => !x || ['.', '..', '__proto__', 'prototype', 'constructor'].includes(x))) fail('文件路径必须相对世界根目录且不能越界：' + value);
    return value;
  }
  const scalar = value => value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value);
  function condition(value, refs, count = { n: 0 }, depth = 0) {
    if (++count.n > 256 || depth > 16) fail('条件过于复杂（最多 256 个节点、16 层）');
    fields(value, ['all', 'any', 'not', 'file', 'path', 'op', 'value'], 'when');
    const logical = ['all', 'any', 'not'].filter(key => Object.hasOwn(value, key));
    if (logical.length) {
      if (Object.keys(value).length !== 1) fail('逻辑条件只能包含 all、any、not 中的一项');
      const key = logical[0];
      if (key === 'not') condition(value.not, refs, count, depth + 1);
      else { list(value[key], key); value[key].forEach(x => condition(x, refs, count, depth + 1)); }
      return;
    }
    filePath(value.file);
    if (!/\.json$/i.test(value.file)) fail('状态条件 file 必须是 JSON 文件');
    refs.add(value.file);
    if (!Array.isArray(value.path) || value.path.some(x => typeof x !== 'string' || !x || ['__proto__', 'prototype', 'constructor'].includes(x))) fail('条件 path 必须为安全的字段名数组，可用 [] 表示根值');
    if (!['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'exists', 'in', 'contains'].includes(value.op)) fail('不支持的条件 op：' + value.op);
    if (value.op === 'exists') boolean(value.value, 'exists.value');
    else if (value.op === 'in') { list(value.value, 'in.value'); if (!value.value.every(scalar)) fail('in.value 只能包含基础值'); }
    else if (!Object.hasOwn(value, 'value') || !scalar(value.value)) fail('条件 value 必须是字符串、数字、布尔值或 null');
    if (['gt', 'gte', 'lt', 'lte'].includes(value.op) && typeof value.value !== 'number') fail('数值比较必须提供数字 value');
  }
  function validate(value) {
    fields(value, ['version', 'enabled', 'budgetTokens', 'entries'], '根节点');
    if (value.version !== 1) fail('version 必须为 1');
    if (value.enabled !== undefined) boolean(value.enabled, 'enabled');
    if (value.budgetTokens !== undefined) integer(value.budgetTokens, 1, 240000, 'budgetTokens');
    if (!Array.isArray(value.entries)) fail('entries 必须是数组');
    const ids = new Set(), refs = new Set();
    for (const entry of value.entries) {
      fields(entry, ['id', 'title', 'note', 'enabled', 'constant', 'keywords', 'secondary', 'sources', 'actorIds', 'scan', 'matchScope', 'caseSensitive', 'wholeWords', 'when', 'content', 'file', 'priority', 'order', 'group', 'duration', 'cooldown', 'once', 'minRound', 'maxRound'], '条目');
      text(entry.id, 'id');
      if (['__proto__', 'prototype', 'constructor'].includes(entry.id) || ids.has(entry.id)) fail('id 非法或重复：' + entry.id);
      ids.add(entry.id);
      for (const key of ['title', 'note', 'group']) if (entry[key] !== undefined) text(entry[key], key);
      for (const key of ['enabled', 'constant', 'caseSensitive', 'wholeWords', 'once']) if (entry[key] !== undefined) boolean(entry[key], key);
      if (entry.keywords !== undefined) strings(entry.keywords, 'keywords');
      if (!entry.constant && !entry.keywords?.length) fail(entry.id + ' 需要 keywords，或设置 constant:true');
      if (entry.secondary !== undefined) {
        fields(entry.secondary, ['mode', 'keys'], 'secondary');
        if (!['any', 'all', 'notAny', 'notAll'].includes(entry.secondary.mode)) fail('secondary.mode 不合法');
        strings(entry.secondary.keys, 'secondary.keys');
      }
      if (entry.sources !== undefined) {
        strings(entry.sources, 'sources');
        if (entry.sources.some(x => !['player', 'private_player', 'story', 'private_story'].includes(x))) fail('sources 包含未知来源');
      }
      if (entry.actorIds !== undefined) strings(entry.actorIds, 'actorIds');
      if (entry.scan !== undefined) {
        fields(entry.scan, ['playerRounds', 'storyMessages'], 'scan');
        for (const key of Object.keys(entry.scan)) integer(entry.scan[key], 1, 100, 'scan.' + key);
      }
      if (entry.matchScope !== undefined && !['window', 'event'].includes(entry.matchScope)) fail('matchScope 必须为 window 或 event');
      if (entry.when !== undefined) condition(entry.when, refs);
      if (Object.hasOwn(entry, 'content') === Object.hasOwn(entry, 'file')) fail(entry.id + ' 必须且只能提供 content 或 file');
      if (entry.content !== undefined) text(entry.content, 'content');
      if (entry.file !== undefined) refs.add(filePath(entry.file));
      for (const key of ['priority', 'order']) if (entry[key] !== undefined) integer(entry[key], -1000000, 1000000, key);
      for (const key of ['duration', 'minRound', 'maxRound']) if (entry[key] !== undefined) integer(entry[key], 1, 1000000, key);
      if (entry.cooldown !== undefined) integer(entry.cooldown, 0, 1000000, 'cooldown');
      if ((entry.minRound ?? 1) > (entry.maxRound ?? 1000000)) fail('minRound 不能大于 maxRound');
    }
    return { value, references: [...refs] };
  }
  function parse(content) {
    if (typeof content !== 'string' || content.length > 120000) fail('必须是最多 120000 字符的文本 JSON');
    let value;
    try { value = JSON.parse(content.replace(/^\uFEFF/, '')); } catch (error) { fail('JSON 格式错误：' + error.message); }
    return validate(value);
  }
  return { FILE, validate, parse, filePath };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WorldTriggerRules;
