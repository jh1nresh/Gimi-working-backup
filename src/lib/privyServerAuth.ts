import { importSPKI, jwtVerify, type JWTPayload } from "jose";

export interface PrivyAuthClaims {
  userId: string;
  sessionId?: string;
}

interface VerificationConfig {
  appId: string;
  verificationKey: string;
}

function normalizedVerificationKey(value: string) {
  return value.replace(/\\n/g, "\n").trim();
}

export function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

export async function verifyPrivyAccessToken(token: string, config: VerificationConfig): Promise<PrivyAuthClaims> {
  const key = await importSPKI(normalizedVerificationKey(config.verificationKey), "ES256");
  const { payload } = await jwtVerify(token, key, {
    algorithms: ["ES256"],
    audience: config.appId,
    issuer: "privy.io",
  });

  return claimsFromPayload(payload);
}

export async function requirePrivyAuth(request: Request): Promise<PrivyAuthClaims> {
  const token = bearerToken(request);
  if (!token) throw new Error("auth_required");

  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
  const verificationKey = process.env.PRIVY_JWT_VERIFICATION_KEY?.trim();
  if (!appId || !verificationKey) throw new Error("auth_not_configured");

  try {
    return await verifyPrivyAccessToken(token, { appId, verificationKey });
  } catch {
    throw new Error("invalid_auth_token");
  }
}

function claimsFromPayload(payload: JWTPayload): PrivyAuthClaims {
  if (typeof payload.sub !== "string" || !payload.sub.startsWith("did:privy:")) {
    throw new Error("invalid_auth_token");
  }

  return {
    userId: payload.sub,
    sessionId: typeof payload.sid === "string" ? payload.sid : undefined,
  };
}
