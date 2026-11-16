import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const source = fs.readFileSync(new URL('./native-reader-source.txt', import.meta.url), 'utf8');
const provenance = JSON.parse(fs.readFileSync(new URL('../SOURCES.json', import.meta.url)));
export function readWithNativeDecoder(text) {
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  if (hash !== provenance.nativeSnapshot.sha256) throw new Error('Native snapshot integrity mismatch');
  const context = vm.createContext({console: {warn() {}}, Buffer, Uint8Array, Uint32Array, Int8Array, Int16Array, Int32Array, ArrayBuffer, DataView, TextDecoder, TextEncoder, mapText: text}, {codeGeneration: {strings: false, wasm: false}});
  vm.runInContext(source, context, {timeout: 3000});
  const result = vm.runInContext('inspectNativeMap(mapText)', context, {timeout: 3000});
  return JSON.parse(JSON.stringify(result));
}
