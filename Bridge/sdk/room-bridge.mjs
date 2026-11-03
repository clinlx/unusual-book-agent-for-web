// Dependency-free ES module for modern browsers and Node.js 22+.
// Use WSS outside localhost: the initial credential exchange relies on TLS.
import { BridgeError } from './errors.mjs';
export { BridgeError } from './errors.mjs';
const utf8 = new TextEncoder();
const text = new TextDecoder('utf-8', { fatal: true });
const subtle = globalThis.crypto.subtle;
const concat = (...parts) => {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};
function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error('Non-canonical base64url');
  return bytes;
}
async function derive(material, salt, info) {
  const key = await subtle.importKey('raw', material, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8.encode(info) }, key, 256));
}
export function randomToken() { return encode(crypto.getRandomValues(new Uint8Array(32))); }

/** Issue a capability scoped to the room, its creation epoch, and player ID. */
export async function issueClientToken(hostToken, roomId, epoch, clientId) {
  const root = decode(hostToken);
  if (root.length !== 32 || decode(epoch).length !== 32) throw new Error('Host token and epoch must be random 32-byte secrets');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(clientId) || !/^[A-Za-z0-9_-]{1,64}$/.test(roomId)) throw new Error('Invalid room or client ID');
  const material = await derive(root, utf8.encode(epoch), 'RoomBridge/v1/issue/' + roomId);
  root.fill(0);
  const key = await subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  material.fill(0);
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const tag = await subtle.sign('HMAC', key, concat(utf8.encode(clientId), new Uint8Array(1), nonce));
  return encode(nonce) + '.' + encode(new Uint8Array(tag));
}

/** Schemas are stable identifiers, e.g. move:v1, rather than executable code. */
export async function contractHash(manifest) {
  const tuples = [];
  for (const direction of ['host', 'client']) {
    const functions = manifest[direction + 'Functions'] ?? [];
    const ids = new Set();
    if (functions.length > 256) throw new Error('Too many functions');
    for (const fn of [...functions].sort((a, b) => a.id - b.id)) {
      const limit = fn.maxPayloadBytes ?? 65536;
      if (!Number.isInteger(fn.id) || fn.id < 1 || fn.id > 2147483647 || ids.has(fn.id) ||
          typeof fn.schema !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(fn.schema) || !Number.isInteger(limit) || limit < 1)
        throw new Error('Invalid function contract');
      ids.add(fn.id);
      tuples.push([direction, fn.id, fn.schema, limit]);
    }
  }
  return Array.from(new Uint8Array(await subtle.digest('SHA-256', utf8.encode(JSON.stringify(tuples)))), n => n.toString(16).padStart(2, '0')).join('');
}

export class BridgeConnection {
  /** Connect returns only after authenticated encrypted Ready is received.
   * hello: host {token,epoch,manifest,players}; client {token,contractHash}.
   * All paths omit credentials. The same module runs in browsers and Node 22.
   */
  static async connect(baseUrl, role, roomId, hello, options = {}) {
    if (!hello || (role !== 'server' && role !== 'client') || !/^[A-Za-z0-9_-]{1,64}$/.test(roomId)) throw new BridgeError('InvalidConfiguration', { phase: 'configuration' });
    let url;
    try { url = new URL(baseUrl); } catch (cause) { throw new BridgeError('InvalidConfiguration', { phase: 'configuration', cause }); }
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new BridgeError('InvalidConfiguration', { phase: 'configuration' });
    url.pathname = '/' + role + '/' + encodeURIComponent(roomId);
    url.search = ''; url.hash = '';
    const init = { ...hello, protocolVersion: hello.protocolVersion ?? 1, clientNonce: randomToken() };
    if (role === 'server') {
      try { init.contractHash = await contractHash(init.manifest); }
      catch (cause) { throw new BridgeError('InvalidManifest', { phase: 'configuration', cause }); }
    }
    let bridge;
    try { bridge = new BridgeConnection(url, init, options); }
    catch (cause) { throw new BridgeError('ConnectionFailed', { phase: 'connecting', cause }); }
    try {
      bridge.ready = await bridge.next('Ready', options.timeoutMs ?? 10000);
      bridge.timer = setInterval(() => {
        if (Date.now() - bridge.lastReceived > (options.idleMs ?? 45000)) { bridge.fail(new BridgeError('HeartbeatTimeout')); return; }
        bridge.send({ type: 'Ping', requestId: '__heartbeat' }).catch(() => {});
      }, options.pingMs ?? 15000);
      return bridge;
    } catch (error) { bridge.fail(error); throw error; }
  }

