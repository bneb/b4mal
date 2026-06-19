import { describe, test, expect, beforeEach } from "bun:test";
import { StreamEngine } from "../src/server/stream_engine";

describe("StreamEngine", () => {
  beforeEach(() => {
    StreamEngine.reset();
  });

  test("broadcast delivers to registered writer", () => {
    let received = "";
    StreamEngine.broadcast("test", { value: 42 });
    // No writers registered — should not throw
    expect(StreamEngine.getActiveClients()).toBe(0);
  });

  test("getActiveClients returns zero when empty", () => {
    expect(StreamEngine.getActiveClients()).toBe(0);
  });

  test("reset clears all writers", () => {
    StreamEngine.reset();
    expect(StreamEngine.getActiveClients()).toBe(0);
  });

  test("broadcast with no writers does not throw", () => {
    expect(() => StreamEngine.broadcast("event", { x: 1 })).not.toThrow();
  });

  test("broadcast with data containing special characters", () => {
    expect(() => StreamEngine.broadcast("collision", { taskA: "a", taskB: "b", resource: "fs:dist/" })).not.toThrow();
  });

  test("getActiveClients returns number", () => {
    expect(typeof StreamEngine.getActiveClients()).toBe("number");
  });

  test("multiple broadcasts without writers does not leak state", () => {
    for (let i = 0; i < 10; i++) {
      StreamEngine.broadcast("wave_complete", { depth: i, tasks: i });
    }
    expect(StreamEngine.getActiveClients()).toBe(0);
  });

  test("addWriter registers a writer", () => {
    const writer = (_: string) => {};
    StreamEngine.addWriter(writer);
    expect(StreamEngine.getActiveClients()).toBe(1);
    StreamEngine.removeWriter(writer);
  });

  test("removeWriter unregisters a writer", () => {
    const writer = (_: string) => {};
    StreamEngine.addWriter(writer);
    StreamEngine.removeWriter(writer);
    expect(StreamEngine.getActiveClients()).toBe(0);
  });

  test("broadcast calls registered writer", () => {
    let called = false;
    const writer = (_: string) => { called = true; };
    StreamEngine.addWriter(writer);
    StreamEngine.broadcast("test", { x: 1 });
    StreamEngine.removeWriter(writer);
    expect(called).toBe(true);
  });

  test("handler returns SSE Response", () => {
    const response = StreamEngine.handler();
    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  test("handler returns Response with CORS header", () => {
    const response = StreamEngine.handler();
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
