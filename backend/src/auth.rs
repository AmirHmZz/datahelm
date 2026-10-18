use crate::{
    AppState,
    model::{PasswordChange, SessionView},
    store::Store,
};
use argon2::{
    Argon2, PasswordHasher, PasswordVerifier,
    password_hash::{PasswordHash, SaltString},
};
use axum::{
    Json,
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{RngCore, rngs::OsRng};
use sha2::{Digest, Sha256};
use sqlx::Row;

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({"message": self.1}))).into_response()
    }
}
impl From<String> for ApiError {
    fn from(s: String) -> Self {
        let status = if s.contains("permission denied") {
            StatusCode::FORBIDDEN
        } else if s.contains("timed out") {
            StatusCode::GATEWAY_TIMEOUT
        } else if s == "Connection not found" {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::BAD_REQUEST
        };
        Self(status, s)
    }
}
pub type ApiResult<T> = Result<T, ApiError>;
pub fn random_token() -> String {
    let mut b = [0; 32];
    OsRng.fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}
pub fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
pub async fn bootstrap(
    store: &Store,
    username: &str,
    password: impl FnOnce() -> Result<String, String>,
) -> Result<Option<String>, String> {
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM admin")
        .fetch_one(&store.pool)
        .await
        .map_err(|_| "Admin storage error")?;
    if exists == 0 {
        let password = password()?;
        validate_password(&password)?;
        let hashed = encode_password(&password).await?;
        sqlx::query("INSERT INTO admin(username,password_hash,must_change_password) VALUES(?,?,1)")
            .bind(username)
            .bind(hashed)
            .execute(&store.pool)
            .await
            .map_err(|_| "Cannot bootstrap administrator")?;
        return Ok(Some(password));
    }
    Ok(None)
}
fn validate_password(password: &str) -> Result<(), String> {
    if password.chars().count() < 12 || password.len() > 1024 {
        return Err("Use at least 12 characters and at most 1024 bytes for your password".into());
    }
    Ok(())
}
async fn encode_password(password: &str) -> Result<String, String> {
    let password = password.to_owned();
    tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|hash| hash.to_string())
            .map_err(|_| "Password hashing failed".to_string())
    })
    .await
    .map_err(|_| "Password hashing failed".to_string())?
}
async fn verify_password(encoded: &str, password: &str) -> bool {
    if password.len() > 1024 {
        return false;
    }
    let encoded = encoded.to_owned();
    let password = password.to_owned();
    tokio::task::spawn_blocking(move || {
        PasswordHash::new(&encoded).ok().is_some_and(|hash| {
            Argon2::default()
                .verify_password(password.as_bytes(), &hash)
                .is_ok()
        })
    })
    .await
    .unwrap_or(false)
}
fn session_cookie(state: &AppState, token: &str) -> String {
    format!(
        "datahelm_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200{}",
        if state.secure_cookie { "; Secure" } else { "" }
    )
}
async fn throttle(state: &AppState, bucket: &str) -> ApiResult<()> {
    let mut attempts = state.login_attempts.lock().await;
    let attempt = attempts
        .entry(bucket.into())
        .or_insert((std::time::Instant::now(), 0));
    if attempt.0.elapsed().as_secs() >= 60 {
        *attempt = (std::time::Instant::now(), 0);
    }
    if attempt.1 >= 5 {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many attempts. Try again in a minute".into(),
        ));
    }
    attempt.1 += 1;
    Ok(())
}
pub fn cookie_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|c| {
            c.trim()
                .strip_prefix("datahelm_session=")
                .map(str::to_owned)
        })
}
pub async fn authorize(
    state: &AppState,
    headers: &HeaderMap,
    method: &Method,
) -> ApiResult<SessionView> {
    let token = cookie_token(headers)
        .ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "Sign in to continue".into()))?;
    let row = sqlx::query("SELECT s.username,s.csrf,s.expires,a.must_change_password FROM sessions s JOIN admin a ON a.username=s.username WHERE s.token_hash=?")
        .bind(hash(&token))
        .fetch_optional(&state.store.pool)
        .await
        .map_err(|_| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Session storage unavailable".into(),
            )
        })?
        .ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "Session expired".into()))?;
    if row.get::<i64, _>("expires") <= chrono::Utc::now().timestamp_millis() {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "Session expired".into()));
    }
    let session = SessionView {
        username: row.get("username"),
        csrf_token: row.get("csrf"),
        must_change_password: row.get::<bool, _>("must_change_password"),
    };
    if !matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        if headers.get("x-csrf-token").and_then(|h| h.to_str().ok()) != Some(&session.csrf_token) {
            return Err(ApiError(StatusCode::FORBIDDEN, "Invalid CSRF token".into()));
        }
        check_origin(state, headers)?;
    }
    Ok(session)
}
pub fn check_origin(state: &AppState, headers: &HeaderMap) -> ApiResult<()> {
    if let Some(origin) = headers.get("origin") {
        if origin.to_str().ok() != Some(state.origin.as_str()) {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "Origin is not allowed".into(),
            ));
        }
    }
    Ok(())
}
pub async fn login(
    state: &AppState,
    username: &str,
    password: &str,
) -> ApiResult<(SessionView, String)> {
    // Global cap prevents username variations from bypassing the single-admin limit.
    throttle(state, "login").await?;
    let row = sqlx::query("SELECT username,password_hash,must_change_password FROM admin LIMIT 1")
        .fetch_one(&state.store.pool)
        .await
        .map_err(|_| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Administrator unavailable".into(),
            )
        })?;
    let stored_name: String = row.get("username");
    let encoded: String = row.get("password_hash");
    let valid = verify_password(&encoded, password).await;
    if !valid || username != stored_name {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Invalid username or password".into(),
        ));
    }
    let token = random_token();
    let session = SessionView {
        username: stored_name,
        csrf_token: random_token(),
        must_change_password: row.get::<bool, _>("must_change_password"),
    };
    let inserted = sqlx::query("INSERT INTO sessions(token_hash,csrf,username,expires) SELECT ?,?,username,? FROM admin WHERE username=? AND password_hash=?")
        .bind(hash(&token))
        .bind(&session.csrf_token)
        .bind(chrono::Utc::now().timestamp_millis() + 12 * 60 * 60 * 1000)
        .bind(&session.username)
        .bind(encoded)
        .execute(&state.store.pool)
        .await
        .map_err(|_| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Cannot create session".into(),
            )
        })?;
    if inserted.rows_affected() != 1 {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Credentials changed. Sign in again".into(),
        ));
    }
    Ok((session, session_cookie(state, &token)))
}

