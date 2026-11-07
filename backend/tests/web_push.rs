//! Port of test/web-push.test.ts plus the isPushSub vectors from scripts/dump-vectors.ts.

use std::fs;
use std::os::unix::fs::PermissionsExt as _;
use std::path::PathBuf;

use aes_gcm::Aes128Gcm;
use aes_gcm::aead::{AeadInPlace as _, KeyInit as _};
use hkdf::Hkdf;
use p256::ecdsa::signature::Verifier as _;
use p256::ecdsa::{Signature, VerifyingKey};
use p256::elliptic_curve::sec1::ToEncodedPoint as _;
use p256::{PublicKey, SecretKey};
use rand_core::OsRng;
use serde_json::Value;
use sha2::Sha256;
use unimaps::js::{buffer_from_base64 as b, to_base64url};
use unimaps::web_push::{encrypt_payload, is_push_sub, vapid_auth, vapid_keys};

const UA: &str = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";

#[test]
fn rfc8291_section5_byte_for_byte() {
    let salt: [u8; 16] = b("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
    let out = encrypt_payload(
        &b(UA),
        &b(AUTH),
        b"When I grow up, I want to be a watermelon",
        Some((&b("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), salt)),
    )
    .unwrap();
    assert_eq!(
        to_base64url(&out),
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml\
         mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT\
         pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
    );
}

/// The browser's side of RFC 8291: what a fresh random key and salt produce must decrypt.
#[test]
fn random_sender_key_decrypts() {
    let ua_sk = SecretKey::random(&mut OsRng);
    let ua_pub = ua_sk.public_key().to_encoded_point(false);
    let auth = [7u8; 16];
    let msg = br#"{"title":"Linia 27","body":"za 3 min"}"#;
    let c = encrypt_payload(ua_pub.as_bytes(), &auth, msg, None).unwrap();
    let again = encrypt_payload(ua_pub.as_bytes(), &auth, msg, None).unwrap();
    assert_ne!(c[..16], again[..16], "salt is random");
    assert_ne!(c[21..86], again[21..86], "sender key is random");
    assert_eq!(c.len(), 21 + 65 + msg.len() + 1 + 16);
    assert_eq!(c[16..21], [0, 0, 16, 0, 65]);
    let as_pub = PublicKey::from_sec1_bytes(&c[21..86]).unwrap();
    let shared = p256::ecdh::diffie_hellman(ua_sk.to_nonzero_scalar(), as_pub.as_affine());
    let info = [b"WebPush: info\0".as_slice(), ua_pub.as_bytes(), &c[21..86]].concat();
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&auth), shared.raw_secret_bytes())
        .expand(&info, &mut ikm)
        .unwrap();
    let hk = Hkdf::<Sha256>::new(Some(&c[..16]), &ikm);
    let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
    hk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).unwrap();
    hk.expand(b"Content-Encoding: nonce\0", &mut nonce).unwrap();
    let mut body = c[86..].to_vec();
    Aes128Gcm::new(&cek.into())
        .decrypt_in_place(&nonce.into(), b"", &mut body)
        .unwrap();
    assert_eq!(body.pop(), Some(2));
    assert_eq!(body, msg);
}

#[test]
fn encrypt_rejects_a_bad_point() {
    assert!(encrypt_payload(&b("AAAA"), &b(AUTH), b"x", None).is_none());
}

#[test]
fn golden_is_push_sub() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("vectors/web_push.json")).unwrap();
    assert!(cases.len() >= 40);
    for c in &cases {
        assert_eq!(is_push_sub(&c["in"]), c["out"].as_bool().unwrap(), "{}", c["name"]);
    }
}

fn temp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("unimaps-web-push-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    d
}

#[test]
fn vapid_pair_is_made_once_and_kept() {
    let dir = temp("make").join("push");
    let k = vapid_keys(&dir).unwrap();
    let file = dir.join("vapid.json");
    assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    assert!(!dir.join("vapid.json.tmp").exists());
    let raw = b(&k.public);
    assert_eq!((raw.len(), raw[0]), (65, 4));
    assert_eq!(vapid_keys(&dir).unwrap().public, k.public);
    let jwk: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!((jwk["kty"].as_str(), jwk["crv"].as_str()), (Some("EC"), Some("P-256")));
    assert_eq!(
        k.public,
        to_base64url(&[&[4], &b(jwk["x"].as_str().unwrap())[..], &b(jwk["y"].as_str().unwrap())].concat())
    );
    fs::remove_dir_all(dir.parent().unwrap()).unwrap();
}

#[test]
fn vapid_reads_the_jwk_node_wrote() {
    let dir = temp("node");
    fs::create_dir_all(&dir).unwrap();
    // crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }), a throwaway key
    fs::write(
        dir.join("vapid.json"),
        r#"{"kty":"EC","x":"eQVPGMQ6RscjKKiE22iW9pqVk0dTzxkfSPzLQKJNZ-U","y":"_cQY4R0WZI62R_F613jgvUo2btDsOmit0SsDt3rl2pU","crv":"P-256","d":"zb29GXVLomz1Q8g5weWucuXXdxEzg7Y2bKvZcFyGBJM"}"#,
    )
    .unwrap();
    assert_eq!(
        vapid_keys(&dir).unwrap().public,
        "BHkFTxjEOkbHIyiohNtolvaalZNHU88ZH0j8y0CiTWfl_cQY4R0WZI62R_F613jgvUo2btDsOmit0SsDt3rl2pU"
    );
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn vapid_never_replaces_a_corrupt_file() {
    let dir = temp("corrupt");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("vapid.json"), "{").unwrap();
    assert!(vapid_keys(&dir).is_err());
    assert_eq!(fs::read_to_string(dir.join("vapid.json")).unwrap(), "{");
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn vapid_auth_is_an_es256_jwt_for_the_origin() {
    let dir = temp("auth");
    let k = vapid_keys(&dir).unwrap();
    let auth = vapid_auth("https://fcm.googleapis.com/fcm/send/abc", &k, 1_800_000_000.9).unwrap();
    let (t, pubk) = auth.strip_prefix("vapid t=").unwrap().split_once(", k=").unwrap();
    assert_eq!(pubk, k.public);
    let parts: Vec<&str> = t.split('.').collect();
    assert_eq!(parts.len(), 3);
    assert_eq!(b(parts[0]), br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = format!(
        r#"{{"aud":"https://fcm.googleapis.com","exp":1800043200,"sub":{}}}"#,
        Value::from(unimaps::config::PUSH_SUBJECT.as_str())
    );
    assert_eq!(String::from_utf8(b(parts[1])).unwrap(), claims);
    let sig = Signature::from_slice(&b(parts[2])).unwrap();
    let vk = VerifyingKey::from_sec1_bytes(&b(&k.public)).unwrap();
    vk.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig)
        .unwrap();
    let port = vapid_auth("https://push.example.com:8443/x", &k, 0.0).unwrap();
    assert!(
        String::from_utf8(b(port.split('.').nth(1).unwrap()))
            .unwrap()
            .contains(r#""aud":"https://push.example.com:8443""#)
    );
    assert!(vapid_auth("not a url", &k, 0.0).is_none());
    fs::remove_dir_all(&dir).unwrap();
}
