/**
 * @file readme_generator.ts
 * @description Auto-generates technical README components from current telemetry and configuration.
 */

export class ReadmeGenerator {
    static generate(): string {
        return `\
<div align="center">
  <img src="https://img.shields.io/badge/%F0%9F%9B%A1%EF%B8%8F_Core-Local_Execution-1A1A1A?style=for-the-badge&labelColor=1A1A1A&color=00FF00" alt="Core Local Execution" />
  <h1>b4mal</h1>
  <p><strong>Reduce Cache Miss Overhead.</strong></p>
</div>

<br />

The average engineering team wastes thousands of hours compiling code that hasn't fundamentally changed. Changing a comment, refactoring whitespace, or tweaking a log string busts standard caches and forces a full compilation chain.

**b4mal** replaces conventional string-based caching with a **Logic-Aware Path-based Isolation**.

---

### The One-Liner

Install b4mal:

\`\`\`bash
curl -fsSL https://b4mal.dev/install.sh | sh
\`\`\`

---

### The Architecture: Determinism

1. **State-Machine Lexing**: Code is tokenized. Comments and non-functional changes are discarded corely.
2. **Logic Proofing**: The engine generates a stable \`LogicHash\`. If the logic hasn't changed, the pipeline yields immediately.
3. **Path-based Isolation**: b4mal statically analyzes resource claims to ensure concurrent isolated tasks never collide over \`fs:\`, \`env:\`, or \`port:\` resources. View the **HUD** for real-time visualization of resource zones.

### The Stack

B4mal supports zero-dependency integration across the modern stack. Shims exist for:

* **Rust**: \`b4mal.rs\` (via \`std::process::Command\`)
* **Python**: \`b4mal.py\` (via \`subprocess.Popen\`)
* **TypeScript**: \`b4mal.ts\` (via \`child_process.spawn\`)

---

### Example Audit

\`\`\`
  ███████╗  ▲ b4mal CORE AUDIT (30D)  
  ──────────────────────────────────────────────────
  › Total Tasks Processed:  500
  › Logical Cache Efficacy: █░░░░░ 4.4%
  › Cache Miss Overhead Saved:  14400.0s
  › Estimated Productivity: 4.0 Human-Hours
  ──────────────────────────────────────────────────
  breakdown: 350 (Content) 22 (Logic) 128 (Miss)
\`\`\`

B4mal ships with a formal proposal generator. Run \`b4mal report --audit <json>\` to generate your own [optimization_report.md](optimization_report.md) computing the exact ROI of integration.
`;
    }
}
