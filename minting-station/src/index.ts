// B4mal Minting Station — Hono Worker Entry Point
//
// Single POST /webhook/stripe endpoint that orchestrates:
//   1. Stripe signature verification (HMAC-SHA256)
//   2. Ed25519 license minting (CLI-compatible)
//   3. D1 persistence (idempotent via UNIQUE stripe_session_id)
//
// Environment bindings:
//   - STRIPE_WEBHOOK_SECRET: Stripe signing secret
//   - B4MAL_PRIVATE_KEY: Ed25519 private key (Base64URL)
//   - DB: D1 database binding

import { Hono } from "hono";
import { mintCoreKey, verifyStripeSignature, buildLicensePayload } from "./mint";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Env {
    STRIPE_WEBHOOK_SECRET: string;
    B4MAL_PRIVATE_KEY: string;
    DB: D1Database;
}

// ─── App ─────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

// Health check
app.get("/", (c) =>
    c.json({ service: "b4mal-minting-station", version: "1.1.0", status: "operational" })
);

// ─── Stripe Webhook ──────────────────────────────────────────────────────────

app.post("/webhook/stripe", async (c) => {
    const body = await c.req.text();
    const sigHeader = c.req.header("stripe-signature") ?? "";

    // 1. Verify Stripe signature
    const valid = await verifyStripeSignature(body, sigHeader, c.env.STRIPE_WEBHOOK_SECRET);
    if (!valid) {
        return c.json({ error: "Unauthorized: invalid Stripe signature" }, 401);
    }

    // 2. Parse event
    let event: any;
    try {
        event = JSON.parse(body);
    } catch {
        return c.json({ error: "Invalid JSON" }, 400);
    }

    // Only process checkout completions
    if (event.type !== "checkout.session.completed") {
        return c.json({ received: true, action: "ignored" });
    }

    const session = event.data?.object;
    const email = session?.customer_details?.email;
    const sessionId = session?.id;

    if (!email || !sessionId) {
        return c.json({ error: "Missing email or session ID" }, 400);
    }

    // 3. Check idempotency (prevent double-minting)
    const existing = await c.env.DB.prepare(
        "SELECT id FROM issued_licenses WHERE stripe_session_id = ?"
    ).bind(sessionId).first();

    if (existing) {
        return c.json({ received: true, action: "already_minted", id: existing.id });
    }

    // 4. Build license record
    const tier = session.metadata?.tier ?? "pro";
    const features = (session.metadata?.features ?? "audit,cache").split(",");
    const record = buildLicensePayload(email, sessionId, tier, features);

    // 5. Mint the core key
    const token = await mintCoreKey(
        {
            userId: sessionId,
            email,
            tier: tier as any,
            features,
            durationDays: 365,
        },
        c.env.B4MAL_PRIVATE_KEY
    );

    record.license_key = token;

    // 6. Persist to D1
    await c.env.DB.prepare(
        `INSERT INTO issued_licenses (id, user_email, stripe_session_id, license_key, tier, features, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
        record.id,
        record.user_email,
        record.stripe_session_id,
        record.license_key,
        record.tier,
        record.features,
        record.expires_at
    ).run();

    // 7. Return success (email delivery would be triggered separately)
    return c.json({
        received: true,
        action: "license_minted",
        id: record.id,
        email,
        tier,
        expires_at: record.expires_at,
    });
});

export default app;
