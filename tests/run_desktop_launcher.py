#!/usr/bin/env python3
"""Linux Tauri/WebView launcher regression, using isolated homes and Xvfb.

Both default Python and opt-in Rust launcher execute; no UI/HTTP implementation
is mocked. The offline proxy rejects every external request. Close uses the WM
protocol, and process exit/listener closure are barriers, not fixed sleep proof.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parents[1]

def until(test, seconds=40):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        value=test()
        if value: return value
        time.sleep(.1)
    raise AssertionError("Desktop launcher condition timed out")

def main():
    output=Path(sys.argv[1]).resolve();output.mkdir(parents=True,exist_ok=True)
    class Reject(BaseHTTPRequestHandler):
        def log_message(self,*_):pass
        def do_CONNECT(self):self.send_error(503)
        do_GET=do_CONNECT
        do_POST=do_CONNECT
    with tempfile.TemporaryDirectory(prefix="desktop-launcher-") as temp,ThreadingHTTPServer(("127.0.0.1",0),Reject) as proxy:
        threading.Thread(target=proxy.serve_forever,daemon=True).start()
        display=f":{90+os.getpid()%1000}"
        xvfb=subprocess.Popen(["Xvfb",display,"-screen","0","1440x1000x24","-nolisten","tcp"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        wm=None
        try:
            until(lambda:Path(f"/tmp/.X11-unix/X{display[1:]}").exists())
            env=dict(os.environ,DISPLAY=display,WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS="1",XDG_CONFIG_HOME=str(Path(temp)/"config"),XDG_CACHE_HOME=str(Path(temp)/"cache"))
            for key in ["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","http_proxy","https_proxy","all_proxy"]:env[key]=f"http://127.0.0.1:{proxy.server_port}"
            env.update(NO_PROXY="127.0.0.1,localhost",no_proxy="127.0.0.1,localhost")
            wm=subprocess.Popen(["openbox"],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            results=[]
            for native in [False,True]:
                name="rust" if native else "default"
                home=Path(temp)/name;home.mkdir()
                log=output/f"{name}-startup.log"
                env.update(BILIKARA_HOME=str(home/"python-home"),BILIKARA_DESKTOP_STARTUP_LOG=str(log),BILIKARA_REQUIRE_RUST_LIB="1")
                if native:env["BILIKARA_DESKTOP_RUST_PREVIEW_DIR"]=str(home/"preview")
                else:env.pop("BILIKARA_DESKTOP_RUST_PREVIEW_DIR",None)
                with open(output/f"{name}-stdout.log","w") as out,open(output/f"{name}-stderr.log","w") as err:
                    app=subprocess.Popen([str(ROOT/"src-tauri/target/debug/bilikara")],cwd=ROOT,env=env,stdout=out,stderr=err)
                    child=None
                    try:
                        def ready():
                            assert app.poll() is None,"Desktop exited before readiness"
                            text=log.read_text() if log.exists() else ""
                            return text if "event=window_navigate status=ok" in text else None
                        text=until(ready,100)
                        child=int(re.findall(r"child_pid=(\d+)",text)[-1])
                        command=Path(f"/proc/{child}/cmdline").read_bytes().replace(b"\0",b" ").decode()
                        assert ("bilikara-desktop-host" in command) == native
                        assert ("python" in command) != native
                        origin=re.findall(r"address=(http[^ ]+|127\.0\.0\.1:\d+)",text)[-1].strip()
                        if not origin.startswith("http"):origin="http://"+origin
                        opener=build_opener(ProxyHandler({}))
                        with opener.open(origin+"/api/health",timeout=5) as response:
                            assert response.status==200
                        window=until(lambda:subprocess.run(["xdotool","search","--onlyvisible","--pid",str(app.pid)],env=env,capture_output=True,text=True).stdout.strip()).splitlines()[-1]
                        subprocess.run(["xdotool","windowactivate","--sync",window],env=env,check=True)
                        # Wait for WebKit to paint using the real window's image;
                        # exit/listener checks below do not use this presentation delay.
                        time.sleep(2)
                        subprocess.run(["scrot","-a","0,180,1440,820",str(output/f"{name}-webview.png")],env=env,check=True)
                        subprocess.run(["xdotool","key","alt+F4"],env=env,check=True)
                        assert app.wait(timeout=40)==0
                        until(lambda:not Path(f"/proc/{child}").exists())
                        try:opener.open(origin+"/api/health",timeout=1)
                        except OSError:pass
                        else:raise AssertionError("Listener survived window close")
                        until(lambda:"stage=backend_exited_gracefully" in log.read_text())
                        results.append({"backend":name,"realTauri":True,"ready":True,"windowClose":True,"childReaped":True,"listenerClosed":True})
                    finally:
                        if app.poll() is None:app.terminate();app.wait(timeout=40)
                        if child and Path(f"/proc/{child}").exists():os.kill(child,15)
            (output/"launcher-summary.json").write_text(json.dumps(results,indent=2))
            print("Default Python and opt-in Rust Tauri launcher/window-close checks passed.")
        finally:
            if wm:wm.terminate();wm.wait()
            xvfb.terminate();xvfb.wait();proxy.shutdown()
    return 0

if __name__=="__main__":raise SystemExit(main())
