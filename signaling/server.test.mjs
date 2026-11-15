import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import { once } from 'node:events';
import { createSignalingServer, NETWORK } from './server.mjs';
// Exercise the actual HTTP request handler in process. No listening socket is
// required, so these tests also run in restricted CI/sandbox environments.
function setup(t) {
  const server=createSignalingServer({origins:['https://app.example'],ttl:2000});
  const open=new Set();t.after(()=>{for(const response of open)response.destroy();server.emit('close');});
  function request(path,{body,token,origin='https://app.example',method=body===undefined?'GET':'POST'}={}){
    const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
    Object.assign(req,{method,url:path,headers:{origin,...(token?{authorization:`Bearer ${token}`}:{})},socket:{remoteAddress:'127.0.0.1'}});
    const res=new PassThrough();res.headers={};res.statusCode=200;res.setHeader=(name,value)=>res.headers[name]=value;
    res.writeHead=(status,headers={})=>{res.statusCode=status;Object.assign(res.headers,headers);res.headersSent=true;return res;};
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.content=()=>Buffer.concat(chunks).toString();
    open.add(res);server.emit('request',req,res);return res;
  }
  const post=async(path,body,token)=>{const res=request(path,{body,token});await once(res,'finish');return {status:res.statusCode,body:JSON.parse(res.content())};};
  return {request,post};
}
test('registration sanitizes roles and rejects wrong networks/origins',async t=>{
  const {request,post}=setup(t);
  assert.equal((await post('/v1/register',{network:'wrong'})).status,400);
  const a=await post('/v1/register',{network:NETWORK,presence:{node:true,mining:'yes',height:3,secret:'never publish'}});
  assert.equal(a.status,200);assert.equal(a.body.peers[0].node,true);assert.equal(a.body.peers[0].mining,false);assert.ok(!('secret' in a.body.peers[0]));
  const denied=request('/health',{origin:'https://evil.example'});await once(denied,'finish');assert.equal(denied.statusCode,403);
  assert.equal((await post('/v1/presence',{node:true},'bad')).status,401);
});
test('signals arriving before an event stream opens are delivered to that peer only',async t=>{
  const {request,post}=setup(t);
  const a=(await post('/v1/register',{network:NETWORK})).body;
  const b=(await post('/v1/register',{network:NETWORK})).body;
  const signal={type:'offer',description:{type:'offer',sdp:'example'}};
  assert.equal((await post('/v1/signal',{to:b.id,signal},a.token)).status,200);
  const response=request('/v1/events',{token:b.token});
  await new Promise(resolve=>setImmediate(resolve));const content=response.content();
  assert.ok(content.includes('event: peers'));assert.ok(content.includes(JSON.stringify({from:a.id,signal})));
  assert.ok(!content.includes(a.token));assert.ok(!content.includes(b.token));
});
test('presence and departure update discovery without carrying chain data',async t=>{
  const {request,post}=setup(t);const a=(await post('/v1/register',{network:NETWORK})).body;
  const response=request('/v1/events',{token:a.token});await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await post('/v1/presence',{node:true,mining:true,height:8},a.token)).status,200);
  assert.ok(response.content().includes('"height":8'));assert.ok(!response.content().includes('transactions'));
  assert.equal((await post('/v1/leave',{},a.token)).status,200);
  assert.equal((await post('/v1/presence',{},a.token)).status,401);
});
