/**
 * @file shield_hud.ts
 * @description Renders a real-time, interactive terminal HUD tracking execution progress.
 */

import type { IsolationAttestation } from "../core/attestation_schema";

// ─── ANSI Palette ────────────────────────────────────────────────────────────

const R = "\x1b[0m";
const B = "\x1b[1m";
const D = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const WHITE = "\x1b[97m";
const BG_BLUE = "\x1b[44m";
const BG_RED = "\x1b[41m";
const BG_GREEN = "\x1b[42m";
const HI_GREEN = "\x1b[92m";
const HI_RED = "\x1b[91m";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProofNode {
    id: string;
    type: "file" | "env";
    verified: boolean;
}

export interface ShieldRenderResult {
    lines: string[];
    raw: string;
    status: "VERIFIED" | "COLLISION";
    unverifiedCount: number;
}

export interface WaveTaskInput {
    taskId: string;
    attestation: IsolationAttestation;
    constraints: ProofNode[];
}

export interface WaveShieldResult {
    waveIndex: number;
    totalTasks: number;
    allVerified: boolean;
    taskResults: ShieldRenderResult[];
    lines: string[];
    raw: string;
}

// ─── Shield HUD ──────────────────────────────────────────────────────────────

export class ShieldHUD {
    /**
     * Render the Core Shield for a single task's isolation proof.
     */
    static renderProof(
        taskId: string,
        attestation: IsolationAttestation,
        constraints: ProofNode[]
    ): ShieldRenderResult {
        const isVerified = attestation.verifier.result === "VERIFIED";
        const status = isVerified ? "VERIFIED" : "COLLISION";
        const unverifiedCount = constraints.filter(c => !c.verified).length;
        const lines: string[] = [];

        // Header
        if (isVerified) {
            lines.push(`${BG_GREEN}${B}${WHITE} SHIELD VERIFIED: ${taskId} ${R}`);
        } else {
            lines.push(`${BG_RED}${B}${WHITE} [WARN] COLLISION DETECTED: ${taskId} ${R}`);
        }

        // Proof type
        const proofLabel = isVerified ? "ISOLATION PROOF [VERIFIED]" : "CONFLICT ANALYSIS [COLLISION]";
        lines.push(`${CYAN} ├─┬─ ${proofLabel}${R}`);

        // Constraint tree
        for (let i = 0; i < constraints.length; i++) {
            const c = constraints[i];
            const isLast = i === constraints.length - 1;
            const branch = isLast ? "└" : "├";
            const icon = c.verified
                ? `${HI_GREEN}[OK] DISJOINT${R}`
                : `${HI_RED}[FAIL] OVERLAP${R}`;
            const typeTag = c.type === "env" ? `${D}(env)${R}` : `${D}(fs)${R}`;

            lines.push(`${CYAN} │ ${branch}── ${WHITE}${c.id}${R} ${typeTag} ${icon}`);
        }

        // Solver metadata
        lines.push(`${CYAN} └── ${D}Verifier: ${attestation.verifier.engine} v${attestation.verifier.version}${R}`);
        lines.push(`${CYAN}     ${YELLOW}${attestation.verifier.duration_ms}ms${R} ${D}verification time${R}`);

        const raw = lines.map(l => l).join("\n");
        return { lines, raw, status, unverifiedCount };
    }

    /**
     * Render the Wave-Level Shield — aggregates all task proofs in a wave.
     */
    static renderWave(waveIndex: number, tasks: WaveTaskInput[]): WaveShieldResult {
        const taskResults = tasks.map(t =>
            this.renderProof(t.taskId, t.attestation, t.constraints)
        );

        const allVerified = taskResults.every(r => r.status === "VERIFIED");
        const lines: string[] = [];

        // Wave header
        const waveBg = allVerified ? BG_BLUE : BG_RED;
        const waveIcon = allVerified ? "" : "[WARN] ";
        lines.push("");
        lines.push(`${waveBg}${B}${WHITE} ${waveIcon}  WAVE ${waveIndex} — ${tasks.length} TASKS ${allVerified ? "CORE" : "CONTESTED"} ${R}`);
        lines.push(`${"─".repeat(50)}`);

        // Individual proofs
        for (const result of taskResults) {
            lines.push(...result.lines);
            lines.push("");
        }

        // Wave summary
        const verifiedCount = taskResults.filter(r => r.status === "VERIFIED").length;
        lines.push(`${D}Wave ${waveIndex}: ${verifiedCount}/${tasks.length} tasks provably isolated${R}`);

        const raw = lines.join("\n");
        return { waveIndex, totalTasks: tasks.length, allVerified, taskResults, lines, raw };
    }

    /**
     * Print the shield to stdout (for CLI integration).
     */
    static print(result: ShieldRenderResult | WaveShieldResult): void {
        for (const line of result.lines) {
            console.log(line);
        }
    }
}
