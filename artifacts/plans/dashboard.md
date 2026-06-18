# Design Plan: Enhanced Dashboard (Feature #11)

## Problem
Dashboard is minimal — wave cards with task names only. No stats, timing, or cache indicators.

## Solution
Enhanced HTML dashboard with: summary stats bar (wave count, task count, cache hits, hit rate, duration), per-wave status counts (pass/cached/failed), task timing display, cache hit indicators (green styling + lightning bolt icon), SVG DAG styles for future graph rendering.

## Files
- `src/cli/templates/dashboard.html` — Enhanced with stats, status, timing CSS/JS
