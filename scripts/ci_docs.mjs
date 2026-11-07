// Cheap docs lane: inspect repository Markdown without native/browser setup.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const files = execFileSync('git', ['ls-files', '-z', '*.md', 'LICENSE'], {encoding: 'utf8'}).split('\0').filter(Boolean);
for (const file of files) {
  const text = new TextDecoder('utf-8', {fatal: true}).decode(readFileSync(file));
  if (/^(?:<<<<<<< |>>>>>>> |=======\r?$)/m.test(text)) throw Error(`Unresolved merge marker: ${file}`);
}
console.log(`Validated UTF-8 and merge markers in ${files.length} documentation files.`);
