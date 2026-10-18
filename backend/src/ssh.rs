use crate::model::SshConfig;
use russh::{
    client,
    keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate},
};
use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};

struct Handler {
    fingerprint: String,
}
impl client::Handler for Handler {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(key
            .public_key()
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string()
            == self.fingerprint)
    }
}
pub struct Tunnel {
    pub port: u16,
    task: JoinHandle<()>,
}
impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub async fn fingerprint(config: &SshConfig) -> Result<String, String> {
    struct Probe(Arc<std::sync::Mutex<Option<String>>>);
    impl client::Handler for Probe {
        type Error = russh::Error;
        async fn check_server_key(
            &mut self,
            key: &PublicKeyOrCertificate,
        ) -> Result<bool, Self::Error> {
            *self.0.lock().unwrap() = Some(
                key.public_key()
                    .fingerprint(russh::keys::HashAlg::Sha256)
                    .to_string(),
            );
            Ok(false)
        }
    }
    let result = Arc::new(std::sync::Mutex::new(None));
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        client::connect(
            Arc::new(client::Config::default()),
            (config.host.as_str(), config.port),
            Probe(result.clone()),
        ),
    )
    .await;
    let value = result.lock().unwrap().clone();
    value.ok_or_else(|| "SSH handshake failed: check host and port".into())
}
pub async fn open(config: &SshConfig) -> Result<Tunnel, String> {
    let fingerprint = config
        .fingerprint
        .clone()
        .filter(|x| !x.is_empty())
        .ok_or("Trust the SSH host fingerprint before connecting")?;
    let mut session = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        client::connect(
            Arc::new(client::Config::default()),
            (config.host.as_str(), config.port),
            Handler { fingerprint },
        ),
    )
    .await
    .map_err(|_| "SSH handshake timed out")?
    .map_err(|_| "SSH handshake failed or host key changed")?;
    let authenticated = if let Some(key) = config.private_key.as_ref().filter(|k| !k.is_empty()) {
        let key = russh::keys::decode_secret_key(
            key,
            config.passphrase.as_deref().filter(|s| !s.is_empty()),
        )
        .map_err(|_| "Cannot decode SSH private key or passphrase")?;
        let alg = session
            .best_supported_rsa_hash()
            .await
            .map_err(|_| "SSH key negotiation failed")?
            .flatten();
        session
            .authenticate_publickey(
                &config.username,
                PrivateKeyWithHashAlg::new(Arc::new(key), alg),
            )
            .await
    } else {
        session
            .authenticate_password(&config.username, config.password.as_deref().unwrap_or(""))
            .await
    }
    .map_err(|_| "SSH authentication failed")?;
    if !authenticated.success() {
        return Err("SSH authentication rejected".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "Cannot open SSH bridge")?;
    let port = listener
        .local_addr()
        .map_err(|_| "Cannot read SSH bridge address")?
        .port();
    let session = Arc::new(session);
    let task = tokio::spawn(async move {
        let mut workers = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                incoming = listener.accept() => {
                    let Ok((socket, _)) = incoming else { break; }; let session = session.clone();
                    workers.spawn(async move { let _ = bridge(socket, session).await; });
                }
                _ = workers.join_next(), if !workers.is_empty() => {}
            }
        }
    });
    Ok(Tunnel { port, task })
}
async fn bridge(
    mut socket: TcpStream,
    ssh: Arc<client::Handle<Handler>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let version = socket.read_u8().await?;
    let count = socket.read_u8().await?;
    if version != 5 {
        return Err("Invalid SOCKS version".into());
    }
    let mut methods = vec![0; count as usize];
    socket.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        socket.write_all(&[5, 255]).await?;
        return Err("SOCKS authentication unsupported".into());
    }
    socket.write_all(&[5, 0]).await?;
    let mut head = [0; 4];
    socket.read_exact(&mut head).await?;
    if head[0] != 5 || head[1] != 1 {
        return Err("Only SOCKS CONNECT is supported".into());
    }
    let host = match head[3] {
        1 => {
            let mut b = [0; 4];
            socket.read_exact(&mut b).await?;
            std::net::Ipv4Addr::from(b).to_string()
        }
        3 => {
            let n = socket.read_u8().await?;
            let mut b = vec![0; n as usize];
            socket.read_exact(&mut b).await?;
            String::from_utf8(b)?
        }
        4 => {
            let mut b = [0; 16];
            socket.read_exact(&mut b).await?;
            std::net::Ipv6Addr::from(b).to_string()
        }
        _ => return Err("Invalid address".into()),
    };
    let port = socket.read_u16().await?;
    let channel = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        ssh.channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0),
    )
    .await??;
    socket.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).await?;
    let mut stream = channel.into_stream();
    tokio::io::copy_bidirectional(&mut socket, &mut stream).await?;
    Ok(())
}
