import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  ReviewResult,
  ReviewerManifest,
  ReviewerPriorDecision,
  StoredReview,
} from "./types.js";

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const executable = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
  return { command: "pi", args };
}

function reviewerExtensionPath(): string {
  const currentPath = fileURLToPath(import.meta.url);
  const extension = extname(currentPath);
  return join(dirname(currentPath), `reviewer-child${extension}`);
}

export function collectReviewerPriorDecisions(
  reviews: readonly StoredReview[],
): ReviewerPriorDecision[] {
  return reviews.flatMap((review) => {
    const findings = new Map(review.result.findings.map((finding) => [finding.id, finding]));
    return (review.decisions ?? []).flatMap((decision) => {
      if (decision.action === "fix") return [];
      const finding = findings.get(decision.findingId);
      if (!finding) return [];
      return [{
        round: review.round,
        findingId: finding.id,
        repository: finding.repository,
        title: finding.title,
        action: decision.action,
        rationale: decision.rationale,
      }];
    });
  });
}

export function buildReviewPrompt(manifest: ReviewerManifest): string {
  const repositories = manifest.repositories
    .map(
      (repository) =>
        `- ${repository.name}: ${repository.changed ? "CHANGED — review complete diff" : "unchanged integration context"}\n  path: ${repository.path}\n  branch: ${repository.branch}\n  base: ${repository.baseRef}`,
    )
    .join("\n");
  const priorDecisions = manifest.priorDecisions ?? [];
  const priorDecisionSection = priorDecisions.length > 0
    ? priorDecisions
        .map(
          (decision) =>
            `- Round ${decision.round}, ${decision.findingId} (${decision.repository}): ${decision.title}\n  ${decision.action}: ${decision.rationale}`,
        )
        .join("\n")
    : "- None";

  return `Review this workspace as one coherent change.

## Intent

${manifest.intent}

## Selected repositories

${repositories}

## Prior accepted or deferred findings

${priorDecisionSection}

These are deliberate user decisions. Do not report the same concern again unless the implementation materially changes its evidence, likelihood, or impact. A recommendation must remain proportionate to the demonstrated risk.

Use ship_git to inspect every changed repository's summary, name-status, complete diff, and commit history. When ship_git returns a nextCursor, repeat the same request with that cursor until complete is true. Read surrounding implementation and selected unchanged repositories where needed. Check cross-repository contracts explicitly. Do not edit files. Finish by calling submit_review exactly once.`;
}

function isReviewResult(value: unknown): value is ReviewResult {
  if (!value || typeof value !== "object") return false;
  const review = value as Partial<ReviewResult>;
  return (review.verdict === "pass" || review.verdict === "findings") && Array.isArray(review.findings);
}

export async function runWorkspaceReviewer(
  ctx: ExtensionContext,
  manifest: ReviewerManifest,
  signal: AbortSignal | undefined,
  onProgress?: (message: string) => void,
): Promise<ReviewResult> {
  if (!ctx.model) throw new Error("No active model is available for code review.");

  const tempDirectory = await mkdtemp(join(tmpdir(), "pi-ship-review-"));
  const manifestPath = join(tempDirectory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest), { encoding: "utf8", mode: 0o600 });

  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "-e",
    reviewerExtensionPath(),
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "--no-approve",
    "--model",
    `${ctx.model.provider}/${ctx.model.id}`,
    "--thinking",
    "high",
    "--tools",
    "read,grep,find,ls,ship_git,submit_review",
    buildReviewPrompt(manifest),
  ];

  let review: ReviewResult | undefined;
  let stderr = "";
  let wasAborted = false;

  try {
    const exitCode = await new Promise<number>((resolveExit) => {
      const invocation = getPiInvocation(args);
      const child = spawn(invocation.command, invocation.args, {
        cwd: manifest.root,
        env: { ...process.env, PI_SHIP_REVIEW_MANIFEST: manifestPath },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const decoder = new StringDecoder("utf8");
      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }

        if (event.type === "tool_execution_start") {
          onProgress?.(`Reviewer: ${String(event.toolName ?? "tool")}`);
        }
        if (event.type === "tool_execution_end" && event.toolName === "submit_review") {
          const result = event.result as { details?: { review?: unknown } } | undefined;
          if (isReviewResult(result?.details?.review)) review = result.details.review;
        }
        if (event.type === "message_end") {
          const message = event.message as { role?: string; toolName?: string; details?: { review?: unknown } } | undefined;
          if (message?.role === "toolResult" && message.toolName === "submit_review" && isReviewResult(message.details?.review)) {
            review = message.details.review;
          }
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          let line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          processLine(line);
        }
      });
      child.stdout.on("end", () => {
        buffer += decoder.end();
        if (buffer) processLine(buffer);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-50_000);
      });
      child.on("error", () => resolveExit(1));
      child.on("close", (code) => resolveExit(code ?? 1));

      const abort = () => {
        wasAborted = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });

    if (wasAborted) throw new Error("Workspace review was aborted.");
    if (exitCode !== 0) throw new Error(`Reviewer exited with code ${exitCode}: ${stderr.trim() || "no diagnostics"}`);
    if (!review) throw new Error(`Reviewer did not submit a structured result.${stderr.trim() ? ` ${stderr.trim()}` : ""}`);

    const findings = review.findings.map((finding, index) => ({
      ...finding,
      id: finding.id.trim() || `R${index + 1}`,
      relatedRepositories: finding.relatedRepositories ?? [],
    }));
    return {
      ...review,
      verdict: findings.length === 0 ? "pass" : "findings",
      findings,
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}
