//! Optional metadata-only observation of an actual SQLite-owned main-file handle.
//! Raw native identity never leaves capture; callers receive only a salted digest.
use std::fmt;
use std::sync::atomic::{AtomicU8, Ordering};
#[cfg(windows)]
use std::time::Duration;

#[cfg(any(windows, test))]
use sha2::{Digest, Sha256};
#[cfg(windows)]
use sqlx::SqliteConnection;
use sqlx::SqlitePool;

#[cfg(any(windows, test))]
const DOMAIN: &[u8] = b"thor.sqlite.main-file.identity.v1\0";
#[cfg(windows)]
const LOCK_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DatabaseIdentityPhase {
    Bootstrap,
    Business,
}

impl DatabaseIdentityPhase {
    pub fn ordinal(self) -> u8 {
        match self {
            Self::Bootstrap => 0,
            Self::Business => 1,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bootstrap => "bootstrap",
            Self::Business => "business",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DatabaseIdentityUnavailable {
    UnsupportedPlatform,
    ConnectionUnavailable,
    LockTimeout,
    SqliteHandleUnavailable,
    FileIdentityUnavailable,
}

impl DatabaseIdentityUnavailable {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnsupportedPlatform => "unsupported_platform",
            Self::ConnectionUnavailable => "connection_unavailable",
            Self::LockTimeout => "lock_timeout",
            Self::SqliteHandleUnavailable => "sqlite_handle_unavailable",
            Self::FileIdentityUnavailable => "file_identity_unavailable",
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub enum DatabaseIdentityObservation {
    Identified {
        fingerprint: String,
    },
    Unavailable {
        reason: DatabaseIdentityUnavailable,
        sqlite_code: Option<i32>,
        win32_code: Option<u32>,
    },
}

// Do not let an incidental debug statement put a fingerprint into generic logs.
impl fmt::Debug for DatabaseIdentityObservation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Identified { .. } => f.write_str("Identified"),
            Self::Unavailable {
                reason,
                sqlite_code,
                win32_code,
            } => f
                .debug_struct("Unavailable")
                .field("reason", reason)
                .field("sqlite_code", sqlite_code)
                .field("win32_code", win32_code)
                .finish(),
        }
    }
}

impl DatabaseIdentityObservation {
    fn unavailable(reason: DatabaseIdentityUnavailable) -> Self {
        Self::Unavailable {
            reason,
            sqlite_code: None,
            win32_code: None,
        }
    }
}

/// Explicit observer for the separate observed initializer. Existing DB APIs never
/// construct one or write identity stdout. The trusted sink must not panic and
/// must handle its own delivery failure without changing database initialization.
pub struct DatabaseIdentityObserver {
    generation: [u8; 16],
    phases: AtomicU8,
    sink: Box<dyn Fn(DatabaseIdentityPhase, DatabaseIdentityObservation) + Send + Sync>,
}

impl DatabaseIdentityObserver {
    pub fn new(
        generation: [u8; 16],
        sink: impl Fn(DatabaseIdentityPhase, DatabaseIdentityObservation) + Send + Sync + 'static,
    ) -> Self {
        Self {
            generation,
            phases: AtomicU8::new(0),
            sink: Box::new(sink),
        }
    }

