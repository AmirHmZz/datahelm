use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

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
