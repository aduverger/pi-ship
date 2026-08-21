import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { CommandOptions, CommandResult } from "./git.js";
import type { ShipRun } from "./types.js";
import { ShipWorkflow } from "./workflow.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createClonedRepository(
  workspace: string,
  name: string,
  changed: boolean,
  branch = "feature",
): Promise<string> {
  const fixtures = join(workspace, "_fixtures");
  const seed = join(fixtures, `${name}-seed`);
  const bare = join(fixtures, `${name}.git`);
  const repository = join(workspace, name);
  await mkdir(seed, { recursive: true });
  await git(seed, ["init", "-b", "main"]);
  await git(seed, ["config", "user.email", "test@example.com"]);
  await git(seed, ["config", "user.name", "Test"]);
  await writeFile(join(seed, "file.txt"), "base\n", "utf8");
  await git(seed, ["add", "."]);
  await git(seed, ["commit", "-m", "initial"]);
  await git(workspace, ["clone", "--bare", seed, bare]);
  await git(workspace, ["clone", bare, repository]);
  await git(repository, ["config", "user.email", "test@example.com"]);
  await git(repository, ["config", "user.name", "Test"]);

  if (branch !== "main") await git(repository, ["switch", "-c", branch]);
  if (changed) {
    await writeFile(join(repository, "file.txt"), "changed\n", "utf8");
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "-m", "change"]);
    await git(repository, ["push", "-u", "origin", branch]);
  }
  await git(repository, ["remote", "set-url", "origin", `https://github.com/example/${name}.git`]);
  return repository;
}

interface FakePiState {
  entries: Array<{ customType: string; data: unknown }>;
  messages: Array<{ content: string }>;
  commands: Array<{ command: string; args: string[] }>;
  existingPullRequest?: { number: number; url: string; isDraft: boolean };
}

