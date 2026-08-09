# Windows desktop wrapper

The desktop release is a thin native wrapper around the static application in the repository root. It starts a loopback-only HTTP server and opens the app in the Windows WebView2 runtime through `pywebview`.

## Build

From PowerShell at the repository root:

```powershell
.\desktop\build_windows.ps1
```

The script creates an isolated build environment under `work/`, bundles `index.html`, `assets/`, `data/`, and `vendor/`, and writes `dist/US_Generation_Intelligence_v3.0.1.exe`.

To rebuild without reinstalling the pinned dependencies:

```powershell
.\desktop\build_windows.ps1 -SkipInstall
```

## Optional courtesy password gate

The wrapper can compile a SHA-256 hash into a build without committing the password:

```powershell
$env:USGI_BUILD_PASSWORD = "choose-a-private-build-password"
.\desktop\build_windows.ps1
Remove-Item Env:USGI_BUILD_PASSWORD
```

This gate is a deterrent only. The password hash and bundled application are still part of the client artifact and should not be treated as strong access control for sensitive data. Use authenticated hosting, encrypted delivery, or per-user licensing when confidentiality matters.

The default repository build has no password configured.
