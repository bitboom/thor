//! Authentication boundary for the embedded desktop listener.
//! The capability belongs to Electron main, never the renderer or agent env.

use aionui_auth::{
    IRuntimeTokenVerifier, RUNTIME_CONVERSATION_ID_HEADER, RUNTIME_TOKEN_HEADER, RUNTIME_USER_ID_HEADER,
};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::sync::Arc;

pub const LOCAL_TOKEN_HEADER: &str = "x-thor-local-token";

#[derive(Clone)]
pub struct LocalChannelCredentials {
    token: String,
    trusted_origin: Option<String>,
}

impl std::fmt::Debug for LocalChannelCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalChannelCredentials")
            .field("token", &"[redacted]")
            .finish()
    }
}

impl LocalChannelCredentials {
    pub fn new(token: String, trusted_origin: Option<String>) -> Result<Self, &'static str> {
        if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("THOR_CORE_LOCAL_TOKEN must be a 32-byte hexadecimal capability");
        }
        if let Some(origin) = trusted_origin.as_deref() {
            let url = reqwest::Url::parse(origin).map_err(|_| "Invalid trusted renderer origin")?;
            if url.scheme() != "http"
                || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
                || url.origin().ascii_serialization() != origin
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("Trusted renderer origin must be an exact HTTP loopback origin");
            }
        }
        Ok(Self { token, trusted_origin })
    }
}

#[derive(Clone)]
pub(crate) struct LocalChannelPolicy {
    port: u16,
    credentials: Option<LocalChannelCredentials>,
    runtime_verifier: Option<Arc<dyn IRuntimeTokenVerifier>>,
}

impl LocalChannelPolicy {
    pub(crate) fn new(port: u16, credentials: Option<LocalChannelCredentials>) -> Self {
        Self {
            port,
            credentials,
            runtime_verifier: None,
        }
    }

    pub(crate) fn with_runtime_verifier(mut self, verifier: Option<Arc<dyn IRuntimeTokenVerifier>>) -> Self {
        self.runtime_verifier = verifier;
        self
    }

    fn valid_conversation_helper(&self, headers: &HeaderMap) -> bool {
        let (Some(verifier), Some(token), Some(user), Some(conversation)) = (
            self.runtime_verifier.as_ref(),
            self.single_header(headers, RUNTIME_TOKEN_HEADER),
            self.single_header(headers, RUNTIME_USER_ID_HEADER),
            self.single_header(headers, RUNTIME_CONVERSATION_ID_HEADER),
        ) else {
            return false;
        };
        // This listener has exactly one local identity. The ordinary auth
        // middleware performs the active-user lookup as a second check.
        user == "system_default_user" && verifier.verify_conversation_helper(token, user, conversation)
    }

    fn single_header<'a>(&self, headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
        let mut values = headers.get_all(name).iter();
        let value = values.next()?.to_str().ok()?;
        if values.next().is_some() {
            return None;
        }
        Some(value)
    }

    fn valid_host(&self, headers: &HeaderMap) -> bool {
        let Some(host) = self.single_header(headers, "host") else {
            return false;
        };
        ["127.0.0.1", "localhost", "[::1]"]
            .iter()
            .any(|name| host == format!("{name}:{}", self.port))
    }

    pub(crate) fn valid_token(&self, token: &str) -> bool {
        let Some(credentials) = &self.credentials else {
            return false;
        };
        // Fixed-length comparison, with no early exit on a matching prefix.
        token.len() == credentials.token.len()
            && token
                .bytes()
                .zip(credentials.token.bytes())
                .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
                == 0
    }

    pub(crate) fn token_from_headers(&self, headers: &HeaderMap) -> Option<String> {
        let token = self.single_header(headers, LOCAL_TOKEN_HEADER)?;
        self.valid_token(token).then(|| token.to_owned())
    }

    fn valid_origin(&self, headers: &HeaderMap) -> bool {
        if !headers.contains_key(header::ORIGIN) {
            return true;
        } // authenticated native IPC
        let Some(origin) = self.single_header(headers, "origin") else {
            return false;
        };
        // Electron loadFile has an opaque Origin. It is accepted only AFTER
        // capability verification; an arbitrary browser's null origin has none.
        if origin == "null" {
            return true;
        }
        let Some(host) = self.single_header(headers, "host") else {
            return false;
        };
        origin == format!("http://{host}")
            || self
                .credentials
                .as_ref()
                .and_then(|value| value.trusted_origin.as_deref())
                == Some(origin)
    }
}

