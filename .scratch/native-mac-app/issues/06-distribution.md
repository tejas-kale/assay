# How the app is signed, notarised, released and updated

Type: research
Status: open

## Question

For an open-source Developer ID app, cover the following from primary sources:
- signing and notarisation, locally (notarytool) and in GitHub Actions on macOS runners, with the cost for public repositories and where the certificates live
- auto-update with Sparkle 2: appcast hosting, EdDSA keys, and delta updates
- verifying that a uv-managed Python downloaded at runtime runs from a notarised app without quarantine or library-validation problems
