use crate::{
    AppState, api, auth, crypto::Vault, model::PasswordChange, provider::MongoProvider,
    store::Store,
};
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;

async fn state() -> AppState {
    let store = Store::new(
        "sqlite::memory:",
        Vault::new(&STANDARD.encode([17; 32])).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        auth::bootstrap(&store, "admin", || Ok("temporary-password-123".into()))
            .await
            .unwrap(),
        Some("temporary-password-123".into())
    );
    assert!(
        auth::bootstrap(&store, "ignored", || Err(
            "must not read bootstrap password again".into()
        ))
        .await
        .unwrap()
        .is_none()
    );
    AppState {
        store,
        provider: Arc::new(MongoProvider::new("unused".into())),
        login_attempts: Default::default(),
        secure_cookie: true,
        origin: "https://helm.example".into(),
    }
}
async fn request(
    app: &Router,
    path: &str,
    method: &str,
    cookie: &str,
    csrf: &str,
    origin: &str,
    body: Value,
) -> (StatusCode, Value, String) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(format!("/api/v1{path}"))
                .header("cookie", cookie)
                .header("x-csrf-token", csrf)
                .header("origin", origin)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap(), cookie)
}

#[tokio::test]
async fn forced_password_change_enforces_api_csrf_and_revokes_sessions() {
    let state = state().await;
    let (session, cookie) = auth::login(&state, "admin", "temporary-password-123")
        .await
        .unwrap();
    let (_, other_cookie) = auth::login(&state, "admin", "temporary-password-123")
        .await
        .unwrap();
    assert!(session.must_change_password);
    let app = api::router(state.clone());
    assert_eq!(
        request(
            &app,
            "/connections",
            "GET",
            &cookie,
            "",
            "https://helm.example",
            json!(null)
        )
        .await
        .0,
        403
    );
    let status = request(
        &app,
        "/auth/session",
        "GET",
        &cookie,
        "",
        "https://helm.example",
        json!(null),
    )
    .await;
    assert_eq!(status.0, 200);
    assert_eq!(status.1["must_change_password"], true);
    let body = json!({"current_password":"temporary-password-123","new_password":"new-private-password-456"});
    assert_eq!(
        request(
            &app,
            "/auth/password",
            "POST",
            &cookie,
            "",
            "https://helm.example",
            body.clone()
        )
        .await
        .0,
        403
    );
    assert_eq!(
        request(
            &app,
            "/auth/password",
            "POST",
            &cookie,
            &session.csrf_token,
            "https://evil.example",
            body.clone()
        )
        .await
        .0,
        403
    );
    let updated = request(
        &app,
        "/auth/password",
        "POST",
        &cookie,
        &session.csrf_token,
        "https://helm.example",
        body,
    )
    .await;
    assert_eq!(updated.0, 200);
    assert_eq!(updated.1["must_change_password"], false);
    assert_ne!(updated.1["csrf_token"], session.csrf_token);
    for flag in ["HttpOnly", "SameSite=Strict", "Secure"] {
        assert!(updated.2.contains(flag));
    }
    for old in [&cookie, &other_cookie] {
        assert_eq!(
            request(
                &app,
                "/auth/session",
                "GET",
                old,
                "",
                "https://helm.example",
                json!(null)
            )
            .await
            .0,
            401
        );
    }
    assert_eq!(
        request(
            &app,
            "/connections",
            "GET",
            &updated.2,
            "",
            "https://helm.example",
            json!(null)
        )
        .await
        .0,
        200
    );
    assert!(
        auth::login(&state, "admin", "temporary-password-123")
            .await
            .is_err()
    );
    assert!(
        !auth::login(&state, "admin", "new-private-password-456")
            .await
            .unwrap()
            .0
            .must_change_password
    );
    let encoded: String = sqlx::query_scalar("SELECT password_hash FROM admin")
        .fetch_one(&state.store.pool)
        .await
        .unwrap();
    assert!(encoded.starts_with("$argon2id$"));
    let audit: String = sqlx::query_scalar("SELECT action || connection_id || outcome FROM audit")
        .fetch_one(&state.store.pool)
        .await
        .unwrap();
    assert!(
        !audit.contains("temporary-password-123") && !audit.contains("new-private-password-456")
    );
}