function fakePi(state: FakePiState): ExtensionAPI {
  const exec = async (command: string, args: string[], options?: CommandOptions): Promise<CommandResult> => {
    state.commands.push({ command, args });
    if (command === "gh") {
      if (args[0] === "auth") return { stdout: "", stderr: "", code: 0, killed: false };
      if (args[0] === "pr" && args[1] === "list") {
        const pullRequests = state.existingPullRequest ? [state.existingPullRequest] : [];
        return { stdout: JSON.stringify(pullRequests), stderr: "", code: 0, killed: false };
      }
      if (args[0] === "pr" && args[1] === "create") {
        const repository = args[args.indexOf("--repo") + 1];
        return { stdout: `https://github.com/${repository}/pull/1\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "pr" && (args[1] === "edit" || args[1] === "ready")) {
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      throw new Error(`Unexpected gh command: ${args.join(" ")}`);
    }
    if (command === "git" && (args[0] === "fetch" || args[0] === "push")) {
      return { stdout: "", stderr: "", code: 0, killed: false };
    }
    try {
      const result = await execFileAsync(command, args, {
        cwd: options?.cwd,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message,
        code: typeof failure.code === "number" ? failure.code : 1,
        killed: false,
      };
    }
  };

  return {
    exec,
    appendEntry(customType: string, data?: unknown) {
      state.entries.push({ customType, data });
    },
    sendMessage(message: { content: string }) {
      state.messages.push(message);
    },
  } as unknown as ExtensionAPI;
}

function fakeContext(
  cwd: string,
  entries: SessionEntry[] = [],
  branchEntries: SessionEntry[] = entries,
): ExtensionCommandContext {
  return {
    cwd,
    waitForIdle: async () => {},
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => branchEntries,
    },
    ui: {
      setStatus: () => {},
      setWidget: () => {},
      notify: () => {},
    },
  } as unknown as ExtensionCommandContext;
}

const passingReviewer = async () => ({
  verdict: "pass" as const,
  summary: "Workspace contracts are consistent.",
  findings: [],
  residualRisks: [],
  suggestedTests: [],
});

async function completeApiSimplification(
  workflow: ShipWorkflow,
  ctx: ExtensionCommandContext,
  intent: string,
) {
  return workflow.handleReport(
    {
      action: "simplification-complete",
      intent,
      repositories: [
        {
          repository: "api",
          summary: "Updated the API.",
          tests: [{ command: "no test suite", status: "skipped", summary: "fixture repository" }],
        },
      ],
    },
    ctx,
    undefined,
  );
}

describe("ShipWorkflow", () => {
  it("rejects selected repositories checked out on their default branch", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ship-default-branch-"));
    await createClonedRepository(workspace, "api", false, "main");
    const state: FakePiState = { entries: [], messages: [], commands: [] };
    const workflow = new ShipWorkflow(fakePi(state));

    await expect(workflow.start("", fakeContext(workspace))).rejects.toThrow(
      "api is checked out on its default branch main",
    );
  });

  it("restores state only from the active session branch and clears stale state", () => {
    const first = {
      version: 1,
      id: "first-run",
      root: "/workspace",
      stage: "simplifying",
      createdAt: 1,
      updatedAt: 1,
      repositories: [],
      rebaseIndex: 0,
    } satisfies ShipRun;
    const second = { ...first, id: "second-run", stage: "drafting" as const };
    const firstEntry = { type: "custom", customType: "pi-ship-state", data: first } as SessionEntry;
    const secondEntry = { type: "custom", customType: "pi-ship-state", data: second } as SessionEntry;
    const state: FakePiState = { entries: [], messages: [], commands: [] };
    const workflow = new ShipWorkflow(fakePi(state));

    workflow.restore(fakeContext("/workspace", [firstEntry, secondEntry], [firstEntry]));
    expect(workflow.status(fakeContext("/workspace"))).toContain("first-ru");

    workflow.restore(fakeContext("/workspace", [firstEntry, secondEntry], [secondEntry]));
    expect(workflow.status(fakeContext("/workspace"))).toContain("second-r");

    workflow.restore(fakeContext("/workspace", [firstEntry, secondEntry], []));
    expect(workflow.status(fakeContext("/workspace"))).toBe("No /ship run is recorded in this session.");
  });

  it("discovers a workspace, rebases changed repos, and prompts scoped simplification", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ship-flow-"));
    const api = await createClonedRepository(workspace, "api", true);
    await createClonedRepository(workspace, "frontend", false);
    const state: FakePiState = { entries: [], messages: [], commands: [] };
    const workflow = new ShipWorkflow(fakePi(state));

    await workflow.start("", fakeContext(workspace));

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.content).toContain("### api");
    expect(state.messages[0]?.content).not.toContain("### frontend");
    expect(await execFileAsync("git", ["status", "--porcelain"], { cwd: api }).then((result) => result.stdout)).toBe("");
    const stored = state.entries.at(-1)?.data as ShipRun;
    expect(stored.stage).toBe("simplifying");
    expect(stored.repositories.map(({ name, changed }) => ({ name, changed }))).toEqual([
      { name: "api", changed: true },
      { name: "frontend", changed: false },
    ]);
  });

  it("reviews, force-with-lease pushes, and publishes without a final confirmation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ship-publish-"));
    await createClonedRepository(workspace, "api", true);
    await createClonedRepository(workspace, "frontend", false);
    const state: FakePiState = { entries: [], messages: [], commands: [] };
    const workflow = new ShipWorkflow(fakePi(state), passingReviewer);
    const ctx = fakeContext(workspace);
    await workflow.start("", ctx);

    const reviewed = await completeApiSimplification(workflow, ctx, "Ship the coordinated API change.");
    expect(reviewed.content[0]?.text).toContain("No actionable findings");
    expect(reviewed.content[0]?.text).toContain("Call ship_report with action \"publish\"");
    expect(reviewed.content[0]?.text).toContain("Do not include an Independent review section");
    expect(reviewed.content[0]?.text).not.toContain("## Review history");
    expect(state.entries.some((entry) => entry.customType === "pi-ship-review")).toBe(true);
    expect(workflow.status(ctx)).toContain("Independent review round 1 — pass");

    const published = await workflow.handleReport(
      {
        action: "publish",
        drafts: [
          {
            repository: "api",
            title: "Ship coordinated API change",
            body: "## Intent\n\nShip the coordinated API change.",
          },
        ],
      },
      ctx,
      undefined,
    );

    expect(published.content[0]?.text).toContain("https://github.com/example/api/pull/1");
    const push = state.commands.find(({ command, args }) => command === "git" && args[0] === "push");
    expect(push?.args.some((argument) => argument.startsWith("--force-with-lease=refs/heads/feature:"))).toBe(true);
    const createPullRequest = state.commands.find(
      ({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "create",
    );
    expect(createPullRequest?.args).toContain("--draft");
    const finalRun = state.entries.at(-1)?.data as ShipRun;
    expect(finalRun.stage).toBe("complete");
    expect(finalRun.repositories.find(({ name }) => name === "frontend")?.pullRequestUrl).toBeUndefined();
  });

  it("converts an existing open PR back to draft", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ship-existing-pr-"));
    await createClonedRepository(workspace, "api", true);
    const state: FakePiState = {
      entries: [],
      messages: [],
      commands: [],
      existingPullRequest: {
        number: 7,
        url: "https://github.com/example/api/pull/7",
        isDraft: false,
      },
    };
    const workflow = new ShipWorkflow(fakePi(state), passingReviewer);
    const ctx = fakeContext(workspace);
    await workflow.start("", ctx);
    await completeApiSimplification(workflow, ctx, "Ship the API change.");

    await workflow.handleReport(
      {
        action: "publish",
        drafts: [{ repository: "api", title: "Update API", body: "## Intent\n\nUpdate API." }],
      },
      ctx,
      undefined,
    );

    const markDraft = state.commands.find(
      ({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "ready",
    );
    expect(markDraft?.args).toEqual([
      "pr",
      "ready",
      "7",
      "--undo",
      "--repo",
      "example/api",
    ]);
    expect(
      state.commands.some(({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "create"),
    ).toBe(false);
  });

  it("requires a user turn after review before accepting decisions", async () => {
    const now = Date.now();
    const run: ShipRun = {
      version: 1,
      id: "run",
      root: "/workspace",
      stage: "awaiting-decision",
      createdAt: now - 1_000,
      updatedAt: now,
      intent: "intent",
      repositories: [],
      rebaseIndex: 0,
      review: {
        round: 1,
        completedAt: now,
        result: {
          verdict: "findings",
          summary: "review",
          findings: [
            {
              id: "R1",
              repository: "api",
              severity: "warning",
              file: "file.ts",
              title: "bug",
              evidence: "evidence",
              impact: "impact",
              recommendation: "fix it",
              confidence: "high",
              relatedRepositories: [],
            },
          ],
          residualRisks: [],
          suggestedTests: [],
        },
      },
    };
    run.repositories.push({
      name: "api",
      path: "/workspace/api",
      githubRepository: "example/api",
      branch: "feature",
      baseBranch: "main",
      baseRef: "refs/remotes/origin/main",
      initialHead: "head",
      head: "head",
      baseSha: "base",
      changed: true,
      simplifyScope: [],
      tests: [],
      pushed: false,
    });
    const storedEntry = { type: "custom", customType: "pi-ship-state", data: run } as SessionEntry;
    const state: FakePiState = { entries: [], messages: [], commands: [] };
    const workflow = new ShipWorkflow(fakePi(state));
    workflow.restore(fakeContext("/workspace", [storedEntry]));
    const decision = {
      action: "decision" as const,
      decisions: [{ findingId: "R1", action: "fix" as const, rationale: "approved" }],
    };

    await expect(
      workflow.handleReport(decision, fakeContext("/workspace", [storedEntry]), undefined),
    ).rejects.toThrow("user has not responded");

    const userEntry = {
      type: "message",
      id: "user",
      parentId: null,
      timestamp: new Date(now + 1).toISOString(),
      message: { role: "user", content: "fix it", timestamp: now + 1 },
    } as SessionEntry;
    const result = await workflow.handleReport(
      decision,
      fakeContext("/workspace", [storedEntry, userEntry]),
      undefined,
    );
    expect(result.content[0]?.text).toContain("Apply only these user-approved review fixes");
    const reviewEntry = state.entries.at(-1);
    expect(reviewEntry?.customType).toBe("pi-ship-review");
    expect(reviewEntry?.data).toMatchObject({ review: { decisions: decision.decisions } });
  });
});
