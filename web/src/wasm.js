const encoder = new TextEncoder();
const decoder = new TextDecoder();
export async function loadCore() {
  const url = new URL('../core.wasm', import.meta.url);
  const response = await fetch(url);
  if (!response.ok) throw new Error('Rust/WASM is missing. Run ./scripts/build-browser.sh first.');
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
  const core = instance.exports;
  return (request) => {
    const input = encoder.encode(JSON.stringify(request));
    const pointer = core.allocate(input.length);
    new Uint8Array(core.memory.buffer, pointer, input.length).set(input);
    const resultPointer = core.request(pointer, input.length);
    const output = JSON.parse(decoder.decode(new Uint8Array(core.memory.buffer, resultPointer, core.response_len())));
    if (!output.ok) throw new Error(output.error);
    return output.value;
  };
}
