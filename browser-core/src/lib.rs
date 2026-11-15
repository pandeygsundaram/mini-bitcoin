//! Browser protocol v2. No sockets, files, OS threads, clock, or host RNG.
//! The host supplies time and key entropy; every received block is replay-validated.
use k256::ecdsa::{
    Signature, SigningKey, VerifyingKey,
    signature::{Signer, Verifier},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const NETWORK: &str = "mini-bitcoin-browser-v2";
pub const MAX_BLOCKS: usize = 10_000;
const MAX_TX: usize = 100;
const MAX_TX_BYTES: usize = 64_000;
const MAX_BLOCK_BYTES: usize = 900_000;
const MATURITY: u32 = 2;
const INITIAL_BITS: u32 = 16;
const MAX_MONEY: u64 = 21_000_000 * 100_000_000;
type Result<T> = std::result::Result<T, String>;
fn hash<T: Serialize>(value: &T) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(value).expect("serializable protocol type"),
    ))
}
pub fn genesis() -> String {
    hash(&(
        NETWORK,
        "genesis: no allocations; reward 50; maturity 2; interval 20; target 10s",
    ))
}
fn money(s: &str) -> Result<u64> {
    let n = s.parse::<u64>().map_err(|_| "Invalid integer amount")?;
    if n > MAX_MONEY || n.to_string() != s {
        return Err("Amount out of range or noncanonical".into());
    }
    Ok(n)
}
fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .filter(|n| *n <= MAX_MONEY)
        .ok_or("Amount overflow".into())
}
fn key(secret: &str) -> Result<SigningKey> {
    SigningKey::from_slice(&hex::decode(secret).map_err(|_| "Invalid private key")?)
        .map_err(|_| "Invalid private key".into())
}
pub fn address(secret: &str) -> Result<String> {
    Ok(hex::encode(
        key(secret)?
            .verifying_key()
            .to_encoded_point(true)
            .as_bytes(),
    ))
}
fn public(address: &str) -> Result<VerifyingKey> {
    if address.len() != 66 || address != address.to_lowercase() {
        return Err("Expected compressed secp256k1 public key".into());
    }
    VerifyingKey::from_sec1_bytes(&hex::decode(address).map_err(|_| "Invalid address")?)
        .map_err(|_| "Invalid address".into())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub outpoint: String,
    pub public_key: String,
    pub signature: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Output {
    pub address: String,
    pub value: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Transaction {
    pub inputs: Vec<Input>,
    pub outputs: Vec<Output>,
    pub nonce: String,
}
impl Transaction {
    pub fn id(&self) -> String {
        hash(&(NETWORK, "transaction", self))
    }
    fn digest(&self, index: usize) -> String {
        let refs: Vec<_> = self
            .inputs
            .iter()
            .map(|i| (&i.outpoint, &i.public_key))
            .collect();
        hash(&(NETWORK, "spend", refs, &self.outputs, &self.nonce, index))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Block {
    pub network: String,
    pub height: u32,
    pub parent: String,
    pub timestamp: u64,
    pub bits: u32,
    pub nonce: String,
    pub merkle: String,
    pub transactions: Vec<Transaction>,
}
impl Block {
    pub fn id(&self) -> String {
        hash(&(
            NETWORK,
            "header",
            &self.network,
            self.height,
            &self.parent,
            self.timestamp,
            self.bits,
            &self.nonce,
            &self.merkle,
        ))
    }
    fn proof(&self) -> bool {
        if !(12..=24).contains(&self.bits) {
            return false;
        }
        let bytes = hex::decode(self.id()).expect("hash is hex");
        let leading: u32 = bytes
            .iter()
            .map(|b| b.leading_zeros())
            .take_while(|n| *n == 8)
            .sum();
        let first = bytes
            .iter()
            .find(|b| **b != 0)
            .map(|b| b.leading_zeros())
            .unwrap_or(0);
        leading + first >= self.bits
    }
}
fn merkle(txs: &[Transaction]) -> String {
    let mut layer: Vec<_> = txs.iter().map(Transaction::id).collect();
    if layer.is_empty() {
        return hash(&(NETWORK, "empty"));
    }
    while layer.len() > 1 {
        layer = layer
            .chunks(2)
            .map(|p| hash(&(NETWORK, "merkle", &p[0], p.get(1).unwrap_or(&p[0]))))
            .collect();
    }
    layer.remove(0)
}
#[derive(Clone)]
struct Coin {
    output: Output,
    height: u32,
    coinbase: bool,
}
#[derive(Default, Clone)]
struct State {
    coins: BTreeMap<String, Coin>,
    transactions: BTreeSet<String>,
}
fn reward(height: u32) -> u64 {
    (50u64 * 100_000_000).checked_shr(height / 210).unwrap_or(0)
}
fn expected_bits(chain: &[Block]) -> u32 {
    let Some(last) = chain.last() else {
        return INITIAL_BITS;
    };
    if chain.len() < 20 || chain.len() % 20 != 0 {
        return last.bits;
    }
    let elapsed = last
        .timestamp
        .saturating_sub(chain[chain.len() - 20].timestamp);
    if elapsed < 95_000 {
        (last.bits + 1).min(24)
    } else if elapsed > 380_000 {
        last.bits.saturating_sub(1).max(12)
    } else {
        last.bits
    }
}
fn apply_tx(state: &mut State, tx: &Transaction, height: u32) -> Result<u64> {
    if serde_json::to_vec(tx).map_err(|e| e.to_string())?.len() > MAX_TX_BYTES {
        return Err("Transaction too large".into());
    }
    if tx.inputs.is_empty()
        || tx.inputs.len() > 100
        || tx.outputs.is_empty()
        || tx.outputs.len() > 100
        || tx.nonce.is_empty()
        || tx.nonce.len() > 128
    {
        return Err("Invalid transaction shape".into());
    }
    let id = tx.id();
    if state.transactions.contains(&id) {
        return Err("Transaction already confirmed".into());
    }
    let mut used = BTreeSet::new();
    let mut incoming = 0;
    let mut outgoing = 0;
    for (index, input) in tx.inputs.iter().enumerate() {
        if !used.insert(input.outpoint.clone()) {
            return Err("Duplicate spend in transaction".into());
        }
        let coin = state
            .coins
            .get(&input.outpoint)
            .ok_or("Input already spent or unknown")?;
        if coin.coinbase && height < coin.height + MATURITY {
            return Err("Mining reward is not mature yet".into());
        }
        if coin.output.address != input.public_key {
            return Err("Input ownership mismatch".into());
        }
        let sig =
            Signature::from_slice(&hex::decode(&input.signature).map_err(|_| "Invalid signature")?)
                .map_err(|_| "Invalid signature")?;
        if sig.normalize_s().is_some() {
            return Err("Noncanonical signature".into());
        }
        public(&input.public_key)?
            .verify(tx.digest(index).as_bytes(), &sig)
            .map_err(|_| "Invalid transaction signature")?;
        incoming = add(incoming, money(&coin.output.value)?)?;
    }
    for output in &tx.outputs {
        public(&output.address)?;
        let value = money(&output.value)?;
        if value == 0 {
            return Err("Zero output".into());
        }
        outgoing = add(outgoing, value)?;
    }
    let fee = incoming
        .checked_sub(outgoing)
        .ok_or("Outputs exceed inputs")?;
    for input in &tx.inputs {
        state.coins.remove(&input.outpoint);
    }
    for (index, output) in tx.outputs.iter().enumerate() {
        state.coins.insert(
            format!("{id}:{index}"),
            Coin {
                output: output.clone(),
                height,
                coinbase: false,
            },
        );
    }
    state.transactions.insert(id);
    Ok(fee)
}
fn apply_block(state: &mut State, block: &Block, chain: &[Block]) -> Result<()> {
    if serde_json::to_vec(block).map_err(|e| e.to_string())?.len() > MAX_BLOCK_BYTES {
        return Err("Block too large".into());
    }
    let parent = chain.last().map(Block::id).unwrap_or_else(genesis);
    if block.network != NETWORK
        || block.height != chain.len() as u32 + 1
        || block.parent != parent
        || block.bits != expected_bits(chain)
    {
        return Err("Wrong network, parent, height, or difficulty".into());
    }
    if block.timestamp < 1_700_000_000_000
        || block.timestamp > 9_000_000_000_000_000
        || chain.last().is_some_and(|p| block.timestamp <= p.timestamp)
    {
        return Err("Invalid block timestamp".into());
    }
    let nonce = block.nonce.parse::<u64>().map_err(|_| "Invalid nonce")?;
    if nonce.to_string() != block.nonce || !block.proof() {
        return Err("Invalid proof of work".into());
    }
    if block.transactions.is_empty()
        || block.transactions.len() > MAX_TX + 1
        || merkle(&block.transactions) != block.merkle
    {
        return Err("Invalid transactions or Merkle root".into());
    }
    let coinbase = &block.transactions[0];
    if !coinbase.inputs.is_empty()
        || coinbase.outputs.len() != 1
        || coinbase.nonce != format!("{}:{}", block.height, block.parent)
    {
        return Err("Invalid coinbase".into());
    }
    public(&coinbase.outputs[0].address)?;
    let coinbase_id = coinbase.id();
    if state.transactions.contains(&coinbase_id) {
        return Err("Duplicate coinbase".into());
    }
    let mut fees = 0;
    for tx in block.transactions.iter().skip(1) {
        fees = add(fees, apply_tx(state, tx, block.height)?)?;
    }
    if money(&coinbase.outputs[0].value)? != add(reward(block.height), fees)? {
        return Err("Invalid mining reward".into());
    }
    state.coins.insert(
        format!("{coinbase_id}:0"),
        Coin {
            output: coinbase.outputs[0].clone(),
            height: block.height,
            coinbase: true,
        },
    );
    state.transactions.insert(coinbase_id);
    Ok(())
}

#[derive(Default)]
pub struct Engine {
    blocks: BTreeMap<String, Block>,
    work: BTreeMap<String, u128>,
    tip: Option<String>,
    pool: BTreeMap<String, Transaction>,
    state: State,
    reorgs: u32,
}
impl Engine {
    fn branch(&self, tip: Option<&str>) -> Result<Vec<Block>> {
        let mut cursor = tip.unwrap_or("").to_string();
        let mut chain = Vec::new();
        while !cursor.is_empty() && cursor != genesis() {
            let b = self
                .blocks
                .get(&cursor)
                .ok_or("Missing parent: synchronize chain first")?;
            chain.push(b.clone());
            cursor = b.parent.clone();
            if chain.len() > MAX_BLOCKS {
                return Err("Chain limit reached".into());
            }
        }
        chain.reverse();
        Ok(chain)
    }
    fn replay(chain: &[Block]) -> Result<State> {
        let mut state = State::default();
        for (i, b) in chain.iter().enumerate() {
            apply_block(&mut state, b, &chain[..i])?;
        }
        Ok(state)
    }
    pub fn accept(&mut self, block: Block, now: u64) -> Result<bool> {
        let id = block.id();
        if self.blocks.contains_key(&id) {
            return Ok(false);
        }
        if self.blocks.len() >= MAX_BLOCKS {
            return Err("Demo block storage limit reached; export your chain".into());
        }
        if block.timestamp > now.saturating_add(120_000) {
            return Err("Block timestamp too far in future".into());
        }
        let parent_chain = if block.parent == genesis() {
            Vec::new()
        } else {
            self.branch(Some(&block.parent))?
        };
        let mut state = Self::replay(&parent_chain)?;
        apply_block(&mut state, &block, &parent_chain)?;
        let work = self.work.get(&block.parent).copied().unwrap_or(0) + (1u128 << block.bits);
        let old_work = self
            .tip
            .as_ref()
            .and_then(|t| self.work.get(t))
            .copied()
            .unwrap_or(0);
        let wins =
            work > old_work || (work == old_work && self.tip.as_ref().is_none_or(|t| id < *t));
        self.work.insert(id.clone(), work);
        self.blocks.insert(id.clone(), block.clone());
        if wins {
            let old = self.branch(self.tip.as_deref())?;
            if self.tip.is_some() && self.tip.as_ref() != Some(&block.parent) {
                self.reorgs += 1;
            }
            let mut candidates = self.pool.clone();
            for b in old {
                for tx in b.transactions.into_iter().skip(1) {
                    candidates.insert(tx.id(), tx);
                }
            }
            self.tip = Some(id);
            self.state = state;
            self.pool.clear();
            for tx in candidates.into_values() {
                let _ = self.submit(tx);
            }
        }
        Ok(wins)
    }
    pub fn submit(&mut self, tx: Transaction) -> Result<String> {
        let id = tx.id();
        if self.pool.contains_key(&id) {
            return Ok(id);
        }
        if self.pool.len() >= 1000 {
            return Err("Mempool full".into());
        }
        if tx
            .inputs
            .iter()
            .any(|i| !self.state.coins.contains_key(&i.outpoint))
        {
            return Err("Spending unconfirmed outputs is not supported".into());
        }
        let height = self.height() + 1;
        let mut state = self.state.clone();
        for pending in self.pool.values() {
            apply_tx(&mut state, pending, height)?;
        }
        apply_tx(&mut state, &tx, height)?;
        self.pool.insert(id.clone(), tx);
        Ok(id)
    }
    pub fn height(&self) -> u32 {
        self.tip
            .as_ref()
            .and_then(|t| self.blocks.get(t))
            .map(|b| b.height)
            .unwrap_or(0)
    }
    pub fn template(&self, address: &str, now: u64) -> Result<Block> {
        public(address)?;
        let chain = self.branch(self.tip.as_deref())?;
        let height = self.height() + 1;
        let mut state = self.state.clone();
        let mut fees = 0;
        let mut txs = Vec::new();
        let mut tx_bytes = 0;
        for tx in self.pool.values().take(MAX_TX) {
            let size = serde_json::to_vec(tx).map_err(|e| e.to_string())?.len();
            if tx_bytes + size > MAX_BLOCK_BYTES - 10_000 {
                continue;
            }
            let mut candidate = state.clone();
            if let Ok(fee) = apply_tx(&mut candidate, tx, height) {
                fees = add(fees, fee)?;
                tx_bytes += size;
                state = candidate;
                txs.push(tx.clone());
            }
        }
        let parent = self.tip.clone().unwrap_or_else(genesis);
        txs.insert(
            0,
            Transaction {
                inputs: Vec::new(),
                outputs: vec![Output {
                    address: address.into(),
                    value: add(reward(height), fees)?.to_string(),
                }],
                nonce: format!("{height}:{parent}"),
            },
        );
        Ok(Block {
            network: NETWORK.into(),
            height,
            parent,
            timestamp: now.max(
                chain
                    .last()
                    .map(|b| b.timestamp + 1)
                    .unwrap_or(1_700_000_000_000),
            ),
            bits: expected_bits(&chain),
            nonce: "0".into(),
            merkle: merkle(&txs),
            transactions: txs,
        })
    }
    pub fn transfer(
        &self,
        secret: &str,
        to: &str,
        amount: &str,
        fee: &str,
        nonce: &str,
    ) -> Result<Transaction> {
        public(to)?;
        let owner = address(secret)?;
        let amount = money(amount)?;
        let fee = money(fee)?;
        if amount == 0 {
            return Err("Amount must be positive".into());
        }
        let needed = add(amount, fee)?;
        let mut state = self.state.clone();
        for tx in self.pool.values() {
            apply_tx(&mut state, tx, self.height() + 1)?;
        }
        let mut inputs = Vec::new();
        let mut total = 0;
        for (outpoint, coin) in &state.coins {
            if self.state.coins.contains_key(outpoint)
                && coin.output.address == owner
                && (!coin.coinbase || self.height() + 1 >= coin.height + MATURITY)
            {
                inputs.push(Input {
                    outpoint: outpoint.clone(),
                    public_key: owner.clone(),
                    signature: String::new(),
                });
                total = add(total, money(&coin.output.value)?)?;
                if total >= needed {
                    break;
                }
            }
        }
        if total < needed {
            return Err("Insufficient spendable funds; rewards mature after two blocks".into());
        }
        let mut outputs = vec![Output {
            address: to.into(),
            value: amount.to_string(),
        }];
        if total > needed {
            outputs.push(Output {
                address: owner,
                value: (total - needed).to_string(),
            });
        }
        let mut tx = Transaction {
            inputs,
            outputs,
            nonce: nonce.into(),
        };
        let signing = key(secret)?;
        for i in 0..tx.inputs.len() {
            let sig: Signature = signing.sign(tx.digest(i).as_bytes());
            tx.inputs[i].signature = hex::encode(sig.to_bytes());
        }
        Ok(tx)
    }
    pub fn snapshot(&self) -> Value {
        let mut blocks: Vec<_> = self.blocks.values().cloned().collect();
        blocks.sort_by_key(|b| (b.height, b.id()));
        json!({"network":NETWORK,"genesis":genesis(),"tip":self.tip.clone().unwrap_or_else(genesis),"work":self.tip.as_ref().and_then(|t|self.work.get(t)).copied().unwrap_or(0).to_string(),"blocks":blocks,"pending":self.pool.values().collect::<Vec<_>>()})
    }
    pub fn restore(&mut self, data: Value, now: u64) -> Result<()> {
        if data["network"] != NETWORK || data["genesis"] != genesis() {
            return Err("Backup belongs to a different network".into());
        }
        let mut blocks: Vec<Block> =
            serde_json::from_value(data["blocks"].clone()).map_err(|e| e.to_string())?;
        if blocks.len() > MAX_BLOCKS {
            return Err("Backup too large".into());
        }
        blocks.sort_by_key(|b| (b.height, b.id()));
        let mut replacement = Engine::default();
        for block in blocks {
            replacement.accept(block, now)?;
        }
        if let Some(pending) = data["pending"].as_array() {
            for tx in pending.iter().take(1000) {
                if let Ok(tx) = serde_json::from_value(tx.clone()) {
                    let _ = replacement.submit(tx);
                }
            }
        }
        *self = replacement;
        Ok(())
    }
    pub fn merge(&mut self, data: Value, now: u64) -> Result<()> {
        let mut incoming = Engine::default();
        incoming.restore(data, now)?;
        let mut combined = self.snapshot();
        let blocks = combined["blocks"].as_array_mut().unwrap();
        let ids: BTreeSet<_> = self.blocks.keys().cloned().collect();
        blocks.extend(
            incoming
                .blocks
                .values()
                .filter(|b| !ids.contains(&b.id()))
                .map(|b| serde_json::to_value(b).unwrap()),
        );
        let pending = combined["pending"].as_array_mut().unwrap();
        pending.extend(
            incoming
                .pool
                .values()
                .map(|tx| serde_json::to_value(tx).unwrap()),
        );
        self.restore(combined, now)
    }
    pub fn status(&self, owner: &str) -> Result<Value> {
        let chain = self.branch(self.tip.as_deref())?;
        let mut balance = 0;
        let mut immature = 0;
        let mut locked = 0;
        let reserved: BTreeSet<_> = self
            .pool
            .values()
            .flat_map(|t| t.inputs.iter().map(|i| i.outpoint.clone()))
            .collect();
        for (outpoint, coin) in &self.state.coins {
            if coin.output.address == owner {
                let value = money(&coin.output.value)?;
                balance = add(balance, value)?;
                if coin.coinbase && self.height() + 1 < coin.height + MATURITY {
                    immature = add(immature, value)?;
                } else if reserved.contains(outpoint) {
                    locked = add(locked, value)?;
                }
            }
        }
        let mut activity = Vec::new();
        let mut owners = BTreeMap::new();
        for b in &chain {
            for (index, tx) in b.transactions.iter().enumerate() {
                let sent = tx
                    .inputs
                    .iter()
                    .any(|i| owners.get(&i.outpoint).is_some_and(|a| a == owner));
                let received: u64 = tx
                    .outputs
                    .iter()
                    .filter(|o| o.address == owner)
                    .map(|o| money(&o.value).unwrap_or(0))
                    .sum();
                if sent || received > 0 {
                    activity.push(json!({"id":tx.id(),"kind":if index==0 {"mined"} else if sent {"sent"} else {"received"},"value":if sent { tx.outputs.iter().filter(|o|o.address!=owner).map(|o|money(&o.value).unwrap_or(0)).sum::<u64>().to_string() } else { received.to_string() },"height":b.height,"timestamp":b.timestamp,"confirmations":self.height()-b.height+1,"status":"confirmed"}));
                }
                for (i, o) in tx.outputs.iter().enumerate() {
                    owners.insert(format!("{}:{i}", tx.id()), o.address.clone());
                }
            }
        }
        for tx in self.pool.values() {
            let sent = tx.inputs.iter().any(|i| i.public_key == owner);
            let received: u64 = tx
                .outputs
                .iter()
                .filter(|o| o.address == owner)
                .map(|o| money(&o.value).unwrap_or(0))
                .sum();
            if sent || received > 0 {
                activity.push(json!({"id":tx.id(),"kind":if sent {"sent"} else {"received"},"value":if sent { tx.outputs.iter().filter(|o|o.address!=owner).map(|o|money(&o.value).unwrap_or(0)).sum::<u64>().to_string() } else { received.to_string() },"confirmations":0,"status":"pending"}));
            }
        }
        activity.reverse();
        activity.truncate(100);
        let interval = if chain.len() > 1 {
            let n = chain.len().min(11);
            let seconds = (chain.last().unwrap().timestamp - chain[chain.len() - n].timestamp)
                as f64
                / 1000.0;
            Some(seconds / (n - 1) as f64)
        } else {
            None
        };
        Ok(
            json!({"network":NETWORK,"genesis":genesis(),"height":self.height(),"tip":self.tip.clone().unwrap_or_else(genesis),"work":self.tip.as_ref().and_then(|t|self.work.get(t)).copied().unwrap_or(0).to_string(),"balance":balance.to_string(),"immature":immature.to_string(),"locked":locked.to_string(),"spendable":(balance-immature-locked).to_string(),"pending":self.pool.len(),"bits":expected_bits(&chain),"reorgs":self.reorgs,"averageBlockSeconds":interval,"activity":activity,"blocks":chain.iter().rev().take(12).map(|b|json!({"height":b.height,"id":b.id(),"timestamp":b.timestamp,"transactions":b.transactions.len(),"bits":b.bits})).collect::<Vec<_>>()}),
        )
    }
    pub fn dispatch(&mut self, req: Value) -> Result<Value> {
        let text = |name: &str| req[name].as_str().ok_or_else(|| format!("Missing {name}"));
        let now = req["now"].as_u64().unwrap_or(0);
        match text("op")? {
            "wallet" => Ok(json!({"address":address(text("secret")?)?})),
            "status" => self.status(req["address"].as_str().unwrap_or("")),
            "snapshot" => Ok(self.snapshot()),
            "merge" => {
                self.merge(req["snapshot"].clone(), now)?;
                Ok(json!(true))
            }
            "restore" => {
                self.restore(req["snapshot"].clone(), now)?;
                Ok(json!(true))
            }
            "template" => Ok(serde_json::to_value(self.template(text("address")?, now)?).unwrap()),
            "block" => {
                let b = serde_json::from_value(req["block"].clone()).map_err(|e| e.to_string())?;
                Ok(json!({"changed":self.accept(b,now)?}))
            }
            "drop-transaction" => {
                self.pool.remove(text("id")?);
                Ok(json!(true))
            }
            "transaction" => {
                let tx = serde_json::from_value(req["transaction"].clone())
                    .map_err(|e| e.to_string())?;
                Ok(json!({"id":self.submit(tx)?}))
            }
            "transfer" => {
                let tx = self.transfer(
                    text("secret")?,
                    text("to")?,
                    text("amount")?,
                    text("fee")?,
                    text("nonce")?,
                )?;
                let id = self.submit(tx.clone())?;
                Ok(json!({"id":id,"transaction":tx}))
            }
            "mine" => {
                let mut b: Block =
                    serde_json::from_value(req["block"].clone()).map_err(|e| e.to_string())?;
                if b.network != NETWORK || !(12..=24).contains(&b.bits) {
                    return Err("Invalid mining job".into());
                }
                let steps = req["steps"].as_u64().unwrap_or(2000).clamp(1, 20_000);
                let stride = req["stride"].as_u64().unwrap_or(1).clamp(1, 32);
                let mut nonce = b.nonce.parse::<u64>().map_err(|_| "Invalid nonce")?;
                for count in 0..steps {
                    b.nonce = nonce.to_string();
                    if b.proof() {
                        return Ok(json!({"found":true,"block":b,"hashes":count+1}));
                    }
                    nonce = nonce.checked_add(stride).ok_or("Nonce range exhausted")?;
                }
                b.nonce = nonce.to_string();
                Ok(json!({"found":false,"block":b,"hashes":steps}))
            }
            _ => Err("Unknown operation".into()),
        }
    }
}

// A tiny JSON ABI avoids wasm-bindgen CLI version coupling. Only one request runs
// at a time per worker; response memory lives until the next request.
#[cfg(target_arch = "wasm32")]
mod abi {
    use super::*;
    use std::cell::RefCell;
    thread_local! { static ENGINE:RefCell<Engine>=RefCell::new(Engine::default()); static RESPONSE:RefCell<Vec<u8>>=const { RefCell::new(Vec::new()) }; }
    #[unsafe(no_mangle)]
    pub extern "C" fn allocate(len: usize) -> *mut u8 {
        let bytes = vec![0u8; len].into_boxed_slice();
        Box::into_raw(bytes) as *mut u8
    }
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn request(ptr: *mut u8, len: usize) -> *const u8 {
        let input = unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) };
        let result = serde_json::from_slice::<Value>(&input)
            .map_err(|e| e.to_string())
            .and_then(|r| ENGINE.with(|e| e.borrow_mut().dispatch(r)));
        let value = match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error}),
        };
        RESPONSE.with(|r| {
            let mut r = r.borrow_mut();
            *r = serde_json::to_vec(&value).unwrap();
            r.as_ptr()
        })
    }
    #[unsafe(no_mangle)]
    pub extern "C" fn response_len() -> usize {
        RESPONSE.with(|r| r.borrow().len())
    }
}
