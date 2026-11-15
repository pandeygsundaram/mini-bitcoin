import { loadCore } from './wasm.js';
const core = loadCore();
self.onmessage = async ({ data }) => {
  try { const dispatch = await core; self.postMessage({ id: data.id, value: dispatch(data.request) }); }
  catch (error) { self.postMessage({ id: data.id, error: error.message }); }
};
