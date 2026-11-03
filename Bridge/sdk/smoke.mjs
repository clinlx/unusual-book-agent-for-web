import assert from 'node:assert/strict';
import { randomToken, issueClientToken, contractHash, BridgeConnection } from './room-bridge.mjs';

const base = process.env.BRIDGE_TEST_URL ?? 'ws://127.0.0.1:18766';
const room = 'js_' + randomToken().slice(0, 16);
const token = randomToken(), epoch = randomToken();
const aToken = await issueClientToken(token, room, epoch, 'alice');
const bToken = await issueClientToken(token, room, epoch, 'bob');
const manifest = { hostFunctions: [{ id: 1, schema: 'text-v1' }], clientFunctions: [{ id: 2, schema: 'text-v1' }] };
const hash = await contractHash(manifest);
const peers = [];
try {
  const host = await BridgeConnection.connect(base, 'server', room, { token, epoch, manifest, players: [{ id: 'alice', token: aToken }, { id: 'bob', token: bToken }] });
  peers.push(host);
  assert.equal(host.ready.contractHash, hash);
  const alice = await BridgeConnection.connect(base, 'client', room, { token: aToken, contractHash: hash }); peers.push(alice);
  const bob = await BridgeConnection.connect(base, 'client', room, { token: bToken, contractHash: hash }); peers.push(bob);
  await alice.invoke(1, { text: '你好，Web Crypto', client_id: 'forged' }, 'js-call');
  const call = await host.next('ClientInvoke');
  assert.equal(call.clientId, 'alice'); assert.equal(call.payload.text, '你好，Web Crypto');
  await host.invokeClient('alice', 2, call.payload, call.requestId);
  const reply = await alice.next('Invoke');
  assert.equal(reply.clientId, undefined); assert.deepEqual(reply.payload, call.payload);
  await bob.send({ type: 'Ping', requestId: 'unicast-check' });
  assert.equal((await bob.next()).type, 'Pong');
  await host.replaceAuthorization([{ id: 'alice', token: aToken }], 0, 'replace');
  assert.equal((await host.next('AuthorizationReplaced')).revision, 1);
  assert.equal((await bob.next('Disconnected')).code, 'AuthorizationRevoked');
  console.log('PASS Node/browser SDK ↔ C# HMAC, contract hash, HKDF, AES-GCM, Unicode relay, unicast, revocation');
} finally { for (const peer of peers) peer.close(); }
