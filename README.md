# @aduverger/pi-ship

Workspace-aware shipping workflow for the [Pi coding agent](https://pi.dev): rebase, simplify, independently review, test, push, and open cross-linked draft GitHub pull requests.

![ship-it](https://media1.tenor.com/m/YEIeLVDQpxsAAAAC/shipping-ship.gif)

## Requirements

- Pi 0.84 or newer
- Git
- GitHub CLI (`gh`), authenticated for `github.com`
- Clean, committed feature branches in every selected repository, including review-only context repositories

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
```

From a workspace directory that is not itself a Git repository, `/ship` discovers direct child Git roots:

```text
/ship
/ship emidat-api emidat-frontend
```

Operational commands:

```text
/ship status
/ship resume
/ship abort
```

`/ship` is the publication consent boundary. The workflow asks for user input only when independent-review findings require a decision or when conflict resolution requires semantic guidance. Once the approved final changes pass review, it pushes branches and creates or updates PRs without another confirmation.

## Workflow

1. Validate that every selected repository is clean, committed, and checked out on a non-default feature branch.
2. Resolve each repository's default branch independently of its configured upstream.
3. Fetch and rebase changed feature branches.
4. Simplify the listed changed-feature files, using Git line ranges as guidance rather than hard edit boundaries, then test and commit per repository.
5. Launch one fresh, read-only Pi reviewer over the complete selected workspace. It inherits the active model, always uses high thinking, can page through complete Git diffs, and focuses on concrete, proportionate correctness and maintainability findings.
6. Persist a visible repository-qualified findings summary in the active session branch and return the full review to the main agent for analysis and a user decision. Later review rounds receive prior accepted and deferred tradeoffs so they are not reported repeatedly.
7. Apply approved fixes, test, commit, and independently review the complete workspace again.
8. Verify that every pushed SHA exactly matches the reviewed SHA and that default branches have not advanced.
9. Push all changed branches, create or update one draft PR per changed repository, and cross-link related PRs.

Independent-review results stay in Pi and are not added as a dedicated PR section.

Unchanged selected repositories remain available to the reviewer as integration context and do not produce commits or PRs unless an approved review fix changes them.

The changed-line simplification prompt is adapted from [MattDevy/pi-simplify](https://github.com/MattDevy/pi-extensions/tree/main/packages/pi-simplify). See [NOTICE.md](NOTICE.md).

## Safety properties

- No dirty or default-branch repository enters the workflow.
- Reviewer subprocess has no bash, edit, or write tools.
- Rebased existing branches use `--force-with-lease` against the observed remote SHA.
- A moved default branch restarts rebase, simplification, and review before publication.
- Partial push/PR failures are resumable with `/ship resume`.
- New PRs are created as drafts, and existing ready PRs are converted back to draft before updates.
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
