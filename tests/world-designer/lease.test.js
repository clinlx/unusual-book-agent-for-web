'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Lease = require('../../src/world-designer/lease.js');

function fakeStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    _map: m,
  };
}
function fakeChannel() { const sent = []; return { postMessage: m => sent.push(m), _sent: sent }; }
function clock() { let t = 1000; return { now: () => t, advance: ms => { t += ms; } }; }

test('工厂注入 storage 时 available=true，tabId 可注入', () => {
  const lm = Lease.create({ storage: fakeStorage(), channel: fakeChannel(), now: clock().now, tabId: 'T1' });
  assert.strictEqual(lm.available, true);
  assert.strictEqual(lm.tabId, 'T1');
});

test('storage 为 null 时 available=false，读写均为空操作', () => {
  const lm = Lease.create({ storage: null, channel: null, now: clock().now, tabId: 'T1' });
  assert.strictEqual(lm.available, false);
  assert.strictEqual(lm.readLease('P1'), null);
  assert.doesNotThrow(() => lm.writeLease('P1', { tab: 'T1', session: 's', ts: 1 }));
  assert.strictEqual(lm.readLease('P1'), null);
});

test('writeLease 写 JSON，readLease 解析回 {tab,session,ts}', () => {
  const st = fakeStorage(); const lm = Lease.create({ storage: st, channel: fakeChannel(), now: clock().now, tabId: 'T1' });
  lm.writeLease('P1', { tab: 'T1', session: 's1', ts: 42 });
  assert.deepStrictEqual(lm.readLease('P1'), { tab: 'T1', session: 's1', ts: 42 });
});

test('readLease 缺键或非法 JSON 返回 null', () => {
  const st = fakeStorage(); st.setItem('awl:lease:P1', 'not-json');
  const lm = Lease.create({ storage: st, channel: fakeChannel(), now: clock().now, tabId: 'T1' });
  assert.strictEqual(lm.readLease('P1'), null);
  assert.strictEqual(lm.readLease('NOPE'), null);
});

test('eraseLease 删除键', () => {
  const st = fakeStorage(); const lm = Lease.create({ storage: st, channel: fakeChannel(), now: clock().now, tabId: 'T1' });
  lm.writeLease('P1', { tab: 'T1', session: 's1', ts: 1 });
  assert.ok(lm.readLease('P1'));
  lm.eraseLease('P1');
  assert.strictEqual(lm.readLease('P1'), null);
});

test('status: free / held-self / held-other / expired-other', () => {
  const c = clock(); const st = fakeStorage();
  const me = Lease.create({ storage: st, channel: fakeChannel(), now: c.now, tabId: 'T1' });
  assert.strictEqual(me.status('P1'), 'free');
  me.writeLease('P1', { tab: 'T1', session: 's', ts: c.now() });
  assert.strictEqual(me.status('P1'), 'held-self');
  const other = Lease.create({ storage: st, channel: fakeChannel(), now: c.now, tabId: 'T2' });
  assert.strictEqual(other.status('P1'), 'held-other');
  c.advance(Lease.EXPIRY + 1);
  assert.strictEqual(other.status('P1'), 'expired-other');
});

test('isHeldByOther: 仅 held-other 为真（过期不算占用）', () => {
  const c = clock(); const st = fakeStorage();
  const me = Lease.create({ storage: st, channel: fakeChannel(), now: c.now, tabId: 'T1' });
  me.writeLease('P1', { tab: 'T1', session: 's', ts: c.now() });
  const other = Lease.create({ storage: st, channel: fakeChannel(), now: c.now, tabId: 'T2' });
  assert.strictEqual(other.isHeldByOther('P1'), true);
  c.advance(Lease.EXPIRY + 1);
  assert.strictEqual(other.isHeldByOther('P1'), false);
});

test('时钟回拨（now-ts 为负）不算过期', () => {
  const c = clock(); const st = fakeStorage();
  Lease.create({ storage: st, channel: fakeChannel(), now: c.now, tabId: 'T1' }).writeLease('P1', { tab: 'T1', session: 's', ts: c.now() });
  c.advance(-5000); // 回拨
  const other = Lease.create({ storage: st, channel: fakeChannel(), now: c.now, tabId: 'T2' });
  assert.strictEqual(other.status('P1'), 'held-other');
});

