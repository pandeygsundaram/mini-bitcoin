import { loadCore } from './wasm.js';
const ready = loadCore();
let generation = 0;
self.onmessage = async ({ data }) => {
  let mine;
  try { mine = await ready; } catch(error) { self.postMessage({type:'error',job:data.job,error:error.message}); return; }
  const current = ++generation;
  if (data.type === 'stop') return;
  let block = structuredClone(data.block);
  block.nonce = String(data.index);
  const run = () => {
    if (generation !== current) return;
    try {
      const start = performance.now();
      const result = mine({ op: 'mine', block, steps: 2000, stride: data.workers });
      block = result.block;
      self.postMessage({ type: 'progress', job: data.job, hashes: result.hashes, elapsed: performance.now() - start });
      if (result.found) { self.postMessage({ type: 'found', job: data.job, block }); return; }
      setTimeout(run, 0); // Let cancellation and new templates reach this worker.
    } catch (error) { self.postMessage({ type: 'error', job: data.job, error: error.message }); }
  };
  run();
};
