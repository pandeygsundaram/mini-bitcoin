import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerNetwork, NETWORK } from '../src/network.js';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('local tabs discover each other, transfer chunked messages, and leave',async()=>{
  const received=[];const a=new PeerNetwork();const b=new PeerNetwork({message:(id,m)=>received.push([id,m])});
  try{
    await a.connect();await b.connect();await pause(150);
    assert.ok(a.peers.has(b.id));assert.ok(b.peers.has(a.id));
    const payload={network:NETWORK,type:'test',text:'x'.repeat(80000)};
    a.send(b.id,payload);await pause(150);assert.deepEqual(received,[[a.id,payload]]);
    a.disconnect();await pause(100);assert.ok(!b.peers.has(a.id));
  }finally{a.disconnect();b.disconnect();}
});
test('malformed and oversized fragments cannot dispatch protocol messages',()=>{
  let count=0;const n=new PeerNetwork({message:()=>count++});
  for(const part of [{},{messageId:'x',index:-1,total:1,text:'{}'},{messageId:'x',index:0,total:100000,text:'{}'},{messageId:'x',index:0,total:1,text:'x'.repeat(13000)}])n.receive('peer',part);
  n.receive('peer',{messageId:'x',index:0,total:1,text:JSON.stringify({network:'wrong',type:'block'})});
  assert.equal(count,0);assert.throws(()=>n.send('peer',{text:'x'.repeat(5*1024*1024)}),/size limit/);
});
