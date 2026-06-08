/**
 * @file attestation_schema.ts
 * @description Defines Zod schemas for verifying remote and local cache execution attestations.
 */

import { z } from "zod";

// ─── Attestation Schema ──────────────────────────────────────────────────────

export const IsolationAttestationSchema = z.object({
    /** ISO 8601 timestamp of verification */
    verified_at: z.string().datetime(),

    /** Verifier metadata */
    verifier: z.object({
        engine: z.string(),
        version: z.string(),
        duration_ms: z.number(),
        result: z.enum(["VERIFIED", "COLLISION"]),
    }),

    /** Proof payload */
    proof: z.object({
        /** NONE = no verification, PROCESS = pid isolation, FORMAL = formal proof */
        isolation_level: z.enum(["NONE", "PROCESS", "FORMAL"]),
        /** AST-stable logic hash from v0.5.0 */
        logic_hash: z.string(),
        /** Deterministic SHA-256 of the verified read/write resource sets */
        resource_set_hash: z.string(),
    }),

    /** Placeholder for v1.6.0 mTLS-sealed cryptographic signature */
    signature: z.string().optional(),
});

export type IsolationAttestation = z.infer<typeof IsolationAttestationSchema>;
