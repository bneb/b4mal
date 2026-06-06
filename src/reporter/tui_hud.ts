/**
 * @file tui_hud.ts
 * @description Renders a structured, text-based user interface for CI environments.
 */

import type { TaskResult } from "../schema";

const R = "\x1b[0m";
const B = "\x1b[1m";
const D = "\x1b[2m";
const HI_GREEN = "\x1b[92m";
const HI_RED = "\x1b[91m";
const HI_CYAN = "\x1b[96m";
const HI_MAGENTA = "\x1b[95m";
const HI_YELLOW = "\x1b[93m";
const BG_BLUE = "\x1b[44m";
const HI_WHITE = "\x1b[97m";

interface TuiTaskState {
    status: "pending" | "running" | "done" | "failed";
    duration?: number;
    cacheHit?: boolean | "logic" | "content";
}

export class TuiReporter {
    private tasks: Map<string, TuiTaskState> = new Map();
    private startNs: number = Bun.nanoseconds();
    private renderInterval?: ReturnType<typeof setInterval>;
    private lastLineCount = 0;

    constructor(taskIds: string[], private pipelineName: string) {
        for (const id of taskIds) {
            this.tasks.set(id, { status: "pending" });
        }
    }

    start() {
        this.renderInterval = setInterval(() => this.render(), 100);
    }

    stop() {
        if (this.renderInterval) {
            clearInterval(this.renderInterval);
        }
        this.render(); // final frame
    }

    renderTaskStart(id: string) {
        const t = this.tasks.get(id);
        if (t) t.status = "running";
        this.render();
    }

    renderTaskEnd(result: TaskResult) {
        const t = this.tasks.get(result.id);
        if (t) {
            t.status = result.exitCode === 0 ? "done" : "failed";
            t.duration = result.durationMs;
            t.cacheHit = result.cacheHit;
        }
        this.render();
    }

    generateFrame(): string {
        const lines: string[] = [];
        const elapsed = ((Bun.nanoseconds() - this.startNs) / 1e9).toFixed(1);
        lines.push(`\n  ${BG_BLUE}${B}${HI_WHITE}  ▲ b4mal TUI MISSION CONTROL  ${R} [${elapsed}s]`);
        lines.push(`  ${B}${HI_WHITE}${this.pipelineName}${R} ${D}(${this.tasks.size} tasks)${R}`);
        lines.push(`  ${D}${"─".repeat(50)}${R}`);

        // Task List
        let pending = 0, running = 0, done = 0, failed = 0;

        for (const [id, state] of this.tasks.entries()) {
            if (state.status === "pending") pending++;
            else if (state.status === "running") running++;
            else if (state.status === "done") done++;
            else if (state.status === "failed") failed++;

            // Only show running and recently completed/failed to keep UI compact
            // Or show all if small
            let icon = "";
            let statusText = "";

            if (state.status === "pending") {
                icon = `${D}○${R}`;
                statusText = `${D}pending${R}`;
                continue; // Skip pending to save vertical space
            } else if (state.status === "running") {
                icon = `${HI_CYAN}●${R}`;
                statusText = `${HI_CYAN}running${R}`;
            } else if (state.status === "done") {
                if (state.cacheHit === "logic") {
                    icon = `${HI_MAGENTA} (Logic)${R}`;
                    statusText = `${HI_MAGENTA}logical hit${R}`;
                } else if (state.cacheHit === "content") {
                    icon = `${HI_CYAN} (Content)${R}`;
                    statusText = `${HI_CYAN}cached${R}`;
                } else {
                    icon = `${HI_GREEN}[OK] ${R}`;
                    statusText = `${HI_GREEN}${state.duration?.toFixed(0)}ms${R}`;
                }
            } else if (state.status === "failed") {
                icon = `${HI_RED}✗${R}`;
                statusText = `${HI_RED}failed${R}`;
            }

            lines.push(`  ${icon} ${id.padEnd(28, " ")} ${D}→${R} ${statusText}`);
        }

        lines.push(`  ${D}${"─".repeat(50)}${R}`);
        lines.push(`  ${HI_GREEN}Done: ${done}${R} │ ${HI_CYAN}Running: ${running}${R} │ ${HI_RED}Failed: ${failed}${R} │ ${D}Pending: ${pending}${R}`);

        return lines.join("\n");
    }

    private render() {
        if (process.env.NODE_ENV === "test") return; // Avoid spamming test logs
        
        const frame = this.generateFrame();
        const newLines = frame.split("\n").length;

        // Clear previous frame
        if (this.lastLineCount > 0) {
            process.stdout.write(`\x1b[${this.lastLineCount}A\x1b[0J`);
        }
        
        process.stdout.write(frame + "\n");
        this.lastLineCount = newLines;
    }
}
