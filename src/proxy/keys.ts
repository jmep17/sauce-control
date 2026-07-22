import fs from "node:fs";
import * as jose from "jose";

export interface SigningKey {
  kid: string;
  alg: "RS256";
  privateJwk: jose.JWK;
  publicJwk: jose.JWK;
}

/**
 * Load an RSA signing key from disk, generating + persisting one on first use.
 * This key backs both the self-issued JWTs and the JWKS the app verifies them against,
 * which is why replayed logins survive expiry and signature checks.
 */
export async function loadOrCreateSigningKey(
  keyPath: string
): Promise<SigningKey> {
  if (fs.existsSync(keyPath)) {
    return JSON.parse(fs.readFileSync(keyPath, "utf8")) as SigningKey;
  }
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256", {
    extractable: true,
  });
  const privateJwk = await jose.exportJWK(privateKey);
  const publicJwk = await jose.exportJWK(publicKey);
  const kid = crypto.randomUUID();
  privateJwk.kid = kid;
  publicJwk.kid = kid;
  publicJwk.use = "sig";
  publicJwk.alg = "RS256";
  const key: SigningKey = { kid, alg: "RS256", privateJwk, publicJwk };
  fs.writeFileSync(keyPath, JSON.stringify(key, null, 2));
  return key;
}

/** The public JWKS document served at /.well-known/jwks.json. */
export function jwks(key: SigningKey): { keys: jose.JWK[] } {
  return { keys: [key.publicJwk] };
}

export interface MintOptions {
  issuer: string;
  audience: string | string[];
  subject: string;
  clientId: string;
  scope?: string;
  extraClaims?: Record<string, unknown>;
  ttlSeconds?: number;
}

/** Sign an RS256 access token. */
export async function mintAccessToken(
  key: SigningKey,
  opts: MintOptions
): Promise<string> {
  const privateKey = await jose.importJWK(key.privateJwk, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? 24 * 60 * 60;
  return new jose.SignJWT({
    scope: opts.scope ?? "openid profile email",
    azp: opts.clientId,
    ...opts.extraClaims,
  })
    .setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" })
    .setIssuedAt(now)
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setSubject(opts.subject)
    .setExpirationTime(now + ttl)
    .sign(privateKey);
}

/** Sign an RS256 id token (OIDC), with profile claims. */
export async function mintIdToken(
  key: SigningKey,
  opts: MintOptions & { nonce?: string; profile?: Record<string, unknown> }
): Promise<string> {
  const privateKey = await jose.importJWK(key.privateJwk, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? 24 * 60 * 60;
  const builder = new jose.SignJWT({
    nonce: opts.nonce,
    azp: opts.clientId,
    ...(opts.profile ?? {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" })
    .setIssuedAt(now)
    .setIssuer(opts.issuer)
    // id_token audience is the client id.
    .setAudience(opts.clientId)
    .setSubject(opts.subject)
    .setExpirationTime(now + ttl);
  return builder.sign(privateKey);
}
