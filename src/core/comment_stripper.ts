/**
 * @file comment_stripper.ts
 * @description Removes documentation and whitespace strings prior to logic hashing to avoid cache invalidation on non-functional changes.
 */

export type LanguageId =
    | "python" | "javascript" | "typescript" | "java" | "csharp"
    | "c" | "cpp" | "go" | "rust" | "php" | "ruby" | "swift" | "kotlin";

const EXT_MAP: Record<string, LanguageId> = {
    ".py": "python",
    ".js": "javascript",
    ".ts": "typescript",
    ".java": "java",
    ".cs": "csharp",
    ".c": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".go": "go",
    ".rs": "rust",
    ".php": "php",
    ".rb": "ruby",
    ".swift": "swift",
    ".kt": "kotlin",
    ".kts": "kotlin",
};

export const SUPPORTED_EXTENSIONS = Object.keys(EXT_MAP);

export function detectLanguage(filename: string): LanguageId | null {
    const dot = filename.lastIndexOf(".");
    if (dot === -1) return null;
    return EXT_MAP[filename.slice(dot)] ?? null;
}

// ─── Language Lexer Configs ──────────────────────────────────────────────────

interface LexerConfig {
    singleLineComment: string[];
    multiLineComment: [string, string][];
    stringDelimiters: string[];
    tripleQuote?: boolean;
    rubyHeredoc?: boolean;
    rustAttributes?: boolean;
    useBunTranspiler?: boolean;
}

const LEXER_CONFIGS: Record<LanguageId, LexerConfig> = {
    typescript: {
        singleLineComment: ["//"],
        multiLineComment: [["/*", "*/"]],
        stringDelimiters: ['"', "'", "`"],
        useBunTranspiler: true,
    },
    javascript: {
        singleLineComment: ["//"],
        multiLineComment: [["/*", "*/"]],
        stringDelimiters: ['"', "'", "`"],
        useBunTranspiler: true,
    },
    java: {
        singleLineComment: ["//"],
        multiLineComment: [["/*", "*/"]],
        stringDelimiters: ['"', "'"],
    },
    csharp: {
        singleLineComment: ["//", "///"],
        multiLineComment: [["/*", "*/"]],
        stringDelimiters: ['"', "'"],
    },
    c: {
        singleLineComment: ["//"],
        multiLineComment: [["/*", "*/"]],
        stringDelimiters: ['"', "'"],
    },
    cpp: {
        singleLineComment: ["//"],
        multiLineComment: [["/*", "*/"]],
        stringDelimiters: ['"', "'"],
    },
    go: {
        singleLineComment: ["//"],
        multiLineComment: [["/*", "*/"]],
        stringDelimiters: ['"', "'", "`"],
    },
    rust: {
        singleLineComment: ["///", "//!", "//"],
        multiLineComment: [["/*", "*/"]],
        stringDelimiters: ['"', "'"],
        rustAttributes: true,
    },
    swift: {
        singleLineComment: ["///", "//"],
        multiLineComment: [["/*", "*/"]],
        stringDelimiters: ['"'],
    },
    kotlin: {
        singleLineComment: ["//"],
        multiLineComment: [["/*", "*/"]],
        stringDelimiters: ['"', "'"],
    },
    php: {
        singleLineComment: ["//", "#"],
        multiLineComment: [["/*", "*/"]],
        stringDelimiters: ['"', "'"],
    },
    python: {
        singleLineComment: ["#"],
        multiLineComment: [],
        stringDelimiters: ['"', "'"],
        tripleQuote: true,
    },
    ruby: {
        singleLineComment: ["#"],
        multiLineComment: [],
        stringDelimiters: ['"', "'"],
        rubyHeredoc: true,
    },
};

// ─── Bun Transpiler (TS/JS) ─────────────────────────────────────────────────

const bunTranspiler = new Bun.Transpiler({ loader: "ts" });

function stripWithBun(source: string): string {
    try {
        return bunTranspiler.transformSync(source).trim();
    } catch {
        return tokenize(source, LEXER_CONFIGS.javascript);
    }
}

// ─── State-Machine Tokenizer ─────────────────────────────────────────────────
//
// Character-by-character scanner that tracks whether we are inside:
//   - A string literal (preserve everything)
//   - A comment (drop everything)
//   - Regular code (preserve)
//
// Correctly handles:
//   - "https://url" (not a comment)
//   - Escaped quotes inside strings
//   - Nested block comments (Swift)
//   - Triple-quoted strings (Python)
//   - =begin/=end blocks (Ruby)
//   - #[attr] annotations (Rust)

