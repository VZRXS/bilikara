import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
const {flatten,neighbor,descendant,intent,completed}=createRequire(import.meta.url)('../static/subtab-swipe.js');

test('recursive sub-tab leaves stay in their own scope at arbitrary depth',()=>{
  const tree=[{id:'request',children:[{id:'quick'},{id:'search',children:[{id:'shared'},{id:'local'}]},
    {id:'deep',children:[{id:'nested',children:[{id:'leaf'}]},{id:'disabled',disabled:true}]},
    {id:'hidden',hidden:true,children:[{id:'leaf'}]},{id:'random'}]}];
  assert.deepEqual(flatten(tree).map(n=>n.key),['request.quick','request.search.shared','request.search.local','request.deep.nested.leaf','request.random']);
  assert.equal(neighbor(tree,'request.search.local',1).key,'request.deep.nested.leaf');
  assert.equal(neighbor(tree,'request.deep.nested.leaf',-1).key,'request.search.local');
  assert.equal(neighbor(tree,'request.random',1),null);
  assert.equal(neighbor(tree,'request.quick',-1),null);
  assert.equal(neighbor(tree,'queue.history',1),null);
  assert.equal(descendant(tree,'request.search','request.search.local').key,'request.search.local','Direct parent taps may remember a child');
  assert.equal(neighbor(tree,'request.quick',1).key,'request.search.shared','Swipes cannot skip to a remembered nonadjacent child');
  tree[0].children[1].children[0].disabled=true;
  assert.equal(neighbor(tree,'request.quick',1).key,'request.search.local');
  assert.equal(descendant(tree,'request.search','request.search.shared').key,'request.search.local');
  assert.deepEqual(flatten([{id:'empty',children:[]}]),[]);
  assert.equal(neighbor([{id:'only'}],'only',1),null);
});
test('axis ownership and calibrated distance/flick decisions reject vertical and undecided motion',()=>{
  assert.equal(intent(13,6),'x');assert.equal(intent(12,10),'');assert.equal(intent(8,12),'y');
  assert.equal(intent(80,20,'y'),'y');assert.equal(intent(3,30,'x'),'x');
  assert.equal(completed(70,300,500,'x'),true);assert.equal(completed(70,800,500,'x'),false);
  assert.equal(completed(96,800,500,'x'),true);assert.equal(completed(-40,800,60,'x'),true);
  assert.equal(completed(31,800,10,'x'),false);assert.equal(completed(120,800,50,'y'),false);
  assert.equal(completed(120,800,50,''),false);
});
