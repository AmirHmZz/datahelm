use base64::{Engine, engine::general_purpose::STANDARD};
use chacha20poly1305::{
    KeyInit, XChaCha20Poly1305, XNonce,
    aead::{Aead, Payload},
};
use rand::{RngCore, rngs::OsRng};
use zeroize::ZeroizeOnDrop;

#[derive(Clone, ZeroizeOnDrop)]
pub struct Vault {
    key: [u8; 32],
}
impl Vault {
    pub fn new(encoded: &str) -> Result<Self, String> {
        let key: [u8; 32] = STANDARD
            .decode(encoded.trim())
            .map_err(|_| "Master key must be base64".to_string())?
            .try_into()
            .map_err(|_| "Master key must contain 32 bytes".to_string())?;
        Ok(Self { key })
    }
    pub fn seal(&self, id: &str, plain: &[u8]) -> Result<Vec<u8>, String> {
        let mut nonce = [0; 24];
        OsRng.fill_bytes(&mut nonce);
        let mut output = nonce.to_vec();
        let data = XChaCha20Poly1305::new((&self.key).into())
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plain,
                    aad: id.as_bytes(),
                },
            )
            .map_err(|_| "Encryption failed".to_string())?;
        output.extend(data);
        Ok(output)
    }
    pub fn open(&self, id: &str, sealed: &[u8]) -> Result<Vec<u8>, String> {
        if sealed.len() < 40 {
            return Err("Invalid encrypted record".into());
        }
        XChaCha20Poly1305::new((&self.key).into())
            .decrypt(
                XNonce::from_slice(&sealed[..24]),
                Payload {
                    msg: &sealed[24..],
                    aad: id.as_bytes(),
                },
            )
            .map_err(|_| "Cannot decrypt record: check the master key".into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authenticated_encryption() {
        let v = Vault::new(&STANDARD.encode([7u8; 32])).unwrap();
        let s = v.seal("connection-a", b"a private password").unwrap();
        assert_eq!(v.open("connection-a", &s).unwrap(), b"a private password");
        assert!(v.open("connection-b", &s).is_err());
        assert!(
            Vault::new(&STANDARD.encode([8u8; 32]))
                .unwrap()
                .open("connection-a", &s)
                .is_err()
        );
        let mut changed = s;
        changed[28] ^= 1;
        assert!(v.open("connection-a", &changed).is_err());
        assert!(v.open("connection-a", b"short").is_err());
    }
}
