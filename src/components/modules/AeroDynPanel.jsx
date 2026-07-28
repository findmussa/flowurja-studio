import { useState, useEffect, useCallback, useRef, useMemo, createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { invoke }             from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Zap, FolderOpen, Eye, Save, ChevronDown, ChevronRight, Link, Unlink, AlertTriangle, List,
} from "lucide-react";
import RawFileModal from "../RawFileModal";
import InfoPopover from "../InfoPopover";
import s from "./AeroDynPanel.module.css";

const ACCENT = "#BA7517";

// ── Missing-fields context ────────────────────────────────────────────────────
const MissingCtx = createContext(new Set());

// Fields with no UI control yet (new v15.03 params) — never flag in the banner.
const NO_UI_FIELDS = new Set([
  "NacelleDrag","BEM_Mod",
  "SkewMomCorr","SkewRedistr_Mod","SkewRedistrFactor",
  "SectAvg","SectAvgWeighting","SectAvgNPoints","SectAvgPsiBwd","SectAvgPsiFwd",
  "AoA34","IntegrationMethod",
  "NacArea","NacCd","NacDragAC",
]);

// Tab location for each DEFAULT key — used to navigate from the banner.
const FIELD_TAB = {
  // quick
  WakeMod:"quick", AFAeroMod:"quick", DTAero:"quick", UAMod:"quick",
  TipLoss:"quick", HubLoss:"quick", TwrAero:"quick", TanInd:"quick",
  // general
  Echo:"general", TwrPotent:"general", TwrShadow:"general",
  FrozenWake:"general", CavitCheck:"general", Buoyancy:"general",
  CompAA:"general", AA_InputFile:"general",
  AirDens:"general", KinVisc:"general", SpdSound:"general", Patm:"general", Pvap:"general",
  TFinAero:"general", TFinFile:"general",
  // models
  SkewMod:"models", SkewModFactor:"models", IndToler:"models", MaxIter:"models",
  AIDrag:"models", TIDrag:"models",
  DBEMT_Mod:"models", tau1_const:"models", OLAFInputFileName:"models",
  FLookup:"models", UAStartRad:"models", UAEndRad:"models",
  // blades
  UseBlCm:"blades",
  ADBlFile1:"blades", ADBlFile2:"blades", ADBlFile3:"blades",
  AFTabMod:"blades", InCol_Alfa:"blades", InCol_Cl:"blades",
  InCol_Cd:"blades", InCol_Cm:"blades", InCol_Cpmin:"blades", NumAFfiles:"blades",
  // output
  VolHub:"output", HubCenBx:"output", VolNac:"output", NacCenB:"output",
  NumTwrNds:"output", SumPrint:"output",
  NBlOuts:"output", BlOutNd:"output", NTwOuts:"output", TwOutNd:"output",
  BldNd_BladesOut:"output", BldNd_BlOutNd:"output",
};

// ── Tabs ─────────────────────────────────────────────────────────────────────
const TABS = [
  { id: "quick",   label: "Quick"           },
  { id: "general", label: "General"         },
  { id: "models",  label: "Aero Models"     },
  { id: "blades",  label: "Blade & Airfoils"},
  { id: "output",  label: "Tower & Output"  },
];

const WAKE_MODES = [
  { v: 0, label: "0 – None"  },
  { v: 1, label: "1 – BEMT"  },
  { v: 2, label: "2 – DBEMT" },
  { v: 3, label: "3 – OLAF"  },
];

const AF_AERO_MODES = [
  { v: 1, label: "1 – Steady" },
  { v: 2, label: "2 – B-L Unsteady" },
];

const TWR_POTENT_MODES = [
  { v: 0, label: "0 – None"        },
  { v: 1, label: "1 – Baseline"    },
  { v: 2, label: "2 – Bak corr."   },
];

const TWR_SHADOW_MODES = [
  { v: 0, label: "0 – None"   },
  { v: 1, label: "1 – Powles" },
  { v: 2, label: "2 – Eames"  },
];

const DBEMT_MODES = [
  { v: 0, label: "0 – Disabled"        },
  { v: 1, label: "1 – Const τ₁"       },
  { v: 2, label: "2 – Time-dep τ₁"    },
  { v: 3, label: "3 – Const τ₁ cont." },
];

const UA_MODES = [
  { v: 2, label: "2 – B-L Gonzalez"        },
  { v: 3, label: "3 – B-L Minnema/Pierce"  },
  { v: 4, label: "4 – B-L HGM 4-state"     },
  { v: 5, label: "5 – B-L 5-state"         },
  { v: 6, label: "6 – Øye"                 },
  { v: 7, label: "7 – Boeing-Vertol"        },
];

const AFTAB_MODES = [
  { v: 1, label: "1 – 1D (AoA)"         },
  { v: 2, label: "2 – 2D (AoA + Re)"    },
  { v: 3, label: "3 – 2D (AoA + User)"  },
];

// ── Default tower table (NREL 5 MW, 12 nodes) ────────────────────────────────
const DEFAULT_TWR_TABLE =
`TwrElev        TwrDiam        TwrCd          TwrTI          TwrCb
(m)            (m)            (-)            (-)            (-)
0.0000E+00     6.0000E+00     1.0000E+00     1.0000E-01     0.0
8.5261E+00     5.7870E+00     1.0000E+00     1.0000E-01     0.0
1.7053E+01     5.5740E+00     1.0000E+00     1.0000E-01     0.0
2.5579E+01     5.3610E+00     1.0000E+00     1.0000E-01     0.0
3.4105E+01     5.1480E+00     1.0000E+00     1.0000E-01     0.0
4.2633E+01     4.9350E+00     1.0000E+00     1.0000E-01     0.0
5.1158E+01     4.7220E+00     1.0000E+00     1.0000E-01     0.0
5.9685E+01     4.5090E+00     1.0000E+00     1.0000E-01     0.0
6.8211E+01     4.2960E+00     1.0000E+00     1.0000E-01     0.0
7.6738E+01     4.0830E+00     1.0000E+00     1.0000E-01     0.0
8.5268E+01     3.8700E+00     1.0000E+00     1.0000E-01     0.0
8.7600E+01     3.8700E+00     1.0000E+00     1.0000E-01     0.0`;

// ── Defaults (NREL 5 MW values) ───────────────────────────────────────────────
const DEFAULT = {
  // General
  Echo: false, DTAero: "default",
  WakeMod: 1, AFAeroMod: 2,
  TwrPotent: 1, TwrShadow: 1, TwrAero: true,
  NacelleDrag: false,
  FrozenWake: false, CavitCheck: false, Buoyancy: false, CompAA: false,
  AA_InputFile: "unused",

  // Environment
  AirDens: "default", KinVisc: "default", SpdSound: "default",
  Patm: "default", Pvap: "default",

  // BEMT — v15.03 new params
  BEM_Mod: 1,
  SkewMod: 1, SkewModFactor: "default",
  SkewMomCorr: false, SkewRedistr_Mod: 1, SkewRedistrFactor: "default",
  TipLoss: true, HubLoss: true, TanInd: true, AIDrag: true, TIDrag: true,
  IndToler: "default", MaxIter: 500,
  // Sector averaging (v15.03)
  SectAvg: false, SectAvgWeighting: 1,
  SectAvgNPoints: "default", SectAvgPsiBwd: "default", SectAvgPsiFwd: "default",

  // DBEMT
  DBEMT_Mod: 2, tau1_const: 29.03,

  // OLAF
  OLAFInputFileName: "unused",

  // B-L Unsteady — v15.03: AoA34 and IntegrationMethod
  AoA34: true,
  UAMod: 3, FLookup: true, UAStartRad: 0.1, UAEndRad: 1.0,
  IntegrationMethod: 3,

  // Airfoil info
  AFTabMod: 1,
  InCol_Alfa: 1, InCol_Cl: 2, InCol_Cd: 3, InCol_Cm: 4, InCol_Cpmin: 0,
  NumAFfiles: 8,
  AFNames: `../5MW_Baseline/Airfoils/Cylinder1.dat
../5MW_Baseline/Airfoils/Cylinder2.dat
../5MW_Baseline/Airfoils/DU40_A17.dat
../5MW_Baseline/Airfoils/DU35_A17.dat
../5MW_Baseline/Airfoils/DU30_A17.dat
../5MW_Baseline/Airfoils/DU25_A17.dat
../5MW_Baseline/Airfoils/DU21_A17.dat
../5MW_Baseline/Airfoils/NACA64_A17.dat`,

  // Rotor/Blade
  UseBlCm: true,
  ADBlFile1: "../5MW_Baseline/NRELOffshrBsline5MW_AeroDyn_blade.dat",
  ADBlFile2: "../5MW_Baseline/NRELOffshrBsline5MW_AeroDyn_blade.dat",
  ADBlFile3: "../5MW_Baseline/NRELOffshrBsline5MW_AeroDyn_blade.dat",

  // Hub / Nacelle buoyancy (unused for onshore)
  VolHub: 0.0, HubCenBx: 0.0,
  VolNac: 0.0, NacCenB: "0,0,0",

  // Tail fin
  TFinAero: false, TFinFile: "unused",

  // Tower
  NumTwrNds: 12,
  TowerTable: DEFAULT_TWR_TABLE,

  // Output
  SumPrint: false,
  NBlOuts: 0, BlOutNd: "1",
  NTwOuts: 0, TwOutNd: "1",
  OutList: '"RtSpeed"\n"RtTSR"\n"RtVAvgxh"\n"RtFldPwr"\n"RtFldCp"\n"RtFldCt"',

  // Optional blade-node output
  BldNd_BladesOut: 1, BldNd_BlOutNd: "All",
  OutListAD: '"Fx"\n"Fy"\n"alpha"\n"Cl"',
};