// These routes already validate narrowly scoped helper credentials themselves.
// No browser Origin is accepted through that separate channel. Do not replace
// this catalog with a prefix exemption for ordinary authenticated APIs.
fn scoped_helper_path(path: &str) -> bool {
    matches!(
        path,
        "/api/runtime/conversations/create"
            | "/api/runtime/team-tools/context"
            | "/api/runtime/team-tools/call"
            | "/api/runtime/session-messages/send"
            | "/api/runtime/session-messages/targets"
            | "/api/runtime/skills"
    ) || path
        .strip_prefix("/api/runtime/skills/")
        .is_some_and(|name| !name.is_empty())
        || path
            .strip_prefix("/internal/antigravity-hook/")
            .is_some_and(|id| !id.is_empty() && !id.contains('/'))
}

fn ordinary_helper_path(path: &str) -> bool {
    // The existing config/diagnose CLI's authenticated route groups. Do not
    // extend this to auth provisioning, file streams, assets, or WebSockets.
    [
        "/api/conversations",
        "/api/assistants",
        "/api/skills",
        "/api/mcp",
        "/api/providers",
        "/api/settings",
        "/api/agents",
        "/api/cron",
        "/api/teams",
        "/api/internal/conversation-cron",
    ]
    .iter()
    .any(|prefix| path == *prefix || path.strip_prefix(prefix).is_some_and(|tail| tail.starts_with('/')))
}

