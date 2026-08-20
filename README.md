# pi-ship

Workspace-aware shipping workflow for the [Pi coding agent](https://pi.dev): rebase, simplify, independently review, test, push, and open cross-linked GitHub pull requests.

## Requirements

- Pi 0.84 or newer
- Git
- GitHub CLI (`gh`), authenticated for `github.com`
- Clean, committed feature branches in every selected changed repository

## Install locally

```bash
npm install
npm run build
pi install ./pi-ship
```

For development:

```bash
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

1. Validate that every selected repository is clean and committed.
2. Resolve each repository's default branch independently of its configured upstream.
3. Fetch and rebase changed feature branches.
4. Simplify only changed current-file line ranges, then test and commit per repository.
5. Launch one fresh, read-only Pi reviewer over the complete selected workspace. It inherits the active model and always uses high thinking.
6. Return repository-qualified findings to the main session for analysis and a user decision.
7. Apply approved fixes, test, commit, and independently review the complete workspace again.
8. Verify that every pushed SHA exactly matches the reviewed SHA and that default branches have not advanced.
9. Push all changed branches, create or update one PR per changed repository, and cross-link related PRs.

Unchanged selected repositories remain available to the reviewer as integration context but do not produce commits or PRs.

The changed-line simplification prompt is adapted from [MattDevy/pi-simplify](https://github.com/MattDevy/pi-extensions/tree/main/packages/pi-simplify). See [NOTICE.md](NOTICE.md).

## Safety properties

- No dirty repository enters the workflow.
- Reviewer subprocess has no bash, edit, or write tools.
- Rebased existing branches use `--force-with-lease` against the observed remote SHA.
- A moved default branch restarts rebase, simplification, and review before publication.
- Partial push/PR failures are resumable with `/ship resume`.
- `/ship abort` aborts active rebases but preserves already completed rebases and commits.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run check
```
