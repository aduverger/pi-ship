import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  formatFullReview,
  formatReviewSummary,
  REVIEW_ENTRY_TYPE,
  type ReviewEntryData,
} from "./review-display.js";
import type { ShipReportInput } from "./types.js";
import { ShipWorkflow } from "./workflow.js";

const TestSchema = Type.Object({
  command: Type.String(),
  status: StringEnum(["passed", "skipped"] as const),
  summary: Type.Optional(Type.String()),
});

const RepositoryReportSchema = Type.Object({
  repository: Type.String(),
  summary: Type.String(),
  tests: Type.Array(TestSchema),
});

const DecisionSchema = Type.Object({
  findingId: Type.String(),
  action: StringEnum(["fix", "accept", "defer"] as const),
  rationale: Type.String(),
});

const DraftSchema = Type.Object({
  repository: Type.String(),
  title: Type.String(),
  body: Type.String(),
});

const ShipReportSchema = Type.Object({
  action: StringEnum([
    "conflict-resolved",
    "simplification-complete",
    "decision",
    "fixes-complete",
    "publish",
  ] as const),
  intent: Type.Optional(Type.String()),
  repositories: Type.Optional(Type.Array(RepositoryReportSchema)),
  decisions: Type.Optional(Type.Array(DecisionSchema)),
  drafts: Type.Optional(Type.Array(DraftSchema)),
});

export default function piShip(pi: ExtensionAPI): void {
  const workflow = new ShipWorkflow(pi);

  pi.on("session_start", (_event, ctx) => workflow.restore(ctx));
  pi.on("session_tree", (_event, ctx) => workflow.restore(ctx));

  pi.registerEntryRenderer<ReviewEntryData>(REVIEW_ENTRY_TYPE, (entry, { expanded }, theme) => {
    const review = entry.data?.review;
    if (!review) return;

    let color: "error" | "warning" | "success" = "success";
    if (review.result.findings.some((finding) => finding.severity === "blocking")) color = "error";
    else if (review.result.findings.length > 0) color = "warning";

    const content = expanded ? formatFullReview(review) : formatReviewSummary(review);
    const [headline = "Independent review", ...details] = content.split("\n");
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text([theme.fg(color, headline), ...details].join("\n"), 0, 0));
    return box;
  });

  pi.on("before_agent_start", (event) => {
    const guidance = workflow.guidance();
    if (!guidance) return;
    return { systemPrompt: `${event.systemPrompt}\n\nActive pi-ship workflow:\n${guidance}` };
  });

  pi.registerCommand("ship", {
    description: "Rebase, simplify, independently review, and publish one repo or a workspace",
    handler: async (args, ctx) => {
      const command = args.trim();
      try {
        if (command === "status") {
          ctx.ui.notify(workflow.status(ctx), "info");
          return;
        }
        if (command === "resume") {
          await workflow.resume(ctx);
          return;
        }
        if (command === "abort") {
          await workflow.abort(ctx);
          return;
        }
        await workflow.start(args, ctx);
      } catch (error) {
        workflow.recordError(ctx, error);
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "ship_report",
    label: "Ship Report",
    description: "Advance the active /ship workflow with structured simplification, review-decision, fix, or PR data.",
    executionMode: "sequential",
    parameters: ShipReportSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        return await workflow.handleReport(
          params as ShipReportInput,
          ctx,
          signal,
          (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: {} }),
        );
      } catch (error) {
        workflow.recordError(ctx, error);
        throw error;
      }
    },
  });
}
