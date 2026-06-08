import type { TraceEvent } from "./types";
import { resolve, isAbsolute, join } from "path";

export interface TaskNode {
    id: string;
    pid: number;
    ppid: number;
    cmd: string[];
    read_claims: Set<string>;
    write_claims: Set<string>;
    cwd: string;
}

export class EventAggregator {
    public nodes: Map<number, TaskNode> = new Map();
    private projectRoot: string;

    constructor(projectRoot: string = process.cwd()) {
        this.projectRoot = resolve(projectRoot);
    }

    public processEvent(event: TraceEvent) {
        if (event.type === "exec") {
            this.nodes.set(event.pid, {
                id: `task_${event.pid}`,
                pid: event.pid,
                ppid: event.ppid || 0,
                cmd: event.cmd || [],
                read_claims: new Set(),
                write_claims: new Set(),
                cwd: event.cwd || this.projectRoot,
            });
        } else if (event.type === "chdir" && event.path) {
            const node = this.nodes.get(event.pid);
            if (!node) return;
            node.cwd = isAbsolute(event.path) ? event.path : resolve(node.cwd, event.path);
        } else if (event.type === "open" && event.path) {
            const node = this.nodes.get(event.pid);
            if (!node) return; // untracked process

            const absPath = isAbsolute(event.path) 
                ? event.path 
                : resolve(node.cwd, event.path);

            // Filter noise: must be inside projectRoot, not in /tmp or .git or node_modules/.cache
            if (!absPath.startsWith(this.projectRoot)) return;
            if (absPath.includes(".git/")) return;
            if (absPath.includes("node_modules/.cache/")) return;
            
            // Format to relative path from project root
            const relPath = absPath.slice(this.projectRoot.length).replace(/^\//, "");
            if (!relPath) return; // Root directory itself
            
            if (event.mode === "r") {
                node.read_claims.add(relPath);
            } else if (event.mode === "w" || event.mode === "rw") {
                node.write_claims.add(relPath);
            }
        }
    }

    public getNodes(): TaskNode[] {
        return Array.from(this.nodes.values());
    }
}
