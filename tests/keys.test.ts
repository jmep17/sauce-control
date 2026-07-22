import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as jose from "jose";
import {
  loadOrCreateSigningKey,
  jwks,
  mintAccessToken,
  mintIdToken,
} from "../src/proxy/keys.js";

function tmpKeyPath() {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "sc-key-")),
    "signing-key.json"
  );
}

describe("signing key + JWTs", () => {
  it("persists and reuses the same key", async () => {
    const p = tmpKeyPath();
    const a = await loadOrCreateSigningKey(p);
    const b = await loadOrCreateSigningKey(p);
    expect(a.kid).toBe(b.kid);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("mints an access token that verifies against its JWKS", async () => {
    const key = await loadOrCreateSigningKey(tmpKeyPath());
    const issuer = "https://localhost:8443/";
    const token = await mintAccessToken(key, {
      issuer,
      audience: "https://api.example.com",
      subject: "auth0|abc",
      clientId: "client123",
    });

    const jwkSet = jose.createLocalJWKSet(jwks(key));
    const { payload } = await jose.jwtVerify(token, jwkSet, {
      issuer,
      audience: "https://api.example.com",
    });
    expect(payload.sub).toBe("auth0|abc");
    expect(payload.azp).toBe("client123");
  });

  it("mints an id token with profile claims and client-id audience", async () => {
    const key = await loadOrCreateSigningKey(tmpKeyPath());
    const issuer = "https://localhost:8443/";
    const token = await mintIdToken(key, {
      issuer,
      audience: "ignored-for-id",
      subject: "auth0|abc",
      clientId: "client123",
      nonce: "n-1",
      profile: { email: "u@example.com", name: "U" },
    });
    const jwkSet = jose.createLocalJWKSet(jwks(key));
    const { payload } = await jose.jwtVerify(token, jwkSet, {
      issuer,
      audience: "client123",
    });
    expect(payload.email).toBe("u@example.com");
    expect(payload.nonce).toBe("n-1");
  });
});
