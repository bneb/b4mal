import type { Pipeline, Task } from "../schema";
import type { TaskNode } from "./aggregator";

export interface SynthesizedTask extends Task {
    claims: string[];
}

export class GraphSynthesizer {
    public synthesize(nodes: TaskNode[], rootCmd: string): Pipeline & { tasks: SynthesizedTask[] } {
        // 1. Build tree
        const childrenMap = new Map<number, TaskNode[]>();
        for (const n of nodes) {
            if (!childrenMap.has(n.ppid)) childrenMap.set(n.ppid, []);
            childrenMap.get(n.ppid)!.push(n);
        }

        // 2. Identify clustered nodes (leaves of linear chains)
        const clusteredNodes: TaskNode[] = [];
        const processNode = (node: TaskNode, inheritedReads: Set<string>, inheritedWrites: Set<string>) => {
            const currentReads = new Set([...inheritedReads, ...node.read_claims]);
            const currentWrites = new Set([...inheritedWrites, ...node.write_claims]);
            
            const children = childrenMap.get(node.pid) || [];
            
            if (children.length === 0) {
                // Leaf node
                node.read_claims = currentReads;
                node.write_claims = currentWrites;
                clusteredNodes.push(node);
            } else if (children.length === 1) {
                // Linear chain: push claims down
                processNode(children[0], currentReads, currentWrites);
            } else {
                // Diverging branch: parent distributes claims to all children
                for (const child of children) {
                    processNode(child, currentReads, currentWrites);
                }
            }
        };

        // Find roots (nodes whose ppid is not in nodes)
        const nodePids = new Set(nodes.map(n => n.pid));
        const roots = nodes.filter(n => !nodePids.has(n.ppid));
        for (const root of roots) {
            processNode(root, new Set(), new Set());
        }

        // Filter active clustered nodes
        const activeNodes = clusteredNodes.filter(n => n.read_claims.size > 0 || n.write_claims.size > 0);
        
        // Find dependencies
        // A depends on B if A reads a file that B wrote.
        // We assume nodes are ordered chronologically by execution.
        const tasks: SynthesizedTask[] = [];
        let counter = 1;

        // Heuristic: collapse massive claims into directory prefixes
        const collapseClaims = (claims: Set<string>): Set<string> => {
            const dirCounts = new Map<string, number>();
            for (const c of claims) {
                const dir = c.includes("/") ? c.split("/").slice(0, -1).join("/") + "/" : "";
                if (dir) dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
            }
            const result = new Set<string>();
            for (const c of claims) {
                const dir = c.includes("/") ? c.split("/").slice(0, -1).join("/") + "/" : "";
                if (dir && (dirCounts.get(dir) || 0) > 5) {
                    result.add(dir);
                } else {
                    result.add(c);
                }
            }
            return result;
        };

        for (const node of activeNodes) {
            // Simplify command for ID
            const cmdName = node.cmd[0] ? node.cmd[0].split("/").pop() : "unknown";
            const id = `${cmdName}_${counter++}`;
            
            const task: SynthesizedTask = {
                id,
                cmd: node.cmd,
                claims: [],
                dependencies: [],
                env: {},
                timeout: 0
            };

            // Add claims with heuristic collapsing
            for (const r of collapseClaims(node.read_claims)) {
                task.claims.push(`fs:read:${r}`);
            }
            for (const w of collapseClaims(node.write_claims)) {
                task.claims.push(`fs:write:${w}`);
            }

            // Find dependencies: check all previously defined activeNodes
            // Actually, we need to map our activeNodes back to tasks.
            // Let's do a direct approach:
            tasks.push(task);
        }

        // Now calculate dependencies
        for (let i = 0; i < tasks.length; i++) {
            const taskB = tasks[i];
            const readsB = new Set(activeNodes[i].read_claims);

            for (let j = 0; j < i; j++) {
                const taskA = tasks[j];
                const writesA = new Set(activeNodes[j].write_claims);
                
                // If intersection > 0
                for (const read of readsB) {
                    if (writesA.has(read)) {
                        if (!taskB.dependencies.includes(taskA.id)) {
                            taskB.dependencies.push(taskA.id);
                        }
                    }
                }
            }
        }

        return {
            name: "Synthesized Pipeline",
            tasks,
            env: {},
            concurrency: 0
        };
    }
}
