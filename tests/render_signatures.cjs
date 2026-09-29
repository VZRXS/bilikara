'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const slice = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const host = fs.readFileSync('static/app.js', 'utf8');
const remote = fs.readFileSync('static/remote.js', 'utf8');
for (const [name, source, signature] of [
  ['Host', slice(host, 'function renderSignatureForData', 'function hasDownloadingItems'), 'renderSignatureForData'],
  ['Remote', slice(remote, 'const CACHE_VOLATILE_ITEM_KEYS', 'function playerStatusSignature'), 'renderSignatureForSnapshot'],
]) {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const sign = context[signature];
  const base = { state_epoch: 'session-a', revision: 10, state_revision: 10, updated_at: 10,
    playback_generation: 2, playback_program: { item_id: 'song' }, player_status: { current_time: 0 },
    current_item: { id: 'song', cache_status: 'downloading', cache_progress: 0 },
    playlist: [], player_settings: { volume_percent: 100 }, player_control_command: null,
  };
  const initial = sign(base);
  for (let i = 1; i <= 10; i++) {
    assert.equal(sign({ ...base, revision: 10 + i, state_revision: 10 + i, updated_at: 10 + i,
      player_status: { current_time: i } }), initial, `${name}: observation-only revision must not redraw workspace`);
  }
  for (const change of [
    { state_epoch: 'session-b' }, { playback_generation: 3 },
    { playback_program: { item_id: 'next' } }, { player_settings: { volume_percent: 50 } },
    { current_item: { ...base.current_item, cache_status: 'failed' } },
    { playlist: [{ id: 'next' }] }, { player_control_command: { command: 'seek', position: 20 } },
  ]) assert.notEqual(sign({ ...base, ...change }), initial, `${name}: meaningful change must still redraw`);
  const progress = { ...base, current_item: { ...base.current_item, cache_progress: 50 } };
  if (name === 'Remote') assert.equal(sign(progress), initial, 'Remote paints progress via its separate coalesced path');
  else assert.notEqual(sign(progress), initial, 'Host must still paint download progress');
}
console.log('Render signatures preserve visual changes and ignore transport-only revisions.');
