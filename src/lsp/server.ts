import { FormalShadow, TaskResourceClaim } from "../core/formal_shadow";

// ─── LSP Message I/O ──────────────────────────────────────────────────────

function sendMessage(msg: any): void {
  const body = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

interface LspState {
  buffer: Buffer;
  contentLength: number;
}

function tryReadMessage(state: LspState): string | null {
  if (state.contentLength === -1) {
    const headerEnd = state.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;
    const headers = state.buffer.subarray(0, headerEnd).toString("utf-8");
    const match = headers.match(/Content-Length: (\d+)/i);
    if (match) state.contentLength = parseInt(match[1], 10);
    state.buffer = state.buffer.subarray(headerEnd + 4);
  }
  if (state.contentLength !== -1 && state.buffer.length >= state.contentLength) {
    const body = state.buffer.subarray(0, state.contentLength).toString("utf-8");
    state.buffer = state.buffer.subarray(state.contentLength);
    state.contentLength = -1;
    return body;
  }
  return null;
}

// ─── Document state ──────────────────────────────────────────────────────

let lastKnownTasks: string[] = [];

function updateKnownTasks(text: string): void {
  try {
    const parsed = JSON.parse(text);
    if (parsed.tasks && typeof parsed.tasks === "object") {
      lastKnownTasks = Object.keys(parsed.tasks);
    }
  } catch {
    // Invalid JSON while typing — keep previous state
  }
}

// ─── Completions ──────────────────────────────────────────────────────────

function provideCompletions() {
  const taskCompletions = lastKnownTasks.map(id => ({
    label: `"${id}"`,
    detail: "Existing task ID",
    insertText: `"${id}"`,
  }));

  return {
    isIncomplete: false,
    items: [
      ...taskCompletions,
      { label: '"cmd"', detail: "Command array", insertText: '"cmd": ["$1"]' },
      { label: '"inputs"', detail: "Filesystem paths this task reads", insertText: '"inputs": ["$1"]' },
      { label: '"outputs"', detail: "Filesystem paths this task writes", insertText: '"outputs": ["$1"]' },
      { label: '"dependencies"', detail: "Task IDs to depend on", insertText: '"dependencies": ["$1"]' },
      { label: '"claims"', detail: "Non-filesystem resource claims", insertText: '"claims": ["$1"]' },
      { label: '"needsEnv"', detail: "Env var names this task reads", insertText: '"needsEnv": ["$1"]' },
      { label: '"providesEnv"', detail: "Env var names this task writes", insertText: '"providesEnv": ["$1"]' },
      { label: '"secrets"', detail: "Secret names resolved at runtime", insertText: '"secrets": ["$1"]' },
      { label: '"env"', detail: "Extra env vars to inject", insertText: '"env": { "$1": "$2" }' },
      { label: '"cwd"', detail: "Working directory", insertText: '"cwd": "$1"' },
      { label: '"timeout"', detail: "Task timeout in ms (0 = 5 min default)", insertText: '"timeout": $1' },
      { label: '"cache"', detail: "Enable caching (default: true)", insertText: '"cache": $1' },
      { label: '"when"', detail: "Conditional execution guard", insertText: '"when": { "branch": "$1" }' },
      { label: '"matrix"', detail: "Matrix build expansion", insertText: '"matrix": { "$1": ["$2"] }' },
    ],
  };
}

function provideHover() {
  return {
    contents: {
      kind: "markdown",
      value:
        "**B4mal task configuration**\n\n" +
        "Define build tasks with explicit resource declarations.\n\n" +
        "- `cmd`: Command and arguments\n" +
        "- `inputs`/`outputs`: Filesystem paths\n" +
        "- `dependencies`: Upstream task IDs\n" +
        "- `claims`: Non-filesystem resources\n\n" +
        "[Configuration Reference](https://github.com/bneb/b4mal/blob/main/docs/guide/configuration.md)",
    },
  };
}

function provideCodeActions() {
  return [{ title: "Add dependency edge to resolve collision", kind: "quickfix", diagnostics: [], edit: { changes: {} } }];
}

// ─── Document Validation ──────────────────────────────────────────────────

function findLineForConflict(text: string, conflict: any): number {
  const searchStr = `"${conflict.counterexample?.replace(/^fs:/, "").replace(/^env:/, "")}"`;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(searchStr)) return i;
  }
  return 0;
}

