#!/usr/bin/env python3
"""Extract the fixed CI payload without following archive paths or links on the host."""
import json, os, plistlib, shutil, stat, sys, tarfile, zipfile
from pathlib import Path, PurePosixPath

MAX_SIZE = 2 * 1024**3
MAX_ENTRIES = 100_000

def relative(name):
    p = PurePosixPath(name)
    if not name or '\\' in name or p.is_absolute() or '..' in p.parts or '\x00' in name:
        raise ValueError('Unsafe archive path')
    return Path(*p.parts)

def unpack(archive, destination):
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    payload = destination / 'app.tar'
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        if len(entries) != 1 or entries[0].filename != 'app.tar' or entries[0].file_size > MAX_SIZE:
            raise ValueError('Expected one app.tar in the artifact')
        with z.open(entries[0]) as source, payload.open('xb') as target:
            shutil.copyfileobj(source, target)
    with tarfile.open(payload, 'r:') as tar:
        members = []
        total = 0
        for member in tar:
            total += member.size
            if len(members) >= MAX_ENTRIES or total > MAX_SIZE:
                raise ValueError('Expanded application exceeds the limit')
            members.append(member)
        names = {}
        links = []
        for m in members:
            rel = relative(m.name)
            if not rel.parts or rel.parts[0] != 'App.app' or rel in names:
                raise ValueError('Expected one App.app with unique paths')
            if not (m.isfile() or m.isdir() or m.issym()):
                raise ValueError('Unsupported archive entry')
            names[rel] = m
            if m.issym(): links.append((rel, m.linkname))
        # No extraction path can pass through an archived symlink or regular file.
        for rel in names:
            for parent in rel.parents:
                if parent in names and not names[parent].isdir():
                    raise ValueError('Non-directory ancestor')
        for rel, m in names.items():
            target = destination / rel
            if m.isdir(): target.mkdir(parents=True, exist_ok=True)
            elif m.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(m) as source, target.open('xb') as out:
                    shutil.copyfileobj(source, out)
                target.chmod(0o755 if m.mode & 0o111 else 0o644)
        root = (destination / 'App.app').resolve()
        for rel, link in links:
            if not link or PurePosixPath(link).is_absolute() or '\\' in link:
                raise ValueError('Unsafe symlink')
            target = destination / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            os.symlink(link, target)
        for rel, _ in links:
            resolved = (destination / rel).resolve(strict=True)
            if not resolved.is_relative_to(root): raise ValueError('Symlink escapes application')
    payload.unlink()
    with (root / 'Info.plist').open('rb') as f: info = plistlib.load(f)
    bundle = info.get('CFBundleIdentifier', '')
    executable = info.get('CFBundleExecutable', '')
    import re
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{1,254}', bundle): raise ValueError('Invalid bundle identifier')
    if not executable or '/' in executable or executable in ('.', '..'): raise ValueError('Invalid executable')
    if 'iPhoneSimulator' not in info.get('CFBundleSupportedPlatforms', []): raise ValueError('Build must target iOS Simulator')
    binary = root / executable
    if not binary.is_file() or not os.access(binary, os.X_OK): raise ValueError('Missing executable')
    minimum = str(info.get('MinimumOSVersion', ''))
    if not re.fullmatch(r'\d+(\.\d+){0,2}', minimum): raise ValueError('Missing minimum iOS version')
    return {'appPath': str(root), 'bundleID': bundle, 'executable': str(binary), 'minimumOS': minimum}

if __name__ == '__main__':
    try: print(json.dumps(unpack(Path(sys.argv[1]), Path(sys.argv[2]))))
    except Exception as error:
        print(f'Invalid simulator artifact: {error}', file=sys.stderr)
        sys.exit(1)
