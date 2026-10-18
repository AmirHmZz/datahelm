mod api;
mod auth;
#[cfg(test)]
mod auth_tests;
mod bootstrap;
mod crypto;
#[cfg(test)]
mod integration;
mod model;
mod provider;
mod ssh;
mod store;

use crate::{crypto::Vault, provider::MongoProvider, store::Store};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    pub provider: Arc<MongoProvider>,
    pub login_attempts: Arc<Mutex<HashMap<String, (std::time::Instant, u32)>>>,
    pub secure_cookie: bool,
    pub origin: String,
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().any(|v| v == "--openapi") {
        println!("{}", api::openapi().to_pretty_json()?);
        return Ok(());
    }
    tracing_subscriber::fmt()
        .with_env_filter("datahelm=info,tower_http=warn")
        .init();
    let key = match bootstrap::configured_secret("DATAHELM_MASTER_KEY")? {
        Some(key) => key,
        None => bootstrap::master_key(std::path::Path::new(
            &std::env::var("DATAHELM_SECRETS_DIR").unwrap_or_else(|_| "secrets".into()),
        ))?,
    };
    let vault = Vault::new(&key)?;
    let url =
        std::env::var("DATAHELM_DATABASE_URL").unwrap_or_else(|_| "sqlite://datahelm.db".into());
    let store = Store::new(&url, vault).await?;
    // Validate every encrypted record before accepting requests; a wrong key fails startup.
    store.list().await?;
    let username = std::env::var("DATAHELM_ADMIN_USERNAME").unwrap_or_else(|_| "admin".into());
    if let Some(password) = auth::bootstrap(&store, &username, || {
        Ok(bootstrap::configured_secret("DATAHELM_ADMIN_PASSWORD")?
            .unwrap_or_else(auth::random_token))
    })
    .await?
    {
        tracing::warn!(
            "Initial administrator credentials — username: {username}, temporary password: {password}. Change this password at first sign-in. These credentials are printed only when the account is created."
        );
    }
    let origin =
        std::env::var("DATAHELM_ORIGIN").unwrap_or_else(|_| "http://localhost:8080".into());
    let provider = Arc::new(MongoProvider::new(
        std::env::var("DATAHELM_RUNTIME_DIR").unwrap_or_else(|_| "/dev/shm/datahelm".into()),
    ));
    let state = AppState {
        store,
        provider,
        login_attempts: Default::default(),
        secure_cookie: origin.starts_with("https://"),
        origin,
    };
    provider::start_monitor(state.clone());
    let address = std::env::var("DATAHELM_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    tracing::info!(%address, "DataHelm is ready");
    axum::serve(listener, api::router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
