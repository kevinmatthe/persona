# Android client Release packages

`.github/workflows/client-release.yml` builds verified Android packages when a Release is published. It also supports manual runs and reusable calls. The existing tag-release workflow calls it explicitly, since a Release created by `GITHUB_TOKEN` does not trigger another workflow.

This fork publishes Android client builds only. These packages are fork builds, not official upstream releases. macOS desktop and Persona Link are not built or packaged by the client Release workflow.

## Outputs

- Android: `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`, and a universal APK. They are actual ABI splits, built together by Gradle. Each APK is signed, checked with `apksigner`/`zipalign`, and checked against the expected native-library architecture.
- `SHA256SUMS-android.txt` and `android-build.json` identify the exact source commit, signing certificate and package versions.

The upload job requires a successful Android build and downloads only its verified Android artifact.

## Signing

Configure these encrypted repository Actions secrets:

- `ANDROID_KEYSTORE_BASE64`: base64 of the PKCS#12 signing keystore.
- `ANDROID_KEYSTORE_PASSWORD`: its password (the private key uses the same password).
- `ANDROID_KEY_ALIAS`: the signing alias.

The workflow uses package ID `cn.kmhomelab.persona` and pins the public signing certificate fingerprint in its environment. Keep the same keystore/certificate to upgrade existing local installations. Private signing material is decoded only into a temporary directory and is never uploaded as an artifact or checked into Git. Build jobs have read-only repository permissions; only the asset-upload job has `contents: write`.

## Running

Publish a Release from a tag containing this workflow to build automatically. Both stable Releases and prereleases are supported. Create new tags at an explicit commit containing the Android-only workflow. For an existing upstream tag that predates the workflow, manually run **Client release** and set `release_tag` to an existing Release in this fork. That tag selects the source to build; the workflow will attach assets but will not create or publish a new Release.

For a build without publishing, use the manual trigger; optionally set `source_ref` to a tag or full commit SHA. Leave `release_tag` empty. Every entry point builds Android only. Verified build artifacts are retained for three days; Release assets remain attached to the Release.

Android version codes are UTC seconds since 2020, so independent entry workflows do not use conflicting run counters. All ABI variants in a build share the code. Release sources use explicit `refs/tags/...` references. Normal developer builds and upstream app sources are unchanged: ABI splits and CI version metadata are applied through an external Gradle init script.

## Validation

```sh
python3 .github/client-release/test_android_release.py
actionlint .github/workflows/client-release.yml .github/workflows/release.yml
```

Actions additionally run the source's release checks and, when present, its R8 shrinking check. The build checks do not establish full interactive or real-device acceptance.
