import { describe, expect, it } from "vitest";
import { buildReviewPrompt, collectReviewerDecisions } from "./reviewer.js";
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
