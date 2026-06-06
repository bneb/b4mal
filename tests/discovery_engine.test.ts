// Tests: Core Discovery Engine (v3.1.0 — RED-to-GREEN)
//
// Validates: import graph tracing, circular detection, orphan
// identification, claim accuracy, and interview flow.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ImportTracer, type DependencyGraph } from "../src/discovery/graph";
import { ClusterEngine, type ApertureProposal } from "../src/discovery/auto_map";
import { InterviewGenerator, type CoreQuestion, type ApertureMap } from "../src/discovery/interview";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

let testRoot: string;

beforeAll(async () => {
    testRoot = path.join(os.tmpdir(), "b4mal-discovery-test-" + Date.now());

    // Build a mock project with known dependency structure:
    //
    //   src/auth/login.ts → src/db/connection.ts
    //   src/db/connection.ts → src/auth/session.ts  (circular!)
    //   src/auth/session.ts → src/auth/login.ts     (circular!)
    //   src/api/routes.ts → src/auth/login.ts
    //   src/api/routes.ts → src/db/connection.ts
    //   src/utils/orphan.ts — no imports, no one imports it
    //   data/seeds.json — not a code file

    await fs.mkdir(path.join(testRoot, "src", "auth"), { recursive: true });
    await fs.mkdir(path.join(testRoot, "src", "db"), { recursive: true });
    await fs.mkdir(path.join(testRoot, "src", "api"), { recursive: true });
    await fs.mkdir(path.join(testRoot, "src", "utils"), { recursive: true });
    await fs.mkdir(path.join(testRoot, "data"), { recursive: true });

    await fs.writeFile(path.join(testRoot, "src", "auth", "login.ts"),
        `import { getConnection } from "../db/connection";\nexport function login() {}`);
    await fs.writeFile(path.join(testRoot, "src", "auth", "session.ts"),
        `import { login } from "./login";\nexport function session() {}`);
    await fs.writeFile(path.join(testRoot, "src", "db", "connection.ts"),
        `import { session } from "../auth/session";\nexport function getConnection() {}`);
    await fs.writeFile(path.join(testRoot, "src", "api", "routes.ts"),
        `import { login } from "../auth/login";\nimport { getConnection } from "../db/connection";\nexport function routes() {}`);
    await fs.writeFile(path.join(testRoot, "src", "utils", "orphan.ts"),
        `export const MAGIC_NUMBER = 42;`);
    await fs.writeFile(path.join(testRoot, "data", "seeds.json"),
        `{"users": []}`);
    await fs.writeFile(path.join(testRoot, "package.json"),
        `{"name": "test-project"}`);
});

afterAll(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
});

// ─── Import Graph ────────────────────────────────────────────────────────────

describe("ImportTracer - Graph Construction", () => {
    test("traces all source files as nodes", async () => {
        const tracer = new ImportTracer();
        const graph = await tracer.trace(testRoot);

        // Should find 5 .ts files
        expect(graph.nodes.length).toBe(5);
        expect(graph.nodes.some(n => n.includes("login.ts"))).toBe(true);
        expect(graph.nodes.some(n => n.includes("orphan.ts"))).toBe(true);
    });

    test("traces import edges correctly", async () => {
        const tracer = new ImportTracer();
        const graph = await tracer.trace(testRoot);

        // login.ts → connection.ts
        const loginToDb = graph.edges.find(e =>
            e.source.includes("login.ts") && e.target.includes("connection.ts")
        );
        expect(loginToDb).toBeDefined();
        expect(loginToDb!.type).toBe("static");
    });

    test("identifies orphan files (no imports, no importers)", async () => {
        const tracer = new ImportTracer();
        const graph = await tracer.trace(testRoot);

        expect(graph.orphans.some(o => o.includes("orphan.ts"))).toBe(true);
    });
});

// ─── Circular Detection ──────────────────────────────────────────────────────

