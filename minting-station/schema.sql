-- Delineau Minting Station — D1 Schema
-- Tracks every core license ever minted.

CREATE TABLE IF NOT EXISTS issued_licenses (
    id TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    stripe_session_id TEXT UNIQUE,
    license_key TEXT NOT NULL,
    tier TEXT DEFAULT 'pro',
    features TEXT DEFAULT 'audit,cache',
    issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email ON issued_licenses(user_email);
CREATE INDEX IF NOT EXISTS idx_stripe ON issued_licenses(stripe_session_id);
