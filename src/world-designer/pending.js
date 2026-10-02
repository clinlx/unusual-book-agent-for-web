'use strict';
/* pending.js —— 待审阅变更的纯逻辑层。
   模型：AI 的写入立即落盘（不阻塞后续工具调用），同时按文件记录一份
   baseline（本次变更前的内容）。审阅时用 baseline 与当前内容做行级 diff，
   得到若干 hunk；接受 = 丢弃 baseline 对应部分，拒绝 = 用 baseline 回退。
   无 DOM、无存储依赖，Node 下可测。 */
const Pending = (() => {
  const _Diff = (typeof module !== 'undefined') ? require('./diff.js') : Diff;

  // 记录一次写入。scope='last' 时每轮覆盖 baseline，只审最后一次改动；
  // scope='accumulate' 时保留最早的 baseline，累积审阅到手动处理为止。
  // before=null 表示新建文件，after=null 表示删除。
  function record(store, path, before, after, opts) {
    const scope = (opts && opts.scope) || 'last';
    const turn = (opts && opts.turn) || 0;
    const prev = store[path];
    if (prev && scope === 'accumulate') {
      // 累积：baseline 保持最早那份，只更新当前值与轮次
      prev.after = after;
      prev.turn = turn;
      // 回到初始状态则不再是变更
      if (prev.before === after) delete store[path];
      return store;
    }
    if (before === after) { delete store[path]; return store; }
    store[path] = { path, before, after, turn };
    return store;
  }

  // 计算某文件的待审 hunk 列表。每个 hunk 是一段连续的增/删/改。
  // 返回 [{ id, type:'add'|'del'|'mod', rows, oldStart, oldEnd, newStart, newEnd }]
  function hunks(entry) {
    if (!entry) return [];
    if (entry.before === null) return [{ id: 0, type: 'add', whole: true, rows: [] }];
    if (entry.after === null) return [{ id: 0, type: 'del', whole: true, rows: [] }];
    const d = _Diff.diffLines(entry.before, entry.after, { context: 0 });
    const out = [];
    let cur = null;
    for (const row of d.rows) {
      if (row.type === 'eq' || row.type === 'gap') { cur = null; continue; }
      if (!cur) {
        cur = { id: out.length, type: row.type, rows: [row] };
        out.push(cur);
      } else {
        cur.rows.push(row);
        // 同一段内混合了增与删，整体记为修改
        if (cur.type !== row.type) cur.type = 'mod';
      }
    }
    // 标注每个 hunk 在新旧文本中的行区间，供部分接受/拒绝时定位
    for (const h of out) {
      const olds = h.rows.map(r => r.oldNo).filter(n => n != null);
      const news = h.rows.map(r => r.newNo).filter(n => n != null);
      h.oldStart = olds.length ? Math.min(...olds) : null;
      h.oldEnd = olds.length ? Math.max(...olds) : null;
      h.newStart = news.length ? Math.min(...news) : null;
      h.newEnd = news.length ? Math.max(...news) : null;
    }
    return out;
  }

  // 统计：给红点与「N 处变更」用
  function summarize(entry) {
    if (!entry) return { added: 0, removed: 0, hunks: 0 };
    if (entry.before === null) {
      const n = entry.after === '' ? 0 : _Diff.splitLines(entry.after).length;
      return { added: n, removed: 0, hunks: 1, whole: 'add' };
    }
    if (entry.after === null) {
      const n = entry.before === '' ? 0 : _Diff.splitLines(entry.before).length;
      return { added: 0, removed: n, hunks: 1, whole: 'del' };
    }
    const d = _Diff.diffLines(entry.before, entry.after, { context: 0 });
    return { added: d.added, removed: d.removed, hunks: hunks(entry).length };
  }

  // 按「拒绝哪些 hunk」重建文件内容：被拒的段落取 baseline，其余保留 AI 的新值。
  // 必须用带完整上下文的 diff——context:0 下未变更区间会被压成 gap，
  // 而 gap 只记录行数不记内容，据此重建会丢掉整段原文。
  function rebuild(entry, rejectedIds) {
    if (!entry) return null;
    if (entry.before === null || entry.after === null) return entry.before;
    const ids = new Set(rejectedIds);
    const all = hunks(entry);
    const oldLines = _Diff.splitLines(entry.before);
    const newLines = _Diff.splitLines(entry.after);
    const full = _Diff.diffLines(entry.before, entry.after, { context: Infinity });
    const rowHunk = new Map();
    // 用 (type, oldNo, newNo) 作键把 hunk 归属映射到完整 diff 的行上
    const key = r => r.type + ':' + r.oldNo + ':' + r.newNo;
    for (const h of all) for (const r of h.rows) rowHunk.set(key(r), h.id);
    const out = [];
    for (const row of full.rows) {
      if (row.type === 'gap') continue;
      if (row.type === 'eq') { out.push(row.text); continue; }
      const hid = rowHunk.get(key(row));
      const rejected = hid !== undefined && ids.has(hid);
      if (row.type === 'add') { if (!rejected) out.push(newLines[row.newNo - 1]); }
      else if (row.type === 'del') { if (rejected) out.push(oldLines[row.oldNo - 1]); }
      else out.push(rejected ? oldLines[row.oldNo - 1] : newLines[row.newNo - 1]);
    }
    return out.join('\n');
  }

  // 目录是否含待审变更（用于文件树上的红点向上冒泡）
  function dirHasPending(store, dirPath) {
    const prefix = dirPath.endsWith('/') ? dirPath : dirPath + '/';
    return Object.keys(store).some(p => p.startsWith(prefix));
  }

  function count(store) { return Object.keys(store).length; }

  return { record, hunks, summarize, rebuild, dirHasPending, count };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Pending;
