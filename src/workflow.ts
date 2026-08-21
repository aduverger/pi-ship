import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  collectChangedFiles,
  dirtyPaths,
  discoverRepositoryPaths,
  git,
  hasChangesAgainstBase,
  isClean,
  parseGitHubRepository,
  requireGit,
  type CommandRunner,
} from "./git.js";
import { withRelatedPullRequests } from "./related-prs.js";
import {
  formatFullReview,
  formatReviewSummary,
  REVIEW_ENTRY_TYPE,
  reviewHeadline,
  type ReviewEntryData,
} from "./review-display.js";
import { collectReviewerPriorDecisions, runWorkspaceReviewer } from "./reviewer.js";
import { buildWorkspaceSimplificationPrompt } from "./simplify.js";
import type {
  FindingDecision,
  PullRequestDraft,
  RepositoryReport,
  ShipRepositoryState,
  ShipReportInput,
  ShipRun,
  StoredReview,
  TestExecution,
} from "./types.js";

const STATE_ENTRY = "pi-ship-state";
const ACTIVE_STAGES = new Set<ShipRun["stage"]>([
  "preflight",
  "rebasing",
  "resolving-conflicts",
  "simplifying",
  "reviewing",
  "awaiting-decision",
  "fixing",
  "drafting",
  "publishing",
]);

interface WorkflowResult {
  content: Array<{ type: "text"; text: string }>;
  details: { run?: ShipRun };
}

type ProgressCallback = (message: string) => void;
type WorkspaceReviewer = typeof runWorkspaceReviewer;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function changedRepositories(run: ShipRun): ShipRepositoryState[] {
  return run.repositories.filter((repository) => repository.changed);
}

function testsMarkdown(tests: readonly TestExecution[]): string {
  return tests
    .map((test) => `- \`${test.command}\` — ${test.status}${test.summary ? `: ${test.summary}` : ""}`)
    .join("\n");
}

function storedReviews(run: ShipRun): StoredReview[] {
  return [...(run.reviewHistory ?? []), ...(run.review ? [run.review] : [])];
}

function isStoredRun(value: unknown): value is ShipRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<ShipRun>;
  return run.version === 1 && typeof run.id === "string" && Array.isArray(run.repositories);
}