pub async fn change_password(
    state: &AppState,
    username: &str,
    input: PasswordChange,
) -> ApiResult<(SessionView, String)> {
    validate_password(&input.new_password).map_err(ApiError::from)?;
    throttle(state, "password-change").await?;
    let encoded: String = sqlx::query_scalar("SELECT password_hash FROM admin WHERE username=?")
        .bind(username)
        .fetch_one(&state.store.pool)
        .await
        .map_err(|_| "Administrator unavailable".to_owned())?;
    if !verify_password(&encoded, &input.current_password).await {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Current password is incorrect".into(),
        ));
    }
    if input.current_password == input.new_password {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Choose a different password".into(),
        ));
    }
    let next_hash = encode_password(&input.new_password)
        .await
        .map_err(ApiError::from)?;
    let token = random_token();
    let session = SessionView {
        username: username.into(),
        csrf_token: random_token(),
        must_change_password: false,
    };
    let mut tx = state
        .store
        .pool
        .begin()
        .await
        .map_err(|_| "Cannot change password".to_owned())?;
    let updated = sqlx::query("UPDATE admin SET password_hash=?,must_change_password=0 WHERE username=? AND password_hash=?")
        .bind(next_hash).bind(username).bind(encoded).execute(&mut *tx).await.map_err(|_| "Cannot change password".to_owned())?;
    if updated.rows_affected() != 1 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Credentials changed. Sign in again".into(),
        ));
    }
    sqlx::query("DELETE FROM sessions WHERE username=?")
        .bind(username)
        .execute(&mut *tx)
        .await
        .map_err(|_| "Cannot revoke old sessions".to_owned())?;
    sqlx::query("INSERT INTO sessions VALUES(?,?,?,?)")
        .bind(hash(&token))
        .bind(&session.csrf_token)
        .bind(username)
        .bind(chrono::Utc::now().timestamp_millis() + 12 * 60 * 60 * 1000)
        .execute(&mut *tx)
        .await
        .map_err(|_| "Cannot create replacement session".to_owned())?;
    tx.commit()
        .await
        .map_err(|_| "Cannot commit password change".to_owned())?;
    state
        .store
        .audit("admin.password.change", username, "success")
        .await;
    Ok((session, session_cookie(state, &token)))
}
