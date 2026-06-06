/**
 * @file proposal_template.ts
 * @description Constructs HTML proposals summarizing CI execution pipelines.
 */

import type { SavingsResult } from "../core/time_savings";

export interface AuditData {
    commitsScanned: number;
    filesAnalyzed: number;
    taxEvents: number;
    logicChanges: number;
    taxRate: number;
    totalSavedSeconds: number;
}

export class ProposalTemplate {
    /**
     * Generate the optimization_report.md content.
     */
    static generate(repoName: string, audit: AuditData, savings: SavingsResult): string {
        const date = new Date().toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
        });

        // ── ZERO-TAX EDGE CASE ──
        if (audit.taxEvents === 0) {
            return `\
# Optimization Report: ${repoName}

> **Date:** ${date}  
> **Prepared by:** B4mal Engine

## 1. Summary: Peak Efficiency

After an analysis of **${audit.commitsScanned}** recent commits in the \`${repoName}\` repository, the B4mal Engine has confirmed peak efficiency.

Every commit analyzed contained meaningful logic changes. There were zero wasted cycles rebuilding invariant code.

| Metric | Value |
|:---|:---|
| Commits Scanned | **${audit.commitsScanned}** |
| Cache Miss Overhead Events | **0** |
| Efficiency Gain | **100.0%** |
`;
        }

        // ── CACHE MISS OVERHEAD CASE ──
        return `\
# Optimization Report: ${repoName}

> **Date:** ${date}  
> **Prepared by:** B4mal Engine

## 1. Summary

This report outlines the build time impact of integrating the B4mal Engine into the \`${repoName}\` development lifecycle.

Based on an audit of the last **${audit.commitsScanned}** commits, your organization is currently experiencing **Cache Miss Overhead** — computational cycles spent rebuilding code where the underlying mathematical logic has not changed.

| Metric | Value |
|:---|:---|
| Commits Analyzed | **${audit.commitsScanned}** |
| Cache Miss Events | **${audit.taxEvents}** |
| Efficiency Gain | **${savings.efficiencyGain}** |
| Hours Recovered | **${savings.hoursSaved}** |

## 2. Cache Miss Overhead

Traditional CI/CD pipelines rely on coarse-grained content hashing (e.g., SHA-256 of a file). If a developer adjusts a comment, fixes whitespace, or modifies a non-functional attribute, the standard cache is invalidated, and the compilation chain runs again.

In \`${repoName}\`, **${audit.taxEvents}** of the last ${audit.commitsScanned} commits triggered full rebuilds despite containing zero logical changes. 

By eliminating these redundant compilation cycles, b4mal immediately recovers **${savings.hoursSaved}** hours of compute capability.

## 3. The Logic Engine

The b4mal engine replaces conventional string matching with **Logic-Aware Path-based Isolation**.

1. **State-Machine Lexing:** Code is parsed into functional tokens. Comments, whitespace, and cosmetic attributes are stripped per language.
2. **Logic Hashing:** The resulting token stream is hashed, guaranteeing that functionally identical code always produces the same cache key.
3. **Execution Sandboxing:** The engine guarantees task isolation, preventing concurrent resource collisions.

## 4. Conclusion

By deploying b4mal, your team reclaims **${savings.hoursSaved} hours** of engineering flow state per ${audit.commitsScanned} commits. The integration handles Rust, TypeScript, and Python out of the box.
`;
    }
}