    pub(crate) async fn observe(&self, phase: DatabaseIdentityPhase, pool: &SqlitePool) {
        let bit = 1 << phase.ordinal();
        if self.phases.fetch_or(bit, Ordering::Relaxed) & bit != 0 {
            return;
        }
        #[cfg(windows)]
        let observation = match pool.try_acquire() {
            Some(mut connection) => capture_connection(&mut connection, self.generation, LOCK_TIMEOUT).await,
            None => DatabaseIdentityObservation::unavailable(DatabaseIdentityUnavailable::ConnectionUnavailable),
        };
        #[cfg(not(windows))]
        let observation = {
            let _ = (pool, self.generation);
            DatabaseIdentityObservation::unavailable(DatabaseIdentityUnavailable::UnsupportedPlatform)
        };
        (self.sink)(phase, observation);
    }
}

#[cfg(any(windows, test))]
fn fingerprint(generation: [u8; 16], volume: u64, file_id: [u8; 16]) -> String {
    let mut hash = Sha256::new();
    hash.update(DOMAIN);
    hash.update(generation);
    hash.update(volume.to_le_bytes());
    hash.update(file_id);
    format!("{:x}", hash.finalize())
}

#[cfg(windows)]
async fn capture_connection(
    connection: &mut SqliteConnection,
    generation: [u8; 16],
    timeout: Duration,
) -> DatabaseIdentityObservation {
    match tokio::time::timeout(timeout, connection.lock_handle()).await {
        Err(_) => DatabaseIdentityObservation::unavailable(DatabaseIdentityUnavailable::LockTimeout),
        Ok(Err(_)) => DatabaseIdentityObservation::unavailable(DatabaseIdentityUnavailable::SqliteHandleUnavailable),
        Ok(Ok(mut guard)) => native_identity(&mut guard, generation),
    }
}

#[cfg(windows)]
fn native_identity(
    guard: &mut sqlx::sqlite::LockedSqliteHandle<'_>,
    generation: [u8; 16],
) -> DatabaseIdentityObservation {
    use windows_sys::Win32::Foundation::{GetLastError, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{FILE_ID_INFO, FileIdInfo, GetFileInformationByHandleEx};

    let mut borrowed: HANDLE = std::ptr::null_mut();
    // SAFETY: SQLx0.8.6 holds its worker mutex for the guard's lifetime. The exact
    // linked libsqlite3-sys0.30.1 ABI is pinned; upgrades require re-review. Public
    // opcode29 writes a borrowed HANDLE, not a sqlite3_file layout. Neither the
    // pointer nor handle escapes this scope, and no close/duplicate/set is used.
    let sqlite_code = unsafe {
        libsqlite3_sys::sqlite3_file_control(
            guard.as_raw_handle().as_ptr(),
            c"main".as_ptr(),
            libsqlite3_sys::SQLITE_FCNTL_WIN32_GET_HANDLE,
            (&mut borrowed as *mut HANDLE).cast(),
        )
    };
    if sqlite_code != libsqlite3_sys::SQLITE_OK || borrowed.is_null() || borrowed == INVALID_HANDLE_VALUE {
        return DatabaseIdentityObservation::Unavailable {
            reason: DatabaseIdentityUnavailable::SqliteHandleUnavailable,
            sqlite_code: (sqlite_code >= 0).then_some(sqlite_code),
            win32_code: None,
        };
    }
    let mut info = FILE_ID_INFO::default();
    // SAFETY: borrowed belongs to the live guarded SQLite connection. info is a
    // correctly sized initialized FILE_ID_INFO. Only its named fields are hashed.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            borrowed,
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if ok == 0 {
        return DatabaseIdentityObservation::Unavailable {
            reason: DatabaseIdentityUnavailable::FileIdentityUnavailable,
            sqlite_code: None,
            win32_code: Some(unsafe { GetLastError() }),
        };
    }
    DatabaseIdentityObservation::Identified {
        fingerprint: fingerprint(generation, info.VolumeSerialNumber, info.FileId.Identifier),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor, sqlite::SqliteConnectOptions};
    use std::sync::{Arc, Mutex};

    const GENERATION: [u8; 16] = [
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x46, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
    ];

    #[test]
    fn canonical_cross_language_vector_uses_full128_and_generation() {
        let file_id = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
        ];
        assert_eq!(
            fingerprint(GENERATION, 0x0123456789abcdef, file_id),
            "0ec3370b24735fa50b5514f648a7085c154067428ac6206ebf7b7abbbdbfff7c"
        );
        let mut changed = file_id;
        changed[15] = 1;
        assert_eq!(
            fingerprint(GENERATION, 0x0123456789abcdef, changed),
            "4bfe787a11c7d5f35b08f21934f15eef50c3a21becd133841abb5714e0776bee"
        );
        let mut generation = GENERATION;
        generation[0] ^= 1;
        assert_ne!(
            fingerprint(generation, 0x0123456789abcdef, file_id),
            fingerprint(GENERATION, 0x0123456789abcdef, file_id)
        );
    }

    #[tokio::test]
    async fn no_idle_connection_is_not_opened_or_waited_for_and_phases_are_capped() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let observer = DatabaseIdentityObserver::new(GENERATION, move |phase, event| {
            sink.lock().unwrap().push((phase, event))
        });
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let held = pool.acquire().await.unwrap();
        observer.observe(DatabaseIdentityPhase::Bootstrap, &pool).await;
        observer.observe(DatabaseIdentityPhase::Bootstrap, &pool).await;
        observer.observe(DatabaseIdentityPhase::Business, &pool).await;
        assert_eq!(pool.size(), 1);
        {
            let captured = events.lock().unwrap();
            assert_eq!(captured.len(), 2);
            #[cfg(windows)]
            assert!(captured.iter().all(|(_, event)| matches!(
                event,
                DatabaseIdentityObservation::Unavailable {
                    reason: DatabaseIdentityUnavailable::ConnectionUnavailable,
                    ..
                }
            )));
            #[cfg(not(windows))]
            assert!(captured.iter().all(|(_, event)| matches!(
                event,
                DatabaseIdentityObservation::Unavailable {
                    reason: DatabaseIdentityUnavailable::UnsupportedPlatform,
                    ..
                }
            )));
        }
        drop(held);
        pool.close().await;
    }

