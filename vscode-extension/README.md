# B4mal VS Code Extension

Collision detection for `b4mal.config.json` and `b4mal.lock` files.

## Features

- **Completions** — autocomplete task IDs, field names, and paths
- **Hover** — field descriptions and links to docs
- **Diagnostics** — collision warnings when two tasks claim the same resource
- **Code Actions** — quick-fix to add dependency edges resolving collisions

## Installation

```bash
cd vscode-extension
npm install
npm run package  # produces b4mal-0.1.0.vsix
code --install-extension b4mal-0.1.0.vsix
```

## Requirements

- B4mal installed (`bun install -g b4mal`)
- VS Code 1.80+
