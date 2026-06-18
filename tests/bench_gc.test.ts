import { describe, test, expect } from "bun:test";

describe("Bun GC Latency Benchmark", () => {
    test("GC pause under heavy object allocation load", async () => {
        let maxDrift = 0;
        let lastTime = performance.now();
        const interval = 5;

        // Start a high-resolution timer to detect Event Loop lags (GC pauses)
        const timer = setInterval(() => {
            const now = performance.now();
            const drift = now - lastTime - interval;
            if (drift > maxDrift) maxDrift = drift;
            lastTime = now;
        }, interval);

        // Simulate creating a massive 50,000 node DAG (mimicking heavy memory alloc)
        const nodes: any[] = [];
        for (let i = 0; i < 50000; i++) {
            nodes.push({
                id: `task-${i}`,
                cmd: ["echo", `hello ${i}`],
                claims: [`fs:src/lib/${i}.ts`],
                deps: i > 0 ? [`task-${i - 1}`] : [],
                metadata: {
                    createdAt: new Date(),
                    complexObject: { a: i, b: i * 2, c: Array(100).fill(i) }
                }
            });
        }

        // Simulate topological sort and memory traversal with yielding
        let sum = 0;
        for (let i = 0; i < 100; i++) {
            const localNodes = nodes.map(n => ({ ...n, id: n.id + "-clone" }));
            for (const n of localNodes) {
                sum += n.metadata.complexObject.a;
            }
            // Yield to the event loop so timer can tick (measures GC, not synchronous compute block)
            await new Promise(r => setTimeout(r, 0));
        }

        // Allow any pending microtasks and GC to settle
        await new Promise(r => setTimeout(r, 50));
        clearInterval(timer);



        // The threshold is 200ms. On heavily loaded systems (CI, parallel tests),
        // GC pause drift can spike. This test is a canary, not a correctness gate.
        expect(maxDrift).toBeLessThan(200); 
    }, 10000);
});
