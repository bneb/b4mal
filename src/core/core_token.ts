/**
 * @file core_token.ts
 * @description Manages cryptographic capabilities and access tokens for L2 cache synchronization.
 */

export interface CoreTokenPayload {
    /** mTLS-verified organization identifier */
    org_id: string;
    /** 30-day audit window (ISO 8601 interval) */
    period: string;
    /** Total time recovered from Logical Hits (ms) */
    savings_ms: number;
    /** Number of tasks with Resource Monitor attestations */
    verification_count: number;
    /** RBAC Role for Enterprise Integrations */
    role?: "admin" | "writer" | "reader";
}

export interface TokenClaims extends CoreTokenPayload {
    iss: string;
    iat: number;
    exp: number;
}

export interface GenerateOptions {
    /** Token TTL in seconds (default: 30 days) */
    ttlSeconds?: number;
}

// ─── Base64url ───────────────────────────────────────────────────────────────

function toBase64url(data: string): string {
    return Buffer.from(data).toString("base64url");
}

function fromBase64url(data: string): string {
    return Buffer.from(data, "base64url").toString();
}

// ─── HMAC-SHA256 ─────────────────────────────────────────────────────────────

function hmacSign(data: string, key: string): string {
    const hasher = new Bun.CryptoHasher("sha256", key);
    hasher.update(data);
    return hasher.digest("base64url") as string;
}

// ─── Token Engine ────────────────────────────────────────────────────────────

const THIRTY_DAYS = 30 * 24 * 60 * 60;

export class CoreToken {
    /**
     * Generate a signed Core Token (JWT HS256).
     *
     * The token encodes the savings payload, issuer, issuance time,
     * and a 30-day expiry window. Signed with HMAC-SHA256.
     */
    static generate(
        payload: CoreTokenPayload,
        signingKey: string,
        options?: GenerateOptions
    ): string {
        const ttl = options?.ttlSeconds ?? THIRTY_DAYS;
        const now = Math.floor(Date.now() / 1000);

        const header = { alg: "HS256", typ: "JWT" };
        const claims: TokenClaims = {
            ...payload,
            iss: "b4mal-node-v2.2.0",
            iat: now,
            exp: now + ttl,
        };

        const headerB64 = toBase64url(JSON.stringify(header));
        const payloadB64 = toBase64url(JSON.stringify(claims));
        const signingInput = `${headerB64}.${payloadB64}`;
        const signature = hmacSign(signingInput, signingKey);

        return `${signingInput}.${signature}`;
    }

    /**
     * Verify and decode a Core Token.
     *
     * Checks:
     *   1. Structural integrity (3-part JWT)
     *   2. HMAC-SHA256 signature match
     *   3. Expiry window (exp > now)
     *
     * @throws Error on invalid/expired/tampered tokens
     */
    static verify(token: string, signingKey: string): TokenClaims {
        const parts = token.split(".");
        if (parts.length !== 3) {
            throw new Error("Core Token: malformed — expected 3 JWT segments");
        }

        const [headerB64, payloadB64, signature] = parts;

        // Verify signature
        const signingInput = `${headerB64}.${payloadB64}`;
        const expectedSig = hmacSign(signingInput, signingKey);

        if (signature !== expectedSig) {
            throw new Error("Core Token: signature verification failed — token tampered or wrong key");
        }

        // Decode payload
        let claims: TokenClaims;
        try {
            claims = JSON.parse(fromBase64url(payloadB64));
        } catch {
            throw new Error("Core Token: payload decode failed — corrupted data");
        }

        // Check expiry
        const now = Math.floor(Date.now() / 1000);
        if (claims.exp <= now) {
            throw new Error(`Core Token: expired at ${new Date(claims.exp * 1000).toISOString()}`);
        }

        return claims;
    }
}
