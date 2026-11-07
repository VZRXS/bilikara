import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';

export const r7Waiting = ['B1','C1','A1','B2','C2','A2'];
export function r7Item(id) {
  return {id, requester_name:id[0], queue_slot_type:'cycle',
    original_url:'https://example.invalid/' + id, resolved_url:'https://example.invalid/' + id,
    bvid:'BV1xx411c7mD', aid:1, cid:2, page:1, title:id, part_title:'P1',
    display_title:id, cover_url:'', embed_url:'', selected_pages:[1], selected_cids:[2],
    selected_durations:[120], selected_parts:['P1']};
}
export function writeR7Seed(directory) {
  const data=path.join(directory,'data');mkdirSync(data,{recursive:true});
  writeFileSync(path.join(data,'.bilikara-desktop-rust-preview'),'desktop-rust-preview-v1\n');
  writeFileSync(path.join(data,'native-library-defaults.json'),JSON.stringify({schema_version:1}));
  writeFileSync(path.join(data,'gatcha_uids.json'),JSON.stringify({schema_version:2,uids:[],profiles:{}}));
  writeFileSync(path.join(data,'host-state.json'),JSON.stringify({schema_version:1,state:{
    session_started_at:1,updated_at:1,session_played_file:'r7.json',session_users:['A','B','C'],
    current_item:r7Item('A0'),playlist:r7Waiting.map(r7Item),
  }}));
  return data;
}
