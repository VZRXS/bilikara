// Evaluate the actual public transport in an offline, non-browser fixture.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import {root} from './desktop_construction_support.mjs';
export function outputTransportFixture(){
  const sandbox={fetch:async()=>{throw Error('Unexpected network');},location:{hash:'#room=fixture',origin:'https://example.test',href:'https://example.test/#room=fixture'},
    localStorage:{getItem:()=>'',setItem:()=>{},removeItem:()=>{}},URLSearchParams,URL,Response,Headers,queueMicrotask,
    setTimeout:()=>1,clearTimeout:()=>{},clearInterval:()=>{},navigator:{onLine:true},addEventListener:()=>{},dispatchEvent:()=>{},Event:class{},
    crypto:webcrypto,TextEncoder,btoa,document:{addEventListener:()=>{},documentElement:{dataset:{}}}};
  runInNewContext(readFileSync(path.join(root,'static/internet-remote-transport.js'),'utf8'),sandbox);
  const source=readFileSync(path.join(root,'static/remote-transport-client.js'),'utf8').replace('})(globalThis);','globalThis.outputTest={state,localState,fetchInternet,stub:fn=>{request=fn;}}; })(globalThis);');
  runInNewContext(source,sandbox);
  return sandbox.outputTest;
}
