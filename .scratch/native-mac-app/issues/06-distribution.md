# How the app is signed, notarised, released and updated

Type: research
Status: resolved

## Question

For an open-source Developer ID app, cover the following from primary sources:
- signing and notarisation, locally (notarytool) and in GitHub Actions on macOS runners, with the cost for public repositories and where the certificates live
- auto-update with Sparkle 2: appcast hosting, EdDSA keys, and delta updates
- verifying that a uv-managed Python downloaded at runtime runs from a notarised app without quarantine or library-validation problems

## Answer

Findings: [research/06-distribution.md](../research/06-distribution.md).

- **Signing and notarisation:** standard GitHub macOS runners (`macos-26`, arm64) are free for public repositories. Electron Assay's Developer ID certificate and Team API key can sign and notarise the Swift app; notarytool refuses Individual API keys, so the key must be a Team key.
- **Updates with Sparkle 2:** the only new secret is the EdDSA private key. The feed can sit at `releases/latest/download/appcast.xml` with no token. Delta updates are optional and need the previous release's archive in CI.
- **uv-managed Python:** uv downloads and extracts Python itself and sets no quarantine flag, so Python fetched by Assay should arrive unquarantined (inference, high confidence). It only works because it isn't quarantined: python-build-standalone carries ad-hoc signatures, which Gatekeeper would reject. It must run as a separate process. Don't add `disable-library-validation`.
- **Risks for the clean-Mac check:**
  - uv runs `install_name_tool`, which may prompt to install the Command Line Tools on a Mac without them (unconfirmed).
  - uv issue #16726: managed Python killed on macOS 15 and 26 until re-signed ad hoc.
  - uv issue #17371: a slow first run on Tahoe.

  The fallback is for Assay to sign the Python tree ad hoc after installing it.
