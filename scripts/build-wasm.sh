#!/bin/sh
set -eu
REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if ! command -v cargo >/dev/null 2>&1; then
  # Installs only inside the checkout, including in a Vercel build container.
  export CARGO_HOME="$REPO_ROOT/.build/cargo"
  export RUSTUP_HOME="$REPO_ROOT/.build/rustup"
  export PATH="$CARGO_HOME/bin:$PATH"
  if ! command -v cargo >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o "$REPO_ROOT/.rustup-install.sh"
    sh "$REPO_ROOT/.rustup-install.sh" -y --profile minimal --default-toolchain stable --no-modify-path
    rm "$REPO_ROOT/.rustup-install.sh"
  fi
fi
rustup target add wasm32-unknown-unknown
cargo build --manifest-path "$REPO_ROOT/browser-core/Cargo.toml" --release --target wasm32-unknown-unknown
