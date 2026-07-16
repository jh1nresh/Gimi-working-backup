import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { bearerToken, verifyPrivyAccessToken } from "@/lib/privyServerAuth";

async function fixture(overrides: { audience?: string; issuer?: string; subject?: string } = {}) {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const verificationKey = await exportSPKI(publicKey);
  const token = await new SignJWT({ sid: "session_1" })
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(overrides.subject ?? "did:privy:user_1")
    .setAudience(overrides.audience ?? "app_1")
    .setIssuer(overrides.issuer ?? "privy.io")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return { token, verificationKey };
}

describe("Privy server auth", () => {
  it("extracts a bearer token", () => {
    const request = new Request("https://gimi.test", { headers: { authorization: "Bearer token_1" } });
    expect(bearerToken(request)).toBe("token_1");
  });

  it("verifies an access token and returns its Privy user id", async () => {
    const { token, verificationKey } = await fixture();
    await expect(verifyPrivyAccessToken(token, { appId: "app_1", verificationKey })).resolves.toEqual({
      userId: "did:privy:user_1",
      sessionId: "session_1",
    });
  });

  it.each([
    [{ audience: "wrong_app" }, "app_1"],
    [{ issuer: "not-privy" }, "app_1"],
    [{ subject: "user_1" }, "app_1"],
  ])("rejects invalid claims", async (overrides, appId) => {
    const { token, verificationKey } = await fixture(overrides);
    await expect(verifyPrivyAccessToken(token, { appId, verificationKey })).rejects.toThrow();
  });
});
