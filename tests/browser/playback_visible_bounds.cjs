// Read the real browser's clipping/translation, rather than the fixed layout canvas.
module.exports = function visibleBounds(node) {
  const rect=node.getBoundingClientRect(),clip=getComputedStyle(node).clipPath;
  if(clip==='none')return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
  if(!clip.startsWith('inset('))throw Error('Unsupported playback clipping: '+clip);
  const values=clip.slice(6).split('round')[0].replace(/\)$/u,'').trim().split(/\s+/u).map(Number.parseFloat);
  const [top,right=top,bottom=top,left=right]=values;
  if(values.some(value=>!Number.isFinite(value)))throw Error('Invalid browser clipping: '+clip);
  return {x:rect.x+left,y:rect.y+top,width:rect.width-left-right,height:rect.height-top-bottom};
};