test('acquireForRun: free → ok:true 写入自己并广播 acquire', () => {
  const c = clock(); const ch = fakeChannel(); const st = fakeStorage();
  const me = Lease.create({ storage: st, channel: ch, now: c.now, tabId: 'T1' });
  const r = me.acquireForRun('P1', 's1');
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(me.readLease('P1').tab, 'T1');
  assert.strictEqual(me.readLease('P1').session, 's1');
  assert.ok(ch._sent.some(m => m.type === 'acquire' && m.projectId === 'P1' && m.tabId === 'T1'));
});

test('acquireForRun: held-other 同会话 → conflict.kind=session', () => {
  const c = clock(); const st = fakeStorage();
  const a = Lease.create({ storage: st, channel: fakeChannel(), now: c.now, tabId: 'A' });
  a.acquireForRun('P1', 's1');
  const b = Lease.create({ storage: st, channel: fakeChannel(), now: c.now, tabId: 'B' });
  const r = b.acquireForRun('P1', 's1');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflict.kind, 'session');
});

test('acquireForRun: held-other 他会话 → conflict.kind=project', () => {
  const c = clock(); const st = fakeStorage();
  const a = Lease.create({ storage: st, channel: fakeChannel(), now: c.now, tabId: 'A' });
  a.acquireForRun('P1', 's1');
  const b = Lease.create({ storage: st, channel: fakeChannel(), now: c.now, tabId: 'B' });
  const r = b.acquireForRun('P1', 's2');
  assert.strictEqual(r.conflict.kind, 'project');
});

test('acquireForRun: expired-other → ok:true 抢占', () => {
  const c = clock(); const st = fakeStorage();
  const a = Lease.create({ storage: st, channel: fakeChannel(), now: c.now, tabId: 'A' });
  a.acquireForRun('P1', 's1');
  c.advance(Lease.EXPIRY + 1);
  const b = Lease.create({ storage: st, channel: fakeChannel(), now: c.now, tabId: 'B' });
  const r = b.acquireForRun('P1', 's2');
  assert.strictEqual(r.ok, true);
});

test('acquireForRun: 写后被别家抢先（split-brain）→ ok:false', () => {
  const c = clock(); const base = fakeStorage();
  let stomp = false;
  const stomping = {
    getItem: base.getItem,
    setItem: (k, v) => { base.setItem(k, v); if (stomp) base.setItem(k, JSON.stringify({ tab: 'OTHER', session: 'sX', ts: c.now() })); },
    removeItem: base.removeItem,
  };
  const me = Lease.create({ storage: stomping, channel: fakeChannel(), now: c.now, tabId: 'T1' });
  stomp = true;
  const r = me.acquireForRun('P1', 's1');
  assert.strictEqual(r.ok, false);
  assert.ok(r.conflict);
});

test('renewLease: 持锁方更新 ts 并广播 renew；非持锁方空操作', () => {
  const c = clock(); const cha = fakeChannel(); const chb = fakeChannel(); const st = fakeStorage();
  const a = Lease.create({ storage: st, channel: cha, now: c.now, tabId: 'A' });
  a.acquireForRun('P1', 's1');
  cha._sent.length = 0;
  c.advance(1000);
  assert.strictEqual(a.renewLease('P1'), true);
  assert.strictEqual(a.readLease('P1').ts, c.now());
  assert.ok(cha._sent.some(m => m.type === 'renew'));
  const b = Lease.create({ storage: st, channel: chb, now: c.now, tabId: 'B' });
  assert.strictEqual(b.renewLease('P1'), false);          // 非持锁方不续
});

test('renewLeaseThrottled: <RENEW_THROTTLE 跳过，≥ 则续', () => {
  const c = clock(); const ch = fakeChannel(); const st = fakeStorage();
  const a = Lease.create({ storage: st, channel: ch, now: c.now, tabId: 'A' });
  a.acquireForRun('P1', 's1');                            // 内部置 lastRenewAt = c.now()
  c.advance(1000);                                        // < 2000
  assert.strictEqual(a.renewLeaseThrottled('P1'), false);
  c.advance(1500);                                        // 累计 2500 ≥ 2000
  assert.strictEqual(a.renewLeaseThrottled('P1'), true);
});

