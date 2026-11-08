import { ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildReviewPrompt, collectReviewerDecisions, runWorkspaceReviewer } from "./reviewer.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));
import type { ReviewerManifest, StoredReview } from "./types.js";

const review: StoredReview = {
  round: 1,
  completedAt: 1,
  result: {
    verdict: "findings",
    summary: "Review",
    findings: [
      {
        id: "ACCEPTED",
        repository: "api",
        severity: "warning",
        file: "api.ts",
        title: "Accepted tradeoff",
        evidence: "Evidence",
        impact: "Impact",
        recommendation: "Recommendation",
        confidence: "high",
        relatedRepositories: [],
      },
      {
        id: "DEFERRED",
        repository: "frontend",
        severity: "warning",
        file: "frontend.ts",
        title: "Deferred work",
        evidence: "Evidence",
        impact: "Impact",
        recommendation: "Recommendation",
        confidence: "high",
        relatedRepositories: [],
      },
      {
        id: "FIXED",
        repository: "api",
        severity: "blocking",
        file: "api.ts",
        title: "Fixed bug",
        evidence: "Evidence",
        impact: "Impact",
        recommendation: "Recommendation",
        confidence: "high",
        relatedRepositories: [],
      },
    ],
    residualRisks: [],
    suggestedTests: [],
  },
  decisions: [
    { findingId: "ACCEPTED", action: "accept", rationale: "Proportionate tradeoff" },
    { findingId: "DEFERRED", action: "defer", rationale: "Follow-up work" },
    { findingId: "FIXED", action: "fix", rationale: "Fix now" },
  ],
};

describe("reviewer provider loading", () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "pi-ship-provider-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new ChildProcess(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      queueMicrotask(() => {
        child.stdout.end(`${JSON.stringify({
          type: "tool_execution_end",
          toolName: "submit_review",
          result: { details: { review: review.result } },
        })}\n`);
        child.emit("close", 0);
      });
      return child;
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(agentDir, { recursive: true, force: true });
  });

  it.each(["claude-bridge", "openai"])("loads only the needed extensions for %s", async (provider) => {
    const bridgePath = join(agentDir, "npm", "node_modules", "pi-claude-bridge");
    if (provider === "claude-bridge") {
      await mkdir(bridgePath, { recursive: true });
      await writeFile(join(bridgePath, "package.json"), JSON.stringify({ name: "pi-claude-bridge" }));
    }
    const ctx = { model: { provider, id: "review-model" } } as ExtensionContext;

    const result = await runWorkspaceReviewer(ctx, { root: agentDir, intent: "Review", repositories: [] }, undefined);

    expect(result.summary).toBe(review.result.summary);
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args).toContain("--no-extensions");
    const extensions = args.flatMap((arg, index) => arg === "-e" ? [args[index + 1]!] : []);
    expect(extensions).toHaveLength(provider === "claude-bridge" ? 2 : 1);
    expect(extensions.some((path) => /reviewer-child\.(ts|js)$/.test(path))).toBe(true);
    expect(extensions.includes(bridgePath)).toBe(provider === "claude-bridge");
    expect(args[args.indexOf("--model") + 1]).toBe(`${provider}/review-model`);
    expect(args[args.indexOf("--tools") + 1]!.split(",").sort())
      .toEqual(["find", "grep", "ls", "read", "ship_git", "submit_review"]);
  });

  it("explains how to install a missing bridge without launching a different model", async () => {
    const ctx = { model: { provider: "claude-bridge", id: "review-model" } } as ExtensionContext;

    await expect(runWorkspaceReviewer(ctx, { root: agentDir, intent: "Review", repositories: [] }, undefined))
      .rejects.toThrow("pi install npm:pi-claude-bridge");
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("reviewer context", () => {
  it("passes every user decision and rationale", () => {
    expect(collectReviewerDecisions([review])).toEqual([
      {
        round: 1,
        findingId: "ACCEPTED",
        repository: "api",
        title: "Accepted tradeoff",
        action: "accept",
        rationale: "Proportionate tradeoff",
      },
      {
        round: 1,
        findingId: "DEFERRED",
        repository: "frontend",
        title: "Deferred work",
        action: "defer",
        rationale: "Follow-up work",
      },
      {
        round: 1,
        findingId: "FIXED",
        repository: "api",
        title: "Fixed bug",
        action: "fix",
        rationale: "Fix now",
      },
    ]);
  });

  it("instructs later reviewers to respect prior decisions", () => {
    const manifest: ReviewerManifest = {
      root: "/workspace",
      intent: "Ship the feature",
      repositories: [
        {
          name: "api",
          path: "/workspace/api",
          baseRef: "refs/remotes/origin/main",
          baseBranch: "main",
          branch: "feature",
          changed: true,
          testCuration: {
            added: 1,
            rewritten: 2,
            consolidated: 0,
            removed: 3,
            behaviors: ["API compatibility"],
            remainingGaps: ["External service integration"],
          },
          reviewFixBase: "abc123",
          reviewFixPaths: ["src/api.test.ts", "test/fixture.json"],
        },
      ],
      priorDecisions: collectReviewerDecisions([review]),
    };
    const prompt = buildReviewPrompt(manifest);

    expect(prompt).toContain("ACCEPTED (api): Accepted tradeoff");
    expect(prompt).toContain("DEFERRED (frontend): Deferred work");
    expect(prompt).toContain("FIXED (api): Fixed bug");
    expect(prompt).toContain("the rationale overrides conflicting language");
    expect(prompt).toContain("1 added, 2 rewritten, 0 consolidated, 3 removed");
    expect(prompt).toContain("protected behaviors: API compatibility");
    expect(prompt).toContain("internal evidence, not requirements");
    expect(prompt).toContain("api, changes since abc123");
    expect(prompt).toContain("src/api.test.ts");
    expect(prompt).toContain('ship_git action "review-fix-diff"');
    expect(prompt).toContain("Do not re-audit other tests for general durability");
  });

  it("leaves the initial review durability audit to the Test phase", () => {
    const prompt = buildReviewPrompt({
      root: "/workspace",
      intent: "Ship the feature",
      repositories: [],
    });

    expect(prompt).toContain("None. The dedicated Test phase already curated the original branch tests");
  });
});
