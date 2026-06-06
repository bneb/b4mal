#!/usr/bin/env node
// b4mal v7.0.0 — Tree-sitter Parser Bridge
//
// Runs under Node.js (not Bun) because web-tree-sitter WASM
// requires full SharedArrayBuffer/Worker support.
//
// Usage: echo '{"file":"path.ts","content":"...","lang":"typescript"}' | node ts_parser.mjs
//
// Reads JSON lines from stdin, writes JSON import results to stdout.
// Each input: { file: string, content: string, lang: "typescript"|"javascript"|"rust" }
// Each output: { file: string, imports: [{ path: string, dynamic: boolean }] }

const Parser = require("web-tree-sitter");
const path = require("path");
const readline = require("readline");

const grammarsDir = path.join(
    __dirname,
    "..",
    "..",
    "node_modules",
    "tree-sitter-wasms",
    "out"
);

const languages = {};

async function getLanguage(lang) {
    if (!languages[lang]) {
        const wasmFile = path.join(grammarsDir, `tree-sitter-${lang}.wasm`);
        languages[lang] = await Parser.Language.load(wasmFile);
    }
    return languages[lang];
}

async function parseFile(file, content, lang) {
    const parser = new Parser();
    const language = await getLanguage(lang);
    parser.setLanguage(language);

    const tree = parser.parse(content);
    const imports = [];
    const root = tree.rootNode;

    if (lang === "typescript" || lang === "javascript") {
        walkTS(root, imports);
    } else if (lang === "rust") {
        walkRust(root, imports);
    }

    parser.delete();
    return { file, imports };
}

function walkTS(node, imports) {
    // import_statement → source is a string node
    if (node.type === "import_statement") {
        const source = node.childForFieldName("source");
        if (source) {
            const text = stripQuotes(source.text);
            imports.push({ path: text, dynamic: false });
        }
    }
    // export_statement with source (re-export)
    else if (node.type === "export_statement") {
        const source = node.childForFieldName("source");
        if (source) {
            const text = stripQuotes(source.text);
            imports.push({ path: text, dynamic: false });
        }
    }
    // call_expression: require("...") or import("...")
    else if (node.type === "call_expression") {
        const fn = node.childForFieldName("function");
        const args = node.childForFieldName("arguments");
        if (fn && args) {
            if (fn.type === "identifier" && fn.text === "require") {
                const arg = args.namedChild(0);
                if (arg && arg.type === "string") {
                    imports.push({ path: stripQuotes(arg.text), dynamic: false });
                }
            } else if (fn.type === "import") {
                const arg = args.namedChild(0);
                if (arg && arg.type === "string") {
                    imports.push({ path: stripQuotes(arg.text), dynamic: true });
                }
            }
        }
    }

    // Recurse
    for (let i = 0; i < node.childCount; i++) {
        walkTS(node.child(i), imports);
    }
}

function walkRust(node, imports) {
    if (node.type === "mod_item") {
        const name = node.childForFieldName("name");
        if (name) {
            imports.push({ path: `./${name.text}`, dynamic: false });
        }
    } else if (node.type === "use_declaration") {
        const arg = node.childForFieldName("argument");
        if (arg) {
            const text = arg.text;
            if (text.startsWith("crate::") || text.startsWith("super::")) {
                imports.push({ path: text, dynamic: false });
            }
        }
    }

    for (let i = 0; i < node.childCount; i++) {
        walkRust(node.child(i), imports);
    }
}

function stripQuotes(s) {
    return s.replace(/^['"`]|['"`]$/g, "");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    await Parser.init();

    const rl = readline.createInterface({ input: process.stdin });

    for await (const line of rl) {
        try {
            const { file, content, lang } = JSON.parse(line);
            const result = await parseFile(file, content, lang);
            process.stdout.write(JSON.stringify(result) + "\n");
        } catch (e) {
            process.stdout.write(JSON.stringify({ file: "error", imports: [], error: e.message }) + "\n");
        }
    }
}

main().catch(e => {
    process.stderr.write("ts_parser fatal: " + e.message + "\n");
    process.exit(1);
});
