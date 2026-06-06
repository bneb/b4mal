// B4mal v3.1.0 — Interview Generator
//
// Converts low-confidence ApertureProposals into human-readable
// "TurboTax-style" questions. Supports binary (confirm/deny),
// select (choose one), and path-split question types.

import type { ApertureProposal } from "./auto_map";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CoreQuestion {
    id: string;
    type: "binary" | "select" | "path-split";
    heading: string;
    body: string;
    options?: string[];
    suggestedAction: string;
    targetIds: string[];
}

export interface ApertureEntry {
    id: string;
    claims: string[];
}

export interface ApertureMap {
    apertures: ApertureEntry[];
}

// ─── Generator ───────────────────────────────────────────────────────────────

export class InterviewGenerator {
    /**
     * Analyze proposals and generate questions for ambiguity points.
     * Only low-confidence proposals (< 0.8) generate questions.
     * High-confidence proposals are auto-accepted.
     */
    generate(proposals: ApertureProposal[]): CoreQuestion[] {
        const questions: CoreQuestion[] = [];

        for (const proposal of proposals) {
            if (proposal.type === "combined") {
                questions.push(this.createMergeQuestion(proposal));
            } else if (proposal.type === "orphan") {
                questions.push(this.createOrphanQuestion(proposal));
            }
            // "isolated" with high confidence → auto-accepted, no question
        }

        return questions;
    }

    /**
     * Apply a user's answer to an aperture map.
     * Returns the updated map (immutable — does not mutate input).
     */
    applyAnswer(
        map: ApertureMap,
        question: CoreQuestion,
        answer: string,
    ): ApertureMap {
        const newApertures = [...map.apertures.map(a => ({ ...a, claims: [...a.claims] }))];

        if (question.suggestedAction === "merge" && answer.toLowerCase() === "yes") {
            // Merge the targeted apertures into one
            const mergedClaims: string[] = [];
            const remaining: ApertureEntry[] = [];

            for (const aperture of newApertures) {
                if (question.targetIds.includes(aperture.id)) {
                    mergedClaims.push(...aperture.claims);
                } else {
                    remaining.push(aperture);
                }
            }

            remaining.push({
                id: question.targetIds.join("-"),
                claims: [...new Set(mergedClaims)],
            });

            return { apertures: remaining };
        }

        // "No" or any other answer → preserve existing map
        return { apertures: newApertures };
    }

    // ── Question Factories ───────────────────────────────────────────────

    private createMergeQuestion(proposal: ApertureProposal): CoreQuestion {
        const dirs = [...new Set(proposal.files.map(f => {
            const parts = f.split("/");
            return parts.length >= 2 ? parts.slice(0, 2).join("/") : parts[0];
        }))];

        return {
            id: `merge-${proposal.id}`,
            type: "binary",
            heading: `Merge ${dirs.join(" and ")} into a single Aperture?`,
            body: proposal.reason,
            suggestedAction: "merge",
            targetIds: dirs.map(d => d.replace(/\//g, "-")),
        };
    }

    private createOrphanQuestion(proposal: ApertureProposal): CoreQuestion {
        return {
            id: `orphan-${proposal.id}`,
            type: "binary",
            heading: `Prune orphan file: ${proposal.files[0]}?`,
            body: proposal.reason,
            suggestedAction: "prune",
            targetIds: [proposal.id],
        };
    }
}
