//! Thor executes only its checksum-pinned OfficeCLI bundle. No runtime install,
//! PATH lookup, moving release channel, or remote shell script is permitted.
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use aionui_runtime::Builder;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::error::OfficeError;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficecliLock {
    schema_version: u32,
    version: String,
    assets: Vec<OfficecliAsset>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficecliAsset {
    runtime_key: String,
    name: String,
    size: u64,
    sha256: String,
    #[serde(default)]
    read_only_watch: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct VerifiedOfficecli {
    path: PathBuf,
}

impl VerifiedOfficecli {
    pub(crate) fn command(&self) -> Builder {
        let mut command = Builder::clean_cli(&self.path);
        command.env("OFFICECLI_SKIP_UPDATE", "1");
        command
    }

    pub(crate) fn watch_command(&self) -> Builder {
        let mut command = Builder::new(&self.path);
        command.env("OFFICECLI_SKIP_UPDATE", "1");
        command.env("OFFICECLI_WATCH_READ_ONLY", "1");
        command.env_remove("OFFICECLI_WATCH_ALLOWED_HOSTS");
        command
    }
}

fn lock() -> &'static OfficecliLock {
    static LOCK: OnceLock<OfficecliLock> = OnceLock::new();
    LOCK.get_or_init(|| {
        serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/officecli.lock.json")))
            .expect("the embedded OfficeCLI lock must be valid")
    })
}

fn current_runtime_key() -> String {
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        #[cfg(target_env = "musl")]
        "linux" => "linux-alpine",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}

fn current_asset() -> Result<&'static OfficecliAsset, OfficeError> {
    let lock = lock();
    if lock.schema_version != 1 {
        return Err(OfficeError::StartFailed(
            "OfficeCLI bundle lock schema is invalid".into(),
        ));
    }
    lock.assets
        .iter()
        .find(|asset| asset.runtime_key == current_runtime_key())
        .ok_or_else(|| OfficeError::StartFailed("Pinned OfficeCLI is unavailable for this platform".into()))
}

pub(crate) fn resolve_officecli_path() -> Result<VerifiedOfficecli, OfficeError> {
    if !current_asset()?.read_only_watch {
        return Err(OfficeError::RuntimePolicy {
            code: "OFFICECLI_READONLY_REQUIRED",
            message:
                "Thor requires its pinned read-only OfficeCLI build for preview; reinstall a verified Thor release"
                    .into(),
        });
    }
    resolve_officecli_with_override(None)
}

pub(crate) fn resolve_officecli_with_override(configured: Option<&Path>) -> Result<VerifiedOfficecli, OfficeError> {
    let asset = current_asset()?;
    let path = match configured {
        Some(path) => path.to_path_buf(),
        None => aionui_runtime::managed_resources::bundled_root_candidate()
            .ok_or_else(bundle_missing)?
            .join("officecli")
            .join(&lock().version)
            .join(&asset.name),
    };
    verify_asset(&path, asset)?;
    Ok(VerifiedOfficecli { path })
}

fn bundle_missing() -> OfficeError {
    OfficeError::RuntimePolicy {
        code: "OFFICECLI_BUNDLE_MISSING",
        message: format!(
            "Thor requires the bundled OfficeCLI {}. Reinstall a verified Thor release; runtime downloads are disabled.",
            lock().version
        ),
    }
}

fn verify_asset(path: &Path, asset: &OfficecliAsset) -> Result<(), OfficeError> {
    let mut file = File::open(path).map_err(|_| bundle_missing())?;
    if !file
        .metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() == asset.size)
    {
        return Err(OfficeError::RuntimePolicy {
            code: "OFFICECLI_INTEGRITY_FAILED",
            message: "Pinned OfficeCLI bundle size mismatch; reinstall Thor".into(),
        });
    }
    let mut hash = Sha256::new();
    let mut chunk = [0u8; 65536];
    loop {
        let count = file.read(&mut chunk).map_err(|_| bundle_missing())?;
        if count == 0 {
            break;
        }
        hash.update(&chunk[..count]);
    }
    if format!("{:x}", hash.finalize()) != asset.sha256 {
        tracing::error!(version = %lock().version, "OfficeCLI bundle integrity validation failed");
        return Err(OfficeError::RuntimePolicy {
            code: "OFFICECLI_INTEGRITY_FAILED",
            message: "Pinned OfficeCLI checksum mismatch; reinstall Thor".into(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_asset(bytes: &[u8]) -> OfficecliAsset {
        OfficecliAsset {
            runtime_key: "test".into(),
            name: "officecli".into(),
            size: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            read_only_watch: false,
        }
    }

    #[test]
    fn embedded_pin_has_fixed_release_assets_for_supported_targets() {
        assert_eq!(lock().schema_version, 1);
        assert_eq!(lock().version, "v1.0.159");
        assert_eq!(lock().assets.len(), 8);
        for asset in &lock().assets {
            assert_eq!(asset.sha256.len(), 64);
            assert!(asset.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert!(asset.size > 1_000_000);
            assert!(!asset.name.contains('/') && !asset.name.contains('\\'));
        }
        assert!(current_asset().is_ok());
    }

    #[test]
    fn valid_bundle_is_verified_on_each_resolution_and_tampering_fails() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("officecli");
        let bytes = b"synthetic executable fixture";
        let asset = test_asset(bytes);
        std::fs::write(&path, bytes).unwrap();
        verify_asset(&path, &asset).unwrap();
        std::fs::write(&path, vec![b'x'; bytes.len()]).unwrap();
        assert!(
            verify_asset(&path, &asset)
                .unwrap_err()
                .to_string()
                .contains("checksum mismatch")
        );
    }

    #[test]
    fn missing_partial_and_configured_unverified_binaries_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("officecli");
        let asset = test_asset(b"complete");
        assert!(
            verify_asset(&path, &asset)
                .unwrap_err()
                .to_string()
                .contains("runtime downloads are disabled")
        );
        std::fs::write(&path, b"partial").unwrap();
        assert!(
            verify_asset(&path, &asset)
                .unwrap_err()
                .to_string()
                .contains("size mismatch")
        );
        assert!(resolve_officecli_with_override(Some(&path)).is_err());
    }

    #[tokio::test]
    async fn preview_and_conversion_commands_disable_self_updates() {
        let cli = VerifiedOfficecli {
            path: PathBuf::from(if cfg!(windows) { "cmd.exe" } else { "sh" }),
        };
        for mut command in [cli.command(), cli.watch_command()] {
            if cfg!(windows) {
                command.args(["/D", "/C", "echo %OFFICECLI_SKIP_UPDATE%"]);
            } else {
                command.args(["-c", "printf %s \"$OFFICECLI_SKIP_UPDATE\""]);
            }
            command.stdout(std::process::Stdio::piped());
            let output = command.output().await.unwrap();
            assert!(output.status.success());
            assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "1");
        }
    }
}
