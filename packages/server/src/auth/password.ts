import { hash, verify } from "@node-rs/argon2";

// =============================================================================
// Password hashing — Argon2id (same as Python's argon2-cffi defaults).
// =============================================================================

const ARGON2_OPTIONS = {
  memoryCost: 19456,   // ~19 MiB
  timeCost: 2,
  outputLen: 32,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  return verify(hashed, plain);
}
