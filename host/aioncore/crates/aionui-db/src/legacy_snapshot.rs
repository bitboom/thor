//! Consistent, no-clobber handoff of the Electron-managed legacy catalog.
use std::fs::{OpenOptions, symlink_metadata};
use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

use rusqlite::backup::{Backup, StepResult};
use rusqlite::{Connection, OpenFlags};
use tracing::{info, warn};

use crate::database::{MigrateLockGuard, migrate_lock_path};
use crate::error::DbError;

struct Limits {
    lock: Duration,
    backup: Duration,
    validation: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            lock: Duration::from_secs(5),
            backup: Duration::from_secs(30),
            validation: Duration::from_secs(10),
        }
    }
}

fn failure(stage: &'static str) -> DbError {
    warn!(
        code = "LEGACY_SNAPSHOT_FAILED",
        stage, "Legacy database snapshot was not accepted"
    );
    DbError::Init(format!("Legacy database snapshot failed at {stage}"))
}

fn sqlite_failure(stage: &'static str, error: rusqlite::Error) -> DbError {
    let sqlite_code = match error {
        rusqlite::Error::SqliteFailure(code, _) => Some(code.extended_code),
        _ => None,
    };
    warn!(
        code = "LEGACY_SNAPSHOT_FAILED",
        stage, sqlite_code, "Legacy database snapshot was not accepted"
    );
    DbError::Init(format!(
        "Legacy database snapshot failed at {stage} (SQLite code {sqlite_code:?})"
    ))
}

fn io_failure(stage: &'static str, error: io::Error) -> DbError {
    let os_code = error.raw_os_error();
    warn!(
        code = "LEGACY_SNAPSHOT_FAILED",
        stage, os_code, "Legacy database snapshot was not accepted"
    );
    DbError::Init(format!(
        "Legacy database snapshot failed at {stage} (OS code {os_code:?})"
    ))
}

// Unlike Path::exists, do not mistake an inaccessible path or a dangling link for absence.
fn exists(path: &Path) -> Result<bool, DbError> {
    match symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_failure("path_check", error)),
    }
}

fn require_no_sidecars(path: &Path) -> Result<(), DbError> {
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sibling = path.as_os_str().to_os_string();
        sibling.push(suffix);
        if exists(Path::new(&sibling))? {
            return Err(failure("sidecar_conflict"));
        }
    }
    Ok(())
}

/// Snapshot `aionui.db` only when the backend catalog does not already exist.
/// A completed snapshot includes committed WAL content; it does not include every later commit.
/// Deadlines below are cooperative, not preemption of an individual filesystem/SQLite call.
pub fn maybe_copy_legacy_database(target: &Path) -> Result<(), DbError> {
    copy_with_limits(target, &Limits::default(), || Ok(()))
}