function tokenize(source: string, config: LexerConfig): string {
    const out: string[] = [];

    // Preprocess: Ruby =begin/=end blocks (line-level, not inline)
    let preprocessed = source;
    if (config.rubyHeredoc) {
        preprocessed = stripRubyBlocks(preprocessed);
    }

    // Preprocess: Rust attributes #[...] and #![...]
    if (config.rustAttributes) {
        preprocessed = stripRustAttributes(preprocessed);
    }

    // Preprocess: Python triple-quoted docstrings
    if (config.tripleQuote) {
        preprocessed = stripPythonDocstrings(preprocessed);
    }

    const src = preprocessed;
    const srcLen = src.length;
    let i = 0;

    while (i < srcLen) {
        // ── Check for string literals first (highest priority) ───────────
        let matchedString = false;
        for (const delim of config.stringDelimiters) {
            if (src[i] === delim) {
                if (delim === "`") {
                    // Template literal — consume entirely
                    const tl = consumeTemplateLiteral(src, i);
                    out.push(tl.text);
                    i = tl.end;
                    matchedString = true;
                    break;
                }
                // Regular string — consume until matching unescaped delimiter
                out.push(delim);
                i++;
                while (i < srcLen) {
                    if (src[i] === "\\" && i + 1 < srcLen) {
                        out.push(src[i], src[i + 1]);
                        i += 2;
                    } else if (src[i] === delim) {
                        out.push(delim);
                        i++;
                        break;
                    } else {
                        out.push(src[i]);
                        i++;
                    }
                }
                matchedString = true;
                break;
            }
        }
        if (matchedString) continue;

        // ── Check for block comments ────────────────────────────────────
        let matchedBlock = false;
        for (const [open, close] of config.multiLineComment) {
            if (src.startsWith(open, i)) {
                let depth = 1;
                i += open.length;
                while (i < srcLen && depth > 0) {
                    if (src.startsWith(close, i)) {
                        depth--;
                        i += close.length;
                    } else if (src.startsWith(open, i)) {
                        depth++;
                        i += open.length;
                    } else {
                        i++;
                    }
                }
                out.push(" ");
                matchedBlock = true;
                break;
            }
        }
        if (matchedBlock) continue;

        // ── Check for single-line comments (longest prefix first) ────────
        let matchedLine = false;
        const prefixes = [...config.singleLineComment].sort((a, b) => b.length - a.length);
        for (const prefix of prefixes) {
            if (src.startsWith(prefix, i)) {
                while (i < srcLen && src[i] !== "\n") i++;
                matchedLine = true;
                break;
            }
        }
        if (matchedLine) continue;

        // ── Regular character ────────────────────────────────────────────
        out.push(src[i]);
        i++;
    }

    return out.join("").replace(/\s+/g, " ").trim();
}

// ─── Rust: Attribute Stripping ───────────────────────────────────────────────
// Strips #[...] and #![...] — tracks bracket depth for nested attrs

function stripRustAttributes(source: string): string {
    const out: string[] = [];
    const len = source.length;
    let i = 0;

    while (i < len) {
        if (source[i] === "#" && i + 1 < len) {
            // #[...] outer attribute
            if (source[i + 1] === "[") {
                i = skipBracketBlock(source, i + 2, len);
                continue;
            }
            // #![...] inner attribute
            if (source[i + 1] === "!" && i + 2 < len && source[i + 2] === "[") {
                i = skipBracketBlock(source, i + 3, len);
                continue;
            }
        }
        out.push(source[i]);
        i++;
    }

    return out.join("");
}

function skipBracketBlock(source: string, start: number, len: number): number {
    let depth = 1;
    let j = start;
    while (j < len && depth > 0) {
        if (source[j] === "[") depth++;
        else if (source[j] === "]") depth--;
        j++;
    }
    return j;
}

// ─── Python: Docstring Stripping ─────────────────────────────────────────────

function stripPythonDocstrings(source: string): string {
    let result = source;
    for (const q of ['"""', "'''"]) {
        let out = "";
        let i = 0;
        while (i < result.length) {
            if (result.startsWith(q, i)) {
                const end = result.indexOf(q, i + q.length);
                if (end !== -1) {
                    i = end + q.length;
                } else {
                    i = result.length;
                }
            } else {
                out += result[i];
                i++;
            }
        }
        result = out;
    }
    return result;
}

// ─── Ruby: =begin/=end Block Stripping ───────────────────────────────────────

function stripRubyBlocks(source: string): string {
    const lines = source.split("\n");
    const out: string[] = [];
    let inBlock = false;

    for (const line of lines) {
        if (!inBlock && line.trimStart().startsWith("=begin")) {
            inBlock = true;
            continue;
        }
        if (inBlock && line.trimStart().startsWith("=end")) {
            inBlock = false;
            continue;
        }
        if (!inBlock) {
            out.push(line);
        }
    }

    return out.join("\n");
}

// ─── Template Literals (JS/TS) ───────────────────────────────────────────────

function consumeTemplateLiteral(src: string, start: number): { text: string; end: number } {
    const out: string[] = ["`"];
    let i = start + 1;
    while (i < src.length) {
        if (src[i] === "\\" && i + 1 < src.length) {
            out.push(src[i], src[i + 1]);
            i += 2;
        } else if (src[i] === "`") {
            out.push("`");
            i++;
            break;
        } else {
            out.push(src[i]);
            i++;
        }
    }
    return { text: out.join(""), end: i };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function stripForLanguage(source: string, lang: LanguageId): string {
    if (!source.trim()) return "";

    const config = LEXER_CONFIGS[lang];
    if (!config) return source.replace(/\s+/g, " ").trim();

    if (config.useBunTranspiler) {
        return stripWithBun(source);
    }

    return tokenize(source, config);
}

export function stripFile(filename: string, content: string): string {
    const lang = detectLanguage(filename);
    if (!lang) return content.replace(/\s+/g, " ").trim();
    return stripForLanguage(content, lang);
}
