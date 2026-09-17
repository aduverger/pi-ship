import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { CommandOptions, CommandResult } from "./git.js";
import type { ReviewerManifest, ShipRun } from "./types.js";
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
  existingPullRequest?: { number: number; url: string; isDraft?: boolean };
  failCommitOnceIn?: string;
}

function latestRun(state: FakePiState): ShipRun {
  for (let index = state.entries.length - 1; index >= 0; index--) {
    const entry = state.entries[index];
    if (entry?.customType === "pi-ship-state") return entry.data as ShipRun;
  }
  throw new Error("No stored ship run.");
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
      if (args[0] === "pr" && args[1] === "view") {
        return {
          stdout: `${state.existingPullRequest?.isDraft ?? true}\n`,
          stderr: "",
          code: 0,
          killed: false,
        };
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
    if (command === "git" && args[0] === "commit" && basename(options?.cwd ?? "") === state.failCommitOnceIn) {
      delete state.failCommitOnceIn;
      return { stdout: "", stderr: "commit hook failed", code: 1, killed: false };
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

const blockingReviewer = async () => ({
  verdict: "findings" as const,
  summary: "One blocking finding.",
  findings: [
    {
      id: "R1",
      repository: "api",
      severity: "blocking" as const,
      file: "file.txt",
      title: "Preserve the API contract",
      evidence: "The changed fixture breaks the contract.",
      impact: "Existing clients can fail.",
      recommendation: "Restore compatibility before merging.",
      confidence: "high" as const,
      relatedRepositories: [],
    },
  ],
  residualRisks: [],
  suggestedTests: [],
});

async function reportApiSimplification(
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

async function completeApiPreparation(
  workflow: ShipWorkflow,
  ctx: ExtensionCommandContext,
  intent: string,
) {
  await reportApiSimplification(workflow, ctx, intent);
  return workflow.handleReport(
    {
      action: "testing-complete",
      repositories: [
        {
          repository: "api",
          summary: "Updated the API.",
          tests: [{ command: "no test suite", status: "skipped", summary: "fixture repository" }],
          testCuration: {
            added: 0,
            rewritten: 0,
            consolidated: 0,
            removed: 0,
            behaviors: ["API contract"],
            remainingGaps: [],
          },
        },
      ],
    },
    ctx,
    undefined,
  );
}

describe("ShipWorkflow", () => {
  it("allows a clean synchronized default branch as workspace context", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ship-default-context-"));
    await createClonedRepository(workspace, "config", false, "main");
    const state: FakePiState = { entries: [], messages: [], commands: [] };
    const workflow = new ShipWorkflow(fakePi(state));
    const ctx = fakeContext(workspace);

    await workflow.start("", ctx);

    const stored = latestRun(state);
    expect(stored.stage).toBe("complete");
    expect(stored.repositories[0]).toMatchObject({
      name: "config",
      branch: "main",
      changed: false,
      contextOnly: true,
    });
    expect(workflow.status(ctx)).toContain("workspace context");
  });

  it("rejects committed changes on a default-branch context repository", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ship-default-commits-"));
    const config = await createClonedRepository(workspace, "config", false, "main");
    await writeFile(join(config, "file.txt"), "local change\n", "utf8");
    await git(config, ["add", "."]);
    await git(config, ["commit", "-m", "local change"]);
    const state: FakePiState = { entries: [], messages: [], commands: [] };
    const workflow = new ShipWorkflow(fakePi(state));

    await expect(workflow.start("", fakeContext(workspace))).rejects.toThrow(
      "default-branch context repositories cannot contain committed changes",
    );
  });

  it("rejects uncommitted changes on a default-branch context repository", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ship-default-dirty-"));
    const config = await createClonedRepository(workspace, "config", false, "main");
    await writeFile(join(config, "file.txt"), "uncommitted change\n", "utf8");
    const state: FakePiState = { entries: [], messages: [], commands: [] };
    const workflow = new ShipWorkflow(fakePi(state));

    await expect(workflow.start("", fakeContext(workspace))).rejects.toThrow(
      "Every selected repository must be clean and committed. Dirty: config",
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
    const stored = latestRun(state);
    expect(stored.stage).toBe("simplifying");
    expect(stored.repositories.map(({ name, changed }) => ({ name, changed }))).toEqual([
      { name: "api", changed: true },
      { name: "frontend", changed: false },
    ]);
  });

  it("curates and commits tests between simplification and independent review", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ship-testing-"));
    const api = await createClonedRepository(workspace, "api", true);
    const state: FakePiState = { entries: [], messages: [], commands: [] };
    let reviewerManifest: ReviewerManifest | undefined;
    const reviewer = async (_ctx: unknown, manifest: ReviewerManifest) => {
      reviewerManifest = manifest;
      return passingReviewer();
    };
    const workflow = new ShipWorkflow(fakePi(state), reviewer);
    const ctx = fakeContext(workspace);
    await workflow.start("", ctx);

    const testing = await reportApiSimplification(workflow, ctx, "Ship the API change.");
    expect(testing.content[0]?.text).toContain("durable confidence");
    expect(testing.content[0]?.text).toContain("behavior-preserving refactor");
    expect(latestRun(state).stage).toBe("testing");

    await writeFile(join(api, "file.test.ts"), "export {};\n", "utf8");
    const report = {
      action: "testing-complete" as const,
      repositories: [
        {
          repository: "api",
          summary: "Updated the API and added contract coverage.",
          tests: [{ command: "no test suite", status: "skipped" as const, summary: "fixture repository" }],
          testCuration: {
            added: 1,
            rewritten: 0,
            consolidated: 0,
            removed: 0,
            behaviors: ["API contract"],
            remainingGaps: [],
          },
        },
      ],
    };
    await expect(workflow.handleReport(report, ctx, undefined)).rejects.toThrow(
      "Test report for api requires a commit message",
    );

    const reviewed = await workflow.handleReport(
      {
        ...report,
        repositories: [{ ...report.repositories[0]!, commitMessage: "test: cover API contract" }],
      },
      ctx,
      undefined,
    );

    expect(reviewed.content[0]?.text).toContain("No actionable findings");
    expect(await execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: api }).then(({ stdout }) => stdout.trim())).toBe(
      "test: cover API contract",
    );
    expect(reviewerManifest?.repositories[0]?.testCuration).toMatchObject({ added: 1, removed: 0 });
  });

  it("resumes test-curation commits after a later repository commit fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ship-testing-resume-"));
    const api = await createClonedRepository(workspace, "api", true);
    const frontend = await createClonedRepository(workspace, "frontend", true);
    const state: FakePiState = { entries: [], messages: [], commands: [] };
    const ctx = fakeContext(workspace);
    const workflow = new ShipWorkflow(fakePi(state), passingReviewer);
    await workflow.start("", ctx);
    await workflow.handleReport(
      {
        action: "simplification-complete",
        intent: "Update API and frontend coverage.",
        repositories: ["api", "frontend"].map((repository) => ({
          repository,
          summary: `Updated ${repository}.`,
          tests: [{ command: "no tests", status: "skipped" as const, summary: "fixture repository" }],
        })),
      },
      ctx,
      undefined,
    );

    await writeFile(join(api, "file.test.ts"), "export {};\n", "utf8");
    await writeFile(join(frontend, "file.test.ts"), "export {};\n", "utf8");
    const reports = ["api", "frontend"].map((repository) => ({
      repository,
      summary: `Updated ${repository} with contract coverage.`,
      commitMessage: `test: cover ${repository} contract`,
      tests: [{ command: "no tests", status: "skipped" as const, summary: "fixture repository" }],
      testCuration: {
        added: 1,
        rewritten: 0,
        consolidated: 0,
        removed: 0,
        behaviors: [`${repository} contract`],
        remainingGaps: [],
      },
    }));
    state.failCommitOnceIn = "frontend";

    await expect(
      workflow.handleReport({ action: "testing-complete", repositories: reports }, ctx, undefined),
    ).rejects.toThrow("commit hook failed");
    expect(await execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: api }).then(({ stdout }) => stdout.trim())).toBe(
      "test: cover api contract",
    );
    expect(await execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: frontend }).then(({ stdout }) => stdout.trim())).toBe(
      "change",
    );

    const storedEntry = {
      type: "custom",
      customType: "pi-ship-state",
      data: structuredClone(latestRun(state)),
    } as SessionEntry;
    const resumed = new ShipWorkflow(fakePi(state), passingReviewer);
    const resumedContext = fakeContext(workspace, [storedEntry]);
    resumed.restore(resumedContext);
    await resumed.resume(resumedContext);

    const reviewed = await resumed.handleReport(
      { action: "testing-complete", repositories: reports },
      resumedContext,
      undefined,
    );
    expect(reviewed.content[0]?.text).toContain("No actionable findings");
    expect(await execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: frontend }).then(({ stdout }) => stdout.trim())).toBe(
      "test: cover frontend contract",
    );
  });

  it("persists auto mode and applies agent decisions without a user response", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ship-auto-"));
    await createClonedRepository(workspace, "api", true);
    const state: FakePiState = { entries: [], messages: [], commands: [] };
    const workflow = new ShipWorkflow(fakePi(state), blockingReviewer);
    const ctx = fakeContext(workspace);

    await workflow.start("api --auto", ctx);
    const reviewed = await completeApiPreparation(workflow, ctx, "Ship the API change.");

    expect(reviewed.content[0]?.text).toContain("call ship_report with action \"decision\"");
    expect(reviewed.content[0]?.text).toContain("Do not wait for user input");
    expect(reviewed.content[0]?.text).toContain("authoritative fixtures");
    expect(reviewed.content[0]?.text).toContain("realistically reachable, or theoretical");
    expect(workflow.status(ctx)).toContain("auto, review round 1/5");
    expect(latestRun(state).auto).toBe(true);

    const decision = await workflow.handleReport(
      {
        action: "decision",
        decisions: [{ findingId: "R1", action: "fix", rationale: "Directly reachable contract break." }],
      },
      ctx,
      undefined,
    );

    expect(decision.content[0]?.text).toContain("Apply only these approved review fixes");
    expect(latestRun(state).stage).toBe("fixing");
  });

  it("reviews, force-with-lease pushes, and publishes without a final confirmation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ship-publish-"));
    await createClonedRepository(workspace, "api", true);
    await createClonedRepository(workspace, "frontend", false, "main");
    const state: FakePiState = { entries: [], messages: [], commands: [] };
    let reviewerManifest: ReviewerManifest | undefined;
    const reviewer = async (_ctx: unknown, manifest: ReviewerManifest) => {
      reviewerManifest = manifest;
      return passingReviewer();
    };
    const workflow = new ShipWorkflow(fakePi(state), reviewer);
    const ctx = fakeContext(workspace);
    await workflow.start("", ctx);

    const reviewed = await completeApiPreparation(workflow, ctx, "Ship the coordinated API change.");
    expect(reviewed.content[0]?.text).toContain("No actionable findings");
    expect(reviewed.content[0]?.text).toContain("Call ship_report with action \"publish\"");
    expect(reviewed.content[0]?.text).toContain("Do not include an Independent review section");
    expect(reviewed.content[0]?.text).toContain("Include a Cross-repository context section only when");
    expect(reviewed.content[0]?.text).toContain("omit it for a single-repository ship");
    expect(reviewed.content[0]?.text).toContain("combine recurring routine gates");
    expect(reviewed.content[0]?.text).toContain("category names instead of exact commands");
    expect(reviewed.content[0]?.text).toContain("do not mention the Simplify or Test workflow phases");
    expect(reviewed.content[0]?.text).not.toContain("## Review history");
    expect(state.entries.some((entry) => entry.customType === "pi-ship-review")).toBe(true);
    expect(workflow.status(ctx)).toContain("Independent review round 1 — pass");
    expect(reviewerManifest?.repositories.map(({ name }) => name)).toEqual(["api"]);

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
    const finalRun = latestRun(state);
    expect(finalRun.stage).toBe("complete");
    expect(finalRun.repositories.find(({ name }) => name === "frontend")?.pullRequestUrl).toBeUndefined();
  });

  it("preserves fifth-round outcomes through a base advance and returns an affected ready PR to draft", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ship-auto-cap-"));
    const api = await createClonedRepository(workspace, "api", true);
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
    let reviewRound = 0;
    const reviewer = async () => {
      reviewRound += 1;
      if (reviewRound > 1) return passingReviewer();
      const review = await blockingReviewer();
      return {
        ...review,
        findings: [
          ...review.findings,
          {
            id: "R2",
            repository: "api",
            severity: "warning" as const,
            file: "file.txt",
            title: "Handle a theoretical edge case",
            evidence: "The scenario is not reachable through the current API.",
            impact: "A hypothetical caller could receive stale data.",
            recommendation: "Add a speculative fallback.",
            confidence: "medium" as const,
            relatedRepositories: [],
          },
        ],
      };
    };
    const workflow = new ShipWorkflow(fakePi(state), reviewer);
    const ctx = fakeContext(workspace);
    await workflow.start("--auto", ctx);
    await completeApiPreparation(workflow, ctx, "Ship the API change.");

    const cappedRun = structuredClone(latestRun(state));
    cappedRun.stage = "awaiting-decision";
    cappedRun.review!.round = 5;
    cappedRun.repositories[0]!.pullRequestUrl = "https://github.com/example/api/pull/7";
    const cappedEntry = { type: "custom", customType: "pi-ship-state", data: cappedRun } as SessionEntry;
    workflow.restore(fakeContext(workspace, [cappedEntry]));

    await expect(
      workflow.handleReport(
        {
          action: "decision",
          decisions: [
            { findingId: "R1", action: "fix", rationale: "Fix the contract." },
            { findingId: "R2", action: "accept", rationale: "The current API prevents this theoretical case." },
          ],
        },
        ctx,
        undefined,
      ),
    ).rejects.toThrow("record fix-worthy findings as defer");

    const drafting = await workflow.handleReport(
      {
        action: "decision",
        decisions: [
          { findingId: "R1", action: "defer", rationale: "Restore compatibility in follow-up." },
          { findingId: "R2", action: "accept", rationale: "The current API prevents this theoretical case." },
        ],
      },
      ctx,
      undefined,
    );
    expect(drafting.content[0]?.text).toContain("autonomous review limit was reached");
    expect(drafting.content[0]?.text).toContain("[blocking] api: Preserve the API contract");
    expect(drafting.content[0]?.text).toContain("Follow-up: Restore compatibility in follow-up.");
    expect(drafting.content[0]?.text).toContain("Tradeoff: The current API prevents this theoretical case.");
    expect(drafting.content[0]?.text).not.toContain("Add a speculative fallback");

    const baseSha = await execFileAsync("git", ["rev-parse", "refs/remotes/origin/main"], { cwd: api })
      .then(({ stdout }) => stdout.trim());
    const baseTree = await execFileAsync("git", ["rev-parse", `${baseSha}^{tree}`], { cwd: api })
      .then(({ stdout }) => stdout.trim());
    const advancedBaseSha = await execFileAsync(
      "git",
      ["commit-tree", baseTree, "-p", baseSha, "-m", "advance base"],
      { cwd: api },
    ).then(({ stdout }) => stdout.trim());
    await git(api, ["update-ref", "refs/remotes/origin/main", advancedBaseSha]);

    const deferredPublication = await workflow.handleReport(
      {
        action: "publish",
        drafts: [{ repository: "api", title: "Update API", body: "## Risks or follow-ups\n\nRestore compatibility." }],
      },
      ctx,
      undefined,
    );
    expect(deferredPublication.content[0]?.text).toContain("A default branch advanced after review");

    const rereviewed = await completeApiPreparation(workflow, ctx, "Ship the API change.");
    expect(rereviewed.content[0]?.text).toContain("No actionable findings");
    expect(rereviewed.content[0]?.text).toContain("Follow-up: Restore compatibility in follow-up.");
    expect(rereviewed.content[0]?.text).toContain("Tradeoff: The current API prevents this theoretical case.");

    await workflow.handleReport(
      {
        action: "publish",
        drafts: [{ repository: "api", title: "Update API", body: "## Risks or follow-ups\n\nRestore compatibility." }],
      },
      ctx,
      undefined,
    );

    const readyCommand = state.commands.find(
      ({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "ready",
    );
    expect(readyCommand?.args).toEqual([
      "pr",
      "ready",
      "https://github.com/example/api/pull/7",
      "--repo",
      "example/api",
      "--undo",
    ]);
  });

  it("updates an existing PR without changing its readiness", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ship-existing-pr-"));
    await createClonedRepository(workspace, "api", true);
    const state: FakePiState = {
      entries: [],
      messages: [],
      commands: [],
      existingPullRequest: {
        number: 7,
        url: "https://github.com/example/api/pull/7",
      },
    };
    const workflow = new ShipWorkflow(fakePi(state), passingReviewer);
    const ctx = fakeContext(workspace);
    await workflow.start("", ctx);
    await completeApiPreparation(workflow, ctx, "Ship the API change.");

    await workflow.handleReport(
      {
        action: "publish",
        drafts: [{ repository: "api", title: "Update API", body: "## Intent\n\nUpdate API." }],
      },
      ctx,
      undefined,
    );

    const pullRequestCommands = state.commands.filter(
      ({ command, args }) => command === "gh" && args[0] === "pr",
    );
    expect(pullRequestCommands.some(({ args }) => args[1] === "ready")).toBe(false);
    expect(pullRequestCommands.some(({ args }) => args[1] === "create")).toBe(false);
    expect(pullRequestCommands.some(({ args }) => args[1] === "edit")).toBe(true);
  });

  it("presents findings with context and scopes test durability to review fixes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ship-review-fix-summary-"));
    const api = await createClonedRepository(workspace, "api", true);
    const state: FakePiState = { entries: [], messages: [], commands: [] };
    let reviewRound = 0;
    const reviewerManifests: ReviewerManifest[] = [];
    const reviewer = async (_ctx: unknown, manifest: ReviewerManifest) => {
      reviewerManifests.push(manifest);
      reviewRound += 1;
      if (reviewRound > 1) return passingReviewer();
      return {
        verdict: "findings" as const,
        summary: "One finding.",
        findings: [
          {
            id: "R1",
            repository: "api",
            severity: "warning" as const,
            file: "file.txt",
            title: "Fix the API fixture",
            evidence: "The fixture needs an approved update.",
            impact: "The fixture remains stale.",
            recommendation: "Update the fixture.",
            confidence: "high" as const,
            relatedRepositories: [],
          },
        ],
        residualRisks: [],
        suggestedTests: [],
      };
    };
    const workflow = new ShipWorkflow(fakePi(state), reviewer);
    const ctx = fakeContext(workspace);
    await workflow.start("", ctx);
    const awaitingDecision = await completeApiPreparation(workflow, ctx, "Ship the API change.");
    expect(awaitingDecision.content[0]?.text).toContain("Background you need first");
    expect(awaitingDecision.content[0]?.text).toContain("has not read the implementation");
    expect(awaitingDecision.content[0]?.text).toContain("the intended behavior");
    expect(awaitingDecision.content[0]?.text).toContain("recommended disposition—fix, accept, or defer");
    expect(awaitingDecision.content[0]?.text).toContain("rationale and tradeoffs");
    expect(reviewerManifests[0]?.repositories[0]?.reviewFixPaths).toBeUndefined();

    const userEntry = {
      type: "message",
      id: "user",
      parentId: null,
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      message: { role: "user", content: "Fix R1", timestamp: Date.now() + 60_000 },
    } as SessionEntry;
    await workflow.handleReport(
      {
        action: "decision",
        decisions: [{ findingId: "R1", action: "fix", rationale: "Approved" }],
      },
      fakeContext(workspace, [userEntry]),
      undefined,
    );

    await writeFile(join(api, "file.txt"), "review fix\n", "utf8");
    await writeFile(join(api, "file.test.ts"), "export {};\n", "utf8");
    const reviewed = await workflow.handleReport(
      {
        action: "fixes-complete",
        repositories: [
          {
            repository: "api",
            summary: "Review fixes: addressed R1.",
            commitMessage: "fix: update API fixture",
            tests: [{ command: "no test suite", status: "skipped", summary: "fixture repository" }],
          },
        ],
      },
      ctx,
      undefined,
    );

    expect(reviewed.content[0]?.text).not.toContain("Review fixes: addressed R1");
    expect(reviewed.content[0]?.text).not.toContain("## Review history");
    expect(reviewed.content[0]?.text).toContain("Summary:\nUpdated the API.");
    expect(await execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: api }).then(({ stdout }) => stdout.trim())).toBe(
      "fix: update API fixture",
    );
    expect(awaitingDecision.content[0]?.text).toContain("distinguish technical validity");
    expect(awaitingDecision.content[0]?.text).toContain("Prefer accept or defer for theoretical cases");
    expect(reviewerManifests[1]?.repositories[0]?.reviewFixBase).toMatch(/^[0-9a-f]{40}$/);
    expect(reviewerManifests[1]?.repositories[0]?.reviewFixPaths).toEqual(["file.test.ts", "file.txt"]);
  });

  it("validates every review-fix commit message before committing any repository", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-ship-fix-commits-"));
    const api = await createClonedRepository(workspace, "api", true);
    const frontend = await createClonedRepository(workspace, "frontend", true);
    const state: FakePiState = { entries: [], messages: [], commands: [] };
    let reviewRound = 0;
    const reviewer = async () => {
      reviewRound += 1;
      if (reviewRound > 1) return passingReviewer();
      return {
        verdict: "findings" as const,
        summary: "Two findings.",
        findings: [
          {
            id: "API-1",
            repository: "api",
            severity: "warning" as const,
            file: "file.txt",
            title: "Fix API",
            evidence: "API needs an update.",
            impact: "API remains stale.",
            recommendation: "Update API.",
            confidence: "high" as const,
            relatedRepositories: [],
          },
          {
            id: "WEB-1",
            repository: "frontend",
            severity: "warning" as const,
            file: "file.txt",
            title: "Fix frontend",
            evidence: "Frontend needs an update.",
            impact: "Frontend remains stale.",
            recommendation: "Update frontend.",
            confidence: "high" as const,
            relatedRepositories: [],
          },
        ],
        residualRisks: [],
        suggestedTests: [],
      };
    };
    const workflow = new ShipWorkflow(fakePi(state), reviewer);
    const ctx = fakeContext(workspace);
    await workflow.start("", ctx);
    await workflow.handleReport(
      {
        action: "simplification-complete",
        intent: "Update API and frontend.",
        repositories: [
          {
            repository: "api",
            summary: "Updated API.",
            tests: [{ command: "no tests", status: "skipped", summary: "fixture repository" }],
          },
          {
            repository: "frontend",
            summary: "Updated frontend.",
            tests: [{ command: "no tests", status: "skipped", summary: "fixture repository" }],
          },
        ],
      },
      ctx,
      undefined,
    );
    await workflow.handleReport(
      {
        action: "testing-complete",
        repositories: ["api", "frontend"].map((repository) => ({
          repository,
          summary: `Updated ${repository}.`,
          tests: [{ command: "no tests", status: "skipped" as const, summary: "fixture repository" }],
          testCuration: {
            added: 0,
            rewritten: 0,
            consolidated: 0,
            removed: 0,
            behaviors: [`${repository} contract`],
            remainingGaps: [],
          },
        })),
      },
      ctx,
      undefined,
    );

    const userEntry = {
      type: "message",
      id: "user",
      parentId: null,
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      message: { role: "user", content: "Fix both", timestamp: Date.now() + 60_000 },
    } as SessionEntry;
    await workflow.handleReport(
      {
        action: "decision",
        decisions: [
          { findingId: "API-1", action: "fix", rationale: "Approved" },
          { findingId: "WEB-1", action: "fix", rationale: "Approved" },
        ],
      },
      fakeContext(workspace, [userEntry]),
      undefined,
    );
    await writeFile(join(api, "file.txt"), "api fix\n", "utf8");
    await writeFile(join(frontend, "file.txt"), "frontend fix\n", "utf8");

    const reports = [
      {
        repository: "api",
        summary: "Updated API.",
        commitMessage: "fix: update API",
        tests: [{ command: "no tests", status: "skipped" as const, summary: "fixture repository" }],
      },
      {
        repository: "frontend",
        summary: "Updated frontend.",
        tests: [{ command: "no tests", status: "skipped" as const, summary: "fixture repository" }],
      },
    ];
    await expect(
      workflow.handleReport({ action: "fixes-complete", repositories: reports }, ctx, undefined),
    ).rejects.toThrow("Review-fix report for frontend requires a commit message");
    for (const repository of [api, frontend]) {
      expect(await execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: repository }).then(({ stdout }) => stdout.trim())).toBe(
        "change",
      );
    }

    const reviewed = await workflow.handleReport(
      {
        action: "fixes-complete",
        repositories: [reports[0]!, { ...reports[1]!, commitMessage: "fix: update frontend" }],
      },
      ctx,
      undefined,
    );
    expect(reviewed.content[0]?.text).toContain("No actionable findings");
    expect(await execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: api }).then(({ stdout }) => stdout.trim())).toBe(
      "fix: update API",
    );
    expect(await execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: frontend }).then(({ stdout }) => stdout.trim())).toBe(
      "fix: update frontend",
    );
  });

  it("repeats decision guidance on resume and requires a user response", async () => {
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
      contextOnly: false,
      changed: true,
      simplifyScope: [],
      tests: [],
      pushed: false,
    });
    const storedEntry = { type: "custom", customType: "pi-ship-state", data: run } as SessionEntry;
    const state: FakePiState = { entries: [], messages: [], commands: [] };
    const workflow = new ShipWorkflow(fakePi(state));
    const reviewContext = fakeContext("/workspace", [storedEntry]);
    workflow.restore(reviewContext);
    await workflow.resume(reviewContext);
    expect(state.messages.at(-1)?.content).toContain("Background you need first");
    expect(state.messages.at(-1)?.content).toContain("self-contained for someone who has not read the code");
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
    expect(result.content[0]?.text).toContain("Apply only these approved review fixes");
    expect(result.content[0]?.text).toContain("commitMessage");
    expect(result.content[0]?.text).toContain("do not use generic review-workflow wording");
    const reviewEntry = state.entries.at(-1);
    expect(reviewEntry?.customType).toBe("pi-ship-review");
    expect(reviewEntry?.data).toMatchObject({ review: { decisions: decision.decisions } });
  });
});
