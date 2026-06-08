import { ResourcePrefixTree } from "./src/formal/prefix_tree";
const tree = new ResourcePrefixTree();
const deepPath = "fs:" + Array(20000).fill("a").join("/") + "/";
tree.insert(deepPath, "taskA", "write");
try {
    const conflicts = tree.findConflicts("fs:a/", "taskB", "read");
    console.log("Success! size: " + conflicts.size);
} catch (e) {
    console.error("Crash: " + e);
}
