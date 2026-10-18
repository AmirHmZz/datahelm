CREATE TABLE IF NOT EXISTS admin (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, username TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, sealed BLOB NOT NULL, status TEXT NOT NULL DEFAULT 'unknown', last_check INTEGER, last_success INTEGER, latency_ms INTEGER, error TEXT);
CREATE TABLE IF NOT EXISTS metrics (connection_id TEXT NOT NULL, timestamp INTEGER NOT NULL, payload TEXT NOT NULL, FOREIGN KEY(connection_id) REFERENCES connections(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS metrics_connection_time ON metrics(connection_id,timestamp);
CREATE INDEX IF NOT EXISTS metrics_time ON metrics(timestamp);
CREATE TABLE IF NOT EXISTS audit (timestamp INTEGER NOT NULL, action TEXT NOT NULL, connection_id TEXT NOT NULL, outcome TEXT NOT NULL);
