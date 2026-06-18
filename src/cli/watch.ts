/**
 * b4mal watch — file watcher that re-executes affected tasks on change.
 * Uses Bun's native fs.watch with debouncing to avoid thrashing.
 */
import { watch } from "fs";
import { join, relative } from "path";
import { B4malEngine } from "../core/engine";

const DEBOUNCE_MS = 300;

export class WatchCommand {
  static async execute(args: string[]): Promise<void> {
    const projectRoot = process.cwd();
    const engine = new B4malEngine(projectRoot);

    // Resolve task inputs from lockfile to determine watched paths
    const lockPath = join(projectRoot, "b4mal.lock");
    const { readFileSync, existsSync } = require("fs");
    if (!existsSync(lockPath)) {
      process.stderr.write("No b4mal.lock found. Run 'b4mal build' first.\n");
      process.exit(1);
    }

    const raw = JSON.parse(readFileSync(lockPath, "utf-8"));
    const tasks = Array.isArray(raw) ? raw : (raw.tasks ?? []);

    // Collect unique watched directories from task inputs
    const watchDirs = new Set<string>();
    for (const t of tasks) {
      for (const input of (t.inputs ?? [])) {
        const absPath = join(projectRoot, input);
        watchDirs.add(absPath);
      }
    }

    // Also watch the config and lockfile
    watchDirs.add(join(projectRoot, "b4mal.config.json"));
    watchDirs.add(lockPath);

    process.stdout.write(`\x1b[1mB4mal Watch\x1b[0m — monitoring ${watchDirs.size} paths\n`);
    process.stdout.write("Press Ctrl+C to stop.\n\n");

    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending = false;

    const trigger = async () => {
      if (pending) return;
      pending = true;
      try {
        process.stdout.write(`\x1b[2mRebuilding...\x1b[0m\n`);
        const result = await engine.build();
        if (result.success) {
          process.stdout.write(`\x1b[32m✓ Build passed\x1b[0m (${result.results.length} tasks)\n`);
        } else {
          process.stdout.write(`\x1b[31m✗ Build failed\x1b[0m\n`);
        }
      } catch (e: any) {
        process.stderr.write(`\x1b[31mError: ${e.message}\x1b[0m\n`);
      }
      pending = false;
    };

    const debouncedTrigger = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(trigger, DEBOUNCE_MS);
    };

    // Watch each directory recursively
    for (const dir of watchDirs) {
      try {
        watch(dir, { recursive: true }, (event, filename) => {
          if (filename && !filename.startsWith(".b4mal")) {
            debouncedTrigger();
          }
        });
      } catch {
        // Directory may not exist yet — that's fine
      }
    }

    // Initial build
    await trigger();

    // Keep alive
    await new Promise(() => {});
  }
}
