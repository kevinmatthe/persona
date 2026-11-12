#!/usr/bin/env bash
# Build personal-use universal apps. No Apple signing identity or notarization is implied.
set -euo pipefail

SOURCE=$(cd "${1:?source checkout}" && pwd)
DIST=${2:?asset directory}
mkdir -p "$DIST"
DIST=$(cd "$DIST" && pwd)
: "${RUNNER_TEMP:?}" "${ASSET_LABEL:?}" "${PERSONA_MAC_VERSION:?}" "${PERSONA_RELEASE_VERSION_CODE:?}"
export PERSONA_CONFIG="$RUNNER_TEMP/persona-client-config.json"
export PERSONA_LINK_BUNDLE_ID=cn.kmhomelab.persona.link
python3 - "$PERSONA_CONFIG" <<'PY'
import json, os, sys
with open(sys.argv[1], 'w') as out:
    json.dump({'app': {'bundle_id': 'cn.kmhomelab.persona.mac', 'team_id': ''},
               'mac': {'link_bundle_id': 'cn.kmhomelab.persona.link'}}, out)
os.chmod(sys.argv[1], 0o600)
PY

cd "$SOURCE"
UNIVERSAL=1 ./scripts/app/mac-link.sh build
LINK="$SOURCE/apple/PersonaLink/build/Persona Link.app"
/usr/libexec/PlistBuddy -c "Set CFBundleShortVersionString $PERSONA_MAC_VERSION" "$LINK/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set CFBundleVersion $PERSONA_RELEASE_VERSION_CODE" "$LINK/Contents/Info.plist"
codesign --force --sign - "$LINK"
for binary in "$LINK/Contents/MacOS/PersonaLink" "$LINK/Contents/Helpers/persona-link" "$LINK/Contents/Helpers/persona-node"; do
  lipo "$binary" -verify_arch arm64 x86_64
  codesign --verify --strict "$binary"
done
codesign --verify --strict "$LINK"
ditto -c -k --sequesterRsrc --keepParent "$LINK" "$DIST/Persona-Link-$ASSET_LABEL-universal.zip"

python3 scripts/persona_config.py xcconfig
(cd apple && xcodegen generate)
# The source checkout is disposable. Retain sandboxing and all ordinary permissions;
# profile-authorized APNs/shared-Keychain entitlements cannot be claimed by ad-hoc builds.
python3 - "$SOURCE" <<'PY'
from pathlib import Path
import plistlib, sys
root = Path(sys.argv[1])
profile = {'com.apple.developer.aps-environment',
           'com.apple.developer.usernotifications.time-sensitive', 'keychain-access-groups'}
for relative in ('apple/Mac/Resources/PersonaMac.entitlements',
                 'apple/PersonaNotify/PersonaMacNotify.entitlements'):
    path = root / relative
    values = plistlib.loads(path.read_bytes())
    if values.get('com.apple.security.app-sandbox') is not True:
        raise ValueError('Mac app sandbox must remain enabled')
    path.write_bytes(plistlib.dumps({k: v for k, v in values.items() if k not in profile}))
PY

DERIVED="$RUNNER_TEMP/persona-macos-release"
xcodebuild -project apple/Persona.xcodeproj -scheme PersonaMac -configuration Release \
  -destination 'generic/platform=macOS' -derivedDataPath "$DERIVED" \
  -clonedSourcePackagesDirPath "$SOURCE/.ci-cache/client-spm" -jobs 2 \
  'ARCHS=arm64 x86_64' ONLY_ACTIVE_ARCH=NO \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= \
  PERSONA_BUNDLE_ID=cn.kmhomelab.persona.mac \
  MARKETING_VERSION="$PERSONA_MAC_VERSION" CURRENT_PROJECT_VERSION="$PERSONA_RELEASE_VERSION_CODE" build
APP="$DERIVED/Build/Products/Release/Persona.app"
lipo "$APP/Contents/MacOS/Persona" -verify_arch arm64 x86_64
codesign --verify --deep --strict "$APP"
codesign -d --entitlements - "$APP" > "$RUNNER_TEMP/persona-final-entitlements.plist"
python3 - "$RUNNER_TEMP/persona-final-entitlements.plist" <<'PY'
import plistlib, sys
values = plistlib.load(open(sys.argv[1], 'rb'))
assert values.get('com.apple.security.app-sandbox') is True
assert not {'com.apple.developer.aps-environment', 'keychain-access-groups'}.intersection(values)
PY
ditto -c -k --sequesterRsrc --keepParent "$APP" "$DIST/Persona-Mac-$ASSET_LABEL-universal.zip"
export PERSONA_MAC_MIN_OS=$(/usr/libexec/PlistBuddy -c 'Print LSMinimumSystemVersion' "$APP/Contents/Info.plist")
export PERSONA_LINK_MIN_OS=$(/usr/libexec/PlistBuddy -c 'Print LSMinimumSystemVersion' "$LINK/Contents/Info.plist")

# Check that AMFI permits the profile-free app to start, then stop only our process.
"$APP/Contents/MacOS/Persona" > "$RUNNER_TEMP/persona-macos-launch.log" 2>&1 &
APP_PID=$!
trap 'kill "$APP_PID" 2>/dev/null || true' EXIT
sleep 8
if ! kill -0 "$APP_PID" 2>/dev/null; then
  cat "$RUNNER_TEMP/persona-macos-launch.log"
  printf 'The packaged Mac app exited during the launch smoke check.\n' >&2
  exit 1
fi
kill "$APP_PID"
wait "$APP_PID" || true
trap - EXIT

python3 - "$DIST" <<'PY'
import hashlib, json, os, sys
from pathlib import Path
directory = Path(sys.argv[1])
artifacts = [{'filename': p.name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest(),
              'size': p.stat().st_size, 'architectures': ['arm64', 'x86_64']}
             for p in sorted(directory.glob('*.zip'))]
if len(artifacts) != 2:
    raise ValueError('Expected the desktop and Link app ZIPs')
(directory / 'SHA256SUMS-macos.txt').write_text(''.join(f"{x['sha256']}  {x['filename']}\n" for x in artifacts))
(directory / 'macos-build.json').write_text(json.dumps({
    'source_commit': os.environ['PERSONA_SOURCE_SHA'], 'signing': 'ad-hoc', 'notarized': False,
    'desktop_min_macos': os.environ['PERSONA_MAC_MIN_OS'], 'link_min_macos': os.environ['PERSONA_LINK_MIN_OS'],
    'profile_authorized_push_and_shared_keychain': False,
    'desktop_launch_smoke_passed': True, 'artifacts': artifacts}, indent=2) + '\n')
PY
