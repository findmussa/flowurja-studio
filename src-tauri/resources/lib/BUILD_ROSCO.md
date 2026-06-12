# Building lean libdiscon.dylib from ROSCO source

Produces a ZMQ-free, arm64 `libdiscon.dylib` from ROSCO v2.10.4 source.
Tested on macOS 26.5 (arm64) with Command Line Tools only (no Xcode app).

## Prerequisites

```bash
conda install -n openfast_capi cmake ninja gfortran
# NOTE: do NOT install libzmq — its absence is what keeps the build ZMQ-free
```

## Build steps

```bash
mkdir -p /tmp/ROSCO_build/{build,install}
cd /tmp/ROSCO_build
git clone --depth 1 --branch v2.10.4 https://github.com/NREL/ROSCO rosco

# Fix: conda gfortran's bundled ld hardcodes sysroot to
# /Applications/Xcode_15.2.app/... which doesn't exist on CLT-only installs.
# Wrap it to redirect to the actual CLT SDK.
CONDA_LD=/Users/findmussa/mamba/envs/openfast_capi/bin/arm64-apple-darwin20.0.0-ld
mv "$CONDA_LD" "${CONDA_LD}.orig"
cat > "$CONDA_LD" << 'WRAPPER'
#!/bin/bash
args=()
skip=false
for arg in "$@"; do
    if $skip; then
        skip=false
        continue
    fi
    if [[ "$arg" == "-syslibroot" ]]; then
        skip=true
        args+=("-syslibroot" "/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk")
    else
        args+=("$arg")
    fi
done
exec /usr/bin/ld "${args[@]}"
WRAPPER
chmod +x "$CONDA_LD"

# Configure (ZMQ auto-excluded when libzmq pkg not found)
cd /tmp/ROSCO_build/build
PATH="/Users/findmussa/mamba/envs/openfast_capi/bin:/Library/Developer/CommandLineTools/usr/bin:/usr/bin:/bin" \
cmake \
  ../rosco/controller \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
  -DCMAKE_Fortran_COMPILER=$(which gfortran) \
  -DCMAKE_C_COMPILER=/Library/Developer/CommandLineTools/usr/bin/clang \
  -DCMAKE_INSTALL_PREFIX=/tmp/ROSCO_build/install

# Confirm: cmake output should say "Package 'libzmq' not found" -- then build
cmake --build . --parallel $(sysctl -n hw.logicalcpu)
```

## Verify and deploy

```bash
# Verify: must return nothing (no ZMQ)
otool -L /tmp/ROSCO_build/build/libdiscon.dylib | grep zmq

# Strip dev-machine rpaths, add portable bundle rpath
install_name_tool -delete_rpath \
  "$(conda run -n openfast_capi conda info --base)/envs/openfast_capi/lib" \
  /tmp/ROSCO_build/build/libdiscon.dylib 2>/dev/null || true
install_name_tool -add_rpath "@loader_path/../../../../lib" \
  /tmp/ROSCO_build/build/libdiscon.dylib

# Deploy
PROJ="/path/to/nurja"
LIB=/tmp/ROSCO_build/build/libdiscon.dylib
cp "$LIB" "$PROJ/src-tauri/resources/turbines/NREL-5MW/model/NREL-5MW/libdiscon.dylib"
cp "$LIB" "$PROJ/src-tauri/target/debug/turbines/NREL-5MW/model/NREL-5MW/libdiscon.dylib"
```

## Runtime deps

The lean dylib only requires (all already present in `resources/lib/`):
- `libgfortran.5.dylib`
- `libquadmath.0.dylib`
- `libgcc_s.1.1.dylib` (indirect via libgfortran)
- `/usr/lib/libSystem.B.dylib` (always on macOS)

No ZMQ, libsodium, Kerberos, or libc++ needed.
ZMQ chain removed from resources/lib/: ~8 MB savings in the app bundle.

## ROSCO is turbine-agnostic

The same libdiscon.dylib binary works for ALL turbines.
Only `DISCON.IN` and `Cp_Ct_Cq.TurbineName.txt` differ per-turbine.
