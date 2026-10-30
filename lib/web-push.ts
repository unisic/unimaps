/**
 * Web Push sender on node:crypto alone: VAPID (RFC 8292, an ES256 JWT) and the aes128gcm payload
 * encryption (RFC 8291, one record). The VAPID key pair is made once and kept on disk: a new pair
 * orphans every subscription made against the old one.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { PUSH_DIR, PUSH_SUBJECT } from "./config";

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/* push services only: the server POSTs to the endpoint, so anything else would be an SSRF hole */
const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "push.apple.com", "notify.windows.com"];

export function isPushSub(v: unknown): v is PushSub {
  const s = v as PushSub;
  if (!s || typeof s.endpoint !== "string" || s.endpoint.length > 1024 || typeof s.keys !== "object" || !s.keys) return false;
  try {
    const u = new URL(s.endpoint);
    if (u.protocol !== "https:" || u.port || !PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`)))
      return false;
    if (typeof s.keys.auth !== "string" || Buffer.from(s.keys.auth, "base64url").length !== 16) return false;
    const ua = Buffer.from(String(s.keys.p256dh), "base64url");
    // computeSecret throws unless the key is a point on P-256
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    ecdh.computeSecret(ua);
    return ua.length === 65;
  } catch {
    return false;
  }
}

/** RFC 8291 §3.4 as one aes128gcm record (rs 4096). `fixed` pins the sender key and salt for the RFC test vector. */
export function encryptPayload(
  uaPublic: Buffer,
  authSecret: Buffer,
  plaintext: Buffer,
  fixed?: { asPrivate: Buffer; salt: Buffer },
): Buffer {
  const ecdh = crypto.createECDH("prime256v1");
  if (fixed) ecdh.setPrivateKey(fixed.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = fixed?.salt ?? crypto.randomBytes(16);
  const hkdf = (ikm: Buffer, s: Buffer, info: string | Buffer, len: number) =>
    Buffer.from(crypto.hkdfSync("sha256", ikm, s, info, len));
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hkdf(ecdh.computeSecret(uaPublic), authSecret, keyInfo, 32);
  const cipher = crypto.createCipheriv(
    "aes-128-gcm",
    hkdf(ikm, salt, "Content-Encoding: aes128gcm\0", 16),
    hkdf(ikm, salt, "Content-Encoding: nonce\0", 12),
  );
  // 0x02: the last (only) record's padding delimiter
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

let vapid: { key: crypto.KeyObject; pub: string } | null = null;

/** The VAPID pair from PUSH_DIR/vapid.json, made on first use; an unreadable file throws rather than replacing it. */
export function vapidKeys(dir = PUSH_DIR): { key: crypto.KeyObject; pub: string } {
  if (vapid) return vapid;
  const file = path.join(dir, "vapid.json");
  let jwk: crypto.JsonWebKey;
  try {
    jwk = JSON.parse(fs.readFileSync(file, "utf8")) as crypto.JsonWebKey;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    jwk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(jwk), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  const key = crypto.createPrivateKey({ key: jwk, format: "jwk" });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x ?? "", "base64url"), Buffer.from(jwk.y ?? "", "base64url")]);
  return (vapid = { key, pub: pub.toString("base64url") });
}

/** RFC 8292 `Authorization` for one push service origin, valid 12 h. */
export function vapidAuth(endpoint: string, k = vapidKeys(), nowSec = Date.now() / 1000): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(nowSec) + 12 * 3600, sub: PUSH_SUBJECT };
  const input = `${enc({ typ: "JWT", alg: "ES256" })}.${enc(claims)}`;
  const sig = crypto.sign("sha256", Buffer.from(input), { key: k.key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${input}.${sig.toString("base64url")}, k=${k.pub}`;
}

/** One message; resolves the push service's status (201 queued, 404/410 = the subscription is gone). */
export async function sendPush(sub: PushSub, payload: object, ttlSec: number): Promise<number> {
  const body = encryptPayload(
    Buffer.from(sub.keys.p256dh, "base64url"),
    Buffer.from(sub.keys.auth, "base64url"),
    Buffer.from(JSON.stringify(payload)),
  );
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      TTL: String(Math.max(0, Math.round(ttlSec))),
      Urgency: "high",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      Authorization: vapidAuth(sub.endpoint),
    },
    body: new Uint8Array(body),
    // a redirect could lead off the allowlisted push hosts
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  await res.body?.cancel();
  return res.status;
}
