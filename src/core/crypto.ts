/**
 * @file crypto.ts
 * @description Provides standardized, low-level cryptographic primitives for hashing and signing.
 */

export class ArtifactCrypto {
    private secretKey: string | null;

    constructor(secretKey: string | null = Bun.env.B4MAL_CACHE_SECRET ?? null) {
        this.secretKey = secretKey;
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
     * If strict mode is on, an unsigned artifact will fail verification.
     */
    verify(contentHash: string, signature: string | undefined): boolean {
        // If no secret key is configured, we run in standard trust mode
        if (!this.secretKey) return true;

        if (!signature) return false;

        const expected = this.sign(contentHash);
        return expected === signature;
    }
}
