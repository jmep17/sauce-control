import type { IncomingMessage, ServerResponse } from "node:http";
import { mintAccessToken, mintIdToken, jwks, type SigningKey } from "./keys.js";

export interface Auth0Profile {
  sub: string;
  name?: string;
  nickname?: string;
  email?: string;
  email_verified?: boolean;
  picture?: string;
  [k: string]: unknown;
}

const DEFAULT_PROFILE: Auth0Profile = {
  sub: "auth0|sauce-control-user",
  name: "Sauce Control User",
  nickname: "sauce",
  email: "user@sauce-control.local",
  email_verified: true,
  picture: "https://localhost/avatar.png",
};

interface PendingCode {
  clientId: string;
  redirectUri: string;
  nonce?: string;
  audience?: string;
  scope?: string;
}

const AUTH0_PATHS = [
  "/authorize",
  "/oauth/token",
  "/userinfo",
  "/.well-known/jwks.json",
  "/.well-known/openid-configuration",
  "/v2/logout",
  "/oidc/logout",
  "/logout",
];

export interface Auth0HandlerOptions {
  key: SigningKey;
  /** Full issuer URL, e.g. https://localhost:8443/ (trailing slash). */
  issuer: string;
  profile?: Auth0Profile;
  /** Fallback audience when the app doesn't request one. */
  defaultAudience?: string;
}

/**
 * A self-issuing fake Auth0 tenant. Handles the OAuth/OIDC endpoints and mints RS256
 * tokens signed by our own key so the app's login flow works entirely offline.
 */
export class Auth0Handler {
  private readonly key: SigningKey;
  private readonly issuer: string;
  private readonly profile: Auth0Profile;
  private readonly defaultAudience: string;
  private readonly codes = new Map<string, PendingCode>();
  private codeSeq = 0;

  constructor(opts: Auth0HandlerOptions) {
    this.key = opts.key;
    this.issuer = opts.issuer.endsWith("/") ? opts.issuer : opts.issuer + "/";
    this.profile = { ...DEFAULT_PROFILE, ...opts.profile };
    this.defaultAudience =
      opts.defaultAudience ?? "https://sauce-control.local/api";
  }

  isAuthPath(pathname: string): boolean {
    return AUTH0_PATHS.some(
      (p) => pathname === p || pathname.startsWith(p + "/")
    );
  }

  /** Returns true if the request was an Auth0 endpoint and has been handled. */
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    body: Buffer
  ): Promise<boolean> {
    const p = url.pathname;
    if (!this.isAuthPath(p)) return false;

    if (p === "/.well-known/jwks.json")
      return (this.json(res, jwks(this.key)), true);
    if (p === "/.well-known/openid-configuration")
      return (this.json(res, this.discovery()), true);
    if (p === "/authorize") return (this.authorize(res, url), true);
    if (p === "/oauth/token")
      return (void (await this.token(req, res, body)), true);
    if (p === "/userinfo") return (this.json(res, this.profile), true);
    // Logout endpoints: bounce back to returnTo.
    const returnTo =
      url.searchParams.get("returnTo") ??
      url.searchParams.get("post_logout_redirect_uri");
    this.redirect(res, returnTo ?? "/");
    return true;
  }

  private discovery() {
    const base = this.issuer.replace(/\/$/, "");
    return {
      issuer: this.issuer,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/oauth/token`,
      userinfo_endpoint: `${base}/userinfo`,
      jwks_uri: `${base}/.well-known/jwks.json`,
      end_session_endpoint: `${base}/v2/logout`,
      response_types_supported: ["code", "token", "id_token", "code id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "profile", "email", "offline_access"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "implicit",
      ],
      code_challenge_methods_supported: ["S256", "plain"],
    };
  }

  private authorize(res: ServerResponse, url: URL): void {
    const redirectUri = url.searchParams.get("redirect_uri");
    if (!redirectUri) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("missing redirect_uri");
      return;
    }
    const code = `sc_${Date.now().toString(36)}_${this.codeSeq++}`;
    this.codes.set(code, {
      clientId: url.searchParams.get("client_id") ?? "",
      redirectUri,
      nonce: url.searchParams.get("nonce") ?? undefined,
      audience: url.searchParams.get("audience") ?? undefined,
      scope: url.searchParams.get("scope") ?? undefined,
    });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    const state = url.searchParams.get("state");
    if (state) target.searchParams.set("state", state);
    this.redirect(res, target.toString());
  }

  private async token(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer
  ): Promise<void> {
    const params = parseBody(req, body);
    const grant = params.grant_type ?? "authorization_code";
    const pending = params.code ? this.codes.get(params.code) : undefined;

    const clientId =
      pending?.clientId || params.client_id || "sauce-control-client";
    const audience =
      pending?.audience ||
      params.audience ||
      params.resource ||
      this.defaultAudience;
    const scope = pending?.scope || params.scope || "openid profile email";
    const nonce = pending?.nonce;

    const common = {
      issuer: this.issuer,
      audience,
      subject: this.profile.sub,
      clientId,
      scope,
    };
    const accessToken = await mintAccessToken(this.key, common);
    const idToken = await mintIdToken(this.key, {
      ...common,
      nonce,
      profile: this.profile,
    });

    if (params.code) this.codes.delete(params.code);

    this.json(res, {
      access_token: accessToken,
      id_token: idToken,
      refresh_token:
        grant === "refresh_token"
          ? params.refresh_token
          : `sc_refresh_${clientId}`,
      token_type: "Bearer",
      expires_in: 24 * 60 * 60,
      scope,
    });
  }

  private json(res: ServerResponse, obj: unknown): void {
    const buf = Buffer.from(JSON.stringify(obj));
    res.writeHead(200, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    });
    res.end(buf);
  }

  private redirect(res: ServerResponse, location: string): void {
    res.writeHead(302, { location });
    res.end();
  }
}

function parseBody(req: IncomingMessage, body: Buffer): Record<string, string> {
  const ct = (req.headers["content-type"] ?? "").toLowerCase();
  const text = body.toString("utf8");
  if (ct.includes("application/json")) {
    try {
      return JSON.parse(text) as Record<string, string>;
    } catch {
      return {};
    }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(text)) out[k] = v;
  return out;
}
