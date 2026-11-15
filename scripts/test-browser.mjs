import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const server=spawn(process.execPath,['scripts/dev.mjs'],{stdio:'pipe'});
let browser;
try{
  await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',code=>reject(new Error(`Preview exited ${code}`)));});
  browser=await chromium.launch();const context=await browser.newContext();
  const a=await context.newPage();await a.goto('http://localhost:8080');
  await a.locator('#wallet-dialog').waitFor({state:'visible'});
  await a.locator('#display-name').fill('Alice');await a.locator('#wallet-password').fill('test password');await a.locator('#wallet-submit').click();await a.locator('#wallet-dialog').waitFor({state:'hidden'});
  await a.locator('[data-tab=node]').click();await a.locator('#toggle-node').click();
  await a.locator('[data-tab=miner]').click();await a.locator('#allow-isolated').check();await a.locator('#worker-count').selectOption('1');await a.locator('#toggle-miner').click();
  await a.waitForFunction(()=>Number(document.getElementById('stat-height').textContent)>=3,{},{timeout:120000});await a.locator('#toggle-miner').click();
  const b=await context.newPage();await b.goto('http://localhost:8080');await b.locator('#wallet-dialog').waitFor({state:'visible'});
  await b.locator('#wallet-password').fill('test password');await b.locator('#wallet-submit').click();await b.locator('#wallet-dialog').waitFor({state:'hidden'});
  await b.locator('[data-tab=wallet]').click();b.on('dialog',dialog=>dialog.accept());await b.locator('#switch-wallet').click();await b.locator('#display-name').fill('Bob');await b.locator('#wallet-password').fill('another password');await b.locator('#wallet-submit').click();await b.locator('#wallet-dialog').waitFor({state:'hidden'});
  const receiver=await b.locator('#receive-address').textContent();assert.match(receiver,/^(02|03)[0-9a-f]{64}$/);
  await b.waitForFunction(()=>Number(document.getElementById('stat-height').textContent)>=3,{},{timeout:30000});
  a.on('dialog',dialog=>dialog.accept());await a.locator('[data-tab=wallet]').click();await a.locator('#recipient').fill(receiver);await a.locator('#send-amount').fill('1');await a.locator('#send-form button[type=submit]').click();
  await a.locator('[data-tab=miner]').click();await a.locator('#toggle-miner').click();
  await b.waitForFunction(()=>document.getElementById('balance-total').textContent==='1.00000000',{},{timeout:120000});
  await a.locator('#toggle-miner').click();await b.reload();await b.locator('#wallet-dialog').waitFor({state:'visible'});await b.locator('#wallet-password').fill('another password');await b.locator('#wallet-submit').click();await b.locator('#wallet-dialog').waitFor({state:'hidden'});
  assert.equal(await b.locator('#balance-total').textContent(),'1.00000000');
  await a.reload();await a.locator('#wallet-dialog').waitFor({state:'visible'});await a.locator('#wallet-password').fill('test password');await a.locator('#wallet-submit').click();await a.locator('#wallet-dialog').waitFor({state:'hidden'});assert.equal(await a.locator('#wallet-menu').textContent(),'Alice');
  console.log('PASS: browser wallets, worker mining, local peer sync, signed payment, and reload recovery');
}finally{await browser?.close();server.kill();}
