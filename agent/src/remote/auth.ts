import { createPublicKey, randomBytes, randomUUID, verify, type KeyObject } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { RemoteError } from "./errors.js";

const AllowedPublicKeySchema = Type.Object(
  {
    keyId: Type.String(),
    publicKey: Type.String(),
  },
  { additionalProperties: false },
);

export interface AllowedPublicKey {
  keyId: string;
  publicKey: string;
}

export interface AuthServiceOptions {
  origin: string;
  challengeTtlMs?: number;
  tokenTtlMs?: number;
  allowedKeys: AllowedPublicKey[];
  now?: () => number;
}

interface ChallengeRecord {
  challengeId: string;
  keyId: string;
  nonce: string;
  origin: string;
  expiresAt: number;
  used: boolean;
}

export interface AuthSession {
  token: string;
  clientId: string;
  keyId: string;
  expiresAt: number;
}

export interface AuthChallenge {
  challengeId: string;
  nonce: string;
  origin: string;
  expiresAt: number;
  algorithm: "ed25519";
}

interface TokenRecord {
  token: string;
  clientId: string;
  keyId: string;
  expiresAt: number;
}

export function createChallengePayload(input: {
  challengeId: string;
  keyId: string;
  nonce: string;
  origin: string;
  expiresAt: number;
}): string {
  return [input.challengeId, input.keyId, input.nonce, input.origin, String(input.expiresAt)].join(
    ":",
  );
}

export class AuthService {
  private readonly challengeTtlMs: number;
  private readonly tokenTtlMs: number;
  private readonly now: () => number;
  private readonly keys = new Map<string, KeyObject>();
  private readonly challenges = new Map<string, ChallengeRecord>();
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly origin: string;

  constructor(options: AuthServiceOptions) {
    this.challengeTtlMs = options.challengeTtlMs ?? 120_000;
    this.tokenTtlMs = options.tokenTtlMs ?? 86_400_000;
    this.now = options.now ?? (() => Date.now());
    this.origin = options.origin;
    for (const entry of options.allowedKeys) {
      const key = createPublicKey(entry.publicKey);
      if (key.asymmetricKeyType !== "ed25519") {
        throw new RemoteError("Only ed25519 public keys are supported", 500);
      }
      this.keys.set(entry.keyId, key);
    }
  }

  private pruneExpiredRecords(now: number): void {
    for (const [challengeId, challenge] of this.challenges) {
      if (challenge.used || challenge.expiresAt <= now) {
        this.challenges.delete(challengeId);
      }
    }
    for (const [token, record] of this.tokens) {
      if (record.expiresAt <= now) {
        this.tokens.delete(token);
      }
    }
  }

  createChallenge(keyId: string): AuthChallenge {
    this.pruneExpiredRecords(this.now());
    if (!this.keys.has(keyId)) {
      throw new RemoteError("Unknown key", 403);
    }

    const challengeId = randomUUID();
    const nonce = randomBytes(24).toString("base64url");
    const expiresAt = this.now() + this.challengeTtlMs;
    this.challenges.set(challengeId, {
      challengeId,
      keyId,
      nonce,
      origin: this.origin,
      expiresAt,
      used: false,
    });

    return {
      challengeId,
      nonce,
      origin: this.origin,
      expiresAt,
      algorithm: "ed25519",
    };
  }

  verifyChallenge(input: { challengeId: string; keyId: string; signature: string }): AuthSession {
    this.pruneExpiredRecords(this.now());
    const challenge = this.challenges.get(input.challengeId);
    if (!challenge) {
      throw new RemoteError("Challenge not found", 401);
    }
    if (challenge.keyId !== input.keyId) {
      throw new RemoteError("Challenge key mismatch", 401);
    }
    if (challenge.used) {
      throw new RemoteError("Challenge already used", 401);
    }
    if (challenge.expiresAt <= this.now()) {
      throw new RemoteError("Challenge expired", 401);
    }

    const publicKey = this.keys.get(input.keyId);
    if (!publicKey) {
      throw new RemoteError("Unknown key", 403);
    }

    const payload = createChallengePayload(challenge);
    const signature = decodeBase64(input.signature);
    const ok = verify(null, Buffer.from(payload), publicKey, signature);

    if (!ok) {
      throw new RemoteError("Invalid signature", 401);
    }

    challenge.used = true;
    this.challenges.delete(input.challengeId);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.tokenTtlMs;
    const record: TokenRecord = {
      token,
      keyId: input.keyId,
      clientId: input.keyId,
      expiresAt,
    };
    this.tokens.set(token, record);

    return {
      token,
      clientId: record.clientId,
      keyId: record.keyId,
      expiresAt,
    };
  }

  authenticate(authorizationHeader: string | undefined): AuthSession {
    this.pruneExpiredRecords(this.now());
    if (authorizationHeader === undefined || authorizationHeader.length === 0) {
      throw new RemoteError("Missing authorization header", 401);
    }
    const [scheme, token] = authorizationHeader.split(" ");
    if (scheme !== "Bearer" || token === undefined || token.length === 0) {
      throw new RemoteError("Invalid authorization header", 401);
    }
    const record = this.tokens.get(token);
    if (!record) {
      throw new RemoteError("Invalid token", 401);
    }
    if (record.expiresAt <= this.now()) {
      this.tokens.delete(token);
      throw new RemoteError("Token expired", 401);
    }

    return {
      token: record.token,
      clientId: record.clientId,
      keyId: record.keyId,
      expiresAt: record.expiresAt,
    };
  }
}

function decodeBase64(value: string): Buffer {
  try {
    return Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
  } catch {
    throw new RemoteError("Invalid signature encoding", 400);
  }
}

export function parseAllowedKeys(value: string | undefined): AllowedPublicKey[] {
  if (value === undefined || value.length === 0) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => {
          if (!Value.Check(AllowedPublicKeySchema, entry)) {
            return null;
          }

          return Value.Parse(AllowedPublicKeySchema, entry);
        })
        .filter((entry): entry is AllowedPublicKey => entry !== null);
    }

    if (parsed !== null && typeof parsed === "object") {
      return Object.entries(parsed).flatMap(([keyId, publicKey]) => {
        if (typeof publicKey !== "string") {
          return [];
        }
        return [{ keyId, publicKey }];
      });
    }
  } catch {
    throw new RemoteError("Invalid PI_REMOTE_ALLOWED_KEYS format", 500);
  }

  return [];
}
