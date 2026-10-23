'use strict';
const RequestRetry = (() => {
  const defaults = typeof module !== 'undefined' && module.exports ? require('../frontend-config').common : FrontendConfig.common;
  function validate(settings) {
    const maxConsecutiveFailures = Number(settings.maxConsecutiveFailures ?? defaults.maxConsecutiveFailures);
    const retryCooldownSeconds = Number(settings.retryCooldownSeconds ?? defaults.retryCooldownSeconds);
    if (!Number.isInteger(maxConsecutiveFailures) || maxConsecutiveFailures < 1 || maxConsecutiveFailures > 100)
      throw Error('最大连续失败次数须为 1–100 的整数');
    if (!Number.isFinite(retryCooldownSeconds) || retryCooldownSeconds < 0 || retryCooldownSeconds > 3600)
      throw Error('重试冷却时间须为 0–3600 秒');
    return { autoRetry: settings.autoRetry === true, maxConsecutiveFailures, retryCooldownSeconds };
  }
  const aborted = signal => signal?.reason || Object.assign(Error('已中止'), { name: 'AbortError' });
  function check(signal) { if (signal?.aborted) throw aborted(signal); }
  function wait(ms, signal) {
    check(signal);
    return new Promise((resolve, reject) => {
      const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(aborted(signal)); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
      signal?.addEventListener('abort', stop, { once: true });
    });
  }
  function retryable(error) {
    if (!error || error.name === 'AbortError' || ['CONTEXT_LIMIT', 'OUTPUT_LIMIT'].includes(error.code)) return false;
    if (Number.isInteger(error.status)) return [408, 429].includes(error.status) || error.status >= 500 && error.status <= 599;
    return ['MODEL_NETWORK_ERROR', 'MODEL_TIMEOUT', 'MODEL_STREAM_ERROR', 'MODEL_PROTOCOL_ERROR', 'MODEL_RESPONSE_ERROR'].includes(error.code);
  }
  const networkError = error => error?.name === 'AbortError' ? error
    : Object.assign(new Error(error?.message || '模型请求网络连接失败'), { code: 'MODEL_NETWORK_ERROR', cause: error });
  const message = ({ failures, maxFailures, delaySeconds }) => `请求连续失败 ${failures}/${maxFailures} 次，${delaySeconds} 秒后自动重试，可随时停止。`;
  // Only retry a model request. Tool execution and persistence stay outside this boundary.
  function wrap(request, settings, hooks = {}) {
    return async (...args) => {
      const policy = settings.autoRetry === true ? validate(settings) : { autoRetry: false };
      for (let failures = 0; ; ) {
        check(hooks.signal);
        await hooks.onAttempt?.();
        check(hooks.signal);
        try { const result = await request(...args); check(hooks.signal); return result; }
        catch (error) {
          check(hooks.signal);
          failures++;
          if (!policy.autoRetry || !retryable(error) || failures >= policy.maxConsecutiveFailures) throw error;
          await hooks.onRetry?.({ error, failures, maxFailures: policy.maxConsecutiveFailures, delaySeconds: policy.retryCooldownSeconds });
          await wait(policy.retryCooldownSeconds * 1000, hooks.signal);
        }
      }
    };
  }
  return { validate, retryable, networkError, message, wrap };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = RequestRetry;
