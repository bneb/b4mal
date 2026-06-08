export interface TraceEvent {
    type: "exec" | "open" | "chdir";
    pid: number;
    ppid?: number;
    cmd?: string[];
    path?: string;
    mode?: "r" | "w" | "rw";
    cwd?: string;
}

export interface ISystemTracer {
    trace(cmd: string): Promise<TraceEvent[]>;
}