// ── Parser ───────────────────────────────────────────────────────────────────
function parseAeroDynFile(content) {
  const kv = {};
  const lines = content.split("\n");
  let inOutList = false;
  let inOutListAD = false;
  let inAFNames = false;
  let afNamesCount = 0;
  let afNamesCollected = 0;
  const afNames = [];
  let inTowerTable = false;
  let towerTableLines = [];
  const outListLines = [];
  const outListADLines = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    if (inOutListAD) {
      if (/^END\b/i.test(line)) { inOutListAD = false; continue; }
      const m = line.match(/^"([^"]+)"/);
      if (m) outListADLines.push(`"${m[1]}"`);
      continue;
    }

    if (inOutList) {
      if (/^END\b/i.test(line)) { inOutList = false; continue; }
      const m = line.match(/^"([^"]+)"/);
      if (m) outListLines.push(`"${m[1]}"`);
      continue;
    }

    if (inAFNames && afNamesCollected < afNamesCount) {
      if (line.startsWith('"')) {
        const end = line.indexOf('"', 1);
        if (end > 0) { afNames.push(line.slice(1, end)); afNamesCollected++; }
      }
      if (afNamesCollected >= afNamesCount) inAFNames = false;
      continue;
    }

    if (inTowerTable) {
      if (/^TwrElev/i.test(line) || /^\(m\)/.test(line)) {
        towerTableLines.push(rawLine);
        continue;
      }
      if (/^[\d\-\+]/.test(line)) {
        towerTableLines.push(rawLine);
        continue;
      }
      inTowerTable = false;
    }

    // Skip blank/comment lines, section headers (=====), separators (--- or more),
    // and END-of-list sentinels in the main body.
    if (!line || line.startsWith("!") || /^={4,}/.test(line) || /^-{2,}/.test(line) || /^END\b/i.test(line)) continue;

    let rest = line;
    let value;

    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      if (end < 0) continue;
      value = rest.slice(1, end);
      rest  = rest.slice(end + 1).trim();
    } else {
      const sp = rest.search(/\s/);
      if (sp < 0) continue;
      value = rest.slice(0, sp);
      rest  = rest.slice(sp).trim();
      // Accumulate comma-terminated tokens (e.g. "0.0, 0.0, 0.0  NacCenB")
      while (value.endsWith(",") && rest.length) {
        const sp2 = rest.search(/\s/);
        if (sp2 < 0) { value += " " + rest; rest = ""; break; }
        value += " " + rest.slice(0, sp2);
        rest = rest.slice(sp2).trim();
      }
    }

    const keyMatch = rest.match(/^(\S+)/);
    if (!keyMatch) continue;
    const key = keyMatch[1];
    // Skip pseudo-keys that are not valid OpenFAST identifiers (e.g. title-line words).
    // Allow the "Key(N)" indexed form used by ADBlFile(1), etc.
    if (!/^[A-Za-z_][A-Za-z_0-9]*(\(\d+\))?$/.test(key)) continue;

    const kl = key.toLowerCase();
    if (kl === "outlist") { inOutList = true; continue; }
    if (kl === "outlistad") { inOutListAD = true; continue; }

    if (kl === "afnames") {
      afNames.push(value);
      afNamesCollected = 1;
      inAFNames = afNamesCollected < afNamesCount;
      continue;
    }

    if (kl === "numtwrnds") {
      kv[key] = value;
      inTowerTable = true;
      continue;
    }

    kv[key] = value;
    if (kl === "numaffiles") afNamesCount = parseInt(value) || 0;
  }

  if (afNames.length)         kv["__AFNames__"]    = afNames.join("\n");
  if (towerTableLines.length) kv["__TowerTable__"] = towerTableLines.join("\n");
  if (outListLines.length)    kv["__OutList__"]    = outListLines.join("\n");
  if (outListADLines.length)  kv["__OutListAD__"]  = outListADLines.join("\n");
  return kv;
}

function adParsedToState(kv) {
  const st = { ...DEFAULT };
  const b  = (v) => typeof v === "string" && v.toLowerCase() === "true";
  const n  = (v) => v !== undefined && !isNaN(Number(v)) ? Number(v) : undefined;

  // ── Key-name aliases: IEA 15 MW uses underscored names (Wake_Mod, UA_Mod, etc.)
  // Normalise them to the canonical forms used in this component.
  const ALIASES = {
    "Wake_Mod":    "WakeMod",
    "UA_Mod":      "UAMod",
    "Skew_Mod":    "SkewMod",
    "AFAero_Mod":  "AFAeroMod",
    "DBEMT_Mod":   "DBEMT_Mod",  // same — keep for completeness
  };
  for (const [alias, canon] of Object.entries(ALIASES)) {
    if (kv[alias] !== undefined && kv[canon] === undefined) {
      kv[canon] = kv[alias];
    }
  }

  const boolKeys = [
    "Echo","TwrAero","FrozenWake","CavitCheck","Buoyancy","CompAA",
    "TipLoss","HubLoss","TanInd","AIDrag","TIDrag","FLookup","UseBlCm",
    "SumPrint","TFinAero",
    // v15.03 new bool params
    "NacelleDrag","SectAvg","SkewMomCorr","AoA34",
  ];
  for (const k of boolKeys) {
    if (kv[k] !== undefined) st[k] = b(kv[k]);
  }

  const intKeys = [
    "WakeMod","AFAeroMod","TwrPotent","TwrShadow","MaxIter","DBEMT_Mod",
    "UAMod","AFTabMod","InCol_Alfa","InCol_Cl","InCol_Cd","InCol_Cm","InCol_Cpmin",
    "NumAFfiles","NumTwrNds","NBlOuts","NTwOuts","BldNd_BladesOut",
    "SkewMod",
    // v15.03 new int params
    "BEM_Mod","SkewRedistr_Mod","SectAvgWeighting","IntegrationMethod",
  ];
  for (const k of intKeys) {
    const v = n(kv[k]); if (v !== undefined) st[k] = v;
  }

  const floatKeys = ["tau1_const","UAStartRad","UAEndRad","VolHub","HubCenBx","VolNac"];
  for (const k of floatKeys) {
    const v = n(kv[k]); if (v !== undefined) st[k] = v;
  }

  // String / "default" fields
  for (const k of ["DTAero","AirDens","KinVisc","SpdSound","Patm","Pvap","SkewModFactor","IndToler"]) {
    if (kv[k] !== undefined) st[k] = kv[k];
  }
  for (const k of ["AA_InputFile","OLAFInputFileName","TFinFile","NacCenB","BlOutNd","TwOutNd","BldNd_BlOutNd"]) {
    if (kv[k] !== undefined) st[k] = kv[k];
  }
  // v15.03 new string/"default" params
  for (const k of ["SkewRedistrFactor","SectAvgNPoints","SectAvgPsiBwd","SectAvgPsiFwd"]) {
    if (kv[k] !== undefined) st[k] = kv[k];
  }

  // Parenthesised blade file keys
  const paren = {
    "ADBlFile(1)": "ADBlFile1",
    "ADBlFile(2)": "ADBlFile2",
    "ADBlFile(3)": "ADBlFile3",
  };
  for (const [fk, sk] of Object.entries(paren)) {
    if (kv[fk] !== undefined) st[sk] = kv[fk];
  }

  if (kv["__AFNames__"])    st.AFNames     = kv["__AFNames__"];
  if (kv["__TowerTable__"]) st.TowerTable  = kv["__TowerTable__"];
  if (kv["__OutList__"])    st.OutList     = kv["__OutList__"];
  if (kv["__OutListAD__"])  st.OutListAD   = kv["__OutListAD__"];

  // Preserve the full raw kv so the builder can write back any params not shown in the UI
  st.__rawKV__ = { ...kv };

  return st;
}

