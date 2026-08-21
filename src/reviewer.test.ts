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
      repositories: [],
      priorDecisions: collectReviewerDecisions([review]),
    };
    const prompt = buildReviewPrompt(manifest);

    expect(prompt).toContain("ACCEPTED (api): Accepted tradeoff");
    expect(prompt).toContain("DEFERRED (frontend): Deferred work");
    expect(prompt).toContain("FIXED (api): Fixed bug");
    expect(prompt).toContain("the rationale overrides conflicting language");
  });
});
