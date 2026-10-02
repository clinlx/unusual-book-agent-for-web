'use strict';
// One history guard per page: consume Back only while a local layer can close.
const BackNavigation = (() => {
  const KEY = '__bookAgentBack';
  function install(handleBack) {
    const page = location.pathname + location.search;
    const marker = () => history.state?.[KEY];
    let leaving = false;
    function arm() {
      if (marker()?.page === page && marker().kind === 'guard') return;
      const state = history.state && typeof history.state === 'object' ? history.state : {};
      history.replaceState({ ...state, [KEY]: { page, kind: 'base' } }, '');
      history.pushState({ ...state, [KEY]: { page, kind: 'guard' } }, '');
    }
    window.addEventListener('popstate', event => {
      const target = event.state?.[KEY];
      if (leaving || target?.page !== page || target.kind !== 'base') return;
      if (handleBack()) arm();
      else { leaving = true; history.back(); }
    });
    window.addEventListener('pageshow', () => { leaving = false; arm(); });
    arm();
  }
  return { install };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = BackNavigation;
