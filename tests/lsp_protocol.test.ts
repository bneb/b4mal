/**
 * Tests: the LSP server, driven over a real stdio JSON-RPC exchange.
 *
 * The server is the tool's editor integration and its only consumer is an
 * editor, so a server that starts and then never speaks is invisible: no error,
 * no exit code, nothing in a test run. This had been observed exactly that far —
 * it "worked" because the process stayed alive.
 *
 * Driving the real protocol found that collision diagnostics never published for
 * a v2 config, which is the shape b4mal itself writes. Completion and hover
 * worked throughout, because neither parses the document, which is why it went
 * unnoticed.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";

const CLI = join(import.meta.dir, "../src/cli/index.ts");

let dir: string | undefined;
// Typed loosely on purpose: `Bun.spawn`'s stdin is a FileSink whose exact type
// differs across Bun versions, and we only need `.write`.
let proc: any = undefined;
let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
let messages: any[] = [];
let received = new Uint8Array(0);

function frame(obj: unknown): Uint8Array {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    const header = new TextEncoder().encode(`Content-Length: ${bytes.length}\r\n\r\n`);
    const out = new Uint8Array(header.length + bytes.length);
    out.set(header, 0);
    out.set(bytes, header.length);
    return out;
}

/** Start the server and collect framed messages in the background. */
async function startServer() {
    dir = mkdtempSync(join(tmpdir(), "b4mal-lsp-"));
    messages = [];
    received = new Uint8Array(0);

    proc = Bun.spawn(["bun", CLI, "lsp"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
    });

    // One reader for the whole session: a second getReader() on the same stream
    // throws "ReadableStream is locked".
    //
    // Raw bytes are accumulated, never decoded strings. Content-Length counts
    // bytes, and the diagnostic text contains a multi-byte character, so a decoded
    // string is shorter than the frame the server declared and the message would
    // never complete.
    reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    (async () => {
        for (;;) {
            const { value, done } = await reader!.read();
            if (done) break;
            const merged = new Uint8Array(received.length + value.length);
            merged.set(received, 0);
            merged.set(value, received.length);
            received = merged;
        }
    })();

    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { processId: process.pid, rootUri: null, capabilities: {} } });
    await waitFor(m => m.id === 1);
    await send({ jsonrpc: "2.0", method: "initialized", params: {} });
}

/** Pull every complete Content-Length frame out of the received bytes. */
function drainFrames() {
    const decoder = new TextDecoder("utf-8");
    for (;;) {
        // Locate the "\r\n\r\n" header terminator.
        let headerEnd = -1;
        for (let i = 0; i + 3 < received.length; i++) {
            if (received[i] === 13 && received[i + 1] === 10 &&
                received[i + 2] === 13 && received[i + 3] === 10) { headerEnd = i; break; }
        }
        if (headerEnd === -1) return;                        // no complete header yet

        const header = decoder.decode(received.subarray(0, headerEnd));
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) { received = received.subarray(headerEnd + 4); continue; }

        const length = Number(m[1]);
        const bodyStart = headerEnd + 4;
        if (received.length < bodyStart + length) return;      // body still arriving

        const body = decoder.decode(received.subarray(bodyStart, bodyStart + length));
        try { messages.push(JSON.parse(body)); } catch { /* not JSON */ }
        // Consume the frame. Without this the next iteration re-finds the same
        // header and re-parses it forever.
        received = received.subarray(bodyStart + length);
    }
}

async function send(obj: unknown) {
    await proc!.stdin.write(frame(obj));
}

async function waitFor(want: (m: any) => boolean, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        drainFrames();
        const hit = messages.find(want);
        if (hit) return hit;
        await Bun.sleep(40);
    }
    drainFrames();
    return messages.find(want) ?? null;
}

/** Wait until the published diagnostics for `uri` satisfy `predicate`. */
async function waitForDiagnostics(
    uri: string,
    predicate: (d: any[]) => boolean,
    timeoutMs = 10000,
): Promise<any[]> {
    const deadline = Date.now() + timeoutMs;
    let latest: any[] = [];
    while (Date.now() < deadline) {
        drainFrames();
        latest = diagnosticsFor(uri);
        if (predicate(latest)) return latest;
        await Bun.sleep(40);
    }
    drainFrames();
    return diagnosticsFor(uri);
}

function diagnosticsFor(uri: string) {
    return messages
        .filter(m => m.method === "textDocument/publishDiagnostics" && m.params?.uri === uri)
        .flatMap(m => m.params.diagnostics ?? []);
}

async function openConfig(text: string, name = "b4mal.config.json") {
    const uri = `file://${dir}/${name}`;
    await send({
        jsonrpc: "2.0", method: "textDocument/didOpen",
        params: { textDocument: { uri, languageId: "json", version: 1, text } },
    });
    return uri;
}

