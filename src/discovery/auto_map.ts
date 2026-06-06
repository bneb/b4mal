// B4mal v3.1.0 — Cluster Engine (Auto-Map)
//
// Analyzes a DependencyGraph to produce ApertureProposals.
// Detects circular dependencies (→ combined apertures),
// orphans (→ pruning candidates), and cohesive clusters.

import * as path from "path";
import type { DependencyGraph } from "./graph";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ApertureProposal {
    id: string;
    type: "isolated" | "combined" | "orphan";
    files: string[];
    claims: string[];
    reason: string;
    confidence: number; // 0-1, how certain we are about this grouping
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export class ClusterEngine {
    /**
     * Analyze a dependency graph and produce aperture proposals.
     */
    analyze(graph: DependencyGraph): ApertureProposal[] {
        const proposals: ApertureProposal[] = [];

        // 1. Detect circular dependencies → Combined Apertures
        const cycles = this.detectCycles(graph);
        const cycleMembers = new Set<string>();

        for (const cycle of cycles) {
            for (const node of cycle) cycleMembers.add(node);

            const dirs = this.uniqueDirectories(cycle);
            proposals.push({
                id: `combined-${dirs.join("-")}`,
                type: "combined",
                files: [...cycle],
                claims: dirs.map(d => `fs:${d}`),
                reason: `Circular dependency detected: ${cycle.map(f => path.basename(f)).join(" → ")} → ${path.basename(cycle[0])}`,
                confidence: 0.6,
            });
        }

        // 2. Detect orphans → Pruning Candidates
        for (const orphan of graph.orphans) {
            if (cycleMembers.has(orphan)) continue;

            proposals.push({
                id: `orphan-${path.basename(orphan, path.extname(orphan))}`,
                type: "orphan",
                files: [orphan],
                claims: [`fs:${orphan}`],
                reason: `File has zero imports and zero importers — candidate for pruning or data root.`,
                confidence: 0.8,
            });
        }

        // 3. Detect isolated clusters (files with unidirectional deps, no cycles)
        const clustered = new Set<string>([...cycleMembers, ...graph.orphans]);
        const dirGroups = this.groupByDirectory(
            graph.nodes.filter(n => !clustered.has(n))
        );

        for (const [dir, files] of Object.entries(dirGroups)) {
            proposals.push({
                id: `isolated-${dir.replace(/\//g, "-")}`,
                type: "isolated",
                files,
                claims: [`fs:${dir}`],
                reason: `Cohesive directory cluster with unidirectional dependencies.`,
                confidence: 0.9,
            });
        }

        return proposals;
    }

    // ── Cycle Detection (Tarjan's SCC) ───────────────────────────────────

    private detectCycles(graph: DependencyGraph): string[][] {
        const adjacency = new Map<string, string[]>();
        for (const node of graph.nodes) adjacency.set(node, []);
        for (const edge of graph.edges) {
            adjacency.get(edge.source)?.push(edge.target);
        }

        let index = 0;
        const stack: string[] = [];
        const onStack = new Set<string>();
        const indices = new Map<string, number>();
        const lowlinks = new Map<string, number>();
        const sccs: string[][] = [];

        const strongConnect = (v: string) => {
            indices.set(v, index);
            lowlinks.set(v, index);
            index++;
            stack.push(v);
            onStack.add(v);

            for (const w of adjacency.get(v) ?? []) {
                if (!indices.has(w)) {
                    strongConnect(w);
                    lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
                } else if (onStack.has(w)) {
                    lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
                }
            }

            if (lowlinks.get(v) === indices.get(v)) {
                const scc: string[] = [];
                let w: string;
                do {
                    w = stack.pop()!;
                    onStack.delete(w);
                    scc.push(w);
                } while (w !== v);

                // Only report SCCs with >= 2 nodes (actual cycles)
                if (scc.length >= 2) {
                    sccs.push(scc);
                }
            }
        };

        for (const node of graph.nodes) {
            if (!indices.has(node)) strongConnect(node);
        }

        return sccs;
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    private uniqueDirectories(files: string[]): string[] {
        const dirs = new Set(files.map(f => path.dirname(f)));
        return [...dirs].sort();
    }

    private groupByDirectory(files: string[]): Record<string, string[]> {
        const groups: Record<string, string[]> = {};
        for (const file of files) {
            const dir = path.dirname(file);
            if (!groups[dir]) groups[dir] = [];
            groups[dir].push(file);
        }
        return groups;
    }
}
