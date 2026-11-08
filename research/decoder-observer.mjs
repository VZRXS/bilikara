// Narrow CDP facts only: never retain media URLs, player logs or headers.
export async function observeDecoders(page) {
  const facts={status:'NOT AVAILABLE',players:{}};
  if(page.context().browser().browserType().name()!=='chromium')return facts;
  const session=await page.context().newCDPSession(page);
  const admitted=new Set(['kVideoDecoderName','kAudioDecoderName','kIsPlatformVideoDecoder','kIsPlatformAudioDecoder']);
  session.on('Media.playerPropertiesChanged',({playerId,properties})=>{
    if(!Object.hasOwn(facts.players,playerId)&&Object.keys(facts.players).length>=16)return;
    for(const property of properties)if(admitted.has(property.name)) {
      facts.players[playerId]??={};facts.players[playerId][property.name]=String(property.value).slice(0,128);
    }
  });
  await session.send('Media.enable');facts.status='CDP-MEDIA-OBSERVED';return facts;
}
