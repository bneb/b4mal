/**
 * Example: Hello Pipeline
 *
 * 5 parallel echo tasks demonstrating zero-YAML config and dependency wiring.
 */
// Note: Pipeline tasks are validated at runtime via Zod's parse().
// Static `satisfies Pipeline` is omitted because Zod infers non-optional
// types for fields that have .default() — they're required in the type
// even though Zod fills them in at runtime.
export default {
    name: "hello-pipeline",
    tasks: [
        { id: "greet", cmd: ["echo", "Hello from B4mal!"], env: {}, dependencies: [], timeout: 0 },
        { id: "world", cmd: ["echo", "World"], env: {}, dependencies: ["greet"], timeout: 0 },
        { id: "parallel-a", cmd: ["echo", "I run in parallel with B"], env: {}, dependencies: [], timeout: 0 },
        { id: "parallel-b", cmd: ["echo", "I run in parallel with A"], env: {}, dependencies: [], timeout: 0 },
        {
            id: "finale",
            cmd: ["echo", "All done."],
            env: {},
            dependencies: ["world", "parallel-a", "parallel-b"],
            timeout: 0,
        },
    ],
};
