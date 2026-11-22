import crypto from "node:crypto";

function b64u(buf) {
  return Buffer.from(buf).toString("base64url");
}

function fromB64u(str) {
  return Buffer.from(String(str), "base64url");
}

export function generateVapidKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: b64u(ecdh.getPublicKey()), // 65-byte uncompressed P-256 point
    privateKey: b64u(ecdh.getPrivateKey()), // 32-byte raw scalar
  };
}

function createVapidJwt(audienceOrigin, subject, publicKeyB64u, privateKeyB64u) {
  const pubRaw = fromB64u(publicKeyB64u);
  const privRaw = fromB64u(privateKeyB64u);
  const x = b64u(pubRaw.subarray(1, 33));
  const y = b64u(pubRaw.subarray(33, 65));
  const d = b64u(privRaw);

  const privateKeyObj = crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", x, y, d },
    format: "jwk",
  });

  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64u(
    JSON.stringify({
      aud: audienceOrigin,
      exp: now + 12 * 3600,
      sub: subject || "mailto:a3152557994@gmail.com",
    })
  );
  const unsigned = `${header}.${payload}`;
  const sig = crypto.sign("sha256", Buffer.from(unsigned), {
    key: privateKeyObj,
    dsaEncoding: "ieee-p1363",
  });
  return `${unsigned}.${b64u(sig)}`;
}

// RFC 8291 Web Push Encryption (aes128gcm)
export function encryptWebPushPayload(plaintextStr, clientP256dhOrSub, clientAuthB64u) {
  const p256dhStr =
    typeof clientP256dhOrSub === "object" && clientP256dhOrSub !== null
      ? clientP256dhOrSub.keys?.p256dh
      : clientP256dhOrSub;
  const authStr =
    typeof clientP256dhOrSub === "object" && clientP256dhOrSub !== null
      ? clientP256dhOrSub.keys?.auth
      : clientAuthB64u;
  const uaPublic = fromB64u(p256dhStr);
  const authSecret = fromB64u(authStr);
  const salt = crypto.randomBytes(16);

  const asEcdh = crypto.createECDH("prime256v1");
  asEcdh.generateKeys();
  const asPublic = asEcdh.getPublicKey(); // 65 bytes
  const ecdhSecret = asEcdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "ascii"),
    uaPublic,
    asPublic,
  ]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));

  const cekInfo = Buffer.from("Content-Encoding: aes128gcm\0", "ascii");
  const nonceInfo = Buffer.from("Content-Encoding: nonce\0", "ascii");
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, cekInfo, 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, nonceInfo, 12));

  const padded = Buffer.concat([Buffer.from(String(plaintextStr), "utf-8"), Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  // Header: salt (16) || rs (4, uint32BE = 4096) || idlen (1 = 65) || keyid (65 = asPublic)
  const rsBuf = Buffer.alloc(4);
  rsBuf.writeUInt32BE(4096, 0);
  const header = Buffer.concat([salt, rsBuf, Buffer.from([asPublic.length]), asPublic]);
  return Buffer.concat([header, encrypted]);
}

export async function sendWebPushNotification(subscription, payloadObj, vapidKeys) {
  if (!subscription || !subscription.endpoint || !vapidKeys?.publicKey || !vapidKeys?.privateKey) {
    return { ok: false, error: "invalid subscription or vapid keys" };
  }
  const endpointUrl = new URL(subscription.endpoint);
  const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;
  const jwt = createVapidJwt(audience, "mailto:a3152557994@gmail.com", vapidKeys.publicKey, vapidKeys.privateKey);

  const p256dh = subscription.keys?.p256dh;
  const auth = subscription.keys?.auth;
  const hasKeys = Boolean(p256dh && auth);
  const bodyBuf = hasKeys
    ? encryptWebPushPayload(JSON.stringify(payloadObj), p256dh, auth)
    : undefined;

  const headers = {
    Authorization: `vapid t=${jwt}, k=${vapidKeys.publicKey}`,
    TTL: "86400",
    Urgency: "high",
  };
  if (bodyBuf) {
    headers["Content-Encoding"] = "aes128gcm";
    headers["Content-Type"] = "application/octet-stream";
    headers["Content-Length"] = String(bodyBuf.length);
  } else {
    headers["Content-Length"] = "0";
  }

  try {
    const res = await fetch(subscription.endpoint, {
      method: "POST",
      headers,
      body: bodyBuf,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
