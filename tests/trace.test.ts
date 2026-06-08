import { describe, test, expect } from "bun:test";
import { EventAggregator } from "../src/trace/aggregator";
import { GraphSynthesizer } from "../src/trace/synthesizer";
import type { TraceEvent } from "../src/trace/types";

describe("Autonomous eBPF Dependency Synthesis", () => {
    test("EventAggregator > maps reads and writes to proper relative paths", () => {
        const aggregator = new EventAggregator("/app");
        aggregator.processEvent({ type: "exec", pid: 100, cmd: ["tsc"] });
        
        // Relative open
        aggregator.processEvent({ type: "open", pid: 100, path: "src/index.ts", mode: "r" });
        // Absolute open outside project (ignored)
        aggregator.processEvent({ type: "open", pid: 100, path: "/usr/lib/libc.so", mode: "r" });
        // Absolute open inside project
        aggregator.processEvent({ type: "open", pid: 100, path: "/app/dist/index.js", mode: "w" });
        
        const nodes = aggregator.getNodes();
        expect(nodes.length).toBe(1);
        expect(nodes[0].read_claims.has("src/index.ts")).toBe(true);
        expect(nodes[0].write_claims.has("dist/index.js")).toBe(true);
    });

    test("EventAggregator > filters out noise directories", () => {
        const aggregator = new EventAggregator("/app");
        aggregator.processEvent({ type: "exec", pid: 200, cmd: ["npm", "install"] });
        
        aggregator.processEvent({ type: "open", pid: 200, path: "/app/.git/HEAD", mode: "r" });
        aggregator.processEvent({ type: "open", pid: 200, path: "/app/node_modules/.cache/terser", mode: "w" });
        
        const nodes = aggregator.getNodes();
        expect(nodes.length).toBe(1);
        expect(nodes[0].read_claims.size).toBe(0);
        expect(nodes[0].write_claims.size).toBe(0);
    });

    test("GraphSynthesizer > maps read-after-write to dependencies", () => {
        const aggregator = new EventAggregator("/app");
        // Task A: compiles src -> dist
        aggregator.processEvent({ type: "exec", pid: 10, cmd: ["tsc"] });
        aggregator.processEvent({ type: "open", pid: 10, path: "src/main.ts", mode: "r" });
        aggregator.processEvent({ type: "open", pid: 10, path: "dist/main.js", mode: "w" });
        
        // Task B: bundles dist -> bundle.js
        aggregator.processEvent({ type: "exec", pid: 20, cmd: ["esbuild"] });
        aggregator.processEvent({ type: "open", pid: 20, path: "dist/main.js", mode: "r" });
        aggregator.processEvent({ type: "open", pid: 20, path: "out/bundle.js", mode: "w" });
        
        // Task C: independent test
        aggregator.processEvent({ type: "exec", pid: 30, cmd: ["test"] });
        aggregator.processEvent({ type: "open", pid: 30, path: "src/test.ts", mode: "r" });
        
        const nodes = aggregator.getNodes();
        const synthesizer = new GraphSynthesizer();
        const pipeline = synthesizer.synthesize(nodes, "build_all");
        
        expect(pipeline.tasks.length).toBe(3);
        
        const tscTask = pipeline.tasks.find(t => t.id.startsWith("tsc"));
        const esbuildTask = pipeline.tasks.find(t => t.id.startsWith("esbuild"));
        const testTask = pipeline.tasks.find(t => t.id.startsWith("test"));
        
        expect(tscTask).toBeDefined();
        expect(esbuildTask).toBeDefined();
        expect(testTask).toBeDefined();
        
        // esbuild reads dist/main.js which tsc wrote
        expect(esbuildTask!.dependencies).toContain(tscTask!.id);
        
        // test is independent
        expect(testTask!.dependencies.length).toBe(0);
        
        // verify claims
        expect((tscTask as any)!.claims).toContain("fs:write:dist/main.js");
        expect((esbuildTask as any)!.claims).toContain("fs:read:dist/main.js");
    });
});
