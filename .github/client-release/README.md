# Client Release packages

`.github/workflows/client-release.yml` builds verified client packages when a Release is published. It also supports manual runs and reusable calls. The existing tag-release workflow calls it explicitly, since a Release created by `GITHUB_TOKEN` does not trigger another workflow.

## Outputs

- Android: `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`, and a universal APK. They are actual ABI splits, built together by Gradle. Each APK is signed, checked with `apksigner`/`zipalign`, and checked against the expected native-library architecture.
- macOS desktop: `Persona-Mac-<release>-universal.zip`, containing the native desktop app for macOS 26 or newer.
- macOS computer connection: `Persona-Link-<release>-universal.zip`, containing the menu-bar app and both Go helpers for macOS 15 or newer.
- Platform-specific SHA-256 checksum files and JSON build records identify the exact source commit.

Both Mac apps contain Apple silicon and Intel code. They use ad-hoc signatures, not an Apple Developer ID, and are not notarized. The desktop build keeps its sandbox and ordinary permissions but omits the Apple-profile-only push and shared-Keychain entitlements. It is a personal-use build; native Mac development upstream is frozen. The Link app is a separate computer connector, not the chat UI.

## Signing

Configure these encrypted repository Actions secrets:

- `ANDROID_KEYSTORE_BASE64`: base64 of the PKCS#12 signing keystore.
- `ANDROID_KEYSTORE_PASSWORD`: its password (the private key uses the same password).
- `ANDROID_KEY_ALIAS`: the signing alias.

The workflow uses package ID `cn.kmhomelab.persona` and pins the public signing certificate fingerprint in its environment. Keep the same keystore/certificate to upgrade existing local installations. Private signing material is decoded only into a temporary directory and is never uploaded as an artifact or checked into Git. Build jobs have read-only repository permissions; only the asset-upload job has `contents: write`.

## Running

Publish a Release from a tag containing this workflow to build automatically. Both stable Releases and prereleases are supported. For an existing upstream tag that predates the workflow, manually run **Client release** and set `release_tag` to an existing Release in this fork. That tag selects the source to build; the workflow will attach assets but will not create or publish a new Release.

For a build without publishing, use the manual trigger with `platform` set to `all`, `android`, or `macos`; optionally set `source_ref` to a tag or full commit SHA. Leave `release_tag` empty. Verified build artifacts are retained for three days; Release assets remain attached to the Release.

Android version codes are UTC seconds since 2020, so independent entry workflows do not use conflicting run counters. All ABI variants in a build share the code. Release sources use explicit `refs/tags/...` references. Normal developer builds and upstream app sources are unchanged: ABI splits and CI version metadata are applied through an external Gradle init script.

## Validation

```sh
python3 .github/client-release/test_android_release.py
bash -n .github/client-release/macos_release.sh
actionlint .github/workflows/client-release.yml .github/workflows/release.yml
```

Actions additionally run the source's release checks and, when present, its R8 shrinking check. The Mac job verifies signatures and universal binaries and requires the packaged desktop process to survive a short launch smoke check. This does not establish full interactive or real-device acceptance.
