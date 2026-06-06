// B4mal v2.0.0 — SSE Streaming Engine
//
// Thread-safe broadcaster that allows multiple clients (IDE, Browser, Agents)
// to listen to the engine's pulse in real time.
//
// Uses an EventTarget-based pub/sub to decouple broadcast from stream writing,
// which avoids Bun's ReadableStream buffering issues with SSE.

type SSEWriter = (payload: string) => void;

export class StreamEngine {
    private static writers: Set<SSEWriter> = new Set();

    /**
     * Broadcast an event to all connected SSE clients.
     */
    static broadcast(event: string, data: object): void {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const writer of this.writers) {
            try {
                writer(payload);
            } catch {
                this.writers.delete(writer);
            }
        }
    }

    /**
     * Get the current number of active connections.
     */
    static getActiveClients(): number {
        return this.writers.size;
    }

    /**
     * Force-close all writers and clear the set.
     * Used for clean test teardown.
     */
    static reset(): void {
        this.writers.clear();
    }

    /**
     * Manually register a writer callback.
     * Used by the MCP Agentic Bridge and for testing.
     */
    static addWriter(writer: SSEWriter): void {
        this.writers.add(writer);
    }

    /**
     * Manually remove a writer callback.
     */
    static removeWriter(writer: SSEWriter): void {
        this.writers.delete(writer);
    }

    /**
     * Generate a streaming SSE Response.
     * Uses a direct-write callback pattern that bypasses Bun's ReadableStream buffering.
     */
    static handler(): Response {
        let writerFn: SSEWriter;

        const stream = new ReadableStream({
            start: (controller) => {
                writerFn = (payload: string) => {
                    try {
                        controller.enqueue(new TextEncoder().encode(payload));
                    } catch {
                        StreamEngine.writers.delete(writerFn);
                    }
                };
                StreamEngine.writers.add(writerFn);
            },
            cancel: () => {
                StreamEngine.writers.delete(writerFn);
            }
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
                "X-Accel-Buffering": "no" // Disable nginx/proxy buffering
            }
        });
    }
}
