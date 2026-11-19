#!/usr/bin/env python3
import os, plistlib, subprocess, sys
from pathlib import Path
root = Path(__file__).resolve().parents[1]
app = Path(sys.argv[1] if len(sys.argv) > 1 else root / 'example-build' / 'Demo.app').resolve()
app.mkdir(parents=True, exist_ok=True)
sdk = subprocess.check_output(['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'], text=True).strip()
subprocess.run(['xcrun', '--sdk', 'iphonesimulator', 'swiftc', '-parse-as-library', '-sdk', sdk, '-target', 'arm64-apple-ios18.0-simulator', str(root / 'examples/PreviewDemo.swift'), '-o', str(app / 'PreviewDemo')], check=True)
info = {'CFBundleIdentifier': 'com.example.simulatorpreview.demo', 'CFBundleName': 'Preview Demo', 'CFBundleDisplayName': 'Preview Demo', 'CFBundleExecutable': 'PreviewDemo', 'CFBundlePackageType': 'APPL', 'CFBundleVersion': '1', 'CFBundleShortVersionString': '1.0', 'CFBundleSupportedPlatforms': ['iPhoneSimulator'], 'MinimumOSVersion': '18.0', 'UIDeviceFamily': [1, 2], 'UILaunchScreen': {}, 'UISupportedInterfaceOrientations': ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'], 'BuildCommit': os.environ.get('PREVIEW_SHA', 'local-demo'), 'BuildPR': os.environ.get('PREVIEW_PR', '1')}
(app / 'Info.plist').write_bytes(plistlib.dumps(info))
subprocess.run(['codesign', '--force', '--sign', '-', str(app)], check=True)
print(app)
