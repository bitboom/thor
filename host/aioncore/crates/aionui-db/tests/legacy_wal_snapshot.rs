use aionui_db::maybe_copy_legacy_database;
use sqlx::{Connection, Executor, SqliteConnection, sqlite::SqliteConnectOptions};

#[tokio::test]
async fn retained_legacy_wal_commits_are_present_in_the_handoff() {
    let directory = tempfile::tempdir().unwrap();
    let legacy = directory.path().join("aionui.db");
    let target = directory.path().join("aionui-backend.db");
    let options = SqliteConnectOptions::new().filename(&legacy).create_if_missing(true);
    let mut owner = SqliteConnection::connect_with(&options).await.unwrap();
    owner
        .execute("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0")
        .await
        .unwrap();
    owner
        .execute("CREATE TABLE handoff_fixture(id INTEGER PRIMARY KEY); INSERT INTO handoff_fixture VALUES(1)")
        .await
        .unwrap();
    owner.execute("PRAGMA wal_checkpoint(TRUNCATE)").await.unwrap();
    let mut peer = SqliteConnection::connect_with(&options).await.unwrap();
    peer.execute("PRAGMA wal_autocheckpoint=0; INSERT INTO handoff_fixture VALUES(2)")
        .await
        .unwrap();
    let wal = legacy.with_extension("db-wal");
    let main_before = std::fs::read(&legacy).unwrap();
    let wal_before = std::fs::read(&wal).unwrap();
    assert!(wal_before.len() > 32);
    let source_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM handoff_fixture")
        .fetch_one(&mut owner)
        .await
        .unwrap();
    assert_eq!(source_count, 2);

    maybe_copy_legacy_database(&target).unwrap();

    let mut copied = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&target).read_only(true))
        .await
        .unwrap();
    let copied_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM handoff_fixture")
        .fetch_one(&mut copied)
        .await
        .unwrap();
    assert_eq!(copied_count, 2, "the handoff must include committed WAL content");
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut copied)
        .await
        .unwrap();
    assert_eq!(integrity, "ok");
    assert_eq!(std::fs::read(&legacy).unwrap(), main_before);
    assert_eq!(std::fs::read(&wal).unwrap(), wal_before);
    let version: String = sqlx::query_scalar("SELECT sqlite_version()")
        .fetch_one(&mut owner)
        .await
        .unwrap();
    println!("actual Rust SQLite engine: {version}");
    assert_eq!(version, "3.46.0", "update evidence when the locked engine changes");
    copied.close().await.unwrap();
    peer.close().await.unwrap();
    owner.close().await.unwrap();
}
