'use strict';
/* diff.js —— 纯逻辑：行级 diff + 行内词级 diff。无 DOM、无存储依赖。
   两级策略：先按行做 LCS，再把配对的「删除行/新增行」在行内做词级 diff，
   使 UI 能高亮"这一行改了哪几个词"，而不是整行红整行绿。 */
const Diff = (() => {
  const LIMITS = {
    lcsCells: 1_000_000,   // 行级 LCS 的 DP 单元上限，超出则退化为整块替换
    pairRatio: 0.5,        // 删除/新增行配对的最低相似度
    affixRatio: 0.4,       // 相似度不足时，公共前后缀占较短行的比例达标也配对
    affixMinChars: 4,      // 公共前后缀的最小绝对长度，避免噪声配对
    context: 3,            // hunk 上下文行数
    maxHunkLines: 400,     // 单条变更记录最多保存的行数（含上下文）
    maxLineChars: 2000,    // 单行超长时截断存储
    wordCells: 250_000,    // 行内词级 LCS 的上限
  };

  // 空文本视为 0 行（若用 ''.split('\n') 会得到 ['']，新建空文件会被误算成 1 行）
  const splitLines = t => {
    const s = String(t == null ? '' : t);
    return s === '' ? [] : s.split('\n');
  };

  // 行内分词：CJK 逐字，拉丁按词，数字成组，空白与标点各自成 token。
  // 中文无空格，若按空白分词整句会成为单个 token，行内 diff 会退化为整行替换。
  function tokenize(s) {
    const out = [];
    const re = /[㐀-䶿一-鿿぀-ヿ가-힯]|[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|\s+|[^\s]/gu;
    let m;
    while ((m = re.exec(String(s)))) out.push(m[0]);
    return out;
  }

  // 通用 LCS → 操作序列。返回 [{type:'eq'|'del'|'add', a?, b?}]
  // a/b 为在原数组中的下标，便于调用方取值。
  function lcsOps(a, b, cellCap) {
    const n = a.length, m = b.length;
    // 先剥离公共前后缀，多数编辑只动局部，可大幅缩小 DP 规模
    let p = 0;
    while (p < n && p < m && a[p] === b[p]) p++;
    let s = 0;
    while (s < n - p && s < m - p && a[n - 1 - s] === b[m - 1 - s]) s++;
    const ops = [];
    for (let i = 0; i < p; i++) ops.push({ type: 'eq', a: i, b: i });
    const an = n - p - s, bn = m - p - s;
    if (an === 0 || bn === 0) {
      // 纯新增或纯删除
      for (let i = 0; i < an; i++) ops.push({ type: 'del', a: p + i });
      for (let j = 0; j < bn; j++) ops.push({ type: 'add', b: p + j });
    } else if (an * bn > cellCap) {
      // 规模过大：退化为整块替换，保证不卡死
      for (let i = 0; i < an; i++) ops.push({ type: 'del', a: p + i });
      for (let j = 0; j < bn; j++) ops.push({ type: 'add', b: p + j });
    } else {
      // 标准 LCS 长度表（滚动不可用，需回溯路径，故存完整表）
      const w = bn + 1;
      const dp = new Int32Array((an + 1) * w);
      for (let i = an - 1; i >= 0; i--) {
        for (let j = bn - 1; j >= 0; j--) {
          dp[i * w + j] = a[p + i] === b[p + j]
            ? dp[(i + 1) * w + j + 1] + 1
            : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
        }
      }
      let i = 0, j = 0;
      while (i < an && j < bn) {
        if (a[p + i] === b[p + j]) { ops.push({ type: 'eq', a: p + i, b: p + j }); i++; j++; }
        else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push({ type: 'del', a: p + i }); i++; }
        else { ops.push({ type: 'add', b: p + j }); j++; }
      }
      while (i < an) { ops.push({ type: 'del', a: p + i }); i++; }
      while (j < bn) { ops.push({ type: 'add', b: p + j }); j++; }
    }
    for (let k = 0; k < s; k++) ops.push({ type: 'eq', a: n - s + k, b: m - s + k });
    return ops;
  }

  // 行相似度（基于分词后的 LCS 占比），用于判断两行是否算"同一行被改动"。
  // 相似度偏低但共享较长前后缀时（改行尾的值、加后缀等常见编辑）也应视为同一行。
  function shouldPair(x, y) {
    if (similarity(x, y) >= LIMITS.pairRatio) return true;
    const shorter = Math.min(x.length, y.length);
    if (!shorter) return false;
    let pre = 0;
    while (pre < shorter && x[pre] === y[pre]) pre++;
    let suf = 0;
    while (suf < shorter - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
    // 共享部分占较短行的比例达标即配对，同时要求绝对长度足够避免噪声配对
    return (pre + suf) >= LIMITS.affixMinChars && (pre + suf) / shorter >= LIMITS.affixRatio;
  }

  function similarity(x, y) {
    if (x === y) return 1;
    const ax = tokenize(x), ay = tokenize(y);
    if (!ax.length && !ay.length) return 1;
    if (!ax.length || !ay.length) return 0;
    const ops = lcsOps(ax, ay, LIMITS.wordCells);
    let same = 0;
    for (const o of ops) if (o.type === 'eq') same += ax[o.a].length;
    const total = x.length + y.length;
    return total ? (2 * same) / total : 0;
  }

  // 行内词级 diff → [{type:'eq'|'del'|'add', text}]，相邻同类 token 合并
  function diffWords(oldLine, newLine) {
    const a = tokenize(oldLine), b = tokenize(newLine);
    const ops = lcsOps(a, b, LIMITS.wordCells);
    const out = [];
    for (const o of ops) {
      const text = o.type === 'add' ? b[o.b] : a[o.a];
      const last = out[out.length - 1];
      if (last && last.type === o.type) last.text += text;
      else out.push({ type: o.type, text });
    }
    return out;
  }

  const clip = s => s.length > LIMITS.maxLineChars ? s.slice(0, LIMITS.maxLineChars) + ' …[行过长已截断]' : s;

  // 把一段连续的删除行与新增行按顺序配对：相似度达标者配成 'mod'（可做行内 diff），
  // 其余保持独立的 del / add。贪心顺序配对，符合"同一行被编辑"的直觉。
  function pairBlock(dels, adds) {
    const rows = [];
    let i = 0, j = 0;
    while (i < dels.length && j < adds.length) {
      const d = dels[i], a = adds[j];
      if (shouldPair(d.text, a.text)) {
        rows.push({ type: 'mod', oldNo: d.no, newNo: a.no, oldText: clip(d.text), newText: clip(a.text) });
        i++; j++;
      } else {
        // 不相似：先输出删除行，让新增行有机会与后续删除行配对
        rows.push({ type: 'del', oldNo: d.no, text: clip(d.text) });
        i++;
      }
    }
    for (; i < dels.length; i++) rows.push({ type: 'del', oldNo: dels[i].no, text: clip(dels[i].text) });
    for (; j < adds.length; j++) rows.push({ type: 'add', newNo: adds[j].no, text: clip(adds[j].text) });
    return rows;
  }

  // 主入口：计算两段文本的行级差异。
  // 返回 { rows, added, removed, changed, truncated }
  //   rows: [{type:'eq'|'del'|'add'|'mod'|'gap', ...}]，gap 表示省略的未变更区间
  //   added/removed: 统计口径与 git 一致（mod 同时计入一增一删）
  function diffLines(oldText, newText, opts) {
    const o = Object.assign({ context: LIMITS.context, maxLines: LIMITS.maxHunkLines }, opts || {});
    const A = splitLines(oldText), B = splitLines(newText);
    const ops = lcsOps(A, B, LIMITS.lcsCells);

    // 先把 ops 归并成行记录，连续的 del/add 块交给 pairBlock 配对
    const raw = [];
    let dels = [], adds = [];
    const flush = () => {
      if (dels.length || adds.length) { raw.push(...pairBlock(dels, adds)); dels = []; adds = []; }
    };
    for (const op of ops) {
      if (op.type === 'eq') { flush(); raw.push({ type: 'eq', oldNo: op.a + 1, newNo: op.b + 1, text: clip(A[op.a]) }); }
      else if (op.type === 'del') dels.push({ no: op.a + 1, text: A[op.a] });
      else adds.push({ no: op.b + 1, text: B[op.b] });
    }
    flush();

    let added = 0, removed = 0, changed = 0;
    for (const r of raw) {
      if (r.type === 'add') added++;
      else if (r.type === 'del') removed++;
      else if (r.type === 'mod') { added++; removed++; changed++; }
    }

    // 只保留变更行附近 context 行，其余压成 gap
    const keep = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      if (raw[i].type === 'eq') continue;
      for (let k = Math.max(0, i - o.context); k <= Math.min(raw.length - 1, i + o.context); k++) keep[k] = 1;
    }
    const rows = [];
    let gap = 0;
    for (let i = 0; i < raw.length; i++) {
      if (keep[i]) {
        if (gap) { rows.push({ type: 'gap', count: gap }); gap = 0; }
        rows.push(raw[i]);
      } else gap++;
    }
    if (gap) rows.push({ type: 'gap', count: gap });

    // 超长变更截断，避免单条消息把 UI 和存储撑爆
    let truncated = false;
    if (rows.length > o.maxLines) { rows.length = o.maxLines; truncated = true; }
    return { rows, added, removed, changed, truncated };
  }

  // 变更摘要：给按钮上的 "+32 -5" 用
  function summarize(kind, oldText, newText) {
    if (kind === 'create') {
      const n = newText === '' ? 0 : splitLines(newText).length;
      return { added: n, removed: 0, changed: 0 };
    }
    if (kind === 'delete') {
      const n = oldText === '' ? 0 : splitLines(oldText).length;
      return { added: 0, removed: n, changed: 0 };
    }
    const d = diffLines(oldText, newText);
    return { added: d.added, removed: d.removed, changed: d.changed };
  }

  return { LIMITS, splitLines, tokenize, lcsOps, similarity, shouldPair, diffWords, pairBlock, diffLines, summarize };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Diff;
