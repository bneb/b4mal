import type { ISystemTracer, TraceEvent } from "./types";
import { spawn } from "child_process";
import { createInterface } from "readline";

/**
 * EbpfTracer wraps strace/eBPF tools to passively intercept OS syscalls.
 * We use strace -f -e trace=execve,openat as a functional equivalent to eBPF 
 * that does not require building custom python/bcc scripts for the demo.
 */
export class EbpfTracer implements ISystemTracer {
    private ppidMap = new Map<number, number>();

    public async trace(cmd: string): Promise<TraceEvent[]> {
        return new Promise((resolve, reject) => {
            const events: TraceEvent[] = [];
            // Note: This relies on strace. If running on macOS without strace,
            // this will fail. Tests should use MockTracer.
            const tracer = spawn("strace", ["-f", "-e", "trace=execve,openat,chdir,clone,fork,vfork", "-y", "-yy", "sh", "-c", cmd], {
                stdio: ["ignore", "inherit", "pipe"] // capture stderr where strace logs
            });

            const rl = createInterface({
                input: tracer.stdio[2]! as any,
                crlfDelay: Infinity
            });

            rl.on("line", (line: string) => {
                const event = this.parseLine(line);
                if (event) events.push(event);
            });

            tracer.on("close", (code) => {
                if (code === 0) resolve(events);
                else {
                    // warn but resolve if it's just a non-zero exit from the wrapped program
                    console.warn(`[EbpfTracer] Trace finished with non-zero exit code: ${code}`);
                    resolve(events);
                }
            });
            
            tracer.on("error", (err) => {
                reject(err);
            });
        });
    }

    private parseLine(line: string): TraceEvent | null {
        const pidMatch = line.match(/^\[pid\s+(\d+)\]/);
        const pidStr = pidMatch ? pidMatch[1] : line.match(/^(\d+)\s/)?.[1];
        if (!pidStr) return null;
        const pid = parseInt(pidStr, 10);

        if (line.includes("clone(") || line.includes("fork(") || line.includes("vfork(")) {
            const childMatch = line.match(/=\s+(\d+)$/);
            if (childMatch) {
                const childPid = parseInt(childMatch[1], 10);
                this.ppidMap.set(childPid, pid);
            }
            return null; // Not an event we emit, just internal tracking
        }

        if (line.includes("execve(")) {
            const cmdMatch = line.match(/execve\("[^"]+",\s*\[(.*?)\]/);
            if (cmdMatch) {
                const argsStr = cmdMatch[1];
                const cmd = argsStr.match(/"([^"\\]*(\\.[^"\\]*)*)"/g)?.map(s => s.replace(/(^"|"$)/g, ''));
                return { type: "exec", pid, ppid: this.ppidMap.get(pid), cmd: cmd || [] };
            }
        } else if (line.includes("chdir(")) {
            const pathMatch = line.match(/chdir\("([^"]+)"\)/);
            if (pathMatch) {
                return { type: "chdir", pid, path: pathMatch[1] };
            }
        } else if (line.includes("openat(")) {
            const pathMatch = line.match(/openat\([^,]+,\s*"([^"]+)"/);
            if (pathMatch) {
                const path = pathMatch[1];
                let mode: "r" | "w" | "rw" = "r";
                if (line.includes("O_WRONLY") || line.includes("O_RDWR") || line.includes("O_CREAT")) {
                    mode = "w";
                }
                return { type: "open", pid, path, mode };
            }
        }
        return null;
    }
}
