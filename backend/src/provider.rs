//! MongoDB-specific commands live here; HTTP and persistence remain provider independent.
use crate::{
    AppState,
    model::*,
    ssh::{self, Tunnel},
    store::Store,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{StreamExt, TryStreamExt, stream};
use mongodb::{
    Client,
    bson::{self, Bson, Document, doc},
    options::{
        AuthMechanism, ClientOptions, Credential, ServerAddress, Socks5Proxy, Tls, TlsOptions,
    },
};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::{Mutex, OnceCell};

struct Entry {
    client: Client,
    options: ClientOptions,
    _tunnel: Option<Tunnel>,
    _files: RuntimeFiles,
}
struct RuntimeFiles(Vec<std::path::PathBuf>);
impl Drop for RuntimeFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}
type Entries = HashMap<String, Arc<OnceCell<Arc<Entry>>>>;
pub struct MongoProvider {
    clients: Mutex<Entries>,
    runtime: String,
}
fn error(e: mongodb::error::Error) -> String {
    use mongodb::error::ErrorKind;
    match e.kind.as_ref() {
        ErrorKind::Command(c) if c.code == 13 => {
            "MongoDB permission denied for this feature".into()
        }
        ErrorKind::Command(c) if c.code == 18 => "MongoDB authentication rejected".into(),
        ErrorKind::Command(c) if c.code == 59 => {
            "This MongoDB node does not support the requested command".into()
        }
        ErrorKind::Command(c) if c.code == 11000 || c.code == 51003 => {
            "The user or role already exists".into()
        }
        ErrorKind::Command(c) => format!(
            "MongoDB rejected this command (code {}). Check its arguments, privileges, and node scope",
            c.code
        ),
        ErrorKind::Authentication { .. } => {
            "MongoDB authentication failed: check credentials and authentication database".into()
        }
        ErrorKind::InvalidArgument { .. } => {
            "Invalid MongoDB connection options or command arguments".into()
        }
        ErrorKind::DnsResolve { .. } => "DNS lookup failed: check the host or SRV record".into(),
        _ => {
            "MongoDB request failed: check network, TLS, node availability, and permissions".into()
        }
    }
}
fn value(doc: Document) -> Value {
    redact(serde_json::to_value(doc).unwrap_or(Value::Null))
}
pub fn redact(mut v: Value) -> Value {
    match &mut v {
        Value::Object(m) => {
            for (k, v) in m.iter_mut() {
                if [
                    "pwd",
                    "password",
                    "credentials",
                    "private_key",
                    "passphrase",
                    "saslPayload",
                ]
                .iter()
                .any(|s| k.eq_ignore_ascii_case(s))
                {
                    *v = json!("[redacted]");
                } else {
                    *v = redact(v.take());
                }
            }
        }
        Value::Array(a) => {
            for v in a {
                *v = redact(v.take());
            }
        }
        _ => {}
    }
    v
}
fn number(doc: &Document, key: &str) -> Option<f64> {
    match doc.get(key)? {
        Bson::Int32(v) => Some(*v as f64),
        Bson::Int64(v) => Some(*v as f64),
        Bson::Double(v) => Some(*v),
        _ => None,
    }
}
async fn run(client: &Client, db: &str, cmd: Document) -> Result<Document, String> {
    tokio::time::timeout(
        Duration::from_secs(15),
        client.database(db).run_command(cmd),
    )
    .await
    .map_err(|_| "MongoDB request timed out".to_string())?
    .map_err(error)
}
impl MongoProvider {
    pub fn new(runtime: String) -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
            runtime,
        }
    }
    pub async fn invalidate(&self, id: &str) {
        self.clients.lock().await.remove(id);
    }
    async fn connect(&self, c: &ConnectionConfig) -> Result<Arc<Entry>, String> {
        tokio::time::timeout(Duration::from_secs(30), self.connect_inner(c))
            .await
            .map_err(|_| {
                "Connection setup timed out: check DNS, SSH, TLS, and server availability"
                    .to_string()
            })?
    }
    async fn connect_inner(&self, c: &ConnectionConfig) -> Result<Arc<Entry>, String> {
        c.validate()?;
        if c.engine != DatabaseEngine::Mongodb {
            return Err("This endpoint requires a MongoDB connection".into());
        }
        let mut options = if c.mode == "uri" {
            ClientOptions::parse(c.uri.as_deref().unwrap_or(""))
                .await
                .map_err(|_| "Invalid URI or SRV DNS lookup failed".to_string())?
        } else {
            let mut o = ClientOptions::parse(format!("mongodb://{}/", c.hosts.trim()))
                .await
                .map_err(|_| "Invalid host list".to_string())?;
            if !c.username.is_empty() || c.mechanism == "MONGODB-X509" {
                let mut credential = Credential::builder()
                    .source(c.auth_database.clone())
                    .build();
                credential.username = (!c.username.is_empty()).then(|| c.username.clone());
                credential.password = c.password.clone().filter(|p| !p.is_empty());
                credential.mechanism = match c.mechanism.as_str() {
                    "SCRAM-SHA-256" => Some(AuthMechanism::ScramSha256),
                    "SCRAM-SHA-1" => Some(AuthMechanism::ScramSha1),
                    "MONGODB-X509" => {
                        credential.source = Some("$external".into());
                        Some(AuthMechanism::MongoDbX509)
                    }
                    "" => None,
                    _ => return Err("Unsupported authentication mechanism".into()),
                };
                o.credential = Some(credential);
            }
            o.repl_set_name = (!c.replica_set.is_empty()).then(|| c.replica_set.clone());
            o.direct_connection = Some(c.direct);
            o
        };
        // Derive X.509 authentication identity from the presented certificate.
        // Keep an explicitly requested identity for a post-authentication check.
        let x509_identity = options.credential.as_mut().and_then(|credential| {
            if credential.mechanism == Some(AuthMechanism::MongoDbX509) {
                credential.password = None;
                credential.username.take()
            } else {
                None
            }
        });
        if let Some(Tls::Enabled(t)) = &options.tls {
            if t.ca_file_path.is_some() || t.cert_key_file_path.is_some() {
                return Err("Upload TLS certificates in the TLS section instead of using filesystem paths in the URI".into());
            }
        }
        let mut files = RuntimeFiles(Vec::new());
        if c.tls.enabled || matches!(options.tls, Some(Tls::Enabled(_))) {
            let mut t = match options.tls.take() {
                Some(Tls::Enabled(t)) => t,
                _ => TlsOptions::default(),
            };
            t.allow_invalid_certificates = Some(c.tls.allow_invalid_certificates);
            t.tls_certificate_key_file_password = c
                .tls
                .key_password
                .as_ref()
                .filter(|p| !p.is_empty())
                .map(|s| s.as_bytes().to_vec());
            for (data, target) in [
                (&c.tls.ca_pem, &mut t.ca_file_path),
                (&c.tls.client_pem, &mut t.cert_key_file_path),
            ] {
                if let Some(pem) = data.as_ref().filter(|p| !p.is_empty()) {
                    if !runtime_is_memory_backed(&self.runtime) {
                        return Err("TLS uploads require DATAHELM_RUNTIME_DIR on tmpfs (use Docker Compose)".into());
                    }
                    std::fs::create_dir_all(&self.runtime)
                        .map_err(|_| "Cannot create TLS runtime directory")?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::set_permissions(
                            &self.runtime,
                            std::fs::Permissions::from_mode(0o700),
                        )
                        .map_err(|_| "Cannot secure runtime directory")?;
                    }
                    let path =
                        std::path::Path::new(&self.runtime).join(uuid::Uuid::new_v4().to_string());
                    files.0.push(path.clone());
                    let mut opts = std::fs::OpenOptions::new();
                    opts.write(true).create_new(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        opts.mode(0o600);
                    }
                    use std::io::Write;
                    opts.open(&path)
                        .and_then(|mut f| f.write_all(pem.as_bytes()))
                        .map_err(|_| "Cannot prepare TLS certificate")?;
                    *target = Some(path.clone());
                }
            }
            options.tls = Some(Tls::Enabled(t));
        }
        options.app_name = Some("Datahelm".into());
        options.max_pool_size = Some(8);
        options.min_pool_size = Some(0);
        options.connect_timeout = Some(Duration::from_secs(8));
        options.server_selection_timeout = Some(Duration::from_secs(8));
        let mut tunnel = None;
        if c.ssh.enabled {
            let bridge = ssh::open(&c.ssh).await?;
            options.socks5_proxy = Some(
                Socks5Proxy::builder()
                    .host("127.0.0.1")
                    .port(bridge.port)
                    .build(),
            );
            tunnel = Some(bridge);
        }
        let entry = Entry {
            client: Client::with_options(options.clone()).map_err(error)?,
            options,
            _tunnel: tunnel,
            _files: files,
        };
        let hello = run(&entry.client, "admin", doc! {"hello":1}).await?;
        if number(&hello, "maxWireVersion").unwrap_or(0.) < 25. {
            return Err("DataHelm requires MongoDB 8.0 or later".into());
        }
        run(&entry.client, "admin", doc! {"ping":1}).await?;
        if let Some(expected) = x509_identity {
            let status = run(&entry.client, "admin", doc! {"connectionStatus":1}).await?;
            let matching = status
                .get_document("authInfo")
                .ok()
                .and_then(|d| d.get_array("authenticatedUsers").ok())
                .is_some_and(|users| {
                    users.iter().filter_map(Bson::as_document).any(|u| {
                        u.get_str("user").ok() == Some(expected.as_str())
                            && u.get_str("db").ok() == Some("$external")
                    })
                });
            if !matching {
                return Err(
                    "Client certificate identity does not match the requested X.509 username"
                        .into(),
                );
            }
        }
        Ok(Arc::new(entry))
    }
    async fn entry(&self, store: &Store, id: &str) -> Result<Arc<Entry>, String> {
        let cell = self
            .clients
            .lock()
            .await
            .entry(id.to_string())
            .or_default()
            .clone();
        cell.get_or_try_init(|| async { self.connect(&store.config(id).await?).await })
            .await
            .cloned()
    }
    pub async fn test(&self, config: &ConnectionConfig) -> Result<Value, String> {
        let start = std::time::Instant::now();
        let entry = self.connect(config).await?;
        let hello = run(&entry.client, "admin", doc! {"hello":1}).await?;
        Ok(
            json!({"ok":true,"latency_ms":start.elapsed().as_millis(),"topology":if hello.get_str("msg").ok()==Some("isdbgrid") {"sharded"} else if hello.contains_key("setName") {"replica_set"} else {"standalone"}}),
        )
    }
    pub async fn command(
        &self,
        store: &Store,
        id: &str,
        db: &str,
        cmd: Document,
    ) -> Result<Value, String> {
        let e = self.entry(store, id).await?;
        Ok(value(run(&e.client, db, cmd).await?))
    }
    pub async fn capabilities(&self, store: &Store, id: &str) -> Result<Value, String> {
        let e = self.entry(store, id).await?;
        let hello = run(&e.client, "admin", doc! {"hello":1}).await?;
        let mut results = serde_json::Map::new();
        for (name, db, command) in [
            ("monitoring", "admin", doc! {"serverStatus":1}),
            ("users", "admin", doc! {"usersInfo":1}),
            (
                "roles",
                "admin",
                doc! {"rolesInfo":1,"showBuiltinRoles":true},
            ),
            ("catalog", "admin", doc! {"listDatabases":1,"nameOnly":true}),
            ("logs", "admin", doc! {"getLog":"global"}),
            ("replication", "admin", doc! {"replSetGetStatus":1}),
        ] {
            let result = run(&e.client, db, command).await;
            results.insert(
                name.into(),
                json!({"available":result.is_ok(),"reason":result.err()}),
            );
        }
        let operations = e
            .client
            .database("admin")
            .aggregate(vec![
                doc! {"$currentOp":{"allUsers":true,"idleConnections":false}},
                doc! {"$limit":1},
            ])
            .await;
        results.insert(
            "operations".into(),
            json!({"available":operations.is_ok(),"reason":operations.err().map(error)}),
        );
        let sharded = hello.get_str("msg").ok() == Some("isdbgrid");
        results.insert("profiler".into(), json!({"available":!sharded,"reason":if sharded {Some("Connect directly to a mongod member to view or configure its profiler")} else {None}}));
        // Permission information is read-only: no mutation probes are ever executed.
        let privileges = run(
            &e.client,
            "admin",
            doc! {"connectionStatus":1,"showPrivileges":true},
        )
        .await
        .ok()
        .map(value);
        let auth = privileges.as_ref().and_then(|v| v.get("authInfo"));
        let unrestricted = auth
            .and_then(|v| v.get("authenticatedUsers"))
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty);
        let actions = auth
            .and_then(|v| v.get("authenticatedUserPrivileges"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .flat_map(|p| p["actions"].as_array().into_iter().flatten())
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        for (feature, required) in [
            ("create_user", "createUser"),
            ("update_user", "changePassword"),
            ("delete_user", "dropUser"),
            ("create_role", "createRole"),
            ("update_role", "grantRole"),
            ("delete_role", "dropRole"),
            ("kill_operations", "killop"),
            ("profiler_write", "enableProfiler"),
        ] {
            let node_ok = feature != "profiler_write"
                || (!sharded
                    && (!hello.contains_key("setName")
                        || e.options.direct_connection == Some(true)));
            let allowed = node_ok
                && (unrestricted || actions.contains(&"anyAction") || actions.contains(&required));
            let reason = if !node_ok {
                "Save a direct mongod connection to change this node's profiler"
            } else {
                "The connected MongoDB account lacks the required administrative privilege"
            };
            results.insert(
                feature.into(),
                json!({"available":allowed,"reason":if allowed{None}else{Some(reason)}}),
            );
        }
        let version = run(&e.client, "admin", doc! {"buildInfo":1})
            .await
            .ok()
            .and_then(|build| build.get_str("version").ok().map(str::to_owned));
        let authentication=e.options.credential.as_ref().map(|c|json!({"mechanism":c.mechanism.as_ref().map(AuthMechanism::as_str).unwrap_or("Automatic / SCRAM"),"database":c.source})).unwrap_or_else(||json!({"mechanism":"No authentication","database":null}));
        Ok(
            json!({"features":results,"hello":value(hello),"access":privileges,"authentication":authentication,"server_version":version}),
        )
    }
    pub async fn database_names(&self, store: &Store, id: &str) -> Result<Vec<String>, String> {
        let e = self.entry(store, id).await?;
        e.client.list_database_names().await.map_err(error)
    }
    pub async fn collection_names(
        &self,
        store: &Store,
        id: &str,
        db: &str,
    ) -> Result<Vec<String>, String> {
        let e = self.entry(store, id).await?;
        e.client
            .database(db)
            .list_collection_names()
            .await
            .map_err(error)
    }
    pub async fn databases(&self, store: &Store, id: &str) -> Result<Value, String> {
        let e = self.entry(store, id).await?;
        let names = e.client.list_database_names().await.map_err(error)?;
        let result = stream::iter(names)
            .map(|name| {
                let e = e.clone();
                async move {
                    let stats = run(&e.client, &name, doc! {"dbStats":1,"scale":1}).await;
                    match stats {
                        Ok(s) => json!({"name":name,"stats":value(s)}),
                        Err(err) => json!({"name":name,"error":err}),
                    }
                }
            })
            .buffered(4)
            .collect::<Vec<_>>()
            .await;
        Ok(json!(result))
    }
    pub async fn collections(&self, store: &Store, id: &str, db: &str) -> Result<Value, String> {
        let e = self.entry(store, id).await?;
        let specs = e
            .client
            .database(db)
            .list_collections()
            .await
            .map_err(error)?
            .try_collect::<Vec<_>>()
            .await
            .map_err(error)?;
        let result=stream::iter(specs).map(|spec| { let e=e.clone(); let db=db.to_string(); async move {
            let name=spec.name.clone(); let kind=format!("{:?}",spec.collection_type).to_lowercase();
            if kind.contains("view") { return json!({"name":name,"kind":"view","count":null,"size":null,"storage_size":null,"indexes":null}); }
            let cursor=e.client.database(&db).collection::<Document>(&name).aggregate(vec![doc!{"$collStats":{"count":{},"storageStats":{}}}]).await;
            match cursor {
                Ok(cursor)=>match cursor.try_collect::<Vec<_>>().await {
                    Ok(stats)=> { let sum=|field:&str| -> Option<f64> { let values=stats.iter().filter_map(|d| d.get_document("storageStats").ok()).filter_map(|d| number(d,field)).collect::<Vec<_>>(); (!values.is_empty()).then(||values.iter().sum()) };
                        let count=stats.iter().filter_map(|d|number(d,"count")).reduce(|a,b|a+b);
                        let indexes=stats.iter().filter_map(|d|d.get_document("storageStats").ok()).filter_map(|d|number(d,"nindexes")).reduce(f64::max);
                        let time_series=kind.contains("timeseries");
                        json!({"name":name,"kind":kind,"count":if time_series{None}else{count},"bucket_count":if time_series{count}else{None},"count_note":if time_series{Some("Storage metadata reports buckets, not measurement counts")}else{None},"size":sum("size"),"storage_size":sum("storageSize"),"indexes":indexes,"index_size":sum("totalIndexSize")}) },
                    Err(err)=>json!({"name":name,"kind":kind,"error":error(err)}) },
                Err(err)=>json!({"name":name,"kind":kind,"error":error(err)})
            }
        } }).buffered(4).collect::<Vec<_>>().await;
        Ok(json!(result))
    }
    pub async fn indexes(
        &self,
        store: &Store,
        id: &str,
        db: &str,
        collection: &str,
    ) -> Result<Value, String> {
        let e = self.entry(store, id).await?;
        let indexes = e
            .client
            .database(db)
            .collection::<Document>(collection)
            .list_indexes()
            .await
            .map_err(error)?
            .try_collect::<Vec<_>>()
            .await
            .map_err(error)?;
        Ok(redact(
            serde_json::to_value(indexes).map_err(|_| "Cannot decode indexes")?,
        ))
    }
    pub async fn topology(&self, store: &Store, id: &str) -> Result<Value, String> {
        let e = self.entry(store, id).await?;
        let hello = run(&e.client, "admin", doc! {"hello":1}).await?;
        let replica = run(&e.client, "admin", doc! {"replSetGetStatus":1}).await;
        let shards = if hello.get_str("msg").ok() == Some("isdbgrid") {
            Some(run(&e.client, "admin", doc! {"listShards":1}).await)
        } else {
            None
        };
        let routers = if shards.is_some() {
            e.client
                .database("config")
                .collection::<Document>("mongos")
                .find(doc! {})
                .limit(100)
                .await
                .ok()
        } else {
            None
        };
        let routers = match routers {
            Some(cursor) => cursor
                .try_collect::<Vec<_>>()
                .await
                .ok()
                .map(|r| r.into_iter().map(value).collect::<Vec<_>>()),
            None => None,
        };
        Ok(
            json!({"hello":value(hello),"replica":replica.as_ref().ok().cloned().map(value),"replica_error":replica.err(),"shards":shards.map(|r|match r {Ok(d)=>value(d),Err(err)=>json!({"error":err})}),"routers":routers}),
        )
    }
    async fn node_client(&self, e: &Entry, source: &str) -> Result<Client, String> {
        let mut o = e.options.clone();
        o.hosts = vec![ServerAddress::parse(source).map_err(|_| "Invalid node address")?];
        o.direct_connection = Some(true);
        o.repl_set_name = None;
        Client::with_options(o).map_err(error)
    }
    pub async fn operations(&self, store: &Store, id: &str) -> Result<Value, String> {
        let e = self.entry(store, id).await?;
        let hello = run(&e.client, "admin", doc! {"hello":1}).await?;
        let source = hello
            .get_str("me")
            .map(str::to_string)
            .unwrap_or_else(|_| e.options.hosts[0].to_string());
        let client = self.node_client(&e, &source).await?;
        let ops = client
            .database("admin")
            .aggregate(vec![
                doc! {"$currentOp":{"allUsers":true,"idleConnections":false,"localOps":true}},
                doc! {"$match":{"active":true}},
                doc! {"$limit":500},
            ])
            .await
            .map_err(error)?
            .try_collect::<Vec<_>>()
            .await
            .map_err(error)?;
        let mut output = Vec::new();
        for op in ops {
            let killable = killable(&op);
            let token = if killable {
                let signed = json!({"op":encode_operation(&op)?,"source":source,"expires":chrono::Utc::now().timestamp_millis()+60000});
                Some(URL_SAFE_NO_PAD.encode(store.vault.seal(
                    id,
                    &serde_json::to_vec(&signed).map_err(|_| "Invalid operation")?,
                )?))
            } else {
                None
            };
            output.push(
                json!({"operation":value(op),"source":source,"killable":killable,"token":token}),
            );
        }
        Ok(json!(output))
    }
    pub async fn kill(&self, store: &Store, id: &str, token: &str) -> Result<Value, String> {
        let bytes = URL_SAFE_NO_PAD
            .decode(token)
            .map_err(|_| "Invalid operation reference")?;
        let v: Value = serde_json::from_slice(&store.vault.open(id, &bytes)?)
            .map_err(|_| "Invalid operation reference")?;
        if v["expires"].as_i64().unwrap_or(0) < chrono::Utc::now().timestamp_millis() {
            return Err("Operation reference expired; refresh the operations list".into());
        }
        let original = decode_operation(v["op"].as_str().ok_or("Invalid operation reference")?)?;
        let source = v["source"].as_str().ok_or("Missing operation node")?;
        let opid = original.get("opid").ok_or("Missing operation id")?.clone();
        let e = self.entry(store, id).await?;
        let client = self.node_client(&e, source).await?;
        let mut ops = client
            .database("admin")
            .aggregate(vec![
                doc! {"$currentOp":{"allUsers":true,"idleConnections":false,"localOps":true}},
                doc! {"$match":{"opid":opid.clone()}},
            ])
            .await
            .map_err(error)?;
        let current = ops
            .try_next()
            .await
            .map_err(error)?
            .ok_or("Operation has already finished")?;
        if !killable(&current)
            || !["client", "connectionId", "ns", "command"]
                .iter()
                .all(|k| original.get(*k) == current.get(*k))
        {
            return Err("Operation changed; refresh before attempting to kill it".into());
        }
        Ok(value(
            run(&client, "admin", doc! {"killOp":1,"op":opid}).await?,
        ))
    }
    pub async fn profiles(
        &self,
        store: &Store,
        id: &str,
        db: &str,
        before: Option<i64>,
        skip: u64,
        min_ms: i64,
    ) -> Result<Value, String> {
        let e = self.entry(store, id).await?;
        let mut filter = doc! {"millis":{"$gte":min_ms.max(0)}};
        if let Some(before) = before {
            filter.insert("ts", doc! {"$lte":bson::DateTime::from_millis(before)});
        }
        let cursor = e
            .client
            .database(db)
            .collection::<Document>("system.profile")
            .find(filter)
            .sort(doc! {"ts":-1})
            .skip(if before.is_some() { skip.min(10000) } else { 0 })
            .limit(101)
            .await
            .map_err(error)?;
        let mut rows = cursor.try_collect::<Vec<_>>().await.map_err(error)?;
        let next = if rows.len() > 100 {
            rows.truncate(100);
            rows.last()
                .and_then(|d| d.get_datetime("ts").ok())
                .map(|t| t.timestamp_millis())
        } else {
            None
        };
        let next_skip = next.map(|ts| {
            rows.iter()
                .rev()
                .take_while(|d| {
                    d.get_datetime("ts")
                        .ok()
                        .is_some_and(|d| d.timestamp_millis() == ts)
                })
                .count() as u64
                + if before == Some(ts) { skip } else { 0 }
        });
        Ok(
            json!({"items":rows.into_iter().map(value).collect::<Vec<_>>(),"next_before":next,"next_skip":next_skip}),
        )
    }
    pub async fn profiler(
        &self,
        store: &Store,
        id: &str,
        input: &ProfilerMutation,
    ) -> Result<Value, String> {
        let e = self.entry(store, id).await?;
        let hello = run(&e.client, "admin", doc! {"hello":1}).await?;
        if hello.get_str("msg").ok() == Some("isdbgrid") {
            return Err("Profiling requires a direct mongod connection".into());
        }
        if e.options.direct_connection != Some(true) && hello.contains_key("setName") {
            return Err("Save a direct connection to the intended replica-set member before changing node-specific profiler settings".into());
        }
        let current = run(&e.client, &input.db, doc! {"profile":-1}).await?;
        let level = if input.enabled {
            if input.slow_ms.is_some() {
                current.get_i32("was").unwrap_or(1).max(1)
            } else {
                1
            }
        } else {
            0
        };
        let mut command = doc! {"profile":level};
        if let Some(slow) = input.slow_ms {
            if !(0..=600000).contains(&slow) {
                return Err("Slow threshold must be between 0 and 600000 ms".into());
            }
            if current.contains_key("filter") {
                return Err("This node uses a profiler filter; its threshold is ignored. Existing filter preserved".into());
            }
            command.insert("slowms", slow);
        }
        run(&e.client, &input.db, command).await?;
        Ok(value(run(&e.client, &input.db, doc! {"profile":-1}).await?))
    }
    pub async fn sample(
        &self,
        store: &Store,
        id: &str,
        previous: Option<&Metric>,
        now: i64,
    ) -> Result<Metric, String> {
        let e = self.entry(store, id).await?;
        let status = run(&e.client, "admin", doc! {"serverStatus":1}).await?;
        let source = status.get_str("host").unwrap_or("unknown").to_string();
        let counters = status
            .get_document("opcounters")
            .ok()
            .cloned()
            .unwrap_or_default();
        let mut metric = Metric {
            clickhouse: None,
            timestamp: now,
            source,
            connections: status
                .get_document("connections")
                .ok()
                .and_then(|d| number(d, "current")),
            memory_bytes: status
                .get_document("mem")
                .ok()
                .and_then(|d| number(d, "resident"))
                .map(|n| n * 1048576.),
            virtual_memory_bytes: status
                .get_document("mem")
                .ok()
                .and_then(|d| number(d, "virtual"))
                .map(|n| n * 1048576.),
            replication_lag_seconds: None,
            ops_per_second: None,
            opcounters: value(counters),
            rates: json!({}),
            error: None,
        };
        calculate_rates(&mut metric, previous);
        if let Ok(replica) = run(&e.client, "admin", doc! {"replSetGetStatus":1}).await {
            metric.replication_lag_seconds = replication_lag(&replica);
        }
        Ok(metric)
    }
}
fn encode_operation(op: &Document) -> Result<String, String> {
    Ok(URL_SAFE_NO_PAD.encode(bson::to_vec(op).map_err(|_| "Invalid operation".to_string())?))
}
fn decode_operation(encoded: &str) -> Result<Document, String> {
    let data = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "Invalid operation reference".to_string())?;
    bson::from_slice(&data).map_err(|_| "Invalid operation reference".to_string())
}
fn killable(op: &Document) -> bool {
    op.get_bool("active").unwrap_or(false)
        && op.get("opid").is_some()
        && op.get_str("client").is_ok()
        && op.get_document("command").ok().is_some_and(|c| {
            ![
                "hello",
                "isMaster",
                "ismaster",
                "replSetHeartbeat",
                "serverStatus",
                "killOp",
                "createIndexes",
                "compact",
                "dropDatabase",
            ]
            .iter()
            .any(|k| c.contains_key(*k))
                && c.get_str("$comment").ok() != Some("Datahelm")
        })
        && op.get_str("appName").ok() != Some("Datahelm")
}
fn runtime_is_memory_backed(path: &str) -> bool {
    #[cfg(target_os = "linux")]
    {
        let canonical = std::fs::canonicalize(path).or_else(|_| {
            std::fs::canonicalize(
                std::path::Path::new(path)
                    .parent()
                    .unwrap_or(std::path::Path::new("/")),
            )
        });
        let Ok(path) = canonical else {
            return false;
        };
        let mounts = std::fs::read_to_string("/proc/mounts").unwrap_or_default();
        return mounts
            .lines()
            .filter_map(|line| {
                let f = line.split_whitespace().collect::<Vec<_>>();
                if f.len() > 2 && path.starts_with(f[1]) {
                    Some((f[1].len(), f[2]))
                } else {
                    None
                }
            })
            .max_by_key(|(len, _)| *len)
            .is_some_and(|(_, kind)| kind == "tmpfs" || kind == "ramfs");
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = path;
        false
    }
}
pub fn calculate_rates(current: &mut Metric, previous: Option<&Metric>) {
    let Some(previous) = previous else {
        return;
    };
    let dt = (current.timestamp - previous.timestamp) as f64 / 1000.;
    if dt <= 0. || dt > 30. || current.source != previous.source || previous.error.is_some() {
        return;
    }
    let mut rates = serde_json::Map::new();
    for name in ["insert", "query", "update", "delete", "getmore", "command"] {
        if let (Some(now), Some(old)) = (
            current.opcounters[name].as_f64(),
            previous.opcounters[name].as_f64(),
        ) {
            if now >= old {
                rates.insert(name.into(), json!((now - old) / dt));
            } else {
                return;
            }
        }
    }
    if !rates.is_empty() {
        current.ops_per_second = Some(rates.values().filter_map(Value::as_f64).sum());
        current.rates = Value::Object(rates);
    }
}
fn replication_lag(replica: &Document) -> Option<f64> {
    let members = replica.get_array("members").ok()?;
    let primary = members
        .iter()
        .filter_map(Bson::as_document)
        .find(|d| d.get_i32("state").ok() == Some(1))?
        .get_datetime("optimeDate")
        .ok()?
        .timestamp_millis();
    members
        .iter()
        .filter_map(Bson::as_document)
        .filter(|d| d.get_i32("state").ok() == Some(2) && number(d, "health") == Some(1.))
        .filter_map(|d| d.get_datetime("optimeDate").ok())
        .map(|t| ((primary - t.timestamp_millis()).max(0) as f64) / 1000.)
        .reduce(f64::max)
}
pub fn start_monitor(state: AppState) {
    tokio::spawn(async move {
        let mut previous = HashMap::<String, Metric>::new();
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_prune = 0i64;
        loop {
            interval.tick().await;
            let now = chrono::Utc::now().timestamp_millis();
            let connections = match state.store.list().await {
                Ok(c) => c,
                Err(_) => {
                    tracing::error!("Cannot load monitoring connections");
                    continue;
                }
            };
            previous.retain(|id, _| {
                connections
                    .iter()
                    .any(|c| c.id == *id && c.config.monitoring)
            });
            let results = stream::iter(connections.into_iter().filter(|c| c.config.monitoring))
                .map(|c| {
                    let state = state.clone();
                    let old = previous.get(&c.id).cloned();
                    async move {
                        let start = std::time::Instant::now();
                        let result = if c.config.engine == DatabaseEngine::Clickhouse {
                            state
                                .clickhouse
                                .sample(&state.store, &c.id, old.as_ref(), now)
                                .await
                        } else {
                            state
                                .provider
                                .sample(&state.store, &c.id, old.as_ref(), now)
                                .await
                        };
                        let m = match result {
                            Ok(m) => {
                                state
                                    .store
                                    .status(&c.id, None, start.elapsed().as_millis() as i64)
                                    .await;
                                m
                            }
                            Err(err) => {
                                state.provider.invalidate(&c.id).await;
                                state.clickhouse.invalidate(&c.id).await;
                                state
                                    .store
                                    .status(&c.id, Some(&err), start.elapsed().as_millis() as i64)
                                    .await;
                                Metric {
                                    clickhouse: None,
                                    timestamp: now,
                                    source: old
                                        .as_ref()
                                        .map(|m| m.source.clone())
                                        .unwrap_or_default(),
                                    connections: None,
                                    memory_bytes: None,
                                    virtual_memory_bytes: None,
                                    replication_lag_seconds: None,
                                    ops_per_second: None,
                                    opcounters: json!({}),
                                    rates: json!({}),
                                    error: Some(err),
                                }
                            }
                        };
                        if state.store.metric(&c.id, &m).await.is_err() {
                            tracing::error!("Cannot persist monitoring sample");
                        }
                        (c.id, m)
                    }
                })
                .buffer_unordered(4)
                .collect::<Vec<_>>()
                .await;
            for (id, m) in results {
                previous.insert(id, m);
            }
            if now - last_prune >= 3600000 {
                if state.store.prune(now).await.is_err() {
                    tracing::error!("Retention cleanup failed");
                }
                last_prune = now;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn operation_identity_preserves_bson_types() {
        let original = doc! {"opid":i64::MAX,"connectionId":Bson::Int32(7),"command":{"find":"events","limit":Bson::Int32(2),"ts":bson::DateTime::from_millis(1)}};
        assert_eq!(
            decode_operation(&encode_operation(&original).unwrap()).unwrap(),
            original
        );
    }
    fn metric(t: i64, n: f64) -> Metric {
        Metric {
            clickhouse: None,
            timestamp: t,
            source: "node:27017".into(),
            connections: Some(2.),
            memory_bytes: None,
            virtual_memory_bytes: None,
            replication_lag_seconds: None,
            ops_per_second: None,
            opcounters: json!({"query":n}),
            rates: json!({}),
            error: None,
        }
    }
    #[test]
    fn counter_reset_and_failover_are_gaps() {
        let old = metric(1000, 10.);
        let mut now = metric(6000, 20.);
        calculate_rates(&mut now, Some(&old));
        assert_eq!(now.ops_per_second, Some(2.));
        let mut reset = metric(6000, 0.);
        calculate_rates(&mut reset, Some(&old));
        assert_eq!(reset.ops_per_second, None);
        let mut switched = metric(6000, 20.);
        switched.source = "other".into();
        calculate_rates(&mut switched, Some(&old));
        assert_eq!(switched.ops_per_second, None);
    }
    #[test]
    fn redaction_removes_nested_credentials() {
        assert_eq!(
            redact(json!({"command":{"pwd":"secret"},"roles":[]}))["command"]["pwd"],
            "[redacted]"
        );
    }
    #[test]
    fn internal_ops_cannot_be_killed() {
        assert!(!killable(
            &doc! {"active":true,"opid":1,"command":{"replSetHeartbeat":"rs"}}
        ));
        assert!(!killable(
            &doc! {"active":true,"opid":1,"client":"localhost","appName":"Datahelm","command":{"find":"x"}}
        ));
        assert!(killable(
            &doc! {"active":true,"opid":1,"client":"localhost","command":{"find":"x"}}
        ));
    }
}
