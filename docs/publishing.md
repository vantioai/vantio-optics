# Publishing Optics

This repository does not publish when a pull request merges. `.github/workflows/publish.yml` is `workflow_dispatch` only, and its publish jobs are disabled with `if: false`. Do not dispatch that workflow.

## Freeze while open-core publishes

Until the npm and PyPI trusted publishers point at this repository, `vantioai/vantio-open-core` is the publishing source. It publishes `@vantio/cli` 0.3.26 and `vantio-agent-sdk` 3.1.2 from sealed bytes. Those versions, plus `@vantio/agent-sdk` 0.2.4 and `@vantio/optics-mcp` 0.1.2, are live from open-core, not from this repository. The `package.json` and `pyproject.toml` links here name this repository, so a pack from this tree does not match those sealed bytes. Do not publish those versions from here. This tree is now `@vantio/cli` 0.3.27, `@vantio/agent-sdk` 0.2.5, `@vantio/optics-mcp` 0.1.3, and `vantio-agent-sdk` 3.1.3. Those are the first release numbers from this repository.

During the freeze, package code in `packages/` and `extensions/vantio-optics` stays byte-identical to open-core `main`. Make a code change in both repositories in the same change window. The `Open-core drift` workflow (`scripts/check_open_core_drift.py`) fails on any other difference. READMEs, changelogs, tests, and repository links may differ.

The freeze ends when the first releases from this repository (`@vantio/cli` 0.3.27, `@vantio/agent-sdk` 0.2.5, `@vantio/optics-mcp` 0.1.3, and `vantio-agent-sdk` 3.1.3) are cut, the trusted publishers are switched as described below, and the package directories are removed from open-core. Remove the drift workflow in that same change.

Registry check on 2026-10-21:

| Package | Registry | Latest | This tree |
| --- | --- | --- | --- |
| `@vantio/cli` | npm | 0.3.24 | 0.3.27 |
| `@vantio/agent-sdk` | npm | 0.2.4 | 0.2.5 |
| `@vantio/optics-mcp` | npm | 0.1.2 | 0.1.3 |
| `vantio-agent-sdk` | PyPI | 3.1.1 | 3.1.3 |

npm and PyPI reject a second upload of a version that already exists. A later publish from this tree is a new version, not a copy of 0.3.24 or 3.1.1.

## What the registries show today

`@vantio/cli@0.3.24` has registry signatures and no provenance attestation (`dist.attestations` is absent). `vantio-open-core`'s `.github/workflows/npm-publish.yml` does not call `npm publish` and does not set `id-token: write`. That file is not evidence that npm trusted publishing already released 0.3.24.

PyPI trusted publishing for `vantio-agent-sdk` is wired in `vantio-open-core` at `.github/workflows/pypi-publish.yml`. That workflow requires all of the following before it will upload:

- `GITHUB_REPOSITORY` is `vantioai/vantio-open-core`
- `GITHUB_WORKFLOW_REF` is `vantioai/vantio-open-core/.github/workflows/pypi-publish.yml@refs/heads/main`
- GitHub environment name `pypi`
- `id-token: write`
- `pypa/gh-action-pypi-publish`

It publishes a sealed 3.1.1 artifact. This repository does not contain that seal, those digests, or that custody tag.

## Switch npm trusted publishing to this repository

Do this once per package: `@vantio/cli`, `@vantio/agent-sdk`, and `@vantio/optics-mcp`. npm trusted publisher connections cannot be edited. Delete the old connection and create a new one. Docs: https://docs.npmjs.com/trusted-publishers

1. Merge a commit that contains `.github/workflows/publish.yml` on the default branch of `vantioai/vantio-optics`. The file must exist before the first publish. Leave `if: false` in place until the publisher records below exist and you intend to release a new version.
2. On npmjs.com open the package, then Settings, then Trusted Publisher.
3. If a GitHub Actions publisher names organization `vantioai` and repository `vantio-open-core`, delete that connection. If none exists, skip the delete.
4. Add a GitHub Actions publisher:
   - Organization or user: `vantioai`
   - Repository: `vantio-optics`
   - Workflow filename: `publish.yml` (filename only, with the `.yml` extension)
   - Environment name: `npm-publish` (must match the workflow `environment:` name)
   - Allowed actions: allow direct `npm publish`. The `publish-npm` job calls `npm publish`, not `npm stage publish`.
