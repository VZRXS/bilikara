// Pinned JS lifecycle adaptation only. Embedded DSP/WASM is unchanged.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const revision = '57b93f4e9206a089a45387eaa39bdc9f310d3308';
const replacements = [
  [
    "var SignalsmithStretch = (() => {",
    "var SignalsmithStretch = (() => {\n  let compiledWasm;"
  ],
  [
    "getBinaryPromise(binaryFile).then(binary=>WebAssembly.instantiate(binary,imports))",
    "(compiledWasm??=getBinaryPromise(binaryFile).then(binary=>WebAssembly.compile(binary))).then(module=>WebAssembly.instantiate(module,imports)).then(instance=>({instance}))"
  ],
  [
    "let pendingMessages = [];",
    "let pendingMessages = [];\n            const destroy = () => {\n                this.destroyed = true;\n                this.wasmReady = false;\n                this.wasmModule = null;\n                this.audioBuffers = this.buffersIn = this.buffersOut = [];\n                pendingMessages = [];\n                this.port.onmessage = null;\n                this.port.close();\n            };"
  ],
  [
    "this.port.onmessage = event => pendingMessages.push(event);",
    "this.port.onmessage = event => {\n                if (event.data[1] === 'destroy') destroy();\n                else pendingMessages.push(event);\n            };"
  ],
  [
    "Module().then(wasmModule => {",
    "Module().then(wasmModule => {\n                if (this.destroyed) return;"
  ],
  [
    "let data = event.data;\n\t\t\t\t\tlet messageId",
    "if (event.data[1] === 'destroy') { destroy(); return; }\n                    let data = event.data;\n                    let messageId"
  ],
  [
    "pendingMessages = null;\n\t\t\t});",
    "pendingMessages = null;\n            }).catch(() => {\n                if (!this.destroyed) this.port.postMessage(['error', 'wasm-init']);\n                destroy();\n            });"
  ],
  [
    "process(inputList, outputList, parameters) {",
    "process(inputList, outputList, parameters) {\n            if (this.destroyed) return false;"
  ],
  [
    "\n\t\t\t\tconfigure();",
    "\n\t\t\t\tthis.configure();"
  ],
  [
    "options.numberOfOutputs ? options.outputChannelCount[0] : 2",
    "options.outputChannelCount?.[0] || 2"
  ],
  [
    "async function(audioContext, options)",
    "async function(audioContext, options, signal)"
  ],
  [
    "// messages with Promise responses",
    "if (signal?.aborted) { audioNode.port.postMessage([null, 'destroy']); audioNode.port.close(); throw new Error('Signalsmith cancelled'); }\n        // messages with Promise responses"
  ],
  [
    "let requestMap = {};",
    "let requestMap = {};\n        let destroyed = false;\n        const dispose = (reason = new Error('Signalsmith disposed')) => {\n            if (destroyed) return;\n            destroyed = true;\n            audioNode.disconnect();\n            audioNode.port.postMessage([null, 'destroy']);\n            audioNode.port.close();\n            audioNode.port.onmessage = null;\n            audioNode.removeEventListener('processorerror', onError);\n            signal?.removeEventListener('abort', onAbort);\n            Object.values(requestMap).forEach(request => request.reject(reason));\n            requestMap = {};\n        };\n        const onError = () => dispose(new Error('Signalsmith processorerror'));\n        const onAbort = () => dispose(new Error('Signalsmith cancelled'));\n        signal?.addEventListener('abort', onAbort, {once: true});\n        audioNode.addEventListener('processorerror', onError);\n        audioNode.destroy = dispose;\n        const response = (id, resolve, reject) => {\n            const timer = setTimeout(() => dispose(new Error('Signalsmith response timeout')), 8000);\n            requestMap[id] = {\n                resolve: value => { clearTimeout(timer); resolve(value); },\n                reject: error => { clearTimeout(timer); reject(error); }\n            };\n        };"
  ],
  [
    "return new Promise(resolve => {\n\t\t\t\trequestMap[id] = resolve;",
    "return new Promise((resolve, reject) => {\n                if (destroyed) { reject(new Error('Signalsmith disposed')); return; }\n                response(id, resolve, reject);"
  ],
  [
    "let id = data[0], value = data[1];",
    "let id = data[0], value = data[1];\n            if (id === 'error') { dispose(new Error(value)); return; }"
  ],
  [
    "requestMap[id](value);",
    "requestMap[id].resolve(value);"
  ],
  [
    "return new Promise(resolve => {\n\t\t\trequestMap['ready'] = remoteMethodKeys => {",
    "return new Promise((resolve, reject) => {\n            response('ready', remoteMethodKeys => {"
  ],
  [
    "resolve(audioNode);\n\t\t\t}\n\t\t});",
    "resolve(audioNode);\n            }, reject);\n        });"
  ]
];
export function adapt(source) {
  // Local source files may have native CRLF line endings. Match the existing
  // universal-newline rebuild contract before checking each pinned marker.
  source = source.replace(/\r\n|\r/g, '\n');
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error(`Unexpected upstream source at ${JSON.stringify(before.slice(0, 70))}`);
    source = source.replace(before, () => after);
  }
  source = source.split(/\r\n|\n|\r/).map(line => line.trimEnd()).join('\n').replace(/\n$/, '') + '\n';
  return `// Signalsmith Stretch Web 1.3.2, ${revision}; MIT. See README.md.\n${source}`;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/vendor_signalsmith.mjs /path/to/SignalsmithStretch.mjs');
  const output = fileURLToPath(new URL('../static/vendor/signalsmith-stretch/SignalsmithStretch.js', import.meta.url));
  const result = adapt(readFileSync(process.argv[2], 'utf8'));
  mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, result, 'utf8');
}
