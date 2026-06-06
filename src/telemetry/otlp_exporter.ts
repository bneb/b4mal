/**
 * @file otlp_exporter.ts
 * @description Exports standardized trace and metric data to OpenTelemetry collectors.
 */

export class OTLPExporter {
    constructor(
        private endpoint: string,
        private serviceName: string = "b4mal"
    ) {}

    async exportSpan(name: string, startTime: number, durationMs: number, attributes: Record<string, any> = {}) {
        const traceId = crypto.randomUUID().replace(/-/g, "");
        const spanId = crypto.randomUUID().replace(/-/g, "").substring(0, 16);
        const endTime = startTime + durationMs;

        const payload = {
            resourceSpans: [{
                resource: {
                    attributes: [
                        { key: "service.name", value: { stringValue: this.serviceName } }
                    ]
                },
                scopeSpans: [{
                    spans: [{
                        traceId,
                        spanId,
                        name,
                        kind: 1, // SPAN_KIND_INTERNAL
                        startTimeUnixNano: startTime * 1_000_000,
                        endTimeUnixNano: endTime * 1_000_000,
                        attributes: Object.entries(attributes).map(([k, v]) => ({
                            key: k,
                            value: { stringValue: String(v) }
                        }))
                    }]
                }]
            }]
        };

        try {
            await fetch(this.endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
        } catch {
        }
    }
}
