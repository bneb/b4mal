import { describe, test, expect } from "bun:test";
import { ResourcePrefixTree } from "../src/formal/prefix_tree";

describe("Resource Prefix Tree", () => {
    test("detects overlap between two exact files", () => {
        const tree = new ResourcePrefixTree();
        tree.insert("fs:src/index.ts", "task-1", "write");
        
        const overlaps = tree.findConflicts("fs:src/index.ts", "task-search", "write");
        expect(overlaps.has("task-1")).toBe(true);
    });

    test("does not overlap disjoint files in the same directory", () => {
        const tree = new ResourcePrefixTree();
        tree.insert("fs:src/foo.ts", "task-1", "write");
        
        const overlaps = tree.findConflicts("fs:src/bar.ts", "task-search", "write");
        expect(overlaps.has("task-1")).toBe(false);
    });

    test("directory claim overlaps with specific file inside it", () => {
        const tree = new ResourcePrefixTree();
        tree.insert("fs:src/", "task-dir", "write");
        
        const overlaps = tree.findConflicts("fs:src/foo.ts", "task-search", "write");
        expect(overlaps.has("task-dir")).toBe(true);
    });

    test("specific file claim overlaps with directory query covering it", () => {
        const tree = new ResourcePrefixTree();
        tree.insert("fs:src/foo.ts", "task-file", "write");
        
        const overlaps = tree.findConflicts("fs:src/", "task-search", "write");
        expect(overlaps.has("task-file")).toBe(true);
    });

    test("directory query overlaps with another directory claim", () => {
        const tree = new ResourcePrefixTree();
        tree.insert("fs:src/", "task-dir-1", "write");
        
        const overlaps = tree.findConflicts("fs:src/", "task-search", "write");
        expect(overlaps.has("task-dir-1")).toBe(true);
    });

    test("nested directory queries", () => {
        const tree = new ResourcePrefixTree();
        tree.insert("fs:src/components/", "task-nested", "write");
        
        const parentOverlaps = tree.findConflicts("fs:src/", "task-search", "write");
        expect(parentOverlaps.has("task-nested")).toBe(true);

        const siblingOverlaps = tree.findConflicts("fs:src/utils/", "task-search", "write");
        expect(siblingOverlaps.has("task-nested")).toBe(false);
    });

    test("path traversal evasion is normalized", () => {
        const tree = new ResourcePrefixTree();
        tree.insert("fs:src/build/", "task-build", "write");
        
        // This should normalize to fs:src/build/
        const traversalOverlaps = tree.findConflicts("fs:src/../src/build/out.ts", "task-search", "write");
        expect(traversalOverlaps.has("task-build")).toBe(true);

        // Reverse test: insert un-normalized, query normalized
        const tree2 = new ResourcePrefixTree();
        tree2.insert("fs:src/../src/build/out.ts", "task-traversal", "write");
        const overlaps2 = tree2.findConflicts("fs:src/build/", "task-search", "write");
        expect(overlaps2.has("task-traversal")).toBe(true);
    });
});