export class ShipWorkflow {
  private run: ShipRun | undefined;
  private readonly runCommand: CommandRunner;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly reviewer: WorkspaceReviewer = runWorkspaceReviewer,
  ) {
    this.runCommand = (command, args, options) => this.pi.exec(command, args, options);
  }

  restore(ctx: ExtensionContext): void {
    this.run = undefined;
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry?.type === "custom" && entry.customType === STATE_ENTRY && isStoredRun(entry.data)) {
        this.run = structuredClone(entry.data);
        break;
      }
    }
    this.updateStatus(ctx);
  }

  guidance(): string | undefined {
    if (!this.run || !ACTIVE_STAGES.has(this.run.stage)) return undefined;
    switch (this.run.stage) {
      case "awaiting-decision":
        return "pi-ship is awaiting the user's review decision. Analyze their latest message against every finding, then call ship_report with action decision. Do not edit files before that tool accepts the decision.";
      case "fixing":
        return "pi-ship is applying approved review fixes. Make only the approved changes, run relevant tests in every changed repository, do not commit, then call ship_report with action fixes-complete.";
      case "simplifying":
        return "pi-ship is simplifying rebased changes. Follow the displayed changed-line scope, do not commit, then call ship_report with action simplification-complete.";
      case "resolving-conflicts":
        return "pi-ship is resolving a rebase conflict. Resolve and stage every unmerged path in the named repository, do not create a commit manually, then call ship_report with action conflict-resolved.";
      case "drafting":
        return "pi-ship is ready to publish. Prepare one GitHub PR title and body per changed repository, then call ship_report with action publish. Do not ask for another confirmation.";
      default:
        return undefined;
    }
  }

  async start(args: string, ctx: ExtensionCommandContext): Promise<void> {
    await ctx.waitForIdle();
    if (this.run && ACTIVE_STAGES.has(this.run.stage)) {
      throw new Error(`A /ship run is already ${this.run.stage}. Use /ship status, /ship resume, or /ship abort.`);
    }

    const requested = args.trim() ? args.trim().split(/\s+/) : [];
    const discovered = await discoverRepositoryPaths(this.runCommand, ctx.cwd, requested);

    const dirty: string[] = [];
    for (const path of discovered.repositories) {
      if (!(await isClean(this.runCommand, path))) dirty.push(basename(path));
    }
    if (dirty.length > 0) {
      throw new Error(`Every selected repository must be clean and committed. Dirty: ${dirty.join(", ")}`);
    }

    const ghAuth = await this.pi.exec("gh", ["auth", "status", "--hostname", "github.com"], {
      cwd: discovered.root,
      timeout: 30_000,
    });
    if (ghAuth.code !== 0) throw new Error(ghAuth.stderr.trim() || "GitHub CLI authentication failed.");

    for (const path of discovered.repositories) {
      const fetch = await git(this.runCommand, path, ["fetch", "--prune", "origin"]);
      if (fetch.code !== 0) throw new Error(`git fetch failed in ${basename(path)}: ${fetch.stderr.trim()}`);
    }

    const repositories: ShipRepositoryState[] = [];
    for (const path of discovered.repositories) repositories.push(await this.inspectRepository(path));

    this.run = {
      version: 1,
      id: randomUUID(),
      root: discovered.root,
      stage: "rebasing",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      repositories,
      rebaseIndex: 0,
    };
    this.persist(ctx);

    const prompt = await this.continueRebases(ctx);
    if (prompt) this.sendPrompt(prompt);
  }

  status(ctx: ExtensionContext): string {
    if (!this.run) return "No /ship run is recorded in this session.";
    const lines = [`Ship ${this.run.id.slice(0, 8)}: ${this.run.stage}`];
    for (const repository of this.run.repositories) {
      const labels = [repository.changed ? "changed" : "context"];
      if (repository.reviewedHead === repository.head) labels.push("reviewed");
      if (repository.pushed) labels.push("pushed");
      if (repository.pullRequestUrl) labels.push(repository.pullRequestUrl);
      lines.push(`- ${repository.name}: ${repository.branch} -> ${repository.baseBranch} (${labels.join(", ")})`);
    }
    if (this.run.lastError) lines.push(`Last error: ${this.run.lastError}`);
    const reviews = storedReviews(this.run);
    if (reviews.length > 0) {
      lines.push("", "Reviews:", ...reviews.flatMap((review) => formatReviewSummary(review).split("\n")));
    }
    this.updateStatus(ctx);
    return lines.join("\n");
  }

  async resume(ctx: ExtensionCommandContext): Promise<void> {
    await ctx.waitForIdle();
    if (!this.run) throw new Error("No /ship run to resume.");

    let prompt: string | undefined;
    switch (this.run.stage) {
      case "rebasing":
        prompt = await this.continueRebases(ctx);
        break;
      case "resolving-conflicts":
        prompt = await this.conflictPrompt();
        break;
      case "simplifying":
        prompt = buildWorkspaceSimplificationPrompt(this.run.repositories);
        break;
      case "reviewing":
        prompt = (await this.performReview(ctx)).content[0]?.text;
        break;
      case "awaiting-decision":
        prompt = `${this.formatReview()}\n\nAnalyze these findings, recommend a disposition for each, and wait for the user's explicit decision.`;
        break;
      case "fixing":
        prompt = this.buildFixPrompt();
        break;
      case "drafting":
        prompt = this.buildDraftPrompt();
        break;
      case "publishing":
        if (!this.run.drafts) throw new Error("Publication drafts are missing.");
        prompt = (await this.publish(ctx, this.run.drafts)).content[0]?.text;
        break;
      case "complete":
      case "aborted":
        ctx.ui.notify(`Ship run is ${this.run.stage}.`, "info");
        return;
      case "preflight":
        throw new Error("Preflight did not finish; start a new /ship run.");
    }
    if (prompt) this.sendPrompt(prompt);
  }

  async abort(ctx: ExtensionContext): Promise<void> {
    if (!this.run || !ACTIVE_STAGES.has(this.run.stage)) {
      ctx.ui.notify("No active /ship run.", "info");
      return;
    }

    for (const repository of this.run.repositories) {
      if (await this.rebaseInProgress(repository.path)) {
        await git(this.runCommand, repository.path, ["rebase", "--abort"]);
      }
    }
    this.run.stage = "aborted";
    delete this.run.conflictRepository;
    this.persist(ctx);
    ctx.ui.notify("Ship run aborted. Existing completed rebases and commits were preserved.", "warning");
  }

  recordError(ctx: ExtensionContext, error: unknown): void {
    if (!this.run) return;
    this.run.lastError = errorMessage(error);
    this.persist(ctx);
  }

  async handleReport(
    input: ShipReportInput,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    onProgress?: ProgressCallback,
  ): Promise<WorkflowResult> {
    if (!this.run) throw new Error("No active /ship run.");
    delete this.run.lastError;

    switch (input.action) {
      case "conflict-resolved":
        return this.handleConflictResolved(ctx);
      case "simplification-complete":
        return this.handleSimplificationComplete(input, ctx, signal, onProgress);
      case "decision":
        return this.handleDecision(input, ctx);
      case "fixes-complete":
        return this.handleFixesComplete(input, ctx, signal, onProgress);
      case "publish":
        if (!input.drafts) throw new Error("publish requires drafts.");
        return this.publish(ctx, input.drafts);
    }
  }

  private async inspectRepository(path: string): Promise<ShipRepositoryState> {
    const branch = await requireGit(this.runCommand, path, ["symbolic-ref", "--quiet", "--short", "HEAD"], "read branch");
    const origin = await requireGit(this.runCommand, path, ["remote", "get-url", "origin"], "read origin");
    const githubRepository = parseGitHubRepository(origin);
    const baseBranch = await this.resolveBaseBranch(path, githubRepository);
    const baseRef = `refs/remotes/origin/${baseBranch}`;
    const initialHead = await requireGit(this.runCommand, path, ["rev-parse", "HEAD"]);
    const baseSha = await requireGit(this.runCommand, path, ["rev-parse", baseRef]);
    const remoteBranch = await git(this.runCommand, path, ["rev-parse", "--verify", `refs/remotes/origin/${branch}`]);
    const changed = await hasChangesAgainstBase(this.runCommand, path, baseRef);
    if (branch === baseBranch) {
      throw new Error(`${basename(path)} is checked out on its default branch ${baseBranch}; every selected repository must use a feature branch.`);
    }

    return {
      name: basename(path),
      path,
      githubRepository,
      branch,
      baseBranch,
      baseRef,
      initialHead,
      head: initialHead,
      baseSha,
      ...(remoteBranch.code === 0 ? { remoteBranchSha: remoteBranch.stdout.trim() } : {}),
      changed,
      simplifyScope: [],
      tests: [],
      pushed: false,
    };
  }

  private async resolveBaseBranch(path: string, githubRepository: string): Promise<string> {
    const symbolic = await git(this.runCommand, path, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    if (symbolic.code === 0 && symbolic.stdout.trim().startsWith("origin/")) {
      return symbolic.stdout.trim().slice("origin/".length);
    }

    const gh = await this.pi.exec(
      "gh",
      ["repo", "view", githubRepository, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      { cwd: path, timeout: 30_000 },
    );
    if (gh.code === 0 && gh.stdout.trim()) return gh.stdout.trim();

    for (const fallback of ["main", "master"]) {
      const result = await git(this.runCommand, path, ["rev-parse", "--verify", `refs/remotes/origin/${fallback}`]);
      if (result.code === 0) return fallback;
    }
    throw new Error(`Could not resolve the default branch for ${githubRepository}.`);
  }

  private async continueRebases(ctx: ExtensionContext): Promise<string | undefined> {
    if (!this.run) throw new Error("No active run.");
    this.run.stage = "rebasing";
    delete this.run.conflictRepository;
    this.persist(ctx);

    for (; this.run.rebaseIndex < this.run.repositories.length; this.run.rebaseIndex++) {
      const repository = this.run.repositories[this.run.rebaseIndex];
      if (!repository?.changed) continue;

      const result = await git(this.runCommand, repository.path, ["rebase", repository.baseRef]);
      if (result.code !== 0) {
        const conflicts = await this.unmergedPaths(repository.path);
        if (conflicts.length === 0) {
          throw new Error(`Rebase failed in ${repository.name}: ${result.stderr.trim() || result.stdout.trim()}`);
        }
        this.run.stage = "resolving-conflicts";
        this.run.conflictRepository = repository.name;
        this.persist(ctx);
        return this.conflictPrompt(conflicts);
      }
      await this.refreshRepository(repository);
    }

    for (const repository of this.run.repositories) {
      await this.refreshRepository(repository);
      repository.simplifyScope = repository.changed
        ? await collectChangedFiles(this.runCommand, repository.path, repository.baseRef)
        : [];
    }

    if (changedRepositories(this.run).length === 0) {
      this.run.stage = "complete";
      this.persist(ctx);
      return "No selected repository has a committed change against its default branch. Nothing was pushed and no pull request was created.";
    }

    this.run.stage = "simplifying";
    this.persist(ctx);
    return buildWorkspaceSimplificationPrompt(this.run.repositories);
  }

  private async handleConflictResolved(ctx: ExtensionContext): Promise<WorkflowResult> {
    if (!this.run || this.run.stage !== "resolving-conflicts" || !this.run.conflictRepository) {
      throw new Error("pi-ship is not waiting for a conflict resolution.");
    }
    const repository = this.repository(this.run.conflictRepository);
    const conflicts = await this.unmergedPaths(repository.path);
    if (conflicts.length > 0) throw new Error(`Unmerged paths remain in ${repository.name}: ${conflicts.join(", ")}`);

    if (await this.rebaseInProgress(repository.path)) {
      const result = await git(this.runCommand, repository.path, ["-c", "core.editor=true", "rebase", "--continue"]);
      if (result.code !== 0) {
        const nextConflicts = await this.unmergedPaths(repository.path);
        if (nextConflicts.length > 0) {
          this.persist(ctx);
          return this.result(await this.conflictPrompt(nextConflicts));
        }
        throw new Error(`Could not continue rebase in ${repository.name}: ${result.stderr.trim()}`);
      }
    }

    await this.refreshRepository(repository);
    this.run.rebaseIndex += 1;
    const prompt = await this.continueRebases(ctx);
    return this.result(prompt ?? "Rebase completed.");
  }

  private async handleSimplificationComplete(
    input: ShipReportInput,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    onProgress?: ProgressCallback,
  ): Promise<WorkflowResult> {
    if (!this.run || this.run.stage !== "simplifying") throw new Error("pi-ship is not in simplification stage.");
    if (!input.intent?.trim()) throw new Error("simplification-complete requires the workspace intent.");
    const reports = this.validateReports(input.repositories, changedRepositories(this.run).map((repository) => repository.name));

    for (const repository of changedRepositories(this.run)) {
      const currentHead = await requireGit(this.runCommand, repository.path, ["rev-parse", "HEAD"]);
      if (currentHead !== repository.head) throw new Error(`${repository.name} was committed during simplification; pi-ship owns commits.`);
      const allowed = new Set(repository.simplifyScope.map((file) => file.path));
      const outOfScope = (await dirtyPaths(this.runCommand, repository.path)).filter((path) => !allowed.has(path));
      if (outOfScope.length > 0) {
        throw new Error(`Out-of-scope simplification edits in ${repository.name}: ${outOfScope.join(", ")}`);
      }
    }

    this.run.intent = input.intent.trim();
    for (const repository of changedRepositories(this.run)) {
      const report = reports.get(repository.name);
      if (!report) continue;
      repository.summary = report.summary;
      repository.tests = report.tests;
      await this.commitIfDirty(repository, "refactor: simplify branch changes");
      await this.refreshRepository(repository);
    }
    this.persist(ctx);
    return this.performReview(ctx, signal, onProgress);
  }

  private async performReview(
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onProgress?: ProgressCallback,
  ): Promise<WorkflowResult> {
    if (!this.run || !this.run.intent) throw new Error("Cannot review without an active run and intent.");
    for (const repository of this.run.repositories) {
      if (!(await isClean(this.runCommand, repository.path))) throw new Error(`${repository.name} is dirty before review.`);
      await this.refreshRepository(repository);
    }

    this.run.stage = "reviewing";
    this.persist(ctx);
    onProgress?.("Starting independent workspace review");
    const review = await this.reviewer(
      ctx,
      {
        root: this.run.root,
        intent: this.run.intent,
        repositories: this.run.repositories.map((repository) => ({
          name: repository.name,
          path: repository.path,
          baseRef: repository.baseRef,
          baseBranch: repository.baseBranch,
          branch: repository.branch,
          changed: repository.changed,
        })),
        priorDecisions: collectReviewerPriorDecisions(storedReviews(this.run)),
      },
      signal,
      onProgress,
    );

    const ids = new Set<string>();
    for (const finding of review.findings) {
      if (ids.has(finding.id)) throw new Error(`Reviewer returned duplicate finding id ${finding.id}.`);
      ids.add(finding.id);
      this.repository(finding.repository);
      for (const relatedRepository of finding.relatedRepositories) this.repository(relatedRepository);
    }

    for (const repository of changedRepositories(this.run)) {
      if (!(await isClean(this.runCommand, repository.path))) throw new Error(`Reviewer modified ${repository.name}.`);
      const head = await requireGit(this.runCommand, repository.path, ["rev-parse", "HEAD"]);
      if (head !== repository.head) throw new Error(`HEAD changed during review in ${repository.name}.`);
      repository.reviewedHead = head;
      repository.baseShaAtReview = await requireGit(this.runCommand, repository.path, ["rev-parse", repository.baseRef]);
    }

    const previousRound = this.run.review?.round ?? this.run.reviewHistory?.at(-1)?.round ?? 0;
    this.archiveCurrentReview();
    this.run.review = {
      round: previousRound + 1,
      completedAt: Date.now(),
      result: review,
    };
    this.run.stage = review.findings.length > 0 ? "awaiting-decision" : "drafting";
    this.persist(ctx);
    this.appendReviewEntry();

    if (review.findings.length > 0) {
      return this.result(
        `${this.formatReview()}\n\nAnalyze every finding against the code and intent. Present your recommended disposition—fix, accept, or defer—and then stop. Do not call ship_report with action decision until the user explicitly responds.`,
      );
    }
    return this.result(`${this.formatReview()}\n\n${this.buildDraftPrompt()}`);
  }

  private handleDecision(input: ShipReportInput, ctx: ExtensionContext): WorkflowResult {
    if (!this.run || this.run.stage !== "awaiting-decision" || !this.run.review) {
      throw new Error("pi-ship is not awaiting a review decision.");
    }
    if (!this.hasUserMessageAfterReview(ctx)) {
      throw new Error("The user has not responded to the review yet. Present the plan and wait for their decision.");
    }

    const decisions = input.decisions ?? [];
    const byId = new Map(decisions.map((decision) => [decision.findingId, decision]));
    const findingIds = new Set(this.run.review.result.findings.map((finding) => finding.id));
    if (byId.size !== decisions.length) throw new Error("Finding decisions contain duplicate ids.");
    for (const findingId of findingIds) {
      if (!byId.has(findingId)) throw new Error(`Missing decision for finding ${findingId}.`);
    }
    for (const findingId of byId.keys()) {
      if (!findingIds.has(findingId)) throw new Error(`Unknown finding decision ${findingId}.`);
    }

    this.run.review.decisions = decisions;
    if (decisions.some((decision) => decision.action === "fix")) {
      this.run.stage = "fixing";
      this.persist(ctx);
      this.appendReviewEntry();
      return this.result(this.buildFixPrompt());
    }

    this.run.stage = "drafting";
    this.persist(ctx);
    this.appendReviewEntry();
    return this.result(this.buildDraftPrompt());
  }

  private async handleFixesComplete(
    input: ShipReportInput,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    onProgress?: ProgressCallback,
  ): Promise<WorkflowResult> {
    if (!this.run || this.run.stage !== "fixing" || !this.run.review?.decisions) {
      throw new Error("pi-ship is not in the review-fix stage.");
    }

    const dirtyRepositories: ShipRepositoryState[] = [];
    for (const repository of this.run.repositories) {
      const head = await requireGit(this.runCommand, repository.path, ["rev-parse", "HEAD"]);
      if (repository.changed && head !== repository.reviewedHead) {
        throw new Error(`${repository.name} was committed during review fixes; pi-ship owns commits.`);
      }
      if (!(await isClean(this.runCommand, repository.path))) dirtyRepositories.push(repository);
    }
    if (dirtyRepositories.length === 0) throw new Error("No review-fix changes were made.");

    const requiredReports = [...new Set([...changedRepositories(this.run), ...dirtyRepositories].map((repository) => repository.name))];
    const reports = this.validateReports(input.repositories, requiredReports);
    for (const repository of this.run.repositories) {
      const report = reports.get(repository.name);
      if (!report) continue;
      repository.summary = [repository.summary, `Review fixes: ${report.summary}`].filter(Boolean).join("\n");
      repository.tests = report.tests;
    }
    for (const repository of dirtyRepositories) {
      await this.commitIfDirty(repository, "fix: address independent review findings");
    }
    for (const repository of this.run.repositories) await this.refreshRepository(repository);
    this.persist(ctx);
    return this.performReview(ctx, signal, onProgress);
  }

  private async publish(ctx: ExtensionContext, drafts: readonly PullRequestDraft[]): Promise<WorkflowResult> {
    if (!this.run || (this.run.stage !== "drafting" && this.run.stage !== "publishing")) {
      throw new Error("pi-ship is not ready to publish.");
    }
    const changed = changedRepositories(this.run);
    const byRepository = new Map(drafts.map((draft) => [draft.repository, draft]));
    if (byRepository.size !== drafts.length) throw new Error("PR drafts contain duplicate repositories.");
    for (const repository of changed) {
      const draft = byRepository.get(repository.name);
      if (!draft?.title.trim() || !draft.body.trim()) throw new Error(`Missing complete PR draft for ${repository.name}.`);
    }
    for (const name of byRepository.keys()) {
      if (!this.repository(name).changed) throw new Error(`PR draft supplied for unchanged repository ${name}.`);
    }

    this.run.drafts = [...drafts];
    this.run.stage = "publishing";
    this.persist(ctx);

    let baseAdvanced = false;
    for (const repository of changed) {
      const fetch = await git(this.runCommand, repository.path, ["fetch", "--prune", "origin"]);
      if (fetch.code !== 0) throw new Error(`git fetch failed in ${repository.name}: ${fetch.stderr.trim()}`);
      const baseSha = await requireGit(this.runCommand, repository.path, ["rev-parse", repository.baseRef]);
      if (baseSha !== repository.baseShaAtReview) baseAdvanced = true;
    }
    if (baseAdvanced) {
      this.run.stage = "rebasing";
      this.run.rebaseIndex = 0;
      for (const repository of changed) repository.pushed = false;
      this.archiveCurrentReview();
      delete this.run.review;
      delete this.run.drafts;
      this.persist(ctx);
      const prompt = await this.continueRebases(ctx);
      return this.result(`A default branch advanced after review. Publication was deferred.\n\n${prompt ?? "Rebase completed."}`);
    }

    for (const repository of changed) {
      if (!(await isClean(this.runCommand, repository.path))) throw new Error(`${repository.name} is dirty before push.`);
      const head = await requireGit(this.runCommand, repository.path, ["rev-parse", "HEAD"]);
      if (head !== repository.reviewedHead) throw new Error(`${repository.name} HEAD no longer matches its reviewed SHA.`);
      if (!repository.pushed) await this.pushRepository(repository);
      this.persist(ctx);
    }

    for (const repository of changed) {
      if (repository.pullRequestUrl) continue;
      const draft = byRepository.get(repository.name);
      if (!draft) continue;
      repository.pullRequestUrl = await this.upsertPullRequest(repository, draft.title, draft.body);
      this.persist(ctx);
    }

    const links = new Map(changed.flatMap((repository) => repository.pullRequestUrl ? [[repository.name, repository.pullRequestUrl] as const] : []));
    for (const repository of changed) {
      const draft = byRepository.get(repository.name);
      if (!draft || !repository.pullRequestUrl) continue;
      const body = withRelatedPullRequests(draft.body, links, repository.name);
      await this.editPullRequest(repository, draft.title, body);
    }

    this.run.stage = "complete";
    this.persist(ctx);
    const summary = changed.map((repository) => `- ${repository.name}: ${repository.pullRequestUrl}`).join("\n");
    return this.result(`Ship complete.\n\n${summary}`);
  }

  private async pushRepository(repository: ShipRepositoryState): Promise<void> {
    const destination = `HEAD:refs/heads/${repository.branch}`;
    const args = repository.remoteBranchSha
      ? [
          "push",
          `--force-with-lease=refs/heads/${repository.branch}:${repository.remoteBranchSha}`,
          "origin",
          destination,
        ]
      : ["push", "-u", "origin", destination];
    const result = await git(this.runCommand, repository.path, args);
    if (result.code !== 0) throw new Error(`Push failed in ${repository.name}: ${result.stderr.trim()}`);
    repository.remoteBranchSha = repository.head;
    repository.pushed = true;
  }

  private async upsertPullRequest(repository: ShipRepositoryState, title: string, body: string): Promise<string> {
    const existing = await this.pi.exec(
      "gh",
      ["pr", "list", "--repo", repository.githubRepository, "--head", repository.branch, "--state", "open", "--json", "number,url,isDraft"],
      { cwd: repository.path, timeout: 30_000 },
    );
    if (existing.code !== 0) throw new Error(`Could not list PRs for ${repository.name}: ${existing.stderr.trim()}`);
    const [pullRequest] = JSON.parse(existing.stdout) as Array<{ number: number; url: string; isDraft: boolean }>;
    if (pullRequest) {
      if (!pullRequest.isDraft) await this.markPullRequestDraft(repository, pullRequest.number);
      await this.editPullRequest(repository, title, body, pullRequest.number);
      return pullRequest.url;
    }

    return this.withBodyFile(body, async (bodyPath) => {
      const created = await this.pi.exec(
        "gh",
        [
          "pr",
          "create",
          "--draft",
          "--repo",
          repository.githubRepository,
          "--base",
          repository.baseBranch,
          "--head",
          repository.branch,
          "--title",
          title,
          "--body-file",
          bodyPath,
        ],
        { cwd: repository.path, timeout: 60_000 },
      );
      if (created.code !== 0) throw new Error(`Could not create PR for ${repository.name}: ${created.stderr.trim()}`);
      return created.stdout.trim();
    });
  }

  private async markPullRequestDraft(
    repository: ShipRepositoryState,
    number: number,
  ): Promise<void> {
    const result = await this.pi.exec(
      "gh",
      ["pr", "ready", String(number), "--undo", "--repo", repository.githubRepository],
      { cwd: repository.path, timeout: 30_000 },
    );
    if (result.code !== 0) throw new Error(`Could not convert PR to draft for ${repository.name}: ${result.stderr.trim()}`);
  }

  private async editPullRequest(
    repository: ShipRepositoryState,
    title: string,
    body: string,
    knownNumber?: number,
  ): Promise<void> {
    const selector = knownNumber ? String(knownNumber) : repository.pullRequestUrl;
    if (!selector) throw new Error(`No PR selector for ${repository.name}.`);
    await this.withBodyFile(body, async (bodyPath) => {
      const edited = await this.pi.exec(
        "gh",
        ["pr", "edit", selector, "--repo", repository.githubRepository, "--title", title, "--body-file", bodyPath],
        { cwd: repository.path, timeout: 60_000 },
      );
      if (edited.code !== 0) throw new Error(`Could not update PR for ${repository.name}: ${edited.stderr.trim()}`);
    });
  }

  private async withBodyFile<T>(body: string, callback: (path: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-ship-pr-"));
    const path = resolve(directory, "body.md");
    try {
      await writeFile(path, body, { encoding: "utf8", mode: 0o600 });
      return await callback(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private buildFixPrompt(): string {
    if (!this.run?.review?.decisions) throw new Error("No approved decisions are available.");
    const findings = new Map(this.run.review.result.findings.map((finding) => [finding.id, finding]));
    const fixes = this.run.review.decisions
      .filter((decision) => decision.action === "fix")
      .map((decision) => {
        const finding = findings.get(decision.findingId);
        return `- ${decision.findingId} (${finding?.repository ?? "unknown"}): ${finding?.recommendation ?? ""}\n  User guidance: ${decision.rationale}`;
      })
      .join("\n");
    return `Apply only these user-approved review fixes across the selected workspace:\n\n${fixes}\n\nRead surrounding and cross-repository code as needed. Do not commit. Run relevant tests in every changed repository, then call ship_report with action "fixes-complete" and repository reports containing exact test commands and outcomes.`;
  }

  private buildDraftPrompt(): string {
    if (!this.run?.intent) throw new Error("No ship intent is available.");
    const repositories = changedRepositories(this.run)
      .map(
        (repository) =>
          `### ${repository.name}\n\nSummary:\n${repository.summary ?? "Inspect the final diff."}\n\nTests:\n${testsMarkdown(repository.tests) || "- Not reported"}`,
      )
      .join("\n\n");
    return `Prepare one concise GitHub pull request title and body for every changed repository below. Each body must help a human reviewer who was not in this session and include: Intent, Changes, Decisions and tradeoffs, Cross-repository context, Testing, and Risks or follow-ups. Do not include an Independent review section, review history, finding dispositions, secrets, or the raw conversation. Do not ask for publication confirmation; /ship already authorized it. Call ship_report with action "publish" and all drafts.\n\n## Workspace intent\n\n${this.run.intent}\n\n${repositories}`;
  }

  private formatReview(): string {
    return this.run?.review ? formatFullReview(this.run.review) : "No review result.";
  }

  private validateReports(
    reports: readonly RepositoryReport[] | undefined,
    requiredRepositories: readonly string[],
  ): Map<string, RepositoryReport> {
    if (!reports) throw new Error("Repository reports are required.");
    const reportsByName = new Map(reports.map((report) => [report.repository, report]));
    if (reportsByName.size !== reports.length) throw new Error("Repository reports contain duplicate names.");
    for (const name of requiredRepositories) {
      const report = reportsByName.get(name);
      if (!report) throw new Error(`Missing repository report for ${name}.`);
      if (!report.summary.trim()) throw new Error(`Repository report for ${name} has no summary.`);
      if (report.tests.length === 0) throw new Error(`Repository report for ${name} must report tests or an explicit skip.`);
      for (const test of report.tests) {
        if (!test.command.trim()) throw new Error(`Repository report for ${name} contains an empty test command.`);
        if (test.status === "skipped" && !test.summary?.trim()) {
          throw new Error(`Skipped test in ${name} requires a reason.`);
        }
      }
    }
    for (const name of reportsByName.keys()) this.repository(name);
    return reportsByName;
  }

  private hasUserMessageAfterReview(ctx: ExtensionContext): boolean {
    const completedAt = this.run?.review?.completedAt ?? Number.POSITIVE_INFINITY;
    return ctx.sessionManager.getBranch().some((entry: SessionEntry) => {
      if (entry.type !== "message" || entry.message.role !== "user") return false;
      return entry.message.timestamp > completedAt;
    });
  }

  private async refreshRepository(repository: ShipRepositoryState): Promise<void> {
    repository.head = await requireGit(this.runCommand, repository.path, ["rev-parse", "HEAD"]);
    repository.baseSha = await requireGit(this.runCommand, repository.path, ["rev-parse", repository.baseRef]);
    repository.changed = await hasChangesAgainstBase(this.runCommand, repository.path, repository.baseRef);
  }

  private async commitIfDirty(repository: ShipRepositoryState, message: string): Promise<void> {
    if (await isClean(this.runCommand, repository.path)) return;
    await requireGit(this.runCommand, repository.path, ["add", "-A"], "stage ship changes");
    const staged = await git(this.runCommand, repository.path, ["diff", "--cached", "--quiet", "--"]);
    if (staged.code === 0) return;
    if (staged.code !== 1) throw new Error(`Could not inspect staged changes in ${repository.name}.`);
    await requireGit(this.runCommand, repository.path, ["commit", "-m", message], "commit ship changes");
  }

  private async unmergedPaths(path: string): Promise<string[]> {
    const output = await requireGit(this.runCommand, path, ["diff", "--name-only", "--diff-filter=U", "-z"]);
    return output.split("\0").filter(Boolean);
  }

  private async rebaseInProgress(path: string): Promise<boolean> {
    for (const name of ["rebase-merge", "rebase-apply"]) {
      const gitPath = await requireGit(this.runCommand, path, ["rev-parse", "--git-path", name]);
      if (existsSync(resolve(path, gitPath))) return true;
    }
    return false;
  }

  private async conflictPrompt(conflicts?: readonly string[]): Promise<string> {
    if (!this.run?.conflictRepository) throw new Error("No conflict repository is recorded.");
    const repository = this.repository(this.run.conflictRepository);
    const paths = conflicts ?? await this.unmergedPaths(repository.path);
    return `Rebase conflicts must be resolved in ${repository.name} (${repository.path}):\n\n${paths.map((path) => `- ${path}`).join("\n")}\n\nResolve the conflicts according to the workspace intent and surrounding contracts. Remove conflict markers and stage every resolved path with git add. Do not commit or abort the rebase. When all unmerged paths are staged, call ship_report with action "conflict-resolved".`;
  }

  private archiveCurrentReview(): void {
    const run = this.run;
    const review = run?.review;
    if (!review) return;
    run.reviewHistory ??= [];
    if (!run.reviewHistory.some((archived) => archived.completedAt === review.completedAt)) {
      run.reviewHistory.push(review);
    }
  }

  private repository(name: string): ShipRepositoryState {
    const repository = this.run?.repositories.find((candidate) => candidate.name === name);
    if (!repository) throw new Error(`Unknown selected repository: ${name}`);
    return repository;
  }

  private appendReviewEntry(): void {
    if (!this.run?.review) return;
    this.pi.appendEntry<ReviewEntryData>(REVIEW_ENTRY_TYPE, {
      runId: this.run.id,
      review: structuredClone(this.run.review),
    });
  }

  private sendPrompt(content: string): void {
    this.pi.sendMessage(
      { customType: "pi-ship", content, display: true, details: { runId: this.run?.id, stage: this.run?.stage } },
      { triggerTurn: true },
    );
  }

  private result(text: string): WorkflowResult {
    return { content: [{ type: "text", text }], details: { ...(this.run ? { run: this.run } : {}) } };
  }

  private persist(ctx: ExtensionContext): void {
    if (!this.run) return;
    this.run.updatedAt = Date.now();
    this.pi.appendEntry<ShipRun>(STATE_ENTRY, structuredClone(this.run));
    this.updateStatus(ctx);
  }

  private updateStatus(ctx: ExtensionContext): void {
    if (!this.run || !ACTIVE_STAGES.has(this.run.stage)) {
      ctx.ui.setStatus("pi-ship", undefined);
      ctx.ui.setWidget("pi-ship", undefined);
      return;
    }
    const changed = changedRepositories(this.run).length;
    const latestReview = this.run.review ?? this.run.reviewHistory?.at(-1);
    ctx.ui.setStatus("pi-ship", `ship: ${this.run.stage} (${changed}/${this.run.repositories.length} repos)`);
    ctx.ui.setWidget(
      "pi-ship",
      [
        `Ship ${this.run.id.slice(0, 8)} — ${this.run.stage}`,
        ...(latestReview ? [`  ${reviewHeadline(latestReview)}`] : []),
        ...this.run.repositories.map((repository) => `  ${repository.changed ? "●" : "○"} ${repository.name}`),
      ],
      { placement: "belowEditor" },
    );
  }
}
