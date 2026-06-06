// B4mal v4.0.0 — Import Graph Tracer (Tree-sitter AST)
//
// Builds a directed dependency graph by crawling source files and
// extracting imports via Tree-sitter AST parsing (not regex).
//
// The heavy lifting is done by ts_parser.cjs (Node subprocess)
// because web-tree-sitter WASM requires Node's SharedArrayBuffer.
// We batch all files into a single subprocess for performance.

import * as fs from "fs/promises";
import * as path from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DependencyEdge {
    source: string;
    target: string;
    type: "static" | "dynamic";
}

export interface DependencyGraph {
    nodes: string[];
    edges: DependencyEdge[];
    orphans: string[];
    root: string;
}

// ─── Extension → Language Map ────────────────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".rs": "rust",
};

const SOURCE_EXTENSIONS = new Set(Object.keys(EXT_TO_LANG));

// ─── Tracer ──────────────────────────────────────────────────────────────────

export class ImportTracer {
    private parserScript: string;

    constructor() {
        this.parserScript = path.join(
            path.dirname(new URL(import.meta.url).pathname),
            "ts_parser.cjs",
        );
    }

    /**
     * Returns the parser engine identifier.
     */
    getParserEngine(): string {
        return "tree-sitter";
    }

    /**
     * Deep-crawl a project directory and build a dependency graph.
     * Uses Tree-sitter AST parsing via a Node subprocess.
     */
    async trace(root: string): Promise<DependencyGraph> {
        const realRoot = await fs.realpath(root).catch(() => root);
        const sourceFiles = await this.walkDirectory(realRoot, realRoot);
        const nodes = sourceFiles.map(f => path.relative(realRoot, f));
        const nodeSet = new Set(nodes);
        const edges: DependencyEdge[] = [];
        const connected = new Set<string>();

        // Batch parse all files through the Tree-sitter bridge
        const parseResults = await this.batchParse(sourceFiles, realRoot);

        for (const result of parseResults) {
            const relSource = result.file;

            for (const imp of result.imports) {
                const absSource = path.resolve(realRoot, relSource);
                const resolved = this.resolveImport(imp.path, absSource, realRoot, nodeSet);
                if (resolved) {
                    edges.push({
                        source: relSource,
                        target: resolved,
                        type: imp.dynamic ? "dynamic" : "static",
                    });
                    connected.add(relSource);
                    connected.add(resolved);
                }
            }
        }

        const orphans = nodes.filter(n => !connected.has(n));

        return { nodes, edges, orphans, root: realRoot };
    }

    // ── Tree-sitter Bridge ───────────────────────────────────────────────

    private async batchParse(
        files: string[],
        root: string,
    ): Promise<{ file: string; imports: { path: string; dynamic: boolean }[] }[]> {
        const proc = Bun.spawn(["node", this.parserScript], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });

        // Feed all files as JSON lines
        for (const absPath of files) {
            const relPath = path.relative(root, absPath);
            const ext = path.extname(absPath);
            const lang = EXT_TO_LANG[ext] ?? "typescript";
            const content = await fs.readFile(absPath, "utf-8");

            const line = JSON.stringify({ file: relPath, content, lang }) + "\n";
            proc.stdin.write(line);
        }
        proc.stdin.end();

        const output = await new Response(proc.stdout).text();
        await proc.exited;

        return output
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(line => JSON.parse(line));
    }

    // ── Directory Walker ─────────────────────────────────────────────────

    private async walkDirectory(dir: string, root: string): Promise<string[]> {
        const results: string[] = [];
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            // RED TEAM MITIGATION: Enforce Chroot boundaries
            const real = await fs.realpath(fullPath).catch(() => null);
            if (!real || !real.startsWith(root)) continue;

            if (entry.isDirectory()) {
                if (["node_modules", ".git", "dist", "target", ".b4mal"].includes(entry.name)) continue;
                results.push(...await this.walkDirectory(fullPath, root));
            } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
                results.push(fullPath);
            }
        }

        return results;
    }

    // ── Import Resolution ────────────────────────────────────────────────

    private resolveImport(
        importPath: string,
        fromFile: string,
        root: string,
        knownNodes: Set<string>,
    ): string | null {
        // Only resolve relative imports
        if (!importPath.startsWith(".")) return null;

        const fromDir = path.dirname(fromFile);
        const resolvedAbs = path.resolve(fromDir, importPath);
        
        // RED TEAM MITIGATION: Prevent import traversal out of workspace
        if (!resolvedAbs.startsWith(root)) return null;

        const resolved = path.relative(root, resolvedAbs);

        if (knownNodes.has(resolved)) return resolved;

        for (const ext of SOURCE_EXTENSIONS) {
            const withExt = resolved + ext;
            if (knownNodes.has(withExt)) return withExt;

            const indexFile = path.join(resolved, "index" + ext);
            if (knownNodes.has(indexFile)) return indexFile;
        }

        return null;
    }
}
