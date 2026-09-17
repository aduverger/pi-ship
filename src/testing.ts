import { formatChangedFile } from "./simplify.js";
import type { ShipRepositoryState } from "./types.js";

function formatRepository(repository: ShipRepositoryState): string {
  const files = repository.simplifyScope.map(formatChangedFile).join("\n");
  return `### ${repository.name}

Repository root: ${repository.path}
Base: ${repository.baseRef}

Original feature scope:
${files}`;
}

export function buildWorkspaceTestingPrompt(repositories: readonly ShipRepositoryState[]): string {
  const scopes = repositories
    .filter((repository) => repository.changed)
    .map(formatRepository)
    .join("\n\n");

  return `The /ship workflow has committed the simplified changes. Curate the tests for the complete branch diff before independent review.

The goal is durable confidence, not more tests, fewer tests, or a coverage target. A durable test detects meaningful behavior changes while remaining insensitive to behavior-preserving implementation changes.

## Principles

- **Test behavior, not structure**: Prefer observable outcomes, contracts, invariants, regressions, boundaries, and meaningful failure modes through stable public interfaces.
- **Use two counterfactuals**: For each in-scope test, ask whether it would fail for a plausible regression and remain green after a plausible behavior-preserving refactor.
- **Be conservative when removing**: Keep a test when its value is uncertain. Rewrite a valuable but brittle test instead of deleting its protection.
- **Avoid false confidence**: Remove or consolidate tests that merely mirror private methods, branches, internal state, incidental call sequences, production logic, framework behavior, or coverage targets, or that duplicate protection without a distinct risk.
- **Keep exact-output tests when exactness is contractual**: Whole snapshots and golden files are appropriate when consumers depend on the complete API payload, file format, generated artifact, or intentional CLI output. Otherwise prefer focused assertions on meaningful behavior.
- **Keep tests clear and reliable**: Tests should be deterministic, isolated, readable, appropriately fast for their level, and use only the data needed to express the behavior.
- **Respect test level**: Apply these criteria to every changed automated test. Integration and end-to-end tests may legitimately use broader boundaries and infrastructure than unit tests.

## Scope

Start with tests added or modified by the branch. Read related existing tests to identify duplicate coverage and missing behavior. You may add tests and modify directly supporting fixtures, snapshots, helpers, and test configuration. Change related existing tests only when replacement or consolidation requires it; do not perform a whole-suite cleanup.

Production edits are allowed only within the original feature scope listed below, only when a durable test demonstrates that the implementation violates the already agreed intent. Do not invent product semantics or broaden the feature. If expected behavior is ambiguous or a valid fix requires production work outside that scope, stop and ask the user for guidance—even during an auto run.

Other selected repositories are read-only context.

${scopes}

## Process

1. Read repository AGENTS.md or CLAUDE.md files, the complete branch diff, relevant public interfaces, and related tests.
2. Identify the durable behaviors and risks the changed code should protect.
3. Keep, rewrite, consolidate, remove, or add tests using the principles above. Do not force test churn when the existing coverage is appropriate.
4. Do not weaken, exclude, or bypass tests through configuration changes.
5. Do not commit; pi-ship owns commits.
6. Run the repository-standard affected validation defined by project instructions, CI, and established scripts. Do not invoke production systems or require unavailable credentials; report unavailable checks as skipped with a reason.
7. Call ship_report with action "testing-complete" and one repository report per changed repository. Each report must include:
   - a summary of the final repository changes, without mentioning workflow phases;
   - exact validation commands and outcomes;
   - testCuration counts for added, rewritten, consolidated, and removed tests;
   - testCuration behaviors listing important protection retained or added;
   - testCuration remainingGaps;
   - a concise one-line commitMessage if you edited that repository.

Test-curation details are internal evidence for the reviewer. They must not be presented as a pull-request workflow report.`;
}
