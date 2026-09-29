/**
 * @file crypto.ts
 * @description Provides standardized, low-level cryptographic primitives for hashing and signing.
 */

import { timingSafeEqual } from "crypto";

export class ArtifactCrypto {
    private secretKey: string | null;

    constructor(secretKey: string | null = Bun.env.B4MAL_CACHE_SECRET ?? null) {
        // An empty string is not a key; treat it as unset so a stray
        // B4MAL_CACHE_SECRET="" cannot silently disable signing.
        this.secretKey = secretKey && secretKey.length > 0 ? secretKey : null;
    }

    /** True when a signing secret is configured. */
    get isEnabled(): boolean {
        return this.secretKey !== null;
    }

    /**
     * Generate an HMAC-SHA256 signature for an artifact's content hash.
     */
    sign(contentHash: string): string | null {
        if (!this.secretKey) return null;
        const hasher = new Bun.CryptoHasher("sha256", this.secretKey);
        hasher.update(contentHash);
        return hasher.digest("hex");
    }

    /**
     * Verify a signature against a content hash.
     *
     * With no secret key configured this runs in trust mode and accepts
     * anything. With a key configured, an unsigned artifact fails — signed
     * entries are required, not merely checked when present.
     */
    verify(contentHash: string, signature: string | undefined): boolean {
        if (!this.secretKey) return true;

        if (!signature) return false;

        const expected = this.sign(contentHash);
        if (!expected) return false;

        // Constant-time comparison: a length mismatch cannot be compared, and a
        // byte-by-byte early exit would leak how much of a guess was correct.
        const expectedBuf = Buffer.from(expected, "hex");
        const actualBuf = Buffer.from(signature, "hex");
        if (expectedBuf.length !== actualBuf.length) return false;

        return timingSafeEqual(expectedBuf, actualBuf);
    }
}
