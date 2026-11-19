#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -z "${PREVIEW_SCHEME:-}" ]]; then
  python3 scripts/build-demo.py example-build/Demo.app
  python3 scripts/package-preview.py example-build/Demo.app example-build
else
  args=()
  if [[ -n "${PREVIEW_WORKSPACE:-}" ]]; then
    args+=(-workspace "$PREVIEW_WORKSPACE")
  elif [[ -n "${PREVIEW_PROJECT:-}" ]]; then
    args+=(-project "$PREVIEW_PROJECT")
  else
    echo 'Set PREVIEW_PROJECT or PREVIEW_WORKSPACE when specifying PREVIEW_SCHEME.' >&2
    exit 1
  fi
  xcodebuild "${args[@]}" -scheme "$PREVIEW_SCHEME" -configuration Debug \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath example-build/DerivedData ARCHS=arm64 ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO build
  shopt -s nullglob
  apps=(example-build/DerivedData/Build/Products/Debug-iphonesimulator/*.app)
  if [[ ${#apps[@]} != 1 ]]; then
    echo 'Expected exactly one top-level Simulator .app. Adjust the build script for this scheme.' >&2
    exit 1
  fi
  python3 scripts/package-preview.py "${apps[0]}" example-build
fi
