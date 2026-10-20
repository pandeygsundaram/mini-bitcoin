use anyhow::{anyhow, Result};
use btclib::crypto::{PrivateKey, PublicKey, Signature};
use btclib::network::Message;
use btclib::types::{Transaction, TransactionInput, TransactionOutput};
use btclib::util::Saveable;
use crossbeam_skiplist::SkipMap;
use kanal::AsyncSender;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::sync::Mutex;

#[derive(Serialize, Deserialize, Clone)]
pub struct Key {
    pub public: PathBuf,
    pub private: PathBuf,
}

#[derive(Clone)]
pub struct LoadedKey {
    pub public: PublicKey,
    pub private: PrivateKey,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Recipient {
    pub name: String,
    pub key: PathBuf,
}

#[derive(Clone)]
pub struct LoadedRecipient {
    #[allow(dead_code)]
    pub name: String,
    pub key: PublicKey,
}

impl Recipient {
    pub fn load(&self) -> Result<LoadedRecipient> {
        let key = PublicKey::load_from_file(&self.key)?;
        Ok(LoadedRecipient {
            name: self.name.clone(),
            key,
        })
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub enum FeeType {
    Fixed,
    Percent,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FeeConfig {
    pub fee_type: FeeType,
    pub value: f64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Config {
    pub my_keys: Vec<Key>,
    pub contacts: Vec<Recipient>,
    pub default_node: String,
    pub fee_config: FeeConfig,
}

#[derive(Clone)]
pub struct UtxoStore {
    pub my_keys: Vec<LoadedKey>,
    pub utxos: Arc<SkipMap<PublicKey, Vec<(bool, TransactionOutput)>>>,
}

impl UtxoStore {
    pub fn new() -> Self {
        UtxoStore {
            my_keys: Vec::new(),
            utxos: Arc::new(SkipMap::new()),
        }
    }

    pub fn add_key(&mut self, key: LoadedKey) {
        self.my_keys.push(key);
    }
}

pub struct Core {
    pub config: Config,
    pub utxos: UtxoStore,
    pub tx_sender: AsyncSender<Transaction>,
    pub stream: Mutex<TcpStream>,
}

impl Core {
    pub async fn load(config_path: PathBuf) -> Result<Self> {
        let config: Config = toml::from_str(&fs::read_to_string(&config_path)?)?;
        let mut utxos = UtxoStore::new();
        let stream = TcpStream::connect(&config.default_node).await?;

        for key in &config.my_keys {
            let public = PublicKey::load_from_file(&key.public)?;
            let private = PrivateKey::load_from_file(&key.private)?;
            utxos.add_key(LoadedKey { public, private });
        }

        let (tx_sender, _) = kanal::bounded(10);
        Ok(Core {
            config,
            utxos,
            tx_sender: tx_sender.clone_async(),
            stream: Mutex::new(stream),
        })
    }

    pub async fn fetch_utxos(&self) -> Result<()> {
        let mut stream = self.stream.lock().await;
        for key in &self.utxos.my_keys {
            let message = Message::FetchUTXOs(key.public.clone());
            message.send_async(&mut *stream).await?;
            if let Message::UTXOs(utxos) = Message::receive_async(&mut *stream).await? {
                self.utxos.utxos.insert(
                    key.public.clone(),
                    utxos
                        .into_iter()
                        .map(|(output, marked)| (marked, output))
                        .collect(),
                );
            } else {
                return Err(anyhow!("Unexpected response from node when fetching UTXOs"));
            }
        }
        Ok(())
    }

    pub async fn send_transaction(&self, transaction: Transaction) -> Result<()> {
        let mut stream = self.stream.lock().await;
        let message = Message::SubmitTransaction(transaction);
        message.send_async(&mut *stream).await?;
        Ok(())
    }

    pub fn get_balance(&self) -> u64 {
        self.utxos
            .utxos
            .iter()
            .map(|entry| {
                entry
                    .value()
                    .iter()
                    .filter(|(marked, _)| !*marked)
                    .map(|(_, utxo)| utxo.value)
                    .sum::<u64>()
            })
            .sum()
    }

    pub async fn create_transaction(&self, recipient: &PublicKey, amount: u64) -> Result<Transaction> {
        let fee = self.calculate_fee(amount);
        let total_amount = amount + fee;
        let mut inputs = Vec::new();
        let mut input_sum = 0;

        for entry in self.utxos.utxos.iter() {
            let pubkey = entry.key();
            let utxos = entry.value();
            for (marked, utxo) in utxos.iter() {
                if *marked {
                    continue;
                }
                if input_sum >= total_amount {
                    break;
                }
                let private_key = &self
                    .utxos
                    .my_keys
                    .iter()
                    .find(|k| k.public == *pubkey)
                    .unwrap()
                    .private;

                inputs.push(TransactionInput {
                    prev_transaction_output_hash: utxo.hash(),
                    signature: Signature::sign_output(&utxo.hash(), private_key),
                });
                input_sum += utxo.value;
            }
            if input_sum >= total_amount {
                break;
            }
        }

        if input_sum < total_amount {
            return Err(anyhow!(
                "Insufficient funds: have {} satoshis, need {} satoshis (amount: {}, fee: {})",
                input_sum,
                total_amount,
                amount,
                fee
            ));
        }

        let mut outputs = vec![TransactionOutput {
            value: amount,
            unique_id: uuid::Uuid::new_v4(),
            pubkey: recipient.clone(),
        }];

        if input_sum > total_amount {
            outputs.push(TransactionOutput {
                value: input_sum - total_amount,
                unique_id: uuid::Uuid::new_v4(),
                pubkey: self.utxos.my_keys[0].public.clone(),
            });
        }

        Ok(Transaction::new(inputs, outputs))
    }

    fn calculate_fee(&self, amount: u64) -> u64 {
        match self.config.fee_config.fee_type {
            FeeType::Fixed => self.config.fee_config.value as u64,
            FeeType::Percent => (amount as f64 * self.config.fee_config.value / 100.0) as u64,
        }
    }
}
