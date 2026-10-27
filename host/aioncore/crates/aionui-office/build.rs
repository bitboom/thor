use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=THOR_OFFICECLI_LOCK_PATH");
    println!("cargo:rerun-if-changed=assets/officecli.lock.json");
    let custom = std::env::var_os("THOR_OFFICECLI_LOCK_PATH");
    let source = custom
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("assets/officecli.lock.json"));
    if custom.is_some() {
        assert!(source.is_absolute(), "THOR_OFFICECLI_LOCK_PATH must be absolute");
        println!("cargo:rerun-if-changed={}", source.display());
    }
    let bytes = std::fs::read(&source).expect("OfficeCLI lock must be readable");
    assert!(bytes.len() < 1024 * 1024, "OfficeCLI lock exceeds size limit");
    let lock: serde_json::Value = serde_json::from_slice(&bytes).expect("OfficeCLI lock must be JSON");
    assert_eq!(lock["schemaVersion"], 1, "OfficeCLI lock schema mismatch");
    assert_eq!(lock["version"], "v1.0.159", "OfficeCLI source version mismatch");
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap();
    let environment = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    let os = match os.as_str() {
        "windows" => "win32",
        "macos" => "darwin",
        "linux" if environment == "musl" => "linux-alpine",
        other => other,
    };
    let arch = match arch.as_str() {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    let key = format!("{os}-{arch}");
    let assets = lock["assets"].as_array().expect("OfficeCLI assets must be an array");
    for asset in assets {
        let name = asset["name"].as_str().expect("OfficeCLI asset name is required");
        assert!(
            !name.is_empty()
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b".-_".contains(&byte)),
            "OfficeCLI asset name is unsafe"
        );
        let hash = asset["sha256"].as_str().expect("OfficeCLI asset digest is required");
        assert!(
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "OfficeCLI digest is invalid"
        );
        assert!(
            asset["size"]
                .as_u64()
                .is_some_and(|size| size > 1_000_000 && size < 256 * 1024 * 1024),
            "OfficeCLI asset size is invalid"
        );
    }
    if custom.is_some() {
        let asset = assets
            .iter()
            .find(|asset| asset["runtimeKey"] == key)
            .expect("Derived OfficeCLI lock has no current target");
        assert_eq!(
            asset["readOnlyWatch"], true,
            "Derived OfficeCLI must enforce read-only watch"
        );
        assert_eq!(
            asset["source"]["commit"], "5e625bf58aca732335590d7aa271f6337535a7ef",
            "OfficeCLI source revision mismatch"
        );
        assert_eq!(
            asset["source"]["policy"], "thor-readonly-v1",
            "OfficeCLI read-only policy mismatch"
        );
        let patch_hash = asset["source"]["patchSha256"]
            .as_str()
            .expect("OfficeCLI patch digest is required");
        assert!(
            patch_hash.len() == 64 && patch_hash.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "OfficeCLI patch digest is invalid"
        );
    } else {
        println!("cargo:warning=OfficeCLI watch is disabled until a derived read-only build lock is supplied");
    }
    let output = PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("officecli.lock.json");
    std::fs::write(output, bytes).expect("OfficeCLI lock could not be embedded");
}
