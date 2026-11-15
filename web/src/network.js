export const NETWORK = 'mini-bitcoin-browser-v2';
const MAX_MESSAGE = 4 * 1024 * 1024;
const CHUNK = 12000;
const MAX_PEERS = 8;
export class PeerNetwork {
  constructor(events = {}) {
    this.events = events; this.id = crypto.randomUUID(); this.peers = new Map(); this.links = new Map(); this.fragments = new Map();
    this.presence = { node: false, mining: false, height: 0 }; this.generation = 0; this.iceServers = [];
  }
  async connect(base = '', customIce = []) {
    this.disconnect(); const generation = ++this.generation;
    this.base = base.replace(/\/$/, ''); this.customIce = customIce;
    if (!base) {
      this.channel = new BroadcastChannel(NETWORK);
      this.channel.onmessage = ({ data }) => {
        if (data.network !== NETWORK || data.from === this.id) return;
        if (data.kind === 'presence') {
          const fresh = !this.peers.has(data.from);
          this.peers.set(data.from, { id: data.from, ...data.presence, lastSeen: Date.now(), connected: true });
          this.emitPeers(); if (fresh) { this.announce(); this.events.connected?.(data.from); }
        } else if (data.kind === 'leave') { this.peers.delete(data.from); this.emitPeers(); }
        else if (data.to === this.id || data.to === '*') this.receive(data.from, data.payload);
      };
      this.timer = setInterval(() => { this.announce(); for (const [id,p] of this.peers) if (Date.now()-p.lastSeen > 16000) this.peers.delete(id); this.emitPeers(); }, 4000);
      this.announce(); this.events.state?.('Local tabs connected'); return;
    }
    if (!/^https?:\/\//.test(base)) throw new Error('Discovery URL must start with https:// (or http:// for local development).');
    if (location.protocol === 'https:' && !base.startsWith('https://')) throw new Error('An HTTPS page needs an HTTPS discovery service.');
    const start = async () => {
      let delay = 1000;
      while (this.generation === generation) {
        try {
          this.events.state?.('Connecting to discovery…');
          const session = await this.api('/v1/register', { network: NETWORK, presence: this.presence }, false);
          if (this.generation !== generation) return;
          for (const link of this.links.values()) { clearTimeout(link.timeout); link.pc.close(); }
          this.links.clear(); this.peers.clear();
          this.id = session.id; this.token = session.token; this.iceServers = [...session.iceServers, ...customIce];
          this.updatePeers(session.peers); this.events.state?.('Global discovery connected'); delay = 1000;
          await this.stream(generation);
          throw new Error('Discovery connection closed');
        } catch (error) {
          if (this.generation !== generation) return;
          this.events.state?.(`Discovery unavailable; retrying (${error.message})`);
          for (const [id,p] of this.peers) if (!this.links.get(id)?.channel || this.links.get(id).channel.readyState !== 'open') this.peers.delete(id);
          this.emitPeers();
          await new Promise(resolve => { this.retryTimer = setTimeout(resolve, delay); this.retryResolve = resolve; }); delay = Math.min(delay*2, 15000);
        }
      }
    };
    // Heartbeats renew discovery leases. Open peer connections survive discovery interruptions.
    this.timer = setInterval(() => this.announce(), 10000);
    this.sessionTask = start();
  }
  async api(path, data, authenticated = true) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(this.base+path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${this.token}` } : {}) }, body: JSON.stringify(data), signal: controller.signal });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`); return body;
    } finally { clearTimeout(timer); }
  }
  async stream(generation) {
    this.streamController = new AbortController();
    const response = await fetch(this.base+'/v1/events', { headers: { Authorization: `Bearer ${this.token}` }, signal: this.streamController.signal });
    if (!response.ok) throw new Error('Signaling session expired');
    const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
    while (this.generation === generation) {
      const { value, done } = await reader.read(); if (done) return;
      pending += decoder.decode(value, { stream: true });
      if (pending.length > MAX_MESSAGE) throw new Error('Oversized discovery response');
      let end;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0,end); pending = pending.slice(end+2);
        const type = frame.split('\n').find(l=>l.startsWith('event: '))?.slice(7);
        const payload = frame.split('\n').filter(l=>l.startsWith('data: ')).map(l=>l.slice(6)).join('\n');
        if (!payload) continue;
        const data = JSON.parse(payload);
        if (type === 'peers') this.updatePeers(data);
        if (type === 'signal') this.signal(data.from, data.signal).catch(e=>this.events.error?.(e.message));
      }
    }
  }
  updatePeers(list) {
    const next = new Map();
    for (const p of list) if (p.id !== this.id) next.set(p.id, { ...p, connected: this.links.get(p.id)?.channel?.readyState === 'open' });
    // Keep directly connected peers during a discovery reconnect.
    for (const [id, link] of this.links) if (link.channel?.readyState === 'open' && !next.has(id)) next.set(id, { ...(this.peers.get(id)||{}), id, connected: true });
    this.peers = next; this.emitPeers();
    for (const p of next.values()) if ((p.node || this.presence.node) && this.id < p.id && !this.links.has(p.id) && this.links.size < MAX_PEERS) this.offer(p.id).catch(e=>this.events.error?.(e.message));
  }
  emitPeers() { this.events.peers?.([...this.peers.values()]); }
  announce() {
    if (this.channel) this.channel.postMessage({ network: NETWORK, kind: 'presence', from: this.id, presence: this.presence });
    else if (this.token) this.api('/v1/presence', this.presence).catch(()=>{});
  }
  setPresence(presence) {
    Object.assign(this.presence, presence); this.announce();
    if (this.base) this.updatePeers([...this.peers.values()]);
  }
  createLink(id) {
    let link = this.links.get(id); if (link) return link;
    if (this.links.size >= MAX_PEERS) throw new Error('Peer connection limit reached');
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    link = { pc, candidates: [], queue: [], queuedBytes: 0 }; this.links.set(id, link);
    link.timeout = setTimeout(() => { if(link.channel?.readyState !== 'open') { if(this.links.get(id)===link)this.links.delete(id); pc.close(); this.events.error?.('Peer setup timed out; check STUN/TURN settings'); } }, 20000);
    pc.onicecandidate = ({candidate}) => { if (candidate) this.api('/v1/signal', { to: id, signal: { type: 'candidate', candidate: candidate.toJSON() } }).catch(()=>{}); };
    pc.ondatachannel = ({channel}) => this.attach(id, channel);
    pc.onconnectionstatechange = () => {
      if (['failed','closed'].includes(pc.connectionState)) { if(this.links.get(id)===link)this.links.delete(id); pc.close(); const p=this.peers.get(id); if(p)p.connected=false; this.emitPeers(); }
    };
    return link;
  }
  attach(id, channel) {
    const link = this.links.get(id); link.channel = channel; channel.bufferedAmountLowThreshold = 65536;
    const flush = () => { while (link.queue.length && channel.readyState === 'open' && channel.bufferedAmount < 262144) { const item = link.queue.shift(); link.queuedBytes -= item.length; channel.send(item); } };
    link.flush = flush; channel.onbufferedamountlow = flush;
    channel.onopen = () => { clearTimeout(link.timeout); const p=this.peers.get(id); if(p)p.connected=true; this.emitPeers(); this.events.connected?.(id); flush(); };
    channel.onclose = () => { if(this.links.get(id)===link)this.links.delete(id); link.pc.close(); const p=this.peers.get(id); if(p)p.connected=false; this.emitPeers(); };
    channel.onmessage = ({data}) => {
      if (typeof data !== 'string' || data.length > CHUNK + 1024) return;
      try { this.receive(id, JSON.parse(data)); } catch { this.events.error?.('Ignored malformed peer message'); }
    };
  }
  async offer(id) {
    const link = this.createLink(id); this.attach(id,link.pc.createDataChannel('blocks', { ordered: true }));
    await link.pc.setLocalDescription(await link.pc.createOffer());
    await this.api('/v1/signal', { to:id, signal:{ type:'offer', description:link.pc.localDescription.toJSON() } });
  }
  async signal(id, signal) {
    const p=this.peers.get(id); if (!p || !(p.node || this.presence.node)) return;
    const link=this.createLink(id);
    if (signal.type === 'candidate') { if(link.pc.remoteDescription) await link.pc.addIceCandidate(signal.candidate); else if(link.candidates.length<100) link.candidates.push(signal.candidate); return; }
    if (signal.type === 'offer') {
      await link.pc.setRemoteDescription(signal.description);
      for(const c of link.candidates.splice(0)) await link.pc.addIceCandidate(c);
      await link.pc.setLocalDescription(await link.pc.createAnswer());
      await this.api('/v1/signal', { to:id, signal:{type:'answer',description:link.pc.localDescription.toJSON()} });
    } else if(signal.type === 'answer') { await link.pc.setRemoteDescription(signal.description); for(const c of link.candidates.splice(0)) await link.pc.addIceCandidate(c); }
  }
  send(id, message) {
    const text=JSON.stringify(message); if(text.length>MAX_MESSAGE) throw new Error('Peer message exceeds size limit');
    const messageId=crypto.randomUUID(); const total=Math.ceil(text.length/CHUNK);
    for(let index=0;index<total;index++) {
      const part={messageId,index,total,text:text.slice(index*CHUNK,(index+1)*CHUNK)};
      if(this.channel) this.channel.postMessage({network:NETWORK,kind:'data',from:this.id,to:id,payload:part});
      else {
        const link=this.links.get(id); if(link?.channel?.readyState!=='open') throw new Error('Peer is not connected');
        const item=JSON.stringify(part);
        if(link.queuedBytes+item.length>MAX_MESSAGE*2) throw new Error('Peer send queue full');
        link.queue.push(item);link.queuedBytes+=item.length;link.flush();
      }
    }
  }
  broadcast(message, except) { for(const p of this.peers.values()) if(p.connected && p.id!==except) { try{this.send(p.id,message);}catch(e){this.events.error?.(e.message);} } }
  receive(id, part) {
    if (!part || typeof part.messageId!=='string' || part.messageId.length>64 || !Number.isInteger(part.total) || part.total<1 || part.total>Math.ceil(MAX_MESSAGE/CHUNK) || !Number.isInteger(part.index) || part.index<0 || part.index>=part.total || typeof part.text!=='string' || part.text.length>CHUNK) return;
    const key=id+':'+part.messageId;
    for(const [key,entry] of this.fragments) if(Date.now()-entry.time>30000)this.fragments.delete(key);
    let entry=this.fragments.get(key);
    if(!entry) { if(this.fragments.size>=16)return; entry={parts:new Map(),total:part.total,time:Date.now(),size:0};this.fragments.set(key,entry); }
    if(entry.total!==part.total || entry.parts.has(part.index))return;
    entry.size+=part.text.length; if(entry.size>MAX_MESSAGE){this.fragments.delete(key);return;} entry.parts.set(part.index,part.text);
    if(entry.parts.size===entry.total) {
      this.fragments.delete(key);
      try { const message=JSON.parse(Array.from({length:entry.total},(_,i)=>entry.parts.get(i)).join('')); if(message.network!==NETWORK)return; this.events.message?.(id,message); } catch {this.events.error?.('Ignored invalid protocol message');}
    }
  }
  disconnect() {
    this.generation++; clearInterval(this.timer); clearTimeout(this.retryTimer);this.retryResolve?.();this.retryResolve=null;
    this.streamController?.abort();
    if(this.token && this.base)this.api('/v1/leave',{}).catch(()=>{});
    if(this.channel){this.channel.postMessage({network:NETWORK,kind:'leave',from:this.id});this.channel.close();this.channel=null;}
    for(const link of this.links.values()){clearTimeout(link.timeout);link.pc.close();}this.links.clear();this.peers.clear();this.fragments.clear();this.token=null;this.emitPeers();
  }
}
