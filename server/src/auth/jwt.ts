import { SignJWT, jwtVerify } from "jose";

// =============================================================================
// JWT helpers — Phase 1: HS256 with auto-generated or env-provided secret.
// =============================================================================

let _secret: Uint8Array | null = null;

function getSecret(): Uint8Array {
  if (_secret) return _secret;

  const raw =
    process.env["JWT_SECRET_KEY"] ??
    process.env["YUXI_INSTANCE_ID"] ??
    // Auto-generate for dev; in production JWT_SECRET_KEY must be set.
    "octopus-dev-" + Math.random().toString(36).slice(2) + Date.now();

  _secret = new TextEncoder().encode(raw);
  return _secret;
}

export interface TokenPayload {
  sub: string;   // user id
  role: string;  // user | admin | superadmin
  iat?: number;
  exp?: number;
}

export async function signToken(payload: Omit<TokenPayload, "iat" | "exp">): Promise<string> {
  const secret = getSecret();
  return new SignJWT({ role: payload.role })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime("24h")
    .setProtectedHeader({ alg: "HS256" })
    .sign(secret);
}

export async function verifyToken(token: string): Promise<TokenPayload> {
  const secret = getSecret();
  const { payload } = await jwtVerify(token, secret);
  return {
    sub: payload.sub!,
    role: (payload.role as string) ?? "user",
  };
}
