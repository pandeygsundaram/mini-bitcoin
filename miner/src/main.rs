use btclib::crypto::PublicKey;
use btclib::network::Message;
use btclib::util::Saveable;
use std::process::exit;
use std::env;
use tokio::net::TcpStream;

fn usage() -> ! {
    eprintln!(
        "Usage: {} <address> <public_key_file> ",
        env::args().next().unwrap()
    );
    exit(1);
}

#[tokio::main]
async fn main() {
    let address = match env::args().nth(1) {
        Some(address) => address,
        None => usage(),
    };

    let public_key_file = match env::args().nth(2) {
        Some(public_key_file) => public_key_file,
        None => usage(),
    };

    let Ok(public_key) = PublicKey::load_from_file(&public_key_file) else {
        eprintln!("Error reading public key from file {}", public_key_file);
        exit(1);
    };
    println!("Connecting to {address} to mine with {public_key:?}",);

    let mut stream = match TcpStream::connect(&address).await {
        Ok(stream) => stream,
        Err(e) => {
            eprintln!("Failed to connect to server: {}", e);
            exit(1);
        }
    };

    // Ask the node for work
    println!("requesting work from {address}");
    let message = Message::FetchTemplate(public_key);
    message.send(&mut stream);


}

// parse block path and steps count from the
// first and second argument respectively

// let (path, steps) = if let (Some(arg), Some(arg2)) = (env::args().nth(1), env::args().nth(2)) {
//     (arg, arg2)
// } else {
//     eprintln!("Usage: miner <block_file> <steps>");
//     exit(1);
// };

// let steps: usize = if let Ok(s @ 1..=usize::MAX) = steps.parse() {
//     s
// } else {
//     eprintln!("Usage: miner <block_file> <steps>");
//     exit(1);
// };

// // load block from file
// let og_block = Block::load_from_file(path).expect("Failed to load block");
// let mut block = og_block.clone();

// // main.rs
// while !block.header.mine(steps) {
//     println!("mining...");
// }

// // print original block and its hash
// println!("original: {:#?}", og_block);
// println!("hash: {}", og_block.header.hash());
// // print mined block and its hash
// println!("final: {:#?}", block);
// println!("hash: {}", block.header.hash());
