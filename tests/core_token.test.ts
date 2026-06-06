/**
 * Tests: Core Token Engine (v2.2.0 — RED PHASE)
 *
 * Validates JWT signing, tamper detection, payload accuracy,
 * expiry enforcement, and signing performance.
 */
import { describe, test, expect } from "bun:test";
import { CoreToken, type CoreTokenPayload } from "../src/core/core_token";

// ─── Signing & Verification ──────────────────────────────────────────────────

describe("CoreToken", () => {
    const TEST_KEY = "b4mal-test-signing-key-256bit-0000";

    test("generates a valid JWT string", () => {
        const payload: CoreTokenPayload = {
            org_id: "acme-corp",
            period: "2026-02-01/2026-03-01",
            savings_ms: 45_000,
            verification_count: 12,
        };

        const token = CoreToken.generate(payload, TEST_KEY);

        expect(typeof token).toBe("string");
        // JWT has 3 dot-separated parts: header.payload.signature
        expect(token.split(".")).toHaveLength(3);
    });

    test("round-trips payload through sign and verify", () => {
        const payload: CoreTokenPayload = {
            org_id: "acme-corp",
            period: "2026-02-01/2026-03-01",
            savings_ms: 120_500,
            verification_count: 47,
        };

        const token = CoreToken.generate(payload, TEST_KEY);
        const decoded = CoreToken.verify(token, TEST_KEY);

        expect(decoded.org_id).toBe("acme-corp");
        expect(decoded.savings_ms).toBe(120_500);
        expect(decoded.verification_count).toBe(47);
        expect(decoded.period).toBe("2026-02-01/2026-03-01");
    });

    // ─── Cryptographic Integrity ──────────────────────────────────────────

    test("tampered payload fails verification", () => {
        const payload: CoreTokenPayload = {
            org_id: "acme-corp",
            period: "2026-02-01/2026-03-01",
            savings_ms: 10_000,
            verification_count: 5,
        };

        const token = CoreToken.generate(payload, TEST_KEY);
        const parts = token.split(".");

        // Tamper: decode payload, change savings_ms, re-encode
        const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString());
        decoded.savings_ms = 999_999;
        parts[1] = Buffer.from(JSON.stringify(decoded)).toString("base64url");
        const tampered = parts.join(".");

        expect(() => CoreToken.verify(tampered, TEST_KEY)).toThrow();
    });

    test("wrong key fails verification", () => {
        const payload: CoreTokenPayload = {
            org_id: "acme-corp",
            period: "2026-02-01/2026-03-01",
            savings_ms: 5_000,
            verification_count: 2,
        };

        const token = CoreToken.generate(payload, TEST_KEY);
        expect(() => CoreToken.verify(token, "wrong-key-totally-different")).toThrow();
    });

    // ─── Payload Accuracy ─────────────────────────────────────────────────

    test("token includes issuer and iat claims", () => {
        const payload: CoreTokenPayload = {
            org_id: "core-labs",
            period: "2026-03-01/2026-03-31",
            savings_ms: 0,
            verification_count: 0,
        };

        const token = CoreToken.generate(payload, TEST_KEY);
        const decoded = CoreToken.verify(token, TEST_KEY);

        expect(decoded.iss).toBe("b4mal-node-v2.2.0");
        expect(decoded.iat).toBeGreaterThan(0);
    });

    // ─── Expiry / Windowing ───────────────────────────────────────────────

    test("token includes expiry claim (30-day window)", () => {
        const payload: CoreTokenPayload = {
            org_id: "acme-corp",
            period: "2026-02-01/2026-03-01",
            savings_ms: 50_000,
            verification_count: 10,
        };

        const token = CoreToken.generate(payload, TEST_KEY);
        const decoded = CoreToken.verify(token, TEST_KEY);

        expect(decoded.exp).toBeGreaterThan(decoded.iat);
        // Expiry should be ~30 days after issuance
        const thirtyDaysInSeconds = 30 * 24 * 60 * 60;
        expect(decoded.exp - decoded.iat).toBe(thirtyDaysInSeconds);
    });

    test("expired token fails verification", () => {
        const payload: CoreTokenPayload = {
            org_id: "acme-corp",
            period: "2025-01-01/2025-02-01",
            savings_ms: 1_000,
            verification_count: 1,
        };

        // Generate with a custom expiry in the past
        const token = CoreToken.generate(payload, TEST_KEY, { ttlSeconds: -1 });

        expect(() => CoreToken.verify(token, TEST_KEY)).toThrow();
    });

    // ─── Performance ──────────────────────────────────────────────────────

    test("token signing completes in <5ms", () => {
        const payload: CoreTokenPayload = {
            org_id: "perf-test",
            period: "2026-03-01/2026-03-31",
            savings_ms: 100_000,
            verification_count: 50,
        };

        const start = performance.now();
        CoreToken.generate(payload, TEST_KEY);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(5);
    });

    // ─── Edge Cases ───────────────────────────────────────────────────────

    test("zero savings generates valid token", () => {
        const payload: CoreTokenPayload = {
            org_id: "new-org",
            period: "2026-03-01/2026-03-31",
            savings_ms: 0,
            verification_count: 0,
        };

        const token = CoreToken.generate(payload, TEST_KEY);
        const decoded = CoreToken.verify(token, TEST_KEY);
        expect(decoded.savings_ms).toBe(0);
        expect(decoded.verification_count).toBe(0);
    });

    test("malformed token string throws", () => {
        expect(() => CoreToken.verify("not.a.jwt", TEST_KEY)).toThrow();
        expect(() => CoreToken.verify("totally-invalid", TEST_KEY)).toThrow();
    });
});
