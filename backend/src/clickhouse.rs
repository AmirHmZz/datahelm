//! Bounded HTTP administration of the connected ClickHouse server. No arbitrary SQL API.
use crate::{
    clickhouse_model::*,
    model::{ConnectionConfig, DatabaseEngine, Metric},
    ssh,
    store::Store,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{Mutex, OnceCell};

const MAX_BODY: usize = 4 * 1024 * 1024;
const MAX_ROWS: usize = 1000;
pub const USERS: &str = "SELECT name,toString(id) id,storage,arrayMap(x->toString(x),auth_type) auth_type,host_ip,host_names,host_names_regexp,host_names_like,default_roles_all,default_roles_list,default_roles_except FROM system.users ORDER BY name";
pub const ROLES: &str = "SELECT name,toString(id) id,storage FROM system.roles ORDER BY name";
pub const PRIVILEGES: &str = "SELECT privilege,ifNull(toString(level),'GROUP') level FROM system.privileges ORDER BY privilege";
pub const GRANTS: &str = "SELECT user_name,role_name,toString(access_type) access_type,database,table,column,is_partial_revoke,grant_option FROM system.grants";
pub const ROLE_GRANTS: &str = "SELECT user_name,role_name,granted_role_name,granted_role_is_default,with_admin_option FROM system.role_grants";

struct Entry {
    client: reqwest::Client,
    config: ConnectionConfig,
    _tunnel: Option<ssh::Tunnel>,
}
type Entries = HashMap<String, Arc<OnceCell<Arc<Entry>>>>;
#[derive(Default)]
pub struct ClickHouseProvider {
    entries: Mutex<Entries>,
    mutations: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

pub fn identifier(s: &str) -> Result<String, String> {
    if s.trim().is_empty() || s.len() > 255 || s.chars().any(char::is_control) {
        return Err("Names must contain 1–255 bytes without control characters".into());
    }
    Ok(format!("`{}`", s.replace('\\', "\\\\").replace('`', "\\`")))
}
pub fn literal(s: &str) -> String {
    format!(
        "'{}'",
        s.replace('\\', "\\\\")
            .replace('\'', "\\'")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
            .replace('\t', "\\t")
            .replace('\0', "\\0")
    )
}
pub fn password(s: &str) -> Result<String, String> {
    if s.is_empty() || s.len() > 72 || s.contains('\0') {
        return Err(
            "A bcrypt password must contain 1–72 UTF-8 bytes without NUL; it is never truncated"
                .into(),
        );
    }
    Ok(literal(s))
}
pub fn network_clause(n: &Networks) -> Result<String, String> {
    match n.mode {
        NetworkMode::Any if n.addresses.is_empty() => Ok("ANY".into()),
        NetworkMode::Local if n.addresses.is_empty() => Ok("LOCAL".into()),
        NetworkMode::Ip if !n.addresses.is_empty() && n.addresses.len() <= 100 => {
            let mut addresses = Vec::new();
            for address in &n.addresses {
                let (host, mask) = address
                    .split_once('/')
                    .map_or((address.as_str(), None), |(a, b)| (a, Some(b)));
                let ip: std::net::IpAddr = host
                    .parse()
                    .map_err(|_| "Enter an IPv4/IPv6 address or CIDR network")?;
                if let Some(mask) = mask {
                    let bits: u8 = mask.parse().map_err(|_| "Invalid CIDR mask")?;
                    if bits > if ip.is_ipv4() { 32 } else { 128 } {
                        return Err("Invalid CIDR mask".into());
                    }
                }
                addresses.push(literal(address));
            }
            Ok(format!("IP {}", addresses.join(", ")))
        }
        _ => Err("Choose ANY, LOCAL, or at least one IP/CIDR address".into()),
    }
}
fn writable(storage: &str) -> bool {
    matches!(storage, "local_directory" | "replicated")
}
fn failure(code: Option<i32>) -> String {
    match code {
        Some(497) => "ClickHouse permission denied for this feature".into(),
        Some(516) => "ClickHouse authentication rejected".into(),
        Some(164) => "ClickHouse account or access storage is read-only".into(),
        Some(n) => format!(
            "ClickHouse rejected the request (code {n}); check privileges, arguments, and server settings"
        ),
        None => "ClickHouse request failed; check HTTP(S), authentication, and server availability"
            .into(),
    }
}
fn response_code(bytes: &[u8]) -> Option<i32> {
    std::str::from_utf8(bytes)
        .ok()?
        .strip_prefix("Code: ")?
        .split('.')
        .next()?
        .parse()
        .ok()
}
fn supported(version: &str) -> bool {
    let mut parts = version.split('.');
    let major = parts
        .next()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0);
    let minor = parts
        .next()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0);
    major > 26 || (major == 26 && minor >= 8)
}
impl ClickHouseProvider {
    pub async fn invalidate(&self, id: &str) {
        self.entries.lock().await.remove(id);
    }
    pub async fn mutation_lock(&self, id: &str) -> Arc<Mutex<()>> {
        self.mutations
            .lock()
            .await
            .entry(id.into())
            .or_default()
            .clone()
    }
    async fn connect(c: &ConnectionConfig) -> Result<Arc<Entry>, String> {
        c.validate()?;
        if c.engine != DatabaseEngine::Clickhouse {
            return Err("This endpoint requires a ClickHouse connection".into());
        }
        let tunnel = if c.ssh.enabled {
            Some(ssh::open(&c.ssh).await?)
        } else {
            None
        };
        let mut builder = reqwest::Client::builder()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .pool_idle_timeout(Duration::from_secs(60))
            .danger_accept_invalid_certs(c.tls.allow_invalid_certificates);
        if let Some(tunnel) = &tunnel {
            builder = builder.proxy(
                reqwest::Proxy::all(format!("socks5h://127.0.0.1:{}", tunnel.port))
                    .map_err(|_| "Cannot configure SSH proxy")?,
            );
        }
        if let Some(ca) = c.tls.ca_pem.as_deref().filter(|s| !s.is_empty()) {
            for certificate in reqwest::Certificate::from_pem_bundle(ca.as_bytes())
                .map_err(|_| "Invalid ClickHouse CA certificate")?
            {
                builder = builder.add_root_certificate(certificate);
            }
        }
        let client = builder
            .build()
            .map_err(|_| "Cannot initialize ClickHouse HTTP client")?;
        let entry = Arc::new(Entry {
            client,
            config: c.clone(),
            _tunnel: tunnel,
        });
        let version: Vec<Value> = Self::rows_entry(&entry, "SELECT version() version").await?;
        if !version
            .first()
            .and_then(|r| r["version"].as_str())
            .is_some_and(supported)
        {
            return Err("ClickHouse 26.8 or later is required".into());
        }
        Ok(entry)
    }
    async fn entry(&self, store: &Store, id: &str) -> Result<Arc<Entry>, String> {
        let cell = self
            .entries
            .lock()
            .await
            .entry(id.into())
            .or_default()
            .clone();
        cell.get_or_try_init(|| async { Self::connect(&store.config(id).await?).await })
            .await
            .cloned()
    }
    async fn execute(e: &Entry, sql: &str, read: bool) -> Result<Vec<u8>, String> {
        let c = e
            .config
            .clickhouse
            .as_ref()
            .ok_or("Missing ClickHouse settings")?;
        let mut headers = reqwest::header::HeaderMap::new();
        for (name, value) in [
            ("x-clickhouse-user", c.username.as_str()),
            ("x-clickhouse-key", c.password.as_deref().unwrap_or("")),
        ] {
            let mut value = reqwest::header::HeaderValue::from_str(value)
                .map_err(|_| "ClickHouse credentials contain invalid HTTP header characters")?;
            value.set_sensitive(true);
            headers.insert(name, value);
        }
        let mut request = e.client.post(&c.endpoint).headers(headers).query(&[
            ("database", c.database.clone()),
            ("wait_end_of_query", "1".into()),
            ("default_format", "JSON".into()),
            ("query_id", format!("datahelm-{}", uuid::Uuid::new_v4())),
        ]);
        if read {
            request = request.query(&[
                ("max_result_rows", "1000"),
                ("result_overflow_mode", "throw"),
                ("max_execution_time", "15"),
            ]);
        }
        let mut response = request.body(sql.to_string()).send().await.map_err(|e| if e.is_timeout() {"ClickHouse request timed out; a mutation may already have completed; refresh before retrying".to_string()} else {failure(None)})?;
        let status = response.status();
        let code = response
            .headers()
            .get("x-clickhouse-exception-code")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok());
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "ClickHouse response interrupted; refresh before retrying a mutation")?
        {
            if body.len() + chunk.len() > MAX_BODY {
                return Err("ClickHouse response exceeds the 4 MiB administration limit".into());
            }
            body.extend_from_slice(&chunk);
        }
        if !status.is_success() || code.is_some() || response_code(&body).is_some() {
            return Err(failure(code.or_else(|| response_code(&body))));
        }
        if !read && !body.iter().all(u8::is_ascii_whitespace) {
            return Err(
                "ClickHouse returned an unexpected mutation response; refresh before retrying"
                    .into(),
            );
        }
        Ok(body)
    }
    async fn rows_entry<T: DeserializeOwned>(entry: &Entry, sql: &str) -> Result<Vec<T>, String> {
        #[derive(Deserialize)]
        struct Rows<T> {
            data: Vec<T>,
        }
        let bytes = Self::execute(entry, sql, true).await?;
        let rows: Rows<T> = serde_json::from_slice(&bytes)
            .map_err(|_| "ClickHouse returned an invalid or incomplete result")?;
        if rows.data.len() > MAX_ROWS {
            return Err("Too many rows for this administration view".into());
        }
        Ok(rows.data)
    }
    pub async fn rows<T: DeserializeOwned>(
        &self,
        store: &Store,
        id: &str,
        sql: &str,
    ) -> Result<Vec<T>, String> {
        let entry = self.entry(store, id).await?;
        Self::rows_entry(&entry, sql).await
    }
    pub async fn execute_mutation(&self, store: &Store, id: &str, sql: &str) -> Result<(), String> {
        let entry = self.entry(store, id).await?;
        Self::execute(&entry, sql, false).await?;
        Ok(())
    }
    pub async fn test(&self, c: &ConnectionConfig) -> Result<Value, String> {
        let start = std::time::Instant::now();
        let entry = Self::connect(c).await?;
        let rows: Vec<Value> =
            Self::rows_entry(&entry, "SELECT version() version, hostName() source").await?;
        let v = rows.first().ok_or("No ClickHouse server information")?;
        if !supported(v["version"].as_str().unwrap_or("")) {
            return Err("ClickHouse 26.8 or later is required".into());
        }
        Ok(
            json!({"engine":"clickhouse","server_version":v["version"],"source":v["source"],"topology":"clickhouse_server","latency_ms":start.elapsed().as_millis()}),
        )
    }
    pub async fn capabilities(&self, store: &Store, id: &str) -> Result<Capabilities, String> {
        let info: Vec<Value> = self
            .rows(store, id, "SELECT version() version, hostName() source")
            .await?;
        let info = info.first().ok_or("No ClickHouse server information")?;
        if !supported(info["version"].as_str().unwrap_or("")) {
            return Err("ClickHouse 26.8 or later is required".into());
        }
        let mut features = BTreeMap::new();
        for (name, sql) in [
            ("catalog", "SELECT name FROM system.databases LIMIT 1"),
            ("monitoring", "SELECT metric FROM system.metrics LIMIT 1"),
            ("users", "SELECT name FROM system.users LIMIT 1"),
            ("roles", "SELECT name FROM system.roles LIMIT 1"),
            ("grants", "SELECT access_type FROM system.grants LIMIT 1"),
            (
                "role_grants",
                "SELECT granted_role_name FROM system.role_grants LIMIT 1",
            ),
            (
                "privileges",
                "SELECT privilege FROM system.privileges LIMIT 1",
            ),
            (
                "operations",
                "SELECT query_id FROM system.processes LIMIT 1",
            ),
            ("history", "SELECT query_id FROM system.query_log LIMIT 1"),
            ("topology", "SELECT table FROM system.replicas LIMIT 1"),
        ] {
            let result = self.rows::<Value>(store, id, sql).await;
            features.insert(
                name.into(),
                Feature {
                    available: result.is_ok(),
                    reason: result.err(),
                },
            );
        }
        for (name, privilege) in [
            ("create_user", "CREATE USER"),
            ("update_user", "ALTER USER"),
            ("delete_user", "DROP USER"),
            ("create_role", "CREATE ROLE"),
            ("delete_role", "DROP ROLE"),
            ("kill", "KILL QUERY"),
        ] {
            let result = self
                .rows::<Value>(store, id, &format!("CHECK GRANT {privilege} ON *.*"))
                .await;
            let available = result
                .as_ref()
                .ok()
                .and_then(|r| r.first())
                .and_then(|r| r.as_object())
                .and_then(|r| r.values().next())
                .is_some_and(|v| v.as_u64() == Some(1));
            features.insert(
                name.into(),
                Feature {
                    available,
                    reason: if available {
                        None
                    } else {
                        Some("The connected account lacks this administrative privilege".into())
                    },
                },
            );
        }
        Ok(Capabilities {
            engine: "clickhouse".into(),
            server_version: info["version"].as_str().unwrap_or("").into(),
            source: info["source"].as_str().unwrap_or("").into(),
            features,
        })
    }
    pub async fn users(&self, store: &Store, id: &str) -> Result<Vec<UserRow>, String> {
        let mut rows: Vec<UserRow> = self.rows(store, id, USERS).await?;
        for r in &mut rows {
            r.readonly = !writable(&r.storage);
        }
        Ok(rows)
    }
    pub async fn roles(&self, store: &Store, id: &str) -> Result<Vec<RoleRow>, String> {
        let mut rows: Vec<RoleRow> = self.rows(store, id, ROLES).await?;
        for r in &mut rows {
            r.readonly = !writable(&r.storage);
        }
        Ok(rows)
    }
    pub async fn target(
        &self,
        store: &Store,
        id: &str,
        target: &Target,
        auth: bool,
    ) -> Result<(), String> {
        identifier(&target.name)?;
        // GRANT's grammar does not distinguish USER from ROLE. ClickHouse
        // resolves a shared name to the user, so never grant to an ambiguous role.
        if target.kind == TargetKind::Role
            && self
                .users(store, id)
                .await?
                .iter()
                .any(|u| u.name == target.name)
        {
            return Err("A user shares this role name; this SQL target is ambiguous and cannot be changed here".into());
        }
        let readonly = match target.kind {
            TargetKind::User => {
                let rows = self.users(store, id).await?;
                let row = rows
                    .iter()
                    .find(|u| u.name == target.name)
                    .ok_or("ClickHouse user not found")?;
                if auth
                    && (row.auth_type.len() != 1
                        || !matches!(
                            row.auth_type[0].as_str(),
                            "bcrypt_password"
                                | "sha256_password"
                                | "double_sha1_password"
                                | "plaintext_password"
                        ))
                {
                    return Err("External or multiple-method authentication is read-only".into());
                }
                row.readonly
            }
            TargetKind::Role => {
                self.roles(store, id)
                    .await?
                    .iter()
                    .find(|r| r.name == target.name)
                    .ok_or("ClickHouse role not found")?
                    .readonly
            }
        };
        if readonly {
            return Err("ClickHouse access entity is read-only in its configured storage".into());
        }
        Ok(())
    }
    pub async fn sample(
        &self,
        store: &Store,
        id: &str,
        previous: Option<&Metric>,
        now: i64,
    ) -> Result<Metric, String> {
        let info: Vec<Value> = self
            .rows(
                store,
                id,
                "SELECT concat(hostName(),'/',toString(serverUUID())) source, uptime() uptime",
            )
            .await?;
        let info = info.first().ok_or("No ClickHouse monitoring information")?;
        let gauges = self.rows::<Value>(store,id,"SELECT metric,toFloat64(value) value FROM system.metrics WHERE metric IN ('MemoryTracking','Query')").await;
        let counters = self.rows::<Value>(store,id,"SELECT event,toFloat64(value) value FROM system.events WHERE event IN ('Query','ReadBufferFromFileDescriptorReadBytes','WriteBufferFromFileDescriptorWriteBytes')").await;
        if gauges.is_err() && counters.is_err() {
            return Err("ClickHouse permission denied for monitoring".into());
        }
        let gauge = |key: &str| {
            gauges
                .as_ref()
                .ok()
                .and_then(|rows| rows.iter().find(|r| r["metric"] == key))
                .and_then(|r| r["value"].as_f64())
        };
        let counter = |key: &str| {
            counters
                .as_ref()
                .ok()
                .and_then(|rows| rows.iter().find(|r| r["event"] == key))
                .and_then(|r| r["value"].as_f64())
        };
        let source = info["source"].as_str().unwrap_or("unknown").to_string();
        let current = json!({"query":counter("Query"),"read":counter("ReadBufferFromFileDescriptorReadBytes"),"write":counter("WriteBufferFromFileDescriptorWriteBytes"),"uptime":info["uptime"]});
        let rate = |key: &str| -> Option<f64> {
            let old = previous?;
            if old.source != source
                || old.error.is_some()
                || now <= old.timestamp
                || old.rates["uptime"].as_f64()? > current["uptime"].as_f64()?
            {
                return None;
            }
            let delta = current[key].as_f64()? - old.rates[key].as_f64()?;
            (delta >= 0.).then_some(delta * 1000. / (now - old.timestamp) as f64)
        };
        Ok(Metric {
            timestamp: now,
            source: source.clone(),
            connections: None,
            memory_bytes: gauge("MemoryTracking"),
            virtual_memory_bytes: None,
            replication_lag_seconds: None,
            ops_per_second: None,
            clickhouse: Some(ClickHouseMetric {
                active_queries: gauge("Query"),
                queries_per_second: rate("query"),
                read_bytes_per_second: rate("read"),
                written_bytes_per_second: rate("write"),
            }),
            opcounters: json!({}),
            rates: current,
            error: None,
        })
    }
    pub async fn queries(&self, store: &Store, id: &str) -> Result<Vec<QueryRow>, String> {
        let rows: Vec<Value> = self.rows(store,id,"SELECT toString(serverUUID()) source,p.query_id query_id,p.user user,if(p.query_kind='Select',left(p.query,4000),'[non-SELECT query]') query,p.elapsed elapsed,toString(p.memory_usage) memory_usage,toString(p.read_rows) read_rows,hex(SHA256(p.query)) fingerprint,toString(p.port) port,toString(toUnixTimestamp64Micro(now64(6))-toInt64(p.elapsed*1000000)) started FROM system.processes AS p WHERE NOT startsWith(p.query_id,'datahelm-') AND NOT p.is_internal AND p.is_initial_query LIMIT 1000").await?;
        let signature = crate::auth::hash(
            &serde_json::to_string(&store.config(id).await?)
                .map_err(|_| "Cannot bind query reference")?,
        );
        let mut result = Vec::new();
        for r in rows {
            let mut row: QueryRow = serde_json::from_value(r.clone())
                .map_err(|_| "Invalid ClickHouse query metadata")?;
            let reference = KillReference {
                signature: signature.clone(),
                source: r["source"].as_str().unwrap_or("").into(),
                fingerprint: r["fingerprint"].as_str().unwrap_or("").into(),
                port: r["port"].as_str().unwrap_or("").into(),
                query_id: row.query_id.clone(),
                user: row.user.clone(),
                started: r["started"]
                    .as_str()
                    .unwrap_or("")
                    .parse()
                    .map_err(|_| "Invalid query start time")?,
                expires: chrono::Utc::now().timestamp() + 30,
            };
            row.kill_token = Some(URL_SAFE_NO_PAD.encode(store.vault.seal(
                &format!("clickhouse-kill:{id}"),
                &serde_json::to_vec(&reference).map_err(|_| "Cannot encode query reference")?,
            )?));
            result.push(row);
        }
        Ok(result)
    }
    pub async fn kill(&self, store: &Store, id: &str, token: &str) -> Result<(), String> {
        if token.len() > 4096 {
            return Err("Invalid query reference".into());
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(token)
            .map_err(|_| "Invalid query reference")?;
        let r: KillReference =
            serde_json::from_slice(&store.vault.open(&format!("clickhouse-kill:{id}"), &bytes)?)
                .map_err(|_| "Invalid query reference")?;
        let signature = crate::auth::hash(
            &serde_json::to_string(&store.config(id).await?)
                .map_err(|_| "Cannot bind query reference")?,
        );
        if signature != r.signature {
            return Err("Saved connection changed; refresh active queries".into());
        }
        if r.expires < chrono::Utc::now().timestamp() || r.query_id.starts_with("datahelm-") {
            return Err("Query reference expired; refresh active queries".into());
        }
        let filter = format!(
            "query_id={} AND user={} AND abs((toUnixTimestamp64Micro(now64(6))-toInt64(elapsed*1000000))-{}) < 10000 AND hex(SHA256(query))={} AND toString(port)={} AND toString(serverUUID())={}",
            literal(&r.query_id),
            literal(&r.user),
            r.started,
            literal(&r.fingerprint),
            literal(&r.port),
            literal(&r.source)
        );
        let rows: Vec<Value> = self
            .rows(
                store,
                id,
                &format!("SELECT query_id FROM system.processes WHERE {filter}"),
            )
            .await?;
        if rows.len() != 1 {
            return Err("The original query is no longer running".into());
        }
        // KILL's WHERE is evaluated against system.processes, including start identity.
        let _: Vec<Value> = self
            .rows(store, id, &format!("KILL QUERY WHERE {filter} SYNC"))
            .await?;
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
struct KillReference {
    signature: String,
    source: String,
    fingerprint: String,
    port: String,
    query_id: String,
    user: String,
    started: i64,
    expires: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sql_boundaries() {
        assert_eq!(identifier("a`b\\c").unwrap(), "`a\\`b\\\\c`");
        assert!(identifier("x\nDROP USER admin").is_err());
        assert_eq!(literal("a'\\b"), "'a\\'\\\\b'");
        assert!(password(&"é".repeat(37)).is_err());
        assert!(password(&"é".repeat(36)).is_ok());
        assert!(password("").is_err());
        assert!(password("a\0b").is_err());
        assert!(supported("26.8.1.1"));
        assert!(!supported("26.7.1"));
        assert!(supported("27.1"));
    }
    #[test]
    fn network_boundaries() {
        let n = |s: &str| Networks {
            user: "u".into(),
            mode: NetworkMode::Ip,
            addresses: vec![s.into()],
        };
        assert!(network_clause(&n("::/0")).is_ok());
        assert!(network_clause(&n("127.0.0.0/8")).is_ok());
        assert!(network_clause(&n("0.0.0.0/33")).is_err());
        assert!(network_clause(&n("x'; DROP USER admin")).is_err());
        assert!(!writable("users_xml"));
        assert!(writable("local_directory"));
    }

    async fn mock_entry(response: String) -> (Entry, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut b = [0; 4096];
                let n = stream.read(&mut b).await.unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&b[..n]);
                if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                    let len = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length: "))
                        .and_then(|s| s.parse::<usize>().ok())
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + len {
                        break;
                    }
                }
            }
            stream.write_all(response.as_bytes()).await.unwrap();
            String::from_utf8(bytes).unwrap()
        });
        let config:ConnectionConfig=serde_json::from_value(json!({"name":"mock","engine":"clickhouse","clickhouse":{"endpoint":format!("http://{address}"),"username":"test","password":"private-header"}})).unwrap();
        (
            Entry {
                client: reqwest::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .retry(reqwest::retry::never())
                    .build()
                    .unwrap(),
                config,
                _tunnel: None,
            },
            task,
        )
    }
    #[tokio::test]
    async fn transport_keeps_credentials_out_of_urls_and_sql_in_bodies() {
        let body = r#"{"data":[{"v":1}]}"#;
        let (entry, request) = mock_entry(format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ))
        .await;
        let rows: Vec<Value> = ClickHouseProvider::rows_entry(&entry, "SELECT 1 v")
            .await
            .unwrap();
        assert_eq!(rows[0]["v"], 1);
        let sent = request.await.unwrap();
        assert!(!sent.lines().next().unwrap().contains("private-header"));
        assert!(sent.contains("x-clickhouse-key: private-header"));
        assert!(sent.ends_with("SELECT 1 v"));
    }
    #[tokio::test]
    async fn late_errors_and_redirects_are_rejected_without_leaking_response_text() {
        for (status, body) in [
            ("200 OK", "Code: 497. password=private-value"),
            ("200 OK", "{\"data\":[]}\nCode: 497. private-value"),
            ("302 Found", "private-value"),
        ] {
            let (entry,request)=mock_entry(format!("HTTP/1.1 {status}\r\nLocation: http://127.0.0.1:1/\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len())).await;
            let error = ClickHouseProvider::rows_entry::<Value>(&entry, "SELECT 1")
                .await
                .unwrap_err();
            assert!(!error.contains("private-value"));
            request.await.unwrap();
        }
    }

    #[tokio::test]
    async fn cancellation_references_are_bound_to_connection_configuration_and_expiry() {
        use base64::engine::general_purpose::STANDARD;
        let store = Store::new(
            "sqlite::memory:",
            crate::crypto::Vault::new(&STANDARD.encode([31; 32])).unwrap(),
        )
        .await
        .unwrap();
        let mut config:ConnectionConfig=serde_json::from_value(json!({"name":"fixture","engine":"clickhouse","clickhouse":{"endpoint":"http://127.0.0.1:1"}})).unwrap();
        store.save("a", &config).await.unwrap();
        store.save("b", &config).await.unwrap();
        let mut reference = KillReference {
            user: "fixture-user".into(),
            signature: crate::auth::hash(&serde_json::to_string(&config).unwrap()),
            source: "node".into(),
            fingerprint: "hash".into(),
            port: "1".into(),
            query_id: "fixture-query".into(),
            started: 0,
            expires: chrono::Utc::now().timestamp() + 30,
        };
        let token = |r: &KillReference| {
            URL_SAFE_NO_PAD.encode(
                store
                    .vault
                    .seal("clickhouse-kill:a", &serde_json::to_vec(r).unwrap())
                    .unwrap(),
            )
        };
        let provider = ClickHouseProvider::default();
        let original = token(&reference);
        assert!(provider.kill(&store, "b", &original).await.is_err());
        config.name = "edited".into();
        store.save("a", &config).await.unwrap();
        assert!(
            provider
                .kill(&store, "a", &original)
                .await
                .unwrap_err()
                .contains("Saved connection changed")
        );
        reference.signature = crate::auth::hash(&serde_json::to_string(&config).unwrap());
        reference.expires = 0;
        assert!(
            provider
                .kill(&store, "a", &token(&reference))
                .await
                .unwrap_err()
                .contains("expired")
        );
        reference.expires = chrono::Utc::now().timestamp() + 30;
        reference.query_id = "datahelm-internal".into();
        assert!(
            provider
                .kill(&store, "a", &token(&reference))
                .await
                .is_err()
        );
    }
}
