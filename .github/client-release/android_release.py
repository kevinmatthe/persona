"""Prepare, verify, and sign the Android Release assets without changing app sources."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import tomllib
import zipfile


ABIS = ('arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64')


def android_version_code(moment):
    # Seconds since 2020, shared across entry workflows and independent run counters.
    code = int(moment) - 1577836800
    if not 1 <= code <= 2100000000:
        raise ValueError('Android version code is out of range')
    return code


def check_certificate(verified, expected):
    if not re.fullmatch(r'[0-9a-fA-F]{64}', expected):
        raise ValueError('Invalid expected signing certificate fingerprint')
    digests = re.findall(r'certificate SHA-256 digest: ([0-9a-fA-F]{64})', verified)
    if [value.lower() for value in digests] != [expected.lower()]:
        raise ValueError('APK signing certificate does not match the configured fingerprint')


def sdk_packages(compile_sdk, build_tools, available):
    installed = {line.strip().split('|')[0].strip() for line in available.splitlines()}
    platform = next((f'platforms;android-{value}' for value in (compile_sdk, compile_sdk + '.0')
                     if f'platforms;android-{value}' in installed), None)
    tools = 'build-tools;' + build_tools
    if platform is None or tools not in installed:
        raise ValueError(f'Unavailable pinned Android SDK: {compile_sdk}, build tools {build_tools}')
    return [platform, tools]


def inventory_apks(directory):
    directory = Path(directory).resolve()
    metadata = json.loads((directory / 'output-metadata.json').read_text())
    found = {}
    for item in metadata['elements']:
        filters = item.get('filters', [])
        abi_filters = [row['value'] for row in filters if row['filterType'] == 'ABI']
        if len(abi_filters) > 1 or len(abi_filters) != len(filters):
            raise ValueError('Unexpected APK output filters')
        abi = abi_filters[0] if abi_filters else 'universal'
        if abi not in (*ABIS, 'universal'):
            raise ValueError(f'Unsupported ABI: {abi}')
        if abi in found:
            raise ValueError(f'Duplicate ABI: {abi}')
        filename = item['outputFile']
        path = directory / filename
        if Path(filename).name != filename or path.resolve().parent != directory or not path.is_file():
            raise ValueError(f'Unsafe APK output path: {filename}')
        with zipfile.ZipFile(path) as archive:
            if archive.testzip() is not None:
                raise ValueError(f'Corrupted APK: {filename}')
            native = {name.split('/')[1] for name in archive.namelist()
                      if name.startswith('lib/') and name.endswith('.so') and len(name.split('/')) == 3}
        expected = set(ABIS) if abi == 'universal' else {abi}
        if native != expected:
            raise ValueError(f'{abi}: unexpected native ABIs: {sorted(native)}')
        found[abi] = path
    missing = set((*ABIS, 'universal')) - found.keys()
    if missing:
        raise ValueError(f'Missing ABI outputs: {sorted(missing)}')
    return found


def metadata(source):
    label = os.environ['ASSET_LABEL']
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,99}', label):
        raise ValueError('Release tag cannot be used as a safe asset label')
    number = android_version_code(time.time())
    sha = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    values = {
        'PERSONA_RELEASE_VERSION_CODE': str(number),
        'PERSONA_RELEASE_VERSION_NAME': label.removeprefix('v'),
        'PERSONA_SOURCE_SHA': sha,
    }
    with open(os.environ['GITHUB_ENV'], 'a') as out:
        for key, value in values.items():
            out.write(f'{key}={value}\n')


def sign(source, sdk, dist):
    dist.mkdir(parents=True, exist_ok=True)
    versions = tomllib.loads((source / 'android/gradle/libs.versions.toml').read_text())['versions']
    tools = sdk / 'build-tools' / versions['buildTools']
    inputs = inventory_apks(source / 'android/app/build/outputs/apk/release')
    label = os.environ['ASSET_LABEL']
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,99}', label):
        raise ValueError('Unsafe asset label')
    for key in ('ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_CERT_SHA256'):
        if not os.environ.get(key):
            raise ValueError(f'Required signing secret is missing: {key}')
    entries = []
    with tempfile.TemporaryDirectory(prefix='persona-signing-', dir=os.environ['RUNNER_TEMP']) as temp:
        keystore = Path(temp) / 'release.p12'
        keystore.write_bytes(base64.b64decode(os.environ['ANDROID_KEYSTORE_BASE64'], validate=True))
        keystore.chmod(0o600)
        for abi, unsigned in inputs.items():
            aligned = Path(temp) / (abi + '.apk')
            output = dist / f'Persona-{label}-{abi}.apk'
            subprocess.run([str(tools / 'zipalign'), '-P', '16', '-f', '4', str(unsigned), str(aligned)], check=True)
            subprocess.run([str(tools / 'apksigner'), 'sign', '--ks', str(keystore),
                            '--ks-key-alias', os.environ['ANDROID_KEY_ALIAS'],
                            '--ks-pass', 'env:ANDROID_KEYSTORE_PASSWORD', '--v4-signing-enabled', 'false',
                            '--out', str(output), str(aligned)], check=True)
            verified = subprocess.check_output([str(tools / 'apksigner'), 'verify', '--verbose', '--print-certs', str(output)], text=True)
            check_certificate(verified, os.environ['ANDROID_CERT_SHA256'])
            subprocess.run([str(tools / 'zipalign'), '-c', '-P', '16', '4', str(output)], check=True)
            badging = subprocess.check_output([str(tools / 'aapt2'), 'dump', 'badging', str(output)], text=True)
            def field(pattern):
                match = re.search(pattern, badging, re.MULTILINE)
                if not match:
                    raise ValueError(f'Missing APK metadata: {pattern}')
                return match.group(1)
            package = field(r"^package: name='([^']+)'")
            code = int(field(r"\bversionCode='([^']+)'") )
            if package != os.environ['APPLICATION_ID'] or code != int(os.environ['PERSONA_RELEASE_VERSION_CODE']):
                raise ValueError('APK package/version differs from the requested release')
            if field(r"\bversionName='([^']*)'") != os.environ['PERSONA_RELEASE_VERSION_NAME']:
                raise ValueError('APK version name differs from the requested release')
            if 'application-debuggable' in badging:
                raise ValueError('Release APK is debuggable')
            entries.append({'filename': output.name, 'abi': abi, 'package': package,
                            'version_code': code, 'version_name': field(r"\bversionName='([^']*)'"),
                            'min_sdk': int(field(r"^(?:sdkVersion|minSdkVersion):'([^']+)'")),
                            'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'size': output.stat().st_size})
            print(f'Verified signed APK: {output.name}')
    (dist / 'SHA256SUMS-android.txt').write_text(''.join(f"{item['sha256']}  {item['filename']}\n" for item in entries))
    (dist / 'android-build.json').write_text(json.dumps({'source_commit': os.environ['PERSONA_SOURCE_SHA'],
        'signing_certificate_sha256': os.environ['ANDROID_CERT_SHA256'], 'artifacts': entries}, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('metadata', 'sdk-packages', 'sign'))
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--sdk', type=Path)
    parser.add_argument('--dist', type=Path)
    args = parser.parse_args()
    if args.command == 'metadata':
        metadata(args.source)
    elif args.command == 'sdk-packages':
        versions = tomllib.loads((args.source / 'android/gradle/libs.versions.toml').read_text())['versions']
        available = subprocess.check_output(['sdkmanager', '--list'], text=True)
        print('\n'.join(sdk_packages(versions['compileSdk'], versions['buildTools'], available)))
    else:
        if args.sdk is None or args.dist is None:
            parser.error('sign requires --sdk and --dist')
        sign(args.source, args.sdk, args.dist)


if __name__ == '__main__':
    main()
