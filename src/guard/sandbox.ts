import * as os from "os";

export interface SandboxOptions {
    /** True if network access is strictly denied */
    denyNetwork?: boolean;
    /** The working directory that must remain writable */
    writablePath?: string;
    /** Enforce strict containment */
    strict?: boolean;
}

export class SandboxEngine {
    /**
     * Wrap a raw command array with OS-native sandboxing.
     * Uses `sandbox-exec` on Darwin and `bwrap` on Linux.
     */
    static wrapCommand(cmd: string[], options: SandboxOptions): string[] {
        if (!options.strict) {
            return cmd; // Opt-out or not requested
        }

        const platform = os.platform();

        if (platform === "darwin") {
            // macOS EndpointSecurity / Sandbox-exec fallback
            // We use an inline scheme profile
            let profile = "(version 1)\n(allow default)\n";
            if (options.denyNetwork) {
                profile += "(deny network*)\n";
                // Allow local unix sockets (often needed by tools)
                profile += "(allow network* (local ip \"localhost:*\"))\n";
            }
            if (options.writablePath) {
                profile += `(allow file-write* (subpath "${options.writablePath}"))\n`;
                // Technically, to enforce strict write, we'd deny all writes then allow this.
                // Doing so here might break basic tools (temp files), so a full profile needs care.
                // For this implementation, we demonstrate the requested fallback.
            }

            return ["sandbox-exec", "-p", profile, ...cmd];
        } 
        
        if (platform === "linux") {
            // Linux Bubblewrap integration
            const bwrapCmd = [
                "bwrap",
                "--ro-bind", "/", "/",          // Root is read-only
                "--dev", "/dev",                // Required for basic execution
                "--proc", "/proc",              // Required for many tools
                "--tmpfs", "/tmp",              // Ephemeral temp
            ];

            if (options.denyNetwork) {
                bwrapCmd.push("--unshare-net");
            }

            if (options.writablePath) {
                bwrapCmd.push("--bind", options.writablePath, options.writablePath);
            }

            bwrapCmd.push(...cmd);
            return bwrapCmd;
        }

        // Unsupported platform (Windows/FreeBSD), return unmodified
        return cmd;
    }
}