fn copy_with_limits(
    target: &Path,
    limits: &Limits,
    before_publish: impl FnOnce() -> Result<(), DbError>,
) -> Result<(), DbError> {
    if exists(target)? {
        return Ok(());
    }
    let source_path = target.with_file_name("aionui.db");
    if !exists(&source_path)? {
        return Ok(());
    }
    // This lock coordinates our own startup/CLI paths. SQLite's backup API, not this
    // advisory lock, supplies source consistency when a legacy writer remains open.
    let _guard = MigrateLockGuard::acquire_with_timeout(&migrate_lock_path(target), limits.lock)
        .map_err(|error| io_failure("lock", error))?;
    if exists(target)? {
        return Ok(());
    }
    require_no_sidecars(target)?;
    let started = Instant::now();
    info!(
        code = "LEGACY_SNAPSHOT_STARTED",
        "Creating a consistent legacy database snapshot"
    );

    let source = Connection::open_with_flags(
        &source_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| sqlite_failure("source_open", error))?;
    source
        .busy_timeout(Duration::ZERO)
        .map_err(|error| sqlite_failure("source_busy_policy", error))?;

    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    // All cleanup is inside this unique attempt directory. Unknown fixed .db.tmp
    // files and all source/target sidecars are never removed by this function.
    let attempt = tempfile::Builder::new()
        .prefix(".aionui-legacy-snapshot-")
        .tempdir_in(parent)
        .map_err(|error| io_failure("temporary_directory", error))?;
    let temporary = tempfile::NamedTempFile::new_in(attempt.path())
        .map_err(|error| io_failure("temporary_file", error))?
        .into_temp_path();
    let mut destination = Connection::open_with_flags(
        &temporary,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| sqlite_failure("destination_open", error))?;
    destination
        .busy_timeout(Duration::ZERO)
        .map_err(|error| sqlite_failure("destination_busy_policy", error))?;
    let backup_started = Instant::now();
    {
        let backup = Backup::new(&source, &mut destination).map_err(|error| sqlite_failure("backup_init", error))?;
        loop {
            if backup_started.elapsed() >= limits.backup {
                return Err(failure("backup_deadline"));
            }
            let result = backup.step(256).map_err(|error| sqlite_failure("backup_step", error))?;
            if backup_started.elapsed() >= limits.backup {
                return Err(failure("backup_deadline"));
            }
            match result {
                StepResult::Done => break,
                StepResult::More => {}
                StepResult::Busy | StepResult::Locked => std::thread::sleep(Duration::from_millis(25)),
                _ => return Err(failure("backup_result")),
            }
        }
    } // Backup::drop finishes the successfully completed backup before destination SQL.
    source
        .close()
        .map_err(|(_, error)| sqlite_failure("source_close", error))?;

    // Change only the owned destination: publish a standalone main file, never a
    // database that still depends on a temporary filename's WAL or journal.
    let mode: String = destination
        .query_row("PRAGMA journal_mode=DELETE", [], |row| row.get(0))
        .map_err(|error| sqlite_failure("destination_journal", error))?;
    if mode != "delete" {
        return Err(failure("destination_journal"));
    }
    destination
        .pragma_update(None, "trusted_schema", false)
        .map_err(|error| sqlite_failure("validation_policy", error))?;
    let validation_started = Instant::now();
    let validation_budget = limits.validation;
    let mut callbacks = 0_u32;
    destination.progress_handler(
        1000,
        Some(move || {
            callbacks += 1;
            callbacks >= 20_000 || validation_started.elapsed() >= validation_budget
        }),
    );
    let validation = (|| {
        let mut statement = destination
            .prepare("PRAGMA quick_check(1)")
            .map_err(|error| sqlite_failure("validation", error))?;
        let mut rows = statement
            .query([])
            .map_err(|error| sqlite_failure("validation", error))?;
        let row = rows
            .next()
            .map_err(|error| sqlite_failure("validation", error))?
            .ok_or_else(|| failure("validation_result"))?;
        let result: String = row.get(0).map_err(|error| sqlite_failure("validation_result", error))?;
        if result != "ok"
            || rows
                .next()
                .map_err(|error| sqlite_failure("validation", error))?
                .is_some()
        {
            return Err(failure("validation_result"));
        }
        if validation_started.elapsed() >= validation_budget {
            return Err(failure("validation_deadline"));
        }
        Ok(())
    })();
    destination.progress_handler(0, None::<fn() -> bool>);
    validation?;
    destination
        .close()
        .map_err(|(_, error)| sqlite_failure("destination_close", error))?;
    require_no_sidecars(&temporary)?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(&temporary)
        .and_then(|file| file.sync_all())
        .map_err(|error| io_failure("destination_flush", error))?;

    before_publish()?;
    require_no_sidecars(target)?;
    // No-clobber publication is essential: std::fs::rename may replace an existing
    // target on some platforms. tempfile uses no-replace MoveFileExW on Windows;
    // do not infer universal crash durability/atomicity on every other filesystem.
    temporary
        .persist_noclobber(target)
        .map_err(|error| io_failure("publish", error.error))?;
    // A non-cooperating process can still create foreign sidecars. Stop without
    // removing them or the now-published target if that race is observed.
    require_no_sidecars(target)?;
    info!(
        code = "LEGACY_SNAPSHOT_COMPLETED",
        elapsed_ms = started.elapsed().as_millis(),
        "Legacy database snapshot published"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fs2::FileExt;

    fn fixture(parent: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
        let legacy = parent.join("aionui.db");
        let target = parent.join("aionui-backend.db");
        let source = Connection::open(&legacy).unwrap();
        source
            .execute_batch(
                "CREATE TABLE handoff_fixture(id INTEGER PRIMARY KEY); INSERT INTO handoff_fixture VALUES(1)",
            )
            .unwrap();
        source.close().unwrap();
        (legacy, target)
    }

    fn no_attempts_left(parent: &Path) {
        assert!(std::fs::read_dir(parent).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".aionui-legacy-snapshot-")
        }));
    }

    #[test]
    fn each_foreign_sidecar_is_rejected_and_preserved() {
        for suffix in ["db-wal", "db-shm", "db-journal"] {
            let directory = tempfile::tempdir().unwrap();
            let (legacy, target) = fixture(directory.path());
            let before = std::fs::read(&legacy).unwrap();
            let conflict = target.with_extension(suffix);
            std::fs::write(&conflict, b"foreign sidecar evidence").unwrap();
            let error = maybe_copy_legacy_database(&target).unwrap_err();
            assert!(error.to_string().contains("sidecar_conflict"));
            assert!(!target.exists());
            assert_eq!(std::fs::read(conflict).unwrap(), b"foreign sidecar evidence");
            assert_eq!(std::fs::read(legacy).unwrap(), before);
            no_attempts_left(directory.path());
        }
    }

    #[test]
    fn racing_target_is_never_replaced() {
        let directory = tempfile::tempdir().unwrap();
        let (legacy, target) = fixture(directory.path());
        let before = std::fs::read(&legacy).unwrap();
        let error = copy_with_limits(&target, &Limits::default(), || {
            std::fs::write(&target, b"concurrent target").unwrap();
            Ok(())
        })
        .unwrap_err();
        assert!(error.to_string().contains("publish"));
        assert_eq!(std::fs::read(target).unwrap(), b"concurrent target");
        assert_eq!(std::fs::read(legacy).unwrap(), before);
        no_attempts_left(directory.path());
    }

    #[test]
    fn sidecar_appearing_before_publication_stops_without_deleting_it() {
        let directory = tempfile::tempdir().unwrap();
        let (_, target) = fixture(directory.path());
        let wal = target.with_extension("db-wal");
        let error = copy_with_limits(&target, &Limits::default(), || {
            std::fs::write(&wal, b"late foreign WAL").unwrap();
            Ok(())
        })
        .unwrap_err();
        assert!(error.to_string().contains("sidecar_conflict"));
        assert!(!target.exists());
        assert_eq!(std::fs::read(wal).unwrap(), b"late foreign WAL");
        no_attempts_left(directory.path());
    }

    #[test]
    fn malformed_source_does_not_publish_or_remove_stale_fixed_temp() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = directory.path().join("aionui.db");
        let target = directory.path().join("aionui-backend.db");
        let stale = target.with_extension("db.tmp");
        std::fs::write(&legacy, b"not a SQLite database").unwrap();
        std::fs::write(&stale, b"another attempt's evidence").unwrap();
        assert!(maybe_copy_legacy_database(&target).is_err());
        assert!(!target.exists());
        assert_eq!(std::fs::read(legacy).unwrap(), b"not a SQLite database");
        assert_eq!(std::fs::read(stale).unwrap(), b"another attempt's evidence");
        no_attempts_left(directory.path());
    }

    #[test]
    fn lock_contention_fails_closed_within_the_copy_budget() {
        let directory = tempfile::tempdir().unwrap();
        let (_, target) = fixture(directory.path());
        let held = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(migrate_lock_path(&target))
            .unwrap();
        FileExt::lock_exclusive(&held).unwrap();
        let limits = Limits {
            lock: Duration::from_millis(50),
            ..Limits::default()
        };
        let started = Instant::now();
        let error = copy_with_limits(&target, &limits, || Ok(())).unwrap_err();
        assert!(error.to_string().contains("lock"));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!target.exists());
        no_attempts_left(directory.path());
    }

    #[test]
    fn sqlite_contention_does_not_spin_forever_or_publish_partial_backup() {
        let directory = tempfile::tempdir().unwrap();
        let (legacy, target) = fixture(directory.path());
        let held = Connection::open(&legacy).unwrap();
        held.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let limits = Limits {
            backup: Duration::from_millis(50),
            ..Limits::default()
        };
        let started = Instant::now();
        let error = copy_with_limits(&target, &limits, || Ok(())).unwrap_err();
        assert!(error.to_string().contains("backup_deadline"));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!target.exists());
        no_attempts_left(directory.path());
        held.execute_batch("ROLLBACK").unwrap();
    }

    #[test]
    fn validation_deadline_prevents_publication() {
        let directory = tempfile::tempdir().unwrap();
        let (_, target) = fixture(directory.path());
        let limits = Limits {
            validation: Duration::ZERO,
            ..Limits::default()
        };
        assert!(copy_with_limits(&target, &limits, || Ok(())).is_err());
        assert!(!target.exists());
        no_attempts_left(directory.path());
    }

    #[test]
    fn standalone_handoff_supports_spaced_unicode_paths_without_touching_stale_temp() {
        let directory = tempfile::tempdir().unwrap();
        let spaced = directory.path().join("synthetic 한글 project");
        std::fs::create_dir(&spaced).unwrap();
        let (_, target) = fixture(&spaced);
        let stale = target.with_extension("db.tmp");
        std::fs::write(&stale, b"untouched stale evidence").unwrap();
        maybe_copy_legacy_database(&target).unwrap();
        require_no_sidecars(&target).unwrap();
        let read = Connection::open_with_flags(&target, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(
            read.query_row("SELECT COUNT(*) FROM handoff_fixture", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(std::fs::read(stale).unwrap(), b"untouched stale evidence");
        read.close().unwrap();
        no_attempts_left(&spaced);
    }
}
