import type { ChangedFile, ShipRepositoryState } from "./types.js";

function formatFile(file: ChangedFile): string {
  if (file.status === "added") return `- ${file.path} (added; entire file is in scope)`;
  if (file.changedLines === undefined) {
    return `- ${file.path} (${file.status}; changed lines unavailable — inspect git diff before editing)`;
  }
  if (file.changedLines.length === 0) {
    return `- ${file.path} (${file.status}; deletions only — no current lines to simplify)`;
  }

  const ranges = file.changedLines.map(({ start, end }) => (start === end ? `${start}` : `${start}-${end}`));
  return `- ${file.path} (${file.status}; changed lines: ${ranges.join(", ")})`;
}

export function buildRepositorySimplificationPrompt(repository: ShipRepositoryState): string {
  const fileList = repository.simplifyScope.map(formatFile).join("\n");
  return `### ${repository.name}

Repository root: ${repository.path}
Base: ${repository.baseRef}

${fileList}`;
}

export function buildWorkspaceSimplificationPrompt(repositories: readonly ShipRepositoryState[]): string {
  const changedRepositories = repositories.filter((repository) => repository.changed);
  const scopes = changedRepositories.map(buildRepositorySimplificationPrompt).join("\n\n");

  return `The /ship workflow has rebased every changed repository. Simplify the committed changes below and prepare the workspace for independent review.

First derive a concise workspace intent from the conversation: the user's goal, requirements, constraints, accepted decisions, and important tradeoffs. Preserve that intent for the reviewer and pull requests.

## Principles

- **Preserve functionality**: Never change what the code does. All existing tests must continue to pass.
- **Apply project standards**: Read and follow CLAUDE.md or AGENTS.md in each repository.
- **Enhance clarity**: Reduce unnecessary complexity and nesting, eliminate redundant code and abstractions, improve variable and function names, and consolidate related logic. Keep valuable comments that explain design rationale, business rules, non-obvious behaviour, or intent. Remove only truly redundant noise. Avoid nested ternary operators: prefer switch statements or if/else chains for multiple conditions.
- **Maintain balance**: Do not over-simplify. Avoid clever solutions that are hard to understand. Do not combine too many concerns into one function. Do not remove helpful abstractions. Prioritize readability over fewer lines.

## Scope

Review and modify only the files listed below. Changed line numbers refer to the current file contents and identify the feature diff to prioritize, but they are not hard edit boundaries. You may simplify surrounding implementation within a listed file when it directly improves the changed feature. Other selected repositories are read-only context. For added files, the entire file is in scope.

${scopes}

## Process

1. Work through each changed repository and file.
2. Apply only concrete simplifications within the listed scope.
3. Do not commit; pi-ship owns commits.
4. Run the relevant existing tests in every changed repository. If no suitable test exists, report it as skipped with a reason.
5. Call ship_report with action "simplification-complete", the workspace intent, and one repository report per changed repository. Include every test command and outcome.

Do not add features, change public APIs, or refactor files that are not listed. If a worthwhile simplification requires an out-of-scope file edit, leave it alone and mention it in that repository's summary.`;
}
