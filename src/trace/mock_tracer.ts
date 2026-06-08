import type { ISystemTracer, TraceEvent } from "./types";

export class MockTracer implements ISystemTracer {
    private events: TraceEvent[];

    constructor(events: TraceEvent[]) {
        this.events = events;
    }

    public async trace(cmd: string): Promise<TraceEvent[]> {
        return this.events;
    }
}
