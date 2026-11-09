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

The goal is durable confidence from the smallest maintained suite. Be pruning-first, not deletion-only: decide whether a test deserves to survive delivery before improving it. A plausible regression story or coverage increase alone does not justify retention.

## Principles

- **Require grounded, ongoing protection**: Retain or add tests only when expectations come from real contracts, known failures, meaningful properties, or authoritative reference implementations—not merely the code under test. Require a supported ongoing behavior or credible security/data-integrity risk, distinct protection not adequately provided by existing tests, and proportionate maintenance and fixture costs. Preserve contractual, security, and data-integrity coverage.
- **Prune implementation residue**: Remove or consolidate private-structure checks, incidental call/SQL/string assertions, duplicated production logic, trivial constructor checks, tests of framework/library behavior rather than application contracts, and redundant coverage. Investigate uncertainty; uncertainty alone is not a reason to keep a test.
- **Remove one-off verification tests**: Remove tests specific to one-off migrations or scripts, along with unused supporting fixtures, snapshots, and helpers. Recurring installation, upgrade, and script contracts may qualify for retention under the same criteria. Removing a check does not establish that the migration or script is correct; report verification evidence and remaining deployment checks.
- **Improve only tests worth keeping**: For each retained or added test, name its independent expectation, distinct protection, and a behavior-preserving refactor it should survive. Prefer extending an existing test over creating a new suite. Rewrite a valuable brittle test at the smallest stable seam; do not automatically replace deleted unit tests with larger integration or end-to-end tests. A narrow unit or private seam is appropriate when it protects the same real invariant without an elaborate public-boundary fixture.
- **Keep exact-output tests when exactness is contractual**: Whole snapshots and golden files are appropriate when consumers depend on the complete API payload, file format, generated artifact, or intentional CLI output. Otherwise prefer focused assertions on meaningful behavior.
- **Keep tests clear and reliable**: Tests should be deterministic, isolated, readable, appropriately fast for their level, and use only the data needed to express the behavior.
- **Ignore test-level labels as justification**: Apply the same retention criteria to unit, integration, and end-to-end tests. Neither coverage targets nor mandatory mutation-score thresholds establish that expectations are correct.

## Scope

Start with tests added or modified by the branch. Read related existing tests to identify duplicate coverage and missing behavior. You may add qualifying tests and modify or remove directly supporting fixtures, snapshots, helpers, and test configuration. Change related existing tests only when replacement or consolidation requires it; do not perform a whole-suite cleanup.

Production edits are allowed only within the original feature scope listed below, only when a durable test demonstrates that the implementation violates the already agreed intent. Do not invent product semantics or broaden the feature. If expected behavior is ambiguous or a valid fix requires production work outside that scope, stop and ask the user for guidance—even during an auto run.

Other selected repositories are read-only context.

${scopes}

## Process

1. Read repository AGENTS.md or CLAUDE.md files, the complete branch diff, relevant public interfaces, and related tests.
2. Identify grounded ongoing behaviors and risks, then prune tests that do not qualify for retention before considering rewrites or additions. Remove tests for intentionally removed behavior; do not preserve obsolete architecture.
3. Check existing coverage before adding a test for a missing, independently grounded risk. Prefer extending an existing test with focused assertions or readable table-driven cases over near-identical tests or new suites. Do not force test churn or a deletion quota when the existing coverage is appropriate.
4. Do not weaken, exclude, or bypass tests through configuration changes.
5. Do not commit; pi-ship owns commits.
6. Run the repository-standard affected validation defined by project instructions, CI, and established scripts. Do not invoke production systems or require unavailable credentials; report unavailable checks as skipped with a reason.
7. Call ship_report with action "testing-complete" and one repository report per changed repository. Each report must include:
   - a summary of the final repository changes, without mentioning workflow phases;
   - exact validation commands and outcomes;
   - testCuration counts for added, rewritten, consolidated, and removed test definitions in this pass, not parameterized cases or cumulative branch totals;
   - testCuration behaviors explaining representative removals/consolidations and the independent grounds and distinct ongoing protection for retained or added tests, or why no pruning candidates were found;
   - testCuration remainingGaps;
   - a concise one-line commitMessage if you edited that repository.

Test-curation details are internal evidence for the reviewer. They must not be presented as a pull-request workflow report.`;
}
