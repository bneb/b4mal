# Design: Collision Detector Extension (Deliverable 8)

## Problem
Collision detector only handled fs: resource claims. Port, database, and other exact-match resources were ignored.

## Solution
Added claims field to TaskResourceClaim. Non-fs, non-env claims use exact-match semantics: two tasks claiming the same resource identifier = collision. Unlike filesystem paths, these don't use hierarchical prefix matching.

## Files
- src/core/formal_shadow.ts — TaskResourceClaim.claims field, exact-match loop in verifyWave
- src/core/engine.ts — Thread claims through build(), plan(), shadow()
- src/lsp/server.ts — Thread claims in validateDocument
