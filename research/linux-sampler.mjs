// One logical CPU = 100%. Process stat includes all threads; children counted once.
import {readFileSync,readdirSync} from 'node:fs';
export function processGroup(pid,result=[],seen=new Set()) {
  if(seen.has(pid))return result;seen.add(pid);
  try {
    const stat=readFileSync(`/proc/${pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
    const memory=readFileSync(`/proc/${pid}/smaps_rollup`,'utf8');
    result.push({pid,start:fields[19],ticks:Number(fields[11])+Number(fields[12]),threads:Number(fields[17]),
      pss:Number(memory.match(/^Pss:\s+(\d+)/m)?.[1]||0)*1024,rss:Number(memory.match(/^Rss:\s+(\d+)/m)?.[1]||0)*1024});
    for(const thread of readdirSync(`/proc/${pid}/task`)) {
      let children;try{children=readFileSync(`/proc/${pid}/task/${thread}/children`,'utf8').trim().split(/\s+/).filter(Boolean);}catch(error){if(['ENOENT','ESRCH'].includes(error.code))continue;throw error;}
      for(const child of children)processGroup(Number(child),result,seen);
    }
  }catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}
  return result;
}
export function sampler(roots,hz) {
  const previous=new Map();
  return ()=>Object.fromEntries(Object.entries(roots).map(([role,pid])=>{
    const rows=processGroup(pid);let ticks=0;
    for(const row of rows){const key=`${role}:${row.pid}:${row.start}`,old=previous.get(key);if(old!==undefined)ticks+=Math.max(0,row.ticks-old);previous.set(key,row.ticks);}
    return[role,{cpuSeconds:ticks/hz,pssBytes:rows.reduce((n,r)=>n+r.pss,0),rssBytes:rows.reduce((n,r)=>n+r.rss,0),processes:rows.length,threads:rows.reduce((n,r)=>n+r.threads,0)}];
  }));
}
export function summarize(samples,elapsed) {
  return Object.fromEntries(Object.keys(samples[0].roles).map(role=>[role,{
    cpuPercentOneCore:100*samples.reduce((sum,s)=>sum+s.roles[role].cpuSeconds,0)/elapsed,
    peakPssMiB:Math.max(...samples.map(s=>s.roles[role].pssBytes))/2**20,
    peakRssMiB:Math.max(...samples.map(s=>s.roles[role].rssBytes))/2**20,
  }]));
}
