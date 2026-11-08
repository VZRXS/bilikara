// Test-only clock calibration. Never infer a precise inter-process clock from
// Date.now(). Offset maps browser performance.now() into this Node process.
export async function calibrateMonotonic(page, count=8) {
  const samples=[];
  for(let i=0;i<count;i++) {
    const before=performance.now();
    const remote=await page.evaluate(()=>performance.now());
    const after=performance.now();
    samples.push({offsetMs:(before+after)/2-remote,uncertaintyMs:(after-before)/2,rttMs:after-before});
  }
  return samples.reduce((a,b)=>a.rttMs<b.rttMs?a:b);
}
