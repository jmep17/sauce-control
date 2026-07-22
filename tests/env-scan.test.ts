import { describe, it, expect } from "vitest";
import { classifyEnvVar } from "../src/detect/env-scan.js";

describe("classifyEnvVar", () => {
  it("classifies auth0 domain vars", () => {
    expect(classifyEnvVar("VITE_AUTH0_DOMAIN")).toBe("auth0-domain");
    expect(classifyEnvVar("NEXT_PUBLIC_AUTH0_DOMAIN")).toBe("auth0-domain");
    expect(classifyEnvVar("AUTH0_TENANT")).toBe("auth0-domain");
  });

  it("classifies auth0 issuer vars", () => {
    expect(classifyEnvVar("AUTH0_ISSUER_BASE_URL")).toBe("auth0-issuer");
  });

  it("classifies audience and client id", () => {
    expect(classifyEnvVar("VITE_AUTH0_AUDIENCE")).toBe("auth0-audience");
    expect(classifyEnvVar("AUTH0_CLIENT_ID")).toBe("auth0-client-id");
  });

  it("classifies non-auth0 api base vars", () => {
    expect(classifyEnvVar("VITE_API_URL")).toBe("api-base");
    expect(classifyEnvVar("NEXT_PUBLIC_API_BASE_URL")).toBe("api-base");
    expect(classifyEnvVar("REACT_APP_BACKEND_ENDPOINT")).toBe("api-base");
  });

  it("infers role from a value when name is ambiguous", () => {
    expect(classifyEnvVar("VITE_TENANT", "dev-abc.us.auth0.com")).toBe(
      "auth0-domain"
    );
    expect(classifyEnvVar("MY_ISSUER", "https://dev-abc.us.auth0.com/")).toBe(
      "auth0-issuer"
    );
  });

  it("ignores unrelated and secret vars", () => {
    expect(classifyEnvVar("NODE_ENV")).toBeNull();
    expect(classifyEnvVar("AUTH0_CLIENT_SECRET")).toBeNull();
    expect(classifyEnvVar("DATABASE_URL")).toBeNull();
  });
});
