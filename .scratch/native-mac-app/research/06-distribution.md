# Research: how the app is signed, notarised, released and updated

Ticket: [06-distribution](../issues/06-distribution.md). Researched 2026-11-12.

Every claim below carries its source. **Unconfirmed** marks a claim that no primary source settles; the reason is
given. Some sites were unreachable from this session (docs.github.com, sparkle-project.org, docs.astral.sh), so their
pages were read from the repositories they are built from, pinned to a commit; the links point at the published page
and, where it matters, at the source file.

Sources read from repositories:

- GitHub docs: `github/docs` at `2b4f2c7` (2026-11-11).
- Sparkle docs: `sparkle-project/sparkle-project.github.io` at `6524f21` (2026-10-31); Sparkle source:
  `sparkle-project/Sparkle` branch `2.x` at `4b20aee` (2026-11-11); latest tag 2.10.1.
- uv: `astral-sh/uv` at `f45ea9b` (2026-11-10). python-build-standalone: `astral-sh/python-build-standalone` at `9244801`.
- runner images: `actions/runner-images` `main`, read 2026-11-12.

## 1. Signing and notarisation

### What notarisation requires

- Apple's notary service requires: every executable signed, with a **Developer ID** certificate (not Mac
  Distribution, ad hoc or development); the **Hardened Runtime** enabled; a **secure timestamp**; no
  `com.apple.security.get-task-allow` entitlement set to true; and well-formed XML entitlements.
  ([Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution))
- Since macOS 10.15, all Developer ID software built after 1 June 2019 must be notarised. Notarisation is an automated
  scan, not App Review. (same page)
- The service accepts apps (in a zip), UDIF disk images and flat installer packages, and processes nested containers,
  issuing a ticket for the top-level file and each nested item.
  ([Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow))
- Hardened-runtime entitlements go on executables only: "Shared libraries, frameworks, and in-process plug-ins inherit
  the entitlements of their host executable." All default to false; include an entitlement only when true.
  ([Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime))
