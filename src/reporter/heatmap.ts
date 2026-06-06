/**
 * @file heatmap.ts
 * @description Generates ASCII heatmaps representing cache hit rates and volatility.
 */

const R = "\x1b[0m";
const B = "\x1b[1m";
const D = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[97m";
const BG_WHITE = "\x1b[47m";
const BG_BLACK = "\x1b[40m";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ZoneState = "EMPTY" | "READ" | "WRITE" | "SHIELD" | "CONTENTION";

export interface TaskClaim {
    taskId: string;
    reads: string[];
    writes: string[];
    envReads: string[];
    envWrites: string[];
}

export interface ZoneInfo {
    name: string;
    state: ZoneState;
    taskIds: string[];
    writerCount: number;
}

export interface HeatmapResult {
    zones: ZoneInfo[];
    grid: ZoneInfo[][];
    lines: string[];
    raw: string;
}

export interface RenderOptions {
    verifiedZones?: string[];
    width?: number;
}

// ─── Zone Definitions ────────────────────────────────────────────────────────

const ZONE_NAMES = ["src/", "tests/", "config/", "assets/", "env/", "dist/", "scripts/", "docs/"];

// ─── Heatmap ─────────────────────────────────────────────────────────────────

export class CoreHeatmap {
    /**
     * Render the 2D resource heatmap for the current wave.
     */
    static render(claims: TaskClaim[], options: RenderOptions = {}): HeatmapResult {
        const verifiedZones = new Set(options.verifiedZones ?? []);
        const zones = this.computeZones(claims, verifiedZones);
        const grid = [zones.slice(0, 4), zones.slice(4, 8)];
        const lines = this.renderGrid(grid, options.width);
        const raw = lines.join("\n");

        return { zones, grid, lines, raw };
    }

    private static computeZones(claims: TaskClaim[], verifiedZones: Set<string>): ZoneInfo[] {
        return ZONE_NAMES.map(zoneName => {
            const taskIds: string[] = [];
            let hasReaders = false;
            let writerCount = 0;

            for (const claim of claims) {
                let isReader = false;
                let isWriter = false;

                if (zoneName === "env/") {
                    // Environment zone: map envReads/envWrites
                    if (claim.envReads.length > 0) isReader = true;
                    if (claim.envWrites.length > 0) isWriter = true;
                } else {
                    // Filesystem zone: match path prefixes
                    if (claim.reads.some(p => p.startsWith(zoneName))) isReader = true;
                    if (claim.writes.some(p => p.startsWith(zoneName))) isWriter = true;
                }

                if (isReader || isWriter) {
                    taskIds.push(claim.taskId);
                    if (isReader) hasReaders = true;
                    if (isWriter) writerCount++;
                }
            }

            // State precedence: SHIELD > CONTENTION > WRITE > READ > EMPTY
            let state: ZoneState;
            if (taskIds.length === 0) {
                state = "EMPTY";
            } else if (verifiedZones.has(zoneName)) {
                state = "SHIELD";
            } else if (writerCount > 1) {
                state = "CONTENTION";
            } else if (writerCount === 1) {
                state = "WRITE";
            } else {
                state = "READ";
            }

            return { name: zoneName, state, taskIds, writerCount };
        });
    }

    private static renderGrid(grid: ZoneInfo[][], _width?: number): string[] {
        const lines: string[] = [];

        lines.push(`${BG_WHITE}${B}\x1b[30m  RESOURCE HEATMAP (WAVE ISOLATION)  ${R}`);
        lines.push(`${D}${"─".repeat(48)}${R}`);

        for (const row of grid) {
            const cells = row.map(z => this.formatCell(z));
            lines.push(`  ${cells.join("  ")}`);
        }

        lines.push(`${D}${"─".repeat(48)}${R}`);

        // Legend
        lines.push(`  ${D}Legend:${R} ${GREEN}[ R ]${R}Read  ${YELLOW}[ W ]${R}Write  ${BLUE}[]${R}Verified  ${RED}[!!]${R}Contention`);

        return lines;
    }

    private static formatCell(zone: ZoneInfo): string {
        const label = zone.name.padEnd(9);
        switch (zone.state) {
            case "SHIELD":
                return `${BLUE}${B}[]${R} ${BLUE}${label}${R}`;
            case "CONTENTION":
                return `${RED}${B}[!!]${R} ${RED}${label}${R}`;
            case "WRITE":
                return `${YELLOW}[ W ]${R} ${YELLOW}${label}${R}`;
            case "READ":
                return `${GREEN}[ R ]${R} ${GREEN}${label}${R}`;
            case "EMPTY":
            default:
                return `${D}[   ]${R} ${D}${label}${R}`;
        }
    }

    /**
     * Print the heatmap to stdout.
     */
    static print(result: HeatmapResult): void {
        for (const line of result.lines) {
            console.log(line);
        }
    }
}