#[tokio::test]
async fn password_validation_and_failed_changes_preserve_account() {
    let state = state().await;
    let (session, cookie) = auth::login(&state, "admin", "temporary-password-123")
        .await
        .unwrap();
    let app = api::router(state.clone());
    for (current, next) in [
        (
            "wrong-current-password".to_owned(),
            "new-private-password-456".to_owned(),
        ),
        ("temporary-password-123".to_owned(), "short".to_owned()),
        (
            "temporary-password-123".to_owned(),
            "temporary-password-123".to_owned(),
        ),
        ("temporary-password-123".to_owned(), "x".repeat(1025)),
    ] {
        let result = request(
            &app,
            "/auth/password",
            "POST",
            &cookie,
            &session.csrf_token,
            "https://helm.example",
            json!({"current_password":current,"new_password":next}),
        )
        .await;
        assert_eq!(result.0, 400);
        assert!(!result.1.to_string().contains("temporary-password-123"));
    }
    assert!(
        auth::login(&state, "admin", "temporary-password-123")
            .await
            .unwrap()
            .0
            .must_change_password
    );
    assert_eq!(
        request(
            &app,
            "/auth/logout",
            "POST",
            &cookie,
            &session.csrf_token,
            "https://helm.example",
            json!(null)
        )
        .await
        .0,
        200
    );
    assert_eq!(
        request(
            &app,
            "/auth/session",
            "GET",
            &cookie,
            "",
            "https://helm.example",
            json!(null)
        )
        .await
        .0,
        401
    );
}

#[tokio::test]
async fn password_change_attempts_are_rate_limited() {
    let state = state().await;
    for _ in 0..5 {
        assert_eq!(
            auth::change_password(
                &state,
                "admin",
                PasswordChange {
                    current_password: "incorrect-password".into(),
                    new_password: "new-private-password-456".into()
                }
            )
            .await
            .err()
            .unwrap()
            .0,
            400
        );
    }
    assert_eq!(
        auth::change_password(
            &state,
            "admin",
            PasswordChange {
                current_password: "temporary-password-123".into(),
                new_password: "new-private-password-456".into()
            }
        )
        .await
        .err()
        .unwrap()
        .0,
        429
    );
    for _ in 0..5 {
        assert!(
            auth::login(&state, "different-name", "wrong-password")
                .await
                .is_err()
        );
    }
    assert_eq!(
        auth::login(&state, "admin", "temporary-password-123")
            .await
            .err()
            .unwrap()
            .0,
        429
    );
}

#[tokio::test]
async fn simultaneous_password_changes_cannot_keep_two_passwords_or_sessions() {
    let state = state().await;
    let change = |next: &str| PasswordChange {
        current_password: "temporary-password-123".into(),
        new_password: next.into(),
    };
    let (first, second) = tokio::join!(
        auth::change_password(&state, "admin", change("first-new-password-456")),
        auth::change_password(&state, "admin", change("second-new-password-456"))
    );
    assert_ne!(first.is_ok(), second.is_ok());
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(&state.store.pool)
        .await
        .unwrap();
    assert_eq!(sessions, 1);
    let winner = if first.is_ok() {
        "first-new-password-456"
    } else {
        "second-new-password-456"
    };
    assert!(auth::login(&state, "admin", winner).await.is_ok());
}

#[tokio::test]
async fn existing_administrator_upgrade_requires_change_and_preserves_credentials() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!("sqlite://{}", directory.path().join("legacy.db").display());
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .connect_with(
            url.parse::<sqlx::sqlite::SqliteConnectOptions>()
                .unwrap()
                .create_if_missing(true),
        )
        .await
        .unwrap();
    sqlx::query("CREATE TABLE admin(username TEXT PRIMARY KEY,password_hash TEXT NOT NULL)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO admin VALUES('admin','existing-argon2-hash')")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let store = Store::new(&url, Vault::new(&STANDARD.encode([19; 32])).unwrap())
        .await
        .unwrap();
    let row: (String, bool) =
        sqlx::query_as("SELECT password_hash,must_change_password FROM admin")
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(row, ("existing-argon2-hash".into(), true));
    assert!(
        auth::bootstrap(&store, "admin", || Err(
            "must not generate another administrator".into()
        ))
        .await
        .unwrap()
        .is_none()
    );
}
