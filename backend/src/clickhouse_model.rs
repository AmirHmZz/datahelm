use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct ClickHouseMetric {
    pub active_queries: Option<f64>,
    pub queries_per_second: Option<f64>,
    pub read_bytes_per_second: Option<f64>,
    pub written_bytes_per_second: Option<f64>,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct Feature {
    pub available: bool,
    pub reason: Option<String>,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct Capabilities {
    pub engine: String,
    pub server_version: String,
    pub source: String,
    pub features: std::collections::BTreeMap<String, Feature>,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct DatabaseRow {
    pub name: String,
    pub engine: String,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct TableRow {
    pub database: String,
    pub name: String,
    pub engine: String,
    pub total_rows: Option<String>,
    pub total_bytes: Option<String>,
    pub partition_key: String,
    pub sorting_key: String,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct ColumnRow {
    pub database: String,
    pub table: String,
    pub name: String,
    pub r#type: String,
    pub default_kind: String,
    pub default_expression: String,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct ReplicaRow {
    pub database: String,
    pub table: String,
    pub replica_name: String,
    pub is_readonly: u8,
    pub queue_size: String,
    pub absolute_delay: String,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct QueryRow {
    pub query_id: String,
    pub user: String,
    pub query: String,
    pub elapsed: f64,
    pub memory_usage: String,
    pub read_rows: String,
    #[serde(default)]
    pub kill_token: Option<String>,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct HistoryRow {
    pub query_id: String,
    pub user: String,
    pub query: String,
    pub event_time: String,
    pub query_duration_ms: String,
    pub read_rows: String,
    pub exception_code: i32,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct UserRow {
    pub name: String,
    pub id: String,
    pub storage: String,
    pub auth_type: Vec<String>,
    pub host_ip: Vec<String>,
    pub host_names: Vec<String>,
    pub host_names_regexp: Vec<String>,
    pub host_names_like: Vec<String>,
    pub default_roles_all: u8,
    pub default_roles_list: Vec<String>,
    pub default_roles_except: Vec<String>,
    #[serde(default)]
    pub readonly: bool,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct RoleRow {
    pub name: String,
    pub id: String,
    pub storage: String,
    #[serde(default)]
    pub readonly: bool,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct PrivilegeRow {
    pub privilege: String,
    pub level: String,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct GrantRow {
    pub user_name: Option<String>,
    pub role_name: Option<String>,
    pub access_type: String,
    pub database: Option<String>,
    pub table: Option<String>,
    pub column: Option<String>,
    pub is_partial_revoke: u8,
    pub grant_option: u8,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct RoleGrantRow {
    pub user_name: Option<String>,
    pub role_name: Option<String>,
    pub granted_role_name: String,
    pub granted_role_is_default: u8,
    pub with_admin_option: u8,
}
#[derive(Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    User,
    Role,
}
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub kind: TargetKind,
    pub name: String,
}
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct UserChange {
    pub name: String,
    pub password: Option<String>,
}
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RoleChange {
    pub name: String,
}
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct GrantChange {
    pub target: Target,
    pub privilege: String,
    pub database: String,
    pub table: String,
    pub column: Option<String>,
    #[serde(default)]
    pub grant_option: bool,
}
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RoleGrantChange {
    pub target: Target,
    pub role: String,
    #[serde(default)]
    pub admin_option: bool,
}
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum DefaultRoleMode {
    All,
    None,
    List,
}
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DefaultRoles {
    pub user: String,
    pub mode: DefaultRoleMode,
    pub roles: Vec<String>,
}
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum NetworkMode {
    Any,
    Local,
    Ip,
}
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Networks {
    pub user: String,
    pub mode: NetworkMode,
    pub addresses: Vec<String>,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct MutationResult {
    pub ok: bool,
}
