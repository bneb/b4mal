import { describe, test, expect } from "bun:test";
import { spawn } from "child_process";
import * as path from "path";

describe("Language Server Protocol", () => {
    test("starts, accepts didChange, and returns diagnostics for collisions", async () => {
        const b4malPath = path.join(process.cwd(), "src", "cli", "index.ts");
        
        const child = spawn("bun", [b4malPath, "lsp"], {
            stdio: ["pipe", "pipe", "inherit"]
        });

        const sendLsp = (msg: any) => {
            const body = JSON.stringify(msg);
            child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
        };

        const result = await new Promise<any>((resolve, reject) => {
            let buffer = Buffer.alloc(0);
            let contentLength = -1;
            
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error("LSP Timeout"));
            }, 2000);

            child.stdout.on("data", (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                
                while (true) {
                    if (contentLength === -1) {
                        const headerEnd = buffer.indexOf('\r\n\r\n');
                        if (headerEnd === -1) break;
                        
                        const headers = buffer.subarray(0, headerEnd).toString('utf-8');
                        const match = headers.match(/Content-Length: (\d+)/i);
                        if (match) {
                            contentLength = parseInt(match[1], 10);
                        }
                        buffer = buffer.subarray(headerEnd + 4);
                    }

                    if (contentLength !== -1 && buffer.length >= contentLength) {
                        const body = buffer.subarray(0, contentLength).toString('utf-8');
                        const msg = JSON.parse(body);
                        
                        if (msg.method === 'textDocument/publishDiagnostics') {
                            clearTimeout(timer);
                            child.kill();
                            resolve(msg);
                            return;
                        }
                        
                        buffer = buffer.subarray(contentLength);
                        contentLength = -1;
                    } else {
                        break;
                    }
                }
            });

            // Send initialize
            sendLsp({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {}
            });

            // Send conflicting b4mal.lock payload
            const lockPayload = JSON.stringify([
                { id: "taskA", reads: [], writes: ["dist/"], envReads: [], envWrites: [] },
                { id: "taskB", reads: ["dist/"], writes: [], envReads: [], envWrites: [] }
            ], null, 2);

            sendLsp({
                jsonrpc: "2.0",
                method: "textDocument/didChange",
                params: {
                    textDocument: { uri: "file:///path/to/b4mal.lock" },
                    contentChanges: [{ text: lockPayload }]
                }
            });
        });

        expect(result.params.uri).toBe("file:///path/to/b4mal.lock");
        expect(result.params.diagnostics.length).toBe(1);
        expect(result.params.diagnostics[0].message).toContain("Resource Collision");
    });
});
