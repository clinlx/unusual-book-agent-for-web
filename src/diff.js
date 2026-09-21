'use strict';

const Diff = (() => {
  const LIMITS = {
    lcsCells: 1_000_000,   
    pairRatio: 0.5,        
    affixRatio: 0.4,       
    affixMinChars: 4,      
    context: 3,            
    maxHunkLines: 400,     
    maxLineChars: 2000,    
    wordCells: 250_000,    
  };

  
  const splitLines = t => {
    const s = String(t == null ? '' : t);
    return s === '' ? [] : s.split('\n');
  };

  
  
  function tokenize(s) {
    const out = [];
    const re = /[㐀-䶿一-鿿぀-ヿ가-힯]|[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|\s+|[^\s]/gu;
    let m;
    while ((m = re.exec(String(s)))) out.push(m[0]);
    return out;
  }

  
  
  function lcsOps(a, b, cellCap) {
    const n = a.length, m = b.length;
    
    let p = 0;
    while (p < n && p < m && a[p] === b[p]) p++;
    let s = 0;
    while (s < n - p && s < m - p && a[n - 1 - s] === b[m - 1 - s]) s++;
    const ops = [];
    for (let i = 0; i < p; i++) ops.push({ type: 'eq', a: i, b: i });
    const an = n - p - s, bn = m - p - s;
    if (an === 0 || bn === 0) {
      
      for (let i = 0; i < an; i++) ops.push({ type: 'del', a: p + i });
      for (let j = 0; j < bn; j++) ops.push({ type: 'add', b: p + j });
    } else if (an * bn > cellCap) {
      
      for (let i = 0; i < an; i++) ops.push({ type: 'del', a: p + i });
      for (let j = 0; j < bn; j++) ops.push({ type: 'add', b: p + j });
    } else {
      
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

  
  
  function shouldPair(x, y) {
    if (similarity(x, y) >= LIMITS.pairRatio) return true;
    const shorter = Math.min(x.length, y.length);
    if (!shorter) return false;
    let pre = 0;
    while (pre < shorter && x[pre] === y[pre]) pre++;
    let suf = 0;
    while (suf < shorter - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
    
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

  
  
  function pairBlock(dels, adds) {
    const rows = [];
    let i = 0, j = 0;
    while (i < dels.length && j < adds.length) {
      const d = dels[i], a = adds[j];
      if (shouldPair(d.text, a.text)) {
        rows.push({ type: 'mod', oldNo: d.no, newNo: a.no, oldText: clip(d.text), newText: clip(a.text) });
        i++; j++;
      } else {
        
        rows.push({ type: 'del', oldNo: d.no, text: clip(d.text) });
        i++;
      }
    }
    for (; i < dels.length; i++) rows.push({ type: 'del', oldNo: dels[i].no, text: clip(dels[i].text) });
    for (; j < adds.length; j++) rows.push({ type: 'add', newNo: adds[j].no, text: clip(adds[j].text) });
    return rows;
  }

  
  
  
  
  function diffLines(oldText, newText, opts) {
    const o = Object.assign({ context: LIMITS.context, maxLines: LIMITS.maxHunkLines }, opts || {});
    const A = splitLines(oldText), B = splitLines(newText);
    const ops = lcsOps(A, B, LIMITS.lcsCells);

    
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

    
    let truncated = false;
    if (rows.length > o.maxLines) { rows.length = o.maxLines; truncated = true; }
    return { rows, added, removed, changed, truncated };
  }

  
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
