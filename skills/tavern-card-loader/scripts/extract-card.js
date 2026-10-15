'use strict';
// Browser/Node share this parser. Card metadata, HTML and scripts remain inert data.
const TavernCard = (() => {
  const MAX_INPUT_BYTES = 32 * 1024 * 1024, MAX_TEXT_BYTES = 8 * 1024 * 1024, MAX_METADATA_BYTES = 16 * 1024 * 1024;
  const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const list = x => x == null ? [] : Array.isArray(x) ? x : [x];
  const text = x => x == null ? '' : typeof x === 'string' ? x.trim() : Array.isArray(x) ? x.map(text).filter(Boolean).join('\n') : typeof x === 'object' ? JSON.stringify(x, null, 2) : String(x);
  const plain = x => text(x).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const KEYS = ['ccv3', 'chara', 'Comment', 'Description'];
  const FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions'];
  const LABELS = { world_rules: '世界规则', start_rules: '开局与初始道具', data_panel: '数据面板', encounter_rules: '遭遇规则', locations: '地点',
    runtime_protocol: '运行协议候选（须复核）', lore: '设定与剧情' };
  const decode = bytes => {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
    catch (_) { return Array.from(bytes, x => String.fromCharCode(x)).join(''); }
  };
  function fromBase64(value) {
    const clean = value.replace(/\s+/g, '');
    if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) throw Error('base64 格式错误');
    const s = atob(clean + '='.repeat((4 - clean.length % 4) % 4));
    return Uint8Array.from(s, c => c.charCodeAt(0));
  }
  async function inflate(bytes, check = () => {}, consume = () => {}) {
    if (typeof DecompressionStream === 'undefined') throw Error('当前环境缺少 zlib 解压能力');
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader(), chunks = [];
    let size = 0;
    try {
      for (;;) {
        check(); const { value, done } = await reader.read(); if (done) break;
        consume(value.length);
        size += value.length;
        if (size > MAX_TEXT_BYTES) throw Error('解压后的角色卡超过 8 MiB 上限');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    check(); const output = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { output.set(chunk, at); at += chunk.length; }
    return output;
  }
  function json(value) {
    if (new TextEncoder().encode(value).length > MAX_TEXT_BYTES) throw Error('角色卡 JSON 超过 8 MiB 上限');
    const raw = JSON.parse(value.replace(/^\uFEFF/, '').trim());
    if (!object(raw)) throw Error('角色卡 JSON 根节点必须是对象');
    return raw;
  }
  function isCard(raw) {
    if (!object(raw)) return false;
    const p = object(raw.data) ? raw.data : raw;
    if (['chara_card_v2', 'chara_card_v3'].includes(raw.spec))
      return object(raw.data) && ['name', 'description', 'first_mes', 'character_book'].some(k => Object.hasOwn(p, k));
    return !!text(p.name) && (['description', 'personality', 'scenario', 'first_mes', 'mes_example'].some(k => !!text(p[k]))
      || object(p.character_book) || object(p.worldbook) || object(p.world));
  }
  async function payload(value, check, consume) {
    const attempts = [value]; let bytes;
    try { bytes = fromBase64(value); attempts.push(decode(bytes)); } catch (_) {}
    for (const candidate of attempts) {
      try { const raw = json(candidate); if (isCard(raw)) return raw; } catch (_) {}
    }
    if (bytes?.[0] === 0x78) {
      const raw = json(decode(await inflate(bytes, check, consume)));
      if (isCard(raw)) return raw;
    }
    throw Error('元数据不是可识别的角色卡 JSON（或 base64/压缩数据损坏）');
  }
  const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1;
    return n >>> 0;
  });
  function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ c >>> 8; return (c ^ 0xffffffff) >>> 0; }
  async function png(bytes, check) {
    if (![137,80,78,71,13,10,26,10].every((b, i) => bytes[i] === b)) throw Error('不是有效的 PNG 文件');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), records = [], warnings = [], names = [];
    let metadataBytes = 0;
    const consume = size => {
      metadataBytes += size;
      if (metadataBytes > MAX_METADATA_BYTES) throw Object.assign(Error('PNG 角色卡元数据累计解码超过 16 MiB 上限'), { code: 'PNG_METADATA_LIMIT' });
    };
    let offset = 8, ended = false, count = 0;
    while (offset < bytes.length) {
      check();
      if (offset + 12 > bytes.length) throw Error('PNG 块头已截断');
      const length = view.getUint32(offset), end = offset + 12 + length;
      if (end > bytes.length) throw Error('PNG 数据块已截断');
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)), data = bytes.subarray(offset + 8, end - 4);
      if (!count++ && (type !== 'IHDR' || length !== 13)) throw Error('PNG 缺少有效 IHDR');
      if (crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) throw Error('PNG 数据块 CRC 校验失败：' + type);
      offset = end;
      if (type === 'IEND') { if (length !== 0) throw Error('PNG IEND 无效'); ended = true; break; }
      if (!['tEXt', 'zTXt', 'iTXt'].includes(type)) continue;
      const nul = data.indexOf(0); if (nul < 1 || nul > 79) { warnings.push(type + ' 文本关键字无效'); continue; }
      if (names.length >= 256) throw Error('PNG 文本元数据超过 256 块上限');
      const key = decode(data.subarray(0, nul)); names.push(key);
      if (!KEYS.includes(key)) continue;
      if (records.some(r => r.key === key)) warnings.push('重复元数据键 ' + key + '，优先尝试最后一份有效数据');
      // Keep bounded input slices; decode candidates only in priority order after validating the PNG.
      records.push({ key, type, data, nul });
    }
    if (!ended) throw Error('PNG 缺少 IEND');
    if (offset < bytes.length) warnings.push('PNG 尾部附加数据未作为角色卡元数据读取');
    for (const key of KEYS) for (const record of records.filter(r => r.key === key).reverse()) {
      try {
        const { type, data, nul } = record;
        let value;
        if (type === 'tEXt') value = data.subarray(nul + 1);
        else if (type === 'zTXt') {
          if (data[nul + 1] !== 0) throw Error('zTXt 压缩方式无效');
          value = await inflate(data.subarray(nul + 2), check, consume);
        } else {
          const flag = data[nul + 1], method = data[nul + 2];
          if (![0, 1].includes(flag) || method !== 0) throw Error('iTXt 压缩标记无效');
          const languageEnd = data.indexOf(0, nul + 3), translatedEnd = data.indexOf(0, languageEnd + 1);
          if (languageEnd < 0 || translatedEnd < 0) throw Error('iTXt 语言/译名字段已截断');
          value = data.subarray(translatedEnd + 1);
          if (flag === 1) value = await inflate(value, check, consume);
        }
        if (type === 'tEXt' || type === 'iTXt' && data[nul + 1] === 0) consume(value.length);
        if (value.length > MAX_TEXT_BYTES) throw Error('元数据超过 8 MiB 上限');
        return { raw: await payload(decode(value), check, consume), format: 'png:' + key, metadata_keys: names, warnings };
      } catch (e) {
        check();
        if (e.code === 'PNG_METADATA_LIMIT') throw e;
        warnings.push(key + '：' + e.message);
      }
    }
    if (names.some(k => ['ccv3', 'chara'].includes(k))) throw Error('发现角色卡元数据但无法解码：' + warnings.join('；'));
    return { raw: null, format: 'image-no-card-metadata', metadata_keys: names, warnings: [...warnings, '普通图片或没有可解析角色卡元数据'] };
  }
  async function load(bytes, name, options = {}) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (bytes.length > MAX_INPUT_BYTES) throw Error('角色卡文件超过 32 MiB 上限');
    const check = options.check || (() => {}); check();
    if (/\.png$/i.test(name)) return png(bytes, check);
    if (!/\.json$/i.test(name)) throw Error('角色卡解析仅支持 PNG 和 JSON；JPEG/WebP 不保证保留卡元数据');
    const raw = json(decode(bytes));
    if (!isCard(raw)) throw Error('JSON 不是可识别的角色卡；不会把普通配置当作解析成功');
    return { raw, format: 'json', metadata_keys: [], warnings: [] };
  }
  function category(e) {
    const blob = (e.title + '\n' + plain(e.content)).toLowerCase(), hit = words => words.some(x => blob.includes(x.toLowerCase()));
    if (hit(['初始地点', '初始道具', '开局选择', '车卡', '<input', '<select']) || /<(input|select|form|button)\b/i.test(e.content)) return 'start_rules';
    if (hit(['世界法则', '世界规则', '防作弊', '禁止读心', '时间连续', '信息获取公平'])) return 'world_rules';
    if (hit(['遭遇', 'NPC 生成', 'npc spawn', 'encounter'])) return 'encounter_rules';
    if (['状态栏', '数据面板', '背包', '属性栏', 'NEXT_TURN_CACHE'].filter(x => blob.includes(x.toLowerCase())).length >= 2) return 'data_panel';
    if (hit(['场景', '地点', 'location'])) return 'locations';
    if (/<(script|style)\b/i.test(e.content) || hit(['输出格式', 'formatting', 'insertionOrder', 'tokenBudget', 'HTML 状态栏'])) return 'runtime_protocol';
    return 'lore'; // Constant/empty keys, HTML or the word "protocol" alone never justify discarding lore.
  }
  function normalize(loaded, source) {
    const raw = loaded.raw, warnings = [...loaded.warnings], conflicts = [];
    if (raw.spec && !['chara_card_v2', 'chara_card_v3'].includes(raw.spec)) warnings.push('未识别的 spec：' + text(raw.spec) + '；仅按常见字段提取，不能视为完整格式兼容');
    let p = raw;
    if (object(raw.data)) {
      p = { ...raw, ...raw.data };
      for (const k of Object.keys(raw.data)) if (Object.hasOwn(raw, k) && k !== 'data' && JSON.stringify(raw[k]) !== JSON.stringify(raw.data[k])) conflicts.push(k);
      if (conflicts.length) warnings.push('顶层与 data 镜像冲突，规范化采用 data；原值保留于 raw-card.json：' + conflicts.join('、'));
    }
    const worldbook_entries = [], books = [];
    for (const key of ['character_book', 'world', 'worldbook']) {
      const book = p[key]; if (!object(book)) continue;
      books.push({ field: key, settings: Object.fromEntries(Object.entries(book).filter(([k]) => k !== 'entries')) });
      const values = Array.isArray(book.entries) ? book.entries.map((e, i) => [String(i), e]) : object(book.entries) ? Object.entries(book.entries) : [];
      for (const [index, rawEntry] of values) {
        if (!object(rawEntry)) { warnings.push(key + '.entries.' + index + ' 不是对象，原文仍在 raw-card.json'); continue; }
        const title = text(rawEntry.comment || rawEntry.name) || plain(rawEntry.content).slice(0, 40) || 'Entry ' + index;
        const e = { id: rawEntry.id ?? rawEntry.uid ?? index, source_key: key + '.entries.' + index, title, content: text(rawEntry.content),
          keys: list(rawEntry.keys ?? rawEntry.key), secondary_keys: list(rawEntry.secondary_keys ?? rawEntry.keysecondary),
          constant: rawEntry.constant === true, enabled: rawEntry.enabled !== undefined ? rawEntry.enabled : rawEntry.disable !== true,
          position: rawEntry.position ?? '', order: rawEntry.insertion_order ?? rawEntry.order ?? '', raw: rawEntry };
        e.category = category(e); e.plain_preview = plain(e.content).slice(0, 240);
        if (rawEntry.enabled !== undefined && rawEntry.disable !== undefined && rawEntry.enabled !== !rawEntry.disable)
          warnings.push(e.source_key + ' 的 enabled/disable 冲突，原值均保留，迁移前须复核');
        e.migration_review = Object.keys(rawEntry).filter(k => !['id', 'uid', 'comment', 'name', 'keys', 'key', 'secondary_keys', 'keysecondary', 'constant', 'enabled', 'disable', 'content', 'position', 'order', 'insertion_order'].includes(k));
        const ext = object(rawEntry.extensions) ? rawEntry.extensions : {};
        e.migration_review.push(...Object.keys(ext).map(k => 'extensions.' + k));
        worldbook_entries.push(e);
      }
    }
    const field_gaps = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes'].filter(k => !text(p[k] || (k === 'creator_notes' ? p.creatorcomment : '')));
    if (/placeholder|todo|待写|测试开场/i.test(text(p.first_mes))) warnings.push('first_mes 疑似占位开场，需要复核');
    const markers = [...new Set((FIELDS.map(k => text(p[k])).join('\n') + '\n' + worldbook_entries.map(e => e.content).join('\n') + '\n' + list(p.alternate_greetings).map(text).join('\n'))
      .match(/\{\{(?:user|char|random(?::[^}]+)?|roll(?::[^}]+)?)\}\}|\{(?:user|char)\}|<user>|<START>/gi) || [])];
    const categories = Object.fromEntries(Object.keys(LABELS).map(k => [k, worldbook_entries.filter(e => e.category === k).map(e => e.source_key)]));
    const extensions = p.extensions ?? {};
    const content_flags = worldbook_entries.filter(e => /nsfw|r18|成人|性关系|性癖/i.test(e.title + '\n' + e.content)).map(e => e.source_key);
    return { source: { path: source, format: loaded.format, metadata_keys: loaded.metadata_keys }, spec: { name: raw.spec || 'legacy', version: raw.spec_version || '' },
      identity: { name: text(p.name) || source.split('/').pop().replace(/\.[^.]+$/, ''), creator: text(p.creator), version: text(p.character_version || p.version), tags: list(p.tags) },
      persona: { description: text(p.description), personality: text(p.personality), creator_notes: text(p.creator_notes || p.creatorcomment) },
      scenario: { scenario: text(p.scenario), system_prompt: text(p.system_prompt), post_history_instructions: text(p.post_history_instructions) },
      first_messages: { first_mes: text(p.first_mes), alternate_greetings: list(p.alternate_greetings).map(text) }, examples: { mes_example: text(p.mes_example) },
      worldbooks: books, worldbook_entries, special_markers: markers, warnings, extensions,
      additional_fields: Object.fromEntries(Object.entries(p).filter(([k]) => ![...FIELDS, 'data', 'alternate_greetings', 'creatorcomment', 'creator', 'character_version', 'version', 'tags', 'extensions', 'character_book', 'world', 'worldbook', 'spec', 'spec_version'].includes(k))),
      review: { conflicts, field_gaps, categories, content_flags, must_land_entries: worldbook_entries.filter(e => ['world_rules', 'start_rules', 'data_panel', 'encounter_rules', 'locations'].includes(e.category)).map(e => e.source_key),
        runtime_protocol_entries: categories.runtime_protocol, empty_keys_constant: worldbook_entries.filter(e => e.constant && !e.keys.length).map(e => e.source_key),
        extension_keys: object(extensions) ? Object.keys(extensions) : [], note: '分类只供复核，不据此删除正文。未识别字段及全部触发设置保留在 raw；内容标记不是完整清单。' } };
  }
  const section = (title, body) => '## ' + title + '\n\n' + (text(body) || '未说明');
  const bullets = items => items.length ? items.map(x => '- ' + x).join('\n') : '- 无自动标记；仍需人工复核';
  function packageFiles(loaded, source, options = {}) {
    const n = normalize(loaded, source), entries = n.worldbook_entries;
    const report = ['# 提取报告', section('来源', JSON.stringify(n.source, null, 2)), section('警告', bullets(n.warnings)),
      section('字段缺口', bullets(n.review.field_gaps)), section('特殊标记', bullets(n.special_markers)),
      section('内容复核标记', bullets(n.review.content_flags)), section('其他字段（全文见 raw/normalized）', bullets(Object.keys(n.additional_fields))), section('世界书分类统计', Object.entries(n.review.categories).map(([k, v]) => LABELS[k] + '：' + v.length).join('\n')),
      section('必须落地机制条目', bullets(n.review.must_land_entries)), section('运行协议候选', bullets(n.review.runtime_protocol_entries)),
      section('无关键词常驻条目（不能据此删除）', bullets(n.review.empty_keys_constant)), section('extensions', JSON.stringify(n.extensions, null, 2)),
      section('世界书迁移复核', entries.map(e => '- ' + e.source_key + ' ' + e.title + '；保留全部原始触发设置；待复核字段：' + (e.migration_review.join('、') || '无额外字段')).join('\n')),
      section('阅读入口', '角色与世界书全文见 normalized-card.json；原始字段和触发设置见 raw-card.json。')].join('\n\n') + '\n';
    const brief = ['# 世界构建交接稿',
      section('角色', n.identity.name + '\n\n' + n.persona.description + '\n\n' + n.persona.personality),
      section('世界与规则（原始素材，须转换）', n.scenario.scenario + '\n\n' + n.scenario.system_prompt + '\n\n' + n.scenario.post_history_instructions),
      section('开场', n.first_messages.first_mes + '\n\n备用开场：\n' + n.first_messages.alternate_greetings.join('\n\n')),
      section('示例对话（不是既成事实）', n.examples.mes_example), section('作者说明', n.persona.creator_notes),
      section('必须落地条目', bullets(n.review.must_land_entries)),
      section('回合缓存交接', 'NEXT_TURN_CACHE 是游玩流程工具 end_the_round 的参数，用于提交更新后的跨回合状态，由宿主持久化。在模组.md 中定义所需缓存字段的名称、类型、含义、初始值、更新及保留/清理条件，告知 AI 主持人按定义提交；不把这些缓存字段写进角色信息或背包，也不创建同名文件。'),
      section('世界书入口', entries.map(e => '### ' + e.source_key + ' ' + e.title + '\n\n分类：' + e.category + '；启用：' + e.enabled + '\n\n' +
        (e.category === 'runtime_protocol' ? '待复核预览：' + e.plain_preview + '\n\n全文与触发设置见 normalized-card.json，不能仅凭分类删除。' : e.content)).join('\n\n')),
      section('交接要求', '按 game-world-builder 的数据约定构建世界。需要条件注入时阅读 WorldTriggers.md 与世界书迁移参考，逐条决定保留、改写、不搬运或待处理；不得声称自动等价转换成功。仅有 UI、标签解析和格式补丁的部分可不迁移，保留其独有玩法；未知脚本语义记录在世界外。')].join('\n\n') + '\n';
    const files = { 'raw-card.json': JSON.stringify(loaded.raw, null, 2) + '\n' };
    if (!options.raw_only) Object.assign(files, { 'normalized-card.json': JSON.stringify(n, null, 2) + '\n', 'extraction-report.md': report,
      'worldbuilder-brief.md': brief, 'localize-draft.md': '# 本地化待复核稿\n\n目标语言：' + (options.target_language || '未指定') + '\n原名：' + n.identity.name +
        '\n\n工具只提取，不翻译。由 AI 根据 localize.md 维护译名、语气与文化事实，完成后再交接。\n' });
    return { normalized: n, files };
  }
  return { MAX_INPUT_BYTES, MAX_TEXT_BYTES, MAX_METADATA_BYTES, load, normalize, packageFiles, crc32, inflate, isCard };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = TavernCard;
