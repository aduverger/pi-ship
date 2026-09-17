# @aduverger/pi-ship

Workspace-aware shipping workflow for the [Pi coding agent](https://pi.dev): rebase, simplify, curate tests, independently review, validate, push, and open cross-linked draft GitHub pull requests.

![ship-it](https://media1.tenor.com/m/YEIeLVDQpxsAAAAC/shipping-ship.gif)

## Requirements

- Pi 0.84 or newer
- Git
- GitHub CLI (`gh`), authenticated for `github.com`
- Clean, committed feature branches in repositories included in simplify/test/review
- Clean default branches synchronized with `origin` in workspace context/config repositories

## Install

From npm:

```sh
pi install npm:@aduverger/pi-ship
```

From a checkout:

```sh
git clone https://github.com/aduverger/pi-ship.git
cd pi-ship
npm install
npm run build
pi install .
```

For a one-off development run:

```sh
pi -e ./dist/index.js
```

## Usage

Inside a Git repository, `/ship` targets only that repository:

```text
/ship
/ship --auto
```

From a workspace directory that is not itself a Git repository, `/ship` discovers direct child Git roots:

```text
/ship
/ship api frontend
/ship api frontend --auto
```

`--auto` makes the agent's evidence-based review dispositions authoritative without waiting for user approval. It stops applying fixes after the fifth independent review, then publishes with any remaining findings disclosed as PR follow-ups. If the base branch moves afterward, mandatory rebase validation may add review-only rounds; their findings are disclosed but not fixed. A ready PR with remaining blocking findings is returned to draft status.

Operational commands:

```text
/ship status
/ship resume
/ship abort
```

`/ship` is the publication consent boundary. The workflow asks for user input only when independent-review findings require a decision, conflict resolution requires semantic guidance, or test curation encounters ambiguous behavior or production work outside the original feature scope. Once the approved final changes pass review, it pushes branches and creates or updates PRs without another confirmation.

## Workflow

1. Validate that every selected repository is clean and committed.
2. Fetch each origin and resolve its default branch independently of the configured upstream.
3. Keep a default-branch repository only when its `HEAD` exactly matches the fetched remote, classifying it as workspace context/config; rebase changed feature branches.
4. Simplify the listed changed-feature files, using Git line ranges as guidance rather than hard edit boundaries, run focused validation, and commit per repository.
5. Curate branch-added or modified automated tests for durable confidence. Keep tests that protect observable behavior and survive behavior-preserving refactors; rewrite brittle but valuable tests, remove redundant or implementation-coupled tests, and add coverage only for meaningful gaps. Run the repository-standard affected validation and commit any changes per repository.
6. Launch one fresh, read-only Pi reviewer over the complete selected workspace. It inherits the active model, always uses high thinking, can page through complete Git diffs, and focuses on concrete, proportionate correctness and maintainability findings, including the durability of tests introduced by later fixes.
7. Persist a visible repository-qualified findings summary in the active session branch and return the full review to the main agent for evidence-based reachability and proportionality analysis. Normal runs wait for a user decision; `--auto` runs immediately apply the agent's structured disposition. Later review rounds receive every prior decision and rationale so fixes are verified against updated guidance and accepted or deferred tradeoffs are not reported repeatedly.
8. Apply approved fixes, test, commit each repository with a message describing its actual changes, and independently review the complete workspace again.
9. Verify that every pushed SHA exactly matches the reviewed SHA and that default branches have not advanced.
10. Push all changed branches, create or update one draft PR per changed repository, and cross-link related PRs.

Workflow-phase activity and independent-review results stay in Pi. Pull requests describe final changes and validation, not simplification or test-curation activity.

Unchanged feature-branch repositories remain available to the reviewer as integration context and do not produce commits or PRs unless an approved review fix changes them. Default-branch context/config repositories remain available in the workspace but are excluded from simplification, test curation, and independent review, and must stay unmodified throughout the run.

The changed-line simplification prompt is adapted from [MattDevy/pi-simplify](https://github.com/MattDevy/pi-extensions/tree/main/packages/pi-simplify). See [NOTICE.md](NOTICE.md).

## Safety properties

- No dirty repository enters the workflow; default-branch repositories must exactly match their fetched remote and remain immutable workspace context.
- Reviewer subprocess has no bash, edit, or write tools.
- Rebased existing branches use `--force-with-lease` against the observed remote SHA.
- A moved default branch restarts rebase, simplification, test curation, and review before publication.
- Partial push/PR failures are resumable with `/ship resume`.
- New PRs are created as drafts; existing PRs preserve their current readiness unless an auto run reaches its review cap with blocking findings, in which case affected PRs return to draft.
- `/ship abort` aborts active rebases but preserves already completed rebases and commits.

## Development

```sh
make check
make pack-check
```

Release a stable version from a clean, synchronized `main` branch:

```sh
make release VERSION=0.1.1
```

For a prerelease, use a non-`latest` npm tag:

```sh
make release VERSION=0.2.0-rc.1 NPM_TAG=next
```

The release target validates Git and npm state, updates package versions, runs all quality gates, publishes the public package, verifies the registry, and pushes the matching Git tag.

`.github/workflows/publish.yml` also supports npm trusted publishing with provenance. Configure the npm trusted publisher for repository `aduverger/pi-ship`, workflow `publish.yml`, and GitHub environment `npm`; dispatch with `dry_run: true` to verify release gates before publishing.
