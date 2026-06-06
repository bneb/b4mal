#!/usr/bin/env bun
/**
 * B4mal v1.2.0 — Certificate Authority Bootstrap
 *
 * Generates a private Root CA, server cert, and client cert for mTLS.
 * Usage: bun run scripts/gen-certs.ts [--out <dir>]
 */

const CERT_DIR = process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]
    : "certs";

async function run(cmd: string[], label: string): Promise<void> {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr as ReadableStream).text();
        throw new Error(`${label} failed (exit ${exitCode}): ${stderr}`);
    }
}

async function main() {
    const { mkdirSync, existsSync } = require("fs");
    if (!existsSync(CERT_DIR)) mkdirSync(CERT_DIR, { recursive: true });

    console.log(`Generating certificates in ${CERT_DIR}/`);

    // 1. Root CA (2048-bit RSA)
    console.log("  [1/3] Root CA...");
    await run(["openssl", "genrsa", "-out", `${CERT_DIR}/ca.key`, "2048"], "CA key");
    await run([
        "openssl", "req", "-new", "-x509",
        "-key", `${CERT_DIR}/ca.key`,
        "-out", `${CERT_DIR}/ca.crt`,
        "-days", "365",
        "-subj", "/CN=b4mal-core-ca/O=b4mal",
    ], "CA cert");

    // 2. Server cert (signed by CA, SAN for localhost)
    console.log("  [2/3] Server cert...");
    await run(["openssl", "genrsa", "-out", `${CERT_DIR}/server.key`, "2048"], "Server key");
    await run([
        "openssl", "req", "-new",
        "-key", `${CERT_DIR}/server.key`,
        "-out", `${CERT_DIR}/server.csr`,
        "-subj", "/CN=localhost/O=b4mal-node",
    ], "Server CSR");

    await Bun.write(
        `${CERT_DIR}/san.cnf`,
        "[v3_req]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n"
    );

    await run([
        "openssl", "x509", "-req",
        "-in", `${CERT_DIR}/server.csr`,
        "-CA", `${CERT_DIR}/ca.crt`, "-CAkey", `${CERT_DIR}/ca.key`,
        "-CAcreateserial",
        "-out", `${CERT_DIR}/server.crt`,
        "-days", "365",
        "-extfile", `${CERT_DIR}/san.cnf`, "-extensions", "v3_req",
    ], "Server cert sign");

    // 3. Client cert (signed by same CA)
    console.log("  [3/3] Client cert...");
    await run(["openssl", "genrsa", "-out", `${CERT_DIR}/client.key`, "2048"], "Client key");
    await run([
        "openssl", "req", "-new",
        "-key", `${CERT_DIR}/client.key`,
        "-out", `${CERT_DIR}/client.csr`,
        "-subj", "/CN=b4mal-cli/O=b4mal-core",
    ], "Client CSR");
    await run([
        "openssl", "x509", "-req",
        "-in", `${CERT_DIR}/client.csr`,
        "-CA", `${CERT_DIR}/ca.crt`, "-CAkey", `${CERT_DIR}/ca.key`,
        "-CAcreateserial",
        "-out", `${CERT_DIR}/client.crt`,
        "-days", "365",
    ], "Client cert sign");

    console.log("\n  Certificates generated:");
    console.log(`    CA:     ${CERT_DIR}/ca.crt + ca.key`);
    console.log(`    Server: ${CERT_DIR}/server.crt + server.key`);
    console.log(`    Client: ${CERT_DIR}/client.crt + client.key`);
    console.log("\n  Start the Core Node with:");
    console.log(`    b4mal-node --cert-dir ${CERT_DIR}`);
}

main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
});