test('lostWhileRunning: 别家持未过期 → true；自己持/过期/空 → false', () => {
  const c = clock(); const st = fakeStorage();
  const a = Lease.create({ storage: st, channel: fakeChannel(), now: c.now, tabId: 'A' });
  a.acquireForRun('P1', 's1');
  assert.strictEqual(a.lostWhileRunning('P1'), false);     // 自己持
  const b = Lease.create({ storage: st, channel: fakeChannel(), now: c.now, tabId: 'B' });
  assert.strictEqual(b.lostWhileRunning('P1'), true);      // 别家持未过期
  c.advance(Lease.EXPIRY + 1);
  assert.strictEqual(b.lostWhileRunning('P1'), false);     // 过期不算（spec §7：过期可被抢占，不算"被抢"）
  assert.strictEqual(Lease.create({ storage: fakeStorage(), channel: fakeChannel(), now: c.now, tabId: 'C' }).lostWhileRunning('P9'), false);
});

test('releaseLease: 持锁方删键并广播 release；非持锁方不动', () => {
  const c = clock(); const cha = fakeChannel(); const chb = fakeChannel(); const st = fakeStorage();
  const a = Lease.create({ storage: st, channel: cha, now: c.now, tabId: 'A' });
  a.acquireForRun('P1', 's1');
  cha._sent.length = 0;
  assert.strictEqual(a.releaseLease('P1'), true);
  assert.strictEqual(a.readLease('P1'), null);
  assert.ok(cha._sent.some(m => m.type === 'release'));
  // 非持锁方对空键释放：false 且不广播
  const b = Lease.create({ storage: st, channel: chb, now: c.now, tabId: 'B' });
  chb._sent.length = 0;
  assert.strictEqual(b.releaseLease('P1'), false);
  assert.strictEqual(chb._sent.length, 0);
});

test('applyPeerMessage: 自己的消息返回 false，别家返回 true', () => {
  const lm = Lease.create({ storage: fakeStorage(), channel: fakeChannel(), now: clock().now, tabId: 'T1' });
  assert.strictEqual(lm.applyPeerMessage({ tabId: 'T1' }), false);
  assert.strictEqual(lm.applyPeerMessage({ tabId: 'T2', type: 'acquire' }), true);
  assert.strictEqual(lm.applyPeerMessage(null), false);
});

test('blockedReason: free/held-self/expired -> null；held-other 同会话->session，他话->project', () => {
  const c = clock(); const st = fakeStorage();
  const a = Lease.create({ storage: st, channel: fakeChannel(), now: c.now, tabId: 'A' });
  a.acquireForRun('P1', 's1');
  const b = Lease.create({ storage: st, channel: fakeChannel(), now: c.now, tabId: 'B' });
  assert.strictEqual(b.blockedReason('P1', 's1').kind, 'session');
  assert.strictEqual(b.blockedReason('P1', 's2').kind, 'project');
  assert.strictEqual(a.blockedReason('P1', 's1'), null);    // a 自己不挡自己（l.tab===tabId -> null）
  c.advance(Lease.EXPIRY + 1);
  assert.strictEqual(b.blockedReason('P1', 's1'), null);     // 过期不挡
});

test('sessionLockState: running / locked-session / locked-project / free', () => {
  const c = clock(); const st = fakeStorage();
  const a = Lease.create({ storage: st, channel: fakeChannel(), now: c.now, tabId: 'A' });
  a.acquireForRun('P1', 's1');
  // 别家视角
  const b = Lease.create({ storage: st, channel: fakeChannel(), now: c.now, tabId: 'B' });
  assert.strictEqual(b.sessionLockState('P1', 's1', false, null), 'locked-session');
  assert.strictEqual(b.sessionLockState('P1', 's2', false, null), 'locked-project');
  assert.strictEqual(b.sessionLockState('P1', 's1', true, 's1'), 'running');  // 本页在跑 s1
  // 空闲项目
  assert.strictEqual(b.sessionLockState('P9', 'sX', false, null), 'free');
});
