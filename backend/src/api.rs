use crate::{
    AppState,
    auth::{self, ApiError, ApiResult},
    model::*,
    provider, ssh,
};
use axum::{
    Json, Router,
    extract::{Path, Query, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use mongodb::bson::{Document, doc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use tower_http::services::{ServeDir, ServeFile};
use utoipa::OpenApi;

#[derive(OpenApi)]
#[openapi(
    paths(
        login,
        session,
        logout,
        change_password,
        connections,
        save_connection,
        update_connection,
        delete_connection,
        test_connection,
        ssh_fingerprint,
        capabilities,
        catalog,
        database_names,
        collection_names,
        collections,
        indexes,
        metrics,
        latest_metric,
        operations,
        kill,
        users,
        create_user,
        update_user,
        delete_user,
        roles,
        create_role,
        update_role,
        delete_role,
        profiles,
        profiler_settings,
        set_profiler,
        logs,
        topology,
        audit
    ),
    components(schemas(
        Login,
        SessionView,
        PasswordChange,
        ConnectionConfig,
        ConnectionView,
        TlsConfig,
        SshConfig,
        Metric,
        TestRequest,
        RoleRef,
        UserMutation,
        RoleMutation,
        Identity,
        ProfilerMutation,
        KillRequest
    )),
    info(title = "DataHelm API", version = "0.1.0")
)]
struct ApiDoc;
pub fn openapi() -> utoipa::openapi::OpenApi {
    ApiDoc::openapi()
}
pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/auth/session", get(session))
        .route("/auth/logout", post(logout))
        .route("/auth/password", post(change_password))
        .route("/connections", get(connections).post(save_connection))
        .route("/connections/test", post(test_connection))
        .route("/connections/ssh-fingerprint", post(ssh_fingerprint))
        .route(
            "/connections/{id}",
            axum::routing::put(update_connection).delete(delete_connection),
        )
        .route("/connections/{id}/capabilities", get(capabilities))
        .route("/connections/{id}/databases", get(catalog))
        .route("/connections/{id}/database-names", get(database_names))
        .route("/connections/{id}/collection-names", get(collection_names))
        .route("/connections/{id}/collections", get(collections))
        .route("/connections/{id}/indexes", get(indexes))
        .route("/connections/{id}/metrics", get(metrics))
        .route("/connections/{id}/metrics/latest", get(latest_metric))
        .route("/connections/{id}/operations", get(operations))
        .route("/connections/{id}/operations/kill", post(kill))
        .route(
            "/connections/{id}/users",
            get(users)
                .post(create_user)
                .patch(update_user)
                .delete(delete_user),
        )
        .route(
            "/connections/{id}/roles",
            get(roles)
                .post(create_role)
                .patch(update_role)
                .delete(delete_role),
        )
        .route("/connections/{id}/profiles", get(profiles))
        .route(
            "/connections/{id}/profiler",
            get(profiler_settings).put(set_profiler),
        )
        .route("/connections/{id}/logs", get(logs))
        .route("/connections/{id}/topology", get(topology))
        .route("/audit", get(audit))
        .route("/openapi.json", get(|| async { Json(openapi()) }))
        .fallback(|| async {
            (
                StatusCode::NOT_FOUND,
                Json(json!({"message":"API route not found"})),
            )
        })
        .route_layer(middleware::from_fn_with_state(state.clone(), guard));
    let dist = std::env::var("DATAHELM_FRONTEND_DIR").unwrap_or_else(|_| "frontend/dist".into());
    Router::new()
        .route("/health", get(|| async { Json(json!({"status":"ok"})) }))
        .nest("/api/v1", protected.route("/auth/login", post(login)))
        .fallback_service(
            ServeDir::new(&dist).not_found_service(ServeFile::new(format!("{dist}/index.html"))),
        )
        .layer(axum::extract::DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(middleware::from_fn(security_headers))
        .with_state(state)
}
async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    response
        .headers_mut()
        .insert("referrer-policy", "no-referrer".parse().unwrap());
    response.headers_mut().insert("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'".parse().unwrap());
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
}
async fn guard(State(state): State<AppState>, request: Request, next: Next) -> ApiResult<Response> {
    let session = auth::authorize(&state, request.headers(), request.method()).await?;
    if session.must_change_password
        && !matches!(
            request.uri().path(),
            "/auth/session"
                | "/auth/logout"
                | "/auth/password"
                | "/api/v1/auth/session"
                | "/api/v1/auth/logout"
                | "/api/v1/auth/password"
        )
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Change your temporary password before continuing".into(),
        ));
    }
    Ok(next.run(request).await)
}
#[utoipa::path(post,path="/api/v1/auth/login",request_body=Login,responses((status=200,body=SessionView)))]
async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Login>,
) -> ApiResult<Response> {
    auth::check_origin(&state, &headers)?;
    let (session, cookie) = auth::login(&state, &input.username, &input.password).await?;
    Ok(([(header::SET_COOKIE, cookie)], Json(session)).into_response())
}
#[utoipa::path(get,path="/api/v1/auth/session",responses((status=200,body=SessionView)))]
async fn session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<SessionView>> {
    Ok(Json(
        auth::authorize(&state, &headers, &axum::http::Method::GET).await?,
    ))
}
#[utoipa::path(post,path="/api/v1/auth/password",request_body=PasswordChange,responses((status=200,body=SessionView)))]
async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<PasswordChange>,
) -> ApiResult<Response> {
    let current = auth::authorize(&state, &headers, &axum::http::Method::POST).await?;
    let (session, cookie) = auth::change_password(&state, &current.username, input).await?;
    Ok(([(header::SET_COOKIE, cookie)], Json(session)).into_response())
}
#[utoipa::path(post,path="/api/v1/auth/logout",responses((status=200)))]
async fn logout(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(token) = auth::cookie_token(&headers) {
        sqlx::query("DELETE FROM sessions WHERE token_hash=?")
            .bind(auth::hash(&token))
            .execute(&state.store.pool)
            .await
            .map_err(|_| "Cannot revoke session".to_string())?;
    }
    Ok((
        [(
            header::SET_COOKIE,
            "datahelm_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
        )],
        Json(json!({"ok":true})),
    )
        .into_response())
}
#[utoipa::path(get,path="/api/v1/connections",responses((status=200,body=Vec<ConnectionView>)))]
async fn connections(State(s): State<AppState>) -> ApiResult<Json<Vec<ConnectionView>>> {
    Ok(Json(s.store.list().await?))
}
#[utoipa::path(post,path="/api/v1/connections",request_body=ConnectionConfig,responses((status=200,body=Value)))]
async fn save_connection(
    State(s): State<AppState>,
    Json(c): Json<ConnectionConfig>,
) -> ApiResult<Json<Value>> {
    c.validate()?;
    let id = uuid::Uuid::new_v4().to_string();
    s.store.save(&id, &c).await?;
    s.store.audit("connection.create", &id, "ok").await;
    Ok(Json(json!({"id":id})))
}
#[utoipa::path(put,path="/api/v1/connections/{id}",request_body=ConnectionConfig,responses((status=200,body=Value)))]
async fn update_connection(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(mut c): Json<ConnectionConfig>,
) -> ApiResult<Json<Value>> {
    let old = s.store.config(&id).await?;
    c.preserve(&old);
    c.validate()?;
    s.store.save(&id, &c).await?;
    s.provider.invalidate(&id).await;
    s.store.audit("connection.update", &id, "ok").await;
    Ok(Json(json!({"id":id})))
}
#[utoipa::path(delete,path="/api/v1/connections/{id}",responses((status=200,body=Value)))]
async fn delete_connection(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    s.store.config(&id).await?;
    let mut tx = s
        .store
        .pool
        .begin()
        .await
        .map_err(|_| "Storage unavailable".to_string())?;
    sqlx::query("DELETE FROM metrics WHERE connection_id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(|_| "Cannot delete metrics".to_string())?;
    sqlx::query("DELETE FROM connections WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(|_| "Cannot delete connection".to_string())?;
    tx.commit()
        .await
        .map_err(|_| "Cannot delete connection".to_string())?;
    s.provider.invalidate(&id).await;
    s.store.audit("connection.delete", &id, "ok").await;
    Ok(Json(json!({"ok":true})))
}
#[utoipa::path(post,path="/api/v1/connections/test",request_body=TestRequest,responses((status=200,body=Value)))]
async fn test_connection(
    State(s): State<AppState>,
    Json(mut input): Json<TestRequest>,
) -> ApiResult<Json<Value>> {
    if let Some(id) = &input.saved_id {
        input.config.preserve(&s.store.config(id).await?);
    }
    let start = std::time::Instant::now();
    let result = s.provider.test(&input.config).await;
    if let Some(id) = &input.saved_id {
        s.store
            .status(
                id,
                result.as_ref().err().map(String::as_str),
                start.elapsed().as_millis() as i64,
            )
            .await;
    }
    Ok(Json(result?))
}
#[utoipa::path(post,path="/api/v1/connections/ssh-fingerprint",request_body=TestRequest,responses((status=200,body=Value)))]
async fn ssh_fingerprint(Json(input): Json<TestRequest>) -> ApiResult<Json<Value>> {
    Ok(Json(
        json!({"fingerprint":ssh::fingerprint(&input.config.ssh).await?}),
    ))
}
#[utoipa::path(get,path="/api/v1/connections/{id}/capabilities",responses((status=200,body=Value)))]
async fn capabilities(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(s.provider.capabilities(&s.store, &id).await?))
}
#[utoipa::path(get,path="/api/v1/connections/{id}/databases",responses((status=200,body=Value)))]
async fn catalog(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(s.provider.databases(&s.store, &id).await?))
}
#[derive(Deserialize)]
struct CatalogQuery {
    db: String,
    collection: Option<String>,
}
#[utoipa::path(get,path="/api/v1/connections/{id}/database-names",responses((status=200,body=Vec<String>)))]
async fn database_names(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<String>>> {
    Ok(Json(s.provider.database_names(&s.store, &id).await?))
}
#[utoipa::path(get,path="/api/v1/connections/{id}/collection-names",params(("db"=String,Query)),responses((status=200,body=Vec<String>)))]
async fn collection_names(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<CatalogQuery>,
) -> ApiResult<Json<Vec<String>>> {
    Ok(Json(
        s.provider.collection_names(&s.store, &id, &q.db).await?,
    ))
}
#[utoipa::path(get,path="/api/v1/connections/{id}/collections",params(("db"=String,Query)),responses((status=200,body=Value)))]
async fn collections(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<CatalogQuery>,
) -> ApiResult<Json<Value>> {
    Ok(Json(s.provider.collections(&s.store, &id, &q.db).await?))
}
#[utoipa::path(get,path="/api/v1/connections/{id}/indexes",params(("db"=String,Query),("collection"=String,Query)),responses((status=200,body=Value)))]
async fn indexes(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<CatalogQuery>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        s.provider
            .indexes(
                &s.store,
                &id,
                &q.db,
                q.collection.as_deref().ok_or_else(|| {
                    ApiError(StatusCode::BAD_REQUEST, "Collection required".into())
                })?,
            )
            .await?,
    ))
}
#[derive(Deserialize)]
struct HistoryQuery {
    from: Option<i64>,
    to: Option<i64>,
}
#[utoipa::path(get,path="/api/v1/connections/{id}/metrics/latest",responses((status=200,body=Option<Metric>)))]
async fn latest_metric(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Option<Metric>>> {
    s.store.config(&id).await?;
    let payload: Option<String> = sqlx::query_scalar(
        "SELECT payload FROM metrics WHERE connection_id=? ORDER BY timestamp DESC LIMIT 1",
    )
    .bind(id)
    .fetch_optional(&s.store.pool)
    .await
    .map_err(|_| "Cannot load latest sample".to_string())?;
    Ok(Json(
        payload
            .map(|p| serde_json::from_str(&p))
            .transpose()
            .map_err(|_| "Invalid stored metric".to_string())?,
    ))
}
#[utoipa::path(get,path="/api/v1/connections/{id}/metrics",params(("from"=Option<i64>,Query),("to"=Option<i64>,Query)),responses((status=200,body=Vec<Metric>)))]
async fn metrics(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<HistoryQuery>,
) -> ApiResult<Json<Vec<Metric>>> {
    s.store.config(&id).await?;
    let now = chrono::Utc::now().timestamp_millis();
    let to = q.to.unwrap_or(now).min(now);
    let from = q.from.unwrap_or(to - 1800000).max(now - 604800000);
    if from > to {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Invalid time range".into(),
        ));
    }
    let bucket = if to - from <= 1800000 {
        5000
    } else if to - from <= 86400000 {
        60000
    } else {
        900000
    };
    let rows=sqlx::query("SELECT timestamp/? AS bucket,json_extract(payload,'$.source') AS source,MIN(timestamp) AS timestamp,AVG(json_extract(payload,'$.connections')) AS connections,AVG(json_extract(payload,'$.memory_bytes')) AS memory,AVG(json_extract(payload,'$.virtual_memory_bytes')) AS virtual_memory,MAX(json_extract(payload,'$.replication_lag_seconds')) AS lag,AVG(json_extract(payload,'$.ops_per_second')) AS ops,MAX(json_extract(payload,'$.error')) AS error FROM metrics WHERE connection_id=? AND timestamp BETWEEN ? AND ? GROUP BY bucket,source ORDER BY timestamp LIMIT 2500").bind(bucket).bind(&id).bind(from).bind(to).fetch_all(&s.store.pool).await.map_err(|_|"Cannot load metrics".to_string())?;
    let output = rows
        .into_iter()
        .map(|r| {
            let error: Option<String> = r.get("error");
            Metric {
                timestamp: r.get("timestamp"),
                source: r.get("source"),
                connections: if error.is_none() {
                    r.get("connections")
                } else {
                    None
                },
                memory_bytes: if error.is_none() {
                    r.get("memory")
                } else {
                    None
                },
                virtual_memory_bytes: if error.is_none() {
                    r.get("virtual_memory")
                } else {
                    None
                },
                replication_lag_seconds: if error.is_none() { r.get("lag") } else { None },
                ops_per_second: if error.is_none() { r.get("ops") } else { None },
                error,
                opcounters: json!({}),
                rates: json!({}),
            }
        })
        .collect();
    Ok(Json(output))
}
#[utoipa::path(get,path="/api/v1/connections/{id}/operations",responses((status=200,body=Value)))]
async fn operations(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(s.provider.operations(&s.store, &id).await?))
}
#[utoipa::path(post,path="/api/v1/connections/{id}/operations/kill",request_body=KillRequest,responses((status=200,body=Value)))]
async fn kill(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<KillRequest>,
) -> ApiResult<Json<Value>> {
    let result = s.provider.kill(&s.store, &id, &input.token).await;
    finish(&s, "operation.kill", &id, result).await
}
#[derive(Deserialize)]
struct AccessQuery {
    db: Option<String>,
    name: Option<String>,
}
#[utoipa::path(get,path="/api/v1/connections/{id}/users",params(("db"=Option<String>,Query),("name"=Option<String>,Query)),responses((status=200,body=Value)))]
async fn users(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<AccessQuery>,
) -> ApiResult<Json<Value>> {
    let db = q.db.as_deref().unwrap_or("admin");
    let command = if let Some(name) = q.name {
        doc! {"usersInfo":{"user":name,"db":db},"showPrivileges":true,"showAuthenticationRestrictions":true,"showCredentials":false}
    } else if q.db.is_some() {
        doc! {"usersInfo":1,"showCredentials":false}
    } else {
        doc! {"usersInfo":{"forAllDBs":true},"showCredentials":false}
    };
    Ok(Json(s.provider.command(&s.store, &id, db, command).await?))
}
fn user_command(input: UserMutation, create: bool) -> Result<(String, Document), String> {
    if input.user.trim().is_empty() || input.db.is_empty() || input.db == "local" {
        return Err("A username and authentication database other than local are required".into());
    }
    if create && input.db != "$external" && input.password.as_ref().is_none_or(|p| p.is_empty()) {
        return Err("Password required for a SCRAM user".into());
    }
    let mut command = doc! {if create {"createUser"}else{"updateUser"}:input.user,"roles":mongodb::bson::to_bson(&input.roles).map_err(|_|"Invalid roles")?};
    if let Some(password) = input.password {
        if input.db != "$external" {
            command.insert("pwd", password);
        }
    }
    if let Some(mechanisms) = input.mechanisms {
        if !mechanisms
            .iter()
            .all(|m| m == "SCRAM-SHA-256" || m == "SCRAM-SHA-1")
        {
            return Err("Unsupported SCRAM mechanism".into());
        }
        if input.db != "$external" {
            command.insert("mechanisms", mechanisms);
        }
    }
    Ok((input.db, command))
}
#[utoipa::path(post,path="/api/v1/connections/{id}/users",request_body=UserMutation,responses((status=200,body=Value)))]
async fn create_user(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<UserMutation>,
) -> ApiResult<Json<Value>> {
    let (db, cmd) = user_command(input, true)?;
    let result = s.provider.command(&s.store, &id, &db, cmd).await;
    finish(&s, "user.create", &id, result).await
}
#[utoipa::path(patch,path="/api/v1/connections/{id}/users",request_body=UserMutation,responses((status=200,body=Value)))]
async fn update_user(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<UserMutation>,
) -> ApiResult<Json<Value>> {
    let (db, cmd) = user_command(input, false)?;
    let result = s.provider.command(&s.store, &id, &db, cmd).await;
    finish(&s, "user.update", &id, result).await
}
#[utoipa::path(delete,path="/api/v1/connections/{id}/users",request_body=Identity,responses((status=200,body=Value)))]
async fn delete_user(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<Identity>,
) -> ApiResult<Json<Value>> {
    let result = s
        .provider
        .command(&s.store, &id, &input.db, doc! {"dropUser":input.name})
        .await;
    finish(&s, "user.delete", &id, result).await
}
#[utoipa::path(get,path="/api/v1/connections/{id}/roles",params(("db"=Option<String>,Query),("name"=Option<String>,Query)),responses((status=200,body=Value)))]
async fn roles(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<AccessQuery>,
) -> ApiResult<Json<Value>> {
    let db = q.db.as_deref().unwrap_or("admin");
    let command = if let Some(name) = q.name {
        doc! {"rolesInfo":{"role":name,"db":db},"showPrivileges":true}
    } else {
        doc! {"rolesInfo":1,"showBuiltinRoles":true,"showPrivileges":true}
    };
    Ok(Json(s.provider.command(&s.store, &id, db, command).await?))
}
async fn change_role(
    s: &AppState,
    id: &str,
    input: RoleMutation,
    create: bool,
) -> Result<Value, String> {
    if input.role.trim().is_empty()
        || input.db.is_empty()
        || input.db == "local"
        || input.db == "$external"
    {
        return Err("Role name and a valid role database are required".into());
    }
    let existing = s
        .provider
        .command(
            &s.store,
            id,
            &input.db,
            doc! {"rolesInfo":{"role":&input.role,"db":&input.db}},
        )
        .await?;
    if existing["roles"]
        .as_array()
        .is_some_and(|r| r.iter().any(|r| r["isBuiltin"] == true))
    {
        return Err("Built-in roles are read-only".into());
    }
    let command = doc! {if create {"createRole"}else{"updateRole"}:input.role,"roles":mongodb::bson::to_bson(&input.roles).map_err(|_|"Invalid roles")?,"privileges":mongodb::bson::to_bson(&input.privileges).map_err(|_|"Invalid privileges")?};
    s.provider.command(&s.store, id, &input.db, command).await
}
#[utoipa::path(post,path="/api/v1/connections/{id}/roles",request_body=RoleMutation,responses((status=200,body=Value)))]
async fn create_role(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<RoleMutation>,
) -> ApiResult<Json<Value>> {
    let result = change_role(&s, &id, input, true).await;
    finish(&s, "role.create", &id, result).await
}
#[utoipa::path(patch,path="/api/v1/connections/{id}/roles",request_body=RoleMutation,responses((status=200,body=Value)))]
async fn update_role(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<RoleMutation>,
) -> ApiResult<Json<Value>> {
    let result = change_role(&s, &id, input, false).await;
    finish(&s, "role.update", &id, result).await
}
#[utoipa::path(delete,path="/api/v1/connections/{id}/roles",request_body=Identity,responses((status=200,body=Value)))]
async fn delete_role(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<Identity>,
) -> ApiResult<Json<Value>> {
    let existing = s
        .provider
        .command(
            &s.store,
            &id,
            &input.db,
            doc! {"rolesInfo":{"role":&input.name,"db":&input.db}},
        )
        .await?;
    if existing["roles"]
        .as_array()
        .is_some_and(|r| r.iter().any(|r| r["isBuiltin"] == true))
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Built-in roles are read-only".into(),
        ));
    }
    let result = s
        .provider
        .command(&s.store, &id, &input.db, doc! {"dropRole":input.name})
        .await;
    finish(&s, "role.delete", &id, result).await
}
#[derive(Deserialize)]
struct ProfileQuery {
    db: String,
    before: Option<i64>,
    skip: Option<u64>,
    min_ms: Option<i64>,
}
#[utoipa::path(get,path="/api/v1/connections/{id}/profiles",params(("db"=String,Query),("before"=Option<i64>,Query),("skip"=Option<u64>,Query),("min_ms"=Option<i64>,Query)),responses((status=200,body=Value)))]
async fn profiles(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<ProfileQuery>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        s.provider
            .profiles(
                &s.store,
                &id,
                &q.db,
                q.before,
                q.skip.unwrap_or(0),
                q.min_ms.unwrap_or(0),
            )
            .await?,
    ))
}
#[utoipa::path(get,path="/api/v1/connections/{id}/profiler",params(("db"=String,Query)),responses((status=200,body=Value)))]
async fn profiler_settings(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<CatalogQuery>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        s.provider
            .command(&s.store, &id, &q.db, doc! {"profile":-1})
            .await?,
    ))
}
#[utoipa::path(put,path="/api/v1/connections/{id}/profiler",request_body=ProfilerMutation,responses((status=200,body=Value)))]
async fn set_profiler(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<ProfilerMutation>,
) -> ApiResult<Json<Value>> {
    let result = s.provider.profiler(&s.store, &id, &input).await;
    finish(&s, "profiler.update", &id, result).await
}
#[utoipa::path(get,path="/api/v1/connections/{id}/logs",responses((status=200,body=Value)))]
async fn logs(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let v = s
        .provider
        .command(&s.store, &id, "admin", doc! {"getLog":"global"})
        .await?;
    let entries = v["log"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|v| {
            v["msg"]
                .as_str()
                .is_some_and(|s| s.to_lowercase().contains("slow query"))
        })
        .map(provider::redact)
        .collect::<Vec<_>>();
    Ok(Json(
        json!({"items":entries,"source":"MongoDB recent diagnostic log buffer"}),
    ))
}
#[utoipa::path(get,path="/api/v1/connections/{id}/topology",responses((status=200,body=Value)))]
async fn topology(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(s.provider.topology(&s.store, &id).await?))
}
#[utoipa::path(get,path="/api/v1/audit",responses((status=200,body=Value)))]
async fn audit(State(s): State<AppState>) -> ApiResult<Json<Value>> {
    let rows=sqlx::query("SELECT timestamp,action,connection_id,outcome FROM audit ORDER BY timestamp DESC LIMIT 200").fetch_all(&s.store.pool).await.map_err(|_|"Cannot load audit records".to_string())?;
    Ok(Json(json!(rows.into_iter().map(|r|json!({"timestamp":r.get::<i64,_>("timestamp"),"action":r.get::<String,_>("action"),"connection_id":r.get::<String,_>("connection_id"),"outcome":r.get::<String,_>("outcome")})).collect::<Vec<_>>())))
}
async fn finish(
    s: &AppState,
    action: &str,
    id: &str,
    result: Result<Value, String>,
) -> ApiResult<Json<Value>> {
    s.store
        .audit(action, id, if result.is_ok() { "ok" } else { "failed" })
        .await;
    Ok(Json(result?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{crypto::Vault, provider::MongoProvider, store::Store};
    use axum::body::Body;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use std::sync::Arc;
    use tower::ServiceExt;
    async fn state() -> AppState {
        let store = Store::new(
            "sqlite::memory:",
            Vault::new(&STANDARD.encode([42u8; 32])).unwrap(),
        )
        .await
        .unwrap();
        auth::bootstrap(&store, "admin", || Ok("test-password-123".into()))
            .await
            .unwrap();
        // General API fixtures represent an administrator who completed first login.
        sqlx::query("UPDATE admin SET must_change_password=0")
            .execute(&store.pool)
            .await
            .unwrap();
        AppState {
            store,
            provider: Arc::new(MongoProvider::new("unused".into())),
            login_attempts: Default::default(),
            secure_cookie: false,
            origin: "http://localhost:8080".into(),
        }
    }
    #[tokio::test]
    async fn session_csrf_logout_and_redaction() {
        let s = state().await;
        let (session, cookie) = auth::login(&s, "admin", "test-password-123").await.unwrap();
        let app = router(s.clone());
        let request = |method: &str, csrf: Option<&str>| {
            let mut b = axum::http::Request::builder()
                .method(method)
                .uri("/api/v1/connections")
                .header("cookie", &cookie)
                .header("content-type", "application/json");
            if let Some(token) = csrf {
                b = b.header("x-csrf-token", token);
            }
            b.body(Body::from(
                r#"{"name":"test","hosts":"localhost:27017","password":"sensitive"}"#,
            ))
            .unwrap()
        };
        assert_eq!(
            app.clone()
                .oneshot(request("POST", None))
                .await
                .unwrap()
                .status(),
            403
        );
        assert_eq!(
            app.clone()
                .oneshot(request("POST", Some(&session.csrf_token)))
                .await
                .unwrap()
                .status(),
            200
        );
        let mut h = HeaderMap::new();
        h.insert("cookie", cookie.parse().unwrap());
        assert!(
            auth::authorize(&s, &h, &axum::http::Method::GET)
                .await
                .is_ok()
        );
        let connections = s.store.list().await.unwrap();
        assert!(connections[0].has_password);
        assert!(connections[0].config.password.is_none());
        let id = &connections[0].id;
        let sealed: Vec<u8> = sqlx::query_scalar("SELECT sealed FROM connections WHERE id=?")
            .bind(id)
            .fetch_one(&s.store.pool)
            .await
            .unwrap();
        assert!(!String::from_utf8_lossy(&sealed).contains("sensitive"));
        h.insert("x-csrf-token", session.csrf_token.parse().unwrap());
        h.insert("origin", "https://evil.example".parse().unwrap());
        assert!(
            auth::authorize(&s, &h, &axum::http::Method::POST)
                .await
                .is_err()
        );
        sqlx::query("UPDATE sessions SET expires=0")
            .execute(&s.store.pool)
            .await
            .unwrap();
        assert!(
            auth::authorize(&s, &h, &axum::http::Method::GET)
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn preservation_restart_and_retention() {
        let temp = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}", temp.path().join("data.db").display());
        let vault = Vault::new(&STANDARD.encode([3u8; 32])).unwrap();
        let s = Store::new(&url, vault.clone()).await.unwrap();
        let old: ConnectionConfig = serde_json::from_value(
            json!({"name":"a","password":"secret","uri":"mongodb://u:p@localhost"}),
        )
        .unwrap();
        s.save("a", &old).await.unwrap();
        let mut edited = old.public();
        edited.uri = None;
        edited.preserve(&old);
        assert_eq!(edited.password, old.password);
        assert_eq!(edited.uri, old.uri);
        let now = 1_000_000_000;
        for timestamp in [now - 604800001, now] {
            s.metric(
                "a",
                &Metric {
                    timestamp,
                    source: "node".into(),
                    connections: None,
                    memory_bytes: None,
                    virtual_memory_bytes: None,
                    replication_lag_seconds: None,
                    ops_per_second: None,
                    opcounters: json!({}),
                    rates: json!({}),
                    error: None,
                },
            )
            .await
            .unwrap();
        }
        s.prune(now).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM metrics")
                .fetch_one(&s.pool)
                .await
                .unwrap(),
            1
        );
        s.pool.close().await;
        let reopened = Store::new(&url, vault).await.unwrap();
        assert_eq!(
            reopened.config("a").await.unwrap().password,
            Some("secret".into())
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM metrics")
                .fetch_one(&reopened.pool)
                .await
                .unwrap(),
            1
        );
    }
}
