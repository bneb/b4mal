import * as fs from "fs";
import * as path from "path";
import { CIEmitter } from "../shim/ci_emitter";

// ─── ANSI colour helpers ──────────────────────────────────────────────────────
const c = {
    reset:  "\x1b[0m",
    bold:   "\x1b[1m",
    dim:    "\x1b[2m",
    green:  "\x1b[32m",
    yellow: "\x1b[33m",
    red:    "\x1b[31m",
};

function banner(msg: string) { process.stdout.write(`\n${c.bold}${msg}${c.reset}\n`); }
function ok(msg: string) { process.stdout.write(`${c.green}[OK] ${msg}${c.reset}\n`); }
function info(msg: string) { process.stdout.write(`${c.dim}   ${msg}${c.reset}\n`); }
function warn(msg: string) { process.stdout.write(`${c.yellow}[WARN] ${msg}${c.reset}\n`); }

export class CICommand {
    /**
     * Finds the nearest .git directory by walking up from cwd.
     */
    private static findGitRoot(cwd: string): string {
        let current = cwd;
        while (current !== path.parse(current).root) {
            if (fs.existsSync(path.join(current, ".git"))) {
                return current;
            }
            current = path.dirname(current);
        }
        return cwd; // fallback to cwd if no git root found
    }

    static async execute(args: string[]): Promise<void> {
        banner("Generating Zero-Configuration CI Workflow…");

        // Simple arg parsing
        let target = "github";
        let dryRun = args.includes("--dry-run") || args.includes("--print");
        let force = args.includes("--force") || args.includes("-f");

        for (const arg of args) {
            if (arg.startsWith("--target=")) {
                target = arg.split("=")[1];
            }
        }
        const targetIndex = args.indexOf("--target");
        if (targetIndex !== -1 && args.length > targetIndex + 1 && !args[targetIndex + 1].startsWith("-")) {
            target = args[targetIndex + 1];
        }

        if (target !== "github") {
            process.stderr.write(`${c.yellow}[FAIL] Currently only --target github is supported.${c.reset}\n`);
            process.exit(1);
        }

        const cwd = process.cwd();
        info("Detecting toolchains and resolving DAG...");
        
        const yaml = CIEmitter.emitGithubActions({ cwd });

        if (dryRun) {
            process.stdout.write(`\n${c.dim}--- b4mal-ci.yml ---${c.reset}\n`);
            process.stdout.write(yaml);
            process.stdout.write(`\n${c.dim}--------------------${c.reset}\n`);
            ok("Dry run complete.");
            return;
        }
        
        const gitRoot = this.findGitRoot(cwd);
        const githubDir = path.join(gitRoot, ".github", "workflows");
        if (!fs.existsSync(githubDir)) {
            fs.mkdirSync(githubDir, { recursive: true });
        }

        const outPath = path.join(githubDir, "b4mal-ci.yml");
        
        if (fs.existsSync(outPath) && !force) {
            warn(`Workflow file already exists at ${path.relative(cwd, outPath)}`);
            process.stderr.write(`${c.red}[FAIL] Refusing to overwrite existing workflow without --force flag.${c.reset}\n`);
            process.exit(1);
        }

        fs.writeFileSync(outPath, yaml);

        ok(`Generated natively optimized GitHub Actions workflow at: ${path.relative(cwd, outPath)}`);
        info("Global remote caching via actions/cache is enabled.");
        process.stdout.write(`\n   ${c.bold}Tip: Commit this file to git to run B4mal on your next push.${c.reset}\n\n`);
    }
}
