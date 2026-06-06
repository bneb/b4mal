import { describe, test, expect } from "bun:test";
import { MintEmitter } from "../src/shim/mint_emitter";
import { WavePlanner, type OrchestratorTask } from "../src/orchestrator/planner";

describe("MintEmitter", () => {
    test("compiles a DAGPlan into RWX Mint YAML", () => {
        const tasks: OrchestratorTask[] = [
            { id: "build", cmd: ["npm", "run", "build"], claims: ["fs:dist/"], deps: [] },
            { id: "test", cmd: ["npm", "test"], claims: ["fs:src/"], deps: ["build"] },
        ];
        
        const dag = WavePlanner.planDAG(tasks);
        const yaml = MintEmitter.emit(dag);
        
        expect(yaml).toContain("tasks:");
        expect(yaml).toContain("- key: build");
        expect(yaml).toContain("run: npm run build");
        expect(yaml).toContain("- key: test");
        expect(yaml).toContain("run: npm test");
        expect(yaml).toContain("after:");
        expect(yaml).toContain("- build");
    });

    test("handles complex composite commands properly", () => {
        const tasks: OrchestratorTask[] = [
            { id: "complex", cmd: ["sh", "-c", "echo 'hi' && echo 'bye'"], claims: [], deps: [] },
            { id: "simple", cmd: ["echo", "simple"], claims: [], deps: [] },
        ];
        const dag = WavePlanner.planDAG(tasks);
        const yaml = MintEmitter.emit(dag);

        // Should unwrap sh -c if possible, or just emit it
        expect(yaml).toContain("run: echo 'hi' && echo 'bye'");
        expect(yaml).toContain("run: echo simple");
    });
});
