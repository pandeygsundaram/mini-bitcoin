use mini_bitcoin_browser::{Block, Engine, address};
use serde_json::json;
const A: &str = "0000000000000000000000000000000000000000000000000000000000000001";
const B: &str = "0000000000000000000000000000000000000000000000000000000000000002";
const C: &str = "0000000000000000000000000000000000000000000000000000000000000003";
const NOW: u64 = 1_800_000_000_000;
fn mine(engine: &Engine, owner: &str) -> Block {
    let block = engine
        .template(owner, NOW + u64::from(engine.height() + 1) * 10_000)
        .unwrap();
    solve(block)
}
fn solve(mut block: Block) -> Block {
    let mut worker = Engine::default();
    loop {
        let result = worker
            .dispatch(json!({"op":"mine","block":block,"steps":20000}))
            .unwrap();
        block = serde_json::from_value(result["block"].clone()).unwrap();
        if result["found"] == true {
            return block;
        }
    }
}
fn advance(engine: &mut Engine, owner: &str, n: usize) {
    for _ in 0..n {
        let block = mine(engine, owner);
        engine.accept(block, NOW + 10_000_000).unwrap();
    }
}
fn funded() -> Engine {
    let mut e = Engine::default();
    advance(&mut e, &address(A).unwrap(), 3);
    e
}
#[test]
fn wallet_transfer_restore_and_signature_binding() {
    let mut e = funded();
    let receiver = address(B).unwrap();
    let tx = e
        .transfer(A, &receiver, "100000000", "1000", "unique")
        .unwrap();
    let mut tampered = tx.clone();
    tampered.outputs[0].address = address(C).unwrap();
    assert!(e.submit(tampered).unwrap_err().contains("signature"));
    e.submit(tx).unwrap();
    advance(&mut e, &address(A).unwrap(), 1);
    assert_eq!(e.status(&receiver).unwrap()["balance"], "100000000");
    let mut restored = Engine::default();
    restored.restore(e.snapshot(), NOW + 10_000_000).unwrap();
    assert_eq!(
        restored.status(&receiver).unwrap(),
        e.status(&receiver).unwrap()
    );
}
#[test]
fn rejects_conflicts_and_bad_targets() {
    let mut e = funded();
    let tx = e
        .transfer(A, &address(B).unwrap(), "100000000", "1000", "first")
        .unwrap();
    let second = e
        .transfer(A, &address(C).unwrap(), "100000000", "1000", "second")
        .unwrap();
    e.submit(tx).unwrap();
    assert!(e.submit(second).is_err());
    let mut block = mine(&e, &address(A).unwrap());
    block.bits = 12;
    assert!(
        e.accept(block, NOW + 10_000_000)
            .unwrap_err()
            .contains("difficulty")
    );
}
#[test]
fn competing_spends_converge_on_more_work() {
    let base = funded().snapshot();
    let mut left = Engine::default();
    let mut right = Engine::default();
    left.restore(base.clone(), NOW + 10_000_000).unwrap();
    right.restore(base, NOW + 10_000_000).unwrap();
    let b = address(B).unwrap();
    let c = address(C).unwrap();
    let tx_left = left.transfer(A, &b, "100000000", "1000", "left").unwrap();
    left.submit(tx_left).unwrap();
    advance(&mut left, &b, 1);
    let tx_right = right.transfer(A, &c, "100000000", "1000", "right").unwrap();
    right.submit(tx_right).unwrap();
    advance(&mut right, &c, 2);
    let snapshot = right.snapshot();
    for value in snapshot["blocks"].as_array().unwrap() {
        left.accept(
            serde_json::from_value(value.clone()).unwrap(),
            NOW + 10_000_000,
        )
        .unwrap();
    }
    assert_eq!(left.status(&b).unwrap()["balance"], "0");
    assert_eq!(
        left.status(&c).unwrap()["tip"],
        right.status(&c).unwrap()["tip"]
    );
    assert!(left.status(&c).unwrap()["reorgs"].as_u64().unwrap() > 0);
    assert_eq!(left.status(&b).unwrap()["pending"], 0);
}
#[test]
fn corrupt_backup_does_not_replace_existing_chain() {
    let mut e = funded();
    let before = e.snapshot();
    let mut corrupt = before.clone();
    corrupt["blocks"][0]["transactions"] = json!([]);
    assert!(e.restore(corrupt, NOW + 10_000_000).is_err());
    assert_eq!(before, e.snapshot());
}
#[test]
fn duplicate_blocks_do_not_duplicate_funds_and_rewards_mature() {
    let mut e = Engine::default();
    let owner = address(A).unwrap();
    let block = mine(&e, &owner);
    e.accept(block.clone(), NOW + 10_000_000).unwrap();
    assert_eq!(e.status(&owner).unwrap()["spendable"], "0");
    assert!(
        e.transfer(A, &address(B).unwrap(), "1", "0", "early")
            .is_err()
    );
    assert!(!e.accept(block, NOW + 10_000_000).unwrap());
    assert_eq!(e.height(), 1);
    advance(&mut e, &owner, 2);
    assert_eq!(e.status(&owner).unwrap()["spendable"], "10000000000");
}
#[test]
fn wrong_network_and_overflow_are_rejected() {
    let mut e = funded();
    assert!(
        e.transfer(
            A,
            &address(B).unwrap(),
            "18446744073709551615",
            "1",
            "overflow"
        )
        .is_err()
    );
    let mut block = mine(&e, &address(A).unwrap());
    block.network = "another-network".into();
    assert!(e.accept(block, NOW + 10_000_000).is_err());
}

#[test]
fn secp256k1_known_public_key() {
    assert_eq!(
        address(A).unwrap(),
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    );
}
