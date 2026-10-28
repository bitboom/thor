//! Deliberate local identity frames; never send them through tracing.
use std::io::{self, Write};

use aionui_db::{DatabaseIdentityObservation, DatabaseIdentityObserver, DatabaseIdentityPhase};
use serde::Serialize;
use uuid::Uuid;

use crate::cli::Cli;

const PREFIX: &[u8] = b"\x1eAIONCORE_DB_IDENTITY_V1 ";
const MAX_FRAME_BYTES: usize = 1024;

pub(crate) fn observer_for_cli(cli: &Cli) -> Option<DatabaseIdentityObserver> {
    observer_with_random(cli, getrandom::getrandom)
}

fn observer_with_random(
    cli: &Cli,
    random: impl FnOnce(&mut [u8]) -> Result<(), getrandom::Error>,
) -> Option<DatabaseIdentityObserver> {
    if cli.command.is_some()
        || !(cli.local || aionui_app::IdentityMode::from(cli.identity_mode).is_local())
        || cli.parent_pid.is_none_or(|pid| pid == 0)
        || cli.recover_corrupted_database
    {
        return None;
    }
    let mut bytes = [0; 16];
    random(&mut bytes).ok()?;
    let generation = uuid::Builder::from_random_bytes(bytes).into_uuid();
    Some(DatabaseIdentityObserver::new(
        *generation.as_bytes(),
        move |phase, observation| {
            if let Some(frame) = encode_frame(std::process::id(), generation, phase, observation) {
                // One locked sequence, no retry or fallback log on a partial write.
                let _ = write_frame(&mut io::stdout().lock(), &frame);
            }
        },
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireRecord<'a> {
    v: u8,
    pid: u32,
    generation: Uuid,
    phase: &'a str,
    ordinal: u8,
    status: &'a str,
    fingerprint: Option<&'a str>,
    reason: Option<&'a str>,
    sqlite_code: Option<i32>,
    win32_code: Option<u32>,
}

pub(super) fn encode_frame(
    pid: u32,
    generation: Uuid,
    phase: DatabaseIdentityPhase,
    observation: DatabaseIdentityObservation,
) -> Option<Vec<u8>> {
    if pid == 0 || generation.get_version_num() != 4 || generation.get_variant() != uuid::Variant::RFC4122 {
        return None;
    }
    let (status, fingerprint, reason, sqlite_code, win32_code) = match &observation {
        DatabaseIdentityObservation::Identified { fingerprint } => {
            if fingerprint.len() != 64
                || !fingerprint
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return None;
            }
            ("identified", Some(fingerprint.as_str()), None, None, None)
        }
        DatabaseIdentityObservation::Unavailable {
            reason,
            sqlite_code,
            win32_code,
        } => {
            use aionui_db::DatabaseIdentityUnavailable as Reason;
            if sqlite_code.is_some_and(|code| code < 0)
                || (sqlite_code.is_some() && *reason != Reason::SqliteHandleUnavailable)
                || (win32_code.is_some() && *reason != Reason::FileIdentityUnavailable)
            {
                return None;
            }
            ("unavailable", None, Some(reason.as_str()), *sqlite_code, *win32_code)
        }
    };
    let record = WireRecord {
        v: 1,
        pid,
        generation,
        phase: phase.as_str(),
        ordinal: phase.ordinal(),
        status,
        fingerprint,
        reason,
        sqlite_code,
        win32_code,
    };
    let mut frame = PREFIX.to_vec();
    serde_json::to_writer(&mut frame, &record).ok()?;
    frame.push(b'\n');
    (frame.len() <= MAX_FRAME_BYTES).then_some(frame)
}

pub(super) fn write_frame(writer: &mut impl Write, frame: &[u8]) -> io::Result<()> {
    writer.write_all(frame)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use aionui_db::DatabaseIdentityUnavailable as Reason;
    use clap::Parser;

    #[test]
    fn only_ordinary_managed_local_startup_constructs_observer_and_rng_failure_is_nonfatal() {
        for args in [
            vec!["core"],
            vec!["core", "--local"],
            vec!["core", "--local", "--parent-pid", "0"],
            vec!["core", "--parent-pid", "1"],
            vec!["core", "--local", "--parent-pid", "1", "--recover-corrupted-database"],
        ] {
            let cli = Cli::try_parse_from(args).unwrap();
            assert!(
                observer_with_random(&cli, |_| panic!("ineligible startup must not request random bytes")).is_none()
            );
        }
        for flag in ["--local", "--identity-mode"] {
            let mut args = vec!["core", flag];
            if flag == "--identity-mode" {
                args.push("local");
            }
            args.extend(["--parent-pid", "1"]);
            let cli = Cli::try_parse_from(args).unwrap();
            assert!(
                observer_with_random(&cli, |bytes| {
                    bytes.fill(7);
                    Ok(())
                })
                .is_some()
            );
            assert!(observer_with_random(&cli, |_| Err(getrandom::Error::UNSUPPORTED)).is_none());
        }
    }

    #[test]
    fn frames_have_exact_closed_keys_nulls_and_bounded_compact_encoding() {
        let generation = Uuid::parse_str("00112233-4455-4677-8899-aabbccddeeff").unwrap();
        let cases = [
            DatabaseIdentityObservation::Identified {
                fingerprint: "a".repeat(64),
            },
            DatabaseIdentityObservation::Unavailable {
                reason: Reason::UnsupportedPlatform,
                sqlite_code: None,
                win32_code: None,
            },
            DatabaseIdentityObservation::Unavailable {
                reason: Reason::ConnectionUnavailable,
                sqlite_code: None,
                win32_code: None,
            },
            DatabaseIdentityObservation::Unavailable {
                reason: Reason::LockTimeout,
                sqlite_code: None,
                win32_code: None,
            },
            DatabaseIdentityObservation::Unavailable {
                reason: Reason::SqliteHandleUnavailable,
                sqlite_code: Some(i32::MAX),
                win32_code: None,
            },
            DatabaseIdentityObservation::Unavailable {
                reason: Reason::FileIdentityUnavailable,
                sqlite_code: None,
                win32_code: Some(u32::MAX),
            },
        ];
        for phase in [DatabaseIdentityPhase::Bootstrap, DatabaseIdentityPhase::Business] {
            for observation in &cases {
                let frame = encode_frame(1, generation, phase, observation.clone()).unwrap();
                assert!(frame.starts_with(PREFIX) && frame.ends_with(b"\n") && frame.len() <= MAX_FRAME_BYTES);
                let value: serde_json::Value = serde_json::from_slice(&frame[PREFIX.len()..frame.len() - 1]).unwrap();
                let object = value.as_object().unwrap();
                assert_eq!(object.len(), 10);
                for key in [
                    "v",
                    "pid",
                    "generation",
                    "phase",
                    "ordinal",
                    "status",
                    "fingerprint",
                    "reason",
                    "sqliteCode",
                    "win32Code",
                ] {
                    assert!(object.contains_key(key));
                }
                assert_eq!(value["ordinal"], phase.ordinal());
                assert_eq!(value["generation"], generation.to_string());
                assert!(!frame.contains(&b'\r'));
            }
        }
        assert!(encode_frame(0, generation, DatabaseIdentityPhase::Bootstrap, cases[0].clone()).is_none());
        assert!(encode_frame(1, Uuid::nil(), DatabaseIdentityPhase::Bootstrap, cases[0].clone()).is_none());
        assert!(
            encode_frame(
                1,
                generation,
                DatabaseIdentityPhase::Bootstrap,
                DatabaseIdentityObservation::Identified {
                    fingerprint: "A".repeat(64)
                }
            )
            .is_none()
        );
        assert!(
            encode_frame(
                1,
                generation,
                DatabaseIdentityPhase::Bootstrap,
                DatabaseIdentityObservation::Unavailable {
                    reason: Reason::LockTimeout,
                    sqlite_code: Some(1),
                    win32_code: None
                }
            )
            .is_none()
        );
    }

    #[test]
    fn failed_delivery_is_not_retried_or_echoed_and_success_flushes() {
        struct Capture {
            bytes: Vec<u8>,
            writes: usize,
            flushes: usize,
            fail: bool,
        }
        impl Write for Capture {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.writes += 1;
                if self.fail {
                    return Err(io::Error::other("owned failure"));
                }
                self.bytes.extend(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                self.flushes += 1;
                Ok(())
            }
        }
        let mut capture = Capture {
            bytes: vec![],
            writes: 0,
            flushes: 0,
            fail: false,
        };
        write_frame(&mut capture, b"owned frame\n").unwrap();
        assert_eq!(capture.writes, 1);
        assert_eq!(capture.flushes, 1);
        capture.fail = true;
        assert!(write_frame(&mut capture, b"not retried").is_err());
        assert_eq!(capture.writes, 2);
        assert_eq!(capture.flushes, 1);
        assert_eq!(capture.bytes, b"owned frame\n");
    }
}
