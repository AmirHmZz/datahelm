use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Clone, Copy, Serialize, Deserialize, ToSchema, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseEngine {
    #[default]
    Mongodb,
    Clickhouse,
}

#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct ClickHouseConfig {
    pub endpoint: String,
    #[serde(default = "clickhouse_database")]
    pub database: String,
    #[serde(default = "clickhouse_user")]
    pub username: String,
    pub password: Option<String>,
}
fn clickhouse_database() -> String {
    "default".into()
}
fn clickhouse_user() -> String {
    "default".into()
}
impl ClickHouseConfig {
    pub fn validate(&self) -> Result<(), String> {
        let url = reqwest::Url::parse(&self.endpoint)
            .map_err(|_| "Invalid ClickHouse HTTP(S) endpoint")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("Use an http:// or https:// endpoint without credentials, query parameters, or fragments".into());
        }
        if self.database.is_empty() || self.username.is_empty() {
            return Err("ClickHouse database and username are required".into());
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize, ToSchema, Default)]
pub struct TlsConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub allow_invalid_certificates: bool,
    pub ca_pem: Option<String>,
    pub client_pem: Option<String>,
    pub key_password: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema, Default)]
pub struct SshConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub host: String,
    #[serde(default = "ssh_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub fingerprint: Option<String>,
}
fn ssh_port() -> u16 {
    22
}
fn seeds() -> String {
    "localhost:27017".into()
}
fn enabled() -> bool {
    true
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct ConnectionConfig {
    #[serde(default)]
    pub engine: DatabaseEngine,
    #[serde(default)]
    pub clickhouse: Option<ClickHouseConfig>,
    pub name: String,
    #[serde(default = "mode")]
    pub mode: String,
    pub uri: Option<String>,
    #[serde(default = "seeds")]
    pub hosts: String,
    #[serde(default)]
    pub username: String,
    pub password: Option<String>,
    #[serde(default = "auth_db")]
    pub auth_database: String,
    #[serde(default)]
    pub mechanism: String,
    #[serde(default)]
    pub replica_set: String,
    #[serde(default)]
    pub direct: bool,
    #[serde(default = "enabled")]
    pub monitoring: bool,
    #[serde(default)]
    pub tls: TlsConfig,
    #[serde(default)]
    pub ssh: SshConfig,
}
fn mode() -> String {
    "form".into()
}
fn auth_db() -> String {
    "admin".into()
}
impl ConnectionConfig {
    pub fn public(&self) -> Self {
        let mut c = self.clone();
        c.uri = self.uri.as_ref().map(|_| "[stored URI]".into());
        if c.hosts.contains('@') {
            c.hosts = "[invalid host form]".into();
        }
        c.password = None;
        if let Some(ch) = &mut c.clickhouse {
            ch.password = None;
            if ch.validate().is_err() {
                ch.endpoint = "[invalid endpoint]".into();
            }
        }
        c.tls.ca_pem = None;
        c.tls.client_pem = None;
        c.tls.key_password = None;
        c.ssh.password = None;
        c.ssh.private_key = None;
        c.ssh.passphrase = None;
        c
    }
    // None means preserve; an explicit empty string means clear.
    pub fn preserve(&mut self, old: &Self) {
        if self.engine == old.engine {
            if let (Some(ch), Some(previous)) = (&mut self.clickhouse, &old.clickhouse) {
                if ch.password.is_none() {
                    ch.password = previous.password.clone();
                }
            }
        }
        macro_rules! keep {
            ($a:expr, $b:expr) => {
                if $a.is_none() {
                    $a = $b.clone();
                }
            };
        }
        keep!(self.uri, old.uri);
        keep!(self.password, old.password);
        keep!(self.tls.ca_pem, old.tls.ca_pem);
        keep!(self.tls.client_pem, old.tls.client_pem);
        keep!(self.tls.key_password, old.tls.key_password);
        keep!(self.ssh.password, old.ssh.password);
        keep!(self.ssh.private_key, old.ssh.private_key);
        keep!(self.ssh.passphrase, old.ssh.passphrase);
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() || self.name.len() > 120 {
            return Err("A connection name of 1–120 characters is required".into());
        }
        if self.engine == DatabaseEngine::Clickhouse {
            self.clickhouse
                .as_ref()
                .ok_or("ClickHouse configuration is required")?
                .validate()?;
            if self.tls.enabled
                && !self
                    .clickhouse
                    .as_ref()
                    .unwrap()
                    .endpoint
                    .starts_with("https://")
            {
                return Err("Use an https:// endpoint when TLS is enabled".into());
            }
            if self.tls.client_pem.as_ref().is_some_and(|s| !s.is_empty())
                || self
                    .tls
                    .key_password
                    .as_ref()
                    .is_some_and(|s| !s.is_empty())
            {
                return Err("ClickHouse client certificate authentication is outside this release; use password authentication".into());
            }
        } else {
            if self.clickhouse.is_some() {
                return Err("ClickHouse settings require the ClickHouse engine".into());
            }
            if self.mode != "uri" && self.mode != "form" {
                return Err("Connection mode must be uri or form".into());
            }
            if self.mode == "uri"
                && !self
                    .uri
                    .as_deref()
                    .is_some_and(|u| u.starts_with("mongodb://") || u.starts_with("mongodb+srv://"))
            {
                return Err("Enter a mongodb:// or mongodb+srv:// URI".into());
            }
            if self.mode == "form" && self.hosts.trim().is_empty() {
                return Err("At least one host is required".into());
            }
            if self.mode == "form"
                && self
                    .hosts
                    .chars()
                    .any(|c| matches!(c, '@' | '/' | '?' | '#'))
            {
                return Err("Enter host:port seeds only; use URI mode or the authentication fields for credentials and options".into());
            }
        }
        if self.ssh.enabled
            && (self.ssh.host.trim().is_empty()
                || self.ssh.username.trim().is_empty()
                || self.ssh.port == 0)
        {
            return Err("SSH host, port, and username are required".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_form_cannot_expose_credentials() {
        let c: ConnectionConfig = serde_json::from_value(
            serde_json::json!({"name":"fixture","hosts":"user:private-password@localhost:27017"}),
        )
        .unwrap();
        assert!(c.validate().is_err());
        assert!(
            !serde_json::to_string(&c.public())
                .unwrap()
                .contains("private-password")
        );
    }
    #[test]
    fn legacy_and_clickhouse_secrets() {
        let old: ConnectionConfig =
            serde_json::from_value(serde_json::json!({"name":"legacy"})).unwrap();
        assert!(old.engine == DatabaseEngine::Mongodb);
        assert!(old.validate().is_ok());
        let old:ConnectionConfig=serde_json::from_value(serde_json::json!({"name":"ch","engine":"clickhouse","clickhouse":{"endpoint":"https://localhost:8443","password":"sensitive"}})).unwrap();
        assert!(old.validate().is_ok());
        let mut public = old.public();
        assert!(
            !serde_json::to_string(&public)
                .unwrap()
                .contains("sensitive")
        );
        public.preserve(&old);
        assert_eq!(
            public.clickhouse.as_ref().unwrap().password.as_deref(),
            Some("sensitive")
        );
        public.clickhouse.as_mut().unwrap().password = Some("".into());
        public.preserve(&old);
        assert_eq!(public.clickhouse.unwrap().password.as_deref(), Some(""));
        for endpoint in [
            "http://u:secret@localhost:8123",
            "http://localhost:8123/?password=secret",
            "file:///tmp/key",
            "http://localhost:8123/#secret",
        ] {
            let mut c = old.clone();
            c.clickhouse.as_mut().unwrap().endpoint = endpoint.into();
            assert!(c.validate().is_err());
            assert!(
                !serde_json::to_string(&c.public())
                    .unwrap()
                    .contains("secret")
            );
        }
    }
}
#[derive(Serialize, ToSchema)]
pub struct ConnectionView {
    pub id: String,
    pub config: ConnectionConfig,
    pub status: String,
    pub last_check: Option<i64>,
    pub last_success: Option<i64>,
    pub latency_ms: Option<i64>,
    pub error: Option<String>,
    pub has_password: bool,
    pub has_uri: bool,
    pub has_ca: bool,
    pub has_client_certificate: bool,
    pub has_ssh_key: bool,
    pub has_ssh_password: bool,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct Login {
    pub username: String,
    pub password: String,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct SessionView {
    pub username: String,
    pub csrf_token: String,
    pub must_change_password: bool,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct PasswordChange {
    pub current_password: String,
    pub new_password: String,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct Metric {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clickhouse: Option<crate::clickhouse_model::ClickHouseMetric>,
    pub timestamp: i64,
    pub source: String,
    pub connections: Option<f64>,
    pub memory_bytes: Option<f64>,
    pub virtual_memory_bytes: Option<f64>,
    pub replication_lag_seconds: Option<f64>,
    pub ops_per_second: Option<f64>,
    pub opcounters: serde_json::Value,
    pub rates: serde_json::Value,
    pub error: Option<String>,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct RoleRef {
    pub role: String,
    pub db: String,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct UserMutation {
    pub db: String,
    pub user: String,
    pub password: Option<String>,
    pub roles: Vec<RoleRef>,
    pub mechanisms: Option<Vec<String>>,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct RoleMutation {
    pub db: String,
    pub role: String,
    pub roles: Vec<RoleRef>,
    pub privileges: Vec<serde_json::Value>,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct Identity {
    pub db: String,
    pub name: String,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct ProfilerMutation {
    pub db: String,
    pub enabled: bool,
    pub slow_ms: Option<i64>,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct KillRequest {
    pub token: String,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct TestRequest {
    pub config: ConnectionConfig,
    pub saved_id: Option<String>,
}
