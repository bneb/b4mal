// Tests: Composite Identity Engine (v2.2.0 — RED-to-GREEN)
//
// Validates the tiered TaskIdentity hashing:
//   logicHash   — normalized AST (cross-platform)
//   claimHash   — Z3 resource map (cross-platform)
//   platformHash — OS + arch + toolchain (platform-specific)

import { describe, test, expect } from "bun:test";
import { TaskIdentity } from "../src/core/identity";

// ─── Comment Invariance ──────────────────────────────────────────────────────

describe("TaskIdentity - Comment Invariance", () => {
    test("adding a 100-line comment does not change the logicHash", () => {
        const codeA = 'fn main() { println!("hello"); }';
        const commentBlock = Array.from({ length: 100 }, (_, i) => `// Comment line ${i}`).join("\n");
        const codeB = commentBlock + '\nfn main() { println!("hello"); }';

        const idA = TaskIdentity.fromCode(codeA, "main.rs", []);
        const idB = TaskIdentity.fromCode(codeB, "main.rs", []);

        expect(idA.logicHash).toBe(idB.logicHash);
    });

    test("indentation and blank-line changes do not affect logicHash", () => {
        const codeA = 'fn add(a: i32, b: i32) -> i32 { a + b }';
        const codeB = 'fn   add(a:   i32,   b:   i32)   ->   i32   {   a   +   b   }';

        const idA = TaskIdentity.fromCode(codeA, "lib.rs", []);
        const idB = TaskIdentity.fromCode(codeB, "lib.rs", []);

        expect(idA.logicHash).toBe(idB.logicHash);
    });
});

// ─── Platform Isolation ──────────────────────────────────────────────────────

describe("TaskIdentity - Platform Isolation", () => {
    test("identical logic on different platforms shares logicHash but differs in platformHash", () => {
        const code = 'fn main() { let x = 42; }';

        const idA = TaskIdentity.fromCode(code, "main.rs", [], "darwin", "arm64");
        const idB = TaskIdentity.fromCode(code, "main.rs", [], "linux", "x64");

        // Logic is cross-platform
        expect(idA.logicHash).toBe(idB.logicHash);
        expect(idA.claimHash).toBe(idB.claimHash);

        // Platform is isolated
        expect(idA.platformHash).not.toBe(idB.platformHash);
    });
});

// ─── Resource Collision ──────────────────────────────────────────────────────

describe("TaskIdentity - Resource Claims", () => {
    test("changing a resource claim produces a new claimHash", () => {
        const code = 'fn main() {}';

        const idA = TaskIdentity.fromCode(code, "main.rs", ["fs:src/", "env:DATABASE_URL"]);
        const idB = TaskIdentity.fromCode(code, "main.rs", ["fs:dist/", "env:DATABASE_URL"]);

        // Logic is the same
        expect(idA.logicHash).toBe(idB.logicHash);

        // Claims differ — Z3 proof must re-verify
        expect(idA.claimHash).not.toBe(idB.claimHash);
    });

    test("empty claims produce a stable, deterministic claimHash", () => {
        const idA = TaskIdentity.fromCode("fn main() {}", "main.rs", []);
        const idB = TaskIdentity.fromCode("fn main() {}", "main.rs", []);

        expect(idA.claimHash).toBe(idB.claimHash);
    });
});

// ─── Major Version Stability ─────────────────────────────────────────────────

describe("TaskIdentity - Major Version Stability", () => {
    test("patch-level runtime updates do not break platformHash", () => {
        // Simulating v20.1.0 vs v20.2.3 — only major version matters
        const idA = TaskIdentity.fromCode("fn main() {}", "main.rs", [], "darwin", "arm64", "v20.1.0");
        const idB = TaskIdentity.fromCode("fn main() {}", "main.rs", [], "darwin", "arm64", "v20.2.3");

        expect(idA.platformHash).toBe(idB.platformHash);
    });

    test("major version change DOES change platformHash", () => {
        const idA = TaskIdentity.fromCode("fn main() {}", "main.rs", [], "darwin", "arm64", "v20.1.0");
        const idB = TaskIdentity.fromCode("fn main() {}", "main.rs", [], "darwin", "arm64", "v22.0.0");

        expect(idA.platformHash).not.toBe(idB.platformHash);
    });
});
