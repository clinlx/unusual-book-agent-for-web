'use strict';
const MD = (() => {
  
  const ALLOWED = new Set(['P','BR','HR','H1','H2','H3','H4','H5','H6','UL','OL','LI','BLOCKQUOTE','PRE','CODE','EM','STRONG','DEL','TABLE','THEAD','TBODY','TR','TH','TD','A','IMG','SPAN','DIV']);

  function render(mdText) {
    const html = (typeof marked !== 'undefined')
      ? marked.parse(mdText || '', { async: false })
      : escapeHtml(mdText || '');
    return sanitize(html);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  
  function sanitize(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    (function walk(node) {
      for (const el of Array.from(node.children)) {
        if (!ALLOWED.has(el.tagName)) { el.replaceWith(...el.childNodes); walk(node); continue; }
        for (const attr of Array.from(el.attributes)) {
          const n = attr.name.toLowerCase();
          const ok = (n === 'href' && el.tagName === 'A') || (n === 'src' && el.tagName === 'IMG') || n === 'class' || n === 'alt' || n === 'title';
          if (!ok) el.removeAttribute(attr.name);
          else if ((n === 'href' || n === 'src') && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
        }
        if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener'); }
        walk(el);
      }
    })(tpl.content);
    return tpl.innerHTML;
  }

  return { render, escapeHtml };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = MD;
