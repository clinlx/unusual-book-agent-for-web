'use strict';

const Lease = (() => {
  const EXPIRY = 8000;
  const HEARTBEAT = 2000;
  const RENEW_THROTTLE = 750;
  const PREFIX = 'awl:lease:';

  function create(opts = {}) {
    const storage = opts.storage || null;
    const channel = opts.channel || null;
    const now = opts.now || (() => Date.now());
    const tabId = opts.tabId || (opts.uid ? opts.uid() : (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)));
    const available = !!(storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function');
    let lastRenewAt = 0;

    const key = projectId => PREFIX + projectId;
    const parse = raw => { try { const v = JSON.parse(raw); return (v && typeof v === 'object') ? v : null; } catch (_) { return null; } };

    function readLease(projectId) {
      if (!available) return null;
      const v = parse(storage.getItem(key(projectId)));
      if (!v) return null;
      return { tab: v.tab || null, session: v.session || null, ts: v.ts || 0 };
    }
    function writeLease(projectId, rec) { if (available) storage.setItem(key(projectId), JSON.stringify(rec)); }
    function eraseLease(projectId) { if (available) { try { storage.removeItem(key(projectId)); } catch (_) {} } }

    function expired(ts) { return now() - ts > EXPIRY; }
    function status(projectId) {
      const l = readLease(projectId);
      if (!l) return 'free';
      if (l.tab === tabId) return expired(l.ts) ? 'expired-other' : 'held-self';
      return expired(l.ts) ? 'expired-other' : 'held-other';
    }
    function isHeldByOther(projectId) { return status(projectId) === 'held-other'; }

    function broadcast(type, projectId, session) {
      if (!channel || typeof channel.postMessage !== 'function') return;
      try { channel.postMessage({ type, projectId, sessionId: session, tabId, ts: now() }); } catch (_) {}
    }
    function acquireForRun(projectId, session) {
      const st = status(projectId);
      if (st === 'held-other') {
        const l = readLease(projectId);
        return { ok: false, conflict: { kind: (l && l.session === session) ? 'session' : 'project', session: l ? l.session : null } };
      }
      writeLease(projectId, { tab: tabId, session, ts: now() });
      const got = readLease(projectId);
      if (!got || got.tab !== tabId) {                       
        const kind = (got && got.session === session) ? 'session' : 'project';
        return { ok: false, conflict: { kind, session: got ? got.session : null } };
      }
      broadcast('acquire', projectId, session);
      lastRenewAt = now();
      return { ok: true };
    }
    function renewLease(projectId) {
      const l = readLease(projectId);
      if (!l || l.tab !== tabId) return false;            
      const ts = now();
      if (ts === l.ts) return false;
      writeLease(projectId, { tab: tabId, session: l.session, ts });
      broadcast('renew', projectId, l.session);
      return true;
    }
    function renewLeaseThrottled(projectId) {
      const ts = now();
      if (ts - lastRenewAt < RENEW_THROTTLE) return false;
      lastRenewAt = ts;
      return renewLease(projectId);
    }
    
    function lostWhileRunning(projectId) {
      const l = readLease(projectId);
      return !!(l && l.tab !== tabId && !expired(l.ts));
    }
    function releaseLease(projectId) {
      const l = readLease(projectId);
      if (!l || l.tab !== tabId) return false;
      eraseLease(projectId);
      broadcast('release', projectId, l.session);
      return true;
    }
    function applyPeerMessage(msg) {
      if (!msg || msg.tabId === tabId) return false;       
      return true;
    }
    function blockedReason(projectId, currentSession) {
      const l = readLease(projectId);
      if (!l || l.tab === tabId || expired(l.ts)) return null;
      return { kind: (l.session === currentSession) ? 'session' : 'project', session: l.session };
    }
    function sessionLockState(projectId, sessionId, running, runningSession) {
      if (running && runningSession === sessionId) return 'running';
      const l = readLease(projectId);
      if (l && l.tab !== tabId && !expired(l.ts))
        return (l.session === sessionId) ? 'locked-session' : 'locked-project';
      return 'free';
    }

    return {
      tabId, available, EXPIRY, HEARTBEAT, RENEW_THROTTLE, PREFIX,
      readLease, writeLease, eraseLease, status, isHeldByOther, acquireForRun,
      renewLease, renewLeaseThrottled, lostWhileRunning, releaseLease, applyPeerMessage,
      blockedReason, sessionLockState,
    };
  }
  return { create, EXPIRY, HEARTBEAT, RENEW_THROTTLE, PREFIX };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Lease;
