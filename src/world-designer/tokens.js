'use strict';
const Tokens = (() => {
  function estimateText(s) {
    if (!s) return 0;
    let cjk = 0, other = 0;
    for (const ch of String(s)) {
      const c = ch.codePointAt(0);
      if (c >= 0x3000 && c <= 0x9fff || c >= 0xac00 && c <= 0xd7a3 || c >= 0xf900 && c <= 0xfaff) cjk++;
      else other++;
    }
    return cjk + Math.ceil(other / 4);
  }

  function estimateMessage(m) {
    // 图片 token 由模型及分辨率决定；使用保守占位估算，不能按 base64 字符数计费。
    let n = Array.isArray(m.content) ? m.content.reduce((sum, p) =>
      sum + (p.type === 'image_url' ? 1024 : estimateText(p.text || '')), 0) : estimateText(m.content || '');
    n += estimateText(m.reasoning_content || '');
    if (m.role === 'compressed') n += estimateText(m.summary || '');
    if (m.tool_calls) for (const tc of m.tool_calls)
      n += estimateText((tc.function && tc.function.name) || '') + estimateText((tc.function && tc.function.arguments) || '');
    return n;
  }

  function estimateMessages(msgs) {
    return msgs.reduce((s, m) => s + estimateMessage(m), 0);
  }

  function contentText(content) {
    return Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text).join('\n') : (content || '');
  }

  function contentImages(content) {
    return Array.isArray(content) ? content.filter(p => p.type === 'image_url').map(p => p.image_url.url) : [];
  }

  // —— 轮次分组：user 开启一轮，其后的 assistant/tool 归属该轮（问答、工具调用与结果永不拆分）；
  //    system/compressed 等各自成组，可独立取舍 ——
  // 上下文完整性净化——最后一道防线。
  // OpenAI 协议要求：assistant 的每个 tool_call 都必须紧跟对应 tool 结果；
  // 孤立的 tool 消息（找不到发起它的 assistant）同样非法，会直接被 API 拒绝，
  // 且一旦写进历史就每次都失败，形成无法自愈的死锁。
  // 能产生半截调用的路径不止裁剪：删除单轮、撤回、中止（tool_calls 已发出但
  // 结果未写入）、拒绝变更后的重组等。故不在各处分别防守，统一在出口净化。
  function sanitizeMessages(msgs) {
    const out = [];
    // 先收集所有已存在的 tool 结果 id，供 assistant 侧判断
    const resultIds = new Set();
    for (const m of msgs) if (m && m.role === 'tool' && m.tool_call_id) resultIds.add(m.tool_call_id);

    const emittedCallIds = new Set();   // 已保留下来的 tool_call id
    for (const m of msgs) {
      if (!m || !m.role) continue;
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        // 只保留结果齐备的调用；全部缺失则退化为普通 assistant 消息
        const kept = m.tool_calls.filter(tc => tc && tc.id && resultIds.has(tc.id));
        if (kept.length === m.tool_calls.length) {
          for (const tc of kept) emittedCallIds.add(tc.id);
          out.push(m);
        } else if (kept.length) {
          for (const tc of kept) emittedCallIds.add(tc.id);
          out.push({ ...m, tool_calls: kept });
        } else if (m.content && m.content.trim()) {
          const { tool_calls, ...rest } = m;
          out.push(rest);
        }
        // 无文本又无有效调用 → 整条丢弃
        continue;
      }
      if (m.role === 'tool') {
        // 丢弃找不到发起者的孤立结果
        if (m.tool_call_id && emittedCallIds.has(m.tool_call_id)) out.push(m);
        continue;
      }
      out.push(m);
    }
    return out;
  }

  function groupTurns(msgs) {
    const groups = [];
    let cur = null;
    for (const m of msgs) {
      if (m.role === 'user') { cur = { turn: true, msgs: [m] }; groups.push(cur); }
      else if ((m.role === 'assistant' || m.role === 'tool') && cur) cur.msgs.push(m);
      else { cur = null; groups.push({ turn: false, msgs: [m] }); }
    }
    return groups;
  }

  // 思考内容按轮次裁决（DeepSeek 思考模式的规则）：
  //   某轮（相邻两条 user 之间）没有任何工具调用 → 该轮的 reasoning_content
  //   无需回传，API 收到也只是忽略，剥掉纯省上行 token；
  //   该轮出现过工具调用 → 整轮的思考必须原样回传，缺了 API 直接 400。
  function pruneReasoning(msgs) {
    return groupTurns(msgs).flatMap(g => {
      if (!g.turn) return g.msgs;
      if (g.msgs.some(m => m.role === 'assistant' && m.tool_calls)) return g.msgs;
      return g.msgs.map(m => {
        if (m.role !== 'assistant' || !('reasoning_content' in m)) return m;
        const { reasoning_content, ...rest } = m;
        return rest;
      });
    });
  }

  // 滑动窗口：保留 system + 从最新往前逐轮加入，装不下就停——
  // 效果等同于「删掉最早的若干轮」，每次只丢刚好够用的量。宁可超限也不拆轮。
  function slidingWindow(msgs, cap) {
    const system = msgs.filter(m => m.role === 'system');
    const groups = groupTurns(msgs.filter(m => m.role !== 'system'));
    let total = estimateMessages(system);
    const kept = [];
    for (let i = groups.length - 1; i >= 0; i--) {
      const cost = estimateMessages(groups[i].msgs);
      if (total + cost > cap && kept.length) break;
      kept.unshift(...groups[i].msgs);
      total += cost;
    }
    return [...system, ...kept];
  }

  // 切断：一次性砍掉前半部分轮次，不逐轮试探。
  // 与滑动窗口的区别是「激进程度」——滑窗每次只丢刚好够用的量，
  // 上下文长期贴着上限反复触发；切断一次腾出约一半空间，之后很久不用再裁。
  function truncateOldest(msgs, cap) {
    const system = msgs.filter(m => m.role === 'system');
    let groups = groupTurns(msgs.filter(m => m.role !== 'system'));
    if (groups.length <= 1) return [...system, ...groups.flatMap(g => g.msgs)];
    // 先砍掉前一半轮次（向下取整，至少保留一轮）
    const half = Math.max(1, groups.length - Math.floor(groups.length / 2));
    groups = groups.slice(groups.length - half);
    // 砍掉一半仍超限（少数轮次极长），继续逐轮丢弃兜底
    while (groups.length > 1 &&
           estimateMessages(system) + groups.reduce((s, g) => s + estimateMessages(g.msgs), 0) > cap)
      groups.shift();
    return [...system, ...groups.flatMap(g => g.msgs)];
  }

  // 按预算把消息切成若干段，段边界只落在轮次边界（用于分段接力压缩）
  function chunkByBudget(msgs, budgetTokens) {
    const groups = groupTurns(msgs);
    const chunks = [];
    let cur = [], total = 0;
    for (const g of groups) {
      const cost = estimateMessages(g.msgs);
      if (cur.length && total + cost > budgetTokens) { chunks.push(cur); cur = []; total = 0; }
      cur.push(...g.msgs); total += cost;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  return { contentText, contentImages, estimateText, estimateMessage, estimateMessages, slidingWindow, truncateOldest, groupTurns, chunkByBudget, sanitizeMessages, pruneReasoning };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Tokens;
