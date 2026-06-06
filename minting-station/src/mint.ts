// B4mal Minting Station — SubtleCrypto Ed25519 Engine
//
// Produces tokens in the exact same format as LicenseManager.mint()
// so the CLI's LicenseManager.verify() accepts them without modification.
//
// Token: Base64URL(header).Base64URL(payload).Base64URL(Ed25519 signature)
//
// Also handles Stripe webhook HMAC-SHA256 verification and
// D1 record construction.

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MintRequest {
    userId: string;
    email: string;
    tier: "founder" | "pro" | "beta-tester" | "team" | "enterprise";
    features: string[];
    durationDays: number;
}

export interface LicenseRecord {
    id: string;
    user_email: string;
    stripe_session_id: string;
    license_key: string;
    tier: string;
    features: string;
    expires_at: string;
}

// ─── Base64URL Helpers ───────────────────────────────────────────────────────

function b64url(data: string): string {
    return btoa(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlBytes(bytes: Uint8Array): string {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(encoded: string): Uint8Array {
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

// ─── Ed25519 Minting ─────────────────────────────────────────────────────────

/**
 * Mint a Core License Key using Ed25519.
 * Produces a token in the exact format expected by LicenseManager.verify().
 */
export async function mintCoreKey(
    request: MintRequest,
    privateKeyB64: string
): Promise<string> {
    const now = Date.now();
    const durationMs = request.durationDays * 24 * 60 * 60 * 1000;

    const header = { alg: "Ed25519", typ: "b4mal-license" };
    const payload = {
        userId: request.userId,
        tier: request.tier,
        features: request.features,
        iat: now,
        exp: now + durationMs,
    };

    const headerB64 = b64url(JSON.stringify(header));
    const payloadB64 = b64url(JSON.stringify(payload));
    const signingInput = `${headerB64}.${payloadB64}`;

    // Import private key
    const keyData = b64urlToBytes(privateKeyB64);
    const key = await crypto.subtle.importKey(
        "pkcs8",
        keyData,
        { name: "Ed25519" },
        false,
        ["sign"]
    );

    // Sign
    const signature = await crypto.subtle.sign(
        "Ed25519",
        key,
        new TextEncoder().encode(signingInput)
    );

    const sigB64 = b64urlBytes(new Uint8Array(signature));
    return `${signingInput}.${sigB64}`;
}

// ─── Stripe Webhook Verification ─────────────────────────────────────────────

const TOLERANCE_SECONDS = 300; // 5 minutes

/**
 * Verify a Stripe webhook signature using HMAC-SHA256.
 * Rejects stale timestamps (>5 min old) to prevent replay attacks.
 */
export async function verifyStripeSignature(
    payload: string,
    signatureHeader: string,
    secret: string
): Promise<boolean> {
    if (!signatureHeader) return false;

    try {
        // Parse t= and v1= from header
        const parts = signatureHeader.split(",");
        let timestamp = "";
        let sigHex = "";

        for (const part of parts) {
            const [k, v] = part.split("=");
            if (k === "t") timestamp = v;
            if (k === "v1") sigHex = v;
        }

        if (!timestamp || !sigHex) return false;

        // Reject stale timestamps
        const age = Math.floor(Date.now() / 1000) - parseInt(timestamp);
        if (age > TOLERANCE_SECONDS) return false;

        // Compute expected signature
        const signingString = `${timestamp}.${payload}`;
        const key = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(secret),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"]
        );
        const expected = await crypto.subtle.sign(
            "HMAC",
            key,
            new TextEncoder().encode(signingString)
        );

        // Constant-time comparison
        const expectedHex = Array.from(new Uint8Array(expected))
            .map(b => b.toString(16).padStart(2, "0"))
            .join("");

        return timingSafeEqual(sigHex, expectedHex);
    } catch {
        return false;
    }
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
}

// ─── D1 Record Builder ──────────────────────────────────────────────────────

/**
 * Build a license record for D1 insertion.
 * Uses crypto.randomUUID() for unique IDs.
 */
export function buildLicensePayload(
    email: string,
    stripeSessionId: string,
    tier: string,
    features: string[]
): LicenseRecord {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

    return {
        id: crypto.randomUUID(),
        user_email: email,
        stripe_session_id: stripeSessionId,
        license_key: "", // Filled after minting
        tier,
        features: features.join(","),
        expires_at: expiresAt.toISOString(),
    };
}
