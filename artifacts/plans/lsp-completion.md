# Design Plan: LSP Completion (Feature #10)

## Problem
LSP only provides collision diagnostics. No autocomplete, hover, or code actions.

## Solution
Add `textDocument/completion`, `textDocument/hover`, and `textDocument/codeAction` handlers to the existing LSP server in `src/lsp/server.ts`.

## Handlers
- **Completion**: 14 field completions for `b4mal.config.json` (cmd, inputs, outputs, dependencies, claims, needsEnv, providesEnv, secrets, env, cwd, timeout, cache, when, matrix) with snippet insert text
- **Hover**: Markdown documentation with field descriptions and link to config reference
- **CodeAction**: Quick fix for collision resolution ("Add dependency edge")

## Files
- `src/lsp/server.ts` — Add 3 handler functions + capability declarations
