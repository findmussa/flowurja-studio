# Bundled Binaries

OpenFAST v4.2.0 and TurbSim v4.2.0 pre-built binaries, organized by platform.
CI copies the target platform's binaries to this directory root before `tauri build`.

## Directory layout

```
bin/
├── macos/
│   ├── openfast        arm64 (Apple Silicon)
│   └── turbsim         arm64
├── windows/
│   ├── openfast.exe    x86_64
│   └── turbsim.exe     x86_64
├── linux/
│   ├── openfast        x86_64
│   └── turbsim         x86_64
└── versions.json       bundled version metadata
```

## Download sources

- **OpenFAST + TurbSim**: https://github.com/OpenFAST/openfast/releases/tag/v4.2.0
- **ROSCO libdiscon**: https://github.com/NREL/ROSCO/releases/tag/v2.10.1

## ROSCO libdiscon

`libdiscon` lives inside each turbine template's model directory alongside the
ServoDyn file. All three platform variants are committed there:

```
turbines/<id>/model/<dir>/
    libdiscon.dylib   (macOS)
    libdiscon.dll     (Windows)
    libdiscon.so      (Linux)
```

The Rust `patch_libdiscon_paths` command rewrites the filename reference in
ServoDyn `.dat` files to match the host OS when a project is created.
