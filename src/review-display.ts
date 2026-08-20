import type { FindingDecision, ReviewFinding, StoredReview } from "./types.js";

export const REVIEW_ENTRY_TYPE = "pi-ship-review";

export interface ReviewEntryData {
  runId: string;
  review: StoredReview;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function severityCount(severity: ReviewFinding["severity"], count: number): string {
  if (severity === "blocking") return `${count} blocking`;
  return plural(count, severity);
}

export function reviewHeadline(review: StoredReview): string {
  const findings = review.result.findings;
  if (findings.length === 0) return `Independent review round ${review.round} — pass`;

  const severities: ReviewFinding["severity"][] = ["blocking", "warning", "nit"];
  const counts = severities.flatMap((severity) => {
    const count = findings.filter((finding) => finding.severity === severity).length;
    return count > 0 ? [severityCount(severity, count)] : [];
  });

  return `Independent review round ${review.round} — ${plural(findings.length, "finding")} (${counts.join(", ")})`;
}

function decisionMap(decisions: readonly FindingDecision[] | undefined): Map<string, FindingDecision> {
  return new Map(decisions?.map((decision) => [decision.findingId, decision]) ?? []);
}

export function formatReviewSummary(review: StoredReview): string {
  const decisions = decisionMap(review.decisions);
  const findings = review.result.findings.map((finding) => {
    const decision = decisions.get(finding.id);
    const disposition = decision ? ` — ${decision.action}` : "";
    return `- ${finding.id} [${finding.severity}] ${finding.repository}: ${finding.title}${disposition}`;
  });
  return [reviewHeadline(review), review.result.summary, ...findings].join("\n");
}

function formatFinding(finding: ReviewFinding, decision: FindingDecision | undefined): string {
  const location = `${finding.repository}/${finding.file}${finding.line ? `:${finding.line}` : ""}`;
  const disposition = decision
    ? `\n- Decision: ${decision.action} — ${decision.rationale}`
    : "";
  return `### ${finding.id} — ${finding.title}\n\n- Severity: ${finding.severity}\n- Location: ${location}\n- Confidence: ${finding.confidence}\n- Evidence: ${finding.evidence}\n- Impact: ${finding.impact}\n- Recommendation: ${finding.recommendation}${disposition}`;
}

export function formatFullReview(review: StoredReview): string {
  const decisions = decisionMap(review.decisions);
  const findings = review.result.findings.length > 0
    ? review.result.findings
        .map((finding) => formatFinding(finding, decisions.get(finding.id)))
        .join("\n\n")
    : "No actionable findings.";
  const risks = review.result.residualRisks.length > 0
    ? review.result.residualRisks.map((risk) => `- ${risk}`).join("\n")
    : "- None reported";
  const tests = review.result.suggestedTests.length > 0
    ? review.result.suggestedTests.map((test) => `- ${test}`).join("\n")
    : "- None suggested";

  return `## Independent workspace review — round ${review.round}\n\n${review.result.summary}\n\n${findings}\n\n## Residual risks\n\n${risks}\n\n## Suggested tests\n\n${tests}`;
}