describe("ClusterEngine - Circular Detection", () => {
    test("3-file circular import chain flagged as Combined Aperture", async () => {
        const tracer = new ImportTracer();
        const graph = await tracer.trace(testRoot);
        const engine = new ClusterEngine();
        const proposals = engine.analyze(graph);

        // auth/login → db/connection → auth/session → auth/login = cycle
        const combined = proposals.find(p => p.type === "combined");
        expect(combined).toBeDefined();
        expect(combined!.reason).toContain("Circular");

        // The combined aperture should contain all 3 cycle members
        const hasCycleMembers =
            combined!.files.some(f => f.includes("login.ts")) &&
            combined!.files.some(f => f.includes("connection.ts")) &&
            combined!.files.some(f => f.includes("session.ts"));
        expect(hasCycleMembers).toBe(true);
    });
});

// ─── Orphan Identification ───────────────────────────────────────────────────

describe("ClusterEngine - Orphan Identification", () => {
    test("orphan files are flagged for pruning", async () => {
        const tracer = new ImportTracer();
        const graph = await tracer.trace(testRoot);
        const engine = new ClusterEngine();
        const proposals = engine.analyze(graph);

        const orphanProposal = proposals.find(p =>
            p.type === "orphan" && p.files.some(f => f.includes("orphan.ts"))
        );
        expect(orphanProposal).toBeDefined();
        expect(orphanProposal!.reason).toContain("zero");
    });
});

// ─── Claim Accuracy ──────────────────────────────────────────────────────────

describe("ClusterEngine - Claim Accuracy", () => {
    test("generated fs: claims match physical file boundaries", async () => {
        const tracer = new ImportTracer();
        const graph = await tracer.trace(testRoot);
        const engine = new ClusterEngine();
        const proposals = engine.analyze(graph);

        for (const proposal of proposals) {
            for (const claim of proposal.claims) {
                expect(claim.startsWith("fs:")).toBe(true);
                // The path after fs: should correspond to a real relative path
                const relative = claim.replace("fs:", "");
                expect(proposal.files.some(f => f.includes(relative) || relative.includes(path.dirname(f.replace(testRoot, ""))))).toBe(true);
            }
        }
    });
});

// ─── Interview Flow ──────────────────────────────────────────────────────────

describe("InterviewGenerator - Question Generation", () => {
    test("generates questions for ambiguous clusters", async () => {
        const tracer = new ImportTracer();
        const graph = await tracer.trace(testRoot);
        const engine = new ClusterEngine();
        const proposals = engine.analyze(graph);
        const interviewer = new InterviewGenerator();
        const questions = interviewer.generate(proposals);

        expect(questions.length).toBeGreaterThan(0);
        // Combined apertures should trigger a merge/split question
        const mergeQ = questions.find(q => q.type === "binary" && q.heading.toLowerCase().includes("merge"));
        expect(mergeQ).toBeDefined();
    });

    test("answering Yes to merge updates aperture map correctly", () => {
        const interviewer = new InterviewGenerator();
        const map: ApertureMap = {
            apertures: [
                { id: "auth", claims: ["fs:src/auth"] },
                { id: "db", claims: ["fs:src/db"] },
            ],
        };

        const question: CoreQuestion = {
            id: "merge-auth-db",
            type: "binary",
            heading: "Merge auth and db?",
            body: "These modules have a circular dependency.",
            suggestedAction: "merge",
            targetIds: ["auth", "db"],
        };

        const updated = interviewer.applyAnswer(map, question, "yes");

        // After merge: one combined aperture replaces two
        expect(updated.apertures.length).toBe(1);
        expect(updated.apertures[0].claims).toContain("fs:src/auth");
        expect(updated.apertures[0].claims).toContain("fs:src/db");
    });

    test("answering No preserves the existing map", () => {
        const interviewer = new InterviewGenerator();
        const map: ApertureMap = {
            apertures: [
                { id: "auth", claims: ["fs:src/auth"] },
                { id: "db", claims: ["fs:src/db"] },
            ],
        };

        const question: CoreQuestion = {
            id: "merge-auth-db",
            type: "binary",
            heading: "Merge auth and db?",
            body: "Circular dependency detected.",
            suggestedAction: "merge",
            targetIds: ["auth", "db"],
        };

        const updated = interviewer.applyAnswer(map, question, "no");

        expect(updated.apertures.length).toBe(2);
    });
});
