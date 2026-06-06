// B4mal — First-Run Experience
//
// Simple welcome screen for new users.

export class WelcomeCommand {
    static async execute(): Promise<void> {
        console.log("\n  Welcome to B4mal.");
        console.log("  Your Cache Miss Overhead is currently being audited.");
        console.log("  Once tasks complete, run \x1b[36mb4mal report --audit <json>\x1b[0m to view your \x1b[1moptimization_report.md\x1b[0m.\n");
    }
}
