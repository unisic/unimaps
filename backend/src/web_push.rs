//! Web Push, port of `lib/web-push.ts`: VAPID (RFC 8292, an ES256 JWT) and the aes128gcm payload encryption
//! (RFC 8291, one record). The VAPID pair is made once and kept on disk: a new pair orphans every subscription made
//! against the old one. Sending comes with the HTTP client.

use std::fs::{self, OpenOptions};
use std::io::{self, Write as _};
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::Path;

use aes_gcm::Aes128Gcm;
use aes_gcm::aead::{AeadInPlace as _, KeyInit as _};
use hkdf::Hkdf;
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint as _;
use p256::{PublicKey, SecretKey};
use rand_core::{OsRng, RngCore as _};
use serde_json::{Value, json};
use sha2::Sha256;
use url::Url;

use crate::js;

/// push services only: the server POSTs to the endpoint, so anything else would be an SSRF hole
const PUSH_HOSTS: [&str; 4] = [
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "push.apple.com",
    "notify.windows.com",
];

/// A public key as OpenSSL reads it for ECDH: SEC1 plus the hybrid form (tag 6/7 = the parity of y, then x and y).
fn ua_point(b: &[u8]) -> Option<PublicKey> {
    match b {
        [t @ (6 | 7), rest @ ..] if b.len() == 65 && t & 1 == b[64] & 1 => {
            PublicKey::from_sec1_bytes(&[&[4], rest].concat()).ok()
        }
        _ => PublicKey::from_sec1_bytes(b).ok(),
    }
}

/// `isPushSub`: `{endpoint, keys: {p256dh, auth}}` with an https endpoint on a push service, a 16-byte auth secret
/// and an uncompressed P-256 point.
pub fn is_push_sub(v: &Value) -> bool {
    let (Some(endpoint), Some(keys)) = (v.get("endpoint").and_then(Value::as_str), v.get("keys")) else {
        return false;
    };
    if endpoint.encode_utf16().count() > 1024 {
        return false;
    }
    let Ok(u) = Url::parse(endpoint) else { return false };
    let host = u.host_str().unwrap_or("");
    if u.scheme() != "https"
        || u.port().is_some()
        || !PUSH_HOSTS
            .iter()
            .any(|h| host == *h || host.strip_suffix(h).is_some_and(|p| p.ends_with('.')))
    {
        return false;
    }
    let Some(auth) = keys.get("auth").and_then(Value::as_str) else {
        return false;
    };
    if js::buffer_from_base64(auth).len() != 16 {
        return false;
    }
    // String(keys.p256dh), as the TS reads it
    let ua = js::buffer_from_base64(&js::value_to_string(keys.get("p256dh")));
    ua.len() == 65 && ua_point(&ua).is_some()
}

/// `encryptPayload`: RFC 8291 §3.4 as one aes128gcm record (rs 4096). `fixed` = (sender private key, salt) pins the
/// RFC test vector. None when `ua_public` is not a P-256 point.
pub fn encrypt_payload(
    ua_public: &[u8],
    auth_secret: &[u8],
    plaintext: &[u8],
    fixed: Option<(&[u8], [u8; 16])>,
) -> Option<Vec<u8>> {
    let ua = ua_point(ua_public)?;
    let sk = match fixed {
        Some((d, _)) => SecretKey::from_slice(d).ok()?,
        None => SecretKey::random(&mut OsRng),
    };
    let salt = fixed.map_or_else(
        || {
            let mut s = [0u8; 16];
            OsRng.fill_bytes(&mut s);
            s
        },
        |f| f.1,
    );
    let as_public = sk.public_key().to_encoded_point(false);
    let shared = p256::ecdh::diffie_hellman(sk.to_nonzero_scalar(), ua.as_affine());
    let key_info = [b"WebPush: info\0".as_slice(), ua_public, as_public.as_bytes()].concat();
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth_secret), shared.raw_secret_bytes())
        .expand(&key_info, &mut ikm)
        .ok()?;
    let hk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
    let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
    hk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).ok()?;
    hk.expand(b"Content-Encoding: nonce\0", &mut nonce).ok()?;
    // 0x02: the last (only) record's padding delimiter
    let mut body = [plaintext, &[2]].concat();
    Aes128Gcm::new(&cek.into())
        .encrypt_in_place(&nonce.into(), b"", &mut body)
        .ok()?;
    let mut out = Vec::with_capacity(21 + as_public.len() + body.len());
    out.extend_from_slice(&salt);
    out.extend_from_slice(&4096u32.to_be_bytes());
    out.push(as_public.len() as u8);
    out.extend_from_slice(as_public.as_bytes());
    out.extend_from_slice(&body);
    Some(out)
}

pub struct Vapid {
    key: SigningKey,
    /// the uncompressed public point, base64url (`k=` of the Authorization header, the browser's applicationServerKey)
    pub public: String,
}

/// `vapidKeys`: the pair from `dir`/vapid.json (a JWK, as Node exports it), made on first use. An unreadable or
/// corrupt file is an error, never replaced. The caller keeps the answer.
pub fn vapid_keys(dir: &Path) -> io::Result<Vapid> {
    let file = dir.join("vapid.json");
    let sk = match fs::read_to_string(&file) {
        Ok(s) => SecretKey::from_jwk_str(&s).map_err(|e| io::Error::other(format!("{}: {e}", file.display())))?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let sk = SecretKey::random(&mut OsRng);
            fs::create_dir_all(dir)?;
            let tmp = dir.join("vapid.json.tmp");
            let mut f = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&tmp)?;
            f.write_all(sk.to_jwk_string().as_bytes())?;
            f.sync_all()?;
            fs::rename(&tmp, &file)?;
            sk
        }
        Err(e) => return Err(e),
    };
    let public = js::to_base64url(sk.public_key().to_encoded_point(false).as_bytes());
    Ok(Vapid {
        key: SigningKey::from(&sk),
        public,
    })
}

/// `vapidAuth`: RFC 8292 `Authorization` for the endpoint's origin, valid 12 h. None for an unparsable endpoint.
pub fn vapid_auth(endpoint: &str, k: &Vapid, now_sec: f64) -> Option<String> {
    let aud = Url::parse(endpoint).ok()?.origin().ascii_serialization();
    let enc = |v: Value| js::to_base64url(v.to_string().as_bytes());
    let claims = json!({
        "aud": aud,
        "exp": now_sec.floor() as i64 + 12 * 3600,
        "sub": &*crate::config::PUSH_SUBJECT,
    });
    let input = format!("{}.{}", enc(json!({ "typ": "JWT", "alg": "ES256" })), enc(claims));
    let sig: Signature = k.key.sign(input.as_bytes());
    Some(format!(
        "vapid t={input}.{}, k={}",
        js::to_base64url(&sig.to_bytes()),
        k.public
    ))
}
