# Releasing SafariKeePassXC

Releases are fully automated by GitHub Actions. Nothing is built on a maintainer's machine.

## Continuous integration

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every pull request and on pushes
to `main`:

1. checks that `MARKETING_VERSION` (app and extension targets) and `version`
   (`manifest.json`) are identical;
2. validates `manifest.json` and every `_locales/*/messages.json` as JSON;
3. runs the JavaScript test suite;
4. builds the app and runs the Swift unit tests (unsigned, keychain tests skipped).

A red CI run should block merging — enable branch protection on `main` to enforce it.

## Cutting a release

1. Bump the version in **both** places (they must match):
   - `MARKETING_VERSION` in `SafariKeePassXC.xcodeproj/project.pbxproj` (app and extension targets);
   - `version` in `SafariKeePassXC Extension/Resources/manifest.json`.
2. Commit the bump on `main` and push.
3. Tag the commit and push the tag:

   ```bash
   git tag v1.2.5
   git push origin v1.2.5
   ```

4. [`.github/workflows/release.yml`](../.github/workflows/release.yml) takes over:
   - runs the same checks as CI first and refuses to publish if they fail;
   - refuses to run unless the tag points to a commit on `main`;
   - fails immediately if the tag does not match the versions from step 1;
   - imports the signing certificates into a temporary keychain;
   - archives the app in `Release` configuration and exports it with **Developer ID Application**
     signing (automatic signing, profiles managed through the App Store Connect API key);
   - verifies that the app and the embedded `.appex` carry a `Developer ID Application` authority;
   - notarizes the app, staples the ticket, and checks it with `spctl`;
   - builds `SafariKeePassXC-<version>.dmg` (app + `/Applications` shortcut), signs the DMG,
     notarizes it, staples it, and validates it;
   - writes `SafariKeePassXC-<version>.dmg.sha256`;
   - publishes a GitHub Release with the DMG, the checksum and auto-generated release notes.

The tag and the release are the only source of truth: the DMG in a GitHub Release is exactly the
artifact that CI signed and notarized.

## Required repository secrets

Add these under **Settings → Secrets and variables → Actions** (or with `gh secret set`):

| Secret | Content |
|---|---|
| `APPLE_DEVELOPER_ID_CERT_P12_BASE64` | Base64 of a `.p12` containing the **Developer ID Application** certificate and an **Apple Development** certificate, both with their private keys. |
| `APPLE_DEVELOPER_ID_CERT_PASSWORD` | Password used when exporting the `.p12`. |
| `APPLE_KEYCHAIN_PASSWORD` | Any random password for the temporary CI keychain. |
| `APPLE_TEAM_ID` | Apple Developer Team ID that owns the app IDs. |
| `APPLE_NOTARY_KEY_P8` | Contents of the App Store Connect API key (`.p8`). |
| `APPLE_NOTARY_KEY_ID` | Key ID of that API key. |
| `APPLE_NOTARY_ISSUER_ID` | Issuer ID of the App Store Connect API key. |

How to create them:

1. **Certificates** — in
   [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates)
   create a *Developer ID Application* certificate (and make sure an *Apple Development* certificate
   exists for the same team). Add both to your login keychain, select them **together** in Keychain
   Access and export them as one `.p12` **with their private keys**. The archive step uses the
   development identity, the export step re-signs with Developer ID. Encode the file for CI:

   ```bash
   base64 -i Signing.p12 | pbcopy   # paste into APPLE_DEVELOPER_ID_CERT_P12_BASE64
   ```

2. **App Store Connect API key** — in
   [App Store Connect → Users and Access → Integrations](https://appstoreconnect.apple.com/access/integrations/api)
   request API access if prompted, then create a key with the *Admin* role (needed so Xcode can
   manage signing certificates and profiles). Download the `.p8` (it can only be downloaded once) and
   copy the Key ID and Issuer ID.

3. The App IDs `yauheni.tech.SafariKeePassXC` and
   `yauheni.tech.SafariKeePassXC.Extension` must exist in that team, and the team must be allowed to
   create Developer ID provisioning profiles.

The certificates and the API key are only used inside the release workflow; the temporary keychain
and the API key file are deleted at the end of the run.

## Verifying a release

Every release DMG is signed with a **Developer ID Application** certificate, notarized by Apple and
stapled. You can verify a download yourself:

```bash
# 1. Check the checksum published next to the DMG
shasum -a 256 -c SafariKeePassXC-<version>.dmg.sha256

# 2. Check the signature and the notarization ticket
codesign --verify --deep --strict --verbose=2 /Applications/SafariKeePassXC.app
codesign -dv --verbose=4 /Applications/SafariKeePassXC.app     # Authority: Developer ID Application: …
spctl -a -vvv -t exec /Applications/SafariKeePassXC.app        # accepted, source=Notarized Developer ID

# 3. Check the DMG itself
xcrun stapler validate SafariKeePassXC-<version>.dmg
spctl -a -t open --context context:primary-signature -v SafariKeePassXC-<version>.dmg
```
