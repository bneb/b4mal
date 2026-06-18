import * as fs from "fs";
import * as path from "path";
import { CIEmitter, type CITarget } from "../shim/ci_emitter";

const VALID_TARGETS: CITarget[] = ["github", "gitlab", "circleci", "buildkite", "bitbucket"];

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

        const dryRun = args.includes("--dry-run") || args.includes("--print");
        const force = args.includes("--force") || args.includes("-f");
        const target = this.parseTarget(args);
        const cwd = process.cwd();
        info(`Detecting toolchains for ${target}...`);

        const yaml = this.emitFor(target, cwd);
        const outPath = this.resolveOutputPath(target, cwd);

        if (dryRun) {
            process.stdout.write(`\n${c.dim}--- b4mal-ci.yml ---${c.reset}\n`);
            process.stdout.write(yaml);
            process.stdout.write(`\n${c.dim}--------------------${c.reset}\n`);
            ok("Dry run complete.");
            return;
        }

        this.ensureDir(path.dirname(outPath));
        this.writeIfNotExists(outPath, yaml, force, cwd);
        ok(`Generated ${target} CI workflow at: ${path.relative(cwd, outPath)}`);
        info("Commit this file to enable B4mal on your CI pipeline.");
        process.stdout.write(`\n   ${c.bold}Tip: Run b4mal build locally to warm the cache before your first CI run.${c.reset}\n\n`);
    }

    private static parseTarget(args: string[]): CITarget {
        let target: string = "github";
        for (let i = 0; i < args.length; i++) {
            if (args[i].startsWith("--target=")) {
                target = args[i].split("=")[1];
            } else if (args[i] === "--target" && i + 1 < args.length && !args[i + 1].startsWith("-")) {
                target = args[i + 1];
            }
        }
        if (!VALID_TARGETS.includes(target as CITarget)) {
            process.stderr.write(`${c.red}[FAIL] Unknown target: "${target}". Valid: ${VALID_TARGETS.join(", ")}${c.reset}\n`);
            process.exit(1);
        }
        return target as CITarget;
    }

    private static emitFor(target: CITarget, cwd: string): string {
        const opts = { cwd };
        switch (target) {
            case "github":    return CIEmitter.emitGithubActions(opts);
            case "gitlab":    return CIEmitter.emitGitLabCI(opts);
            case "circleci":  return CIEmitter.emitCircleCI(opts);
            case "buildkite": return CIEmitter.emitBuildkite(opts);
            case "bitbucket": return CIEmitter.emitBitbucket(opts);
        }
    }

    private static resolveOutputPath(target: CITarget, cwd: string): string {
        const gitRoot = this.findGitRoot(cwd);
        switch (target) {
            case "github":    return path.join(gitRoot, ".github", "workflows", "b4mal-ci.yml");
            case "gitlab":    return path.join(gitRoot, ".gitlab-ci.yml");
            case "circleci":  return path.join(gitRoot, ".circleci", "config.yml");
            case "buildkite": return path.join(gitRoot, ".buildkite", "pipeline.yml");
            case "bitbucket": return path.join(gitRoot, "bitbucket-pipelines.yml");
        }
    }

    private static ensureDir(dir: string): void {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    private static writeIfNotExists(outPath: string, content: string, force: boolean, cwd: string): void {
        if (fs.existsSync(outPath) && !force) {
            warn(`Workflow file already exists at ${path.relative(cwd, outPath)}`);
            process.stderr.write(`${c.red}[FAIL] Refusing to overwrite without --force flag.${c.reset}\n`);
            process.exit(1);
        }
        fs.writeFileSync(outPath, content);
    }
}
