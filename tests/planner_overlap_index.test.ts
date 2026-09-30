/**
 * Tests: the planner's overlap index is both FAST and IDENTICAL to a linear scan.
 *
 * The scheduler used to compare every task against every previously-accepted task
 * (O(n^2)). It now uses ResourcePrefixTree to find only the conflicting ones. This
 * file pins both properties, because the second is the one that matters: a faster
 * scheduler that injects different dependencies would silently break the isolation
 * guarantee the product is built on.
 *
 * `referenceOverlap` below is the original algorithm, transcribed. Every case is
 * asserted to produce the same serialized dependencies.
 */
import { describe, test, expect } from "bun:test";
import { WavePlanner } from "../src/orchestrator/planner";
import { ResourcePrefixTree } from "../src/formal/prefix_tree";
import type { OrchestratorTask } from "../src/orchestrator/planner";
import * as path from "path";
import * as os from "os";

// ── The original overlap test, verbatim ─────────────────────────────────────
function claimsOverlap(claimA: string, claimB: string): boolean {
    const isCaseInsensitive = os.platform() === "win32" || os.platform() === "darwin";
    let a = isCaseInsensitive ? claimA.toLowerCase() : claimA;
    let b = isCaseInsensitive ? claimB.toLowerCase() : claimB;
    const aProtoMatch = a.match(/^([a-z0-9]{2,}):(.*)$/i);
    const bProtoMatch = b.match(/^([a-z0-9]{2,}):(.*)$/i);
    const aProto = aProtoMatch ? aProtoMatch[1].toLowerCase() : "fs";
    const bProto = bProtoMatch ? bProtoMatch[1].toLowerCase() : "fs";
    if (aProto !== bProto) return false;
    const aPath = aProtoMatch ? aProtoMatch[2] : a;
    const bPath = bProtoMatch ? bProtoMatch[2] : b;
    if (aProto === "fs") {
        const absA = path.resolve("/", aPath);
        const absB = path.resolve("/", bPath);
        if (absA === absB) return true;
        const prefixA = absA.endsWith(path.sep) ? absA : absA + path.sep;
        const prefixB = absB.endsWith(path.sep) ? absB : absB + path.sep;
        return absB.startsWith(prefixA) || absA.startsWith(prefixB);
    }
    return aPath === bPath;
}

/** Reproduce planDAG's accessMap normalisation. */
function accessOf(t: any): { reads: string[]; writes: string[] } {
    const reads = new Set<string>();
    const writes = new Set<string>();
    if (t.reads) t.reads.forEach((r: string) => reads.add(path.normalize(r.replace(/^fs:/, ""))));
    if (t.writes) t.writes.forEach((w: string) => writes.add(path.normalize(w.replace(/^fs:/, ""))));
    if (t.claims) {
        t.claims.forEach((c: string) => {
            if (c.startsWith("fs:")) {
                const p = path.normalize(c.slice(3));
                reads.add(p);
                writes.add(p);
            } else {
                writes.add(c);
            }
        });
    }
    return { reads: Array.from(reads), writes: Array.from(writes) };
}

/**
 * The original O(n^2) edge-injection, run standalone over an ordered task list.
 * Returns the set of (prev -> curr) dependency edges it would have injected.
 */
function referenceEdges(ordered: any[]): Set<string> {
    const edges = new Set<string>();
    const accessors: { id: string; reads: string[]; writes: string[] }[] = [];
    for (const t of ordered) {
        const a = accessOf(t);
        for (const prev of accessors) {
            let overlaps = false;
            for (const claimA of a.reads) {
                for (const claimB of prev.writes) if (claimsOverlap(claimA, claimB)) { overlaps = true; break; }
                if (overlaps) break;
            }
            if (!overlaps) {
                for (const claimA of a.writes) {
                    for (const claimB of prev.reads) if (claimsOverlap(claimA, claimB)) { overlaps = true; break; }
                    if (overlaps) break;
                    for (const claimB of prev.writes) if (claimsOverlap(claimA, claimB)) { overlaps = true; break; }
                    if (overlaps) break;
                }
            }
            if (overlaps) edges.add(`${prev.id}->${t.id}`);
        }
        accessors.push({ id: t.id, reads: a.reads, writes: a.writes });
    }
    return edges;
}

