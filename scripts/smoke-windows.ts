/**
 * Cross-platform smoke check.
 *
 * Answers one question: does the CLI work on a platform with no POSIX shell?
 * The test suite cannot answer it — it uses `sh -c` throughout, so running it on
 * Windows would report the harness, not the product.
 *
 * Every task here is executed with `bun -e`, so nothing depends on `sh`, `mkdir`
 * or `echo`. Run it on any platform:
 *
 *     bun run scripts/smoke-windows.ts
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");
const root = mkdtempSync(join(tmpdir(), "b4mal-smoke-"));

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
    if (ok) {
        console.log(`  ok    ${label}`);
    } else {
        failures++;
        console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    }
}

async function cli(args: string[], cwd: string) {
    const proc = Bun.spawn(["bun", CLI, ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { stdout, stderr, exitCode, output: stdout + stderr };
}

// A task that writes its output using Bun rather than a shell builtin.
const SCRIPT = "const fs=require('fs');fs.mkdirSync('out',{recursive:true});fs.writeFileSync('out/a.txt','smoke-ok');";

writeFileSync(join(root, "b4mal.config.json"), JSON.stringify({
    tasks: {
        gen: { cmd: ["bun", "-e", SCRIPT], outputs: ["out/a.txt"] },
        verify: {
            cmd: ["bun", "-e", "const fs=require('fs');if(fs.readFileSync('out/a.txt','utf8')!=='smoke-ok')process.exit(3);"],
            inputs: ["out/a.txt"],
            dependencies: ["gen"],
        },
    },
}, null, 2));

console.log(`platform: ${process.platform} ${process.arch}`);
console.log(`project:  ${root}\n`);

// ── The two most basic invocations ─────────────────────────────────────────
const version = await cli(["--version"], root);
check("--version exits 0", version.exitCode === 0, `exit ${version.exitCode}`);
check("--version prints a version", /^\d+\.\d+\.\d+/.test(version.stdout.trim()), JSON.stringify(version.stdout.trim()));
check("--version does not crash", !/UNHANDLED REJECTION/.test(version.output));

const help = await cli(["--help"], root);
check("--help exits 0", help.exitCode === 0, `exit ${help.exitCode}`);
check("--help prints usage", /Usage:/.test(help.stdout));

// ── The machine-facing command ─────────────────────────────────────────────
const attest = await cli(["attest", "gen", "fs:write:out", "env:NODE_ENV"], root);
check("attest exits 0", attest.exitCode === 0, `exit ${attest.exitCode}`);
try {
    const parsed = JSON.parse(attest.stdout);
    check("attest returns a claim", parsed.accepted === true && parsed.claim?.writes?.includes("out") === true);
} catch {
    check("attest returns JSON", false, attest.stdout.slice(0, 120));
}

// ── A real build, with declared deps and a cache pass ──────────────────────
const build = await cli(["build", "--sync"], root);
check("build exits 0", build.exitCode === 0, build.output.slice(-300));
check("build produced the declared output", existsSync(join(root, "out", "a.txt")));
if (existsSync(join(root, "out", "a.txt"))) {
    check("output has the expected content", readFileSync(join(root, "out", "a.txt"), "utf-8") === "smoke-ok");
}

const again = await cli(["build"], root);
check("second build exits 0", again.exitCode === 0, again.output.slice(-300));

// The cache assertion depends on the platform. The artifact vault shells out to
// `tar` and `zstd`; Windows runners ship the former (bsdtar) but not the latter,
// so packing fails there and every run re-executes. Asserting merely that the
// output mentions "cache hits" would pass on 0 hits and prove nothing — so the
// count is checked where packing is possible, and reported either way.
const hits = Number(/(\d+) cache hits/.exec(again.output)?.[1] ?? "-1");
const canPack = Boolean(Bun.which("tar")) && Boolean(Bun.which("zstd"));
if (canPack) {
    check("second build reports a cache hit", hits >= 1, `reported ${hits}`);
} else {
    console.log(
        `  skip  cache assertion — tar=${Bun.which("tar") ?? "absent"}, ` +
        `zstd=${Bun.which("zstd") ?? "absent"}; reported ${hits} hits`,
    );
}

// ── The audit ──────────────────────────────────────────────────────────────
const audit = await cli(["check"], root);
check("check exits 0 on a valid DAG", audit.exitCode === 0, audit.output.slice(-200));

// ── Report ─────────────────────────────────────────────────────────────────
rmSync(root, { recursive: true, force: true });

if (failures > 0) {
    console.error(`\n${failures} smoke check(s) failed on ${process.platform}.`);
    process.exit(1);
}
console.log(`\nAll smoke checks passed on ${process.platform}.`);
