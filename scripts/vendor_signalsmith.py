"""Apply the small Web lifecycle fixes to the pinned upstream release (no WASM rebuild).

Usage: python scripts/vendor_signalsmith.py /path/to/upstream/SignalsmithStretch.mjs
"""
from pathlib import Path
import sys

REVISION = "57b93f4e9206a089a45387eaa39bdc9f310d3308"


def adapt(source: str) -> str:
    def replace(old: str, new: str) -> None:
        nonlocal source
        if source.count(old) != 1:
            raise ValueError(f"Unexpected upstream source at {old[:70]!r}")
        source = source.replace(old, new)

    # One compiled module per worklet realm; each processor still owns its memory.
    replace("var SignalsmithStretch = (() => {", "var SignalsmithStretch = (() => {\n  let compiledWasm;")
    replace("getBinaryPromise(binaryFile).then(binary=>WebAssembly.instantiate(binary,imports))",
            "(compiledWasm??=getBinaryPromise(binaryFile).then(binary=>WebAssembly.compile(binary)))"
            ".then(module=>WebAssembly.instantiate(module,imports)).then(instance=>({instance}))")
    # Upstream stop() feeds zeros but returns true forever. Destruction is distinct
    # from stop(), and also works before asynchronous WASM initialization finishes.
    replace("let pendingMessages = [];", """let pendingMessages = [];
            const destroy = () => {
                this.destroyed = true;
                this.wasmReady = false;
                this.wasmModule = null;
                this.audioBuffers = this.buffersIn = this.buffersOut = [];
                pendingMessages = [];
                this.port.onmessage = null;
                this.port.close();
            };""")
    replace("this.port.onmessage = event => pendingMessages.push(event);", """this.port.onmessage = event => {
                if (event.data[1] === 'destroy') destroy();
                else pendingMessages.push(event);
            };""")
    replace("Module().then(wasmModule => {", "Module().then(wasmModule => {\n                if (this.destroyed) return;")
    replace("let data = event.data;\n\t\t\t\t\tlet messageId", """if (event.data[1] === 'destroy') { destroy(); return; }
                    let data = event.data;
                    let messageId""")
    replace("pendingMessages = null;\n\t\t\t});", """pendingMessages = null;
            }).catch(() => {
                if (!this.destroyed) this.port.postMessage(['error', 'wasm-init']);
                destroy();
            });""")
    replace("process(inputList, outputList, parameters) {", "process(inputList, outputList, parameters) {\n            if (this.destroyed) return false;")
    replace("\n\t\t\t\tconfigure();", "\n\t\t\t\tthis.configure();")
    replace("options.numberOfOutputs ? options.outputChannelCount[0] : 2", "options.outputChannelCount?.[0] || 2")
    replace("async function(audioContext, options)", "async function(audioContext, options, signal)")
    replace("// messages with Promise responses", "if (signal?.aborted) { audioNode.port.postMessage([null, 'destroy']); audioNode.port.close(); throw new Error('Signalsmith cancelled'); }\n        // messages with Promise responses")
    # Every RPC and initial ready wait is bounded and rejected on processorerror.
    replace("let requestMap = {};", """let requestMap = {};
        let destroyed = false;
        const dispose = (reason = new Error('Signalsmith disposed')) => {
            if (destroyed) return;
            destroyed = true;
            audioNode.disconnect();
            audioNode.port.postMessage([null, 'destroy']);
            audioNode.port.close();
            audioNode.port.onmessage = null;
            audioNode.removeEventListener('processorerror', onError);
            signal?.removeEventListener('abort', onAbort);
            Object.values(requestMap).forEach(request => request.reject(reason));
            requestMap = {};
        };
        const onError = () => dispose(new Error('Signalsmith processorerror'));
        const onAbort = () => dispose(new Error('Signalsmith cancelled'));
        signal?.addEventListener('abort', onAbort, {once: true});
        audioNode.addEventListener('processorerror', onError);
        audioNode.destroy = dispose;
        const response = (id, resolve, reject) => {
            const timer = setTimeout(() => dispose(new Error('Signalsmith response timeout')), 8000);
            requestMap[id] = {
                resolve: value => { clearTimeout(timer); resolve(value); },
                reject: error => { clearTimeout(timer); reject(error); }
            };
        };""")
    replace("return new Promise(resolve => {\n\t\t\t\trequestMap[id] = resolve;", """return new Promise((resolve, reject) => {
                if (destroyed) { reject(new Error('Signalsmith disposed')); return; }
                response(id, resolve, reject);""")
    replace("let id = data[0], value = data[1];", "let id = data[0], value = data[1];\n            if (id === 'error') { dispose(new Error(value)); return; }")
    replace("requestMap[id](value);", "requestMap[id].resolve(value);")
    replace("return new Promise(resolve => {\n\t\t\trequestMap['ready'] = remoteMethodKeys => {", "return new Promise((resolve, reject) => {\n            response('ready', remoteMethodKeys => {")
    replace("resolve(audioNode);\n\t\t\t}\n\t\t});", "resolve(audioNode);\n            }, reject);\n        });")
    # Normalize upstream's whitespace-only lines for the repository diff gate.
    source = "\n".join(line.rstrip() for line in source.splitlines()) + "\n"
    return f"// Signalsmith Stretch Web 1.3.2, {REVISION}; MIT. See README.md.\n" + source


if __name__ == "__main__":
    output = Path(__file__).resolve().parents[1] / "static/vendor/signalsmith-stretch/SignalsmithStretch.js"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(adapt(Path(sys.argv[1]).read_text()), encoding="utf-8")
