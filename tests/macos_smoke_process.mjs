// Narrow streaming process capture for native shell acceptance, not a test
// framework. Output and waits are bounded; cleanup also handles exited leaders.
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export class CapturedProcess {
  constructor(command, cwd, env) {
    this.process = spawn(command[0], command.slice(1), {cwd, env, detached: process.platform !== 'win32', windowsHide: true});
    this.output = {stdout: '', stderr: ''}; this.lines = []; this.closed = new Set(); this.size = 0;
    this.failure = null; this.exited = false;
    this.finished = new Promise(resolve => {
      this.process.on('error', error => {this.failure = error; this.exited = true; resolve();});
      this.process.on('close', () => resolve());
    });
    this.process.on('exit', () => {this.exited = true;});
    for (const name of ['stdout', 'stderr']) {
      const stream = this.process[name], decoder = new StringDecoder('utf8'); let pending = '';
      stream.on('data', bytes => {
        this.size += bytes.length;
        if (this.size > 32 * 1024 * 1024) {this.failure = new Error('native smoke output exceeded 32 MiB'); this.signal('SIGKILL'); return;}
        const text = decoder.write(bytes); this.output[name] += text; pending += text;
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {this.lines.push([name, pending.slice(0, end + 1)]); pending = pending.slice(end + 1);}
      });
      stream.on('end', () => {const tail = decoder.end(); this.output[name] += tail; pending += tail; if (pending) this.lines.push([name, pending]); this.closed.add(name);});
    }
  }
  async waitForOutput(matcher, timeout) {
    if (!(timeout > 0)) throw new Error('output timeout must be positive');
    const deadline = performance.now() + timeout * 1000;
    let drainDeadline = Infinity;
    while (performance.now() < Math.min(deadline, drainDeadline)) {
      if (this.failure) throw this.failure;
      while (this.lines.length) {const [name, line] = this.lines.shift(); const value = matcher(name, line); if (value !== null && value !== undefined) return value;}
      if (this.closed.size === 2) return null;
      if (this.exited && drainDeadline === Infinity) drainDeadline = Math.min(deadline, performance.now() + 1000);
      await delay(5);
    }
    return null;
  }
  groupExists() {
    if (!this.process.pid) return false;
    if (process.platform === 'win32') return !this.exited;
    try {process.kill(-this.process.pid, 0); return true;} catch (error) {if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error;}
  }
  signal(value) {
    if (!this.process.pid) return true;
    try {
      if (process.platform === 'win32') {
        if (this.exited) return true;
        const result = spawnSync(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(this.process.pid), '/T', '/F'], {timeout: 10000, windowsHide: true}); return result.status === 0;
      }
      process.kill(-this.process.pid, value); return true;
    } catch (error) {if (error.code === 'ESRCH') return true; if (error.code === 'EPERM') return false; throw error;}
  }
  async waitForExit(timeout) {
    const deadline = performance.now() + timeout * 1000;
    while (!this.exited && performance.now() < deadline) await delay(5);
    return this.exited;
  }
  async terminate(terminateTimeout = 5, killTimeout = 5) {
    // Darwin can refuse a signal while the process is already exiting. A
    // refusal is still failure unless the actual owned group and child vanish
    // within the cleanup deadline; never disguise a live permission failure.
    const awaitClean = async timeout => {
      const deadline = performance.now() + timeout * 1000;
      while ((this.groupExists() || !this.exited) && performance.now() < deadline) await delay(5);
      const clean = !this.groupExists() && this.exited;
      if (clean) await this.finished;
      return clean;
    };
    if (this.groupExists() && !this.signal('SIGTERM')) return awaitClean(terminateTimeout);
    const deadline = performance.now() + terminateTimeout * 1000;
    while (this.groupExists() && performance.now() < deadline) await delay(5);
    if (this.groupExists() && !this.signal('SIGKILL')) return awaitClean(killTimeout);
    return awaitClean(killTimeout);
  }
}
