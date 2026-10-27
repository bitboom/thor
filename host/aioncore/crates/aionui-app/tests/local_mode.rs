use aionui_ai_agent::{RuntimeTokenScope, TEAM_RUNTIME_TOKEN_SESSION_GENERATION};
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use serde_json::Value;
use tower::ServiceExt;

#[tokio::test]
async fn local_helpers_require_live_bound_scope_without_desktop_capability() {
    let db = aionui_db::init_database_memory().await.unwrap();
    let config = aionui_app::AppConfig {
        local: true,
        port: 32100,
        local_channel: Some(aionui_app::LocalChannelCredentials::new("01".repeat(32), None).unwrap()),
        ..Default::default()
    };
    let services = aionui_app::AppServices::from_config(db, &config).await.unwrap();
    let router = aionui_app::create_router(&services).await.expect("build router");
    let issue = services.runtime_token_service.issue(
        "system_default_user",
        "local-helper",
        TEAM_RUNTIME_TOKEN_SESSION_GENERATION,
        [RuntimeTokenScope::ConversationHelper],
    );
    let wrong_scope = services.runtime_token_service.issue(
        "system_default_user",
        "local-helper",
        TEAM_RUNTIME_TOKEN_SESSION_GENERATION,
        [RuntimeTokenScope::TeamContext],
    );
    for (token, user, conversation, origin, path, expected) in [
        (
            issue.token.as_str(),
            "system_default_user",
            "local-helper",
            None,
            "/api/settings",
            StatusCode::OK,
        ),
        (
            issue.token.as_str(),
            "forged-user",
            "local-helper",
            None,
            "/api/settings",
            StatusCode::UNAUTHORIZED,
        ),
        (
            issue.token.as_str(),
            "system_default_user",
            "forged-conversation",
            None,
            "/api/settings",
            StatusCode::UNAUTHORIZED,
        ),
        (
            wrong_scope.token.as_str(),
            "system_default_user",
            "local-helper",
            None,
            "/api/settings",
            StatusCode::UNAUTHORIZED,
        ),
        (
            issue.token.as_str(),
            "system_default_user",
            "local-helper",
            Some("null"),
            "/api/settings",
            StatusCode::UNAUTHORIZED,
        ),
        (
            issue.token.as_str(),
            "system_default_user",
            "local-helper",
            None,
            "/ws",
            StatusCode::UNAUTHORIZED,
        ),
    ] {
        let mut request = Request::builder()
            .uri(path)
            .header("host", "127.0.0.1:32100")
            .header("x-aionui-runtime-token", token)
            .header("x-aionui-user-id", user)
            .header("x-aionui-conversation-id", conversation);
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        assert_eq!(
            router
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap()
                .status(),
            expected
        );
    }
    services.database.close().await;
}

#[tokio::test]
async fn test_local_mode_requires_desktop_capability() {
    let db = aionui_db::init_database_memory().await.unwrap();
    let config = aionui_app::AppConfig {
        local: true,
        port: 32100,
        local_channel: Some(aionui_app::LocalChannelCredentials::new("01".repeat(32), None).unwrap()),
        ..Default::default()
    };
    let services = aionui_app::AppServices::from_config(db, &config).await.unwrap();

    let router = aionui_app::create_router(&services).await.expect("build router");

    // Health check should work
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/health")
                .header("host", "127.0.0.1:32100")
                .header("x-thor-local-token", "01".repeat(32))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // No JWT is needed, but the per-child desktop capability is mandatory.
    let response = router
        .oneshot(
            Request::builder()
                .uri("/api/settings")
                .header("host", "127.0.0.1:32100")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    services.database.close().await;
}

#[tokio::test]
async fn test_non_local_mode_requires_auth() {
    let db = aionui_db::init_database_memory().await.unwrap();
    let services = aionui_app::AppServices::from_config(db, &aionui_app::AppConfig::default())
        .await
        .unwrap();

    let router = aionui_app::create_router(&services).await.expect("build router");

    let response = router
        .oneshot(Request::builder().uri("/api/settings").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["code"], "UNAUTHORIZED");

    services.database.close().await;
}

#[tokio::test]
async fn test_local_mode_aionpro_requires_session_and_allows_bootstrap_provision_without_csrf() {
    let db = aionui_db::init_database_memory().await.unwrap();
    let config = aionui_app::AppConfig {
        identity_mode: aionui_app::IdentityMode::AionPro,
        bootstrap_secret: Some("bootstrap-secret".to_string()),
        ..Default::default()
    };
    let services = aionui_app::AppServices::from_config(db, &config).await.unwrap();
    let router = aionui_app::create_router(&services).await.expect("build router");

    let business_response = router
        .clone()
        .oneshot(Request::builder().uri("/api/settings").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(business_response.status(), StatusCode::UNAUTHORIZED);

    let provision_response = router
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/auth/internal/external-users/pro-app")
                .header("content-type", "application/json")
                .header("x-aioncore-bootstrap-secret", "bootstrap-secret")
                .body(Body::from(r#"{"user_type":"aionpro","username":"Pro App User"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(provision_response.status(), StatusCode::OK);
    let body = to_bytes(provision_response.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["data"]["user_type"], "aionpro");
    assert_ne!(json["data"]["user_id"], "system_default_user");

    services.database.close().await;
}
