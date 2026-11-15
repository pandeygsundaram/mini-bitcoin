const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const randomHex = (length = 32) => [...crypto.getRandomValues(new Uint8Array(length))].map(b => b.toString(16).padStart(2, '0')).join('');
const base64 = bytes => btoa(String.fromCharCode(...bytes));
const unbase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
async function passwordKey(password, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 310000 }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function sealWallet(wallet, password) {
  if (password.length < 8) throw new Error('Use a wallet password of at least 8 characters.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await passwordKey(password, salt), encoder.encode(JSON.stringify(wallet)));
  return { format: 'mini-bitcoin-wallet-v2', salt: base64(salt), iv: base64(iv), data: base64(new Uint8Array(data)) };
}
export async function openWallet(vault, password) {
  if (vault?.format !== 'mini-bitcoin-wallet-v2' || typeof vault.data !== 'string' || vault.data.length > 20000) throw new Error('Not a supported wallet backup.');
  try {
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(vault.iv) }, await passwordKey(password, unbase64(vault.salt)), unbase64(vault.data));
    const wallet = JSON.parse(decoder.decode(data));
    if (!/^[0-9a-f]{64}$/.test(wallet.secret) || typeof wallet.name !== 'string') throw new Error('Invalid wallet');
    return wallet;
  } catch { throw new Error('Incorrect password or damaged wallet backup.'); }
}
let database;
async function db() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('mini-bitcoin-browser-v2', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('data');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}
export async function read(key) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction('data').objectStore('data').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function write(key, value) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('data', 'readwrite');
    transaction.objectStore('data').put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Storage transaction aborted'));
  });
}
export function download(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = Object.assign(document.createElement('a'), { href: url, download: name });
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Compare and write inside one IndexedDB transaction so a stale tab cannot
// replace a better saved chain between the read and the write.
export async function saveHistory(snapshot) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('data', 'readwrite');
    const store = transaction.objectStore('data');
    const request = store.get('best-chain');
    request.onsuccess = () => {
      const previous = request.result;
      const better = !previous || BigInt(snapshot.work) > BigInt(previous.work) || (snapshot.work === previous.work && snapshot.tip < previous.tip);
      if (better) store.put(snapshot, 'best-chain');
      else if (snapshot.tip === previous.tip && snapshot.blocks.length >= previous.blocks.length) store.put(snapshot, 'best-chain');
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('History save aborted'));
  });
}
export async function saveVault(wallet, vault) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('data', 'readwrite');
    const store = transaction.objectStore('data');
    store.put(vault, `wallet:${wallet.address}`); store.put(wallet.address, 'last-wallet');
    const request = store.get('wallet-index');
    request.onsuccess = () => { const entries=request.result||[]; const index=entries.findIndex(e=>e.address===wallet.address); const entry={address:wallet.address,name:wallet.name};if(index<0)entries.push(entry);else entries[index]=entry;store.put(entries,'wallet-index'); };
    transaction.oncomplete=()=>resolve();transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);
  });
}