/** Serialize the plan's synthetic edges (ignoring the declared deps). */
function plannedEdges(tasks: OrchestratorTask[]): Set<string> {
    const declared = new Map<string, string[]>();
    for (const t of tasks) declared.set(t.id, t.deps ?? []);
    const dag = WavePlanner.planDAG(tasks);
    const edges = new Set<string>();
    for (const [id, deps] of dag.dependents) {
        for (const dep of deps) {
            // A declared dependency is not synthetic; skip those.
            if ((declared.get(id) ?? []).includes(dep)) continue;
            edges.add(`${id}->${dep}`);
        }
    }
    return edges;
}

// ── Differential fixtures ───────────────────────────────────────────────────

const cases: [string, any[]][] = [
    ["write/write same file", [
        { id: "a", cmd: ["true"], deps: [], reads: [], writes: ["dist/x"], claims: [] },
        { id: "b", cmd: ["true"], deps: [], reads: [], writes: ["dist/x"], claims: [] },
    ]],
    ["read after write (should serialize)", [
        { id: "w", cmd: ["true"], deps: [], reads: [], writes: ["src/x"], claims: [] },
        { id: "r", cmd: ["true"], deps: [], reads: ["src/x"], writes: [], claims: [] },
    ]],
    ["write after read", [
        { id: "r", cmd: ["true"], deps: [], reads: ["src/x"], writes: [], claims: [] },
        { id: "w", cmd: ["true"], deps: [], reads: [], writes: ["src/x"], claims: [] },
    ]],
    ["directory claim vs file", [
        { id: "d", cmd: ["true"], deps: [], reads: [], writes: [], claims: ["fs:src/db/"] },
        { id: "f", cmd: ["true"], deps: [], reads: [], writes: ["src/db/file.ts"], claims: [] },
    ]],
    ["non-fs exact match (db)", [
        { id: "a", cmd: ["true"], deps: [], reads: [], writes: [], claims: ["db:primary"] },
        { id: "b", cmd: ["true"], deps: [], reads: [], writes: [], claims: ["db:primary"] },
    ]],
    ["non-fs near-miss must NOT conflict", [
        { id: "a", cmd: ["true"], deps: [], reads: [], writes: [], claims: ["env:PORT"] },
        { id: "b", cmd: ["true"], deps: [], reads: [], writes: [], claims: ["env:PORTSET"] },
    ]],
    ["different protocols must NOT conflict", [
        { id: "a", cmd: ["true"], deps: [], reads: [], writes: [], claims: ["db:shared"] },
        { id: "b", cmd: ["true"], deps: [], reads: [], writes: [], claims: ["env:shared"] },
    ]],
    ["sibling directories must NOT conflict", [
        { id: "a", cmd: ["true"], deps: [], reads: [], writes: ["src/db"], claims: [] },
        { id: "b", cmd: ["true"], deps: [], reads: [], writes: ["src/db_backup"], claims: [] },
    ]],
    ["independent tasks produce no edges", [
        { id: "a", cmd: ["true"], deps: [], reads: ["a"], writes: ["a-out"], claims: [] },
        { id: "b", cmd: ["true"], deps: [], reads: ["b"], writes: ["b-out"], claims: [] },
    ]],
    ["transitive chain of overlaps", [
        { id: "a", cmd: ["true"], deps: [], reads: [], writes: ["x"], claims: [] },
        { id: "b", cmd: ["true"], deps: [], reads: [], writes: ["x"], claims: [] },
        { id: "c", cmd: ["true"], deps: [], reads: [], writes: ["x"], claims: [] },
    ]],
    ["declared dependency is not re-injected", [
        { id: "a", cmd: ["true"], deps: [], reads: [], writes: ["x"], claims: [] },
        { id: "b", cmd: ["true"], deps: ["a"], reads: [], writes: ["x"], claims: [] },
    ]],
    ["mixed reads, writes and claims", [
        { id: "a", cmd: ["true"], deps: [], reads: ["src/1"], writes: [], claims: ["env:A"] },
        { id: "b", cmd: ["true"], deps: [], reads: [], writes: ["src/1"], claims: [] },
        { id: "c", cmd: ["true"], deps: [], reads: [], writes: [], claims: ["db:2"] },
    ]],
];

