mod crypto;
mod sha256;
mod types;
mod util;


use uint::construct_uint;

construct_uint!{

    pub struct U256(4);
}