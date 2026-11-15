// Two isolated browser profiles: discovery + actual WebRTC + remote miner.
// This checks host ICE candidates on one machine; NAT/TURN needs a cross-network check.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const services=[];let browser;
async function start(file,env={}){const process=spawn(globalThis.process.execPath,[file],{stdio:'pipe',env:{...globalThis.process.env,...env}});services.push(process);await new Promise((resolve,reject)=>{process.stdout.once('data',resolve);process.once('error',reject);process.once('exit',code=>reject(new Error(`${file} exited ${code}`)));});}
async function wallet(page,name){await page.goto('http://localhost:8080');await page.locator('#wallet-dialog').waitFor({state:'visible'});await page.locator('#display-name').fill(name);await page.locator('#wallet-password').fill('test password');await page.locator('#wallet-submit').click();await page.locator('#wallet-dialog').waitFor({state:'hidden'});}
async function globalNetwork(page){await page.locator('[data-tab=network]').click();await page.locator('#discovery-url').fill('http://127.0.0.1:8787');await page.locator('#network-form button[type=submit]').click();await page.waitForFunction(()=>document.getElementById('connection-state').textContent==='Global discovery connected');}
try{
  await start('scripts/dev.mjs');await start('signaling/server.mjs',{ALLOWED_ORIGINS:'http://localhost:8080',STUN_URLS:'',TURN_URLS:'',TURN_SECRET:''});
  browser=await chromium.launch();const a=await(await browser.newContext()).newPage(),b=await(await browser.newContext()).newPage();
  await wallet(a,'Node operator');await wallet(b,'Remote miner');
  await a.locator('[data-tab=node]').click();await a.locator('#toggle-node').click();await globalNetwork(a);await globalNetwork(b);
  await b.waitForFunction(()=>document.getElementById('peer-count').textContent==='1 CONNECTED',{},{timeout:45000});
  await b.locator('[data-tab=miner]').click();await b.locator('#worker-count').selectOption('1');await b.locator('#toggle-miner').click();
  await b.waitForFunction(()=>Number(document.getElementById('stat-height').textContent)>=3,{},{timeout:120000});await b.locator('#toggle-miner').click();
  await a.locator('[data-tab=wallet]').click();const recipient=await a.locator('#receive-address').textContent();
  b.on('dialog',dialog=>dialog.accept());await b.locator('[data-tab=wallet]').click();await b.locator('#recipient').fill(recipient);await b.locator('#send-amount').fill('1');await b.locator('#send-form button[type=submit]').click();
  await b.locator('[data-tab=miner]').click();await b.locator('#toggle-miner').click();
  await a.waitForFunction(()=>document.getElementById('balance-total').textContent==='1.00000000',{},{timeout:120000});await b.locator('#toggle-miner').click();
  assert.equal(await a.locator('#balance-total').textContent(),'1.00000000');
  console.log('PASS: isolated profiles, signaling, WebRTC, remote mining, transaction acknowledgement, and block propagation');
}finally{await browser?.close();for(const service of services)service.kill();}
