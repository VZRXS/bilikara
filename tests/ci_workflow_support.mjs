// Read real job definitions and their shared native composite steps.
import {readFileSync} from 'node:fs';
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
export function workflowJob(file, id, action) {
  const source = read(`.github/workflows/${file}.yml`);
  const marker = `\n  ${id}:\n`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${file}/${id}`);
  const job = marker + source.slice(start + marker.length).split(/\n  [a-z][\w-]*:\n/)[0];
  if (!action) return job;
  if (!job.includes(`uses: ./.github/actions/${action}`)) throw Error(`Missing native action ${action}`);
  const steps = read(`.github/actions/${action}/action.yml`).split('\n  steps:\n')[1];
  if (!steps) throw Error(`Missing composite steps ${action}`);
  return job + '\n' + steps.split('\n').map(line => '  ' + line).join('\n');
}
export const desktopChecks = workflowJob('ci', 'platforms', 'desktop-checks');
export const mobileChecks = workflowJob('ci', 'platforms', 'mobile-checks');
export const desktopPackages = workflowJob('bundle', 'packages', 'desktop-bundle');
export const mobilePackages = workflowJob('bundle', 'packages', 'mobile-bundle') + workflowJob('bundle', 'ios-adhoc');
export const desktopWorkflow = desktopChecks + desktopPackages;
export const mobileWorkflow = mobileChecks + mobilePackages;