describe("planner overlap index — differential vs the original scan", () => {
    for (const [label, tasks] of cases) {
        test(label, () => {
            const expected = referenceEdges(tasks);
            const actual = plannedEdges(tasks as OrchestratorTask[]);
            expect([...actual].sort()).toEqual([...expected].sort());
        });
    }
});

describe("planner overlap index — performance", () => {
    /**
     * The planner used to compare every task against every previously-accepted
     * task. On the Crucible's own benchmark shape (10 chains × N/10 tasks that all
     * write `src/<c>/`) that cost 6,024 ms at 2,000 tasks and doubled the input
     * multiplied the time by ~5, putting 100,000 tasks hours away.
     *
     * Indexing the accepted tasks brings that down and, more importantly, makes
     * realistically-shaped graphs (each package owning its own output) linear.
     */
    test("a disjoint graph of 20,000 tasks plans linearly", () => {
        const build = (n: number) => {
            const tasks: OrchestratorTask[] = [];
            const chains = 10, per = n / chains;
            for (let c = 0; c < chains; c++)
                for (let k = 0; k < per; k++)
                    tasks.push({
                        id: `c${c}-t${k}`, cmd: ["true"],
                        reads: [`pkg${c}/${k}/src`], writes: [`pkg${c}/${k}/dist`],
                        deps: k > 0 ? [`c${c}-t${k - 1}`] : [],
                    } as OrchestratorTask);
            return tasks;
        };

        const start = performance.now();
        const dag = WavePlanner.planDAG(build(20_000));
        const ms = performance.now() - start;

        expect(dag.tasks.size).toBe(20_000);
        // Linear scaling puts this near 450ms; the ceiling catches an O(n^2)
        // regression without asserting a specific speed.
        expect(ms).toBeLessThan(5000);
    });

    test("time grows sub-quadratically with task count", () => {
        const build = (n: number) => {
            const tasks: OrchestratorTask[] = [];
            const chains = 10, per = n / chains;
            for (let c = 0; c < chains; c++)
                for (let k = 0; k < per; k++)
                    tasks.push({
                        id: `c${c}-t${k}`, cmd: ["true"],
                        reads: [`pkg${c}/${k}/src`], writes: [`pkg${c}/${k}/dist`],
                        deps: k > 0 ? [`c${c}-t${k - 1}`] : [],
                    } as OrchestratorTask);
            return tasks;
        };
        const time = (n: number) => {
            const t0 = performance.now();
            WavePlanner.planDAG(build(n));
            return performance.now() - t0;
        };
        const small = time(2_000);
        const large = time(8_000);   // 4x the work
        // Linear ≈ 4x, quadratic ≈ 16x. Generous headroom for warm-up, still
        // fails loudly on a return to quadratic.
        expect(large).toBeLessThan(Math.max(small * 10, 400));
    });

    /**
     * Documents the remaining cost honestly rather than pretending it away.
     *
     * When many tasks write the SAME resource they genuinely must be serialized,
     * so the injected dependency graph has O(k^2) edges for k such tasks. That is
     * the isolation guarantee being correct, not a defect — but it is a real
     * scalability cliff, and it is why the old benchmark's 100,000-task figure was
     * not achievable on a graph shaped like that one.
     */
    test("fully-overlapping tasks are serialized pairwise — quadratic by necessity", () => {
        const n = 1_000;
        const tasks: OrchestratorTask[] = [];
        for (let i = 0; i < n; i++) {
            tasks.push({
                id: `t${i}`, cmd: ["true"],
                reads: [], writes: ["shared/out"],
                deps: [], claims: [],
            } as unknown as OrchestratorTask);
        }

        const dag = WavePlanner.planDAG(tasks);
        let edges = 0;
        for (const [, dependents] of dag.dependents) edges += dependents.length;

        // Every task writes the same file, so every pair must be ordered.
        expect(edges).toBe((n * (n - 1)) / 2);
        // And the plan is a total order: no two tasks can run concurrently.
        expect(dag.inDegree.get("t0")).toBe(0);
    });
});
