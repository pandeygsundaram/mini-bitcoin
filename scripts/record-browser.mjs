// Records real browser actions/assertions using isolated demo profiles.
// Does not reuse the user's browser data or stop existing preview services.
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import assert from 'node:assert/strict';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve('recordings', stamp);
const port = Number(process.env.MINI_RECORD_PORT || 18181);
const signalPort = Number(process.env.MINI_RECORD_SIGNAL_PORT || 18787);
const base = `http://localhost:${port}`;
const discovery = `http://127.0.0.1:${signalPort}`;
const password = 'recording-demo-password';
const services = [], chapters = [], results = [];
let browser;
await mkdir(resolve(output, 'raw'), { recursive: true });
await mkdir(resolve(output, 'backups'), { recursive: true });
console.log(`Recording directory: ${output}`);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
async function start(file, env) {
  const child = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  services.push(child);
  let error = ''; child.stderr.on('data', chunk => error += chunk);
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve); child.once('error', reject);
    child.once('exit', code => reject(new Error(`${file} exited ${code}: ${error}`)));
  });
}
async function context() {
  return browser.newContext({ viewport: { width: 1280, height: 900 }, recordVideo: { dir: resolve(output, 'raw'), size: { width: 1280, height: 900 } }, acceptDownloads: true });
}
async function stage(chapter, title, action, pages = [], hold = 1800) {
  const start = (performance.now() - chapter.started) / 1000;
  chapter.events.push({ seconds: start, title }); console.log(`[${chapter.name}] ${title}`);
  await action();
  for (const page of pages) {
    await page.waitForTimeout(hold);
    const index = chapter.events.length.toString().padStart(2, '0');
    await page.screenshot({ path: resolve(output, `${chapter.name}-${index}-${pages.indexOf(page)}.png`) });
  }
  results.push({ chapter: chapter.name, title, passed: true });
}
function chapter(name) { const c = { name, started: performance.now(), events: [], raw: [] }; chapters.push(c); return c; }
function dialogs(page) { page.on('dialog', dialog => dialog.accept()); page.on('pageerror', error => console.error(`Browser error: ${error.message}`)); }
async function open(page) { dialogs(page); await page.goto(base); await page.locator('#wallet-dialog').waitFor({ state: 'visible' }); }
async function create(page, name) {
  await page.locator('#display-name').fill(name); await page.locator('#wallet-password').fill(password);
  await page.locator('#wallet-submit').click(); await page.locator('#wallet-dialog').waitFor({ state: 'hidden' });
}
async function tab(page, name) { await page.locator(`[data-tab=${name}]`).click(); }
async function unlock(page) {
  await page.locator('#wallet-dialog').waitFor({ state: 'visible' }); await page.locator('#wallet-password').fill(password);
  await page.locator('#wallet-submit').click(); await page.locator('#wallet-dialog').waitFor({ state: 'hidden' });
}
async function height(page) { return Number(await page.locator('#stat-height').textContent()); }
async function mine(page, isolated = false) {
  await tab(page, 'miner'); await page.locator('#worker-count').selectOption('1');
  if (isolated) await page.locator('#allow-isolated').check();
  await page.locator('#toggle-miner').click();
}
async function stopMine(page) { await tab(page, 'miner'); if ((await page.locator('#toggle-miner').textContent()).includes('Stop')) await page.locator('#toggle-miner').click(); }
async function send(page, to, amount) {
  await tab(page, 'wallet'); await page.locator('#recipient').fill(to); await page.locator('#send-amount').fill(amount);
  await page.locator('#send-form button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#send-form button').disabled === false);
  assert.equal(await page.locator('#error').isVisible(), false, await page.locator('#error').textContent());
}
async function configure(page, url = discovery) {
  await tab(page, 'network'); await page.locator('#discovery-url').fill(url);
  await page.locator('#network-form button[type=submit]').click();
  await page.waitForFunction(global => document.getElementById('connection-state').textContent === (global ? 'Global discovery connected' : 'Local tabs connected'), Boolean(url), { timeout: 45000 });
}
async function exportFile(page, button, path) {
  const downloading = page.waitForEvent('download'); await page.locator(button).click();
  const download = await downloading; await download.saveAs(path);
}
async function finish(c, contexts, pages, names) {
  c.seconds = (performance.now() - c.started) / 1000;
  const videos = pages.map(page => page.video());
  for (const ctx of contexts) await ctx.close();
  for (let i = 0; i < videos.length; i++) {
    const path = resolve(output, `${c.name}-${names[i]}.webm`); await videos[i].saveAs(path); c.raw.push(path);
  }
}
try {
  run('ffmpeg', ['-version']); run('ffprobe', ['-version']);
  await start('scripts/dev.mjs', { PORT: String(port) });
  await start('signaling/server.mjs', { PORT: String(signalPort), ALLOWED_ORIGINS: base, STUN_URLS: '', TURN_URLS: '', TURN_SECRET: '' });
  browser = await chromium.launch({ slowMo: 110 });

  // 1. Two local tabs, full wallet/node/miner flow and persistence.
  const local = chapter('01-local'); const localContext = await context();
  const alice = await localContext.newPage(), bob = await localContext.newPage();
  await Promise.all([open(alice), open(bob)]);
  await stage(local, 'Create Alice wallet and optional local name', () => create(alice, 'Alice - local node'), [alice, bob], 900);
  await stage(local, 'Create Bob wallet in a second tab', () => create(bob, 'Bob - recipient'), [alice, bob], 900);
  await tab(bob, 'wallet'); const bobAddress = await bob.locator('#receive-address').textContent();
  await stage(local, 'Start Alice full node; inspect both browser roles', async () => {
    await tab(alice, 'node'); await alice.locator('#toggle-node').click(); await tab(bob, 'overview');
    await alice.waitForFunction(() => document.getElementById('node-status').textContent === 'RUNNING');
  }, [alice, bob]);
  await stage(local, 'Start Rust/WASM mining and mature the first rewards', async () => {
    await mine(alice, true);
    await alice.waitForFunction(() => Number(document.getElementById('stat-height').textContent) >= 3, null, { timeout: 120000 });
    await alice.waitForTimeout(900); await stopMine(alice); await tab(bob, 'wallet');
  }, [alice, bob]);
  await stage(local, 'Check spendable balance; export encrypted wallets', async () => {
    await tab(alice, 'wallet'); assert.ok(parseFloat(await alice.locator('#balance-spendable').textContent()) > 0);
    await exportFile(alice, '#backup-wallet', resolve(output, 'backups/alice-wallet.json'));
    await exportFile(bob, '#backup-wallet', resolve(output, 'backups/bob-wallet.json'));
  }, [alice, bob]);
  await stage(local, 'Send 1.25 MINI; inspect the pending transaction before mining', async () => {
    await send(alice, bobAddress, '1.25');
    await bob.waitForFunction(() => document.getElementById('activity').textContent.includes('pending'), null, { timeout: 30000 });
    assert.equal(await bob.locator('#balance-total').textContent(), '0.00000000');
  }, [alice, bob]);
  await stage(local, 'Mine the payment; recipient balance becomes 1.25000000 MINI', async () => {
    await mine(alice, true);
    await bob.waitForFunction(() => document.getElementById('balance-total').textContent === '1.25000000', null, { timeout: 120000 });
    await stopMine(alice); await tab(alice, 'wallet');
  }, [alice, bob]);
  await stage(local, 'Lock Bob wallet; reject a wrong password and unlock correctly', async () => {
    await bob.locator('#lock-wallet').click(); await bob.locator('#wallet-password').fill('incorrect-password'); await bob.locator('#wallet-submit').click();
    await bob.waitForFunction(() => document.getElementById('wallet-error').textContent.includes('Incorrect password'));
    await bob.waitForTimeout(1400); await unlock(bob);
    assert.equal(await bob.locator('#balance-total').textContent(), '1.25000000');
  }, [alice, bob]);
  await stage(local, 'Reload both tabs; restore independent wallets and chain history', async () => {
    await alice.reload(); await unlock(alice); await tab(alice, 'overview');
    await bob.reload(); await unlock(bob); await tab(bob, 'wallet');
    assert.equal(await alice.locator('#wallet-menu').textContent(), 'Alice - local node');
    assert.equal(await bob.locator('#wallet-menu').textContent(), 'Bob - recipient');
    assert.equal(await bob.locator('#balance-total').textContent(), '1.25000000');
  }, [alice, bob]);
  const localHeight = await height(bob);
  await stage(local, 'Export the validated chain for recovery on a fresh profile', async () => {
    await tab(alice, 'node'); await exportFile(alice, '#export-chain', resolve(output, 'backups/local-chain.json'));
    await tab(bob, 'wallet');
  }, [alice, bob]);
  await finish(local, [localContext], [alice, bob], ['alice', 'bob']);

  // 2. Isolated profiles, real signaling/WebRTC and a remote mining provider.
  const global = chapter('02-webrtc'); const nodeContext = await context(), minerContext = await context();
  const node = await nodeContext.newPage(), miner = await minerContext.newPage();
  await Promise.all([open(node), open(miner)]);
  await stage(global, 'Create independent node and miner profiles', async () => {
    await create(node, 'Node operator'); await create(miner, 'Remote miner');
  }, [node, miner]);
  await stage(global, 'Start node and connect both profiles through signaling + WebRTC', async () => {
    await tab(node, 'node'); await node.locator('#toggle-node').click();
    await configure(node); await configure(miner);
    await miner.waitForFunction(() => document.getElementById('peer-count').textContent === '1 CONNECTED', null, { timeout: 45000 });
    await node.waitForFunction(() => document.getElementById('peer-count').textContent === '1 CONNECTED', null, { timeout: 45000 });
  }, [node, miner]);
  await stage(global, 'Mine remotely while the miner own node stays stopped', async () => {
    await mine(miner);
    await miner.waitForFunction(() => Number(document.getElementById('stat-height').textContent) >= 3, null, { timeout: 120000 });
    assert.equal(await miner.locator('#node-status').textContent(), 'STOPPED');
    assert.notEqual(await miner.locator('#miner-provider').textContent(), 'This browser');
    await miner.waitForTimeout(900); await stopMine(miner); await tab(node, 'overview');
  }, [node, miner]);
  await tab(node, 'wallet'); const nodeAddress = await node.locator('#receive-address').textContent();
  await stage(global, 'Submit 2 MINI through the remote node; wait for acknowledgement', async () => {
    await send(miner, nodeAddress, '2'); await tab(node, 'node');
    await node.waitForFunction(() => Number(document.getElementById('node-pending').textContent) >= 1, null, { timeout: 30000 });
    await miner.waitForFunction(() => document.getElementById('toast').textContent.includes('accepted'), null, { timeout: 30000 });
  }, [node, miner]);
  await stage(global, 'Confirm the remote payment and propagate the new block', async () => {
    await mine(miner); await tab(node, 'wallet');
    await node.waitForFunction(() => document.getElementById('balance-total').textContent === '2.00000000', null, { timeout: 120000 });
    await stopMine(miner); await tab(miner, 'wallet');
  }, [node, miner]);
  await stage(global, 'Start a second full node; history has multiple serving peers', async () => {
    await tab(miner, 'node'); await miner.locator('#toggle-node').click();
    await node.waitForFunction(() => document.getElementById('stat-nodes').textContent === '2', null, { timeout: 30000 });
    await tab(node, 'overview');
  }, [node, miner]);
  const oldHeight = await height(node);
  await stage(global, 'Disconnect the original node; the remaining browser continues mining', async () => {
    await tab(node, 'node'); await node.locator('#toggle-node').click(); await configure(node, ''); await tab(node, 'overview');
    await mine(miner, true);
    await miner.waitForFunction(previous => Number(document.getElementById('stat-height').textContent) >= previous + 3, oldHeight, { timeout: 120000 });
    await stopMine(miner); await tab(miner, 'overview');
    assert.equal(await height(node), oldHeight);
    assert.ok(await height(miner) > oldHeight);
  }, [node, miner]);
  const latestHeight = await height(miner);
  await stage(global, 'Reconnect the older node; download and validate missing blocks', async () => {
    await configure(node); await tab(node, 'node'); await node.locator('#toggle-node').click();
    await node.waitForFunction(expected => Number(document.getElementById('stat-height').textContent) === expected, latestHeight, { timeout: 45000 });
    await tab(node, 'overview'); await tab(miner, 'overview');
    assert.equal(await height(node), await height(miner));
  }, [node, miner]);
  await finish(global, [nodeContext, minerContext], [node, miner], ['node', 'miner']);

  // 3. Wallet backup + chain backup imported through the UI on a fresh profile.
  const recovery = chapter('03-recovery'); const recoveryContext = await context(); const restored = await recoveryContext.newPage(); await open(restored);
  await stage(recovery, 'Fresh profile: import the encrypted Bob wallet backup', async () => {
    await restored.locator('#wallet-file').setInputFiles(resolve(output, 'backups/bob-wallet.json'));
    await restored.locator('#wallet-password').fill(password); await restored.locator('#wallet-submit').click();
    await restored.locator('#wallet-dialog').waitFor({ state: 'hidden' }); await tab(restored, 'wallet');
    assert.equal(await restored.locator('#receive-address').textContent(), bobAddress);
    assert.equal(await restored.locator('#balance-total').textContent(), '0.00000000');
  }, [restored], 2600);
  await stage(recovery, 'Import and validate chain history; recover the 1.25 MINI payment', async () => {
    await tab(restored, 'node'); await restored.locator('#import-chain').setInputFiles(resolve(output, 'backups/local-chain.json'));
    await restored.waitForFunction(() => document.getElementById('balance-total').textContent === '1.25000000', null, { timeout: 45000 });
    assert.equal(await height(restored), localHeight); await tab(restored, 'wallet');
  }, [restored], 2600);
  await stage(recovery, 'Reload the recovered profile; balance and history persist', async () => {
    await restored.reload(); await unlock(restored); await tab(restored, 'wallet');
    assert.equal(await restored.locator('#balance-total').textContent(), '1.25000000');
  }, [restored], 2400);
  await stage(recovery, 'Check the mobile layout and navigation at 390px', async () => {
    await restored.setViewportSize({ width: 390, height: 844 }); await tab(restored, 'overview');
    assert.equal(await restored.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await restored.screenshot({path: resolve(output, 'mobile-recovery.png'), fullPage: true});
  }, [restored], 2600);
  await restored.setViewportSize({width:1280,height:900}); await tab(restored,'wallet'); await restored.waitForTimeout(1500);
  await finish(recovery, [recoveryContext], [restored], ['wallet']);
  console.log('All recorded browser assertions passed. Encoding MP4 chapters…');

  // Encode readable actor views, with step captions placed outside the app.
  const clips = [];
  const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  for (const c of chapters) {
    const args = ['-hide_banner', '-loglevel', 'error', '-n'];
    for (const file of c.raw) args.push('-i', file);
    const labels = c.name === '01-local' ? ['Alice: node, miner and sender', 'Bob: wallet and recipient'] : ['Validating node operator', 'Remote miner and wallet'];
    let graph = c.raw.length === 2
      ? '[0:v]fps=25,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=2[a];[1:v]fps=25,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=2[b];[a][b]hstack=shortest=1,pad=2560:1080:0:70:color=0x101511,setsar=1'
      : '[0:v]fps=25,setpts=PTS-STARTPTS,pad=2560:1080:640:70:color=0x101511,setsar=1';
    if(c.raw.length === 2) graph += `,drawtext=fontfile=${font}:text='${labels[0].replaceAll(':',' -')}':fontsize=26:fontcolor=white:x=24:y=22,drawtext=fontfile=${font}:text='${labels[1].replaceAll(':',' -')}':fontsize=26:fontcolor=white:x=1304:y=22`;
    else graph += `,drawtext=fontfile=${font}:text='Fresh browser - encrypted wallet and chain recovery':fontsize=26:fontcolor=white:x=(w-tw)/2:y=22`;
    for (let i=0;i<c.events.length;i++) {
      const event=c.events[i]; const end=c.events[i+1]?.seconds ?? c.seconds+3;
      const file=resolve(output,`${c.name}-caption-${i+1}.txt`); await writeFile(file,`${i+1}. ${event.title}`);
      graph += `,drawtext=fontfile=${font}:textfile=${file}:fontsize=28:fontcolor=white:x=(w-tw)/2:y=1003:enable='between(t,${event.seconds.toFixed(3)},${end.toFixed(3)})'`;
    }
    graph += '[out]'; const file=resolve(output,`${c.name}.mp4`);
    args.push('-filter_complex',graph,'-map','[out]','-an','-c:v','libx264','-preset','veryfast','-crf','22','-pix_fmt','yuv420p','-threads','4','-movflags','+faststart',file);
    run('ffmpeg',args); clips.push(file);
    const info=JSON.parse(run('ffprobe',['-v','error','-show_entries','format=duration,size:stream=codec_name,width,height','-of','json',file]));
    assert.ok(Number(info.format.duration)>2); c.video=relative(output,file);c.media=info;
    console.log(`Encoded ${c.video}: ${Number(info.format.duration).toFixed(1)} seconds`);
  }
  const concat=resolve(output,'chapters.concat.txt'); await writeFile(concat,clips.map(path=>`file '${path}'`).join('\n')+'\n');
  const full=resolve(output,'full-walkthrough.mp4');run('ffmpeg',['-hide_banner','-loglevel','error','-n','-f','concat','-safe','0','-i',concat,'-c','copy','-movflags','+faststart',full]);
  const info=JSON.parse(run('ffprobe',['-v','error','-show_entries','format=duration,size:stream=codec_name,width,height','-of','json',full]));
  await writeFile(resolve(output,'report.json'),JSON.stringify({passed:true,created:new Date().toISOString(),scope:'Real Chromium UI, localhost signaling and WebRTC; isolated demo profiles. Physical-network STUN/TURN not covered.',video:info,chapters,assertions:results},null,2));
  await writeFile(resolve(output,'README.txt'),`Full walkthrough: full-walkthrough.mp4\n\n01-local.mp4: local wallets, node, mining, transfer, lock/unlock, reload\n02-webrtc.mp4: isolated profiles, remote mining, payment, offline/reconnect sync\n03-recovery.mp4: encrypted wallet import, chain backup restore, mobile layout\n\n${results.length} recorded browser steps passed.\nRaw participant WebM recordings, screenshots, captions and report.json are included.\nUses isolated generated demo wallets; backup passwords are test-only.\nNo microphone/audio recording. Cross-network STUN/TURN deployment is not covered.\n`);
  await writeFile(resolve(output,'index.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><title>Mini-Bitcoin recorded tests</title><style>body{background:#101511;color:#e8ece5;font:16px system-ui;max-width:1200px;margin:40px auto;padding:20px}video{width:100%;background:#000}a{color:#c9f370}</style><h1>Mini-Bitcoin: recorded browser tests</h1><p>${results.length} steps passed. Real Chromium UI with generated demo wallets.</p><video controls src="full-walkthrough.mp4"></video><p><a href="full-walkthrough.mp4" download>Download full MP4</a> · <a href="report.json">Test report</a></p><p>Chapters: <a href="01-local.mp4">Local flow</a> · <a href="02-webrtc.mp4">WebRTC + reconnect</a> · <a href="03-recovery.mp4">Backup recovery</a></p><p>No audio. Physical-network STUN/TURN not covered.</p></html>`);
  console.log(`SUCCESS: ${full} (${Number(info.format.duration).toFixed(1)}s, ${(Number(info.format.size)/1048576).toFixed(1)} MiB)`);
} catch(error) {
  await writeFile(resolve(output,'failure.json'),JSON.stringify({passed:false,error:error.stack,chapters,assertions:results},null,2));
  console.error(`Recording failed; existing footage retained in ${output}`); throw error;
} finally {
  await browser?.close(); for(const child of services) child.kill();
}
