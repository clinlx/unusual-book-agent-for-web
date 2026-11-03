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

export class BridgeError extends Error {
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
