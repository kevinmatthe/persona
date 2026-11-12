import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile


HELPER = Path(__file__).with_name('android_release.py')
if HELPER.exists():
    spec = importlib.util.spec_from_file_location('android_release', HELPER)
    release = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = release
    spec.loader.exec_module(release)
else:
    release = None


class AndroidReleaseTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(release, 'Android release implementation is missing')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def apk(self, name, abis):
        with zipfile.ZipFile(self.directory / name, 'w') as apk:
            apk.writestr('AndroidManifest.xml', b'manifest')
            apk.writestr('classes.dex', b'dex')
            for abi in abis:
                apk.writestr(f'lib/{abi}/libexample.so', b'ELF')

    def manifest(self, elements):
        (self.directory / 'output-metadata.json').write_text(json.dumps({'elements': elements}))

    def complete_set(self):
        elements = []
        for abi in release.ABIS:
            name = f'app-{abi}.apk'
            self.apk(name, [abi])
            elements.append({'outputFile': name, 'filters': [{'filterType': 'ABI', 'value': abi}]})
        self.apk('app-universal.apk', release.ABIS)
        elements.append({'outputFile': 'app-universal.apk', 'filters': []})
        self.manifest(elements)
        return elements

    def test_collects_four_real_abi_splits_and_universal(self):
        self.complete_set()
        found = release.inventory_apks(self.directory)
        self.assertEqual(set(found), set(release.ABIS) | {'universal'})

    def test_rejects_missing_architecture(self):
        elements = self.complete_set()
        self.manifest(elements[1:])
        with self.assertRaisesRegex(ValueError, 'Missing'):
            release.inventory_apks(self.directory)

    def test_rejects_renamed_universal_as_architecture_split(self):
        self.complete_set()
        self.apk(f'app-{release.ABIS[0]}.apk', release.ABIS)
        with self.assertRaisesRegex(ValueError, 'native ABIs'):
            release.inventory_apks(self.directory)

    def test_rejects_output_path_outside_build_directory(self):
        elements = self.complete_set()
        elements[0]['outputFile'] = '../outside.apk'
        self.manifest(elements)
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            release.inventory_apks(self.directory)

    def test_rejects_duplicate_architecture(self):
        elements = self.complete_set()
        self.manifest(elements + [elements[0]])
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            release.inventory_apks(self.directory)

    def test_resolves_new_sdk_platform_package_name(self):
        packages = 'platforms;android-37.0 | 2\nbuild-tools;37.0.0 | 37'
        self.assertEqual(release.sdk_packages('37', '37.0.0', packages),
                         ['platforms;android-37.0', 'build-tools;37.0.0'])

    def test_keeps_legacy_sdk_platform_package_name(self):
        packages = 'platforms;android-36 | 2\nbuild-tools;36.0.0 | 36'
        self.assertEqual(release.sdk_packages('36', '36.0.0', packages),
                         ['platforms;android-36', 'build-tools;36.0.0'])

    def test_fails_when_pinned_sdk_is_unavailable(self):
        with self.assertRaisesRegex(ValueError, 'Unavailable'):
            release.sdk_packages('37', '37.0.0', 'platforms;android-36 | 2')

    def test_accepts_only_the_actual_signing_certificate_digest(self):
        digest = 'a' * 64
        release.check_certificate('V3.0 Signer: certificate SHA-256 digest: ' + digest, digest)

    def test_rejects_fingerprint_text_in_certificate_name(self):
        expected = 'a' * 64
        output = 'certificate DN: CN=' + expected + '\ncertificate SHA-256 digest: ' + 'b' * 64
        with self.assertRaisesRegex(ValueError, 'certificate'):
            release.check_certificate(output, expected)

    def test_version_codes_increase_without_a_workflow_run_counter(self):
        now = 1794466800
        self.assertGreater(release.android_version_code(now + 1), release.android_version_code(now))
        self.assertGreater(release.android_version_code(now), 1)

    def test_version_code_rejects_invalid_clock_range(self):
        for moment in (1577836800, 1577836800 + 2100000001):
            with self.assertRaisesRegex(ValueError, 'version code'):
                release.android_version_code(moment)


if __name__ == '__main__':
    unittest.main()
