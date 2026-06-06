import { FormalShadow, TaskResourceClaim } from "../core/formal_shadow";

export function startLspServer() {
    let buffer = Buffer.alloc(0);
    let contentLength = -1;
    const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB limit

    process.stdin.on('data', async (chunk) => {
        buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
        
        if (buffer.length > MAX_BUFFER_SIZE) {
            console.error("LSP buffer size exceeded maximum limit. Possible DoS attack or malformed payload.");
            process.exit(1);
        }

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
                buffer = buffer.subarray(contentLength);
                contentLength = -1;

                try {
                    await handleMessage(JSON.parse(body));
                } catch (e) {
                    // Ignore malformed messages
                }
            } else {
                break;
            }
        }
    });

    async function handleMessage(msg: any) {
        if (msg.method === 'initialize') {
            sendMessage({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                    capabilities: {
                        textDocumentSync: 1, // Full
                    }
                }
            });
        }

        if (msg.method === 'textDocument/didChange' || msg.method === 'textDocument/didOpen') {
            const uri = msg.params.textDocument.uri;
            const text = msg.method === 'textDocument/didChange' 
                ? msg.params.contentChanges[0].text 
                : msg.params.textDocument.text;
                
            if (uri.endsWith('b4mal.lock')) {
                await validateDocument(uri, text);
            }
        }
    }

    function sendMessage(msg: any) {
        const body = JSON.stringify(msg);
        process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
    }

    async function validateDocument(uri: string, text: string) {
        try {
            const tasksRaw = JSON.parse(text);
            if (!Array.isArray(tasksRaw)) return;
            
            const tasks: TaskResourceClaim[] = tasksRaw.map(t => ({
                id: t.id || 'unknown',
                reads: t.reads || [],
                writes: t.writes || [],
                envReads: t.envReads || [],
                envWrites: t.envWrites || []
            }));

            const result = await FormalShadow.verifyWave(tasks);
            
            const diagnostics = [];
            for (const conflict of result.conflicts) {
                // Find line number using a naive regex if possible
                let lineNum = 0;
                const lines = text.split('\n');
                const searchStr = `"${conflict.counterexample?.replace(/^fs:/, '').replace(/^env:/, '')}"`;
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes(searchStr)) {
                        lineNum = i;
                        break;
                    }
                }

                diagnostics.push({
                    range: {
                        start: { line: lineNum, character: 0 },
                        end: { line: lineNum, character: 100 }
                    },
                    severity: 1, // Error
                    source: 'b4mal',
                    message: `Resource Collision: Task ${conflict.taskA} and ${conflict.taskB} concurrently claim ${conflict.counterexample}`
                });
            }

            sendMessage({
                jsonrpc: '2.0',
                method: 'textDocument/publishDiagnostics',
                params: {
                    uri,
                    diagnostics
                }
            });
        } catch (e) {
            // Ignore JSON parse errors while typing
        }
    }
}
