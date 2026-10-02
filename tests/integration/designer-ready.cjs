'use strict';
module.exports = async function readyDesigner(page) {
  await page.waitForFunction(() => window.__UI_STATE__?.sessionId && !document.querySelector('#boot'));
  if (await page.locator('#welcomeOverlay').count()) {
    await page.locator('#welcomeOverlay').getByRole('button', { name: '知道了', exact: true }).click();
    await page.locator('#welcomeOverlay').waitFor({ state: 'detached' });
  }
};
