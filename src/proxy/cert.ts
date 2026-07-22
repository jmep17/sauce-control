import fs from "node:fs";
import path from "node:path";
import selfsigned from "selfsigned";
import { ensureDir } from "../config/paths.js";

export interface TlsCert {
  key: string;
  cert: string;
}

/**
 * Load or generate a self-signed cert for localhost. The SPA Auth0 SDKs force
 * https://<domain>, so the proxy must speak TLS even locally; the app trusts it via
 * ignoreHTTPSErrors (browser) / NODE_TLS_REJECT_UNAUTHORIZED=0 (SSR fetch).
 */
export function loadOrCreateCert(certDir: string): TlsCert {
  ensureDir(certDir);
  const keyPath = path.join(certDir, "localhost-key.pem");
  const certPath = path.join(certDir, "localhost-cert.pem");
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return {
      key: fs.readFileSync(keyPath, "utf8"),
      cert: fs.readFileSync(certPath, "utf8"),
    };
  }
  const attrs = [{ name: "commonName", value: "localhost" }];
  const pems = selfsigned.generate(attrs, {
    days: 3650,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" }, // DNS
          { type: 7, ip: "127.0.0.1" }, // IP
        ],
      },
    ],
  });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}
