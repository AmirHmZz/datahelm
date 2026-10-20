use crate::{
    AppState,
    auth::ApiResult,
    clickhouse::{self, identifier, literal},
    clickhouse_model::*,
    model::{DatabaseEngine, KillRequest},
};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::{get, post},
};
use serde::Deserialize;
use utoipa::OpenApi;

#[derive(OpenApi)]
#[openapi(
    paths(
        databases,
        tables,
        columns,
        replicas,
        queries,
        history,
        users,
        roles,
        grants,
        role_grants,
        privileges,
        create_user,
        update_user,
        delete_user,
        create_role,
        delete_role,
        grant,
        revoke,
        assign_role,
        revoke_role,
        default_roles,
        networks,
        kill
    ),
    components(schemas(
        Capabilities,
        Feature,
        DatabaseRow,
        TableRow,
        ColumnRow,
        ReplicaRow,
        QueryRow,
        HistoryRow,
        UserRow,
        RoleRow,
        GrantRow,
        RoleGrantRow,
        PrivilegeRow,
        TargetKind,
        Target,
        UserChange,
        RoleChange,
        GrantChange,
        RoleGrantChange,
        DefaultRoleMode,
        DefaultRoles,
        NetworkMode,
        Networks,
        MutationResult
    ))
)]
struct Doc;
pub fn openapi() -> utoipa::openapi::OpenApi {
    Doc::openapi()
}
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/connections/{id}/clickhouse/databases", get(databases))
        .route("/connections/{id}/clickhouse/tables", get(tables))
        .route("/connections/{id}/clickhouse/columns", get(columns))
        .route("/connections/{id}/clickhouse/replicas", get(replicas))
        .route("/connections/{id}/clickhouse/queries", get(queries))
        .route("/connections/{id}/clickhouse/queries/kill", post(kill))
        .route("/connections/{id}/clickhouse/history", get(history))
        .route(
            "/connections/{id}/clickhouse/users",
            get(users)
                .post(create_user)
                .patch(update_user)
                .delete(delete_user),
        )
        .route(
            "/connections/{id}/clickhouse/roles",
            get(roles).post(create_role).delete(delete_role),
        )
        .route(
            "/connections/{id}/clickhouse/grants",
            get(grants).post(grant).delete(revoke),
        )
        .route(
            "/connections/{id}/clickhouse/role-grants",
            get(role_grants).post(assign_role).delete(revoke_role),
        )
        .route("/connections/{id}/clickhouse/privileges", get(privileges))
        .route(
            "/connections/{id}/clickhouse/default-roles",
            axum::routing::put(default_roles),
        )
        .route(
            "/connections/{id}/clickhouse/networks",
            axum::routing::put(networks),
        )
}
async fn check(s: &AppState, id: &str) -> Result<(), String> {
    if s.store.config(id).await?.engine != DatabaseEngine::Clickhouse {
        return Err("This endpoint requires a ClickHouse connection".into());
    }
    Ok(())
}
async fn finish(
    s: &AppState,
    id: &str,
    action: &str,
    result: Result<(), String>,
) -> ApiResult<Json<MutationResult>> {
    s.store
        .audit(action, id, if result.is_ok() { "ok" } else { "failed" })
        .await;
    // A failed HTTP response may follow a completed mutation. Never retry here.
    s.clickhouse.invalidate(id).await;
    result?;
    Ok(Json(MutationResult { ok: true }))
}
macro_rules! read {
    ($name:ident,$path:literal,$row:ty,$sql:expr) => {
        #[utoipa::path(get,path=$path,responses((status=200,body=Vec<$row>)))]
        async fn $name(
            State(s): State<AppState>,
            Path(id): Path<String>,
        ) -> ApiResult<Json<Vec<$row>>> {
            check(&s, &id).await?;
            Ok(Json(s.clickhouse.rows(&s.store, &id, $sql).await?))
        }
    };
}
read!(
    databases,
    "/api/v1/connections/{id}/clickhouse/databases",
    DatabaseRow,
    "SELECT name,engine FROM system.databases ORDER BY name"
);
read!(
    replicas,
    "/api/v1/connections/{id}/clickhouse/replicas",
    ReplicaRow,
    "SELECT database,table,replica_name,is_readonly,toString(queue_size) queue_size,toString(absolute_delay) absolute_delay FROM system.replicas ORDER BY database,table"
);
read!(
    history,
    "/api/v1/connections/{id}/clickhouse/history",
    HistoryRow,
    "SELECT query_id,user,left(query,4000) query,toString(q.event_time) event_time,toString(query_duration_ms) query_duration_ms,toString(read_rows) read_rows,exception_code FROM system.query_log AS q WHERE q.event_date >= today()-1 AND q.event_time >= now()-INTERVAL 1 DAY AND type IN ('QueryFinish','ExceptionWhileProcessing') AND query_kind='Select' AND NOT startsWith(query_id,'datahelm-') ORDER BY q.event_time DESC LIMIT 100"
);
read!(
    grants,
    "/api/v1/connections/{id}/clickhouse/grants",
    GrantRow,
    clickhouse::GRANTS
);
read!(
    role_grants,
    "/api/v1/connections/{id}/clickhouse/role-grants",
    RoleGrantRow,
    clickhouse::ROLE_GRANTS
);
read!(
    privileges,
    "/api/v1/connections/{id}/clickhouse/privileges",
    PrivilegeRow,
    clickhouse::PRIVILEGES
);
#[derive(Deserialize)]
pub struct CatalogQuery {
    pub database: String,
    pub table: Option<String>,
}
#[utoipa::path(get,path="/api/v1/connections/{id}/clickhouse/tables",params(("database"=String,Query)),responses((status=200,body=Vec<TableRow>)))]
async fn tables(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<CatalogQuery>,
) -> ApiResult<Json<Vec<TableRow>>> {
    check(&s, &id).await?;
    identifier(&q.database)?;
    Ok(Json(s.clickhouse.rows(&s.store,&id,&format!("SELECT database,name,engine,toString(total_rows) total_rows,toString(total_bytes) total_bytes,partition_key,sorting_key FROM system.tables WHERE database={} ORDER BY name",literal(&q.database))).await?))
}
#[utoipa::path(get,path="/api/v1/connections/{id}/clickhouse/columns",params(("database"=String,Query),("table"=String,Query)),responses((status=200,body=Vec<ColumnRow>)))]
async fn columns(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<CatalogQuery>,
) -> ApiResult<Json<Vec<ColumnRow>>> {
    check(&s, &id).await?;
    identifier(&q.database)?;
    let table = q.table.ok_or("Choose a table".to_string())?;
    identifier(&table)?;
    Ok(Json(s.clickhouse.rows(&s.store,&id,&format!("SELECT database,table,name,type,default_kind,default_expression FROM system.columns WHERE database={} AND table={} ORDER BY position",literal(&q.database),literal(&table))).await?))
}
#[utoipa::path(get,path="/api/v1/connections/{id}/clickhouse/users",operation_id="clickhouse_users",responses((status=200,body=Vec<UserRow>)))]
async fn users(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<Vec<UserRow>>> {
    check(&s, &id).await?;
    Ok(Json(s.clickhouse.users(&s.store, &id).await?))
}
#[utoipa::path(get,path="/api/v1/connections/{id}/clickhouse/roles",operation_id="clickhouse_roles",responses((status=200,body=Vec<RoleRow>)))]
async fn roles(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<Vec<RoleRow>>> {
    check(&s, &id).await?;
    Ok(Json(s.clickhouse.roles(&s.store, &id).await?))
}
#[utoipa::path(get,path="/api/v1/connections/{id}/clickhouse/queries",responses((status=200,body=Vec<QueryRow>)))]
async fn queries(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<QueryRow>>> {
    check(&s, &id).await?;
    let lock = s.clickhouse.mutation_lock(&id).await;
    let _guard = lock.lock().await;
    Ok(Json(s.clickhouse.queries(&s.store, &id).await?))
}
#[utoipa::path(post,path="/api/v1/connections/{id}/clickhouse/queries/kill",operation_id="clickhouse_kill",request_body=KillRequest,responses((status=200,body=MutationResult)))]
async fn kill(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<KillRequest>,
) -> ApiResult<Json<MutationResult>> {
    check(&s, &id).await?;
    let lock = s.clickhouse.mutation_lock(&id).await;
    let _guard = lock.lock().await;
    let result = s.clickhouse.kill(&s.store, &id, &input.token).await;
    finish(&s, &id, "clickhouse.query.kill", result).await
}
#[utoipa::path(post,path="/api/v1/connections/{id}/clickhouse/users",operation_id="clickhouse_create_user",request_body=UserChange,responses((status=200,body=MutationResult)))]
async fn create_user(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<UserChange>,
) -> ApiResult<Json<MutationResult>> {
    check(&s, &id).await?;
    let lock = s.clickhouse.mutation_lock(&id).await;
    let _guard = lock.lock().await;
    let result = async {
        let name = identifier(&input.name)?;
        let secret = clickhouse::password(input.password.as_deref().unwrap_or(""))?;
        s.clickhouse
            .execute_mutation(
                &s.store,
                &id,
                &format!("CREATE USER {name} IDENTIFIED WITH bcrypt_password BY {secret} HOST ANY"),
            )
            .await
    }
    .await;
    finish(&s, &id, "clickhouse.user.create", result).await
}
#[utoipa::path(patch,path="/api/v1/connections/{id}/clickhouse/users",operation_id="clickhouse_update_user",request_body=UserChange,responses((status=200,body=MutationResult)))]
async fn update_user(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<UserChange>,
) -> ApiResult<Json<MutationResult>> {
    check(&s, &id).await?;
    let lock = s.clickhouse.mutation_lock(&id).await;
    let _guard = lock.lock().await;
    let result = async {
        s.clickhouse
            .target(
                &s.store,
                &id,
                &Target {
                    kind: TargetKind::User,
                    name: input.name.clone(),
                },
                input.password.as_deref().is_some_and(|p| !p.is_empty()),
            )
            .await?;
        if let Some(secret) = input.password.as_deref().filter(|p| !p.is_empty()) {
            s.clickhouse
                .execute_mutation(
                    &s.store,
                    &id,
                    &format!(
                        "ALTER USER {} IDENTIFIED WITH bcrypt_password BY {}",
                        identifier(&input.name)?,
                        clickhouse::password(secret)?
                    ),
                )
                .await?;
        }
        Ok(())
    }
    .await;
    finish(&s, &id, "clickhouse.user.password", result).await
}
#[utoipa::path(delete,path="/api/v1/connections/{id}/clickhouse/users",operation_id="clickhouse_delete_user",request_body=RoleChange,responses((status=200,body=MutationResult)))]
async fn delete_user(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<RoleChange>,
) -> ApiResult<Json<MutationResult>> {
    remove(s, id, input, TargetKind::User).await
}
#[utoipa::path(post,path="/api/v1/connections/{id}/clickhouse/roles",operation_id="clickhouse_create_role",request_body=RoleChange,responses((status=200,body=MutationResult)))]
async fn create_role(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<RoleChange>,
) -> ApiResult<Json<MutationResult>> {
    check(&s, &id).await?;
    let lock = s.clickhouse.mutation_lock(&id).await;
    let _guard = lock.lock().await;
    let result = async {
        s.clickhouse
            .execute_mutation(
                &s.store,
                &id,
                &format!("CREATE ROLE {}", identifier(&input.name)?),
            )
            .await
    }
    .await;
    finish(&s, &id, "clickhouse.role.create", result).await
}
#[utoipa::path(delete,path="/api/v1/connections/{id}/clickhouse/roles",operation_id="clickhouse_delete_role",request_body=RoleChange,responses((status=200,body=MutationResult)))]
async fn delete_role(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<RoleChange>,
) -> ApiResult<Json<MutationResult>> {
    remove(s, id, input, TargetKind::Role).await
}
async fn remove(
    s: AppState,
    id: String,
    input: RoleChange,
    kind: TargetKind,
) -> ApiResult<Json<MutationResult>> {
    check(&s, &id).await?;
    let lock = s.clickhouse.mutation_lock(&id).await;
    let _guard = lock.lock().await;
    let result = async {
        s.clickhouse
            .target(
                &s.store,
                &id,
                &Target {
                    kind,
                    name: input.name.clone(),
                },
                false,
            )
            .await?;
        s.clickhouse
            .execute_mutation(
                &s.store,
                &id,
                &format!(
                    "DROP {} {}",
                    if kind == TargetKind::User {
                        "USER"
                    } else {
                        "ROLE"
                    },
                    identifier(&input.name)?
                ),
            )
            .await
    }
    .await;
    finish(
        &s,
        &id,
        if kind == TargetKind::User {
            "clickhouse.user.delete"
        } else {
            "clickhouse.role.delete"
        },
        result,
    )
    .await
}
#[utoipa::path(post,path="/api/v1/connections/{id}/clickhouse/grants",request_body=GrantChange,responses((status=200,body=MutationResult)))]
async fn grant(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<GrantChange>,
) -> ApiResult<Json<MutationResult>> {
    change_grant(s, id, input, false).await
}
#[utoipa::path(delete,path="/api/v1/connections/{id}/clickhouse/grants",request_body=GrantChange,responses((status=200,body=MutationResult)))]
async fn revoke(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<GrantChange>,
) -> ApiResult<Json<MutationResult>> {
    change_grant(s, id, input, true).await
}
fn scope(input: &GrantChange) -> Result<String, String> {
    if input.database == "*" && input.table != "*" {
        return Err("Choose a database for table privileges".into());
    }
    let quote = |s: &str| {
        if s == "*" {
            Ok("*".into())
        } else {
            identifier(s)
        }
    };
    Ok(format!(
        "{}.{}",
        quote(&input.database)?,
        quote(&input.table)?
    ))
}
async fn change_grant(
    s: AppState,
    id: String,
    input: GrantChange,
    revoke: bool,
) -> ApiResult<Json<MutationResult>> {
    check(&s, &id).await?;
    let lock = s.clickhouse.mutation_lock(&id).await;
    let _guard = lock.lock().await;
    let result = async {
        s.clickhouse
            .target(&s.store, &id, &input.target, false)
            .await?;
        let privileges: Vec<PrivilegeRow> = s
            .clickhouse
            .rows(&s.store, &id, clickhouse::PRIVILEGES)
            .await?;
        if !input
            .privilege
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '_')
            || !privileges.iter().any(|p| p.privilege == input.privilege)
        {
            return Err("Choose a privilege supported by this ClickHouse server".into());
        }
        let column = if let Some(column) = input.column.as_deref().filter(|c| !c.is_empty()) {
            if input.table == "*" {
                return Err("Column privileges require a table".into());
            }
            format!("({})", identifier(column)?)
        } else {
            String::new()
        };
        let sql = format!(
            "{} {}{} ON {} {} {}{}",
            if revoke {
                if input.grant_option {
                    "REVOKE GRANT OPTION FOR"
                } else {
                    "REVOKE"
                }
            } else {
                "GRANT"
            },
            input.privilege,
            column,
            scope(&input)?,
            if revoke { "FROM" } else { "TO" },
            identifier(&input.target.name)?,
            if !revoke && input.grant_option {
                " WITH GRANT OPTION"
            } else {
                ""
            }
        );
        s.clickhouse.execute_mutation(&s.store, &id, &sql).await
    }
    .await;
    finish(
        &s,
        &id,
        if revoke {
            "clickhouse.privilege.revoke"
        } else {
            "clickhouse.privilege.grant"
        },
        result,
    )
    .await
}
#[utoipa::path(post,path="/api/v1/connections/{id}/clickhouse/role-grants",request_body=RoleGrantChange,responses((status=200,body=MutationResult)))]
async fn assign_role(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<RoleGrantChange>,
) -> ApiResult<Json<MutationResult>> {
    change_role(s, id, input, false).await
}
#[utoipa::path(delete,path="/api/v1/connections/{id}/clickhouse/role-grants",request_body=RoleGrantChange,responses((status=200,body=MutationResult)))]
async fn revoke_role(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<RoleGrantChange>,
) -> ApiResult<Json<MutationResult>> {
    change_role(s, id, input, true).await
}
async fn change_role(
    s: AppState,
    id: String,
    input: RoleGrantChange,
    revoke: bool,
) -> ApiResult<Json<MutationResult>> {
    check(&s, &id).await?;
    let lock = s.clickhouse.mutation_lock(&id).await;
    let _guard = lock.lock().await;
    let result = async {
        s.clickhouse
            .target(&s.store, &id, &input.target, false)
            .await?;
        let sql = format!(
            "{} {} {} {}{}",
            if revoke {
                if input.admin_option {
                    "REVOKE ADMIN OPTION FOR"
                } else {
                    "REVOKE"
                }
            } else {
                "GRANT"
            },
            identifier(&input.role)?,
            if revoke { "FROM" } else { "TO" },
            identifier(&input.target.name)?,
            if !revoke && input.admin_option {
                " WITH ADMIN OPTION"
            } else {
                ""
            }
        );
        s.clickhouse.execute_mutation(&s.store, &id, &sql).await
    }
    .await;
    finish(
        &s,
        &id,
        if revoke {
            "clickhouse.role.revoke"
        } else {
            "clickhouse.role.assign"
        },
        result,
    )
    .await
}
#[utoipa::path(put,path="/api/v1/connections/{id}/clickhouse/default-roles",request_body=DefaultRoles,responses((status=200,body=MutationResult)))]
async fn default_roles(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<DefaultRoles>,
) -> ApiResult<Json<MutationResult>> {
    check(&s, &id).await?;
    let lock = s.clickhouse.mutation_lock(&id).await;
    let _guard = lock.lock().await;
    let result = async {
        s.clickhouse
            .target(
                &s.store,
                &id,
                &Target {
                    kind: TargetKind::User,
                    name: input.user.clone(),
                },
                false,
            )
            .await?;
        let roles = match input.mode {
            DefaultRoleMode::All => "ALL".into(),
            DefaultRoleMode::None => "NONE".into(),
            DefaultRoleMode::List => {
                if input.roles.is_empty() || input.roles.len() > 100 {
                    return Err("Choose 1–100 default roles".into());
                }
                input
                    .roles
                    .iter()
                    .map(|r| identifier(r))
                    .collect::<Result<Vec<_>, _>>()?
                    .join(", ")
            }
        };
        s.clickhouse
            .execute_mutation(
                &s.store,
                &id,
                &format!(
                    "ALTER USER {} DEFAULT ROLE {roles}",
                    identifier(&input.user)?
                ),
            )
            .await
    }
    .await;
    finish(&s, &id, "clickhouse.user.default_roles", result).await
}
#[utoipa::path(put,path="/api/v1/connections/{id}/clickhouse/networks",request_body=Networks,responses((status=200,body=MutationResult)))]
async fn networks(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<Networks>,
) -> ApiResult<Json<MutationResult>> {
    check(&s, &id).await?;
    let lock = s.clickhouse.mutation_lock(&id).await;
    let _guard = lock.lock().await;
    let result = async {
        s.clickhouse
            .target(
                &s.store,
                &id,
                &Target {
                    kind: TargetKind::User,
                    name: input.user.clone(),
                },
                false,
            )
            .await?;
        s.clickhouse
            .execute_mutation(
                &s.store,
                &id,
                &format!(
                    "ALTER USER {} HOST {}",
                    identifier(&input.user)?,
                    clickhouse::network_clause(&input)?
                ),
            )
            .await
    }
    .await;
    finish(&s, &id, "clickhouse.user.networks", result).await
}
