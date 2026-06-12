# FlowWake Studio

**A desktop GUI for OpenFAST and TurbSim wind turbine aeroelastic simulation workflows.**

FlowWake Studio brings OpenFAST and TurbSim into a unified application — from wind field generation and parameter sweeps to simulation execution and results analysis — without requiring command-line expertise.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.XXXXXXX.svg)](https://doi.org/10.5281/zenodo.XXXXXXX)

**Website**: [www.flowwakestudio.com](https://www.flowwakestudio.com)

---

## Features

- **Wind field generation** — TurbSim GUI with IEC turbulence classes, custom profiles, and gTI (gradient turbulence intensity) support
- **Batch sweep generator** — DLC matrix and custom parameter sweeps with automatic TMax calculation (Taylor frozen turbulence)
- **Simulation batch runner** — parallel OpenFAST execution with live progress, stop/resume, and PID tracking
- **Results analysis** — time-series plots, scatter charts, FFT/PSD, channel selection, and export-ready presets
- **Wind field visualiser** — BTS binary file viewer with hover crosshair and grid-point coordinates
- **FAST sub-module editors** — InflowWind, ElastoDyn, AeroDyn, ServoDyn, and offshore modules (HydroDyn, SubDyn, MoorDyn, SeaState, IceDyn)
- **Bundled binaries** — ships with OpenFAST v4.2.0 and TurbSim v4.2.0; no separate installation required
- **Reference turbines** — NREL 5MW, IEA 10MW, IEA 15MW (monopile + UMaine semi + OLAF), IEA 22MW (monopile + semi)

---

## Installation

Download the installer for your platform from the [Releases](https://github.com/findmussa/flowwake-studio/releases) page.

| Platform | File |
|----------|------|
| macOS (Apple Silicon, 13+) | `.dmg` |
| Windows (64-bit, 10/11) | `.exe` installer |

**macOS**: Open the `.dmg`, accept the license agreement, and drag FlowWake Studio to Applications.

**Windows**: Run the `.exe` installer, accept the license agreement, and follow the setup wizard.

No additional software (Python, OpenFAST, TurbSim) is required — everything is bundled.

---

## Quick start

1. **Open or create a project** — click "Open Project" in the sidebar and select a folder.
2. **Generate a wind field** — go to TurbSim, configure parameters, and click Run.
3. **Run a simulation** — go to OpenFAST or Simulation Batch and select your `.fst` file.
4. **Inspect results** — go to Results, load an `.outb` file, and explore the channels.

---

## Building from source

Requirements: [Node.js 20+](https://nodejs.org), [Rust stable](https://rustup.rs), [Python 3.11+](https://python.org)

```bash
git clone https://github.com/findmussa/flowwake-studio.git
cd flowwake-studio
npm install
npm run tauri dev        # development
npm run tauri build      # production build
```

The app ships with pre-built OpenFAST/TurbSim binaries in `src-tauri/resources/bin/`.
The Python sidecar (`fws_io.py`) runs directly in development; CI compiles it with PyInstaller for release builds.

---

## Citation

If you use FlowWake Studio in your research, please cite both the software and the paper:

**Software**
```
Kalimullah, N. M. M. (2026). FlowWake Studio: A desktop GUI for OpenFAST and TurbSim
(v0.1.0). Zenodo. https://doi.org/10.5281/zenodo.XXXXXXX
```

**Paper** *(SoftwareX, in preparation)*
```
Kalimullah, N. M. M. (2026). FlowWake Studio: An open-source desktop application for
wind turbine aeroelastic simulation using OpenFAST. SoftwareX.
```

---

## Third-party components

FlowWake Studio bundles the following open-source software and reference data:

| Component | Version | Reference | License |
|-----------|---------|-----------|---------|
| [OpenFAST](https://github.com/OpenFAST/openfast) | 4.2.0 | NREL | Apache 2.0 |
| [TurbSim](https://github.com/OpenFAST/openfast) | 4.2.0 | NREL | Apache 2.0 |
| [ROSCO](https://github.com/NREL/ROSCO) (libdiscon) | 2.10.1 | Abbas et al. (2022) | Apache 2.0 |
| [NREL 5MW RWT](https://github.com/OpenFAST/r-test/tree/main/glue-codes/openfast/5MW_Baseline) | — | Jonkman et al. (2009) | Apache 2.0 |
| [IEA 10MW RWT](https://github.com/IEAWindSystems/IEA-10.0-198-RWT) | — | Bortolotti et al. (2019) | CC BY 4.0 |
| [IEA 15MW RWT](https://github.com/IEAWindSystems/IEA-15-240-RWT) | — | Gaertner et al. (2020) | CC BY 4.0 |
| [IEA 22MW RWT](https://github.com/IEAWindSystems/IEA-22-280-RWT) | — | Zahle et al. (2024) | CC BY 4.0 |

Full attribution and license texts are in [NOTICE](NOTICE) and [LICENSES/](LICENSES/).

FlowWake Studio is an independent open-source project and is not affiliated with or endorsed by NREL or IEA Wind.

### Key references

- Jonkman, J., Butterfield, S., Musial, W., & Scott, G. (2009). *Definition of a 5-MW reference wind turbine for offshore system development.* NREL/TP-500-38060.
- Bortolotti, P., et al. (2019). *IEA Wind Task 37 on Systems Engineering in Wind Energy — WP2.1 Reference Wind Turbines.* NREL/TP-73492. https://www.nrel.gov/docs/fy19osti/73492.pdf
- Gaertner, E., et al. (2020). *Definition of the IEA Wind 15-Megawatt Offshore Reference Wind Turbine.* NREL/TP-75698. https://www.nrel.gov/docs/fy20osti/75698.pdf
- Allen, C., et al. (2020). *Definition of the UMaine VolturnUS-S Reference Platform.* NREL/TP-76773. https://www.nrel.gov/docs/fy20osti/76773.pdf
- Zahle, F., et al. (2024). *Definition of the IEA Wind 22-Megawatt Offshore Reference Wind Turbine.* DTU Wind Report E-0243. https://doi.org/10.11581/DTU.00000317
- Abbas, N., et al. (2022). *A Reference Open-Source Controller for Fixed and Floating Offshore Wind Turbines.* Wind Energy Science. https://doi.org/10.5194/wes-7-53-2022

---

## License

FlowWake Studio is released under the [Apache License 2.0](LICENSE).

Copyright 2026 Nur Mahammad Mussa Kalimullah, Trinity College Dublin.

---

## Developer

**Nur Mahammad Mussa Kalimullah, PhD**
Research Fellow · Trinity College Dublin
[www.flowwakestudio.com](https://www.flowwakestudio.com) · [findmussa.github.io](https://findmussa.github.io) · [ORCID 0000-0003-0447-6527](https://orcid.org/0000-0003-0447-6527)
