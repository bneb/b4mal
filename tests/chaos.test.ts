import { describe, test, expect } from "bun:test";
import { DynamicExecutor } from "../src/orchestrator/executor";
import type { DAGPlan } from "../src/orchestrator/planner";

describe("Build Chaos Engineering", () => {
    test("Chaos mode shuffles execution order of independent tasks", async () => {
        // Create 10 independent tasks
        const tasks = new Map();
        const inDegree = new Map();
        const dependents = new Map();

        for (let i = 0; i < 10; i++) {
            tasks.set(`t${i}`, {
                id: `t${i}`,
                cmd: ["echo", `${i}`],
                claims: [],
                writes: []
            });
            inDegree.set(`t${i}`, 0);
            dependents.set(`t${i}`, []);
        }

        const dag: DAGPlan = { tasks, inDegree, dependents, waves: [] };

        const runOnce = async (chaos: boolean) => {
            const results = await DynamicExecutor.run(dag, { projectRoot: "/tmp", concurrency: 1, chaos });
            return results.map(r => r.taskId).join(",");
        };

        const firstNoChaos = await runOnce(false);
        const secondNoChaos = await runOnce(false);
        expect(firstNoChaos).toBe(secondNoChaos);

        let changedOrder = false;
        for (let i = 0; i < 10; i++) {
            const chaosOrder = await runOnce(true);
            if (chaosOrder !== firstNoChaos) {
                changedOrder = true;
                break;
            }
        }
        
        expect(changedOrder).toBe(true);
    });
});