    #[tokio::test]
    async fn observed_phases_bracket_migration_and_precede_seed() {
        use crate::{DatabaseInitOptions, init_database_staged_with_observer};
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("owned.db");
        let observed_path = path.clone();
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let observer = DatabaseIdentityObserver::new(GENERATION, move |phase, event| {
            let reference =
                rusqlite::Connection::open_with_flags(&observed_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .unwrap();
            let users_table: i64 = reference
                .query_row("SELECT count(*) FROM sqlite_schema WHERE name='users'", [], |row| {
                    row.get(0)
                })
                .unwrap();
            let users = if users_table == 0 {
                0
            } else {
                reference
                    .query_row("SELECT count(*) FROM users", [], |row| row.get::<_, i64>(0))
                    .unwrap()
            };
            sink.lock().unwrap().push((phase, event, users_table, users));
        });
        let db = init_database_staged_with_observer(&path, DatabaseInitOptions::default(), Some(&observer))
            .await
            .unwrap();
        let user_count: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
            .fetch_one(db.pool())
            .await
            .unwrap();
        assert_eq!(user_count, 1);
        {
            let captured = events.lock().unwrap();
            assert_eq!(captured.len(), 2);
            assert_eq!(captured[0].0, DatabaseIdentityPhase::Bootstrap);
            assert_eq!(captured[0].2, 0);
            assert_eq!(captured[1].0, DatabaseIdentityPhase::Business);
            assert_eq!(captured[1].2, 1);
            assert_eq!(captured[1].3, 0);
            #[cfg(windows)]
            assert!(
                matches!((&captured[0].1,&captured[1].1),(DatabaseIdentityObservation::Identified{fingerprint:a},DatabaseIdentityObservation::Identified{fingerprint:b}) if a==b)
            );
        }
        db.close().await;
    }

    #[tokio::test]
    async fn unreached_phases_are_not_invented_and_recovery_option_ignores_observer() {
        use crate::{DatabaseInitOptions, init_database_staged_with_observer};
        let directory = tempfile::tempdir().unwrap();
        let blocked = directory.path().join("directory.db");
        std::fs::create_dir(&blocked).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let observer = DatabaseIdentityObserver::new(GENERATION, move |phase, event| {
            sink.lock().unwrap().push((phase, event))
        });
        assert!(
            init_database_staged_with_observer(&blocked, DatabaseInitOptions::default(), Some(&observer))
                .await
                .is_err()
        );
        assert!(events.lock().unwrap().is_empty());
        let fresh = directory.path().join("recovery-option-but-valid.db");
        let db = init_database_staged_with_observer(
            &fresh,
            DatabaseInitOptions {
                recover_corrupted_database: true,
            },
            Some(&observer),
        )
        .await
        .unwrap();
        assert!(events.lock().unwrap().is_empty());
        db.close().await;
    }

    #[cfg(windows)]
    fn reference_fingerprint(path: &std::path::Path, generation: [u8; 16]) -> String {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ID_INFO, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FileIdInfo,
            GetFileInformationByHandleEx,
        };
        let file = std::fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(path)
            .unwrap();
        let mut info = FILE_ID_INFO::default();
        let ok = unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileIdInfo,
                (&mut info as *mut FILE_ID_INFO).cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
        };
        assert_ne!(ok, 0, "owned metadata reference unavailable");
        fingerprint(generation, info.VolumeSerialNumber, info.FileId.Identifier)
    }

    #[cfg(windows)]
    fn identified(event: DatabaseIdentityObservation) -> String {
        match event {
            DatabaseIdentityObservation::Identified { fingerprint } => fingerprint,
            _ => panic!("owned actual SQLite HANDLE unavailable"),
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn actual_sqlite_handle_matches_reference_alias_and_differs_from_equal_copy() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("owned.db");
        let mut connection =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path).create_if_missing(true))
                .await
                .unwrap();
        connection
            .execute("CREATE TABLE owned_fixture(value INTEGER); INSERT INTO owned_fixture VALUES(7)")
            .await
            .unwrap();
        let observed = identified(capture_connection(&mut connection, GENERATION, LOCK_TIMEOUT).await);
        assert!(
            observed == reference_fingerprint(&path, GENERATION),
            "actual SQLite and owned metadata handle must agree"
        );
        let alias = directory.path().join("owned-alias.db");
        std::fs::hard_link(&path, &alias).unwrap();
        assert!(
            observed == reference_fingerprint(&alias, GENERATION),
            "hardlink must identify the same object"
        );
        let copy = directory.path().join("owned-copy.db");
        std::fs::copy(&path, &copy).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), std::fs::read(&copy).unwrap());
        assert!(
            observed != reference_fingerprint(&copy, GENERATION),
            "equal bytes must not substitute for object identity"
        );
        let value: i64 = sqlx::query_scalar("SELECT value FROM owned_fixture")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(value, 7);
        connection.close().await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn lock_timeout_cancels_no_native_use_and_connection_remains_usable() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("owned-busy.db");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .busy_timeout(Duration::from_secs(3));
        let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
        connection
            .execute("CREATE TABLE owned_fixture(value INTEGER)")
            .await
            .unwrap();
        let mut writer = SqliteConnection::connect_with(&options).await.unwrap();
        writer.execute("BEGIN EXCLUSIVE").await.unwrap();
        // Queue real SQLite work that remains busy after the Rust query future is
        // cancelled, so the subsequent lock_handle must actually wait for the worker.
        assert!(
            tokio::time::timeout(
                Duration::from_millis(50),
                connection.execute("INSERT INTO owned_fixture VALUES(1)")
            )
            .await
            .is_err()
        );
        let observation = capture_connection(&mut connection, GENERATION, LOCK_TIMEOUT).await;
        assert!(matches!(
            observation,
            DatabaseIdentityObservation::Unavailable {
                reason: DatabaseIdentityUnavailable::LockTimeout,
                ..
            }
        ));
        writer.execute("ROLLBACK").await.unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            sqlx::query_scalar::<_, i64>("SELECT 1").fetch_one(&mut connection),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result, 1);
        connection.close().await.unwrap();
        writer.close().await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn memory_connection_has_no_native_file_handle_and_remains_usable() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        assert!(matches!(
            capture_connection(&mut connection, GENERATION, LOCK_TIMEOUT).await,
            DatabaseIdentityObservation::Unavailable {
                reason: DatabaseIdentityUnavailable::SqliteHandleUnavailable,
                ..
            }
        ));
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT 1")
                .fetch_one(&mut connection)
                .await
                .unwrap(),
            1
        );
        connection.close().await.unwrap();
    }

    #[tokio::test]
    async fn migration_failure_keeps_only_the_reached_bootstrap_phase() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("owned-newer.db");
        let db = crate::init_database(&path).await.unwrap();
        sqlx::query("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(999999,'owned future migration',1,X'00',0)")
            .execute(db.pool()).await.unwrap();
        db.close().await;
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let observer = DatabaseIdentityObserver::new(GENERATION, move |phase, event| {
            sink.lock().unwrap().push((phase, event))
        });
        let error =
            crate::init_database_staged_with_observer(&path, crate::DatabaseInitOptions::default(), Some(&observer))
                .await
                .unwrap_err();
        assert_eq!(error.stage(), crate::DATABASE_NEWER_THAN_APP_STAGE);
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, DatabaseIdentityPhase::Bootstrap);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn held_sqlite_object_never_substitutes_a_replacement_path() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("owned-original.db");
        let mut connection =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path).create_if_missing(true))
                .await
                .unwrap();
        connection
            .execute("CREATE TABLE owned_fixture(value INTEGER); INSERT INTO owned_fixture VALUES(7)")
            .await
            .unwrap();
        let original = identified(capture_connection(&mut connection, GENERATION, LOCK_TIMEOUT).await);
        let renamed = directory.path().join("owned-renamed.db");
        match std::fs::rename(&path, &renamed) {
            Ok(()) => {
                std::fs::write(&path, b"owned unrelated replacement").unwrap();
                assert!(original != reference_fingerprint(&path, GENERATION));
                assert!(original == identified(capture_connection(&mut connection, GENERATION, LOCK_TIMEOUT).await));
            }
            Err(error) => {
                assert!(
                    matches!(error.raw_os_error(), Some(5 | 32 | 33)),
                    "owned Windows rename must be access/sharing/lock denied; code={:?}",
                    error.raw_os_error()
                );
                assert!(original == reference_fingerprint(&path, GENERATION));
                assert!(original == identified(capture_connection(&mut connection, GENERATION, LOCK_TIMEOUT).await));
            }
        }
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT value FROM owned_fixture")
                .fetch_one(&mut connection)
                .await
                .unwrap(),
            7
        );
        connection.close().await.unwrap();
    }
}