- The Hardened Runtime turns on **library validation**: a process may load only code signed by Apple or with the same
  Team ID as its main executable. `com.apple.security.cs.disable-library-validation` lifts this, and Gatekeeper runs
  extra checks on programs that use it.
  ([Disable Library Validation Entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-library-validation);
  Quinn, [Resolving Library Loading Problems](https://developer.apple.com/forums/thread/706437))
- Electron needed `allow-jit` and `allow-unsigned-executable-memory` (`docs/process/ci-release.md`). A Swift app with
  WKWebView should need neither, since the web content runs in WebKit's own processes. **Unconfirmed**: no Apple page
  read here says so; check by signing without them.

### notarytool, locally

- `altool` is no longer accepted (since 1 November 2023); use `notarytool` (Xcode 13+) or the Notary REST API.
  ([Notarizing…](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution))
- Submit with `xcrun notarytool submit <file> --keychain-profile "<name>" --wait`. Credentials are stored once with
  `xcrun notarytool store-credentials`. Apple's example shows Apple ID, team ID and an app-specific password (2FA makes
  an app-specific password necessary). `notarytool log <id>` fetches the JSON log; Apple says to read it even on
  success.
  ([Customizing…](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow))
- `store-credentials` also accepting an API key (`--key`, `--key-id`, `--issuer`) is **unconfirmed** from Apple's page,
  which shows only the Apple ID form. The flags appear in `notarytool --help`; check on the Mac.
- A zip cannot be stapled. Staple the `.app` (or the dmg or pkg) with `xcrun stapler staple`, then zip it again for
  distribution. Without a staple, Gatekeeper finds the ticket online. (same page)
- Most submissions finish within 5 minutes and 98% within 15. Apple asks for no more than 75 notarisations a day, and
  for non-executable files to go in `Contents/Resources`, not `Contents/MacOS`. (same page)
- A network installer must have both the installer and the items it downloads notarised. (same page) This bears on
  §3: Apple's model expects downloaded code to be notarised *if* Gatekeeper will assess it.

### The API key for CI

- notarytool can authenticate with an App Store Connect API key. **Team** keys work; **Individual** keys "aren't able
  to use … `notaryTool`". The private key (.p8) can be downloaded only once, and Apple keeps no copy. Generating team
  keys needs an Admin account.
  ([Creating API Keys for App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api))
- The same key signs JWTs for the Notary REST API, which removes the need for macOS for the submit and status steps
  only. Signing still needs a Mac.
  ([Submitting software for notarization over the web](https://developer.apple.com/documentation/notaryapi/submitting-software-for-notarization-over-the-web))
- Electron Assay already holds such a key (`APPLE_API_KEY`, `_ID`, `_ISSUER`) and a Developer ID .p12 (`CSC_LINK`)
  as repository secrets, and its first green notarised release was v0.1.0 on 2026-11-11 (`docs/process/ci-release.md`).
  The same certificate and key can sign the Swift app; they belong to the team, not to the app.

### The certificate

- Only the **Account Holder** can create Developer ID certificates. A team can have up to five Developer ID
  Application certificates. "Cloud-managed" Developer ID certificates also exist, for admins with that role.
  ([Create Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates))
- Cloud-managed certificates are documented only for Xcode's Organizer archive-and-distribute flow (Xcode 13+).
  ([Cloud-managed certificates](https://developer.apple.com/help/account/certificates/cloud-managed-certificates))
  Whether `xcodebuild -exportArchive` can cloud-sign Developer ID in CI with an API key is **unconfirmed**.
- When a Developer ID Application certificate expires, software already signed with it still downloads, installs and
  runs, but new releases need a new certificate. If it is revoked, the software it signed can no longer be installed.
  ([Certificates support page](https://developer.apple.com/support/certificates/))
- The five-year validity stated in `docs/process/ci-release.md` is **unconfirmed** by the Apple pages read here, which
  give no period.

### GitHub Actions on macOS runners

- **Cost for a public repository: free.** "The use of standard GitHub-hosted runners is free: In public repositories".
  Larger runners are billed even in public repositories.
  ([GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions);
  [source](https://github.com/github/docs/blob/2b4f2c7398e04ee8d02adca7440e4286d20c78b9/content/billing/concepts/product-billing/github-actions.md))
- For private repositories (today's Assay), the standard macOS runner costs $0.062 a minute against $0.006 for
  standard Linux, about ten times as much. The Free plan includes $12 of compute a month, Pro $18.
  ([Actions runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing); rates and quotas in
  [`actions-standard-runner-prices.md`](https://github.com/github/docs/blob/2b4f2c7398e04ee8d02adca7440e4286d20c78b9/data/reusables/billing/actions-standard-runner-prices.md)
  and [`actions-included-quotas.md`](https://github.com/github/docs/blob/2b4f2c7398e04ee8d02adca7440e4286d20c78b9/data/reusables/billing/actions-included-quotas.md))
  Electron Assay's release filter exists because of this ratio. For the open-source repo it saves time, not money.
- `macos-latest` and `macos-26` are macOS 26 on arm64. The image carries Xcode 26.0.1 to 26.6 (26.6 is the default),
  with Xcode 27 in public preview. Intel runners exist only as `-large` (larger, so billed).
  ([runner-images README](https://github.com/actions/runner-images/blob/main/README.md);
  [macos-26-arm64 image](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md))
  This fits the macOS 26 floor.
- **Where the certificates live in CI:** GitHub's guide stores the .p12 as a base64 repository secret, plus its
  password and a keychain password. The job creates a temporary keychain in `$RUNNER_TEMP`, imports the .p12, runs
  `security set-key-partition-list -S apple-tool:,apple:` and adds the keychain to the search list. Hosted runners are
  destroyed after the job; self-hosted runners must delete the keychain themselves.
  ([Installing an Apple certificate on macOS runners](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications))
- **Public-repo safeguard:** "With the exception of `GITHUB_TOKEN`, secrets are not passed to the runner when a
  workflow is triggered from a forked repository." Environment secrets can also require reviewers before a job may
  read them.
  ([Secrets](https://docs.github.com/en/actions/concepts/security/secrets);
  [source](https://github.com/github/docs/blob/2b4f2c7398e04ee8d02adca7440e4286d20c78b9/content/actions/concepts/security/secrets.md))
- Prior art: uv signs and notarises its own macOS binaries in a dedicated release job
  ([`sign-release-binaries.yml`](https://github.com/astral-sh/uv/blob/f45ea9bd5335a60832c10cfb359b8e58bc358810/.github/workflows/sign-release-binaries.yml),
  job "sign and notarize macos binaries").

## 2. Auto-update with Sparkle 2

### Setup and signing

- Add Sparkle with Swift Package Manager. `SPUStandardUpdaterController` gives automatic checks with no other code;
  SwiftUI apps use the programmatic setup. The tools (`generate_keys`, `sign_update`, `generate_appcast`) are in the
  package artefacts or the release archive.
  ([Sparkle documentation](https://sparkle-project.org/documentation/))
- Sparkle's security advice: serve over HTTPS, use Developer ID and notarisation, and sign every archive and delta with
  **EdDSA (ed25519)**. (same page)
- `generate_keys` puts the private key in the login Keychain and prints the public key for `SUPublicEDKey` in
  `Info.plist`. `-x` exports the private key to a file and `-f` imports it. Erasing the keychain loses the key. (same
  page)
- **Key rotation:** for an app signed with Developer ID that also has an EdDSA key, an update may change the Apple
  certificate *or* the EdDSA key, but not both at once. So losing the EdDSA key can be recovered from. (same page)
- **Signed feeds (optional, Sparkle 2.9+):** `SURequireSignedFeed` together with `SUVerifyUpdateBeforeExtraction`.
  With them, changing the EdDSA key needs the update to be a Developer-ID-signed dmg. (same page)
- **In CI:** `generate_appcast --ed-key-file -` reads the private key from standard input, for example
  `echo "$PRIVATE_KEY_SECRET" | generate_appcast --ed-key-file - …`. The older `-s <key>` option is deprecated.
  ([`generate_appcast/main.swift`](https://github.com/sparkle-project/Sparkle/blob/4b20aee135d5a29ce418fc6fc8d211945c2edeeb/generate_appcast/main.swift),
  lines 80–97)
- The CI job uses its own signing. Sparkle ships its helpers (`Autoupdate`, `Updater.app`, the XPC services) ad-hoc
  signed with the Hardened Runtime. Xcode's Archive and Export flow re-signs them; any other flow must re-sign each one
  with `codesign -f -s "$IDENTITY" -o runtime …`, without `--deep`. A non-sandboxed app needs none of the XPC services.
  ([Sandboxing: Code Signing](https://sparkle-project.org/documentation/sandboxing/#code-signing);
  [Upgrading](https://sparkle-project.org/documentation/upgrading/))
- With an ad-hoc signed local build, library validation can stop Sparkle loading. Sign with an Apple Development
  certificate, or turn library validation off for Debug only. This is not a problem for Developer ID builds.
  ([Sparkle documentation](https://sparkle-project.org/documentation/))
- Once the update is installed, Sparkle clears quarantine from the new app (`releaseItemFromQuarantineAtRootURL:`), so
  the user sees no "downloaded from the internet" dialog.
  ([`SUFileManager.h`](https://github.com/sparkle-project/Sparkle/blob/4b20aee135d5a29ce418fc6fc8d211945c2edeeb/Sparkle/SUFileManager.h),
  around line 190)

### Appcast hosting

- The appcast is an RSS feed at the URL in `SUFeedURL`. Sparkle orders versions by `CFBundleVersion`, which must
  increase. It can update from dmg, zip, tarballs, Apple Archives and pkg files, so the first-install archive can
  double as the update. ([Sparkle documentation](https://sparkle-project.org/documentation/))
- Sparkle's docs prescribe no host, only HTTPS that meets App Transport Security. GitHub serves a stable URL for an
  asset of the latest release: `/<owner>/<repo>/releases/latest/download/<asset>`.
  ([Linking to releases](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases))
  So `https://github.com/<owner>/<repo>/releases/latest/download/appcast.xml` would work as `SUFeedURL`, as would
  GitHub Pages. That Sparkle follows GitHub's redirect to the asset host is **unconfirmed** from Sparkle's docs; the
  first update test settles it.
- A public repository needs no token. Electron Assay needs a fine-grained token in Settings > Updates only because its
  repository is private (`docs/process/ci-release.md`).
- Feed features useful later: channels (`sparkle:channel`, for example beta), `sparkle:minimumSystemVersion`, critical
  updates, phased rollouts (7 groups at `phasedRolloutInterval`), and `minimumAutoupdateVersion` for major upgrades.
  ([Publishing an update](https://sparkle-project.org/documentation/publishing/))
- By default Sparkle checks every 86 400 s, with a floor of 1 hour (`SUScheduledCheckInterval`), and asks permission
  on the second launch unless `SUEnableAutomaticChecks` is set. `SUAutomaticallyUpdate` installs silently.
  ([Customization](https://sparkle-project.org/documentation/customization/))

### Delta updates

- `generate_appcast <folder>` writes the appcast and signed `.delta` files from the archives in the folder: "This
  folder will be used to store all your future updates." `--maximum-deltas` limits how many deltas it makes; old
  archives move to `old_updates/`.
  ([Sparkle documentation §5](https://sparkle-project.org/documentation/#5-publish-your-appcast);
  [`main.swift`](https://github.com/sparkle-project/Sparkle/blob/4b20aee135d5a29ce418fc6fc8d211945c2edeeb/generate_appcast/main.swift),
  lines 75, 132, 185)
- Each delta upgrades from one older version only. If none matches, or the patch fails, Sparkle falls back to the full
  archive. The current delta format is 4 (Sparkle 2.7+), and `generate_appcast` picks the format.
  ([Delta updates](https://sparkle-project.org/documentation/delta-updates/))
- So a CI job that makes deltas must first fetch the previous release's archive or archives (from GitHub Releases)
  into the folder. Deltas are an optimisation: leaving them out still updates correctly.

## 3. uv-managed Python downloaded at runtime

### How uv downloads and installs Python

- CPython comes from python-build-standalone. By default uv tries Astral's mirror first, then
  `https://github.com/astral-sh/python-build-standalone/releases/download/`. `UV_PYTHON_INSTALL_MIRROR` replaces both.
  ([`downloads.rs`](https://github.com/astral-sh/uv/blob/f45ea9bd5335a60832c10cfb359b8e58bc358810/crates/uv-python-managed/src/downloads.rs),
  lines 186–198, 796–834; [Python versions](https://docs.astral.sh/uv/concepts/python-versions/#managed-python-distributions))
- uv streams the archive over its own HTTP client, checks its SHA-256, extracts it with its own Rust tar code into a
  temporary directory, and renames that into place (`downloads.rs`, lines 489–677, 736–755). There is no
  `com.apple.quarantine` or `xattr` code in uv's Python install path: a search of the repository for
  `com.apple.quarantine` finds nothing, and the one `xattr` mention is a comment about tar pax headers
  ([`uv-extract/src/stream.rs`](https://github.com/astral-sh/uv/blob/f45ea9bd5335a60832c10cfb359b8e58bc358810/crates/uv-extract/src/stream.rs),
  line 754).
- `UV_PYTHON_INSTALL_DIR` sets the install directory (default `~/.local/share/uv/python`), so the app can install into
  Application Support.
  ([Storage reference](https://docs.astral.sh/uv/reference/storage/#python-versions))
- After installing, uv runs `install_name_tool -id` on `libpython3.x.dylib`. If the tool is missing it only warns, and
  the warning says to install the Xcode Command Line Tools.
  ([`macos_dylib.rs`](https://github.com/astral-sh/uv/blob/f45ea9bd5335a60832c10cfb359b8e58bc358810/crates/uv-python-managed/src/macos_dylib.rs);
  called from `uv-python-commands/src/install.rs:674` and `uv-python-discovery/src/installation.rs:366`)
  **Unconfirmed:** whether, on a Mac without developer tools, `/usr/bin/install_name_tool` prompts the user to install
  the Command Line Tools rather than just failing. Ticket 13 should record this.

### Quarantine

- Quarantine comes from the program that writes the file. `LSFileQuarantineEnabled` is "a Boolean value indicating
  whether the files this app creates are quarantined by default."
  ([LSFileQuarantineEnabled](https://developer.apple.com/documentation/bundleresources/information-property-list/lsfilequarantineenabled))
  Quinn shows a non-sandboxed app writing an executable file with plain `String.write`: without the key, it runs
  without a Gatekeeper prompt; with the key, Gatekeeper stops it.
  ([forum thread 725487](https://developer.apple.com/forums/thread/725487))
- "Unix-y networking tools, like `curl` and `scp`, don't quarantine the files they download. Unix-y unarchiving tools,
  like `tar` and `unzip`, don't propagate quarantine." Running a quarantined app always invokes Gatekeeper, and the
  system "may run Gatekeeper at other times as well … not documented and changes over time."
  (Quinn, [Resolving Trusted Execution Problems](https://developer.apple.com/forums/thread/706442))
- **Conclusion (inference, high confidence):** a non-sandboxed Assay without `LSFileQuarantineEnabled`, starting a
  Developer-ID-signed uv that downloads and extracts Python itself, should produce a Python with **no**
  `com.apple.quarantine`. **Unconfirmed:** whether a child process takes on quarantine from a parent app that sets
  `LSFileQuarantineEnabled` (Assay should simply not set it), and how the `com.apple.provenance` attribute that macOS
  13+ attaches is weighed. No Apple document on provenance was found.

### Code signatures and library validation

- On Apple silicon, macOS requires every native executable to be signed; an ad-hoc signature is enough. The linker
  ad-hoc signs at link time, but tools that change a binary after linking (`strip`, `install_name_tool`) may require
  re-signing. Such signatures "do not bear any valid identity, [so] binaries signed this way cannot pass through
  Gatekeeper."
  ([macOS Big Sur 11.0.1 Universal Apps release notes](https://developer.apple.com/documentation/macos-release-notes/macos-big-sur-11_0_1-universal-apps-release-notes))
- python-build-standalone does no Developer ID signing. It relies on the automatic arm64 ad-hoc signature (its build
  script pads the Mach-O header "to add a code signature … on non-arm64 where there's no automatic ad-hoc signature").
  ([`cpython-unix/build-cpython.sh`](https://github.com/astral-sh/python-build-standalone/blob/9244801782b78e4c4afc5c82a4524aa2101d3298/cpython-unix/build-cpython.sh),
  lines 369–375) A uv maintainer: "we'll probably just sign these upstream when we distribute them with a proper key"
  ([uv PR #17123](https://github.com/astral-sh/uv/pull/17123), closed unmerged). So this is not done today.
- Taken together, managed Python works **only because it is not quarantined**. If anything quarantined it, Gatekeeper
  would reject the ad-hoc signatures. This is why §3's quarantine conclusion matters.
- **Library validation is a property of the process's main executable** ("If library validation is enabled on an
  executable, … the process [may] only load code signed by Apple or with the same Team ID as the executable", Quinn,
  [706437](https://developer.apple.com/forums/thread/706437)). Python started by Assay as a **separate process** (the
  kernel, the server, the hooks) runs under python's own ad-hoc signature, without the Hardened Runtime, so library
  validation should not apply to the polars and duckdb extension modules it loads. **Inference**: Apple's pages
  describe validation per executable but say nothing explicit about child processes. Two cases would break it:
  loading libpython *inside* the Swift process, or re-signing Python with the team's hardened runtime.
- **Known failure in the field:** uv issues
  [#16726](https://github.com/astral-sh/uv/issues/16726) (open, `needs-mre`) and
  [#16003](https://github.com/astral-sh/uv/issues/16003) (closed as its duplicate) report uv-managed Python killed with
  SIGKILL on macOS 15 and 26, cured by `codesign --force -s -` on the interpreter and sometimes on `.so` files. The
  cause is not established: reporters point to `com.apple.provenance` and the ad-hoc signature, one machine ran a
  corporate MDM (Mosyle), and a maintainer could not reproduce it on macOS 26.1. A maintainer believes ad-hoc signing
  "happens automatically in newer versions of `install_name_tool`".
- **Known slowness:** [uv #17371](https://github.com/astral-sh/uv/issues/17371) (open) reports a first run after
  `uv sync` 20–50 s slower on Tahoe, attributed without proof to per-file signature checks on new inodes.
  `UV_LINK_MODE=hardlink` reduced it. Ticket 13 should time the first kernel start.

## Implications for the decision

- **CI release is free once the repo is public.** Standard `macos-26` arm64 runners cost nothing in public repos and
  carry Xcode 26, so building, signing and notarising in GitHub Actions has no cost reason against it. The release
  filter becomes about time, not money. Secrets do not reach fork PRs; an environment with required reviewers adds a
  gate.
- **Reuse the existing team credentials.** The Developer ID .p12 and the Team API key in Electron Assay's secrets can
  sign and notarise the Swift app (temporary keychain plus `notarytool --key`). Only the Account Holder can make a new
  certificate; an Admin can make a new Team key.
- **Sparkle adds one secret:** the EdDSA private key, generated once on the Mac (`generate_keys`, exported with `-x`)
  and passed to `generate_appcast --ed-key-file -`. Back it up outside the keychain. Key rotation through Developer ID
  makes a lost key recoverable.
- **The feed can live on GitHub Releases** (`releases/latest/download/appcast.xml`) with no token, which removes
  Electron Assay's update-token machinery. Deltas need the previous archive fetched in CI. Leave them out of the first
  cut; they are optional.
- **Managed Python should work unsigned, with one condition:** Assay must not set `LSFileQuarantineEnabled`, and it
  must run Python as a separate process, never embedded. Ship a Developer-ID-signed uv inside the bundle (re-signed
  with the app) and install Python into Application Support with `UV_PYTHON_INSTALL_DIR`. Do not add
  `disable-library-validation` to the app; it should not need it.
- **Ticket 13 must settle these points:** whether `install_name_tool` prompts for the Command Line Tools on a clean
  Mac; whether the interpreter and the `.so` files run without re-signing (the #16726 symptom); `xattr -l` on the
  installed tree (no quarantine expected; record provenance); and the first-run delay. If any of these fails, the
  fallback is for Assay to ad-hoc sign the Python tree after install (`codesign --force -s -`), or, at more cost, to
  host a Python tree that Assay signs and notarises itself.
