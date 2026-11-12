# CI and release

`.github/workflows/ci.yml` runs the pipeline. Every action in it is pinned by commit SHA, with its tag in a comment.

## The pipeline

| Job | Runner | When | What |
|---|---|---|---|
| `unit` | ubuntu-latest | every push and pull request | `npm run check` (typecheck, ESLint, node tests, ruff, pytest, the coverage bar), `npm audit --audit-level=high`, `pip-audit` on every locked Python group; on main, the release filter |
| `integration` | ubuntu-latest | every push, after `unit` | `npm run test:integration` under `xvfb-run`, with node-pty rebuilt for Electron |
| `release` | macos-latest, environment `release` | a push to main, after both, unless the filter skips it | version, build, sign, notarize, fuse check, tag, GitHub release |

Node comes from `.node-version` (22, the lowest supported); uv is pinned in `setup-uv`; Python and its dependencies
come from `uv sync --frozen`. `scripts/workflow.test.ts` pins the workflow's security properties (docs/process/security.md).

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
- The release job installs with `npm ci --ignore-scripts`, then runs only the repo's own `scripts/postinstall.mjs`, so
  no dependency's install script runs on the machine about to hold the signing secrets. Its checkout keeps no token
  in `.git/config`; the one `git fetch` that needs it passes it for that call.
- Hardened runtime, with `resources/entitlements.mac.plist` (`allow-jit`, `allow-unsigned-executable-memory`).
- Fuses (`build.electronFuses`) are all set: `runAsNode`, `enableNodeOptionsEnvironmentVariable`,
  `enableNodeCliInspectArguments` and `loadBrowserProcessSpecificV8Snapshot` off; `enableCookieEncryption`,
  `enableEmbeddedAsarIntegrityValidation`, `onlyLoadAppFromAsar` and `grantFileProtocolExtraPrivileges` on (the
  renderer loads from `file://`). The app runs its server and hooks with the system `node`, never with Electron as
  Node. After the build, `node scripts/fuse-check.ts dist/mac-arm64/Assay.app` reads the built app's fuses and fails
  unless each is as package.json sets it.
- The job then runs `gh release create v<version> --target <sha>`, which tags the pushed commit and uploads the DMG,
  the zip, the blockmaps and `latest-mac.yml`, with the notes. electron-builder does not publish: its GitHub publisher
  makes a draft, and the tag must name the commit CI tested.
- `mac.notarize` is on: electron-builder notarizes the signed app with the API key below and staples the ticket.
- `npm run install-app` still builds and installs a local copy, ad-hoc signed and without the hardened runtime.

## Two pushes close together

The release job runs one at a time (`concurrency: release`), but not always in push order. When main has moved past
the commit by the time its job starts, and the commits after it will release, the job does nothing: the newer release
holds this commit, and this commit's version, computed from the tags it can reach, could collide with the newer one.
When the commits after it change only docs and tests, they release nothing, so it releases.

## Secrets

The five secrets live in the GitHub Environment `release`, whose deployment branches are limited to `main`; the
`release` job names it (`environment: release`). Repository secrets would be readable by a workflow edited on any
pushed branch. To set it up once: Settings, Environments, New environment `release`; Deployment branches and tags,
Selected branches, add `main`; add the five secrets there; then delete the repository secrets of the same names.

| Name | What |
|---|---|
| `CSC_LINK` | the Developer ID Application certificate and its key, a .p12 in base64 |
| `CSC_KEY_PASSWORD` | the .p12's password |
| `APPLE_API_KEY` | an App Store Connect API key (Team key, Developer access), the text of its .p8 |
| `APPLE_API_KEY_ID` | that key's ID |
| `APPLE_API_ISSUER` | the Issuer ID shown above the team keys |

The release job stops when any of these is empty: electron-builder would otherwise ship an unsigned build, or skip
notarization with only a warning. It writes the .p8 to a file for electron-builder, which signs the app with the
Developer ID, notarizes it with `notarytool` and staples the ticket. `scripts/ci-release-setup.sh` walks through
making the certificate and the key and adding these.

The certificate expires after five years, and only the team's Account Holder can make a new one. The API key does not
expire; revoke it in App Store Connect if it leaks.

## Installing

A notarized build opens without a warning. The first Developer ID build replaces any copy installed before it
(`npm run install-app`'s ad-hoc build): install it by hand once, from its DMG. Later releases update it (slice 11d).
`npm run install-app` still builds an ad-hoc signed local copy, which notarization skips.

## Updates

A release updates itself (`src/main/update.ts`, decisions in `src/core/update.ts`); `npm run dev` never does.

- The token: a fine-grained GitHub token for `tejas-kale/assay`, Contents read-only, pasted in Settings > Updates.
  Main encrypts it with `safeStorage` (the Keychain) into `update-token.bin` in the app's data folder; the renderer
  only learns whether one is kept. electron-updater's private GitHub provider sends it as the `authorization` header on
  every request, the release list and the downloads. Without a token the updater is off and Settings says so; a
  check still running when the token is forgotten changes nothing, and a later download does not install at quit.
  A saved token the Keychain cannot decrypt shows as an error, not as no token.
- Checks: 10 seconds after launch, then an hour after the last one started; none while a download runs or one waits
  to install. `autoDownload` and `autoInstallOnAppQuit` are on.
- Ready only once macOS's own updater (Squirrel.Mac) has fetched and checked the zip: electron-updater reports a
  download before that step, which can still fail. Then every analysis view shows `Assay <version> is ready. Restart`, and the palette lists `Restart to update`.
  Restart runs the Cmd+Q close flow (each Claude exits, a launcher finishes its import), then `quitAndInstall`. The
  open set is saved, so the relaunch reopens the same analyses, each with a new Claude session. If the app is still
  running 30 seconds after `quitAndInstall`, the update is dropped with an error in Settings and the analyses reopen.
  The decisions for Cmd+Q and Restart are in `src/core/shutdown.ts`.
- Keep waiting, in the dialog that a second Cmd+W or Cmd+Q on a closing analysis shows, only keeps waiting: a quit or
  restart under way still ends once that session exits, and the saved set stays whole.
- Errors never interrupt: Settings > Updates shows the version, what the updater is doing, the last check and the
  last error. A downloaded update stays ready through later errors.

### The manual test

On the Mac, with release N installed from its DMG and a token saved: push a change that releases, wait for release
N+1, and check that the banner appears within the hour (or relaunch to check at once), that Restart reopens the same
analyses, and that Settings then shows N+1. Record each run here.

## When main is red

Fix forward: nothing ships until main is green again. Do not revert to get a release out unless the fix will take
longer than a day.

## First runs

The workflow is verified by its first runs. Record the first green release here: its version, date and run link.

- v0.1.0, 2026-11-11: the first green release, signed with the Developer ID and notarized, on the fourth attempt of
  https://github.com/tejas-kale/assay/actions/runs/43033377311 (the first three stopped on missing or wrong secrets).
