'use strict';
const SendShortcut = (() => {
  function action(event, reversed = false) {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey) return null;
    const modified = !!(event.ctrlKey || event.metaKey);
    return (reversed ? !modified : modified) ? 'send' : 'newline';
  }
  function hint(reversed = false) {
    return reversed ? 'Enter 发送 · Ctrl / ⌘ + Enter 换行' : 'Ctrl / ⌘ + Enter 发送 · Enter 换行';
  }
  return { action, hint };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SendShortcut;
