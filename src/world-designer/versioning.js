'use strict';
const Versioning = (() => {
  function sorted(snaps) {
    return snaps.slice().sort((a, b) => a.createdAt - b.createdAt);
  }

  // 回滚到快照 targetId 之前的状态：恢复 target.tree（该轮开始前的全量树），
  // 删除 target 及其后所有快照；列出其后由其他 Session 产生的快照的 Session 集合。
  function planRollback(snaps, targetId) {
    const list = sorted(snaps);
    const idx = list.findIndex(s => s.id === targetId);
    if (idx === -1) throw new Error('快照不存在: ' + targetId);
    const target = list[idx];
    const after = list.slice(idx + 1);
    const conflictSessions = [...new Set(
      after.filter(s => s.turnRef.sessionId !== target.turnRef.sessionId)
           .map(s => s.turnRef.sessionId)
    )];
    return {
      restoreTree: target.tree,
      deleteIds: [target.id, ...after.map(s => s.id)],
      conflictSessions,
    };
  }

  // 优先按稳定的 msgId 匹配；msgIndex 是数组下标，删除/撤回消息后会整体前移，
  // 老数据没有 msgId 时才回落到下标（表现为历史轮次的回滚按钮可能失配）。
  function findSnapshotForTurn(snaps, sessionId, msgIndex, msgId) {
    if (msgId) {
      const byId = snaps.find(s => s.turnRef.sessionId === sessionId && s.turnRef.msgId === msgId);
      if (byId) return byId;
    }
    return snaps.find(s => s.turnRef.sessionId === sessionId
      && s.turnRef.msgId === undefined && s.turnRef.msgIndex === msgIndex) || null;
  }

  return { planRollback, findSnapshotForTurn, sorted };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Versioning;