// ── File builder ─────────────────────────────────────────────────────────────
function buildAeroDynContent(p, description = "Generated by FlowUrja Studio") {
  const b   = v => v ? "True " : "False";
  const q   = v => `"${v}"`;
  const r   = (v, w = 14) => String(v).padStart(w);
  const pad = (v, n = 14) => String(v).padEnd(n);

  const afFileLines = (p.AFNames || "")
    .split("\n").map(l => l.trim()).filter(l => l);
  const afBlock = afFileLines.length
    ? [`${q(afFileLines[0]).padEnd(60)}AFNames            - Airfoil file names (NumAFfiles lines) (quoted strings)`,
       ...afFileLines.slice(1).map(f => q(f))]
    : [`"airfoil.dat"${" ".repeat(48)}AFNames            - Airfoil file names`];

  const outLines = (p.OutList || "")
    .split("\n").map(l => l.trim()).filter(l => l)
    .map(l => l.startsWith('"') ? l : `"${l}"`);

  const outADLines = (p.OutListAD || "")
    .split("\n").map(l => l.trim()).filter(l => l)
    .map(l => l.startsWith('"') ? l : `"${l}"`);

  const towerRows = (p.TowerTable || DEFAULT_TWR_TABLE)
    .split("\n").map(l => l);

  const lines = [
    `------- AERODYN v15 for OpenFAST INPUT FILE -----------------------------------------------`,
    description,
    `======  General Options  ============================================================================`,
    `${pad(b(p.Echo))} Echo               - Echo the input to "<rootname>.AD.ech"?  (flag)`,
    `${pad(q(p.DTAero))} DTAero             - Time interval for aerodynamic calculations {or "default"} (s)`,
    `${r(p.WakeMod)}   WakeMod            - Type of wake/induction model (switch) {0=none, 1=BEMT, 2=DBEMT, 3=OLAF}`,
    `${r(p.AFAeroMod)}   AFAeroMod          - Type of blade airfoil aerodynamics model (switch) {1=steady, 2=B-L unsteady}`,
    `${r(p.TwrPotent)}   TwrPotent          - Type tower influence on wind based on potential flow (switch) {0=none, 1=baseline, 2=Bak}`,
    `${r(p.TwrShadow)}   TwrShadow          - Calculate tower shadow (switch) {0=none, 1=Powles, 2=Eames}`,
    `${pad(b(p.TwrAero))} TwrAero            - Calculate tower aerodynamic loads? (flag)`,
    `${pad(b(p.FrozenWake))} FrozenWake         - Assume frozen wake during linearization? (flag)`,
    `${pad(b(p.CavitCheck))} CavitCheck         - Perform cavitation check? (flag)`,
    `${pad(b(p.Buoyancy))} Buoyancy           - Include buoyancy effects? (flag)`,
    `${pad(b(p.CompAA))} CompAA             - Flag to compute AeroAcoustics calculation`,
    `${pad(q(p.AA_InputFile))} AA_InputFile       - AeroAcoustics input file [used only when CompAA=true]`,
    `======  Environmental Conditions  ===================================================================`,
    `${pad(q(p.AirDens))} AirDens            - Air density (kg/m^3)`,
    `${pad(q(p.KinVisc))} KinVisc            - Kinematic viscosity of working fluid (m^2/s)`,
    `${pad(q(p.SpdSound))} SpdSound           - Speed of sound in working fluid (m/s)`,
    `${pad(q(p.Patm))} Patm               - Atmospheric pressure (Pa) [used only when CavitCheck=True]`,
    `${pad(q(p.Pvap))} Pvap               - Vapour pressure of working fluid (Pa) [used only when CavitCheck=True]`,
    `======  Blade-Element/Momentum Theory Options  ====================================================== [unused when WakeMod=0 or 3]`,
    `${r(p.SkewMod)}   SkewMod            - Type of skewed-wake correction model (switch) {1=uncoupled, 2=Pitt/Peters, 3=coupled}`,
    `${pad(q(p.SkewModFactor))} SkewModFactor      - Constant used in Pitt/Peters skewed wake model {or "default"}`,
    `${pad(b(p.TipLoss))} TipLoss            - Use the Prandtl tip-loss model? (flag)`,
    `${pad(b(p.HubLoss))} HubLoss            - Use the Prandtl hub-loss model? (flag)`,
    `${pad(b(p.TanInd))} TanInd             - Include tangential induction in BEMT calculations? (flag)`,
    `${pad(b(p.AIDrag))} AIDrag             - Include the drag term in the axial-induction calculation? (flag)`,
    `${pad(b(p.TIDrag))} TIDrag             - Include the drag term in the tangential-induction calculation? (flag)`,
    `${pad(q(p.IndToler))} IndToler           - Convergence tolerance for BEMT nonlinear solve residual {or "default"}`,
    `${r(p.MaxIter)}   MaxIter            - Maximum number of iteration steps (-)`,
    `======  Dynamic Blade-Element/Momentum Theory Options  ============================================== [used only when WakeMod=2]`,
    `${r(p.DBEMT_Mod)}   DBEMT_Mod          - Type of dynamic BEMT model {1=const tau1, 2=time-dep tau1, 3=const tau1 cont.}`,
    `${r(p.tau1_const)}   tau1_const         - Time constant for DBEMT (s) [used only when WakeMod=2 and DBEMT_Mod=1 or 3]`,
    `======  OLAF -- cOnvecting LAgrangian Filaments (Free Vortex Wake) Theory Options  ================== [used only when WakeMod=3]`,
    `${pad(q(p.OLAFInputFileName))} OLAFInputFileName  - Input file for OLAF [used only when WakeMod=3]`,
    `======  Beddoes-Leishman Unsteady Airfoil Aerodynamics Options  ===================================== [used only when AFAeroMod=2]`,
    `${r(p.UAMod)}   UAMod              - Unsteady Aero Model Switch (switch) {2=B-L Gonzalez, 3=B-L Minnema/Pierce, 4=HGM 4-states, 5=5 states, 6=Oye, 7=Boeing-Vertol}`,
    `${pad(b(p.FLookup))} FLookup            - Flag to indicate whether a lookup for f' will be calculated (flag)`,
    `${r(p.UAStartRad)}   UAStartRad         - Starting radius for dynamic stall (fraction of rotor radius)`,
    `${r(p.UAEndRad)}   UAEndRad           - Ending radius for dynamic stall (fraction of rotor radius)`,
    `======  Airfoil Information =========================================================================`,
    `${r(p.AFTabMod)}   AFTabMod           - Interpolation method for multiple airfoil tables {1=1D AoA; 2=2D AoA+Re; 3=2D AoA+User}`,
    `${r(p.InCol_Alfa)}   InCol_Alfa         - The column in the airfoil tables that contains the angle of attack`,
    `${r(p.InCol_Cl)}   InCol_Cl           - The column in the airfoil tables that contains the lift coefficient`,
    `${r(p.InCol_Cd)}   InCol_Cd           - The column in the airfoil tables that contains the drag coefficient`,
    `${r(p.InCol_Cm)}   InCol_Cm           - The column in the airfoil tables that contains the pitching-moment coefficient`,
    `${r(p.InCol_Cpmin)}   InCol_Cpmin        - The column in the airfoil tables that contains the Cpmin coefficient; 0 if none`,
    `${r(p.NumAFfiles)}   NumAFfiles         - Number of airfoil files used (-)`,
    ...afBlock,
    `======  Rotor/Blade Properties  =====================================================================`,
    `${pad(b(p.UseBlCm))} UseBlCm            - Include aerodynamic pitching moment in calculations?  (flag)`,
    `${q(p.ADBlFile1).padEnd(60)}ADBlFile(1)        - Name of file containing distributed aerodynamic properties for Blade #1`,
    `${q(p.ADBlFile2).padEnd(60)}ADBlFile(2)        - Name of file containing distributed aerodynamic properties for Blade #2`,
    `${q(p.ADBlFile3).padEnd(60)}ADBlFile(3)        - Name of file containing distributed aerodynamic properties for Blade #3`,
    `======  Hub Properties ============================================================================== [used only when Buoyancy=True]`,
    `${r(p.VolHub)}   VolHub             - Hub volume (m^3)`,
    `${r(p.HubCenBx)}   HubCenBx           - Hub center of buoyancy x direction offset (m)`,
    `======  Nacelle Properties ========================================================================== [used only when Buoyancy=True]`,
    `${r(p.VolNac)}   VolNac             - Nacelle volume (m^3)`,
    `${String(p.NacCenB).padEnd(6)} NacCenB            - Position of nacelle center of buoyancy from yaw bearing in nacelle coordinates (m)`,
    `======  Tail fin Aerodynamics ========================================================================`,
    `${pad(b(p.TFinAero))} TFinAero           - Calculate tail fin aerodynamics model (flag)`,
    `${pad(q(p.TFinFile))} TFinFile           - Input file for tail fin aerodynamics [used only when TFinAero=True]`,
    `======  Tower Influence and Aerodynamics ============================================================`,
    `${r(p.NumTwrNds)}   NumTwrNds         - Number of tower nodes used in the analysis  (-)`,
    ...towerRows,
    `======  Outputs  ====================================================================================`,
    `${pad(b(p.SumPrint))} SumPrint            - Generate a summary file?  (flag)`,
    `${r(p.NBlOuts)}   NBlOuts             - Number of blade node outputs [0 - 9] (-)`,
    `${String(p.BlOutNd).padEnd(14)} BlOutNd             - Blade nodes whose values will be output  (-)`,
    `${r(p.NTwOuts)}   NTwOuts             - Number of tower node outputs [0 - 9]  (-)`,
    `${String(p.TwOutNd).padEnd(14)} TwOutNd             - Tower nodes whose values will be output  (-)`,
    `                   OutList             - The next line(s) contains a list of output parameters.`,
    ...outLines,
    `END of input file (the word "END" must appear in the first 3 columns of this last OutList line)`,
    `====== Outputs for all blade stations ============================= [optional section]`,
    `${r(p.BldNd_BladesOut)}              BldNd_BladesOut     - Number of blades to output all node information at.`,
    `${pad(q(p.BldNd_BlOutNd))} BldNd_BlOutNd       - Future feature will allow selecting a portion of the nodes.`,
    `                  OutListAD             - The next line(s) contains a list of output parameters.`,
    ...outADLines,
    `END of  input file (the word "END" must appear in the first 3 columns of this last OutList line)`,
    `-------------------------------------------------------------------------------------------`,
  ];

  // ── Passthrough: write back any params from the original file not shown in the UI ──
  const WRITTEN_AD = new Set([
    "Echo","DTAero","WakeMod","AFAeroMod","TwrPotent","TwrShadow","TwrAero",
    "NacelleDrag",
    "FrozenWake","CavitCheck","Buoyancy","CompAA","AA_InputFile",
    "AirDens","KinVisc","SpdSound","Patm","Pvap",
    "BEM_Mod",
    "SkewMod","SkewModFactor",
    "SkewMomCorr","SkewRedistr_Mod","SkewRedistrFactor",
    "TipLoss","HubLoss","TanInd","AIDrag","TIDrag","IndToler","MaxIter",
    "SectAvg","SectAvgWeighting","SectAvgNPoints","SectAvgPsiBwd","SectAvgPsiFwd",
    "DBEMT_Mod","tau1_const",
    "OLAFInputFileName",
    "AoA34",
    "UAMod","FLookup","UAStartRad","UAEndRad",
    "IntegrationMethod",
    "AFTabMod","InCol_Alfa","InCol_Cl","InCol_Cd","InCol_Cm","InCol_Cpmin","NumAFfiles","AFNames",
    "UseBlCm","ADBlFile(1)","ADBlFile(2)","ADBlFile(3)","ADBlFile1","ADBlFile2","ADBlFile3",
    "VolHub","HubCenBx","VolNac","NacCenB",
    "NacArea","NacCd","NacDragAC",
    "TFinAero","TFinFile",
    "NumTwrNds",
    "SumPrint","NBlOuts","BlOutNd","NTwOuts","TwOutNd","OutList",
    "BldNd_BladesOut","BldNd_BlOutNd","OutListAD",
    // alias originals (already normalised in kv by adParsedToState)
    "Wake_Mod","UA_Mod","Skew_Mod","AFAero_Mod",
  ]);
  const rawAD = p.__rawKV__ || {};
  const passAD = Object.entries(rawAD)
    .filter(([k]) => !WRITTEN_AD.has(k) && !k.startsWith("__"))
    .map(([k, v]) => `${String(v).padEnd(14)} ${k}`);
  if (passAD.length) {
    lines.push(
      "!--- Parameters not editable in this UI (preserved verbatim from original file) ---",
      ...passAD,
    );
  }
  return lines.join("\n");
}

// ── Sub-components ────────────────────────────────────────────────────────────
function SectionHead({ children }) {
  return <h3 className={s.sectionHead}>{children}</h3>;
}

function DisabledHintPortal({ text, rect }) {
  const popRef = useRef(null);
  const W = 280;
  let left = rect.left;
  if (left + W > window.innerWidth - 8) left = window.innerWidth - W - 8;
  if (left < 8) left = 8;
  const [top, setTop] = useState(rect.bottom + 6);
  useEffect(() => {
    if (!popRef.current) return;
    const r = popRef.current.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) setTop(rect.top - r.height - 6);
  }, [rect.top]);
  return createPortal(
    <div ref={popRef} style={{
      position:"fixed", top, left, zIndex:99998, width:W,
      background:"var(--bg-popover, color-mix(in srgb, var(--bg-surface) 88%, transparent))",
      backdropFilter:"blur(20px) saturate(1.8)",
      WebkitBackdropFilter:"blur(20px) saturate(1.8)",
      border:"0.5px solid var(--bd-popover, rgba(0,0,0,0.15))",
      borderRadius:10,
      padding:"8px 12px",
      fontSize:11.5,
      color:"var(--tx-2)",
      lineHeight:1.5,
      boxShadow:"0 4px 20px rgba(0,0,0,0.14)",
      pointerEvents:"none",
    }}>{text}</div>,
    document.body
  );
}

function Field({ label, unit, children, hint, info, fieldKey, disabledHint }) {
  const missingSet = useContext(MissingCtx);
  const fieldRef = useRef(null);
  const [hintRect, setHintRect] = useState(null);
  const key = fieldKey || label.match(/\(([A-Za-z_][A-Za-z_0-9]*)\)\s*$/)?.[1];
  const isMissing = key && missingSet.size > 0 && missingSet.has(key);
  const showHint = () => {
    if (!disabledHint || !fieldRef.current) return;
    setHintRect(fieldRef.current.getBoundingClientRect());
  };
  return (
    <div ref={fieldRef}
      className={`${s.field} ${disabledHint ? s.fieldDisabled : ""}`}
      onMouseEnter={showHint}
      onMouseLeave={() => setHintRect(null)}>
      <div className={s.fieldHeader}>
        <span className={s.fieldLabel}>{label}</span>
        {unit && <span className={s.unit}>{unit}</span>}
        {isMissing && <span className={s.defaultBadge}>default</span>}
        {info && (
          <InfoPopover
            accentColor={ACCENT}
            content={typeof info === "string" ? { desc: info } : info}
          />
        )}
      </div>
      <div className={isMissing ? s.fieldDefaulted : undefined}>
        {children}
      </div>
      {hint && <span className={s.hint}>{hint}</span>}
      {disabledHint && hintRect && <DisabledHintPortal text={disabledHint} rect={hintRect} />}
    </div>
  );
}

