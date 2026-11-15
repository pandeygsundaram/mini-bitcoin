// Execute the actual release WASM ABI in Node, including signatures and fork replay.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const bytes=await readFile(new URL('../dist/core.wasm',import.meta.url));
async function engine(){
  const {instance}=await WebAssembly.instantiate(bytes,{});const x=instance.exports;const enc=new TextEncoder(),dec=new TextDecoder();
  return req=>{const input=enc.encode(JSON.stringify({now:Date.now(),...req}));const p=x.allocate(input.length);new Uint8Array(x.memory.buffer,p,input.length).set(input);const r=x.request(p,input.length);const result=JSON.parse(dec.decode(new Uint8Array(x.memory.buffer,r,x.response_len())));if(!result.ok)throw new Error(result.error);return result.value;};
}
const a=await engine(),b=await engine(),worker=await engine();
const secret='1'.padStart(64,'0'),other='2'.padStart(64,'0');const owner=a({op:'wallet',secret}).address,receiver=b({op:'wallet',secret:other}).address;
function mine(e){let block=e({op:'template',address:owner});for(;;){const result=worker({op:'mine',block,steps:20000});block=result.block;if(result.found){e({op:'block',block});return;}}}
for(let i=0;i<3;i++)mine(a);
b({op:'restore',snapshot:a({op:'snapshot'})});
const transfer=a({op:'transfer',secret,to:receiver,amount:'100000000',fee:'1000',nonce:'wasm-smoke'});
const altered=structuredClone(transfer.transaction);altered.outputs[0].value='2';assert.throws(()=>b({op:'transaction',transaction:altered}),/signature/);
mine(a);b({op:'restore',snapshot:a({op:'snapshot'})});assert.equal(b({op:'status',address:receiver}).balance,'100000000');
assert.equal(a({op:'status'}).tip,b({op:'status'}).tip);
console.log('PASS: real WASM key derivation, mining, signed transfer, persisted replay, and convergence');