  constructor(url, hello, options) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.inbox = []; this.waiters = []; this.listeners = new Set();
    this.errorListeners = new Set(); this.requests = new Map(); this.phase = 'connecting';
    if (options.onError) this.errorListeners.add(options.onError);
    this.sendSequence = 0n; this.receiveSequence = 0n;
    this.sendChain = Promise.resolve(); this.receiveChain = Promise.resolve();
    this.maxQueueMessages = options.maxQueueMessages ?? 256;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 1048576;
    this.maxMessageBytes = options.maxMessageBytes ?? 131072;
    this.pendingSends = 0; this.pendingBytes = 0; this.pendingReceiveBytes = 0; this.lastReceived = Date.now();
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.ws.addEventListener('open', () => { this.phase = 'handshake'; this.ws.send(JSON.stringify(hello)); });
    this.ws.addEventListener('message', event => {
      const size = typeof event.data === 'string' ? utf8.encode(event.data).length : event.data.byteLength;
      if (this.pendingReceiveBytes + size > this.maxBufferedBytes) { this.fail(new BridgeError('Backpressure')); return; }
      this.pendingReceiveBytes += size;
      this.receiveChain = this.receiveChain.then(() => this.receive(event.data, hello)).catch(error => this.fail(error))
        .finally(() => { this.pendingReceiveBytes -= size; });
    });
    // Browsers deliberately hide HTTP upgrade status/TLS/DNS details. Wait for close,
    // and drain already queued decryptions before assigning a generic transport error.
    this.ws.addEventListener('error', () => {
      this.receiveChain.then(() => {
        if (!this.failure && !this.localClose)
          this.fail(new BridgeError(this.phase === 'session' ? 'ConnectionLost' : 'ConnectionFailed', { phase: this.phase }));
      });
    });
    this.ws.addEventListener('close', event => {
      this.receiveChain.finally(() => {
        if (!this.failure) {
          const serverReason = !this.localClose && event.code === 1008 && event.reason;
          const code = serverReason || (this.localClose ? 'ClientClosed' : this.phase === 'session' ? 'ConnectionLost' : 'ConnectionFailed');
          this.fail(new BridgeError(code, { phase: this.phase, closeCode: event.code, server: !!serverReason }), !this.localClose);
        }
        this.resolveClosed({ code: event.code, reason: event.reason, error: this.failure?.code === 'ClientClosed' ? null : this.failure });
      });
    });
  }

  async receive(data, hello) {
    if (this.failure) return;
    if (!this.receiveKey) {
      if (typeof data !== 'string') throw new Error('Expected Welcome');
      const welcome = JSON.parse(data);
      if (welcome.type === 'Error') throw new BridgeError(welcome.code, { phase: 'handshake', server: true });
      if (welcome.type !== 'Welcome' || !welcome.sessionId) throw new BridgeError('InvalidHandshake', { phase: 'handshake' });
      const serverNonce = decode(welcome.serverNonce);
      if (serverNonce.length !== 32) throw new Error('Invalid server nonce');
      const salt = new Uint8Array(await subtle.digest('SHA-256', concat(decode(hello.clientNonce), serverNonce)));
      const keys = await Promise.all(['c2s', 's2c'].map(async direction => {
        const bytes = await derive(utf8.encode(hello.token), salt, 'RoomBridge/v1/' + welcome.sessionId + '/' + direction);
        const key = await subtle.importKey('raw', bytes, 'AES-GCM', false, [direction === 'c2s' ? 'encrypt' : 'decrypt']);
        bytes.fill(0); return key;
      }));
      [this.sendKey, this.receiveKey] = keys;
      delete hello.token;
      return;
    }
    if (!(data instanceof ArrayBuffer) || data.byteLength < 24 || data.byteLength > this.maxBufferedBytes) throw new Error('Invalid encrypted record');
    const bytes = new Uint8Array(data);
    if (this.receiveSequence === 0xffffffffffffffffn || new DataView(data).getBigUint64(0) !== this.receiveSequence) throw new BridgeError('IntegrityCheckFailed', { phase: this.phase });
    const aad = bytes.slice(0, 8), nonce = new Uint8Array(12); nonce.set(aad, 4);
    let plaintext;
    try { plaintext = await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, this.receiveKey, bytes.subarray(8)); }
    catch (cause) { throw new BridgeError('IntegrityCheckFailed', { phase: this.phase, cause }); }
    this.receiveSequence++;
    const message = JSON.parse(text.decode(plaintext));
    if (message.type === 'Ready') this.phase = 'session';
    this.lastReceived = Date.now();
    if (message.type === 'Pong' && message.requestId === '__heartbeat') return;
    const error = message.type === 'Error' || message.type === 'Disconnected'
      ? new BridgeError(message.code, { phase: this.phase, fatal: message.type === 'Disconnected', requestId: message.requestId, revision: message.revision, server: true }) : null;
    const request = this.requests.get(message.requestId);
    const handled = request && (message.type === 'Error' || message.type === request.responseType);
    if (handled) {
      this.requests.delete(message.requestId); clearTimeout(request.timer);
      if (error) request.reject(error); else request.resolve(message);
    }
    const index = this.waiters.findIndex(w => (w.type === undefined || w.type === message.type) && w.predicate(message));
    if (index >= 0) { const waiter = this.waiters.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(message); }
    else if (!handled && this.listeners.size === 0) {
      if (this.inbox.length >= this.maxQueueMessages) throw new Error('Receive inbox full; consume messages or register onMessage');
      this.inbox.push(message);
    }
    if (error?.fatal) this.fail(error);
    else if (error) this.emitError(error);
    for (const listener of this.listeners) listener(message);
  }

  /** Register a synchronous message handler. Unmatched messages are queued only without listeners. */
  onMessage(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onError(listener) { this.errorListeners.add(listener); return () => this.errorListeners.delete(listener); }
  emitError(error) {
    for (const listener of this.errorListeners) {
      try { listener(error); } catch (callbackError) { console.error('RoomBridge onError callback failed', callbackError); }
    }
  }
  next(type, timeoutMs = 5000, predicate = () => true) {
    const index = this.inbox.findIndex(m => (type === undefined || m.type === type) && predicate(m));
    if (index >= 0) return Promise.resolve(this.inbox.splice(index, 1)[0]);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const waiter = { type, predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== waiter);
        reject(new BridgeError(this.phase === 'connecting' ? 'ConnectTimeout' : this.phase === 'handshake' ? 'HandshakeTimeout' : 'RequestTimeout', { phase: this.phase, fatal: this.phase !== 'session' }));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Serialized encryption preserves nonce/message order even with concurrent callers. */
  send(message) {
    if (this.failure) return Promise.reject(this.failure);
    if (++this.pendingSends > this.maxQueueMessages) { this.pendingSends--; return Promise.reject(new BridgeError('Backpressure', { fatal: false })); }
    let plaintext;
    try { plaintext = utf8.encode(JSON.stringify(message)); }
    catch (cause) { this.pendingSends--; return Promise.reject(new BridgeError('InvalidMessage', { fatal: false, cause })); }
    if (plaintext.length > this.maxMessageBytes || this.pendingBytes + plaintext.length > this.maxBufferedBytes) { this.pendingSends--; return Promise.reject(new BridgeError(plaintext.length > this.maxMessageBytes ? 'MessageTooLarge' : 'Backpressure', { fatal: false })); }
    this.pendingBytes += plaintext.length;
    const operation = this.sendChain.then(async () => {
      if (this.failure) throw this.failure;
      if (!this.sendKey || this.ws.readyState !== WebSocket.OPEN) throw new BridgeError('ConnectionLost');
      if (this.ws.bufferedAmount + plaintext.length + 24 > this.maxBufferedBytes) throw new BridgeError('Backpressure');
      if (this.sendSequence === 0xffffffffffffffffn) throw new BridgeError('IntegrityCheckFailed');
      const aad = new Uint8Array(8); new DataView(aad.buffer).setBigUint64(0, this.sendSequence);
      const nonce = new Uint8Array(12); nonce.set(aad, 4);
      const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, this.sendKey, plaintext);
      this.ws.send(concat(aad, new Uint8Array(ciphertext)));
      this.sendSequence++;
    }).catch(error => { throw error instanceof BridgeError ? error : new BridgeError('SendFailed', { cause: error }); })
      .finally(() => { this.pendingSends--; this.pendingBytes -= plaintext.length; });
    this.sendChain = operation.catch(error => this.fail(error));
    return operation;
  }
  invoke(functionId, payload, requestId = crypto.randomUUID()) { return this.send({ type: 'Invoke', functionId, payload, requestId }); }
  invokeClient(clientId, functionId, payload, requestId = crypto.randomUUID()) { return this.send({ type: 'InvokeClient', clientId, functionId, payload, requestId }); }
  replaceAuthorization(players, expectedRevision, requestId = crypto.randomUUID()) { return this.send({ type: 'ReplaceAuthorization', players, expectedRevision, requestId }); }
  /** Correlates control success/Error without replaying a possibly completed operation. */
  request(message, responseType, timeoutMs = 5000) {
    if (this.failure) return Promise.reject(this.failure);
    const requestId = message.requestId ?? crypto.randomUUID();
    if (this.requests.has(requestId)) return Promise.reject(new BridgeError('DuplicateRequestId', { fatal: false, requestId }));
    return new Promise((resolve, reject) => {
      const request = { responseType, resolve, reject };
      request.timer = setTimeout(() => {
        this.requests.delete(requestId);
        reject(new BridgeError('RequestTimeout', { fatal: false, requestId }));
      }, timeoutMs);
      this.requests.set(requestId, request);
      this.send({ ...message, requestId }).catch(error => {
        if (this.requests.get(requestId) === request) {
          this.requests.delete(requestId); clearTimeout(request.timer); reject(error);
        }
      });
    });
  }
  fail(error, notify = true) {
    if (this.failure) return;
    if (!(error instanceof BridgeError)) error = new BridgeError('InvalidMessage', { phase: this.phase, cause: error });
    this.failure = error; clearInterval(this.timer);
    for (const waiter of this.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(error); }
    this.requests.clear();
    this.sendKey = undefined; this.receiveKey = undefined;
    if (notify) this.emitError(error);
    this.close();
  }
  close() { this.localClose = true; clearInterval(this.timer); if (this.ws.readyState < WebSocket.CLOSING) this.ws.close(1000, 'Client closing'); }
}
