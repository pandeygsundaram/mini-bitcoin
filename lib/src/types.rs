use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use crate::crypto::{PublicKey, Signature};

use crate::U256;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Blockchain{
    pub blocks : Vec<Block>,

}

impl Blockchain {
    pub fn new()-> Self {
        Blockchain { blocks: vec![] }
    }
    pub fn add_block(&mut self, block : Block){
        self.blocks.push(block);
    }    
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Block{
    pub header : BlockHeader,
    pub transactions : Vec<Transaction>,
}

impl Block{
    pub fn new( header : BlockHeader , transactions: Vec<Transaction>)->Block{
        Block { header, transactions }
    }
    pub fn hash(&self)-> ! {
        unimplemented!()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BlockHeader{
    // timemstamp of block when it is mined
    pub timestamp : DateTime<Utc>,
    // nonce which is used to mine the block
    pub nonce : u64,
    // hash of prev block
    pub prev_block_hash: [u8; 32],
    // merkle of the block's transaction
    pub merkle_root : [u8; 32],
    // the target number miner were supposed to achieve
    pub target: U256

}



impl BlockHeader{
    pub fn new ( timestamp : DateTime<Utc>, nonce : u64, prev_block_hash : [u8;32], merkle_root : [u8;32] , target : U256 )-> BlockHeader{

        BlockHeader { timestamp, nonce, prev_block_hash, merkle_root, target }
    }

    pub fn hash(&self)->!{
        unimplemented!()
    }

}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Transaction{
    pub inputs: Vec<TransactionInput>,
    pub output : Vec<TransactionOutput>
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TransactionInput{
    pub prev_transaction_output_hash:[u8; 32],
    pub signature : Signature


}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TransactionOutput{
    pub value : u64,
    pub unique_id : Uuid,
    pub pubkey : PublicKey
}

