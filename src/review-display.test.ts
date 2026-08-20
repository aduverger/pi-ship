import { describe, expect, it } from "vitest";
import { formatFullReview, formatReviewSummary, reviewHeadline } from "./review-display.js";
import type { ReviewFinding, StoredReview } from "./types.js";

function finding(id: string, severity: ReviewFinding["severity"]): ReviewFinding {
  return {
    id,
    repository: "api",
    severity,
    file: "src/api.ts",
    line: 12,
    title: `Finding ${id}`,
    evidence: "Concrete evidence",
    impact: "Concrete impact",
    recommendation: "Fix it",
    confidence: "high",
    relatedRepositories: [],
  };
}

function review(findings: ReviewFinding[]): StoredReview {
  return {
    round: 2,
    completedAt: 1,
    result: {
      verdict: findings.length > 0 ? "findings" : "pass",
      summary: "Review summary",
      findings,
      residualRisks: ["Residual risk"],
      suggestedTests: ["Run integration tests"],
    },
  };
}

describe("review display", () => {
  it("summarizes finding counts, locations, and decisions", () => {
    const stored = review([finding("R1", "blocking"), finding("R2", "warning")]);
    stored.decisions = [{ findingId: "R1", action: "fix", rationale: "Approved" }];

    expect(reviewHeadline(stored)).toBe(
      "Independent review round 2 — 2 findings (1 blocking, 1 warning)",
    );
    expect(formatReviewSummary(stored)).toContain("R1 [blocking] api: Finding R1 — fix");
    expect(formatReviewSummary(stored)).toContain("R2 [warning] api: Finding R2");
    expect(formatFullReview(stored)).toContain("Decision: fix — Approved");
  });

  it("shows a passing review", () => {
    expect(formatReviewSummary(review([]))).toBe(
      "Independent review round 2 — pass\nReview summary",
    );
  });
});
