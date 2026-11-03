import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { BridgeConnection, BridgeError, randomToken, issueClientToken, contractHash } from './room-bridge.mjs';

const base = process.env.BRIDGE_TEST_URL ?? 'ws://127.0.0.1:18766';
const room = 'errors_' + randomToken().slice(0, 12);
const root = randomToken(), epoch = randomToken();
const token = await issueClientToken(root, room, epoch, 'alice');
const manifest = { hostFunctions: [], clientFunctions: [] }, hash = await contractHash(manifest);
const peers = [];
async function rejected(code, operation) {
  await assert.rejects(operation, error => {
    assert.equal(error.name, 'BridgeError'); assert.equal(error.code, code);
    assert.equal(typeof error.retryable, 'boolean'); assert.ok(error.message.length > 0);
    return true;
  });
}
try {
  await rejected('RoomNotFound', () => BridgeConnection.connect(base, 'client', room, { token, contractHash: hash }));
  const host = await BridgeConnection.connect(base, 'server', room, { token: root, epoch, manifest, players: [{ id: 'alice', token }] }); peers.push(host);
  await rejected('Unauthorized', () => BridgeConnection.connect(base, 'client', room, { token: randomToken(), contractHash: hash }));
  await rejected('ContractMismatch', () => BridgeConnection.connect(base, 'client', room, { token, contractHash: 'incorrect' }));
  await rejected('ProtocolVersionMismatch', () => BridgeConnection.connect(base, 'client', room, { token, contractHash: hash, protocolVersion: 99 }));
  const errors = [];
  const player = await BridgeConnection.connect(base, 'client', room, { token, contractHash: hash }); peers.push(player);
  player.onError(error => errors.push(error));
  await rejected('AlreadyConnected', () => BridgeConnection.connect(base, 'client', room, { token, contractHash: hash }));
  await rejected('RevisionConflict', () => host.request({ type: 'ReplaceAuthorization', expectedRevision: 99, players: [] }, 'AuthorizationReplaced'));
  await host.send({ type: 'Ping', requestId: 'still-alive' });
  assert.equal((await host.next('Pong')).requestId, 'still-alive');
  const blockedRead = player.next('Invoke').catch(error => error);
  await host.request({ type: 'ReplaceAuthorization', expectedRevision: 0, players: [] }, 'AuthorizationReplaced');
  assert.equal((await blockedRead).code, 'AuthorizationRevoked');
  assert.equal((await player.closed).error.code, 'AuthorizationRevoked');
  assert.equal(errors.length, 1); assert.equal(errors[0].code, 'AuthorizationRevoked');
  await host.request({ type: 'ReplaceAuthorization', expectedRevision: 1, players: [{ id: 'alice', token }] }, 'AuthorizationReplaced');
  const remaining = await BridgeConnection.connect(base, 'client', room, { token, contractHash: hash }); peers.push(remaining);
  host.close();
  assert.equal((await remaining.closed).error.code, 'HostDisconnected');
  const unknown = new BridgeError('<unexpected-server-code>', { server: true });
  assert.equal(unknown.code, 'UnknownServerError');
  assert.ok(!unknown.message.includes('<unexpected-server-code>'));
  console.log('PASS structured room/auth/contract/version/duplicate/control/revocation errors');
} finally { peers.forEach(peer => peer.close()); }

// Reserve then release a local port to exercise a real refused connection, not a mock.
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
await rejected('ConnectionFailed', () => BridgeConnection.connect(`ws://127.0.0.1:${port}`, 'client', 'missing', { token, contractHash: hash }, { timeoutMs: 1500 }));

// A TCP listener which never completes the HTTP upgrade exercises client connect timeout.
const sockets = new Set();
const blackhole = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => blackhole.listen(0, '127.0.0.1', resolve));
try {
  await rejected('ConnectTimeout', () => BridgeConnection.connect(`ws://127.0.0.1:${blackhole.address().port}`, 'client', 'missing', { token, contractHash: hash }, { timeoutMs: 100 }));
} finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => blackhole.close(resolve)); }
console.log('PASS connection refusal and timeout distinguishable without claiming TLS/Origin details');
