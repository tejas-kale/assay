# CI and release

`.github/workflows/ci.yml` runs the pipeline. Every action in it is pinned by commit SHA, with its tag in a comment.

## The pipeline

| Job | Runner | When | What |
|---|---|---|---|
| `unit` | ubuntu-latest | every push and pull request | `npm run check` (typecheck, ESLint, node tests, ruff, pytest, the ratchet); on main, the release filter |
| `integration` | ubuntu-latest | every push, after `unit` | `npm run test:integration` under `xvfb-run`, with node-pty rebuilt for Electron |
| `release` | macos-latest | a push to main, after both, unless the filter skips it | version, build, sign, tag, GitHub release |

Node comes from `.node-version` (22, the lowest supported); Python and its dependencies from `uv sync --frozen`.

## The release filter

macOS minutes on a private repo count ten times, so a push that changes only these does not release:
`docs/**`, Markdown outside `plugin/`, `*.test.ts`, `python/tests/**`, `tests/**`, `.github/**`. The plugin's skills are
Markdown that ships in the app, so a change to them releases. `scripts/release-paths.ts` decides
(`git diff --name-only <before>..<sha>`, run in the `unit` job); a push it cannot compare (a new branch, a force push)
releases.

## Versions and trailers

`scripts/next-version.ts` takes the latest `v*` tag and bumps its patch, or its minor or major when a commit since the
tag carries a `Release: minor` or `Release: major` trailer; the largest wins. A trailer is what git parses as one
(`%(trailers:key=Release)`): a line in the message's last paragraph, never the subject or a line in the prose. With no tag yet, the version is 0.1.0.
CI writes it into `package.json` on the runner only (`npm version --no-git-tag-version`); the repo's `package.json`
keeps 0.1.0. `node scripts/next-version.ts` prints the next version; `--notes` prints the release notes, one line per
commit subject since the last tag.

## Build, sign, publish

- `npm run release:build`: `electron-builder --mac dmg zip --arm64 --publish never --config.forceCodeSigning=true`,
  so a build electron-builder cannot sign fails instead of shipping unsigned. The DMG is for a first install;
  the zip and `latest-mac.yml` are what the updater (slice 11d) reads.
- Hardened runtime, with `resources/entitlements.mac.plist` (`allow-jit`, `allow-unsigned-executable-memory`).
- Fuses (`build.electronFuses`): `runAsNode`, `enableNodeOptionsEnvironmentVariable` and
  `enableNodeCliInspectArguments` off; `enableEmbeddedAsarIntegrityValidation` and `onlyLoadAppFromAsar` on. The app
  runs its server and hooks with the system `node`, never with Electron as Node.
- The job then runs `gh release create v<version> --target <sha>`, which tags the pushed commit and uploads the DMG,
  the zip, the blockmaps and `latest-mac.yml`, with the notes. electron-builder does not publish: its GitHub publisher
  makes a draft, and the tag must name the commit CI tested.
- `npm run install-app` still builds and installs a local copy, ad-hoc signed and without the hardened runtime.

## Two pushes close together

The release job runs one at a time (`concurrency: release`), but not always in push order. When main has moved past
the commit by the time its job starts, and the commits after it will release, the job does nothing: the newer release
holds this commit, and this commit's version, computed from the tags it can reach, could collide with the newer one.
When the commits after it change only docs and tests, they release nothing, so it releases.

## Secrets

| Name | Kind | What |
|---|---|---|
| `CSC_LINK` | secret | the code-signing certificate and key, a .p12 in base64 |
| `CSC_KEY_PASSWORD` | secret | the .p12's password |
| `CSC_NAME` | variable | the certificate's common name, when electron-builder does not find the identity by itself |

The release job stops when `CSC_LINK` is empty, and electron-builder fails when it cannot sign, so an unsigned build
never ships. `scripts/ci-release-setup.sh` walks
through making the certificate and adding these.

## The certificate switch

Today the certificate is self-signed. The Developer ID, later, changes these secrets, plus notarization's, and
`CSC_NAME`: set it to the Developer ID's name or delete it, or it keeps choosing the old certificate's name. A
build signed by a new identity is a different app to macOS: install the first Developer ID build by hand once, from
its DMG, and allow it in System Settings > Privacy & Security, as with the first self-signed build.

If node-pty will not load under the self-signed identity (library validation), add
`com.apple.security.cs.disable-library-validation` to the entitlements, and drop it again with the Developer ID.

## When main is red

Fix forward: nothing ships until main is green again. Do not revert to get a release out unless the fix will take
longer than a day.

## First runs

The workflow is verified by its first runs. Record the first green release here: its version, date and run link.

- Not yet run.
