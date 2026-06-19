import * as readline from "readline/promises";
import * as fs from "fs/promises";
import * as path from "path";
import { TurboMigrator } from "../shim/turbo_migrator";
import { NxMigrator } from "../shim/nx_migrator";
import { LernaMigrator } from "../shim/lerna_migrator";
import { NpmMigrator } from "../shim/npm_migrator";

export class MigrationWizard {
    static async prompt(projectRoot: string): Promise<any[] | null> {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        try {
            const hasTurbo = await fs.access(path.join(projectRoot, "turbo.json")).then(() => true).catch(() => false);
            const hasNx = await fs.access(path.join(projectRoot, "nx.json")).then(() => true).catch(() => false);
            const hasLerna = await fs.access(path.join(projectRoot, "lerna.json")).then(() => true).catch(() => false);
            const hasPkg = await fs.access(path.join(projectRoot, "package.json")).then(() => true).catch(() => false);

            let detected = null;
            let migrator: () => any[] = () => [];

            if (hasTurbo) {
                detected = "Turborepo";
                migrator = () => TurboMigrator.migrate(path.join(projectRoot, "turbo.json"));
            } else if (hasNx) {
                detected = "Nx";
                migrator = () => NxMigrator.migrate(path.join(projectRoot, "nx.json"));
            } else if (hasLerna) {
                detected = "Lerna";
                migrator = () => LernaMigrator.migrate(path.join(projectRoot, "lerna.json"));
            } else if (hasPkg) {
                detected = "npm scripts";
                migrator = () => NpmMigrator.migrate(path.join(projectRoot, "package.json"));
            }

            if (!detected) {
                rl.close();
                return null;
            }

            // Non-interactive mode (CI, scripts): auto-accept migration
            if (!process.stdin.isTTY) {
              rl.close();
              return migrator();
            }

            console.log(`\nB4mal detected a legacy ${detected} configuration!`);
            const answer = await rl.question("Would you like to auto-migrate it into a highly-optimized b4mal.lock? (y/N): ");

            if (answer.trim().toLowerCase() === "y") {
                console.log(`\n[OK] Translating ${detected} configuration into B4mal tasks...`);
                rl.close();
                return migrator();
            } else {
                console.log("\nSkipping migration. Falling back to native AST discovery.");
                rl.close();
                return null;
            }
        } finally {
            rl.close();
        }
    }
}