afterEach(async () => {
    try { proc?.kill(); } catch { /* already gone */ }
    // Awaiting exit unbounded can hang the whole suite: the CLI process is a
    // wrapper and its stdio pipes can be held by a grandchild that outlives the
    // kill. Bounded so cleanup can never stall a run.
    if (proc) {
        await Promise.race([
            proc.exited,
            new Promise((r) => setTimeout(r, 2000)),
        ]);
        try { proc?.kill(9); } catch { /* gone */ }
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    proc = undefined;
    reader = undefined;
});

const V2_COLLISION = JSON.stringify({
    tasks: {
        alpha: { cmd: ["bun", "build"], outputs: ["out/a.txt"] },
        beta: { cmd: ["bun", "build"], outputs: ["out/a.txt"] },
    },
}, null, 2);

// Clean means declared: beta consumes alpha's output AND says so. Without the
// dependency edge this is an implicit-dependency finding, which `b4mal check`
// reports and the LSP must match.
const V2_CLEAN = JSON.stringify({
    tasks: {
        alpha: { cmd: ["bun", "build"], outputs: ["out/a.txt"] },
        beta: { cmd: ["bun", "test"], inputs: ["out/a.txt"], outputs: ["out/b.txt"], dependencies: ["alpha"] },
    },
}, null, 2);

// Read-after-write with no declared edge: the same finding the CLI reports.
const V2_IMPLICIT = JSON.stringify({
    tasks: {
        alpha: { cmd: ["bun", "build"], outputs: ["out/a.txt"] },
        beta: { cmd: ["bun", "test"], inputs: ["out/a.txt"], outputs: ["out/b.txt"] },
    },
}, null, 2);

describe("LSP server", () => {
    test("answers initialize and advertises its capabilities", async () => {
        await startServer();
        const res = messages.find(m => m.id === 1);
        expect(res).toBeDefined();

        const caps = res.result.capabilities;
        expect(caps.completionProvider).toBeTruthy();
        expect(caps.hoverProvider).toBeTruthy();
        expect(caps.codeActionProvider).toBeTruthy();
    }, 30000);

    test("returns completions naming tasks and fields", async () => {
        await startServer();
        const uri = await openConfig(V2_CLEAN);
        await send({
            jsonrpc: "2.0", id: 2, method: "textDocument/completion",
            params: { textDocument: { uri }, position: { line: 2, character: 4 } },
        });

        const res = await waitFor(m => m.id === 2);
        const items = res.result?.items ?? res.result ?? [];
        expect(items.length).toBeGreaterThan(0);
        // Labels carry their JSON quoting (e.g. '"cmd"'), so match on content.
        const labels: string[] = items.map((i: any) => String(i.label));
        expect(labels.some((l: string) => l.includes("cmd"))).toBe(true);
        expect(labels.some((l: string) => l.includes("outputs"))).toBe(true);
        // Task names from the open document are offered too.
        expect(labels.some((l: string) => l.includes("alpha"))).toBe(true);
    }, 30000);

    test("publishes collision diagnostics for a v2 config", async () => {
        // The regression: validateDocument bailed unless the parsed document was
        // a flat array, and b4mal.config.json is an object with a `tasks` map. No
        // editor feedback for any file the tool writes.
        await startServer();
        const uri = await openConfig(V2_COLLISION);
        const diagnostics = await waitForDiagnostics(uri, d => d.length > 0);
        expect(diagnostics.length).toBe(1);
        expect(diagnostics[0].message).toMatch(/alpha/);
        expect(diagnostics[0].message).toMatch(/beta/);
        expect(diagnostics[0].message).toMatch(/out\/a\.txt/);
    }, 30000);

    test("publishes no diagnostics for a valid v2 config", async () => {
        await startServer();
        const uri = await openConfig(V2_CLEAN);
        await waitFor(m => m.method === "textDocument/publishDiagnostics" && m.params?.uri === uri, 10000);
        expect(diagnosticsFor(uri)).toEqual([]);
    }, 30000);

    test("still understands the legacy flat-array lockfile shape", async () => {
        await startServer();
        const v1 = JSON.stringify([
            { id: "alpha", reads: [], writes: ["out/a.txt"] },
            { id: "beta", reads: [], writes: ["out/a.txt"] },
        ], null, 2);   // identical output, no edge -> a shadow
        const uri = await openConfig(v1, "b4mal.lock");
        const diagnostics = await waitForDiagnostics(uri, d => d.length > 0);
        expect(diagnostics.length).toBe(1);
    }, 30000);

    test("re-publishes diagnostics when the document changes", async () => {
        await startServer();
        const uri = await openConfig(V2_CLEAN);
        await waitFor(m => m.method === "textDocument/publishDiagnostics" && m.params?.uri === uri, 10000);

        await send({
            jsonrpc: "2.0", method: "textDocument/didChange",
            params: {
                textDocument: { uri, version: 2 },
                contentChanges: [{ text: V2_COLLISION }],
            },
        });
        const after = await waitForDiagnostics(uri, d => d.length > 0);
        expect(after.length).toBe(1);
    }, 30000);
});

describe("LSP agrees with b4mal check", () => {
    test("reports the implicit dependency the CLI reports", async () => {
        // The parity claim, stated as a test: the editor shows the same findings
        // as `b4mal check` rather than a different (previously wrong) set.
        await startServer();
        const uri = await openConfig(V2_IMPLICIT);
        const diagnostics = await waitForDiagnostics(uri, d => d.length > 0);
        expect(diagnostics.length).toBe(1);
        expect(diagnostics[0].message).toMatch(/beta/);
        expect(diagnostics[0].message).toMatch(/alpha/);
        expect(diagnostics[0].message).toMatch(/out\/a\.txt/);
    }, 30000);
});
