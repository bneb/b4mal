# Minting Station API

B4mal license minting service — Cloudflare Workers + D1.

## Endpoints

### `POST /webhook/stripe`
Stripe webhook handler. Verifies HMAC-SHA256 signature. Processes `checkout.session.completed` events.

### `GET /health`
Health check. Returns `{ version: "1.2.0", status: "ok" }`.

### `POST /api/licenses/verify` (planned)
Verify a license key's validity. Returns `{ valid: boolean, tier: string, features: string[], expiresAt: string }`.

### `GET /api/licenses/:email` (planned)
List licenses for an email address. Requires admin API key.

## Database Schema

```sql
CREATE TABLE issued_licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,
  stripe_session_id TEXT UNIQUE NOT NULL,
  license_key TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'community',
  features TEXT NOT NULL DEFAULT '[]',
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);
```

## Environment

| Variable | Purpose |
|----------|---------|
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `MINT_PRIVATE_KEY` | Ed25519 private key for license signing |
| `ADMIN_API_KEY` | API key for admin endpoints |
