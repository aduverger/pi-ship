import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import piShip from "./index.js";
import type { ShipRun } from "./types.js";

function run(id: string, stage: ShipRun["stage"]): ShipRun {
  return {
    version: 1,
    id,
    root: "/workspace",
    stage,
    createdAt: 1,
    updatedAt: 1,
    repositories: [],
    rebaseIndex: 0,
  };
}

function entry(shipRun: ShipRun): SessionEntry {
  return { type: "custom", customType: "pi-ship-state", data: shipRun } as SessionEntry;
}

describe("pi-ship session events", () => {
  it("restores workflow guidance after session-tree navigation", async () => {
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const pi = {
      on(event: string, handler: (...args: any[]) => any) {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
      },
      registerEntryRenderer() {},
      registerCommand() {},
      registerTool() {},
      exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    } as unknown as ExtensionAPI;
    piShip(pi);

    let branch = [entry(run("first", "simplifying"))];
    const ctx = {
      sessionManager: {
        getBranch: () => branch,
        getEntries: () => branch,
      },
      ui: {
        setStatus: () => {},
        setWidget: () => {},
      },
    } as unknown as ExtensionContext;

    await handlers.get("session_start")?.[0]?.({}, ctx);
    const beforeAgentStart = handlers.get("before_agent_start")?.[0];
    expect(beforeAgentStart?.({ systemPrompt: "base" }, ctx)?.systemPrompt).toContain("simplifying");

    branch = [entry(run("second", "drafting"))];
    await handlers.get("session_tree")?.[0]?.({}, ctx);
    expect(beforeAgentStart?.({ systemPrompt: "base" }, ctx)?.systemPrompt).toContain("ready to publish");

    branch = [];
    await handlers.get("session_tree")?.[0]?.({}, ctx);
    expect(beforeAgentStart?.({ systemPrompt: "base" }, ctx)).toBeUndefined();
  });
});