async function validateDocument(uri: string, text: string): Promise<void> {
  try {
    const parsed = JSON.parse(text);

    // Both shapes have to be handled. b4mal.config.json is v2 — an object keyed
    // by task id under `tasks` — and the flat array is the v1 lockfile form. This
    // function only recognised the array, so on any v2 config it returned before
    // reaching the check below and the LSP published no diagnostics at all.
    // The feature the README advertises ("real-time editor feedback for resource
    // collisions while editing configuration files") was therefore dead for every
    // file the tool writes.
    const raw: any[] = Array.isArray(parsed)
      ? parsed
      : Object.entries(parsed?.tasks ?? {}).map(([id, t]) => ({ id, ...(t as any) }));

    const deps = new Map<string, string[]>();
    const tasks: TaskResourceClaim[] = raw.map((t: any) => {
      const id = String(t.id ?? "unknown");
      // v1 names them reads/writes, v2 inputs/outputs; reading only the v1 pair
      // left every v2 task with empty resources and nothing to collide over.
      deps.set(id, t.dependencies ?? t.deps ?? []);
      return {
        id,
        reads: t.reads ?? t.inputs ?? [],
        writes: t.writes ?? t.outputs ?? [],
        envReads: t.envReads ?? t.needsEnv ?? [],
        envWrites: t.envWrites ?? t.providesEnv ?? [],
        claims: t.claims ?? [],
      };
    });

    // Report the same findings as `b4mal check`: the shadowing audit, which is
    // what survives dependency ordering. Previously this called verifyWave, which
    // is a SAME-WAVE check applied to every task at once — so it flagged ordinary
    // producer→consumer edges (alpha writes out/a.txt, beta reads it) as
    // collisions. Those are not conflicts: the planner serializes them, and
    // `b4mal check` stays silent. An editor that underlines every correct config
    // is worse than one that underlines nothing.
    const shadows = await FormalShadow.detectShadowing(tasks, deps);
    const diagnostics = shadows.map((shadow: any) => {
      const resource = shadow.resources?.[0] ?? shadow.counterexample;
      // Two distinct findings, worded as `b4mal check` words them. "masks" is
      // only right for a write/write overwrite; an implicit dependency has no
      // overwrite at all, just a missing edge.
      const message = shadow.kind === "implicit-dependency"
        ? `${shadow.taskB} reads ${resource} produced by ${shadow.taskA} — no dependency edge is declared`
        : `${shadow.taskB} masks ${shadow.taskA} at ${resource} — the overwrite is ${shadow.ordering === "implicit" ? "not declared" : "declared"}`;

      return {
        range: {
          start: { line: findLineForConflict(text, shadow), character: 0 },
          end: { line: findLineForConflict(text, shadow), character: 100 },
        },
        severity: 2, // warning: the build is ordered, but the ordering is implicit
        source: "b4mal",
        message,
      };
    });
    sendMessage({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
  } catch {
    // Ignore JSON parse errors while typing
  }
}

// ─── Message Dispatch ─────────────────────────────────────────────────────

function handleInitialize(msg: any): void {
  const capabilities = {
    textDocumentSync: 1,
    completionProvider: { triggerCharacters: ['"', ".", "/"] },
    hoverProvider: true,
    codeActionProvider: true,
  };
  sendMessage({ jsonrpc: "2.0", id: msg.id, result: { capabilities } });
}

async function handleDidChange(msg: any): Promise<void> {
  const uri = msg.params.textDocument.uri;
  const text = msg.method === "textDocument/didChange"
    ? msg.params.contentChanges[0].text
    : msg.params.textDocument.text;
  if (uri.endsWith("b4mal.lock") || uri.endsWith("b4mal.config.json")) {
    updateKnownTasks(text);
    await validateDocument(uri, text);
  }
}

async function handleLspMessage(msg: any): Promise<void> {
  const method = msg.method;
  if (method === "initialize") return handleInitialize(msg);
  if (method === "textDocument/didChange" || method === "textDocument/didOpen") return handleDidChange(msg);
  if (method === "textDocument/completion") return sendMessage({ jsonrpc: "2.0", id: msg.id, result: provideCompletions() });
  if (method === "textDocument/hover") return sendMessage({ jsonrpc: "2.0", id: msg.id, result: provideHover() });
  if (method === "textDocument/codeAction") return sendMessage({ jsonrpc: "2.0", id: msg.id, result: provideCodeActions() });
}

// ─── Server Entry Point ───────────────────────────────────────────────────

const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB limit

export function startLspServer(): void {
  const state: LspState = { buffer: Buffer.alloc(0), contentLength: -1 };

  process.stdin.on("data", (chunk) => {
    state.buffer = Buffer.concat([state.buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
    if (state.buffer.length > MAX_BUFFER_SIZE) {
      console.error("LSP buffer size exceeded maximum limit. Possible DoS attack.");
      process.exit(1);
    }
    while (true) {
      const body = tryReadMessage(state);
      if (!body) break;
      try { handleLspMessage(JSON.parse(body)); } catch { /* ignore malformed */ }
    }
  });
}
