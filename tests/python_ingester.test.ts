import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { PythonIngester } from "../src/discovery/python_ingester";
import * as fs from "fs";

describe("Python Ingester", () => {
    const testDir = ".b4mal_py_test";

    beforeAll(() => {
        fs.mkdirSync(testDir, { recursive: true });
        fs.writeFileSync(`${testDir}/requirements.txt`, "pytest");
        fs.writeFileSync(`${testDir}/main.py`, "print('hello')");
        fs.mkdirSync(`${testDir}/tests`, { recursive: true });
        fs.writeFileSync(`${testDir}/tests/test_main.py`, "def test_a(): pass");
    });

    afterAll(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    test("detects requirements.txt and creates pipeline", () => {
        const ingester = new PythonIngester();
        const pipeline = ingester.ingest(testDir);

        expect(pipeline).not.toBeNull();
        expect(pipeline!.tasks.find(t => t.id === "install")!.cmd).toEqual(["pip", "install", "-r", "requirements.txt"]);
        expect(pipeline!.tasks.find(t => t.id === "test")!.cmd).toEqual(["pytest"]);
    });
});
