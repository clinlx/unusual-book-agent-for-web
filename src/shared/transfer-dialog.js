'use strict';
// Shared, entirely page-rendered progress/error dialog for both applications.
const TransferDialog = (() => {
  function open(title) {
    const previous = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'world-transfer-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:#111a;z-index:20000;display:grid;place-items:center;padding:16px';
    const box = document.createElement('section');
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', title); box.tabIndex = -1;
    box.style.cssText = 'width:min(460px,100%);max-height:90vh;overflow:auto;background:var(--transfer-panel,#eee7d7);color:var(--transfer-fg,#342f26);border:1px solid #b79b62;border-radius:3px;padding:22px;font:14px/1.7 system-ui';
    const heading = document.createElement('h3'); heading.textContent = title;
    const status = document.createElement('p'); status.setAttribute('role', 'status'); status.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0';
    const progress = document.createElement('progress'); progress.max = 1; progress.style.cssText = 'width:100%;height:12px;accent-color:#80704e'; progress.setAttribute('aria-label', '世界交接进度');
    const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:16px';
    box.append(heading, status, progress, actions); overlay.append(box); document.body.append(overlay); box.focus();
    overlay.addEventListener('click', e => e.stopPropagation());
    overlay.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') e.preventDefault();
      if (e.key === 'Tab') {
        const items = [...box.querySelectorAll('button')].filter(b => !b.disabled);
        if (!items.length) { e.preventDefault(); box.focus(); }
        else if (e.shiftKey && (document.activeElement === items[0] || document.activeElement === box)) { e.preventDefault(); items.at(-1).focus(); }
        else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0].focus(); }
      }
    });
    function update(text, fraction) {
      overlay.dismissFromBack = () => {};
      status.textContent = text; progress.hidden = false; actions.replaceChildren();
      if (Number.isFinite(fraction)) progress.value = Math.max(0, Math.min(1, fraction)); else progress.removeAttribute('value');
    }
    function choices(text, buttons) {
      status.textContent = text; progress.hidden = true; actions.replaceChildren();
      for (const [label, action] of buttons) {
        const button = document.createElement('button'); button.textContent = label; button.type = 'button';
        button.style.cssText = 'font:inherit;padding:5px 12px;border:1px solid #b79b62;background:var(--transfer-button,#e4dac3);color:var(--transfer-fg,#342f26);border-radius:3px;cursor:pointer';
        button.onclick = async () => { try { await action(); } catch (error) { status.textContent = error.message; } };
        actions.append(button);
      }
      overlay.dismissFromBack = () => {
        const button = [...actions.querySelectorAll('button')].find(b => /关闭|取消|返回编辑/.test(b.textContent));
        button?.click();
      };
      actions.querySelector('button')?.focus();
    }
    return { update, choices, close: () => { overlay.remove(); if (previous?.isConnected) previous.focus(); } };
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = String(name || '世界').replace(/[\\/:*?"<>|]/g, '_') + '.zip';
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function handleBack() {
    const overlays = document.querySelectorAll('.world-transfer-overlay');
    const top = overlays[overlays.length - 1];
    if (!top) return false;
    top.dismissFromBack?.();
    return true;
  }
  return { open, download, handleBack };
})();
