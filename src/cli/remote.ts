/**
 * b4mal remote — L2 cache management commands.
 */
import { S3Adapter } from "../remote/s3_adapter";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
};

export class RemoteCommand {
  static async execute(args: string[]): Promise<void> {
    const sub = args[0];
    if (sub === "status" || !sub) {
      await this.status();
    } else {
      process.stderr.write(`${c.red}[FAIL] Unknown remote command: ${sub}. Try: b4mal remote status${c.reset}\n`);
      process.exit(1);
    }
  }

  private static async status(): Promise<void> {
    const bucket = process.env.B4MAL_CACHE_BUCKET;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const endpoint = process.env.AWS_S3_ENDPOINT;

    process.stdout.write(`\n${c.bold}L2 Remote Cache Status${c.reset}\n\n`);

    if (!bucket || !accessKeyId) {
      process.stdout.write(`${c.dim}  Not configured.${c.reset}\n`);
      process.stdout.write(`${c.dim}  Set B4MAL_CACHE_BUCKET + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY to enable.${c.reset}\n\n`);
      process.exit(0);
    }

    process.stdout.write(`${c.dim}  Endpoint:${c.reset} ${endpoint || "AWS S3 (default)"}\n`);
    process.stdout.write(`${c.dim}  Bucket:  ${c.reset} ${bucket}\n`);
    if (process.env.B4MAL_CACHE_ORG) {
      process.stdout.write(`${c.dim}  Org:     ${c.reset} ${process.env.B4MAL_CACHE_ORG}\n`);
    }

    process.stdout.write(`${c.dim}  Checking connectivity...${c.reset}\n`);
    const adapter = new S3Adapter({
      bucket,
      region: process.env.AWS_REGION || "us-east-1",
      accessKeyId,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      ...(endpoint ? { endpoint } : {}),
      ...(process.env.B4MAL_CACHE_ORG ? { orgId: process.env.B4MAL_CACHE_ORG } : {}),
    });

    const ok = await adapter.validate();
    if (ok) {
      process.stdout.write(`${c.green}  ✓ Connected${c.reset}\n\n`);
    } else {
      process.stdout.write(`${c.yellow}  ⚠ Connection failed — check credentials and bucket permissions${c.reset}\n\n`);
    }
  }
}
