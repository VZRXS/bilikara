import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../static/song-detail.js',import.meta.url),'utf8');
test('canonical Bilibili video handoff validates BV IDs and optional positive multipart page',()=>{
  const context=vm.createContext({window:{},URL});vm.runInContext(source,context);
  const canonical=context.window.BilikaraSongDetail.canonicalBilibiliUrl;
  const base='https://www.bilibili.com/video/BV1yyjzzCEQn';
  assert.equal(canonical({bvid:'BV1yyjzzCEQn',page:2}),base+'?p=2');
  assert.equal(canonical({resolved_url:base+'?p=3&spm_id_from=333'}),base+'?p=3');
  for(const page of [0,-1,1.5,'02','x',true,2147483648])assert.equal(canonical({bvid:'BV1yyjzzCEQn',page}),base);
  for(const item of [{bvid:'BV1'},{bvid:'BV<script>'},{url:'https://example.test/video/BV1yyjzzCEQn'},{url:'https://youtube.com/watch?v=abcdef'}])assert.equal(canonical(item),'');
  assert.equal(canonical({bvid:'BV1yyjzzCEQn'}),base);
});