5. Create a GitHub Environment named `npm-publish` on `vantioai/vantio-optics`. Put required reviewers on it if you want a person to approve the dispatch. npm does not create that environment for you.
6. Use a GitHub-hosted runner (`ubuntu-latest`). npm trusted publishing does not accept self-hosted runners. Do not copy the open-core `VANTIO_ENROLLED_RUNNER` selector into this job.
7. The publish job needs `permissions: id-token: write` and `contents: read`. Do not set `NPM_TOKEN` or `NODE_AUTH_TOKEN` on the publish step.
8. Node.js must be `>=22.14.0` and the npm CLI must be `>=11.5.1`. Provenance is attached automatically for a public package published from a public repository. Do not set `provenance` to false.
9. Each package's `repository.url` must be `git+https://github.com/vantioai/vantio-optics.git`. That value is already set in this tree. Publish from the package directory so the monorepo `directory` field stays accurate.
10. A new trusted publisher must complete a successful publish within 2 days or the configuration expires. After it works, revoke leftover automation tokens you no longer need (npm package settings, Publishing access, "Require two-factor authentication and disallow tokens" is the token lockdown; trusted publishers keep working).
11. Only then delete the `publishing-disabled` job, remove `needs: publishing-disabled`, and remove `if: false` from `publish-npm`. Dispatch for a version that is not already on npm. The first npm releases from this repository are `@vantio/cli` 0.3.27, `@vantio/agent-sdk` 0.2.5, and `@vantio/optics-mcp` 0.1.3. `@vantio/cli` 0.3.26, `@vantio/agent-sdk` 0.2.4, and `@vantio/optics-mcp` 0.1.2 are already on npm (0.3.26 is live from `vantioai/vantio-open-core`), so publishing those again fails. Do not dispatch from this pull request.

`workflow_dispatch` validation uses the workflow file that was triggered. Keep the publish command in `publish.yml` itself. Do not hide `npm publish` behind a reusable workflow with a different filename.

## Switch PyPI trusted publishing to this repository

Project: `vantio-agent-sdk`. Docs: https://docs.pypi.org/trusted-publishers/

1. On GitHub, create an Environment named `pypi` on `vantioai/vantio-optics`.
2. On https://pypi.org/manage/project/vantio-agent-sdk/settings/publishing/ add a GitHub Actions publisher:
   - Owner: `vantioai`
   - Repository name: `vantio-optics`
   - Workflow name: `publish.yml`
   - Environment name: `pypi`
3. The workflow job must set `permissions: id-token: write`, `environment: pypi`, and use `pypa/gh-action-pypi-publish` with no password and no token. The disabled job in `publish.yml` is that shape.
4. After a publish from this repository succeeds, remove the publisher that names `vantioai/vantio-open-core` and workflow `pypi-publish.yml`. Until you remove it, open-core can still match its own workflow.
5. Do not republish 3.1.1 or 3.1.2. 3.1.2 is live from `vantioai/vantio-open-core`. The next PyPI upload from this tree is a new version. The tree's current version is 3.1.3, the first PyPI release number from this repository. Confirm that version is the one you mean before you delete `publishing-disabled`, remove `needs: publishing-disabled`, and remove `if: false` from `publish-pypi`.
6. Do not dispatch the workflow from this pull request. Do not create a tag as part of turning the publisher around.

## What stays disabled until those steps are done

`.github/workflows/publish.yml` has two parts:

- A `publishing-disabled` job that fails if someone dispatches the workflow.
- `publish-npm` and `publish-pypi` jobs with `if: false`, so they do not run, do not request an OIDC token, and do not upload.

Enabling publishing means, in order: trusted publishers point at `vantioai/vantio-optics` and `publish.yml`, GitHub environments exist, the version is new, then a reviewed change deletes `publishing-disabled`, removes `needs: publishing-disabled`, and removes `if: false`. This pull request does not do that.
