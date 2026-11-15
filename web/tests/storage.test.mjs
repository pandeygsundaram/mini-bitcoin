import test from 'node:test';
import assert from 'node:assert/strict';
import { randomHex, sealWallet, openWallet } from '../src/storage.js';
test('wallet backups encrypt, authenticate, and recover keys',async()=>{
  const wallet={name:'My wallet',secret:randomHex()};
  assert.equal(wallet.secret.length,64);
  const sealed=await sealWallet(wallet,'test password');
  assert.ok(!JSON.stringify(sealed).includes(wallet.secret));
  assert.deepEqual(await openWallet(sealed,'test password'),wallet);
  await assert.rejects(()=>openWallet(sealed,'wrong password'),/Incorrect password/);
  const altered={...sealed,data:'AA'+sealed.data.slice(2)};
  await assert.rejects(()=>openWallet(altered,'test password'));
});
