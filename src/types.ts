export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export interface ChangedFile {
  readonly path: string;
  readonly status: "modified" | "added" | "renamed" | "copied";
  readonly changedLines?: readonly LineRange[];
}

export interface TestExecution {
  command: string;
  status: "passed" | "skipped";
  summary?: string;
}

export interface RepositoryReport {
  repository: string;
  summary: string;
  commitMessage?: string;
  tests: TestExecution[];
}

export interface ReviewFinding {
  id: string;
  repository: string;
  severity: "blocking" | "warning" | "nit";
  file: string;
  line?: number;
  title: string;
  evidence: string;
  impact: string;
  recommendation: string;
  confidence: "high" | "medium" | "low";
  relatedRepositories: string[];
}

export interface ReviewResult {
  verdict: "pass" | "findings";
  summary: string;
  findings: ReviewFinding[];
  residualRisks: string[];
  suggestedTests: string[];
}

export interface FindingDecision {
  findingId: string;
  action: "fix" | "accept" | "defer";
  rationale: string;
}

export interface PullRequestDraft {
  repository: string;
  title: string;
  body: string;
}

export type ShipStage =
  | "preflight"
  | "rebasing"
  | "resolving-conflicts"
  | "simplifying"
  | "reviewing"
  | "awaiting-decision"
  | "fixing"
  | "drafting"
  | "publishing"
  | "complete"
  | "aborted";

export interface ShipRepositoryState {
  name: string;
  path: string;
  githubRepository: string;
  branch: string;
  baseBranch: string;
  baseRef: string;
  initialHead: string;
  head: string;
  baseSha: string;
  remoteBranchSha?: string;
  changed: boolean;
  simplifyScope: ChangedFile[];
  summary?: string;
  tests: TestExecution[];
  reviewedHead?: string;
  baseShaAtReview?: string;
  pushed: boolean;
  pullRequestUrl?: string;
}

export interface StoredReview {
  round: number;
  completedAt: number;
  result: ReviewResult;
  decisions?: FindingDecision[];
}

export interface ShipRun {
  version: 1;
  id: string;
  root: string;
  stage: ShipStage;
  createdAt: number;
  updatedAt: number;
  intent?: string;
  repositories: ShipRepositoryState[];
  rebaseIndex: number;
  conflictRepository?: string;
  review?: StoredReview;
  reviewHistory?: StoredReview[];
  drafts?: PullRequestDraft[];
  lastError?: string;
}

export interface ShipReportInput {
  action: "conflict-resolved" | "simplification-complete" | "decision" | "fixes-complete" | "publish";
  intent?: string;
  repositories?: RepositoryReport[];
  decisions?: FindingDecision[];
  drafts?: PullRequestDraft[];
}

export interface ReviewerManifestRepository {
  name: string;
  path: string;
  baseRef: string;
  baseBranch: string;
  branch: string;
  changed: boolean;
}

export interface ReviewerPriorDecision {
  round: number;
  findingId: string;
  repository: string;
  title: string;
  action: FindingDecision["action"];
  rationale: string;
}

export interface ReviewerManifest {
  root: string;
  intent: string;
  repositories: ReviewerManifestRepository[];
  priorDecisions?: ReviewerPriorDecision[];
}
