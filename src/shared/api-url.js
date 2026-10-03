'use strict';
const ApiUrl = (() => {
  function root(value) {
    const base = String(value || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) throw Error('请在设置中填写有效的模型 API 地址');
    return base.replace(/(?:\/chat\/completions)+$/, '');
  }
  return { root };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ApiUrl;
