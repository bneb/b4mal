/**
 * b4mal watch — file watcher that re-executes affected tasks on change.
 */
import { watch, readFileSync, existsSync } from "fs";
import { join } from "path";
import { B4malEngine } from "../core/engine";

const DEBOUNCE_MS = 300;

function collectWatchDirs(projectRoot: string): Set<string> {
  const lockPath = join(projectRoot, "b4mal.lock");
  if (!existsSync(lockPath)) return new Set();

  const raw = JSON.parse(readFileSync(lockPath, "utf-8"));
  const tasks = Array.isArray(raw) ? raw : (raw.tasks ?? []);
  const dirs = new Set<string>();
  for (const t of tasks) {
    for (const input of (t.inputs ?? [])) {
      dirs.add(join(projectRoot, input));
    }
  }
  dirs.add(join(projectRoot, "b4mal.config.json"));
  dirs.add(lockPath);
  return dirs;
}

function createDebouncedTrigger(engine: B4malEngine) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;

  const runBuild = async () => {
    if (pending) return;
    pending = true;
    try {
      process.stdout.write("\x1b[2mRebuilding...\x1b[0m\n");
      const result = await engine.build();
      const status = result.success ? "\x1b[32m✓ Build passed\x1b[0m" : "\x1b[31m✗ Build failed\x1b[0m";
      process.stdout.write(`${status} (${result.results.length} tasks)\n`);
    } catch (e: any) {
      process.stderr.write(`\x1b[31mError: ${e.message}\x1b[0m\n`);
    }
    pending = false;
  };

  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(runBuild, DEBOUNCE_MS);
  };
}

export class WatchCommand {
  static async execute(_args: string[]): Promise<void> {
    const projectRoot = process.cwd();
    const engine = new B4malEngine(projectRoot);
    const watchDirs = collectWatchDirs(projectRoot);
    const trigger = createDebouncedTrigger(engine);

    process.stdout.write(`\x1b[1mB4mal Watch\x1b[0m — monitoring ${watchDirs.size} paths\n`);
    process.stdout.write("Press Ctrl+C to stop.\n\n");

    const onFileChange = (_event: string, filename: string | null) => {
      if (filename && !filename.startsWith(".b4mal")) trigger();
    };

    for (const dir of watchDirs) {
      try { watch(dir, { recursive: true }, onFileChange); } catch { /* dir may not exist yet */ }
    }

    await trigger(); // initial build
    await new Promise(() => {}); // keep alive
  }
}
