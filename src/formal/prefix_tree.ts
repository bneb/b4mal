import * as path from "path";

export class ResourcePrefixTree {
    private children = new Map<string, ResourcePrefixTree>();
    private exactReaders = new Set<string>();
    private exactWriters = new Set<string>();
    private dirReaders = new Set<string>();
    private dirWriters = new Set<string>();

    private normalizeClaim(claim: string): { cleanClaim: string, isDir: boolean } {
        const isDir = claim.endsWith("/");
        let cleanClaim = isDir ? claim.slice(0, -1) : claim;
        
        if (cleanClaim.startsWith("fs:")) {
            cleanClaim = "fs:" + path.posix.normalize(cleanClaim.slice(3));
        }
        
        // Remove trailing slash if path.posix.normalize introduced it (e.g., "." or "/")
        if (cleanClaim.endsWith("/") && cleanClaim !== "fs:/") {
            cleanClaim = cleanClaim.slice(0, -1);
        }
        
        return { cleanClaim, isDir };
    }

    insert(claim: string, taskId: string, type: "read" | "write") {
        const { cleanClaim, isDir } = this.normalizeClaim(claim);
        const parts = cleanClaim.split("/");
        
        let current: ResourcePrefixTree = this;
        for (const part of parts) {
            let next = current.children.get(part);
            if (!next) {
                next = new ResourcePrefixTree();
                current.children.set(part, next);
            }
            current = next;
        }
        
        if (isDir) {
            if (type === "read") current.dirReaders.add(taskId);
            else current.dirWriters.add(taskId);
        } else {
            if (type === "read") current.exactReaders.add(taskId);
            else current.exactWriters.add(taskId);
        }
    }

    findConflicts(claim: string, taskId: string, type: "read" | "write"): Set<string> {
        const { cleanClaim, isDir } = this.normalizeClaim(claim);
        const parts = cleanClaim.split("/");
        
        let current: ResourcePrefixTree = this;
        const conflicts = new Set<string>();

        for (const part of parts) {
            // Any dir write along the path conflicts with BOTH read and write
            for (const id of current.dirWriters) conflicts.add(id);
            // If WE are writing, any dir read along the path conflicts with us
            if (type === "write") {
                for (const id of current.dirReaders) conflicts.add(id);
            }
            
            const next = current.children.get(part);
            if (!next) {
                conflicts.delete(taskId);
                return conflicts;
            }
            current = next;
        }

        // Reached the exact node.
        for (const id of current.exactWriters) conflicts.add(id);
        for (const id of current.dirWriters) conflicts.add(id);
        if (type === "write") {
            for (const id of current.exactReaders) conflicts.add(id);
            for (const id of current.dirReaders) conflicts.add(id);
        }

        // If OUR claim is a directory, it conflicts with ALL deeper claims
        if (isDir) {
            this.collectConflicts(current, type, conflicts);
        }

        conflicts.delete(taskId);
        return conflicts;
    }

    private collectConflicts(node: ResourcePrefixTree, ourType: "read" | "write", out: Set<string>) {
        for (const id of node.exactWriters) out.add(id);
        for (const id of node.dirWriters) out.add(id);
        if (ourType === "write") {
            for (const id of node.exactReaders) out.add(id);
            for (const id of node.dirReaders) out.add(id);
        }
        for (const child of node.children.values()) {
            this.collectConflicts(child, ourType, out);
        }
    }
}
