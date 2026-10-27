set windows-shell := ["powershell.exe", "-NoProfile", "-Command"]

default:
    @just --list

test:
    node --test tests/runtime/*.test.mjs release/*.test.mjs release/bootstrap/*.test.mjs

check: test
    node release/check-version.mjs
    just --working-directory desktop/aionui check
    bun --cwd desktop/aionui run test --maxWorkers=4

[working-directory: 'host/aioncore']
check-host:
    cargo fmt --all -- --check
    cargo clippy --locked --workspace --all-targets -- -D warnings
    cargo test --locked --workspace

push *ARGS: check check-host
    git push {{ ARGS }}

build-windows:
    node release/build-windows.mjs

prepare-bootstrap:
    node release/bootstrap/prepare.mjs
