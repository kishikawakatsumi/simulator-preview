#!/usr/bin/env python3
"""Preserve executable bits and bundle symlinks before upload-artifact packages the payload."""
import plistlib, sys, tarfile, zipfile
from pathlib import Path
app, output = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
with (app / 'Info.plist').open('rb') as f: info = plistlib.load(f)
assert 'iPhoneSimulator' in info.get('CFBundleSupportedPlatforms', []), 'An iOS Simulator .app is required'
output.mkdir(parents=True, exist_ok=True)
with tarfile.open(output / 'app.tar', 'w', format=tarfile.PAX_FORMAT) as archive:
    archive.add(app, arcname='App.app')
# Local demo uses exactly the same outer ZIP shape as the Actions artifact.
with zipfile.ZipFile(output / 'artifact.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.write(output / 'app.tar', 'app.tar')
print(output / 'app.tar')
