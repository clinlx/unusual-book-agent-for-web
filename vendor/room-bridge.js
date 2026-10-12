'use strict';
// Vendored from Bridge/sdk/errors.mjs and Bridge/sdk/room-bridge.mjs (2026-10-11).
// Source: C:/Users/Administrator/source/repos/Bridge.
const RoomBridgeSDK=(()=>{
// Stable machine codes; messages are safe to show as textContent, never as HTML.
const definitions = {
  ConnectionFailed: ['无法建立服务器连接，请检查网络、服务器地址、证书或网页来源设置。', 'network', true],
  ConnectTimeout: ['连接服务器超时，请检查网络或稍后重试。', 'network', true],
  HandshakeTimeout: ['已连接服务器，但房间握手超时。', 'network', true],
  ConnectionLost: ['与服务器的连接已中断。', 'network', true],
  ConnectionClosed: ['连接已关闭，未收到更具体的原因。', 'network', true],
  TransportClosed: ['底层网络连接已关闭。', 'network', true],
  HeartbeatTimeout: ['服务器长时间未响应，连接已关闭。', 'network', true],
  IdleTimeout: ['长时间未收到有效消息，连接已超时。', 'network', true],
  SendFailed: ['消息发送失败，连接已关闭。', 'network', true],
  ClientClosed: ['连接已由当前页面关闭。', 'local', false],
  InvalidConfiguration: ['连接参数无效，请检查服务器地址、房间 ID 和客户端配置。', 'local', false],
  RoomNotFound: ['房间不存在，请确认房间号，或等待房主创建房间。', 'room', false],
  RoomUnavailable: ['房间正在关闭或暂时不可用。', 'room', true],
  RoomExists: ['房间号已被占用，无法重复创建。', 'room', false],
  RoomCapacity: ['服务器房间数量已达上限，请稍后重试。', 'capacity', true],
  Unauthorized: ['无权进入房间，凭证无效或不在当前授权名单中。', 'authorization', false],
  AlreadyConnected: ['该玩家身份已在线，请先断开原连接。', 'authorization', false],
  AuthorizationRevoked: ['房主已撤销你的访问权限，或更换了你的凭证。', 'authorization', false],
  ContractMismatch: ['页面支持的房间函数协议不匹配，请使用与房主兼容的版本。', 'protocol', false],
  ProtocolVersionMismatch: ['通信协议版本不兼容，请更新客户端。', 'protocol', false],
  InvalidHello: ['连接握手参数无效。', 'protocol', false],
  InvalidHandshake: ['握手格式无效或无法完成。', 'protocol', false],
  InvalidHostSecret: ['房主凭证或房间代次格式无效。', 'authorization', false],
  InvalidManifest: ['房主声明的函数协议无效。', 'protocol', false],
  MetadataTooLarge: ['房间基础信息或函数声明过大。', 'protocol', false],
  InvalidAuthorization: ['授权名单无效，可能包含重复身份、重复凭证或不匹配的凭证。', 'authorization', false],
  RevisionConflict: ['授权名单版本已变化，本次更新未生效。', 'conflict', false],
  ClientUnavailable: ['目标玩家未在线或已无访问权限。', 'room', false],
  HostDisconnected: ['房主已断开连接，房间已关闭。', 'room', false],
  HostUnavailable: ['房主连接异常或处理能力不足，房间已关闭。', 'room', false],
  ServerShutdown: ['服务器正在停止，房间已关闭。', 'network', true],
  IdentitySpoof: ['消息包含禁止指定的玩家身份字段。', 'protocol', false],
  UnknownFunction: ['调用了未声明的函数。', 'protocol', false],
  ForbiddenMessage: ['当前身份不能发送此类消息。', 'authorization', false],
  InvalidRequestId: ['请求标识格式无效。', 'protocol', false],
  InvalidMessage: ['消息格式无效。', 'protocol', false],
  InvalidFrameType: ['消息帧类型不符合协议。', 'protocol', false],
  IntegrityCheckFailed: ['消息完整性或序号校验失败，连接已关闭。', 'protocol', false],
  PayloadTooLarge: ['函数参数超出大小限制。', 'capacity', false],
  MessageTooLarge: ['消息超出大小限制。', 'capacity', false],
  OutgoingMessageTooLarge: ['转发后的消息超出大小限制。', 'capacity', false],
  RateLimited: ['消息发送过于频繁，连接已关闭。', 'capacity', true],
  SlowConsumer: ['消息处理过慢，发送队列已满，连接已关闭。', 'capacity', true],
  Backpressure: ['本地消息队列已满，请降低发送速度。', 'capacity', true],
  RequestTimeout: ['等待服务器响应超时，请确认结果后再重试。', 'network', false],
  DuplicateRequestId: ['同一请求标识仍在等待响应，不能重复使用。', 'local', false],
  UnknownServerError: ['服务器返回了当前客户端无法识别的错误。', 'server', false]
};

class BridgeError extends Error {
  constructor(code, { phase = 'session', fatal = true, requestId, revision, closeCode, server = false, cause } = {}) {
    const known = Object.hasOwn(definitions, code);
    const [message, category, retryable] = definitions[known ? code : 'UnknownServerError'];
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BridgeError';
    this.code = known ? code : 'UnknownServerError';
    this.category = category; this.retryable = retryable; this.phase = phase; this.fatal = fatal;
    this.requestId = requestId; this.revision = revision; this.closeCode = closeCode;
    // Bounded diagnostic code, never interpolated into the user-facing message.
    if (server) this.serverCode = typeof code === 'string' ? code.slice(0, 128) : undefined;
  }
}

// Dependency-free ES module for modern browsers and Node.js 22+.
// Use WSS outside localhost: the initial credential exchange relies on TLS.


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
function randomToken() { return encode(crypto.getRandomValues(new Uint8Array(32))); }

/** Issue a capability scoped to the room, its creation epoch, and player ID. */
async function issueClientToken(hostToken, roomId, epoch, clientId) {
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
async function contractHash(manifest) {
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

function diagnosticError(error, depth = 0) {
  if (!error || depth > 2) return null;
  const names = ['Error', 'BridgeError', 'TypeError', 'SyntaxError', 'RangeError', 'DOMException', 'OperationError', 'DataError', 'InvalidStateError', 'SecurityError', 'AbortError', 'NetworkError'];
  const result = { name: names.includes(error.name) ? error.name : 'Error' };
  if (Object.hasOwn(definitions, error.code)) result.code = error.code;
  if (['configuration', 'connecting', 'handshake', 'session'].includes(error.phase)) result.phase = error.phase;
  if (['network', 'local', 'room', 'capacity', 'authorization', 'protocol', 'conflict', 'server'].includes(error.category)) result.category = error.category;
  if (Object.hasOwn(definitions, error.serverCode)) result.serverCode = error.serverCode;
  else if (error.serverCode) { result.serverCodeOmitted = true; result.serverCodeLength = String(error.serverCode).length; }
  for (const key of ['fatal', 'retryable']) if (typeof error[key] === 'boolean') result[key] = error[key];
  if (Number.isFinite(error.closeCode)) result.closeCode = error.closeCode;
  if (Number.isFinite(error.code)) result.nativeCode = error.code;
  if (error instanceof BridgeError) result.message = definitions[error.code]?.[0] ?? definitions.UnknownServerError[0];
  else result.messageOmitted = true;
  const frames = [];
  for (const line of String(error.stack || '').split('\n').slice(1, 6)) {
    const location = line.match(/((?:https?:\/\/|file:\/\/\/)[^\s()]+):(\d+):(\d+)/);
    if (!location) continue;
    try { const url = new URL(location[1]); frames.push({ file: url.origin + url.pathname, line: Number(location[2]), column: Number(location[3]) }); } catch (_) {}
  }
  if (frames.length) result.frames = frames;
  if (error.cause) result.cause = diagnosticError(error.cause, depth + 1);
  return result;
}
class BridgeConnection {
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
      bridge.lastHeartbeatTick = Date.now();
      bridge.timer = setInterval(() => {
        bridge.heartbeatDelayMs = Math.max(0, Date.now() - bridge.lastHeartbeatTick - (options.pingMs ?? 15000));
        bridge.lastHeartbeatTick = Date.now();
        if (Date.now() - bridge.lastReceived > (options.idleMs ?? 45000)) { bridge.fail(new BridgeError('HeartbeatTimeout')); return; }
        bridge.lastHeartbeatSent = Date.now();
        bridge.send({ type: 'Ping', requestId: '__heartbeat' }).catch(() => {});
      }, options.pingMs ?? 15000);
      return bridge;
    } catch (error) { bridge.fail(error); throw error; }
  }

  constructor(url, hello, options) {
    this.connectionId = crypto.randomUUID(); this.startedAt = Date.now(); this.lastSent = null; this.lastHeartbeatSent = null; this.lastPong = null;
    this.heartbeatDelayMs = 0; this.pingMs = options.pingMs ?? 15000; this.idleMs = options.idleMs ?? 45000;
    this.onDiagnostic = options.onDiagnostic;
    const endpoint = new URL(url); this.endpoint = endpoint.origin + endpoint.pathname; this.role = endpoint.pathname.startsWith('/server/') ? 'host' : 'client';
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
    this.ws.addEventListener('error', event => {
      this.diagnose('websocket.error', event.error, { browserErrorDetailsAvailable: !!event.error, networkDetails: 'Browser WebSocket API does not expose HTTP upgrade status, TLS or DNS failure details.' });
      this.receiveChain.then(() => {
        if (!this.failure && !this.localClose)
          this.fail(new BridgeError(this.phase === 'session' ? 'ConnectionLost' : 'ConnectionFailed', { phase: this.phase }));
      });
    });
    this.ws.addEventListener('close', event => {
      this.receiveChain.finally(() => {
        const knownReason = Object.hasOwn(definitions, event.reason) || ['Client closing', 'Closed'].includes(event.reason);
        this.diagnose('websocket.closed', this.failure, { closeCode: event.code, closeReason: !event.reason ? '' : knownReason ? event.reason : '[redacted: non-protocol close reason]', closeReasonLength: event.reason?.length ?? 0, wasClean: event.wasClean });
        if (!this.failure) {
          const serverReason = !this.localClose && event.code === 1008 && event.reason;
          const code = serverReason || (this.localClose ? 'ClientClosed' : this.phase === 'session' ? 'ConnectionLost' : 'ConnectionFailed');
          this.fail(new BridgeError(code, { phase: this.phase, closeCode: event.code, server: !!serverReason }), !this.localClose);
        }
        this.resolveClosed({ code: event.code, reason: event.reason, error: this.failure?.code === 'ClientClosed' ? null : this.failure });
      });
    });
  }

  diagnose(event, error, details = {}) {
    try {
      const at = Date.now();
      const record = { event, connectionId: this.connectionId, timestamp: new Date(at).toISOString(), endpoint: this.endpoint, role: this.role, phase: this.phase,
        lifetimeMs: Math.max(0, at - this.startedAt), readyState: this.ws.readyState, bufferedAmount: this.ws.bufferedAmount,
        lastReceivedAgoMs: Math.max(0, at - this.lastReceived), lastSentAgoMs: this.lastSent === null ? null : Math.max(0, at - this.lastSent),
        lastHeartbeatSentAgoMs: this.lastHeartbeatSent === null ? null : Math.max(0, at - this.lastHeartbeatSent), lastPongAgoMs: this.lastPong === null ? null : Math.max(0, at - this.lastPong),
        heartbeatDelayMs: this.heartbeatDelayMs, pingMs: this.pingMs, idleMs: this.idleMs,
        pendingSends: this.pendingSends, pendingBytes: this.pendingBytes, pendingReceiveBytes: this.pendingReceiveBytes,
        sendSequence: String(this.sendSequence), receiveSequence: String(this.receiveSequence),
        visibility: globalThis.document?.visibilityState ?? null, focused: globalThis.document?.hasFocus?.() ?? null, online: globalThis.navigator?.onLine ?? null,
        localClose: !!this.localClose, error: diagnosticError(error), ...details };
      if (this.onDiagnostic) this.onDiagnostic(record);
      else console.warn('[BookAgent WS]', record);
    } catch (_) {}
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
    if (message.type === 'Pong' && message.requestId === '__heartbeat') { this.lastPong = Date.now(); return; }
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
    else if (error) { this.diagnose('server.error', error); this.emitError(error); }
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
      this.lastSent = Date.now();
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
    this.diagnose('connection.failed', error);
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

return {BridgeError,BridgeConnection,randomToken,issueClientToken,contractHash,diagnosticError};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=RoomBridgeSDK;
