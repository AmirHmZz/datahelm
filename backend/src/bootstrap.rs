use base64::{Engine, engine::general_purpose::STANDARD};
use rand::{RngCore, rngs::OsRng};
use std::{fs, io::Write, path::Path};

pub fn configured_secret(name: &str) -> Result<Option<String>, String> {
    if let Some(path) = std::env::var_os(format!("{name}_FILE")) {
        return fs::read_to_string(path)
            .map(|value| Some(value.trim().to_owned()))
            .map_err(|_| format!("Cannot read {name}_FILE"));
    }
    Ok(std::env::var(name).ok())
}

pub fn master_key(directory: &Path) -> Result<String, String> {
    fs::create_dir_all(directory).map_err(|_| "Cannot create secrets directory")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot secure secrets directory")?;
    }
    let target = directory.join("master_key");
    match fs::read_to_string(&target) {
        Ok(value) => return Ok(value.trim().to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(_) => return Err("Cannot read persisted master key".into()),
    }
    let temporary = directory.join(format!(".master-key-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "Cannot create master key")?;
        let mut bytes = [0; 32];
        OsRng.fill_bytes(&mut bytes);
        writeln!(file, "{}", STANDARD.encode(bytes)).map_err(|_| "Cannot write master key")?;
        file.sync_all().map_err(|_| "Cannot persist master key")?;
        // Publish a complete file atomically without replacing another startup's key.
        match fs::hard_link(&temporary, &target) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(_) => return Err("Cannot publish master key"),
        }
        fs::read_to_string(&target).map_err(|_| "Cannot read persisted master key")
    })();
    let _ = fs::remove_file(temporary);
    result
        .map(|value| value.trim().to_owned())
        .map_err(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::Vault;

    #[test]
    fn generated_key_survives_restart_and_concurrent_initialization() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("secrets");
        let keys = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..6)
                .map(|_| scope.spawn(|| master_key(&directory).unwrap()))
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(keys.iter().all(|key| key == &keys[0]));
        let sealed = Vault::new(&keys[0])
            .unwrap()
            .seal("test", b"persisted secret")
            .unwrap();
        let restarted = Vault::new(&master_key(&directory).unwrap()).unwrap();
        assert_eq!(
            restarted.open("test", &sealed).unwrap(),
            b"persisted secret"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(directory.join("master_key"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn existing_invalid_key_is_never_replaced() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("master_key"), "invalid-existing-key").unwrap();
        let key = master_key(temp.path()).unwrap();
        assert_eq!(key, "invalid-existing-key");
        assert!(Vault::new(&key).is_err());
    }
}
