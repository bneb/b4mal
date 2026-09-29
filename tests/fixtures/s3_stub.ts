/**
 * Minimal in-memory S3-compatible object store.
 *
 * Exists so the L2 remote-cache path can be exercised end to end without AWS
 * credentials, network access, or a MinIO/Docker dependency. Bun.S3Client
 * addresses custom endpoints path-style (`<endpoint>/<bucket>/<key>`), which is
 * all this implements:
 *
 *   PUT     store the body
 *   GET     return it
 *   HEAD    existence + length
 *   DELETE  remove it
 *
 * Auth headers are ignored on purpose — the subject under test is the cache
 * protocol (push, existence check, pull, promote, restore), not SigV4.
 */
export interface S3Stub {
    port: number;
    url: string;
    /**
     * Stored objects, keyed by "<bucket>/<key>". Backed by plain ArrayBuffers
     * (not SharedArrayBuffer) so the views are valid `BodyInit` values.
     */
    objects: Map<string, Uint8Array<ArrayBuffer>>;
    /** Every request seen, in order, for assertions about which path was taken. */
    requests: { method: string; path: string }[];
    stop: () => void;
}

export function startS3Stub(options: { port?: number } = {}): S3Stub {
    const objects = new Map<string, Uint8Array<ArrayBuffer>>();
    const requests: { method: string; path: string }[] = [];

    const server = Bun.serve({
        port: options.port ?? 0,
        async fetch(req) {
            const url = new URL(req.url);
            const key = decodeURIComponent(url.pathname).replace(/^\//, "");
            requests.push({ method: req.method, path: key });

            switch (req.method) {
                case "PUT": {
                    // Copy out of the request buffer so the stored view is backed
                    // by a plain ArrayBuffer.
                    const buffer = await req.arrayBuffer();
                    objects.set(key, new Uint8Array(buffer));
                    return new Response(null, { status: 200 });
                }
                case "GET":
                case "HEAD": {
                    const value = objects.get(key);
                    if (!value) {
                        return new Response(
                            `<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>`,
                            { status: 404, headers: { "content-type": "application/xml" } },
                        );
                    }
                    // Wrap in a Blob: a valid BodyInit, unlike the Uint8Array
                    // view (which Bun accepts at runtime but the type
                    // definitions reject).
                    return new Response(req.method === "HEAD" ? null : new Blob([value]), {
                        status: 200,
                        headers: {
                            "content-length": String(value.length),
                            "content-type": "application/octet-stream",
                        },
                    });
                }
                case "DELETE": {
                    objects.delete(key);
                    return new Response(null, { status: 204 });
                }
                default:
                    return new Response(null, { status: 405 });
            }
        },
    });

    return {
        port: server.port ?? options.port ?? 0,
        url: `http://127.0.0.1:${server.port}`,
        objects,
        requests,
        stop: () => server.stop(true),
    };
}
