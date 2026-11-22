# VAN-363: CODEOWNERS for vantio-optics

Base: `main` at `8bee543`. Branch `engineering/van-363-no-codeowners-file-in-nine-vantioai`, draft pull request (public repo; its CI runs normally). No VM run. No workflow dispatch. No settings change.

## Finding

`vantio-optics` had no `CODEOWNERS`, `.github/CODEOWNERS` or `docs/CODEOWNERS` on `main` (VAN-156 audit), so "require review from code owners" could not be turned on.

## Change

Option A on VAN-363 (taken under Zach's standing go): `.github/CODEOWNERS` names `@zacharybalicki` on `*` and on `/.github/`, the same file as in vantio-company, vantio-deploy and vantio-enterprise. No other path owners. No branch rule is turned on; that setting stays Zach's.

This is a config-only change, so there is no new test. The repo's existing checks and GitHub's own CODEOWNERS check (`GET repos/vantioai/vantio-optics/codeowners/errors?ref=engineering/van-363-no-codeowners-file-in-nine-vantioai`) were run on the pushed head; results are on VAN-363.

## Gaps

- GitHub applies CODEOWNERS from the default branch only. Until this merges, nothing changes.
- Requiring code-owner review is a branch protection setting; not changed.
