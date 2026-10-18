use crate::{
    crypto::Vault,
    model::{ConnectionConfig, ConnectionView, Metric},
};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::str::FromStr;

#[derive(Clone)]
pub struct Store {
    pub pool: SqlitePool,
    pub vault: Vault,
}
impl Store {
    pub async fn new(url: &str, vault: Vault) -> Result<Self, String> {
        let opts = SqliteConnectOptions::from_str(url)
            .map_err(|_| "Invalid SQLite URL")?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(std::time::Duration::from_secs(10));
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(opts)
            .await
            .map_err(|_| "Cannot open SQLite database")?;
        sqlx::raw_sql(include_str!("../schema.sql"))
            .execute(&pool)
            .await
            .map_err(|_| "Cannot initialize SQLite schema")?;
        let columns = sqlx::query("PRAGMA table_info(connections)")
            .fetch_all(&pool)
            .await
            .map_err(|_| "Cannot inspect storage schema")?;
        if !columns
            .iter()
            .any(|r| r.get::<String, _>("name") == "last_success")
        {
            sqlx::query("ALTER TABLE connections ADD COLUMN last_success INTEGER")
                .execute(&pool)
                .await
                .map_err(|_| "Cannot update storage schema")?;
        }
        let admin_columns = sqlx::query("PRAGMA table_info(admin)")
            .fetch_all(&pool)
            .await
            .map_err(|_| "Cannot inspect administrator schema")?;
        if !admin_columns
            .iter()
            .any(|r| r.get::<String, _>("name") == "must_change_password")
        {
            sqlx::query(
                "ALTER TABLE admin ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 1",
            )
            .execute(&pool)
            .await
            .map_err(|_| "Cannot update administrator schema")?;
        }
        Ok(Self { pool, vault })
    }
    pub async fn config(&self, id: &str) -> Result<ConnectionConfig, String> {
        let sealed: Vec<u8> = sqlx::query_scalar("SELECT sealed FROM connections WHERE id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| "Storage error")?
            .ok_or("Connection not found")?;
        serde_json::from_slice(&self.vault.open(id, &sealed)?)
            .map_err(|_| "Invalid connection record".into())
    }
    pub async fn save(&self, id: &str, config: &ConnectionConfig) -> Result<(), String> {
        let sealed = self.vault.seal(
            id,
            &serde_json::to_vec(config).map_err(|_| "Invalid connection")?,
        )?;
        sqlx::query("INSERT INTO connections(id,sealed) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET sealed=excluded.sealed,status='unknown',error=NULL").bind(id).bind(sealed).execute(&self.pool).await.map_err(|_| "Cannot save connection")?;
        Ok(())
    }
    pub async fn list(&self) -> Result<Vec<ConnectionView>, String> {
        let rows = sqlx::query(
            "SELECT id,status,last_check,last_success,latency_ms,error FROM connections ORDER BY rowid",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|_| "Storage error")?;
        let mut output = Vec::new();
        for row in rows {
            let id: String = row.get("id");
            let c = self.config(&id).await?;
            output.push(ConnectionView {
                id,
                status: row.get("status"),
                last_check: row.get("last_check"),
                last_success: row.get("last_success"),
                latency_ms: row.get("latency_ms"),
                error: row.get("error"),
                has_password: c.password.as_ref().is_some_and(|x| !x.is_empty()),
                has_uri: c.uri.is_some(),
                has_ca: c.tls.ca_pem.as_ref().is_some_and(|s| !s.is_empty()),
                has_client_certificate: c.tls.client_pem.as_ref().is_some_and(|s| !s.is_empty()),
                has_ssh_key: c.ssh.private_key.as_ref().is_some_and(|s| !s.is_empty()),
                has_ssh_password: c.ssh.password.as_ref().is_some_and(|s| !s.is_empty()),
                config: c.public(),
            });
        }
        Ok(output)
    }
    pub async fn status(&self, id: &str, error: Option<&str>, latency: i64) {
        let _ = sqlx::query(
            "UPDATE connections SET status=?,last_check=?,latency_ms=?,error=?,last_success=CASE WHEN ? IS NULL THEN ? ELSE last_success END WHERE id=?",
        )
        .bind(if error.is_some_and(|e|e.contains("permission")) {
            "degraded"
        } else if error.is_some() {
            "offline"
        } else {
            "connected"
        })
        .bind(chrono::Utc::now().timestamp_millis())
        .bind(latency)
        .bind(error)
        .bind(error)
        .bind(chrono::Utc::now().timestamp_millis())
        .bind(id)
        .execute(&self.pool)
        .await;
    }
    pub async fn metric(&self, id: &str, metric: &Metric) -> Result<(), String> {
        sqlx::query("INSERT INTO metrics(connection_id,timestamp,payload) VALUES(?,?,?)")
            .bind(id)
            .bind(metric.timestamp)
            .bind(serde_json::to_string(metric).map_err(|_| "Invalid metric")?)
            .execute(&self.pool)
            .await
            .map_err(|_| "Cannot store metric")?;
        Ok(())
    }
    pub async fn prune(&self, now: i64) -> Result<(), String> {
        sqlx::query("DELETE FROM metrics WHERE timestamp < ?")
            .bind(now - 7 * 24 * 60 * 60 * 1000)
            .execute(&self.pool)
            .await
            .map_err(|_| "Retention cleanup failed")?;
        sqlx::query("DELETE FROM sessions WHERE expires < ?")
            .bind(now)
            .execute(&self.pool)
            .await
            .map_err(|_| "Session cleanup failed")?;
        Ok(())
    }
    pub async fn audit(&self, action: &str, id: &str, outcome: &str) {
        let _ = sqlx::query(
            "INSERT INTO audit(timestamp,action,connection_id,outcome) VALUES(?,?,?,?)",
        )
        .bind(chrono::Utc::now().timestamp_millis())
        .bind(action)
        .bind(id)
        .bind(outcome)
        .execute(&self.pool)
        .await;
    }
}
