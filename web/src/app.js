import { PeerNetwork, NETWORK } from './network.js';
import { read, write, randomHex, sealWallet, openWallet, download, saveHistory, saveVault } from './storage.js';
import { parseAmount, formatAmount } from './amount.js';
const $ = id => document.getElementById(id);
const text = (id,value) => { $(id).textContent = value; };
let walletId=sessionStorage.getItem('mini-bitcoin-wallet-id');
let wallet, vault, status, nodeRunning = false, mining = false, ready = false, peers = [], miners = [], job, minedCount = 0;
let provider, hashes = 0, hashStart = performance.now(), stateSaving = Promise.resolve(), syncing = new Set(), submitted = [], vaultMode = 'new';
let requestIndex = 0, refreshTimer, templateTimer, toastTimer, currentSettings = {};
const latencies = new Map();
const requests = new Map(), knownBlocks = new Set(), knownTransactions = new Set(), syncRequests = new Map(), outboundSync = new Map(), checkedPeers = new Set();
const core = new Worker(new URL('./core.worker.js', import.meta.url), { type: 'module' });
core.onmessage = ({data}) => { const pending = requests.get(data.id); if(!pending)return; clearTimeout(pending.timer); requests.delete(data.id); if(data.error)pending.reject(new Error(data.error));else pending.resolve(data.value); };
core.onerror = event => { for(const pending of requests.values()){clearTimeout(pending.timer);pending.reject(new Error(event.message));}requests.clear(); showError('The Rust worker stopped. Reload the page to restore saved state.'); };
function rpc(op,args = {}) { return new Promise((resolve,reject) => { const id=++requestIndex; const timer=setTimeout(()=>{requests.delete(id);reject(new Error('The Rust worker timed out. Large history imports can take time.'));},120000);requests.set(id,{resolve,reject,timer});core.postMessage({id,request:{op,now:Date.now(),...args}}); }); }
function log(message) { const line=document.createElement('div');line.textContent=`${new Date().toLocaleTimeString()}  ${message}`;$('log').prepend(line);while($('log').children.length>70)$('log').lastChild.remove(); }
function showError(message) { text('error',message);$('error').hidden=false;log(message); }
function toast(message) { clearTimeout(toastTimer);text('toast',message);$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,4500); }
function page(tab) { for(const el of document.querySelectorAll('.page'))el.classList.toggle('active',el.id===tab);for(const el of document.querySelectorAll('[data-tab]'))el.classList.toggle('active',el.dataset.tab===tab);history.replaceState(null,'',`#${tab}`); }
for(const el of document.querySelectorAll('[data-tab],[data-goto]'))el.addEventListener('click',()=>page(el.dataset.tab||el.dataset.goto));
function packet(type, fields = {}) { return { network:NETWORK,type,...fields }; }
function send(id,type,fields) { network.send(id,packet(type,fields)); }
const network = new PeerNetwork({
  state(message) { text('connection-state',message);$('connection-dot').classList.toggle('online',/connected$/.test(message));log(message); },
  peers(list) { peers=list;renderPeers();renderCounts();updateNodeOptions();updateSyncStatus();if(mining && provider && provider!=='local' && !list.some(p=>p.id===provider&&p.connected&&p.node))scheduleTemplate(100); },
  connected(id) { log(`Peer connected: ${id.slice(0,8)}`);sendHello(id); },
  message(id,message) { handleMessage(id,message).catch(error=>log(`Peer ${id.slice(0,8)}: ${error.message}`)); },
  error(message) { log(message); }
});
let messageQueue=Promise.resolve();
function handleMessage(id,message) {
  // Serialize sync/accept operations so chain ordering is preserved across peers.
  const task=messageQueue.then(()=>processMessage(id,message));messageQueue=task.catch(()=>{});return task;
}
async function sendHello(id) {
  if(!ready)return;
  try { const s=await rpc('status');send(id,'hello',{genesis:s.genesis,tip:s.tip,height:s.height,node:nodeRunning}); }catch(e){log(e.message);}
}
async function beginSync(id) {
  if(syncRequests.has(id))return;
  syncing.add(id);const token=crypto.randomUUID();syncRequests.set(id,{token,cursor:0,time:Date.now()});
  send(id,'get-blocks',{cursor:0,token});updateSyncStatus();
}
async function processMessage(id,message) {
  if(!ready)return;
  if(message.type==='ping'){send(id,'pong',{sent:message.sent});return;}
  if(message.type==='pong'){if(Number.isFinite(message.sent))latencies.set(id,Math.max(0,Date.now()-message.sent));return;}
  if(message.type==='hello') {
    send(id,'ping',{sent:Date.now()});
    if(message.genesis!==status.genesis)throw new Error('Different genesis anchor');
    if(message.node && message.tip!==status.tip)await beginSync(id);
    else if(message.node){if(!checkedPeers.has(id))send(id,'get-pending',{});checkedPeers.add(id);updateSyncStatus();}
    return;
  }
  if(message.type==='get-blocks') {
    if(!nodeRunning)return;
    if(!Number.isInteger(message.cursor)||message.cursor<0||typeof message.token!=='string'||message.token.length>64)return;
    const key=id+':'+message.token;let snapshot=outboundSync.get(key);
    if(message.cursor===0){if(outboundSync.size>=8)outboundSync.delete(outboundSync.keys().next().value);snapshot=await rpc('snapshot');snapshot.created=Date.now();outboundSync.set(key,snapshot);}
    if(!snapshot)return;const cursor=message.cursor;
    send(id,'blocks',{token:message.token,cursor,items:snapshot.blocks.slice(cursor,cursor+4),next:cursor+4<snapshot.blocks.length?cursor+4:null,genesis:snapshot.genesis});if(cursor+4>=snapshot.blocks.length){outboundSync.delete(key);await sendHello(id);}return;
  }
  if(message.type==='blocks') {
    const request=syncRequests.get(id);
    if(!request || request.token!==message.token || request.cursor!==message.cursor || message.genesis!==status.genesis || !Array.isArray(message.items)||message.items.length>4)return;
    request.time=Date.now();
    for(const block of message.items) await rpc('block',{block});
    if(message.next!==null) {
      if(!Number.isInteger(message.next)||message.next!==request.cursor+4)throw new Error('Invalid sync cursor');request.cursor=message.next;send(id,'get-blocks',{cursor:request.cursor,token:request.token});
    } else {
      syncRequests.delete(id);syncing.delete(id);checkedPeers.add(id);log(`History synchronized with ${id.slice(0,8)}`);
      send(id,'get-pending',{});await refresh();await persist();if(mining)scheduleTemplate(100);
    }
    updateSyncStatus();return;
  }
  if(message.type==='get-pending') { if(nodeRunning){const snapshot=await rpc('snapshot');for(const transaction of snapshot.pending)send(id,'transaction',{transaction});}return; }
  if(message.type==='block') {
    const marker=JSON.stringify([message.block?.network,message.block?.height,message.block?.parent,message.block?.timestamp,message.block?.bits,message.block?.nonce,message.block?.merkle]);
    if(knownBlocks.has(marker))return;
    try { const result=await rpc('block',{block:message.block});knownBlocks.add(marker);trimSeen();if(nodeRunning)network.broadcast(message,id);await persist();if(result.changed){await refresh();if(mining)scheduleTemplate(100);} }
    catch(error) { if(/Missing parent/.test(error.message))await beginSync(id);else throw error; }return;
  }
  if(message.type==='transaction') {
    const result=await rpc('transaction',{transaction:message.transaction});
    if(!knownTransactions.has(result.id)){knownTransactions.add(result.id);trimSeen();if(nodeRunning)network.broadcast(message,id);await refresh();await persist();}
    return;
  }
  if(message.type==='submit-transaction') {
    if(!nodeRunning)return;
    try { const result=await rpc('transaction',{transaction:message.transaction});send(id,'transaction-result',{request:message.request,accepted:true,id:result.id});network.broadcast(packet('transaction',{transaction:message.transaction}));await refresh();await persist(); }
    catch(error){send(id,'transaction-result',{request:message.request,accepted:false,error:error.message});}return;
  }
  if(message.type==='transaction-result') {
    const record=submitted.find(t=>t.request===message.request&&t.peer===id);
    if(record){record.status=message.accepted?'accepted':'rejected';record.error=message.error;if(!message.accepted){await rpc('drop-transaction',{id:record.id});await refresh();await persist();}await saveSubmitted();renderActivity();toast(message.accepted?'Node accepted your transaction; awaiting a block.':`Transaction rejected: ${message.error}`);}return;
  }
  if(message.type==='get-template') {
    if(!nodeRunning||typeof message.address!=='string')return;
    if(syncing.size){send(id,'template-error',{request:message.request,error:'Node is synchronizing'});return;}
    try {send(id,'template',{request:message.request,block:await rpc('template',{address:message.address})});}catch(error){send(id,'template-error',{request:message.request,error:error.message});}return;
  }
  if(message.type==='template') {
    if(!mining || id!==provider || message.request!==job?.request)return;
    const block=message.block;
    if(block?.network!==NETWORK || block.transactions?.[0]?.outputs?.[0]?.address!==wallet?.address || !Number.isInteger(block.bits)||block.bits<12||block.bits>24)throw new Error('Invalid mining template or reward destination');
    if(block.parent!==status.tip){await beginSync(id);scheduleTemplate(2000);return;}
    const expected=await rpc('template',{address:wallet.address});
    if(block.bits!==expected.bits || block.height!==expected.height)throw new Error('Template difficulty/height does not match validated local history');
    startJob(block);return;
  }
  if(message.type==='template-error') {if(id===provider&&message.request===job?.request){log(message.error);scheduleTemplate(3000);}return;}
  if(message.type==='submit-block') {
    if(!nodeRunning)return;
    try{await rpc('block',{block:message.block});network.broadcast(packet('block',{block:message.block}));await refresh();await persist();if(mining)scheduleTemplate(100);}catch(error){send(id,'block-error',{error:error.message});}return;
  }
  if(message.type==='block-error')log(`Mined block rejected: ${message.error}`);
}
function trimSeen(){if(knownBlocks.size>2000)knownBlocks.clear();if(knownTransactions.size>2000)knownTransactions.clear();}
function renderCounts(){text('stat-nodes',peers.filter(p=>p.node).length+Number(nodeRunning));text('stat-miners',peers.filter(p=>p.mining).length+Number(mining));}
function updateSyncStatus(){text('sync-state',syncing.size?`Synchronizing with ${syncing.size} peer(s)…`:peers.some(p=>p.node&&p.connected&&checkedPeers.has(p.id))?'Peer history checked · independently validated':'No node peers; sync status unknown');}
function makeRow(values){const row=document.createElement('div');row.className='data-row';for(const [value,cls]of values){const cell=document.createElement('span');cell.textContent=value;cell.className=cls||'';row.append(cell);}return row;}
function renderPeers(){const el=$('peers');el.replaceChildren();const connected=peers.filter(p=>p.connected).length;text('peer-count',`${connected} CONNECTED`);if(!peers.length){el.textContent='No peers discovered yet. Open another tab, or configure global discovery.';return;}for(const p of peers)el.append(makeRow([[p.id.slice(0,8),'mono'],[p.node?'Full node':p.mining?'Miner':'Wallet client'],[`Height ${p.height||0}`],[p.connected?'Connected':'Connecting…']]));}
function updateNodeOptions(){const selected=$('mining-node').value;$('mining-node').replaceChildren(new Option('Automatic · prefer a synced local node','auto'));if(nodeRunning)$('mining-node').add(new Option('This browser node','local'));for(const p of peers)if(p.node&&p.connected)$('mining-node').add(new Option(`${p.id.slice(0,8)} · height ${p.height}${latencies.has(p.id)?` · ${latencies.get(p.id)}ms`:''}`,p.id));if([...$('mining-node').options].some(o=>o.value===selected))$('mining-node').value=selected;}
function renderActivity(){const el=$('activity');el.replaceChildren();const activity=status?.activity||[];const ids=new Set(activity.map(t=>t.id));const records=[...submitted.filter(t=>!ids.has(t.id)).map(t=>({...t,status:t.status==='confirmed'?'reorganized':t.status})),...activity];if(!records.length){el.textContent='Your transactions will appear here.';return;}for(const tx of records.slice(0,100)){const description=tx.error?`${tx.status}: ${tx.error}`:tx.status==='confirmed'?`${tx.confirmations} confirmation${tx.confirmations===1?'':'s'}`:tx.status;const row=makeRow([[tx.kind||'sent'],[`${tx.id.slice(0,18)}…`,'mono truncate'],[`${formatAmount(tx.value)} MINI`],[description]]);row.title=tx.id;el.append(row);}}
async function refresh(){
  if(!ready)return;
  const previous=status?.tip, previousReorgs=status?.reorgs||0;status=await rpc('status',{address:wallet?.address||''});
  network.setPresence({node:nodeRunning,mining,height:status.height});
  for(const id of ['stat-height','node-height'])text(id,status.height);
  text('node-work',status.work);text('node-bits',`${status.bits} bits`);text('node-pending',status.pending);text('node-reorgs',status.reorgs);
  text('overview-balance',formatAmount(status.spendable));text('balance-spendable',formatAmount(status.spendable));text('balance-total',formatAmount(status.balance));text('balance-immature',formatAmount(status.immature));text('balance-locked',formatAmount(status.locked));
  const minersOnline=peers.filter(p=>p.mining).length+Number(mining);
  const estimate=status.averageBlockSeconds;
  text('stat-estimate',minersOnline&&estimate?`~${Math.ceil(estimate*(Math.floor(status.pending/100)+1))}s`:'—');
  text('estimate-note',!minersOnline?'No miners reported online':estimate?'Based on recent blocks; timing varies':'Waiting for observed blocks');
  const blocks=$('blocks');blocks.replaceChildren();if(!status.blocks.length)blocks.textContent='No blocks yet. Start a node and a miner to create the first one.';
  for(const b of status.blocks)blocks.append(makeRow([[`#${b.height}`],[`${b.id.slice(0,24)}…`,'mono truncate'],[`${b.transactions-1} transfers`],[new Date(b.timestamp).toLocaleTimeString()]]));
  const activityById=new Map(status.activity.map(t=>[t.id,t]));let changed=false;
  for(const record of submitted){const found=activityById.get(record.id);if(found?.status==='confirmed'&&record.status!=='confirmed'){record.status='confirmed';changed=true;}else if(!found&&record.status==='confirmed'){record.status='not on active chain';changed=true;}}
  if(status.reorgs>previousReorgs)for(const record of submitted)if(!activityById.has(record.id)&&record.status==='accepted'){record.status='not on active chain';changed=true;}
  if(changed)await saveSubmitted();
  renderActivity();renderCounts();updateSyncStatus();
  if(previous && previous!==status.tip){log(`Active chain → height ${status.height}, work ${status.work}`);if(nodeRunning)network.broadcast(packet('hello',{genesis:status.genesis,tip:status.tip,height:status.height,node:true}));}
}
async function saveSubmitted(){if(wallet)await write(`submitted:${wallet.address}`,submitted);}
function persist(){stateSaving=stateSaving.catch(()=>{}).then(async()=>saveHistory(await rpc('snapshot'))).catch(error=>showError(`Could not save chain: ${error.message}. Export a backup.`));return stateSaving;}
function showWallet(mode='new'){
  vaultMode=mode;const locked=mode==='unlock';$('wallet-dialog-title').textContent=locked?'Welcome back.':'Your wallet starts here.';
  $('name-label').hidden=locked;$('import-label').hidden=locked;$('raw-key-label').hidden=locked;
  text('wallet-submit',locked?'Unlock wallet':'Create / import wallet');text('wallet-error','');$('wallet-password').value='';$('raw-key').value='';$('wallet-file').value='';$('wallet-cancel').hidden=!wallet;
  loadWalletOptions();$('wallet-dialog').showModal();
}
async function loadWalletOptions(){const entries=await read('wallet-index')||[];const select=$('saved-wallet');select.replaceChildren(new Option('Create / import a wallet','new'));for(const item of entries)select.add(new Option(`${item.name} · ${item.address.slice(0,10)}…`,item.address));select.value=vaultMode==='unlock'?walletId:'new';$('saved-wallet-label').hidden=!entries.length;}
$('saved-wallet').onchange=async()=>{const selected=$('saved-wallet').value;if(selected==='new')showWalletFields(false);else{walletId=selected;vault=await read(`wallet:${selected}`);showWalletFields(true);}};
function showWalletFields(locked){vaultMode=locked?'unlock':'new';$('name-label').hidden=locked;$('import-label').hidden=locked;$('raw-key-label').hidden=locked;text('wallet-submit',locked?'Unlock wallet':'Create / import wallet');text('wallet-error','');}
$('wallet-dialog').addEventListener('cancel',event=>{if(!wallet)event.preventDefault();});
$('wallet-cancel').onclick=async()=>{if(wallet){walletId=wallet.address;vault=await read(`wallet:${walletId}`);}$('wallet-dialog').close();};
$('wallet-form').onsubmit=async event=>{
  event.preventDefault();$('wallet-submit').disabled=true;text('wallet-error','');
  try {
    if(!ready)throw new Error('Rust/WASM runtime is unavailable. Build the browser package and reload.');
    const password=$('wallet-password').value;let candidate;
    if(vaultMode==='unlock')candidate=await openWallet(vault,password);
    else if($('wallet-file').files[0]){const file=$('wallet-file').files[0];if(file.size>30000)throw new Error('Wallet backup is too large');candidate=await openWallet(JSON.parse(await file.text()),password);if($('display-name').value.trim())candidate.name=$('display-name').value.trim();}
    else {const secret=$('raw-key').value.trim().toLowerCase()||randomHex();candidate={secret,name:$('display-name').value.trim()||'My wallet'};}
    const identity=await rpc('wallet',{secret:candidate.secret});candidate.address=identity.address;
    const sealed=await sealWallet(candidate,password);await saveVault(candidate,sealed);vault=sealed;wallet=candidate;walletId=wallet.address;sessionStorage.setItem('mini-bitcoin-wallet-id',walletId);
    submitted=(await read(`submitted:${wallet.address}`))||[];
    $('wallet-dialog').close();$('wallet-password').value='';$('raw-key').value='';
    text('wallet-menu',wallet.name);text('wallet-name',wallet.name);text('receive-address',wallet.address);text('miner-address',wallet.address);await refresh();toast(vaultMode==='unlock'?'Wallet unlocked.':'Wallet ready. Export an encrypted backup from the Wallet tab.');
  }catch(error){text('wallet-error',error.message);}finally{$('wallet-submit').disabled=false;}
};
$('wallet-menu').onclick=()=>wallet?page('wallet'):showWallet(vault?'unlock':'new');
$('switch-wallet').onclick=()=>{if(wallet&&confirm('Have you exported your wallet backup? You can create/import another wallet; this wallet stays saved on this device.')){stopMining();showWallet('new');}};
$('lock-wallet').onclick=()=>{stopMining();wallet=null;submitted=[];text('wallet-menu','Wallet locked');text('wallet-name','Locked');text('receive-address','Unlock your wallet to see your address.');text('miner-address','Wallet locked');refresh().catch(showError);showWallet('unlock');};
$('backup-wallet').onclick=()=>{if(!vault)return;download('mini-bitcoin-wallet.json',vault);toast('Encrypted wallet backup exported.');};
for(const id of ['copy-address','copy-address-overview'])$(id).onclick=async()=>{try{if(!wallet)throw new Error('Unlock your wallet first');await navigator.clipboard.writeText(wallet.address);toast('Address copied.');}catch(e){showError(e.message);}};
$('send-form').onsubmit=async event=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;let createdId;
  try {
    if(!wallet)throw new Error('Unlock your wallet first');
    if(syncing.size)throw new Error('Wait for chain synchronization to finish');
    const target=chooseProvider();if(!target)throw new Error('Start your node or connect to a remote node first');
    const amount=parseAmount($('send-amount').value.trim()),fee=parseAmount($('send-fee').value.trim()),to=$('recipient').value.trim();
    if(BigInt(amount)===0n)throw new Error('Amount must be positive');
    if(!confirm(`Send ${formatAmount(amount)} MINI to ${to}?\nFee: ${formatAmount(fee)} MINI`))return;
    const result=await rpc('transfer',{secret:wallet.secret,to,amount,fee,nonce:randomHex(16)});
    createdId=result.id;const request=crypto.randomUUID();submitted.unshift({id:result.id,request,peer:target,kind:'sent',value:amount,status:target==='local'?'accepted':'submitted',timestamp:Date.now()});submitted=submitted.slice(0,100);
    if(target==='local')network.broadcast(packet('transaction',{transaction:result.transaction}));else send(target,'submit-transaction',{request,transaction:result.transaction});
    await saveSubmitted();await persist();await refresh();$('send-form').reset();$('send-fee').value='0.00001000';toast(target==='local'?'Transaction accepted; waiting for a mined block.':'Submitted to node; waiting for acknowledgement.');
  }catch(error){if(createdId){await rpc('drop-transaction',{id:createdId});const record=submitted.find(t=>t.id===createdId);if(record){record.status='not delivered';await saveSubmitted();}await refresh();}showError(error.message);}finally{button.disabled=false;}
};
$('toggle-node').onclick=async()=>{try{if(!ready)throw new Error('Runtime not ready');nodeRunning=!nodeRunning;text('node-status',nodeRunning?'RUNNING':'STOPPED');text('toggle-node',nodeRunning?'Stop node':'Start node');$('node-dot').classList.toggle('running',nodeRunning);await refresh();updateNodeOptions();for(const peer of peers.filter(p=>p.connected))sendHello(peer.id);log(nodeRunning?'Node started; serving validated history.':'Node stopped; saved history retained.');if(mining)scheduleTemplate(100);}catch(e){showError(e.message);}};
function chooseProvider(){const selected=$('mining-node').value;if(selected==='local')return nodeRunning?'local':null;if(selected!=='auto')return peers.some(p=>p.id===selected&&p.node&&p.connected)?selected:null;if(nodeRunning&&!syncing.size)return 'local';return peers.filter(p=>p.node&&p.connected).sort((a,b)=>Number(b.height>=status.height)-Number(a.height>=status.height)||(latencies.get(a.id)??Infinity)-(latencies.get(b.id)??Infinity)||a.id.localeCompare(b.id))[0]?.id||null;}
function scheduleTemplate(delay=1000){clearTimeout(templateTimer);templateTimer=setTimeout(()=>fetchTemplate().catch(error=>{log(error.message);if(mining)scheduleTemplate(3000);}),delay);}
async function fetchTemplate(){
  if(!mining||!wallet)return;
  for(const miner of miners)miner.postMessage({type:'stop'});
  if(syncing.size){text('miner-job','Waiting for synchronization');scheduleTemplate(1500);return;}
  provider=chooseProvider();if(!provider){text('miner-provider','Waiting for a node');scheduleTemplate(2000);return;}
  if(provider==='local'&&!$('allow-isolated').checked&&!peers.some(p=>p.node&&p.connected)){text('miner-job','Isolated mining needs opt-in');scheduleTemplate(2000);return;}
  text('miner-provider',provider==='local'?'This browser':provider.slice(0,8));
  job={request:crypto.randomUUID(),provider};
  if(provider==='local')startJob(await rpc('template',{address:wallet.address}));else{send(provider,'get-template',{request:job.request,address:wallet.address});scheduleTemplate(15000);}
}
function startJob(block){
  if(!mining)return;clearTimeout(templateTimer);job={...job,id:crypto.randomUUID(),block};
  text('miner-job',`Block #${block.height} · ${block.bits} bits`);
  miners.forEach((worker,index)=>worker.postMessage({type:'start',job:job.id,block,index,workers:miners.length}));
  scheduleTemplate(15000);
}
function stopMining(){mining=false;clearTimeout(templateTimer);for(const worker of miners)worker.terminate();miners=[];job=null;provider=null;text('miner-status','STOPPED');text('toggle-miner','Start mining');text('miner-job','Stopped');text('hashrate','0');$('miner-dot').classList.remove('running');network.setPresence({mining:false});renderCounts();}
$('toggle-miner').onclick=async()=>{
  if(mining){stopMining();return;}
  try{
    if(!ready||!wallet)throw new Error('Unlock a wallet before mining');
    if(!chooseProvider())throw new Error('Start your node or connect to a remote node first');
    mining=true;hashes=0;hashStart=performance.now();text('miner-status','RUNNING');text('toggle-miner','Stop mining');$('miner-dot').classList.add('running');
    const count=Number($('worker-count').value);
    miners=Array.from({length:count},()=>{
      const worker=new Worker(new URL('./miner.worker.js',import.meta.url),{type:'module'});
      worker.onerror=event=>{showError(event.message||'Mining worker failed');stopMining();};
      worker.onmessage=async({data})=>{
        if(!mining||data.job!==job?.id)return;
        if(data.type==='progress'){hashes+=data.hashes;const seconds=(performance.now()-hashStart)/1000;text('hashrate',Math.round(hashes/Math.max(seconds,.01)).toLocaleString());}
        if(data.type==='error'){showError(data.error);stopMining();}
        if(data.type==='found'){
          const selected=provider;job=null;for(const miner of miners)miner.postMessage({type:'stop'});
          try{
            if(selected==='local'){await rpc('block',{block:data.block});network.broadcast(packet('block',{block:data.block}));await refresh();await persist();}
            else send(selected,'submit-block',{block:data.block});
            minedCount++;text('mined-count',minedCount);log(`Found proof for block #${data.block.height}; ${selected==='local'?'validated locally':'submitted to provider'}.`);
          }catch(error){log(`Block submission: ${error.message}`);}finally{if(mining)scheduleTemplate(300);}
        }
      };return worker;
    });
    network.setPresence({mining:true});renderCounts();await fetchTemplate();
  }catch(error){stopMining();showError(error.message);}
};
$('mining-node').onchange=()=>{if(mining)scheduleTemplate(100);};$('worker-count').onchange=()=>{if(mining){stopMining();toast('Worker count updated. Start mining to apply it.');}};
$('export-chain').onclick=async()=>{try{download('mini-bitcoin-chain.json',await rpc('snapshot'));}catch(e){showError(e.message);}};
$('import-chain').onchange=async event=>{
  const file=event.target.files[0];if(!file)return;
  try{if(file.size>32*1024*1024)throw new Error('Chain backup exceeds 32 MB');if(nodeRunning||mining)throw new Error('Stop your node and miner before importing history');
    const data=JSON.parse(await file.text());await rpc('merge',{snapshot:data});await persist();await refresh();toast('Chain backup validated and restored.');
  }catch(e){showError(e.message);}finally{event.target.value='';}
};
$('network-form').onsubmit=async event=>{
  event.preventDefault();try{const url=$('discovery-url').value.trim();const ice=JSON.parse($('ice-servers').value.trim()||'[]');if(!Array.isArray(ice)||ice.length>8)throw new Error('ICE configuration must be an array with at most 8 servers');
    for(const server of ice){const urls=Array.isArray(server.urls)?server.urls:[server.urls];if(!urls.every(u=>typeof u==='string'&&/^(stun|stuns|turn|turns):/.test(u)))throw new Error('ICE server URLs must use stun:, stuns:, turn:, or turns:');}
    currentSettings={url,ice};await write('settings',currentSettings);syncRequests.clear();syncing.clear();outboundSync.clear();checkedPeers.clear();await network.connect(url,ice);toast('Connection settings applied.');
  }catch(e){showError(e.message);}
};
async function boot(){
  page(['overview','wallet','node','miner','network'].includes(location.hash.slice(1))?location.hash.slice(1):'overview');
  try{
    walletId=walletId||await read('last-wallet');vault=walletId?await read(`wallet:${walletId}`):null;currentSettings=await read('settings');if(!currentSettings){try{const config=await fetch(new URL('../config.json',import.meta.url));currentSettings=config.ok?await config.json():{url:'',ice:[]};}catch{currentSettings={url:'',ice:[]};}}submitted=[];
    $('discovery-url').value=currentSettings.url||'';$('ice-servers').value=currentSettings.ice?.length?JSON.stringify(currentSettings.ice,null,2):'';
    status=await rpc('status');const saved=await read('best-chain');if(saved)await rpc('restore',{snapshot:saved});ready=true;await refresh();
    await network.connect(currentSettings.url||'',currentSettings.ice||[]);log('Rust/WASM ready. Saved history validated.');
    refreshTimer=setInterval(()=>{
      for(const [key,snapshot]of outboundSync)if(Date.now()-snapshot.created>60000)outboundSync.delete(key);
      for(const [id,request]of syncRequests)if(Date.now()-request.time>30000){syncRequests.delete(id);syncing.delete(id);log(`Sync timed out: ${id.slice(0,8)}`);}
      refresh().catch(e=>log(e.message));
    },5000);
    showWallet(vault?'unlock':'new');
  }catch(error){showError(error.message);text('connection-state','Runtime unavailable');text('sync-state','Build Rust/WASM before opening the app');}
}
window.addEventListener('pagehide',()=>{stopMining();network.disconnect();clearInterval(refreshTimer);});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
boot();
