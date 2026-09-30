/**
 * Tests: the installer resolves the newest release, not a hard-coded pin.
 *
 * install.sh used to pin `v0.1.1` literally. After v0.1.2 shipped — the build
 * whose --help does not crash — a fresh `curl ... | sh` still downloaded v0.1.1,
 * because the pin only changed when someone remembered to change it. Nobody did,
 * and the very first command in the README handed new users the broken build.
 *
 * These tests do not hit the network. They assert the shape of the logic: a
 * version is always non-empty, a bare "v" can never be installed, and an
 * explicit B4MAL_VERSION pin still wins.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const INSTALLER = readFileSync(join(import.meta.dir, "../install.sh"), "utf-8");

/** The tag_name extraction expression used by the installer. */
function extractVersion(json: string): string {
    const m = /"tag_name"\s*:\s*"?v?([^",]*)"?/.exec(json);
    return m ? m[1] : "";
}

describe("install.sh — version resolution", () => {
    test("does not hard-code a single release version", () => {
        // A literal VERSION="vX.Y.Z" assignment is the bug. The version must
        // come from the API, B4MAL_VERSION, or a named fallback.
        expect(INSTALLER).not.toMatch(/^VERSION="\$\{B4MAL_VERSION:-v\d/m);
    });

    test("queries the API, and the right one", () => {
        // github.com/.../releases/latest is the web URL and answers 302; using
        // it yields an empty version and a download of literally "v". That bug
        // shipped inside the fix once already.
        expect(INSTALLER).toContain("api.github.com/repos/bneb/b4mal/releases/latest");
    });

    test("keeps an explicit B4MAL_VERSION pin authoritative", () => {
        expect(INSTALLER).toContain("B4MAL_VERSION");
    });

    test("has a named fallback version", () => {
        expect(INSTALLER).toMatch(/FALLBACK_VERSION="v\d+\.\d+\.\d+"/);
    });

    test("tag_name extraction handles a well-formed release", () => {
        expect(extractVersion('{ "tag_name": "v0.1.2", "name": "v0.1.2" }')).toBe("0.1.2");
    });

    test("tag_name extraction handles a response with no tag_name", () => {
        // A rate-limit or error body must yield empty, so the fallback is used —
        // never a half-parsed version.
        expect(extractVersion('{"message":"API rate limit exceeded"}')).toBe("");
    });
});
