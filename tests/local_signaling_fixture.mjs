// Narrow non-forwarding signaling fixture shared by real browser tests.
// Only offer/answer/candidate messages pass here; application data uses WebRTC.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import {root} from './desktop_construction_support.mjs';
const require = createRequire(import.meta.url);
const {wsServer} = require(path.join(root, 'node_modules/playwright-core/lib/utilsBundle.js'));
export function localSignaling(server, {counters, issueIce = () => null}) {
  const lanes = new Map();
  let failure;
  const wss = new wsServer({server, handleProtocols: () => 'bilikara-v1'});
  wss.on('connection', (socket, request) => {
    counters.websocketConnections++;
    const auth = String(request.headers['sec-websocket-protocol']).split(',').map(value => value.trim()).find(value => /^(host|remote)\./u.test(value));
    assert.ok(auth);
    const [role, , peerId] = auth.split('.');
    (counters.roles ||= []).push(role); lanes.set(role, socket); socket.peerId = peerId;
    const ice = issueIce(role, peerId);
    if (ice) { socket.send(JSON.stringify({type:'ice.config', payload:ice})); counters.iceConfigs++; }
    const host = lanes.get('host'), remote = lanes.get('remote');
    if (host?.readyState === 1 && remote?.readyState === 1) host.send(JSON.stringify({type:'peer.join', peer_id:remote.peerId}));
    socket.on('message', wire => {
      counters.signals++;
      try {
        const message = JSON.parse(wire);
        const target = lanes.get(role === 'host' ? 'remote' : 'host');
        if (message.type === 'leave' && role === 'host') {
          // Existing Host peer teardown evicts signaling; this is lifecycle
          // control, not an application-data relay.
          if (target?.peerId === message.to) target.close(1000,'Fixture peer released');
          return;
        }
        assert.ok(['offer','answer','candidate'].includes(message.type), 'fixture never relays application commands');
        if (target?.readyState === 1) target.send(JSON.stringify({type:message.type, from:peerId, payload:message.payload}));
      } catch(error) {
        // Throwing inside ws's message callback strands its receiver. Preserve
        // the failure for the test while still retiring the real socket.
        failure ||= error; socket.close(1008,'Invalid fixture signaling');
      }
    });
    socket.on('close', () => { if (lanes.get(role) === socket) lanes.delete(role); });
  });
  return {lanes, async close() {
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    if(failure)throw failure;
  }};
}
