import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { GoIngester } from "../src/discovery/go_ingester";
import * as fs from "fs";

describe("Go Ingester", () => {
    const testDir = ".b4mal_go_test";

    beforeAll(() => {
        fs.mkdirSync(testDir, { recursive: true });
        fs.writeFileSync(`${testDir}/go.mod`, "module example.com/m");
        fs.writeFileSync(`${testDir}/main.go`, "package main");
        fs.writeFileSync(`${testDir}/main_test.go`, "package main");
    });

    afterAll(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    test("detects go.mod and creates pipeline", () => {
        const ingester = new GoIngester();
        const pipeline = ingester.ingest(testDir);

        expect(pipeline).not.toBeNull();
        expect(pipeline!.tasks.find(t => t.id === "build")!.cmd).toEqual(["go", "build", "./..."]);
        expect(pipeline!.tasks.find(t => t.id === "test")!.cmd).toEqual(["go", "test", "./..."]);
    });
});
