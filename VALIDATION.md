# Validation

Verified locally on Apple Silicon macOS 15.8.2, Xcode 26.3, iOS 26.3.

- 66 Node tests: inherited input/session/auth boundaries plus GitHub build validation, fork rejection, expiration, integrity, credential redirect separation, API origin checks, per-build app configuration and runtime compatibility.
- 3 Python archive test groups: valid executable, traversal/absolute paths/duplicate paths/symlink escape/symlink ancestors, valid internal symlinks.
- Workflow YAML parsed successfully. Third-party Actions references are pinned to commit SHAs.
- Demo builds as arm64 iOS Simulator Mach-O; native capture/encoding host builds successfully.
- Browser integration: real ZIP unpacking, two fresh iPhone 17 Pro instances, app install/launch, H.264/WebRTC video, a browser tap confirmed by the actual iOS app counter, separate app state between builds, reconnect preserving the running app. Test-created devices were removed.
- [Captured browser preview](docs/preview.png).

The integration test replaces only GitHub transport with a local artifact fixture. No GitHub repository has been created or published by this task. Actual Actions execution, PR comment delivery, private repository credentials, Cloudflare Access/Tunnel/TURN and external-network access remain to be verified after repository and hosting configuration. Local demo mode does not claim to verify those services.