pub(crate) async fn local_channel_middleware(
    State(policy): State<LocalChannelPolicy>,
    request: Request,
    next: Next,
) -> Response {
    if !policy.valid_host(request.headers()) {
        return (StatusCode::FORBIDDEN, "Local channel host rejected").into_response();
    }
    let helper = !request.headers().contains_key(header::ORIGIN)
        && (scoped_helper_path(request.uri().path())
            || (ordinary_helper_path(request.uri().path()) && policy.valid_conversation_helper(request.headers())));
    if !helper && policy.token_from_headers(request.headers()).is_none() {
        return (StatusCode::UNAUTHORIZED, "Local channel authentication required").into_response();
    }
    if !helper && !policy.valid_origin(request.headers()) {
        return (StatusCode::FORBIDDEN, "Local channel origin rejected").into_response();
    }
    let origin = request.headers().get(header::ORIGIN).cloned();
    let preflight =
        request.method() == Method::OPTIONS && request.headers().contains_key(header::ACCESS_CONTROL_REQUEST_METHOD);
    let mut response = if preflight {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    // Never publish wildcard CORS. Only an already authenticated trusted request
    // reaches this reflection (including an Electron-generated preflight).
    if let Some(origin) = origin {
        let headers = response.headers_mut();
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        headers.insert(header::VARY, HeaderValue::from_static("Origin"));
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("content-type, authorization, x-csrf-token, x-thor-local-token"),
        );
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, routing::get};
    use tower::ServiceExt;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    fn app() -> Router {
        Router::new()
            .route("/test", get(|| async { "private" }).post(|| async { "write" }))
            .route("/ws", get(|| async { StatusCode::SWITCHING_PROTOCOLS }))
            .layer(axum::middleware::from_fn_with_state(
                LocalChannelPolicy::new(
                    32100,
                    Some(LocalChannelCredentials::new(TOKEN.into(), Some("http://localhost:5173".into())).unwrap()),
                ),
                local_channel_middleware,
            ))
    }

    #[tokio::test]
    async fn capability_host_origin_and_preflight_matrix() {
        for path in ["/test", "/ws"] {
            for origin in [
                None,
                Some("http://127.0.0.1:32100"),
                Some("null"),
                Some("http://localhost:5173"),
            ] {
                let mut request = Request::builder()
                    .uri(path)
                    .header("host", "127.0.0.1:32100")
                    .header(LOCAL_TOKEN_HEADER, TOKEN);
                if let Some(origin) = origin {
                    request = request.header("origin", origin);
                }
                assert_eq!(
                    app()
                        .oneshot(request.body(Body::empty()).unwrap())
                        .await
                        .unwrap()
                        .status(),
                    if path == "/ws" {
                        StatusCode::SWITCHING_PROTOCOLS
                    } else {
                        StatusCode::OK
                    }
                );
            }
            for origin in [
                "https://foreign.invalid",
                "http://127.0.0.1:32101",
                "file://",
                "http://localhost:5174",
                "null, https://foreign.invalid",
                "http://127.0.0.1:32100/path",
            ] {
                let response = app()
                    .oneshot(
                        Request::builder()
                            .uri(path)
                            .header("host", "127.0.0.1:32100")
                            .header(LOCAL_TOKEN_HEADER, TOKEN)
                            .header("origin", origin)
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::FORBIDDEN, "{origin}");
                assert!(!response.headers().contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
            }
            for host in [
                "foreign.invalid:32100",
                "127.0.0.1:32101",
                "127.0.0.1",
                "127.0.0.1:32100@foreign.invalid",
            ] {
                assert_eq!(
                    app()
                        .oneshot(
                            Request::builder()
                                .uri(path)
                                .header("host", host)
                                .header(LOCAL_TOKEN_HEADER, TOKEN)
                                .body(Body::empty())
                                .unwrap()
                        )
                        .await
                        .unwrap()
                        .status(),
                    StatusCode::FORBIDDEN
                );
            }
            for origin in [None, Some("null"), Some("http://127.0.0.1:32100")] {
                let mut request = Request::builder().uri(path).header("host", "127.0.0.1:32100");
                if let Some(origin) = origin {
                    request = request.header("origin", origin);
                }
                assert_eq!(
                    app()
                        .oneshot(request.body(Body::empty()).unwrap())
                        .await
                        .unwrap()
                        .status(),
                    StatusCode::UNAUTHORIZED
                );
            }
        }
        let response = app()
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/test")
                    .header("host", "127.0.0.1:32100")
                    .header("origin", "https://foreign.invalid")
                    .header("access-control-request-method", "POST")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(!response.headers().contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
        let response = app()
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/test")
                    .header("host", "127.0.0.1:32100")
                    .header(LOCAL_TOKEN_HEADER, TOKEN)
                    .header("origin", "null")
                    .header("access-control-request-method", "POST")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "null");
    }

    #[tokio::test]
    async fn duplicate_headers_and_wrong_capabilities_fail_closed() {
        for name in ["host", "origin", LOCAL_TOKEN_HEADER] {
            let mut request = Request::builder()
                .uri("/test")
                .header("host", "127.0.0.1:32100")
                .header("origin", "null")
                .header(LOCAL_TOKEN_HEADER, TOKEN)
                .body(Body::empty())
                .unwrap();
            let duplicate = request.headers()[name].clone();
            request.headers_mut().append(name, duplicate);
            assert!(app().oneshot(request).await.unwrap().status().is_client_error());
        }
        let response = app()
            .oneshot(
                Request::builder()
                    .uri("/test")
                    .header("host", "127.0.0.1:32100")
                    .header(LOCAL_TOKEN_HEADER, "wrong")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(!format!("{:?}", LocalChannelCredentials::new(TOKEN.into(), None).unwrap()).contains(TOKEN));
    }
}
