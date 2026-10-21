// Cross-checks webpush.ts against the reference `web-push` / `http_ece` npm packages.
//   cd <dir with web-push installed> && NODE_PATH=$PWD/node_modules node --experimental-strip-types \
//     <repo>/supabase/functions/push-sender/webpush.test.mjs
import { createRequire } from "node:module";
import nodeCrypto from "node:crypto";
import { encryptPayload, generateVapidKeys, vapidAuthorization, b64u, unb64u } from "./webpush.ts";

const require = createRequire(process.env.NODE_PATH + "/");
const ece = require("http_ece");
const webpush = require("web-push");
let failed = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) failed++; };

// A browser subscription: ECDH P-256 key + 16-byte auth secret.
const ua = nodeCrypto.createECDH("prime256v1"); ua.generateKeys();
const auth = nodeCrypto.randomBytes(16);
const p256dh = b64u(new Uint8Array(ua.getPublicKey()));

for (const msg of ["hi", JSON.stringify({ title: "New help request", body: "A parent asked for help finding their code. — Hampden", url: "/#parents/requests" }), "x".repeat(3000)]) {
  const body = await encryptPayload(p256dh, b64u(new Uint8Array(auth)), new TextEncoder().encode(msg));
  const plain = ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: ua, authSecret: auth });
  ok(plain.toString("utf8") === msg, `http_ece decrypts our aes128gcm body (${msg.length} chars)`);
}

// And the other way: the reference encryptor's output has the same layout we produce.
const ref = webpush.encrypt(p256dh, b64u(new Uint8Array(auth)), "hello", "aes128gcm");
const ours = await encryptPayload(p256dh, b64u(new Uint8Array(auth)), new TextEncoder().encode("hello"));
ok(ref.cipherText.length === ours.length, `same body length as web-push (${ours.length})`);

// VAPID: signature verifies with the public key; claims are what push services expect.
const keys = await generateVapidKeys();
ok(unb64u(keys.publicKey).length === 65 && unb64u(keys.publicKey)[0] === 4, "VAPID public key is a 65-byte uncompressed point");
const endpoint = "https://web.push.apple.com/QGuQyavXutnMW";
const hdr = await vapidAuthorization(endpoint, keys, "mailto:info@207photo.com");
const m = hdr.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
ok(!!m && m[4] === keys.publicKey, "Authorization header has the vapid t=..., k=... shape");
const claims = JSON.parse(Buffer.from(m[2], "base64url").toString());
ok(claims.aud === "https://web.push.apple.com" && claims.sub === "mailto:info@207photo.com" && claims.exp > Date.now() / 1000, "JWT claims: aud = push origin, sub, exp");
const pub = await crypto.subtle.importKey("raw", unb64u(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64u(m[3]), new TextEncoder().encode(m[1] + "." + m[2])), "ES256 signature verifies");
// web-push accepts our keys as valid VAPID keys
const d = Buffer.from(keys.privateJwk.d, "base64url").toString("base64url");
let accepted = true;
try { webpush.getVapidHeaders("https://web.push.apple.com", "mailto:info@207photo.com", keys.publicKey, d, "aes128gcm"); } catch (e) { accepted = false; console.log(e.message); }
ok(accepted, "web-push accepts the generated key pair");

console.log(failed ? `\n${failed} failed` : "\nAll web push checks passed");
process.exit(failed ? 1 : 0);
