import { attest } from "../../src/shims/b4mal";

async function integrate() {
    await attest("WebIntegrator", ["fs:write:db/local.sqlite", "env:PORT"], async () => {
        console.log("      [TypeScript] WebIntegrator: Attesting claims...");
        await new Promise((resolve) => setTimeout(resolve, 1000));
        console.log("      [TypeScript] WebIntegrator: Integration complete.");
    });
}

integrate().catch(console.error);
