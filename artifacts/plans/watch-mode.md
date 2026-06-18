# Design Plan: Watch Mode (Feature #8)

## Problem
No watch/dev mode. Developers must manually re-run `b4mal build` after every change.

## Solution
`b4mal watch` command using Bun's `fs.watch` with recursive monitoring and debounced rebuilds.

## Architecture
- Watch all directories listed in task `inputs` from lockfile
- Also watch `b4mal.config.json` and `b4mal.lock`
- 300ms debounce to avoid thrashing
- Skip `.b4mal/` directory changes
- Initial build on start, then rebuild on change
- Shows pass/fail status after each rebuild

## Files
- `src/cli/watch.ts` — WatchCommand implementation
- `src/cli/index.ts` — Wire `watch` and `dev` commands

## Edge Cases
- Directory doesn't exist yet → skip, catch error
- Rapid saves → debounce coalesces them
- Process termination → SIGINT handled by Bun
