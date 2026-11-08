// Linux virtual-output lab only. Does not configure the machine's audio server.
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,existsSync,openSync,closeSync,rmSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';

export async function virtualOutputs(sdk,directory) {
  sdk=path.resolve(sdk);directory=path.resolve(directory);
  mkdirSync(directory,{recursive:true,mode:0o700});
  let runtime=path.join(directory,'pa');
  if(Buffer.byteLength(path.join(runtime,'native'))>=104) {
    assert.ok(process.env.TMPDIR,'Set a short HDD TMPDIR for the Unix audio socket');
    runtime=mkdtempSync(path.join(process.env.TMPDIR,'rounda-pa-'));
  } else mkdirSync(runtime,{mode:0o700});
  assert.ok(Buffer.byteLength(path.join(runtime,'native'))<104,'Choose a shorter external evidence path for the Unix audio socket');
  const environment={...process.env,CUDA_VISIBLE_DEVICES:'',LIBGL_ALWAYS_SOFTWARE:'1',
    LD_LIBRARY_PATH:[path.join(sdk,'usr/lib/x86_64-linux-gnu'),path.join(sdk,'usr/lib/x86_64-linux-gnu/pulseaudio'),path.join(sdk,'usr/lib/pulse-15.99.1+dfsg1/modules'),process.env.LD_LIBRARY_PATH||''].filter(Boolean).join(':'),
    GST_PLUGIN_PATH_1_0:path.join(sdk,'usr/lib/x86_64-linux-gnu/gstreamer-1.0'),
    GST_REGISTRY_1_0:path.join(directory,'gst-registry.bin'),
    PULSE_RUNTIME_PATH:runtime,PULSE_STATE_PATH:runtime,XDG_CONFIG_HOME:path.join(runtime,'config'),PULSE_COOKIE:path.join(runtime,'cookie'),
    PULSE_SERVER:'unix:'+path.join(runtime,'native'),PULSE_SINK:'rounda',
  };
  const configuration=path.join(directory,'pulse.pa');
  writeFileSync(configuration,`load-module module-native-protocol-unix socket=${runtime}/native auth-anonymous=1\nload-module module-null-sink sink_name=rounda rate=48000 channels=2\nset-default-sink rounda\n`);
  const pulseLog=openSync(path.join(directory,'pulse.log'),'wx');
  const pulse=spawn(path.join(sdk,'usr/bin/pulseaudio'),['--daemonize=no','--use-pid-file=no','--exit-idle-time=-1','--disable-shm=yes',
    '--dl-search-path='+path.join(sdk,'usr/lib/pulse-15.99.1+dfsg1/modules'),'-n','-F',configuration],{env:environment,stdio:['ignore',pulseLog,pulseLog]});
  closeSync(pulseLog);
  let xvfb;
  let closing;
  const close=()=>closing??=(async()=>{
    for(const child of [xvfb,pulse])if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
    await Promise.all([xvfb,pulse].filter(Boolean).map(child=>child.exitCode!==null||child.signalCode!==null?Promise.resolve():new Promise(resolve=>child.once('exit',resolve))));
    // Generated lab authentication/runtime state is not useful evidence.
    rmSync(runtime,{recursive:true,force:true});
  })();
  try {
    for(let i=0;i<100&&!existsSync(path.join(runtime,'native'));i++){assert.equal(pulse.exitCode,null,'virtual PulseAudio exited; inspect pulse.log');await delay(30);}
    assert.ok(existsSync(path.join(runtime,'native')),'virtual PulseAudio readiness');
    xvfb=spawn('/usr/bin/Xvfb',['-displayfd','1','-screen','0','1920x1080x24','-nolisten','tcp'],{env:environment,stdio:['ignore','pipe',openSync(path.join(directory,'xvfb.log'),'wx')]});
    const display=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Xvfb timeout')),5000);xvfb.stdout.on('data',data=>{text+=data;if(text.includes('\n')){clearTimeout(timer);resolve(text.trim());}});xvfb.once('error',reject);});
    environment.DISPLAY=':'+display;
    return {environment,pulse,xvfb,close};
  }catch(error){await close();throw error;}
}
