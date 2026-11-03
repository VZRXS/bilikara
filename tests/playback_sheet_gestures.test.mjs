import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
const scope={};
runInNewContext(readFileSync(new URL('../static/playback-sheet-gestures.js',import.meta.url),'utf8'),scope);
const {shouldExpand}=scope.BilikaraPlaybackSheetGestures;
test('sheet settles by position or a recent bounded flick, including reversals',()=>{
  assert.equal(shouldExpand(.2,0,500),false);
  assert.equal(shouldExpand(.8,0,500),true);
  assert.equal(shouldExpand(.3,800,500),true);
  assert.equal(shouldExpand(.7,-800,500),false);
  assert.equal(shouldExpand(0,-9000,500),false);
  assert.equal(shouldExpand(1,9000,500),true);
});