function Toggle({ label, value, onChange, note }) {
  return (
    <div className={s.toggleRow}>
      <button
        className={[s.toggle, value ? s.on : ""].join(" ")}
        onClick={() => onChange(!value)}
        type="button"
      >
        <span className={s.toggleThumb} />
      </button>
      <span className={s.toggleLabel}>{label}</span>
      {note && <span className={s.toggleNote}>{note}</span>}
    </div>
  );
}

function SelField({ label, value, onChange, options, hint, disabledHint }) {
  return (
    <Field label={label} hint={hint} disabledHint={disabledHint}>
      <select
        className={s.select}
        value={value}
        disabled={!!disabledHint}
        onChange={e => onChange(Number(e.target.value))}
      >
        {options.map(o => (
          <option key={o.v} value={o.v}>{o.label}</option>
        ))}
      </select>
    </Field>
  );
}

function FileTriple({ label, keys, p, setP }) {
  const [synced, setSynced] = useState(
    p[keys[0]] === p[keys[1]] && p[keys[1]] === p[keys[2]]
  );
  const handleChange = (key, val) => {
    if (synced) {
      setP(prev => ({ ...prev, [keys[0]]: val, [keys[1]]: val, [keys[2]]: val }));
    } else {
      setP(prev => ({ ...prev, [key]: val }));
    }
  };
  const browse = async (key) => {
    const f = await openDialog({ multiple: false, filters: [{ name: "DAT", extensions: ["dat","inp","txt","*"] }] });
    if (f) handleChange(key, f);
  };
  return (
    <div className={s.field}>
      <div className={s.fieldHeader}>
        <span className={s.fieldLabel}>{label}</span>
        <button
          className={[s.syncBtn, synced ? s.synced : ""].join(" ")}
          onClick={() => setSynced(v => !v)}
          type="button"
        >
          {synced
            ? <Link size={10} strokeWidth={2} />
            : <Unlink size={10} strokeWidth={2} />}
          {synced ? "Synced" : "Sync"}
        </button>
      </div>
      <div className={s.bladeRow}>
        {keys.map((k, i) => (
          <div key={k} className={s.bladeCell}>
            <span className={s.bladeIdx}>Blade {i + 1}</span>
            <div className={s.fileRow}>
              <input
                className={s.inp}
                value={p[k] || ""}
                onChange={e => handleChange(k, e.target.value)}
                placeholder="path/to/blade.dat"
              />
              <button className={s.browseBtn} onClick={() => browse(k)} type="button">
                <FolderOpen size={12} strokeWidth={1.8} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Collapsible({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={s.collapsible}>
      <button className={s.collapsibleHead} onClick={() => setOpen(v => !v)} type="button">
        {open
          ? <ChevronDown  size={13} strokeWidth={2} />
          : <ChevronRight size={13} strokeWidth={2} />}
        {title}
      </button>
      {open && <div className={s.collapsibleBody}>{children}</div>}
    </div>
  );
}

function inp(className) { return className; }

// ── Turbine schematic (aerodynamic focus — wind arrows + orange blades) ───────
function TurbineSchematic() {
  const c = "#BA7517";
  return (
    <svg viewBox="0 0 100 110" width="100%" height="180" style={{ display: "block" }}>
      {/* Tower + base */}
      <line x1="50" y1="54" x2="50" y2="100"
        style={{ stroke: "var(--tx-4)" }} strokeWidth="5" strokeLinecap="round"/>
      <line x1="38" y1="101" x2="62" y2="101"
        style={{ stroke: "var(--bd-strong)" }} strokeWidth="2"/>
      {/* Nacelle */}
      <rect x="42" y="48" width="16" height="8" rx="2"
        style={{ fill: "var(--bg-hover-md)" }}/>
      {/* Hub */}
      <circle cx="50" cy="52" r="3.5" fill={c}/>
      {/* Blades */}
      <line x1="50" y1="48" x2="50" y2="14" stroke={c} strokeWidth="3" strokeLinecap="round"/>
      <line x1="47" y1="55" x2="18" y2="73" stroke={c} strokeWidth="3" strokeLinecap="round"/>
      <line x1="53" y1="55" x2="82" y2="73" stroke={c} strokeWidth="3" strokeLinecap="round"/>
      {/* Wind arrows — inflow */}
      <g opacity="0.55">
        <line x1="4" y1="38" x2="24" y2="38" stroke={c} strokeWidth="1.5" strokeLinecap="round"/>
        <polyline points="20,34 24,38 20,42" stroke={c} strokeWidth="1.5" fill="none"
          strokeLinecap="round" strokeLinejoin="round"/>
        <line x1="4" y1="52" x2="24" y2="52" stroke={c} strokeWidth="1.5" strokeLinecap="round"/>
        <polyline points="20,48 24,52 20,56" stroke={c} strokeWidth="1.5" fill="none"
          strokeLinecap="round" strokeLinejoin="round"/>
        <line x1="4" y1="66" x2="24" y2="66" stroke={c} strokeWidth="1.5" strokeLinecap="round"/>
        <polyline points="20,62 24,66 20,70" stroke={c} strokeWidth="1.5" fill="none"
          strokeLinecap="round" strokeLinejoin="round"/>
      </g>
      {/* Label */}
      <text x="4" y="100" fontSize="6"
        style={{ fill: c }} fontFamily="-apple-system,sans-serif" opacity="0.7">
        AeroDyn
      </text>
    </svg>
  );
}

// ── AeroDyn OutList variable groups ─────────────────────────────────────────
const AD_OUT_VARS = [
  { group: "Rotor Performance", vars: [
    { name:"RtAeroCp",  unit:"–",    desc:"Rotor aerodynamic power coefficient" },
    { name:"RtAeroCt",  unit:"–",    desc:"Rotor aerodynamic thrust coefficient" },
    { name:"RtAeroCq",  unit:"–",    desc:"Rotor aerodynamic torque coefficient" },
    { name:"RtAeroPwr", unit:"W",    desc:"Rotor aerodynamic power" },
    { name:"RtTSR",     unit:"–",    desc:"Rotor tip-speed ratio" },
  ]},
  { group: "Rotor Fluid Forces — hub frame", vars: [
    { name:"RtFldFxh",  unit:"N",    desc:"Rotor fluid force, hub x (downwind)" },
    { name:"RtFldFyh",  unit:"N",    desc:"Rotor fluid force, hub y (lateral)" },
    { name:"RtFldFzh",  unit:"N",    desc:"Rotor fluid force, hub z (upward)" },
    { name:"RtFldMxh",  unit:"N·m",  desc:"Rotor fluid moment, hub x (torque)" },
    { name:"RtFldMyh",  unit:"N·m",  desc:"Rotor fluid moment, hub y (tilt)" },
    { name:"RtFldMzh",  unit:"N·m",  desc:"Rotor fluid moment, hub z (yaw)" },
  ]},
  { group: "Wind at Rotor", vars: [
    { name:"RtVAvgxh",  unit:"m/s",  desc:"Average wind speed at rotor, hub x" },
    { name:"RtVAvgyh",  unit:"m/s",  desc:"Average wind speed at rotor, hub y" },
    { name:"RtVAvgzh",  unit:"m/s",  desc:"Average wind speed at rotor, hub z" },
    { name:"RtSkew",    unit:"deg",  desc:"Rotor inflow skew angle" },
  ]},
  { group: "Blade Summary (Blade 1)", vars: [
    { name:"B1N001Alpha", unit:"deg",  desc:"Blade 1 node 1 angle of attack" },
    { name:"B1N001Cl",    unit:"–",    desc:"Blade 1 node 1 lift coefficient" },
    { name:"B1N001Cd",    unit:"–",    desc:"Blade 1 node 1 drag coefficient" },
    { name:"B1N001Fn",    unit:"N/m",  desc:"Blade 1 node 1 normal force per unit span" },
    { name:"B1N001Ft",    unit:"N/m",  desc:"Blade 1 node 1 tangential force per unit span" },
    { name:"B1N001AxInd", unit:"–",    desc:"Blade 1 node 1 axial induction factor" },
    { name:"B1N001TnInd", unit:"–",    desc:"Blade 1 node 1 tangential induction factor" },
  ]},
  { group: "Tower Aerodynamics (optional)", vars: [
    { name:"TwN001VUndx", unit:"m/s",  desc:"Tower node 1 undisturbed wind, x" },
    { name:"TwN001VDisx", unit:"m/s",  desc:"Tower node 1 disturbed wind, x" },
    { name:"TwN001Vrel",  unit:"m/s",  desc:"Tower node 1 relative wind speed" },
    { name:"TwN001STVx",  unit:"m/s",  desc:"Tower node 1 structural velocity, x" },
    { name:"TwN001Fx",    unit:"N/m",  desc:"Tower node 1 aerodynamic force x" },
    { name:"TwN001Fy",    unit:"N/m",  desc:"Tower node 1 aerodynamic force y" },
  ]},
];

// ── AeroDyn OutListAD blade-station variable groups ──────────────────────────
const AD_NODE_VARS = [
  { group: "Angle of Attack & Kinematics", vars: [
    { name:"Alpha",   unit:"deg",   desc:"Angle of attack" },
    { name:"Vrel",    unit:"m/s",   desc:"Relative wind speed at section" },
    { name:"STVx",    unit:"m/s",   desc:"Structural velocity, rotor x" },
    { name:"STVy",    unit:"m/s",   desc:"Structural velocity, rotor y" },
    { name:"STVz",    unit:"m/s",   desc:"Structural velocity, rotor z" },
  ]},
  { group: "Wind Velocity at Section", vars: [
    { name:"VUndx",   unit:"m/s",   desc:"Undisturbed wind velocity, x" },
    { name:"VUndy",   unit:"m/s",   desc:"Undisturbed wind velocity, y" },
    { name:"VUndz",   unit:"m/s",   desc:"Undisturbed wind velocity, z" },
    { name:"VDisx",   unit:"m/s",   desc:"Disturbed wind velocity, x" },
    { name:"VDisy",   unit:"m/s",   desc:"Disturbed wind velocity, y" },
    { name:"VDisz",   unit:"m/s",   desc:"Disturbed wind velocity, z" },
  ]},
  { group: "Induction Factors", vars: [
    { name:"AxInd",   unit:"–",     desc:"Axial induction factor" },
    { name:"TnInd",   unit:"–",     desc:"Tangential induction factor" },
    { name:"Vindx",   unit:"m/s",   desc:"Induction velocity, x" },
    { name:"Vindy",   unit:"m/s",   desc:"Induction velocity, y" },
  ]},
  { group: "Aerodynamic Coefficients", vars: [
    { name:"Cl",      unit:"–",     desc:"Lift coefficient" },
    { name:"Cd",      unit:"–",     desc:"Drag coefficient" },
    { name:"Cm",      unit:"–",     desc:"Pitching moment coefficient" },
    { name:"Cn",      unit:"–",     desc:"Normal force coefficient" },
    { name:"Ct",      unit:"–",     desc:"Tangential force coefficient" },
    { name:"Cla",     unit:"–",     desc:"Attached flow lift coefficient" },
    { name:"Cda",     unit:"–",     desc:"Attached flow drag coefficient" },
    { name:"Cma",     unit:"–",     desc:"Attached flow moment coefficient" },
  ]},
  { group: "Forces Per Unit Span", vars: [
    { name:"Fn",      unit:"N/m",   desc:"Normal force per unit span (out-of-plane)" },
    { name:"Ft",      unit:"N/m",   desc:"Tangential force per unit span (in-plane)" },
    { name:"Fx",      unit:"N/m",   desc:"Force per unit span, global x" },
    { name:"Fy",      unit:"N/m",   desc:"Force per unit span, global y" },
    { name:"Fl",      unit:"N/m",   desc:"Lift force per unit span" },
    { name:"Fd",      unit:"N/m",   desc:"Drag force per unit span" },
    { name:"Mm",      unit:"N·m/m", desc:"Pitching moment per unit span" },
  ]},
  { group: "Dynamic & Turbulence", vars: [
    { name:"DynP",    unit:"Pa",    desc:"Dynamic pressure at section" },
    { name:"Re",      unit:"–",     desc:"Reynolds number × 10⁶" },
    { name:"M",       unit:"–",     desc:"Mach number" },
    { name:"Gamma",   unit:"m²/s",  desc:"Circulation (vortex strength)" },
  ]},
  { group: "B-L Unsteady State (UAMod≥2)", vars: [
    { name:"X1",      unit:"–",     desc:"B-L state variable X1" },
    { name:"X2",      unit:"–",     desc:"B-L state variable X2" },
    { name:"X3",      unit:"–",     desc:"B-L state variable X3 (HGM/5-state)" },
    { name:"X4",      unit:"–",     desc:"B-L state variable X4 (HGM/5-state)" },
    { name:"Cl_static", unit:"–",   desc:"Static lift coefficient" },
    { name:"Cd_static", unit:"–",   desc:"Static drag coefficient" },
  ]},
];

// ── Inline variable picker modal (same glass pattern as ElastoDyn) ───────────
function AdOutVarModal({ vars = AD_OUT_VARS, title = "Output variable picker", current = "", onClose, onApply }) {
  const [selected, setSelected] = useState(() => {
    const s = new Set();
    (current || "").split("\n").forEach(l => { const v = l.trim().replace(/"/g,""); if (v) s.add(v); });
    return s;
  });
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(false);
  const [collapsed, setCollapsed] = useState(new Set());

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const q = query.toLowerCase();
  const allFlat = vars.flatMap(g => g.vars.map(v => v.name));

  const toggleVar = (name) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };
  const toggleGroup = (group) => {
    const names = group.vars.map(v => v.name);
    const allOn = names.every(n => selected.has(n));
    setSelected(prev => {
      const next = new Set(prev);
      allOn ? names.forEach(n => next.delete(n)) : names.forEach(n => next.add(n));
      return next;
    });
  };
  const toggleCollapse = (g) => setCollapsed(prev => {
    const next = new Set(prev);
    next.has(g) ? next.delete(g) : next.add(g);
    return next;
  });

  const apply = () => {
    onApply([...selected].join("\n"));
    onClose();
  };

  return createPortal(
    <div className={`${s.modalOverlay} ${visible ? s.modalOverlayVisible : ""}`}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`${s.modal} ${visible ? s.modalVisible : ""}`}>
        <div className={s.modalHeader}>
          <span className={s.modalTitle}>{title}</span>
          <span className={s.modalCount}>{selected.size} selected</span>
          <button className={s.modalClose} onClick={onClose}>×</button>
        </div>
        <div className={s.modalSearch}>
          <div className={s.modalSearchBox}>
            <List size={12} style={{ color:"var(--tx-4)", flexShrink:0 }} />
            <input className={s.modalSearchInput} placeholder="Filter variables…"
              value={query} onChange={e => setQuery(e.target.value)} autoFocus />
          </div>
        </div>
        <div className={s.modalBody}>
          {vars.map(grp => {
            const filtered = q ? grp.vars.filter(v =>
              v.name.toLowerCase().includes(q) || v.desc.toLowerCase().includes(q)
            ) : grp.vars;
            if (!filtered.length) return null;
            const allOn  = filtered.every(v => selected.has(v.name));
            const someOn = !allOn && filtered.some(v => selected.has(v.name));
            const isOpen = !collapsed.has(grp.group);
            return (
              <div key={grp.group} className={s.varGroup}>
                <div className={s.varGroupHead} onClick={() => { if (!q) toggleCollapse(grp.group); }}>
                  <div
                    className={`${s.groupCheck} ${allOn ? s.groupCheckAll : someOn ? s.groupCheckSome : ""}`}
                    onClick={e => { e.stopPropagation(); toggleGroup(grp); }}>
                    {allOn && <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
                      <path d="M1 3.5L3.5 6L8 1" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>}
                    {someOn && <div style={{ width:6, height:6, borderRadius:1.5, background:"#BA7517" }} />}
                  </div>
                  <span style={{ flex:1 }}>{grp.group}</span>
                  <span className={s.varGroupCount}>{filtered.length}</span>
                  {!q && (isOpen
                    ? <ChevronDown  size={12} strokeWidth={2} style={{ color:"var(--tx-4)" }} />
                    : <ChevronRight size={12} strokeWidth={2} style={{ color:"var(--tx-4)" }} />)}
                </div>
                <div className={`${s.varGroupBody} ${(!isOpen && !q) ? s.varGroupBodyCollapsed : ""}`}>
                  <div className={s.varGroupInner}>
                    {filtered.map(v => (
                      <div key={v.name} className={`${s.varRow} ${selected.has(v.name) ? s.varRowOn : ""}`}
                        onClick={() => toggleVar(v.name)}>
                        <div className={s.varCheck}>
                          <svg className={s.varCheckMark} width="9" height="7" viewBox="0 0 9 7" fill="none">
                            <path d="M1 3.5L3.5 6L8 1" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </div>
                        <span className={s.varName}>{v.name}</span>
                        <span className={s.varDesc}>{v.desc}</span>
                        <span className={s.varUnit}>{v.unit}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
          {q && !vars.some(g => g.vars.some(v =>
            v.name.toLowerCase().includes(q) || v.desc.toLowerCase().includes(q)
          )) && <div className={s.varNoMatch}>No variables match "{query}"</div>}
        </div>
        <div className={s.modalFooter}>
          <button className={s.modalCancelBtn} onClick={onClose}>Cancel</button>
          <button className={s.modalApplyBtn} onClick={apply}>Apply {selected.size} variable{selected.size !== 1 ? "s" : ""}</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function AeroDynPanel({ onLog, project, filePathFromProject, onDirtyChange, onRegisterSave, simRunning = false }) {
  const [tab,      setTab]      = useState("quick");
  const tabDirRef = useRef(1);
  const [p,        _setP]       = useState(DEFAULT);
  const [filePath, setFilePath] = useState("");
  const [isDirtyFlag, setIsDirtyFlag] = useState(false);
  const [rawOpen,          setRawOpen]          = useState(false);
  const [showOutVarModal,  setShowOutVarModal]  = useState(false);
  const [showNodeVarModal, setShowNodeVarModal] = useState(false);
  const rawContent  = useRef("");
  const originalRef = useRef(null); // JSON snapshot of last loaded/saved state (ref = no race)

  // All user-driven field changes go through this wrapper.
  // setIsDirtyFlag(true) triggers a re-render; isDirty is then re-evaluated
  // against the updated p and the originalRef snapshot.
  const setP = useCallback((updater) => {
    _setP(updater);
    setIsDirtyFlag(true);
  }, []);

  // isDirty: file open  AND  user touched something  AND  snapshot exists + state differs.
  // Condition 3 ensures a brief isDirtyFlag=true during loading never produces a false positive.
  const isDirty = !!filePath && isDirtyFlag &&
    originalRef.current !== null && JSON.stringify(p) !== originalRef.current;

  // Detect UI fields that have no counterpart in the loaded file (showing defaults)
  const missingFields = useMemo(() => {
    if (!filePath || !p.__rawKV__) return [];
    const rawKeys = new Set(Object.keys(p.__rawKV__));
    // Expand "Key(N)" → "KeyN" for blade file alias pattern
    for (const k of [...rawKeys]) {
      const m = k.match(/^([A-Za-z_]+)\((\d+)\)$/);
      if (m) rawKeys.add(`${m[1]}${m[2]}`);
    }
    // ── Suppress known false positives caused by renamed parameters in newer OpenFAST ──
    // Files using the underscored (v15.03+) naming don't include the old names.
    // When a covered alias is present, treat the corresponding DEFAULT key as satisfied.
    if (rawKeys.has("UA_Mod") || rawKeys.has("UAMod")) rawKeys.add("AFAeroMod");
    if (rawKeys.has("DBEMT_Mod"))                      rawKeys.add("FrozenWake");
    if (rawKeys.has("Skew_Mod") || rawKeys.has("SkewMod")) rawKeys.add("SkewModFactor");

    return Object.keys(DEFAULT).filter(k => {
      if (k.startsWith("__")) return false;
      if (NO_UI_FIELDS.has(k)) return false;  // no UI control for these — never flag
      if (typeof DEFAULT[k] === "string" && DEFAULT[k].includes("\n")) return false;
      return !rawKeys.has(k);
    });
  }, [filePath, p.__rawKV__]);

  // Revert detection: clear the dirty flag when state matches the saved snapshot exactly.
  useEffect(() => {
    if (!isDirtyFlag || originalRef.current === null) return;
    if (JSON.stringify(p) === originalRef.current) {
      setIsDirtyFlag(false);
    }
  }, [p, isDirtyFlag]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = useCallback((key, val) => {
    setP(prev => ({ ...prev, [key]: val }));
  }, []);

  // ── Core file loader (used by handleOpen and auto-load effect) ───────────────
  // Writes snapshot to a ref first (synchronous) so isDirty can never be a
  // false-positive between the _setP and setIsDirtyFlag(false) state updates.
  const loadFileFromPath = useCallback(async (path) => {
    try {
      const content = await invoke("read_text_file", { path });
      rawContent.current = content;
      const kv = parseAeroDynFile(content);
      const parsed = adParsedToState(kv);
      originalRef.current = JSON.stringify(parsed); // synchronous snapshot
      _setP(parsed);
      setIsDirtyFlag(false);
      setFilePath(path);
      onLog?.("ok", `Loaded ${path.split("/").pop()}`);
    } catch (e) {
      onLog?.("error", String(e));
    }
  }, [onLog]);

  // ── Open .dat (user-initiated via Browse button) ───────────────────────────
  const handleOpen = async () => {
    try {
      const f = await openDialog({
        multiple: false,
        filters: [{ name: "AeroDyn", extensions: ["dat","inp","txt"] }],
      });
      if (!f) return;
      await loadFileFromPath(f);
    } catch (e) {
      onLog?.("error", String(e));
    }
  };

  // ── Save ───────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (simRunning) { onLog?.("warn", "⚠ OpenFAST is running — save blocked to protect the active simulation."); return; }
    if (!filePath) return;
    try {
      const content = buildAeroDynContent(p);
      await invoke("write_text_file", { path: filePath, content });
      originalRef.current = JSON.stringify(p); // advance snapshot to what was written
      setIsDirtyFlag(false);
      onLog?.("info", `Saved ${filePath.split("/").pop()}`);
    } catch (e) {
      onLog?.("error", String(e));
    }
  }, [filePath, p, onLog]);

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  // ── Project integration effects ────────────────────────────────────────────
  // Auto-load when App.jsx detects this panel's file from an imported .fst.
  // loadFileFromPath intentionally omitted from deps — we only want to re-trigger
  // when the path itself changes, not when the callback reference changes.
  useEffect(() => {
    if (!filePathFromProject) return;
    loadFileFromPath(filePathFromProject);
  }, [filePathFromProject]); // eslint-disable-line react-hooks/exhaustive-deps

  // Propagate dirty state up.
  // onDirtyChange omitted from deps — it is guaranteed stable (useCallback in App.jsx).
  // Including it would cause a render loop if it were ever recreated.
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty]); // eslint-disable-line react-hooks/exhaustive-deps

  // Register the current save function so App.jsx can call it from the dialog.
  // onRegisterSave omitted — stable by construction.
  useEffect(() => {
    onRegisterSave?.(handleSave);
  }, [handleSave]); // eslint-disable-line react-hooks/exhaustive-deps

  const wakeName = ["None","BEMT","DBEMT","OLAF"][p.WakeMod] ?? "–";
  const aeroName = p.AFAeroMod === 1 ? "Steady" : "B-L Unsteady";
  const afCount  = (p.AFNames || "").split("\n").filter(l => l.trim()).length;

  // ── Tabs content ──────────────────────────────────────────────────────────
  const renderQuick = () => (
    <div className={`${s.form} ${s.tabEnterFirst}`}>
      <div className={s.callout}>
        Most-used aerodynamic settings for day-to-day simulations — full control on other tabs.
      </div>

      <SectionHead>Wake &amp; Aero Models</SectionHead>
      <div className={s.grid2}>
        <Field label="Wake / Induction model (WakeMod)"
          info={{ param: "WakeMod", desc: "Type of wake/induction model used in the aerodynamic solver.", range: "0–3", default: "1 (BEMT)", note: "0=None · 1=BEMT (industry standard) · 2=DBEMT (dynamic inflow effects) · 3=OLAF free-vortex (high-fidelity, slow)" }}>
          <select className={s.select} value={p.WakeMod} onChange={e => set("WakeMod", Number(e.target.value))}>
            {WAKE_MODES.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="Airfoil aerodynamics (AFAeroMod)"
          info={{ param: "AFAeroMod", desc: "Blade airfoil aerodynamics model. Steady = fast; Beddoes-Leishman = unsteady dynamic stall.", range: "1 or 2", default: "2", note: "Use AFAeroMod=1 for linearisation / modal analysis. Use 2 for all load/fatigue DLCs." }}>
          <select className={s.select} value={p.AFAeroMod} onChange={e => set("AFAeroMod", Number(e.target.value))}>
            {AF_AERO_MODES.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="Time step DTAero" unit="s"
          info={{ param: "DTAero", desc: 'Aerodynamic calculation time step. "default" equals the OpenFAST DT.', default: '"default"', unit: "s or \"default\"", note: "Can be set smaller than DT for better BEM convergence at high TSR, e.g. DTAero = DT/2." }}>
          <input className={s.inp} value={p.DTAero}
            onChange={e => set("DTAero", e.target.value)} placeholder='"default"' />
        </Field>
        <Field label="B-L Unsteady model (UAMod)"
          info={{ param: "UAMod", desc: "Beddoes-Leishman dynamic stall model variant. Only active when AFAeroMod = 2.", range: "2–7", default: "3 (Minnema/Pierce)", note: "UAMod=4 (HGM 4-state) is the most physically accurate and recommended for IEA 15 MW. UAMod=3 is more numerically robust." }}>
          <select className={s.select} value={p.UAMod} onChange={e => set("UAMod", Number(e.target.value))}>
            {UA_MODES.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
          </select>
        </Field>
      </div>

      <SectionHead>Key Flags</SectionHead>
      <div className={s.toggleGrid}>
        <Toggle label="Tip loss (TipLoss)"
          value={p.TipLoss} onChange={v => set("TipLoss", v)}
          note="Prandtl tip-loss model — almost always True" />
        <Toggle label="Hub loss (HubLoss)"
          value={p.HubLoss} onChange={v => set("HubLoss", v)}
          note="Prandtl hub-loss model" />
        <Toggle label="Tower aerodynamic loads (TwrAero)"
          value={p.TwrAero} onChange={v => set("TwrAero", v)}
          note="Required for tower fatigue loads" />
        <Toggle label="Tangential induction (TanInd)"
          value={p.TanInd} onChange={v => set("TanInd", v)}
          note="Include Cθ in BEMT loop" />
      </div>

      <SectionHead>Blade Files</SectionHead>
      <FileTriple
        label="Blade aerodynamic property files (ADBlFile)"
        keys={["ADBlFile1","ADBlFile2","ADBlFile3"]}
        p={p} setP={setP}
      />
    </div>
  );

  const renderGeneral = () => (
    <div className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
      <SectionHead>General Options</SectionHead>
      <div className={s.grid2}>
        <SelField label="Wake / Induction" value={p.WakeMod} onChange={v => set("WakeMod", v)}
          options={WAKE_MODES}
          hint="0=None, 1=BEMT, 2=DBEMT, 3=OLAF" />
        <SelField label="Airfoil Aerodynamics" value={p.AFAeroMod} onChange={v => set("AFAeroMod", v)}
          options={AF_AERO_MODES}
          hint="1=Steady, 2=Beddoes-Leishman" />
        <Field label="Time step DTAero" unit="s">
          <input className={s.inp} value={p.DTAero} onChange={e => set("DTAero", e.target.value)}
            placeholder='"default"' />
        </Field>
      </div>

      <SectionHead>Tower Effects</SectionHead>
      <div className={s.grid2}>
        <SelField label="Tower Potential Flow" value={p.TwrPotent} onChange={v => set("TwrPotent", v)}
          options={TWR_POTENT_MODES}
          hint="Upstream potential-flow influence" />
        <SelField label="Tower Shadow" value={p.TwrShadow} onChange={v => set("TwrShadow", v)}
          options={TWR_SHADOW_MODES}
          hint="Downstream wake shadow model" />
      </div>
      <div className={s.toggleGrid}>
        <Toggle label="Tower aerodynamic loads (TwrAero)" value={p.TwrAero}     onChange={v => set("TwrAero", v)} />
      </div>

      <SectionHead>Flags</SectionHead>
      <div className={s.toggleGrid}>
        <Toggle label="Frozen wake during linearization (FrozenWake)" value={p.FrozenWake}  onChange={v => set("FrozenWake", v)}  note="WakeMod=1 only" />
        <Toggle label="Cavitation check (CavitCheck)"  value={p.CavitCheck} onChange={v => set("CavitCheck", v)} note="requires AFAeroMod=1" />
        <Toggle label="Buoyancy effects (Buoyancy)"    value={p.Buoyancy}   onChange={v => set("Buoyancy", v)} />
        <Toggle label="Aero-acoustics (CompAA)"        value={p.CompAA}     onChange={v => set("CompAA", v)}   note="WakeMod=1 or 2" />
        <Toggle label="Echo input to .ech file (Echo)" value={p.Echo}       onChange={v => set("Echo", v)} />
      </div>
      <Field label="Aero-acoustics input file (AA_InputFile)"
        disabledHint={!p.CompAA ? "Enable CompAA to specify an aero-acoustics input file" : undefined}>
        <div className={s.fileRow}>
          <input className={s.inp} value={p.AA_InputFile} disabled={!p.CompAA}
            onChange={e => set("AA_InputFile", e.target.value)} />
          <button className={s.browseBtn} type="button" disabled={!p.CompAA}
            onClick={async () => {
              const f = await openDialog({ multiple: false });
              if (f) set("AA_InputFile", f);
            }}>
            <FolderOpen size={12} strokeWidth={1.8} />
          </button>
        </div>
      </Field>

      <Collapsible title="Environment (usually 'default')">
        <div className={s.grid2}>
          {[
            ["AirDens","Air density","kg/m³",  undefined],
            ["KinVisc","Kinematic viscosity","m²/s", undefined],
            ["SpdSound","Speed of sound","m/s", undefined],
            ["Patm","Atmospheric pressure","Pa", !p.CavitCheck ? "Enable CavitCheck to use Patm" : undefined],
            ["Pvap","Vapour pressure","Pa",       !p.CavitCheck ? "Enable CavitCheck to use Pvap" : undefined],
          ].map(([k, lbl, unit, hint]) => (
            <Field key={k} label={lbl} unit={unit} disabledHint={hint}>
              <input className={s.inp} value={p[k]} disabled={!!hint}
                onChange={e => set(k, e.target.value)} placeholder='"default"' />
            </Field>
          ))}
        </div>
      </Collapsible>

      <Collapsible title="Tail fin aerodynamics">
        <div className={s.toggleGrid}>
          <Toggle label="Calculate tail fin aerodynamics (TFinAero)" value={p.TFinAero} onChange={v => set("TFinAero", v)} />
        </div>
        <Field label="Tail fin input file (TFinFile)"
          disabledHint={!p.TFinAero ? "Enable TFinAero to specify a tail fin input file" : undefined}>
          <div className={s.fileRow}>
            <input className={s.inp} value={p.TFinFile} disabled={!p.TFinAero}
              onChange={e => set("TFinFile", e.target.value)} />
            <button className={s.browseBtn} type="button" disabled={!p.TFinAero}
              onClick={async () => {
                const f = await openDialog({ multiple: false });
                if (f) set("TFinFile", f);
              }}>
              <FolderOpen size={12} strokeWidth={1.8} />
            </button>
          </div>
        </Field>
      </Collapsible>
    </div>
  );

  const renderModels = () => (
    <div className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
      <div className={s.callout}>
        ⚡ Active: <strong style={{ marginLeft: 4 }}>{wakeName}</strong>&nbsp;wake model,&nbsp;
        <strong>{aeroName}</strong>&nbsp;aerodynamics.
        Sections below only apply when the relevant model is active.
      </div>

      <SectionHead>BEMT Options — WakeMod = 1 or 2</SectionHead>
      {(p.WakeMod === 0 || p.WakeMod === 3) && (
        <p className={s.hint} style={{ color:"var(--tx-4)", fontStyle:"italic" }}>
          Set WakeMod = 1 (BEMT) or 2 (DBEMT) to activate these options.
        </p>
      )}
      <div className={s.grid2}>
        <SelField label="Skewed-wake correction" value={p.SkewMod} onChange={v => set("SkewMod", v)}
          options={[{v:1,label:"1 – Uncoupled"},{v:2,label:"2 – Pitt/Peters"},{v:3,label:"3 – Coupled"}]}
          disabledHint={(p.WakeMod === 0 || p.WakeMod === 3) ? "Only active when WakeMod = 1 or 2" : undefined} />
        <Field label="Skew factor (SkewModFactor)"
          disabledHint={(p.WakeMod === 0 || p.WakeMod === 3) ? "Only active when WakeMod = 1 or 2" : undefined}>
          <input className={s.inp} value={p.SkewModFactor} onChange={e => set("SkewModFactor", e.target.value)}
            disabled={p.WakeMod === 0 || p.WakeMod === 3} placeholder='"default" = 15/32·π' />
        </Field>
        <Field label="BEMT convergence tolerance (IndToler)"
          disabledHint={(p.WakeMod === 0 || p.WakeMod === 3) ? "Only active when WakeMod = 1 or 2" : undefined}>
          <input className={s.inp} value={p.IndToler} onChange={e => set("IndToler", e.target.value)}
            disabled={p.WakeMod === 0 || p.WakeMod === 3} placeholder='"default"' />
        </Field>
        <Field label="Max iterations (MaxIter)"
          disabledHint={(p.WakeMod === 0 || p.WakeMod === 3) ? "Only active when WakeMod = 1 or 2" : undefined}>
          <input className={s.inp} value={p.MaxIter}
            disabled={p.WakeMod === 0 || p.WakeMod === 3}
            onChange={e => set("MaxIter", parseInt(e.target.value) || p.MaxIter)} />
        </Field>
      </div>
      <div className={s.toggleGrid}>
        <Toggle label="Prandtl tip-loss (TipLoss)"             value={p.TipLoss} onChange={v => set("TipLoss", v)} />
        <Toggle label="Prandtl hub-loss (HubLoss)"             value={p.HubLoss} onChange={v => set("HubLoss", v)} />
        <Toggle label="Tangential induction (TanInd)"          value={p.TanInd}  onChange={v => set("TanInd", v)} />
        <Toggle label="Drag in axial induction (AIDrag)"       value={p.AIDrag}  onChange={v => set("AIDrag", v)} />
        <Toggle label="Drag in tangential induction (TIDrag)"  value={p.TIDrag}  onChange={v => set("TIDrag", v)} />
      </div>

      <SectionHead>DBEMT Options — WakeMod = 2</SectionHead>
      {p.WakeMod !== 2 && (
        <p className={s.hint} style={{ color:"var(--tx-4)", fontStyle:"italic" }}>
          Set WakeMod = 2 (DBEMT) to activate dynamic wake options.
        </p>
      )}
      <div className={s.grid2}>
        <SelField label="DBEMT model (DBEMT_Mod)" value={p.DBEMT_Mod}
          onChange={v => set("DBEMT_Mod", v)} options={DBEMT_MODES}
          disabledHint={p.WakeMod !== 2 ? "Only active when WakeMod = 2 (DBEMT)" : undefined} />
        <Field label="τ₁ constant (tau1_const)" unit="s"
          hint="Used when DBEMT_Mod = 1 or 3"
          disabledHint={p.WakeMod !== 2 ? "Only active when WakeMod = 2 (DBEMT)" :
                        (p.DBEMT_Mod === 0 || p.DBEMT_Mod === 2) ? "Only used when DBEMT_Mod = 1 or 3" : undefined}>
          <input className={s.inp} value={p.tau1_const}
            disabled={p.WakeMod !== 2 || p.DBEMT_Mod === 0 || p.DBEMT_Mod === 2}
            onChange={e => set("tau1_const", parseFloat(e.target.value) || p.tau1_const)} />
        </Field>
      </div>

      <SectionHead>OLAF Free-Vortex Wake — WakeMod = 3</SectionHead>
      {p.WakeMod !== 3 && (
        <p className={s.hint} style={{ color:"var(--tx-4)", fontStyle:"italic" }}>
          Set WakeMod = 3 (OLAF) to activate the free-vortex wake model.
        </p>
      )}
      <Field label="OLAF input file (OLAFInputFileName)"
        disabledHint={p.WakeMod !== 3 ? "Only active when WakeMod = 3 (OLAF)" : undefined}>
        <div className={s.fileRow}>
          <input className={s.inp} value={p.OLAFInputFileName} disabled={p.WakeMod !== 3}
            onChange={e => set("OLAFInputFileName", e.target.value)} />
          <button className={s.browseBtn} type="button" disabled={p.WakeMod !== 3}
            onClick={async () => {
              const f = await openDialog({ multiple: false });
              if (f) set("OLAFInputFileName", f);
            }}>
            <FolderOpen size={12} strokeWidth={1.8} />
          </button>
        </div>
      </Field>

      <SectionHead>Beddoes-Leishman Unsteady — AFAeroMod = 2</SectionHead>
      {p.AFAeroMod !== 2 && (
        <p className={s.hint} style={{ color:"var(--tx-4)", fontStyle:"italic" }}>
          Set AFAeroMod = 2 (B-L Unsteady) in Quick or General tab to activate these options.
        </p>
      )}
      <div className={s.grid2}>
        <SelField label="Unsteady aero model (UAMod)" value={p.UAMod}
          onChange={v => set("UAMod", v)} options={UA_MODES}
          disabledHint={p.AFAeroMod !== 2 ? "Only active when AFAeroMod = 2 (B-L Unsteady)" : undefined} />
        <Field label="UA start radius (UAStartRad)" unit="R" hint="Fraction of rotor radius"
          disabledHint={p.AFAeroMod !== 2 ? "Only active when AFAeroMod = 2 (B-L Unsteady)" : undefined}>
          <input className={s.inp} value={p.UAStartRad} disabled={p.AFAeroMod !== 2}
            onChange={e => set("UAStartRad", parseFloat(e.target.value) || p.UAStartRad)} />
        </Field>
        <Field label="UA end radius (UAEndRad)" unit="R"
          disabledHint={p.AFAeroMod !== 2 ? "Only active when AFAeroMod = 2 (B-L Unsteady)" : undefined}>
          <input className={s.inp} value={p.UAEndRad} disabled={p.AFAeroMod !== 2}
            onChange={e => set("UAEndRad", parseFloat(e.target.value) || p.UAEndRad)} />
        </Field>
      </div>
      <div className={s.toggleGrid}>
        <Toggle label="f' lookup table (FLookup)" value={p.FLookup} onChange={v => set("FLookup", v)}
          note={p.AFAeroMod !== 2 ? "Requires AFAeroMod = 2" : "FALSE → use S1–S4 from airfoil files"} />
      </div>
    </div>
  );

  const renderBlades = () => (
    <div className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
      <SectionHead>Blade Aerodynamic Property Files</SectionHead>
      <div className={s.toggleGrid} style={{ marginBottom: 16 }}>
        <Toggle label="Include aerodynamic pitching moment (UseBlCm)" value={p.UseBlCm}
          onChange={v => set("UseBlCm", v)} />
      </div>
      <FileTriple
        label="Blade .dat files (ADBlFile)"
        keys={["ADBlFile1","ADBlFile2","ADBlFile3"]}
        p={p} setP={setP}
      />

      <SectionHead>Airfoil Tables</SectionHead>
      <div className={s.grid2}>
        <SelField label="Table interpolation (AFTabMod)" value={p.AFTabMod}
          onChange={v => set("AFTabMod", v)} options={AFTAB_MODES} />
        <Field label="NumAFfiles">
          <input className={s.inp} value={p.NumAFfiles}
            onChange={e => {
              const v = parseInt(e.target.value) || p.NumAFfiles;
              set("NumAFfiles", v);
            }} />
        </Field>
      </div>

      <Collapsible title="Column indices" defaultOpen={false}>
        <div className={s.grid3}>
          {[
            ["InCol_Alfa","AoA column"],
            ["InCol_Cl","Cl column"],
            ["InCol_Cd","Cd column"],
            ["InCol_Cm","Cm column (0=none)"],
            ["InCol_Cpmin","Cpmin column (0=none)"],
          ].map(([k, lbl]) => (
            <Field key={k} label={lbl}>
              <input className={s.inp} value={p[k]}
                onChange={e => set(k, parseInt(e.target.value) ?? p[k])} />
            </Field>
          ))}
        </div>
      </Collapsible>

      <Field label="Airfoil file paths (AFNames)" hint="One path per line — order must match blade table station indices">
        <textarea
          className={s.outListArea}
          value={p.AFNames}
          onChange={e => set("AFNames", e.target.value)}
          rows={Math.max(6, afCount + 1)}
          placeholder="path/to/Cylinder1.dat&#10;path/to/DU40_A17.dat&#10;..."
        />
      </Field>

      <Collapsible title="Buoyancy properties (only when Buoyancy=True)">
        <div className={s.grid2}>
          <Field label="Hub volume (VolHub)" unit="m³">
            <input className={s.inp} value={p.VolHub}
              onChange={e => set("VolHub", parseFloat(e.target.value) || 0)} />
          </Field>
          <Field label="Hub buoyancy x-offset (HubCenBx)" unit="m">
            <input className={s.inp} value={p.HubCenBx}
              onChange={e => set("HubCenBx", parseFloat(e.target.value) || 0)} />
          </Field>
          <Field label="Nacelle volume (VolNac)" unit="m³">
            <input className={s.inp} value={p.VolNac}
              onChange={e => set("VolNac", parseFloat(e.target.value) || 0)} />
          </Field>
          <Field label="Nacelle CoB (NacCenB)" unit="m" hint="x,y,z from yaw bearing">
            <input className={s.inp} value={p.NacCenB}
              onChange={e => set("NacCenB", e.target.value)} />
          </Field>
        </div>
      </Collapsible>
    </div>
  );

  const renderOutput = () => (
    <div className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
      <SectionHead>Tower Definition</SectionHead>
      <div className={s.grid1}>
        <Field label="Number of tower nodes (NumTwrNds)">
          <input className={s.inp} value={p.NumTwrNds}
            onChange={e => set("NumTwrNds", parseInt(e.target.value) || p.NumTwrNds)} />
        </Field>
      </div>
      <Field label="Tower properties table"
        hint="Columns: TwrElev (m), TwrDiam (m), TwrCd (−), TwrTI (−), TwrCb (−). Edit directly or import a .dat file.">
        <textarea
          className={s.outListArea}
          style={{ minHeight: 200, fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: 11 }}
          value={p.TowerTable}
          onChange={e => set("TowerTable", e.target.value)}
        />
      </Field>

      <SectionHead>Output Settings</SectionHead>
      <div className={s.toggleGrid}>
        <Toggle label="Generate summary file (SumPrint)" value={p.SumPrint}
          onChange={v => set("SumPrint", v)} />
      </div>
      <div className={s.grid2}>
        <Field label="# blade node outputs (NBlOuts)" hint="0–9">
          <input className={s.inp} value={p.NBlOuts}
            onChange={e => set("NBlOuts", parseInt(e.target.value) || 0)} />
        </Field>
        <Field label="Blade output nodes (BlOutNd)"
          disabledHint={p.NBlOuts === 0 ? "Set NBlOuts ≥ 1 to specify blade output node indices" : undefined}>
          <input className={s.inp} value={p.BlOutNd} disabled={p.NBlOuts === 0}
            onChange={e => set("BlOutNd", e.target.value)} />
        </Field>
        <Field label="# tower node outputs (NTwOuts)" hint="0–9">
          <input className={s.inp} value={p.NTwOuts}
            onChange={e => set("NTwOuts", parseInt(e.target.value) || 0)} />
        </Field>
        <Field label="Tower output nodes (TwOutNd)"
          disabledHint={p.NTwOuts === 0 ? "Set NTwOuts ≥ 1 to specify tower output node indices" : undefined}>
          <input className={s.inp} value={p.TwOutNd} disabled={p.NTwOuts === 0}
            onChange={e => set("TwOutNd", e.target.value)} />
        </Field>
      </div>

      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6, marginTop:12 }}>
        <span style={{ fontSize:12, fontWeight:600, color:"var(--tx-2)" }}>OutList — rotor/blade/tower channel names</span>
        <button type="button" className={s.pickVarsBtn} onClick={() => setShowOutVarModal(true)}>
          <List size={11} /> Pick variables
        </button>
      </div>
      <p style={{ margin:"0 0 6px", fontSize:11.5, color:"var(--tx-4)" }}>One channel per line. Quotes added automatically on save.</p>
      <textarea className={s.outListArea}
        value={p.OutList}
        onChange={e => set("OutList", e.target.value)}
        spellCheck={false} />
      {showOutVarModal && (
        <AdOutVarModal
          vars={AD_OUT_VARS}
          title="AeroDyn output variable picker"
          current={p.OutList}
          onClose={() => setShowOutVarModal(false)}
          onApply={outList => set("OutList", outList)}
        />
      )}

      <SectionHead>Blade-node detailed output (OutListAD)</SectionHead>
      <p className={s.hint}>
        Per-station blade aerodynamic channels (e.g. Alpha, Cl, Fn). Requires BldNd_BladesOut ≥ 1.
      </p>
      <div className={s.grid2}>
        <Field label="Blades to output (BldNd_BladesOut)" hint="0 = disabled; 1–3 = blades to include" fieldKey="BldNd_BladesOut">
          <input className={s.inp} type="number" min={0} max={3} step={1}
            value={p.BldNd_BladesOut ?? 0}
            onChange={e => set("BldNd_BladesOut", parseInt(e.target.value) || 0)} />
        </Field>
        <Field label="Node indices (BldNd_BlOutNd)" hint={'"All" or space-separated node numbers'} fieldKey="BldNd_BlOutNd"
          disabledHint={(p.BldNd_BladesOut ?? 0) === 0 ? "Set BldNd_BladesOut ≥ 1 to select which blade nodes to output" : undefined}>
          <input className={s.inp} value={p.BldNd_BlOutNd ?? "All"}
            disabled={(p.BldNd_BladesOut ?? 0) === 0}
            onChange={e => set("BldNd_BlOutNd", e.target.value)} />
        </Field>
      </div>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6, marginTop:10 }}>
        <span style={{ fontSize:12, fontWeight:600, color:"var(--tx-2)" }}>OutListAD — blade-station channel names</span>
        <button type="button" className={s.pickVarsBtn}
          disabled={(p.BldNd_BladesOut ?? 0) === 0}
          style={{ opacity:(p.BldNd_BladesOut ?? 0) === 0 ? 0.35 : 1, cursor:(p.BldNd_BladesOut ?? 0) === 0 ? "not-allowed" : "pointer" }}
          onClick={() => (p.BldNd_BladesOut ?? 0) > 0 && setShowNodeVarModal(true)}>
          <List size={11} /> Pick blade-station vars
        </button>
      </div>
      <p style={{ margin:"0 0 6px", fontSize:11.5, color:"var(--tx-4)" }}>Blade-station aerodynamic outputs (Alpha, Cl, Fn, Fx, etc.). One per line.</p>
      <textarea className={s.outListArea}
        value={p.OutListAD}
        disabled={(p.BldNd_BladesOut ?? 0) === 0}
        onChange={e => set("OutListAD", e.target.value)}
        spellCheck={false}
        placeholder={(p.BldNd_BladesOut ?? 0) === 0 ? "Set BldNd_BladesOut ≥ 1 to enable blade-station outputs" : ""} />
      {showNodeVarModal && (
        <AdOutVarModal
          vars={AD_NODE_VARS}
          title="Blade-station variable picker"
          current={p.OutListAD}
          onClose={() => setShowNodeVarModal(false)}
          onApply={outList => set("OutListAD", outList)}
        />
      )}
    </div>
  );

  return (
    <div className={s.panel}>
      {/* Header */}
      <div className={s.header}>
        <Zap size={16} strokeWidth={1.8} style={{ color: ACCENT }} />
        <h1 className={s.title}>AeroDyn</h1>
        <span className={s.desc}>Aerodynamic loads</span>
        <span className={s.badge} style={{ background: "rgba(186,117,23,0.12)", color: "#BA7517" }}>v15</span>
        <span className={s.badge}>sub-module</span>
        <div style={{ flex: 1 }} />
        <button className={`${s.headerBtn} ${s.headerBtnPrimary}`} onClick={handleOpen} type="button">
          <FolderOpen size={12} strokeWidth={2} /> Open .dat
        </button>
        <button className={`${s.headerBtn} ${s.headerBtnSecondary}`} type="button"
          onClick={async () => {
            if (!filePath) {
              onLog?.("warn", "Load or save the AeroDyn file first — then View will show the actual file on disk.");
              return;
            }
            try {
              rawContent.current = await invoke("read_text_file", { path: filePath });
              setRawOpen(true);
            } catch (err) { onLog?.("error", `Cannot read file: ${err}`); }
          }}>
          <Eye size={12} strokeWidth={2} /> View .dat
        </button>
      </div>

      {/* File bar */}
      <div className={[s.fileBar, filePath ? s.fileBarLoaded : ""].join(" ")}>
        <span className={[s.filePath, filePath ? s.filePathSet : ""].join(" ")}>
          {filePath || "No file — editing defaults (NREL 5 MW)"}
        </span>
        <span className={s.dirtyDot} style={{ opacity: isDirty ? 1 : 0 }} />
        <button className={[s.saveBtn, (!isDirty || simRunning) ? s.saveBtnInactive : ""].join(" ")}
          onClick={(!isDirty || simRunning) ? undefined : handleSave}
          type="button" title={simRunning ? "OpenFAST is running — save blocked" : "Save (⌘S)"}>
          <Save size={11} strokeWidth={2} /> Save
        </button>
      </div>

      {simRunning && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "7px 18px",
          background: "rgba(217,119,6,0.10)",
          borderBottom: "0.5px solid rgba(217,119,6,0.28)",
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 13 }}>⚠</span>
          <span style={{ fontSize: 12, fontWeight: 500, color: "#92400E" }}>
            OpenFAST is running — saving is disabled to protect the active simulation
          </span>
        </div>
      )}

      {/* Tab bar */}
      <div className={s.tabBar}>
        {TABS.map(t => (
          <button key={t.id}
            className={[s.tab, tab === t.id ? s.tabActive : ""].join(" ")}
            onClick={() => {
              const oldIdx = TABS.findIndex(x => x.id === tab);
              const newIdx = TABS.findIndex(x => x.id === t.id);
              tabDirRef.current = newIdx >= oldIdx ? 1 : -1;
              setTab(t.id);
            }} type="button">
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Missing-fields banner ─────────────────────────── */}
      {missingFields.length > 0 && (
        <div className={s.absentBanner}>
          <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            <strong>{missingFields.length} parameter{missingFields.length > 1 ? "s" : ""}</strong>
            {" "}not found in this file — showing model defaults.{" "}
            <span className={s.absentList}>
              {missingFields.slice(0, 10).map((f, i) => (
                <span key={f}>
                  {i > 0 && <span style={{ opacity: 0.5 }}> · </span>}
                  {FIELD_TAB[f] ? (
                    <button
                      className={s.absentFieldBtn}
                      onClick={() => setTab(FIELD_TAB[f])}
                      title={`Jump to ${FIELD_TAB[f]} tab`}
                    >{f}</button>
                  ) : f}
                </span>
              ))}
              {missingFields.length > 10 && <span style={{ opacity: 0.5 }}> · +{missingFields.length - 10} more</span>}
            </span>
          </span>
        </div>
      )}

      {/* Content */}
      <div className={s.contentRow}>
        <div className={s.formArea}>
          <MissingCtx.Provider value={new Set(missingFields)}>
            {tab === "quick"   && renderQuick()}
            {tab === "general" && renderGeneral()}
            {tab === "models"  && renderModels()}
            {tab === "blades"  && renderBlades()}
            {tab === "output"  && renderOutput()}
          </MissingCtx.Provider>
        </div>

        {/* Stats panel */}
        <div className={s.statsPanel}>
          <p className={s.statsLabel}>Quick stats</p>
          <div className={s.turbineWrap}>
            <TurbineSchematic />
          </div>
          <div className={s.statsGrid}>
            {[
              ["Wake model",  wakeName],
              ["Aero model",  aeroName],
              ["# AF files",  afCount || p.NumAFfiles],
              ["# Twr nodes", p.NumTwrNds],
              ["Tip loss",    p.TipLoss ? "On" : "Off"],
              ["Hub loss",    p.HubLoss ? "On" : "Off"],
              ["Twr aero",    p.TwrAero ? "On" : "Off"],
              ["Twr shadow",  ["None","Powles","Eames"][p.TwrShadow] ?? "–"],
              ["UseBlCm",     p.UseBlCm ? "Yes" : "No"],
              ["Cavit. chk",  p.CavitCheck ? "On" : "Off"],
              ["Buoyancy",    p.Buoyancy ? "On" : "Off"],
            ].map(([k, v]) => (
              <div key={k} className={s.statCard}>
                <span className={s.statKey}>{k}</span>
                <span className={s.statVal}>{String(v)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {rawOpen && (
        <RawFileModal
          content={rawContent.current}
          filename={filePath ? filePath.split("/").pop() : "AeroDyn.dat"}
          fromDisk={!!filePath}
          hasDirtyWarning={isDirty}
          filePath={filePath}
          onSaved={(newContent) => { rawContent.current = newContent; loadFileFromPath(filePath); }}
          onClose={() => setRawOpen(false)}
        />
      )}
    </div>
  );
}
