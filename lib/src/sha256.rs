//we need the hex crate, so that we can easily parse SHA-256 hashes from the
// sha256 crate, which returns them as Strings:

use core::fmt;

use serde::{Deserialize, Serialize};
use sha256::digest;

use crate::U256;


#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hash(U256);

impl Hash {
    // this will take any data(struct) as long as it implements serialize
    // and return a hash of it
    pub fn hash<T: serde::Serialize>(data: &T) -> Self {
        let mut serialized: Vec<u8> = vec![];
        if let Err(e) = ciborium::into_writer(data, &mut serialized) {
            panic!(
                "Failed to serialize data: {:?}. \
                This should not happen",
                e
            )
        }

        let hash = digest(&serialized);
        let hash_bytes = hex::decode(hash).unwrap();
        let hash_array: [u8; 32] = hash_bytes.as_slice().try_into().unwrap();

        Hash(U256::from_big_endian(&hash_array))
    }

    // network basically set's a difficulty and the miners have to match if the difficulty
    // matches or not!
    pub fn matches(&self, target: U256) -> bool {
        self.0 <= target
    }

    pub fn zero() -> Self {
        Hash(U256::zero())
    }
}

impl fmt::Display for Hash {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{:x}", self.0)
    }
}
