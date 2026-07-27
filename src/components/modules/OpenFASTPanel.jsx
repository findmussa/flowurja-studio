import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Gauge, FolderOpen, Eye, Play, Square, ChevronDown, ChevronRight, Wind, Save, AlertTriangle,
} from "lucide-react";
import RawFileModal from "../RawFileModal";
// BinaryRow removed from dashboard — binary config lives in Settings (⚙)
import InfoPopover from "../InfoPopover";
import { toast } from "sonner";
import { useBinarySettings } from "../../hooks/useBinarySettings";
import s from "./OpenFASTPanel.module.css";

// ── Constants ─────────────────────────────────────────────────────────────────
const TABS = [
  { id: "run",        label: "Dashboard"  },
  { id: "simulation", label: "Simulation" },
  { id: "modules",    label: "Modules"    },
  { id: "output",     label: "Output"     },
  { id: "linearize",  label: "Linearize"  },
];

const COMP_ELAST   = ["None", "ElastoDyn", "ElastoDyn + BeamDyn", "Simplified ElastoDyn"];
const COMP_INFLOW  = ["None", "InflowWind", "ExtInflow"];
const COMP_AERO    = ["None", "AeroDisk", "AeroDyn", "ExtLoads"];
const COMP_SERVO   = ["None", "ServoDyn"];
const COMP_SEAST   = ["None", "SeaState"];
const COMP_HYDRO   = ["None", "HydroDyn"];
const COMP_SUB     = ["None", "SubDyn", "ExtPtfm_MCKF"];
const COMP_MOORING = ["None", "MAP++", "FEAMooring", "MoorDyn", "OrcaFlex"];
const COMP_ICE     = ["None", "IceFloe", "IceDyn"];

const ABORT_LEVELS  = ["WARNING", "SEVERE", "FATAL"];
const INTERP_ORDERS = [{ v: 1, label: "1 — Linear" }, { v: 2, label: "2 — Quadratic" }];
const OUT_FMT_OPTS  = [
  { v: 1, label: "1 — Text (.out)" },
  { v: 2, label: "2 — Binary (.outb)" },
  { v: 3, label: "3 — Text + Binary" },
  { v: 4, label: "4 — Uncompressed binary (.outb)" },
  { v: 5, label: "5 — Text + Uncompressed binary" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function resolveRelPath(fstDir, rel) {
  if (!rel) return "";
  const trimmed = rel.trim().replace(/\\/g, "/");
  if (!trimmed || /^(unused|none)$/i.test(trimmed)) return "";
  // Windows absolute path (e.g. "C:/..." or previously-mangled "/C:/...")
  const winAbs = trimmed.match(/^\/?([A-Za-z]:\/.+)/);
  if (winAbs) return winAbs[1];
  // Unix absolute path
  if (trimmed.startsWith("/")) return trimmed;
  const combined = fstDir + "/" + trimmed;
  const parts    = combined.split("/");
  const stack    = [];
  for (const part of parts) {
    if (part === "..") { if (stack.length > 0) stack.pop(); }
    else if (part !== "." && part !== "") stack.push(part);
  }
  // Don't prepend "/" for Windows drive-letter paths ("C:" as first segment)
  const hasDrive = stack.length > 0 && /^[A-Za-z]:$/.test(stack[0]);
  return (hasDrive ? "" : "/") + stack.join("/");
}

/** Compute the relative path from one directory to another */
function computeRelPath(fromDir, toDir) {
  const from = fromDir.replace(/\\/g, "/").split("/").filter(Boolean);
  const to   = toDir.replace(/\\/g, "/").split("/").filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  return [...Array(from.length - i).fill(".."), ...to.slice(i)].join("/") || ".";
}

/** Parse numeric key-value pairs from an OpenFAST input file.
 *  Returns { KeyName: numericValue, ... } for every parseable line. */
function parseFastKV(content) {
  const kv = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/!.*$/, "").trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 2) continue;
    const val = parseFloat(tokens[0]);
    if (!isNaN(val)) kv[tokens[1]] = val;
  }
  return kv;
}

/** Patch a single key's value in an OpenFAST-format text file.
 *  Format:  <value>  KeyName  - comment  */
async function patchInputFileKey(path, key, newValue, onLog) {
  const content = await invoke("read_text_file", { path });
  let matched   = false;
  const re      = new RegExp(`^([ \\t]*)(?:"[^"]*"|\\S+)([ \\t]+${key}(?:[ \\t]|$).*?)\\r?$`);
  const lines   = content.split("\n").map(line => {
    const m = line.match(re);
    if (m) { matched = true; return `${m[1]}${newValue}${m[2]}`; }
    return line;
  });
  if (!matched) {
    throw new Error(`key "${key}" not found in ${path.split("/").pop()}`);
  }
  await invoke("write_text_file", { path, content: lines.join("\n") });
}

/** In-memory version — returns the patched string without touching the file. */
function patchContentKey(content, key, newValue) {
  const re = new RegExp(`^([ \\t]*)(?:"[^"]*"|\\S+)([ \\t]+${key}(?:[ \\t]|$).*?)\\r?$`);
  return content.split("\n").map(line => {
    const m = line.match(re);
    return m ? `${m[1]}${newValue}${m[2]}` : line;
  }).join("\n");
}

/**
 * Build a run-copy of the .fst with every relative file reference made absolute,
 * and InflowFile pointing at the given casedIfwPath.
 * This lets OpenFAST run from any directory without breaking sub-module paths.
 */
function buildRunFst(fstContent, fstDir, casedIfwPath) {
  const FILE_KEYS = new Set([
    "EDFile", "AeroFile", "ServoFile", "SubFile",
    "MooringFile", "HydroFile", "SeaStFile", "IceFile", "BDBldFile",
  ]);
  return fstContent.split("\n").map(line => {
    const m = line.match(/^(\s*)"([^"]+)"(\s+)(\w+)/);
    if (!m) return line;
    const [, , val, , key] = m;
    if (key === "InflowFile") return line.replace(`"${val}"`, `"${casedIfwPath}"`);
    if (FILE_KEYS.has(key) && !val.startsWith("/") && !/^[A-Za-z]:/.test(val) &&
        val.toLowerCase() !== "default" && val.toLowerCase() !== "none") {
      return line.replace(`"${val}"`, `"${fstDir}/${val}"`);
    }
    return line;
  }).join("\n");
}

/** Format ISO timestamp → relative string */
function relTime(iso) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (isNaN(diff) || diff < 0) return "";
  if (diff < 60_000)        return "just now";
  if (diff < 3_600_000)     return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000)    return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ── Parser ────────────────────────────────────────────────────────────────────
function parseFstLines(content) {
  const result = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("!") || line.startsWith("-") || line.startsWith("=")) continue;
    let rest  = line;
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
    }
    const keyMatch = rest.match(/^(\S+)/);
    if (!keyMatch) continue;
    result[keyMatch[1]] = value;
  }
  return result;
}

// ── Defaults ──────────────────────────────────────────────────────────────────
// Matches OpenFAST v4 .fst format. New fields vs v3:
//   NumCrctn (was NumCorrSteps), DT_UJac, UJacSclFact — Simulation Control
//   CompSeaSt — Feature Switches
//   Environmental Conditions section (Gravity … MSL2SWL)
//   SeaStFile — Input Files
//   DT_Out + TStart moved to Output section
//   Linearize — Linearization section
//   WrVTK — Visualization section
const DEFAULT = {
  // Simulation Control
  Echo: false, AbortLevel: 2,
  TMax: 600.0, DT: 0.005, InterpOrder: 2, NumCorrSteps: 0,
  DT_UJac: 99999.0, UJacSclFact: 1000000.0,
  // Feature Switches
  CompElast: 1, CompInflow: 1, CompAero: 2, CompServo: 1, CompSeaSt: 0,
  CompHydro: 0, CompSub: 0, CompMooring: 0, CompIce: 0, MHK: 0,
  // Environmental Conditions
  Gravity: 9.80665, AirDens: 1.225, WtrDens: 1025.0, KinVisc: 1.464e-5,
  SpdSound: 335.0, Patm: 103500.0, Pvap: 1700.0, WtrDpth: 0.0, MSL2SWL: 0.0,
  // Input Files
  EDFile: "elastodyn.dat", BDBldFile1: "unused", BDBldFile2: "unused", BDBldFile3: "unused",
  InflowFile: "inflowwind.dat", AeroFile: "aerodyn.dat", ServoFile: "servodyn.dat",
  SeaStFile: "unused", HydroFile: "unused", SubFile: "unused", MooringFile: "unused", IceFile: "unused",
  // Output
  SumPrint: true, SttsTime: 0.0, ChkptTime: 99999.9,
  DT_Out: "default", TStart: 0.0,
  OutFileFmt: 3, TabDelim: true, OutFmt: "ES10.3E2",
  // Linearization
  Linearize: false, CalcSteady: false, TrimCase: 3, TrimTol: 0.001, TrimGain: 0.01,
  Twr_Kdmp: 0.0, Bld_Kdmp: 0.0, NLinTimes: 2, LinTimes: "30, 60",
  LinInputs: 1, LinOutputs: 1, LinOutJac: false, LinOutMod: false,
  // Visualization
  WrVTK: 0, VTK_type: 1, VTK_fields: false, VTK_fps: 15,
  // UI-only
  FilePrefix: "", BinPath: "",
};

// DT_Out must be "default" or a positive finite number; anything else → "default"
const normalizeDtOut = raw => {
  const s = String(raw ?? "").trim();
  if (!s || s.toLowerCase() === "default") return "default";
  const n = Number(s);
  return isFinite(n) && n > 0 ? s : "default";
};

function fstParsedToState(kv) {
  const state = { ...DEFAULT };
  const bool = v => typeof v === "string" && v.toLowerCase() === "true";
  const num  = v => v !== undefined && !isNaN(Number(v)) ? Number(v) : undefined;

  if (kv.Echo       !== undefined) state.Echo       = bool(kv.Echo);
  if (kv.SumPrint   !== undefined) state.SumPrint   = bool(kv.SumPrint);
  if (kv.TabDelim   !== undefined) state.TabDelim   = bool(kv.TabDelim);
  if (kv.Linearize  !== undefined) state.Linearize  = bool(kv.Linearize);
  if (kv.CalcSteady !== undefined) state.CalcSteady = bool(kv.CalcSteady);
  if (kv.LinOutJac  !== undefined) state.LinOutJac  = bool(kv.LinOutJac);
  if (kv.LinOutMod  !== undefined) state.LinOutMod  = bool(kv.LinOutMod);
  if (kv.VTK_fields !== undefined) state.VTK_fields = bool(kv.VTK_fields);

  // Scalar numerics — v4 renames NumCorrSteps → NumCrctn; accept both
  for (const k of ["TMax","DT","TStart","InterpOrder","NumCorrSteps","SttsTime","ChkptTime","OutFileFmt","MHK",
                   "DT_UJac","UJacSclFact","CompSeaSt",
                   "Gravity","AirDens","WtrDens","KinVisc","SpdSound","Patm","Pvap","WtrDpth","MSL2SWL",
                   "WrVTK","VTK_type","VTK_fps",
                   "TrimCase","TrimTol","TrimGain","Twr_Kdmp","Bld_Kdmp","NLinTimes","LinInputs","LinOutputs"]) {
    const v = num(kv[k]); if (v !== undefined) state[k] = v;
  }
  // LinTimes is a space/comma-separated list — store as trimmed string
  if (kv.LinTimes !== undefined) state.LinTimes = kv.LinTimes.trim();
  // v4 renamed parameter
  if (kv.NumCrctn !== undefined) { const v = num(kv.NumCrctn); if (v !== undefined) state.NumCorrSteps = v; }

  if (kv.DT_Out !== undefined) state.DT_Out = normalizeDtOut(kv.DT_Out);
  if (kv.OutFmt)     state.OutFmt = kv.OutFmt;
  if (kv.AbortLevel) { const idx = ABORT_LEVELS.indexOf(kv.AbortLevel.toUpperCase()); if (idx >= 0) state.AbortLevel = idx; }

  for (const [fk, sk] of Object.entries({
    CompElast:"CompElast", CompInflow:"CompInflow", CompAero:"CompAero",
    CompServo:"CompServo", CompHydro:"CompHydro", CompSub:"CompSub",
    CompMooring:"CompMooring", CompIce:"CompIce",
  })) { const v = num(kv[fk]); if (v !== undefined) state[sk] = v; }

  for (const [fk, sk] of Object.entries({
    EDFile:"EDFile","BDBldFile(1)":"BDBldFile1","BDBldFile(2)":"BDBldFile2","BDBldFile(3)":"BDBldFile3",
    InflowFile:"InflowFile",AeroFile:"AeroFile",ServoFile:"ServoFile",SeaStFile:"SeaStFile",
    HydroFile:"HydroFile",SubFile:"SubFile",MooringFile:"MooringFile",IceFile:"IceFile",
  })) { if (kv[fk] !== undefined) state[sk] = kv[fk]; }

  return state;
}

// ── .fst builder — OpenFAST v4 format ────────────────────────────────────────
function buildFstContent(p, prefix) {
  const b   = v => v ? "True" : "False";
  const q   = v => `"${v}"`;
  const pad = (v, n = 22) => String(v).padEnd(n);
  return [
    `------- OpenFAST INPUT FILE -------------------------------------------`,
    `Generated by FlowUrja Studio — ${prefix}`,
    `---------------------- SIMULATION CONTROL --------------------------------------`,
    `${pad(b(p.Echo))} Echo            - Echo input data to <RootName>.ech (flag)`,
    `${pad(q(ABORT_LEVELS[p.AbortLevel]))} AbortLevel      - Error level when simulation should abort (string) {"WARNING", "SEVERE", "FATAL"}`,
    `${pad(p.TMax)} TMax            - Total run time (s)`,
    `${pad(p.DT)} DT              - Recommended module time step (s)`,
    `${pad(p.InterpOrder)} InterpOrder     - Interpolation order for input/output time history (-) {1=linear, 2=quadratic}`,
    `${pad(p.NumCorrSteps)} NumCrctn        - Number of correction iterations (-) {0=explicit calculation, i.e., no corrections}`,
    `${pad(p.DT_UJac)} DT_UJac         - Time between calls to get Jacobians (s)`,
    `${pad(p.UJacSclFact)} UJacSclFact     - Scaling factor used in Jacobians (-)`,
    `---------------------- FEATURE SWITCHES AND FLAGS ------------------------------`,
    `${pad(p.CompElast)} CompElast       - Compute structural dynamics (switch) {1=ElastoDyn; 2=ElastoDyn + BeamDyn for blades; 3=Simplified ElastoDyn}`,
    `${pad(p.CompInflow)} CompInflow      - Compute inflow wind velocities (switch) {0=still air; 1=InflowWind; 2=external from OpenFOAM}`,
    `${pad(p.CompAero)} CompAero        - Compute aerodynamic loads (switch) {0=None; 1=AeroDyn v14; 2=AeroDyn v15}`,
    `${pad(p.CompServo)} CompServo       - Compute control and electrical-drive dynamics (switch) {0=None; 1=ServoDyn}`,
    `${pad(p.CompSeaSt)} CompSeaSt       - Compute sea state information (switch) {0=None; 1=SeaState}`,
    `${pad(p.CompHydro)} CompHydro       - Compute hydrodynamic loads (switch) {0=None; 1=HydroDyn}`,
    `${pad(p.CompSub)} CompSub         - Compute sub-structural dynamics (switch) {0=None; 1=SubDyn; 2=External Platform MCKF}`,
    `${pad(p.CompMooring)} CompMooring     - Compute mooring system (switch) {0=None; 1=MAP++; 2=FEAMooring; 3=MoorDyn; 4=OrcaFlex}`,
    `${pad(p.CompIce)} CompIce         - Compute ice loads (switch) {0=None; 1=IceFloe; 2=IceDyn}`,
    `${pad(p.MHK)} MHK             - MHK turbine type (switch) {0=Not an MHK turbine; 1=Fixed MHK turbine; 2=Floating MHK turbine}`,
    `---------------------- ENVIRONMENTAL CONDITIONS --------------------------------`,
    `${pad(p.Gravity)} Gravity         - Gravitational acceleration (m/s^2)`,
    `${pad(p.AirDens)} AirDens         - Air density (kg/m^3)`,
    `${pad(p.WtrDens)} WtrDens         - Water density (kg/m^3)`,
    `${pad(p.KinVisc)} KinVisc         - Kinematic viscosity of working fluid (m^2/s)`,
    `${pad(p.SpdSound)} SpdSound        - Speed of sound in working fluid (m/s)`,
    `${pad(p.Patm)} Patm            - Atmospheric pressure (Pa) [used only for an MHK turbine cavitation check]`,
    `${pad(p.Pvap)} Pvap            - Vapour pressure of working fluid (Pa) [used only for an MHK turbine cavitation check]`,
    `${pad(p.WtrDpth)} WtrDpth         - Water depth (m)`,
    `${pad(p.MSL2SWL)} MSL2SWL         - Offset between still-water level and mean sea level (m) [positive upward]`,
    `---------------------- INPUT FILES ---------------------------------------------`,
    `${pad(q(p.EDFile))} EDFile          - Name of file containing ElastoDyn input parameters (quoted string)`,
    `${pad(q(p.BDBldFile1))} BDBldFile(1)    - Name of file containing BeamDyn input parameters for blade 1 (quoted string)`,
    `${pad(q(p.BDBldFile2))} BDBldFile(2)    - Name of file containing BeamDyn input parameters for blade 2 (quoted string)`,
    `${pad(q(p.BDBldFile3))} BDBldFile(3)    - Name of file containing BeamDyn input parameters for blade 3 (quoted string)`,
    `${pad(q(p.InflowFile))} InflowFile      - Name of file containing inflow wind input parameters (quoted string)`,
    `${pad(q(p.AeroFile))} AeroFile        - Name of file containing aerodynamic input parameters (quoted string)`,
    `${pad(q(p.ServoFile))} ServoFile       - Name of file containing control and electrical-drive input parameters (quoted string)`,
    `${pad(q(p.SeaStFile))} SeaStFile       - Name of file containing sea state input parameters (quoted string)`,
    `${pad(q(p.HydroFile))} HydroFile       - Name of file containing hydrodynamic input parameters (quoted string)`,
    `${pad(q(p.SubFile))} SubFile         - Name of file containing sub-structural input parameters (quoted string)`,
    `${pad(q(p.MooringFile))} MooringFile     - Name of file containing mooring system input parameters (quoted string)`,
    `${pad(q(p.IceFile))} IceFile         - Name of file containing ice input parameters (quoted string)`,
    `---------------------- OUTPUT --------------------------------------------------`,
    `${pad(b(p.SumPrint))} SumPrint        - Print summary data to "<RootName>.sum" (flag)`,
    `${pad(p.SttsTime)} SttsTime        - Amount of time between screen status messages (s)`,
    `${pad(p.ChkptTime)} ChkptTime       - Amount of time between creating checkpoint files for potential restart (s)`,
    `${pad(q(p.DT_Out))} DT_Out          - Time step for tabular output (s) (or "default")`,
    `${pad(p.TStart)} TStart          - Time to begin tabular output (s)`,
    `${pad(p.OutFileFmt)} OutFileFmt      - Format for tabular (time-marching) output file (switch) {1: text file [<RootName>.out], 2: binary file [<RootName>.outb], 3: both 1 and 2, 4: uncompressed binary [<RootName>.outb, 5: both 1 and 4}`,
    `${pad(b(p.TabDelim))} TabDelim        - Use tab delimiters in text tabular output file? (flag)`,
    `${pad(q(p.OutFmt))} OutFmt          - Format used for text tabular output (quoted string)`,
    `---------------------- LINEARIZATION -------------------------------------------`,
    `${pad(b(p.Linearize))} Linearize       - Linearization analysis (flag)`,
    `${pad(b(p.CalcSteady))} CalcSteady      - Calculate a steady-state periodic operating point before linearization? (flag)`,
    `${pad(p.TrimCase)} TrimCase        - Controller parameter to be trimmed {1:yaw; 2:torque; 3:pitch} (-)`,
    `${pad(p.TrimTol)} TrimTol         - Tolerance for the rotational speed convergence (-)`,
    `${pad(p.TrimGain)} TrimGain        - Proportional gain for the rotational speed error (-)`,
    `${pad(p.Twr_Kdmp)} Twr_Kdmp        - Damping factor for the tower (N/(m/s))`,
    `${pad(p.Bld_Kdmp)} Bld_Kdmp        - Damping factor for the blades (N/(m/s))`,
    `${pad(p.NLinTimes)} NLinTimes       - Number of times to linearize (-) [>=1]`,
    `${pad(p.LinTimes)} LinTimes        - List of times at which to linearize (s) [1 to NLinTimes]`,
    `${pad(p.LinInputs)} LinInputs       - Inputs included in linearization (switch) {0=none; 1=standard; 2=all module inputs (debug)}`,
    `${pad(p.LinOutputs)} LinOutputs      - Outputs included in linearization (switch) {0=none; 1=from OutList(s); 2=all module outputs (debug)}`,
    `${pad(b(p.LinOutJac))} LinOutJac       - Include full Jacobians in linearization output (flag)`,
    `${pad(b(p.LinOutMod))} LinOutMod       - Write module-level linearization output files (flag)`,
    `---------------------- VISUALIZATION ------------------------------------------`,
    `${pad(p.WrVTK)} WrVTK           - VTK visualization data output: (switch) {0=none; 1=init only; 2=animation; 3=mode shapes}`,
    `${pad(p.VTK_type)} VTK_type        - Type of VTK visualization data: (switch) {1=surfaces; 2=basic meshes; 3=all meshes}`,
    `${pad(b(p.VTK_fields))} VTK_fields      - Write mesh fields to VTK data files? (flag)`,
    `${pad(p.VTK_fps)} VTK_fps         - Frame rate for VTK output (frames per second)`,
  ].join("\n");
}

// ── Sub-components ────────────────────────────────────────────────────────────
function SectionHead({ children }) { return <p className={s.sectionHead}>{children}</p>; }

const OF_ACCENT = "#0891B2";

function Field({ label, unit, info, title, children }) {
  return (
    <div className={s.field} title={title}>
      <div className={s.fieldHeader}>
        <label className={s.fieldLabel}>{label}{unit && <span className={s.unit}> {unit}</span>}</label>
        {info && <InfoPopover accentColor={OF_ACCENT} content={typeof info === "string" ? { desc: info } : info} />}
      </div>
      {children}
    </div>
  );
}

function Toggle({ label, value, onChange, info, disabled, title }) {
  return (
    <div className={s.toggleRow} title={title}>
      <button type="button" disabled={disabled} className={`${s.toggle} ${value ? s.toggleOn : ""}`} onClick={() => onChange(!value)}>
        <span className={s.toggleThumb} />
      </button>
      <span className={s.toggleLabel}>{label}</span>
      {info && <InfoPopover accentColor={OF_ACCENT} content={typeof info === "string" ? { desc: info } : info} />}
    </div>
  );
}

function Collapsible({ title, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={s.collapsible}>
      <button className={s.collapsibleHead} onClick={() => setOpen(o => !o)}>
        {open ? <ChevronDown size={13} strokeWidth={2} /> : <ChevronRight size={13} strokeWidth={2} />}
        {title}
      </button>
      {open && <div className={s.collapsibleBody}>{children}</div>}
    </div>
  );
}

function CompSelector({ options, value, onChange, disabled, lockedAbove, lockedAboveTitle }) {
  return (
    <div className={s.compSeg}>
      {options.map((label, i) => {
        const partialLock = !disabled && lockedAbove !== undefined && i > lockedAbove;
        return (
          <button key={i}
            disabled={disabled || partialLock}
            title={partialLock ? lockedAboveTitle : undefined}
            className={`${s.compBtn} ${value === i ? s.compBtnActive : ""}`}
            onClick={() => onChange(i)}>
            {label}
          </button>
        );
      })}
    </div>
  );
}

function ModuleRow({ title, compOptions, value, onChange, fileKey, fileValue, onFileChange, onBrowse, compact, lockedReason, lockedAbove, lockedAboveTitle }) {
  const active = value > 0;
  return (
    <div
      className={`${s.moduleRow} ${active ? s.moduleActive : ""} ${lockedReason ? s.moduleRowLocked : ""}`}
      title={lockedReason || undefined}
    >
      <div className={`${s.moduleRowHead} ${compact ? s.moduleRowHeadCompact : ""}`}>
        <div className={s.moduleRowLabel}>
          <span className={s.moduleRowTitle}>{title}</span>
          <span className={`${s.moduleRowSub} ${active && !lockedReason ? s.activeText : ""} ${lockedReason ? s.lockedText : ""}`}>
            {lockedReason ? "locked" : active ? compOptions[value] : "disabled"}
          </span>
        </div>
        <CompSelector options={compOptions} value={value} onChange={onChange} disabled={!!lockedReason} lockedAbove={lockedAbove} lockedAboveTitle={lockedAboveTitle} />
      </div>
      {active && fileKey && !lockedReason && (
        <div className={s.moduleFilePath}>
          <input type="text" className={s.fileInp} value={fileValue} onChange={e => onFileChange(e.target.value)} />
          <button className={s.browseBtn} onClick={onBrowse}><FolderOpen size={12} strokeWidth={1.8} /> Browse</button>
        </div>
      )}
    </div>
  );
}

// ── Module pill definitions (module strip in run dashboard) ──────────────────
// defaultVal: the Comp* value to restore when re-enabling a module from the pill.
const MODULE_PILL_DEFS = [
  { id: "elastodyn",  label: "ElastoDyn",  comp: "CompElast",   color: "var(--c-elastodyn)", hasPanel: true,  defaultVal: 1 },
  { id: "inflowwind", label: "InflowWind", comp: "CompInflow",  color: "var(--c-inflow)",    hasPanel: true,  defaultVal: 1 },
  { id: "aerodyn",    label: "AeroDyn",    comp: "CompAero",    color: "var(--c-aerodyn)",   hasPanel: true,  defaultVal: 2 },
  { id: "servodyn",   label: "ServoDyn",   comp: "CompServo",   color: "var(--c-servodyn)",  hasPanel: true,  defaultVal: 1 },
  { id: "seastate",   label: "SeaState",   comp: "CompSeaSt",   color: "var(--c-seastate)",  hasPanel: true,  defaultVal: 1 },
  { id: "hydrodyn",   label: "HydroDyn",   comp: "CompHydro",   color: "var(--c-hydrodyn)",  hasPanel: true,  defaultVal: 1 },
  { id: "subdyn",     label: "SubDyn",     comp: "CompSub",     color: "var(--c-subdyn)",    hasPanel: true,  defaultVal: 1 },
  { id: "moordyn",    label: "MoorDyn",    comp: "CompMooring", color: "var(--c-moordyn)",   hasPanel: true,  defaultVal: 3 },
  { id: "icedyn",     label: "IceDyn",     comp: "CompIce",     color: "var(--c-icedyn)",    hasPanel: true,  defaultVal: 2 },
];

// ── Editable parameter cell (run dashboard Zone 4) ────────────────────────────
function EditableParam({ label, unit, value, onChange, step, min, isString = false }) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState("");

  const handleStart  = () => { setDraft(String(value)); setEditing(true); };
  const handleCommit = () => {
    setEditing(false);
    if (isString) { onChange(draft); return; }
    const n = parseFloat(draft);
    if (!isNaN(n)) onChange(n);
  };

  return (
    <div className={s.paramCell} onClick={!editing ? handleStart : undefined}>
      <span className={s.paramLabel}>
        {label}{unit && <span className={s.paramUnit}> {unit}</span>}
      </span>
      {editing ? (
        <input
          autoFocus
          className={s.paramInput}
          type={isString ? "text" : "number"}
          value={draft}
          step={step}
          min={min}
          onChange={e => setDraft(e.target.value)}
          onBlur={handleCommit}
          onKeyDown={e => {
            if (e.key === "Enter")  { e.preventDefault(); handleCommit(); }
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <span className={s.paramVal}>{value}</span>
      )}
    </div>
  );
}

// ── Turbine icon (spins while running) ───────────────────────────────────────
// memo: props only change at simulation start/stop, so this never re-renders
// while running. Prevents macOS WKWebView main-thread SVG animation jitter.
const TurbineIcon = memo(function TurbineIcon({ spinning, className }) {
  // Blades spin inside an HTML <div> so WKWebView promotes the animation to the
  // compositor thread — eliminating the jitter caused by SVG <g> transform animations
  // which run on the main thread and get interrupted by React renders / layout work.
  return (
    <div className={[s.turbineWrapper, className].join(" ")}>
      <div className={spinning ? s.turbineBladeWrapperSpin : s.turbineBladeWrapper}>
        <svg className={s.turbineLayer} viewBox="0 0 100 140" fill="none" aria-hidden="true">
          <g transform="translate(50 69)">
            <path d="M-3 -1 C-4.5 -14 -4 -36 -2.5 -49 A2.5 2.5 0 0 1 2.5 -49 C4 -36 4.5 -14 3 -1 Z" fill="currentColor" opacity="0.82" />
            <path d="M-3 -1 C-4.5 -14 -4 -36 -2.5 -49 A2.5 2.5 0 0 1 2.5 -49 C4 -36 4.5 -14 3 -1 Z" fill="currentColor" opacity="0.82" transform="rotate(120)" />
            <path d="M-3 -1 C-4.5 -14 -4 -36 -2.5 -49 A2.5 2.5 0 0 1 2.5 -49 C4 -36 4.5 -14 3 -1 Z" fill="currentColor" opacity="0.82" transform="rotate(240)" />
          </g>
        </svg>
      </div>
      {/* Tower + nacelle + hub — static layer rendered on top of the spinning blades */}
      <svg className={s.turbineLayer} viewBox="0 0 100 140" fill="none" aria-hidden="true">
        <path d="M44 70 L56 70 L60 134 L40 134 Z" fill="currentColor" opacity="0.18" />
        <rect x="32" y="63" width="36" height="12" rx="4.5" fill="currentColor" opacity="0.28" />
        <circle cx="50" cy="69" r="6.5" fill="currentColor" />
      </svg>
    </div>
  );
});

// ── Main Component ────────────────────────────────────────────────────────────
export default function OpenFASTPanel({ onLog, project, tabRequest, onModuleFilesDetected, onModuleActiveChange, onDirtyChange, onRegisterSave, discardSeq = 0, onModuleSelect, isActive = false, inflowWindParams = null, onSimRunningChange, onPidChange, onInflowPatch }) {
  // ── Core state ──────────────────────────────────────────────────────────────
  const [tab,            setTab]            = useState("run");
  const tabDirRef = useRef(1);
  const [p,              setP]              = useState(DEFAULT);
  const [running,        setRunning]        = useState(false);
  const [runPct,         setRunPct]         = useState(0);   // 0-100, parsed from stdout
  const [showRaw,    setShowRaw]    = useState(false);
  const [rawContent, setRawContent] = useState("");
  const [fstPath,    setFstPath]    = useState("");

  // ── Binary resolution (bundled → override → system) ──────────────────────────
  const {
    resolvedPath:   ofBinPath,
    source:         ofBinSource,
    bundledVersion: ofBundledVersion,   // version from versions.json when source=bundled
  } = useBinarySettings("openfast");


  // ── OpenFAST version ─────────────────────────────────────────────────────────
  // For "bundled" source we use the known version from versions.json (no exec needed).
  // For "system" / "override" we probe via query_binary.
  const [ofVersion,  setOfVersion]  = useState(null);   // e.g. "4.2.0" | null | "unknown"

  // ── Wind + run state ─────────────────────────────────────────────────────────
  const [windType,      setWindType]      = useState(1);      // 1|2|3 (Steady|BTS|Uniform)
  const [hWindSpeed,    setHWindSpeed]    = useState("10.0");
  const [btsFile,       setBtsFile]       = useState("");
  const [btsOptions,    setBtsOptions]    = useState([]);
  const [btsUsableTime, setBtsUsableTime] = useState(null);   // seconds or null
  const [recentRuns,    setRecentRuns]    = useState([]);
  // Template metadata loaded from list_turbine_templates when fstPath changes.
  // Provides hubHeight, rotorDiameter, ratedPower, badge, etc. for the hero.
  const [modelMeta,    setModelMeta]    = useState(null);
  // Hub height derived from ElastoDyn file — fallback when template metadata is absent.
  const [edHubHeight,  setEdHubHeight]  = useState(null);

  // ── Refs ─────────────────────────────────────────────────────────────────────
  const unlistenRef      = useRef([]);
  const pidRef           = useRef(null);
  const tabReqSeqRef     = useRef(0);
  const autoLoadedFstRef = useRef("");
  // JSON snapshot of `p` taken every time a .fst is loaded or saved.
  // isDirty fires when current form state diverges from the snapshot.
  const fstSnapshotRef   = useRef(null);

  // ── Derived ──────────────────────────────────────────────────────────────────
  const effectivePrefix = p.FilePrefix.trim() || (project ? project.name : "run_001");
  const fstDir = fstPath ? fstPath.replace(/\\/g, "/").split("/").slice(0, -1).join("/") : "";
  const inflowwindPath = (fstDir && p.InflowFile && p.CompInflow > 0)
    ? resolveRelPath(fstDir, p.InflowFile) : "";
  // True when the form has diverged from the last saved / loaded snapshot.
  // FilePrefix is NOT a real .fst parameter (it's the run-case name kept in UI state);
  // exclude it so typing a case name doesn't light up the model-file Save button.
  const isDirty = !!fstPath && fstSnapshotRef.current !== null && (() => {
    try {
      const { FilePrefix: _a, BinPath: _b, ...pCore }    = p;
      const { FilePrefix: _c, BinPath: _d, ...snapCore } = JSON.parse(fstSnapshotRef.current);
      return JSON.stringify(pCore) !== JSON.stringify(snapCore);
    } catch {
      return false;
    }
  })();

  // ── Broadcast module active states to sidebar ─────────────────────────────────
  // Fires whenever a Comp* switch is toggled in the Modules tab, and also when
  // a .fst loads (via fstPath changing) or when no model is loaded (null = reset).
  useEffect(() => {
    if (!fstPath) { onModuleActiveChange?.(null); return; }
    onModuleActiveChange?.({
      elastodyn:  p.CompElast   > 0,
      inflowwind: p.CompInflow  > 0,
      aerodyn:    p.CompAero    > 0,
      servodyn:   p.CompServo   > 0,
      seastate:   p.CompSeaSt   > 0,
      hydrodyn:   p.CompHydro   > 0,
      subdyn:     p.CompSub     > 0,
      moordyn:    p.CompMooring > 0,
      icedyn:     p.CompIce     > 0,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fstPath, p.CompElast, p.CompInflow, p.CompAero, p.CompServo, p.CompSeaSt, p.CompHydro, p.CompSub, p.CompMooring, p.CompIce]);

  // Next sequential run number — scan recentRuns names for the highest trailing integer
  const nextSeq = useMemo(() => {
    let max = 0;
    for (const r of recentRuns) {
      const m = (r.name ?? "").match(/(\d+)$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return String(max + 1).padStart(3, "0");
  }, [recentRuns]);

  // Auto-suggested case names shown as clickable chips
  const suggestedNames = useMemo(() => {
    const fmtSpd = v => {
      const n = parseFloat(v);
      if (isNaN(n)) return null;
      return Number.isInteger(n) ? `ws${n}` : `ws${n.toString().replace(".", "p")}`;
    };
    const names = [];
    if (windType === 1 && hWindSpeed) {
      const spd = fmtSpd(hWindSpeed);
      if (spd) names.push(`${spd}_r${nextSeq}`);
    } else if (windType === 3 && btsFile) {
      const stem = btsFile.replace(/\.bts$/i, "");
      names.push(`${stem}_r${nextSeq}`);
    }
    names.push(`run_${nextSeq}`);
    // Deduplicate while preserving order
    return [...new Set(names)].slice(0, 3);
  }, [windType, hWindSpeed, btsFile, nextSeq]);

  // The actual case name used for archiving: typed name → first suggestion → project name.
  // Defined after suggestedNames so it can use suggestedNames[0] as fallback.
  const effectiveCaseName = p.FilePrefix.trim() || suggestedNames[0] || (project ? project.name : "run_001");

  // ServoDyn off + aero on + structural on = pitch-controller absent → likely fatal error
  const showServoDynWarn = !!fstPath && windType !== null
    && p.CompServo === 0 && p.CompAero >= 2 && p.CompElast >= 1;

  // BTS selected and TMax exceeds the wind field's usable duration
  const btsTMaxOver = windType === 3 && btsUsableTime !== null && p.TMax > btsUsableTime;

  // ── Tab-jump requests ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!tabRequest?.tab) return;
    if (tabRequest.seq === tabReqSeqRef.current) return;
    tabReqSeqRef.current = tabRequest.seq;
    if (tabRequest.tab !== "runtime") setTab(tabRequest.tab);
  }, [tabRequest]);

  // ── Auto-load .fst from project ───────────────────────────────────────────────
  useEffect(() => {
    if (!project?.modelFst) return;
    if (autoLoadedFstRef.current === project.modelFst) return;
    autoLoadedFstRef.current = project.modelFst;
    invoke("read_text_file", { path: project.modelFst })
      .then(content => {
        const kv       = parseFstLines(content);
        const newState = fstParsedToState(kv);
        if (p.BinPath) newState.BinPath = p.BinPath;
        setFstPath(project.modelFst);
        setP(newState);
        fstSnapshotRef.current = JSON.stringify(newState); // baseline for dirty detection
        const dir = project.modelFst.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
        onModuleFilesDetected?.({
          fstPath: project.modelFst, fstDir: dir,
          elastodyn:  resolveRelPath(dir, newState.EDFile),
          aerodyn:    resolveRelPath(dir, newState.AeroFile),
          servodyn:   resolveRelPath(dir, newState.ServoFile),
          inflowwind: resolveRelPath(dir, newState.InflowFile),
          seastate:   resolveRelPath(dir, newState.SeaStFile),
          hydrodyn:   resolveRelPath(dir, newState.HydroFile),
          subdyn:     resolveRelPath(dir, newState.SubFile),
          moordyn:    resolveRelPath(dir, newState.MooringFile),
          icedyn:     resolveRelPath(dir, newState.IceFile),
        });
        onLog?.("ok", `Loaded ${project.modelFst.split("/").pop()} from project.`);
      })
      .catch(err => onLog?.("warn", `Could not auto-load .fst: ${err}`));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.modelFst]);

  // ── Probe version once the binary is resolved ────────────────────────────────
  // For "bundled": use the version from versions.json (no exec — binary has @rpath
  //   dylib deps from the conda env that aren't available when run standalone).
  // For "system" / "override": probe via query_binary (those binaries have their
  //   dylibs resolved by the shell environment).
  useEffect(() => {
    if (!ofBinPath) return;
    const src = ofBinSource === "bundled" ? "bundled"
              : ofBinSource === "override" ? "override"
              : "system";

    if (ofBinSource === "bundled") {
      // Known version — no subprocess needed
      const ver = ofBundledVersion ?? null;
      setOfVersion(ver);
      const verStr = ver ? ` v${ver}` : "";
      onLog?.("ok", `OpenFAST${verStr} → ${ofBinPath}  [bundled]`);
      return;
    }

    onLog?.("ok", `OpenFAST → ${ofBinPath}  [${src}]`);
    setOfVersion(null);   // show "probing…" while we wait
    invoke("query_binary", { binary: ofBinPath, args: [] })
      .then(output => {
        const m = output.match(/OpenFAST[-_\s]+(v?[\d]+\.[\d]+\.?[\d]*)/i);
        if (m) {
          const ver = m[1].replace(/^v/i, "");
          setOfVersion(ver);
          onLog?.("ok", `OpenFAST v${ver} detected`);
        } else {
          setOfVersion("");   // probed but version not parseable — suppress badge
        }
      })
      .catch(() => setOfVersion(""));   // probe failed — suppress badge
  }, [ofBinPath, ofBinSource, ofBundledVersion]);

  // ── Read InflowWind.dat → wind type + current settings ───────────────────────
  // Fires when the path changes (initial load / .fst switch) AND when the user
  // navigates back to this panel (isActive: false→true) so edits made in the
  // InflowWind panel are always reflected here.
  // Only reads when panel is becoming ACTIVE — skipping the false→inactive
  // transition prevents a race where the file read returns the pre-patch value
  // after the user changed a setting but before patchInputFileKey completed.
  useEffect(() => {
    if (!inflowwindPath) { setWindType(1); return; }
    if (!isActive) return;
    invoke("read_text_file", { path: inflowwindPath })
      .then(content => {
        const kv = parseFstLines(content);
        const wt = Number(kv.WindType ?? kv.NWindInpFile ?? 1);
        setWindType(wt);
        if (kv.HWindSpeed) setHWindSpeed(String(kv.HWindSpeed));
        if (kv.FileName_BTS) {
          setBtsFile(kv.FileName_BTS.replace(/"/g, "").replace(/\\/g, "/").split("/").pop());
        }
      })
      .catch(e => { onLog?.("warn", `InflowWind sync read failed: ${String(e)}`); setWindType(1); });
  }, [inflowwindPath, isActive]);

  // ── Live sync from InflowWind panel (no save required) ───────────────────────
  // When the user changes WindType / HWindSpeed / FileName_BTS in the InflowWind
  // module, App.jsx broadcasts the new values here via the inflowWindParams prop.
  // This overrides whatever was last read from disk so the run panel stays current.
  useEffect(() => {
    if (!inflowWindParams) return;
    const { windType: wt, hWindSpeed: spd, btsFile: bts } = inflowWindParams;
    if (wt  != null)           setWindType(wt);
    if (spd != null && spd !== "") setHWindSpeed(spd);
    if (bts != null)           setBtsFile(bts);
  }, [inflowWindParams]);

  // ── Load BTS file options from project wind dir ───────────────────────────────
  // Uses the sidecar's recursive list_bts_files so .bts files nested inside
  // wind/dlc_<timestamp>/DLC1.x/ are found alongside any top-level TurbSim files.
  // Re-scans when the panel becomes active so newly generated files appear
  // without needing a project reload.
  useEffect(() => {
    if (!isActive) return; // only scan when panel is visible
    const windDir = project?.windDir ?? (project ? `${project.workingDir}/wind` : null);
    if (!windDir) { setBtsOptions([]); return; }
    invoke("sidecar_call", {
      payload: JSON.stringify({ cmd: "list_bts_files", working_dir: windDir }),
    })
      .then(raw => {
        const res = JSON.parse(raw);
        setBtsOptions(res.ok ? res.files : []);
      })
      .catch(() => setBtsOptions([]));
  }, [project?.windDir, project?.workingDir, isActive]);

  // ── Read BTS usable time when a BTS file is selected ────────────────────────
  // Calls the fast read_bts_duration command (reads only the 64-byte header).
  // Used to warn the user if TMax exceeds the wind field's usable duration.
  useEffect(() => {
    if (windType !== 3 || !btsFile) { setBtsUsableTime(null); return; }
    const opt     = btsOptions.find(o => o.name === btsFile);
    const btsPath = opt
      ? opt.path
      : `${project?.windDir ?? `${project?.workingDir}/wind`}/${btsFile}`;
    invoke("read_bts_duration", { path: btsPath })
      .then(t  => setBtsUsableTime(t))
      .catch(() => setBtsUsableTime(null));
  }, [windType, btsFile, btsOptions, project?.windDir, project?.workingDir]);

  // ── Load template meta (hub height, rated power, etc.) from bundled resources ──
  // Matches the loaded .fst's parent directory name against each template's modelDir.
  useEffect(() => {
    if (!fstPath) { setModelMeta(null); return; }
    const parts       = fstPath.replace(/\\/g, "/").split("/");
    const modelDirName = parts[parts.length - 2]; // directory containing the .fst
    invoke("list_turbine_templates")
      .then(templates => {
        const match = templates.find(t => t.modelDir === modelDirName);
        setModelMeta(match ?? null);
      })
      .catch(() => setModelMeta(null));
  }, [fstPath]);

  // ── Derive hub height from ElastoDyn (TowerHt + Twr2Shft) ───────────────────
  // Used as fallback when the template database doesn't carry hubHeight.
  useEffect(() => {
    if (!fstDir || !p.EDFile || p.CompElast <= 0) { setEdHubHeight(null); return; }
    const edPath = resolveRelPath(fstDir, p.EDFile);
    if (!edPath) { setEdHubHeight(null); return; }
    invoke("read_text_file", { path: edPath })
      .then(content => {
        const kv      = parseFastKV(content);
        const towerHt  = kv["TowerHt"];
        const twr2shft = kv["Twr2Shft"] ?? 0;
        setEdHubHeight(towerHt !== undefined ? +(towerHt + twr2shft).toFixed(2) : null);
      })
      .catch(() => setEdHubHeight(null));
  }, [fstDir, p.EDFile, p.CompElast]);

  // ── Load recent runs from results/ (refresh after each run) ──────────────────
  useEffect(() => {
    const resultsDir = project?.resultsDir ?? (project ? `${project.workingDir}/results` : null);
    if (!resultsDir) { setRecentRuns([]); return; }
    // Each run now lives in results/{caseName}/run.json (new structure).
    // Legacy flat results/{caseName}.json files are also attempted for back-compat.
    invoke("list_dir", { path: resultsDir })
      .then(entries =>
        Promise.all(
          entries.slice(0, 40).map(entry =>
            // New structure: results/{caseName}/run.json
            invoke("read_text_file", { path: `${entry}/run.json` })
              .then(s => JSON.parse(s))
              .catch(() =>
                // Legacy flat structure: results/{caseName}.json
                entry.toLowerCase().endsWith(".json")
                  ? invoke("read_text_file", { path: entry }).then(s => JSON.parse(s)).catch(() => null)
                  : null
              )
          )
        )
      )
      .then(records => {
        setRecentRuns(
          records
            .filter(Boolean)
            .sort((a, b) => new Date(b.finishedAt ?? b.startedAt) - new Date(a.finishedAt ?? a.startedAt))
            .slice(0, 8)
        );
      })
      .catch(() => setRecentRuns([]));
  }, [project?.resultsDir, project?.workingDir, running]);

  // ── Helpers ───────────────────────────────────────────────────────────────────
  const set  = k => v  => setP(prev => ({ ...prev, [k]: v }));
  const setN = k => e  => setP(prev => ({ ...prev, [k]: Number(e.target.value) }));
  const setE = k => e  => setP(prev => ({ ...prev, [k]: e.target.value }));
  // SeaState → HydroDyn cascade: turning off SeaState must also disable HydroDyn
  const setCompSeaSt = v => setP(prev => ({ ...prev, CompSeaSt: v, ...(v === 0 ? { CompHydro: 0 } : {}) }));
  // InflowWind → AeroDyn cascade: still air (CompInflow=0) only supports None or AeroDisk
  const setCompInflow = v => setP(prev => ({ ...prev, CompInflow: v, ...(v === 0 && prev.CompAero >= 2 ? { CompAero: 1 } : {}) }));
  // Derived flags used for dependency dimming across tabs
  const isOffshore = p.CompSeaSt > 0 || p.CompHydro > 0 || p.CompSub > 0 || p.MHK > 0;
  const isMHK = p.MHK > 0;

  const browseFile = async key => {
    try {
      const f = await openDialog({ multiple: false, directory: false });
      if (f) setP(prev => ({ ...prev, [key]: f }));
    } catch {}
  };

  // ── Wind source write-through helpers ────────────────────────────────────────
  // Both handlers update local state AND patch inflowwind.dat on disk so the
  // InflowWind panel reads the correct state the next time it mounts.

  const handleWindTypeChange = async (newWt) => {
    setWindType(newWt);
    if (!inflowwindPath) {
      onLog?.("warn", `InflowWind sync: no path — CompInflow=${p.CompInflow}, InflowFile="${p.InflowFile}"`);
      return;
    }
    try {
      await patchInputFileKey(inflowwindPath, "WindType", String(newWt), onLog);
      onLog?.("info", `InflowWind patch ok: WindType=${newWt} written to ${inflowwindPath.split("/").pop()}`);
    } catch (e) {
      onLog?.("warn", `InflowWind patch failed (${inflowwindPath.split("/").pop()}): ${String(e)}`);
    }
    onInflowPatch?.();
  };

  const handleHWindSpeedBlur = async () => {
    if (windType !== 1 || !inflowwindPath || !hWindSpeed) return;
    try { await patchInputFileKey(inflowwindPath, "HWindSpeed", hWindSpeed, onLog); } catch {}
    onInflowPatch?.();
  };

  // Key is "FileName_BTS" (capital N) — matches what InflowWind buildContent writes.
  const handleBtsFileChange = async (newFile) => {
    setBtsFile(newFile);
    if (!inflowwindPath || !newFile || !project) return;
    const opt     = btsOptions.find(o => o.name === newFile);
    const btsPath = (opt
      ? opt.path
      : `${project.windDir ?? `${project.workingDir}/wind`}/${newFile}`
    ).replace(/\\/g, "/");
    try { await patchInputFileKey(inflowwindPath, "FileName_BTS", `"${btsPath}"`, onLog); } catch {}
    onInflowPatch?.();
  };

  // ── View / Save .fst ──────────────────────────────────────────────────────────
  const handleViewFst = async () => {
    if (!fstPath) {
      onLog?.("warn", "Save the .fst file first — then View will show the actual file on disk.");
      return;
    }
    try {
      const content = await invoke("read_text_file", { path: fstPath });
      setRawContent(content);
      setShowRaw(true);
    } catch (err) {
      onLog?.("error", `Cannot read .fst: ${err}`);
    }
  };

  // useCallback so onRegisterSave always stores the version that closes over the
  // latest fstPath and p — re-registers whenever those change.
  const handleWriteFst = useCallback(async () => {
    if (!fstPath) { onLog?.("error", "No .fst file loaded — import one first."); return; }
    try {
      const modelLabel = fstPath.split("/").pop().replace(/\.fst$/i, "");
      await invoke("write_text_file", { path: fstPath, content: buildFstContent(p, modelLabel) });
      fstSnapshotRef.current = JSON.stringify(p); // clear dirty flag
      onLog?.("ok", `Saved → ${fstPath.split("/").pop()}`);
    } catch (err) { onLog?.("error", String(err)); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fstPath, p, onLog]);

  // ── Dirty / save / discard wiring to App.jsx ─────────────────────────────────
  // Propagate isDirty so the nav guard in App.jsx can intercept navigation.
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty]); // eslint-disable-line react-hooks/exhaustive-deps

  // Register the latest save fn so App.jsx "Save & continue" can call it.
  useEffect(() => {
    onRegisterSave?.(handleWriteFst);
  }, [handleWriteFst]); // eslint-disable-line react-hooks/exhaustive-deps

  // Discard signal — reloads from disk and resets the snapshot so isDirty → false.
  // OpenFAST stays mounted during navigation so we can't rely on unmount to reset.
  useEffect(() => {
    if (discardSeq === 0 || !fstPath) return;
    invoke("read_text_file", { path: fstPath })
      .then(content => {
        const kv       = parseFstLines(content);
        const newState = fstParsedToState(kv);
        // Preserve UI-only fields
        newState.BinPath    = p.BinPath;
        newState.FilePrefix = p.FilePrefix;
        setP(newState);
        fstSnapshotRef.current = JSON.stringify(newState);
      })
      .catch(() => {
        // Fallback: just reset snapshot so dirty clears without changing form
        fstSnapshotRef.current = JSON.stringify(p);
        setP(prev => ({ ...prev })); // force re-render so isDirty recalculates
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discardSeq]);

  // ── Cmd+S / Ctrl+S shortcut ───────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (isDirty) handleWriteFst(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, fstPath]);

  // ── Stop ──────────────────────────────────────────────────────────────────────
  const handleStop = () => {
    if (pidRef.current !== null) {
      invoke("kill_pid", { pid: pidRef.current }).catch(() => {});
      pidRef.current = null;
    }
    unlistenRef.current.forEach(fn => fn?.());
    setRunning(false);
    onSimRunningChange?.(false);
    onPidChange?.(null);
    onLog?.("warn", "Stopped by user.");
    toast.warning("Simulation stopped", { description: "Stopped by user" });
  };

  // ── Run ───────────────────────────────────────────────────────────────────────
  const handleRun = async () => {
    if (!ofBinPath) { onLog?.("error", "OpenFAST binary not found — open Settings (⚙ in the sidebar footer) to configure the binary path."); return; }
    if (!project)   { onLog?.("error", "Open a project folder first."); return; }
    if (!fstPath)   { onLog?.("error", "No model loaded — add one from the sidebar first."); return; }
    setRunning(true);
    setRunPct(0);
    onSimRunningChange?.(true);
    toast.info("Simulation started", { description: effectiveCaseName });

    const resultsDir = project.resultsDir ?? `${project.workingDir}/results`;
    const caseName   = effectiveCaseName;
    // Stem used by OpenFAST to name its output files (matches the .fst filename).
    const fstStem    = fstPath.split("/").pop().replace(/\.fst$/i, "");

    // Per-run subdirectory structure — mirrors Batch Run layout.
    const caseRoot = `${resultsDir}/${caseName}`;
    const outbDir  = `${caseRoot}/outb`;
    const inpDir   = `${caseRoot}/inp`;

    try {
      // 0 — Auto-save if dirty so the file on disk matches what will be run.
      if (isDirty) {
        await invoke("write_text_file", { path: fstPath, content: buildFstContent(p, fstStem) });
        fstSnapshotRef.current = JSON.stringify(p); // clear dirty flag
        onLog?.("ok", `Auto-saved ${fstPath.split("/").pop()} before run`);
      }

      // ── Build run copies in inp/ — model folder is never written to ──────────
      // Read original .fst content (already auto-saved above if it was dirty).
      const origFst = await invoke("read_text_file", { path: fstPath });

      // Build the InflowWind content in memory (no in-place patching of the original).
      let ifwContent = null;
      if (inflowwindPath) {
        ifwContent = await invoke("read_text_file", { path: inflowwindPath }).catch(() => null);
      }
      if (ifwContent && windType !== null) {
        if (windType === 1 && hWindSpeed) {
          ifwContent = patchContentKey(ifwContent, "HWindSpeed", hWindSpeed);
          onLog?.("ok", `Wind: steady ${hWindSpeed} m/s`);
        } else if (windType === 3 && btsFile) {
          const opt     = btsOptions.find(o => o.name === btsFile);
          const btsPath = (opt
            ? opt.path
            : `${project.windDir ?? `${project.workingDir}/wind`}/${btsFile}`
          ).replace(/\\/g, "/");
          ifwContent = patchContentKey(ifwContent, "FileName_BTS", `"${btsPath}"`);
          onLog?.("ok", `Wind: BTS → ${btsFile}`);
        }
      }

      // Write the patched InflowWind copy to inp/.
      const runIfwPath = `${inpDir}/inflowwind.dat`;
      if (ifwContent) {
        await invoke("write_text_file", { path: runIfwPath, content: ifwContent });
      }

      // Build the .fst copy: absolute paths for all sub-module files + new InflowWind.
      const runFstContent = buildRunFst(origFst, fstDir, ifwContent ? runIfwPath : inflowwindPath ?? "");
      const runFstPath    = `${inpDir}/${caseName}.fst`;
      await invoke("write_text_file", { path: runFstPath, content: runFstContent });

      onLog?.("info", `Run copy written to inp/ — model folder will stay clean.`);

      const startedAt   = new Date().toISOString();
      const FATAL_RE    = /FATAL\s+ERROR|OpenFAST\s+FATAL|FAST_InitializeAll\s+error/i;
      const PROGRESS_RE = /\s+Time:\s+([\d.]+)\s+of\s+([\d.]+)/i;
      let hasFatalError = false;
      let fatalMsg      = "";

      const ul0 = await listen("binary-pid", evt => {
        pidRef.current = Number(evt.payload);
        onPidChange?.(pidRef.current);
      });
      const ul1 = await listen("binary-stdout", evt => {
        const line = String(evt.payload);
        if (FATAL_RE.test(line)) { hasFatalError = true; fatalMsg = line.trim().slice(0, 200); }
        const pm = PROGRESS_RE.exec(line);
        if (pm) setRunPct(Math.min(100, Math.round((parseFloat(pm[1]) / parseFloat(pm[2])) * 100)));
        onLog?.("info", line);
      });
      const ul2 = await listen("binary-stderr", evt => onLog?.("warn", `[stderr] ${evt.payload}`));
      const ul3 = await listen("binary-done", async (evt) => {
        ul0(); ul1(); ul2(); ul3();
        pidRef.current = null;
        onPidChange?.(null);
        const payload = String(evt.payload ?? "");
        const exitOk  = payload === "ok";

        if (!exitOk || hasFatalError) {
          const msg = hasFatalError
            ? (fatalMsg || "OpenFAST FATAL ERROR — check the log above")
            : `OpenFAST exited with code ${payload.slice(4)}`;
          onLog?.("error", `Run failed: ${msg}`);
          toast.error("Simulation failed", { description: msg.slice(0, 120), duration: Infinity });
          setRunning(false);
          onSimRunningChange?.(false);
          return;
        }

        onLog?.("ok", "OpenFAST complete — moving outputs to outb/…");

        // 2 — Move outputs from inp/ → outb/
        // OpenFAST writes {stem}.* next to the .fst it was given (i.e. in inp/).
        for (const ext of ["outb", "out", "sum", "ech"]) {
          try {
            await invoke("rename_file", {
              src: `${inpDir}/${caseName}.${ext}`,
              dst: `${outbDir}/${caseName}.${ext}`,
            });
            onLog?.("ok", `  → ${caseName}/outb/${caseName}.${ext}`);
          } catch { /* ext not written for this run */ }
        }

        // 3 — Save run record
        const record = {
          name:          caseName,
          startedAt,
          finishedAt:    new Date().toISOString(),
          params:        { TMax: p.TMax, DT: p.DT, DT_Out: p.DT_Out, TStart: p.TStart },
          wind:          windType === 1 ? { type: "steady", speed: Number(hWindSpeed) }
                       : windType === 3 ? { type: "bts",    file: btsFile }
                       :                  { type: "other" },
          modelFst:      fstPath,
          output:        `${caseName}/outb/${caseName}.outb`,
          inputSnapshot: `${caseName}/inp/`,
        };
        try {
          await invoke("write_text_file", {
            path:    `${caseRoot}/run.json`,
            content: JSON.stringify(record, null, 2),
          });
        } catch {}

        toast.success("Simulation complete", { description: `${caseName}/outb/${caseName}.outb` });
        setRunning(false);
        onSimRunningChange?.(false);
      });
      unlistenRef.current = [ul0, ul1, ul2, ul3];

      // Run against the copy in inp/ — not the original model file.
      onLog?.("info", `Running: ${ofBinPath} ${caseName}.fst`);
      await invoke("run_binary", { binary: ofBinPath, args: [runFstPath] });
    } catch (err) {
      const msg = String(err);
      onLog?.("error", msg);
      toast.error("Simulation failed", { description: msg.slice(0, 120), duration: Infinity });
      setRunning(false);
      onSimRunningChange?.(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className={s.panel}>

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className={s.header}>
        <Gauge size={16} strokeWidth={1.8} className={s.headerIcon} />
        <h1 className={s.title}>OpenFAST</h1>
        <div style={{ flex: 1 }} />
        {fstPath && (
          <button className={`${s.headerBtn} ${s.headerBtnSecondary}`} onClick={handleViewFst}
            title="View actual .fst file on disk">
            <Eye size={12} strokeWidth={1.8} /> View .fst
          </button>
        )}
      </div>

      {/* ── Model bar ─────────────────────────────────────────────────────── */}
      {fstPath ? (
        <div className={s.loadedBar}>
          {isDirty && (
            <span className={s.loadedDotDirty} title="Unsaved changes" />
          )}
          <span className={s.loadedFileName}>{fstPath.replace(/\\/g, "/").split("/").pop()}</span>
          <span className={s.loadedFilePath}>
            {(() => { const pts = fstPath.replace(/\\/g, "/").split("/"); return pts.length > 2 ? "…/" + pts.slice(-3, -1).join("/") : pts.slice(0, -1).join("/"); })()}
          </span>
          {/* Save button — disabled when nothing has changed */}
          <button
            className={[s.loadedSaveBtn, !isDirty ? s.loadedSaveBtnInactive : ""].join(" ")}
            onClick={!isDirty ? undefined : handleWriteFst}
            title={isDirty ? "Save changes to .fst (⌘S)" : "No unsaved changes"}
          >
            <Save size={11} strokeWidth={2} /> Save
          </button>
        </div>
      ) : (
        <div className={s.noModelBar}>
          <span className={s.noModelText}>No turbine model loaded — use the <strong>+</strong> button in the sidebar to add a model</span>
        </div>
      )}

      {showRaw && (
        <RawFileModal
          content={rawContent}
          filename={fstPath ? fstPath.split("/").pop() : `${effectiveCaseName}.fst`}
          fromDisk={!!fstPath}
          filePath={fstPath}
          hasDirtyWarning={isDirty}
          onClose={() => setShowRaw(false)}
          onSaved={async (newContent) => {
            setRawContent(newContent);
            try {
              const kv    = parseFstLines(newContent);
              const tmax  = Number(kv.TMax);
              const dt    = Number(kv.DT);
              // Guard: if core numeric fields are missing or non-numeric, the file
              // is malformed. Do NOT update p — it would silently show defaults.
              if (!kv.EDFile || !(tmax > 0) || !(dt > 0)) {
                throw new Error("core fields (TMax, DT, EDFile) missing or invalid");
              }
              const newState = fstParsedToState(kv);
              newState.BinPath    = p.BinPath;
              newState.FilePrefix = p.FilePrefix;
              setP(newState);
              fstSnapshotRef.current = JSON.stringify(newState);
              onLog?.("ok", `Saved and re-parsed → ${fstPath.split("/").pop()}`);
            } catch (err) {
              // Keep current p unchanged — never overwrite UI with defaults.
              // fstSnapshotRef is intentionally NOT changed here; isDirty reflects
              // whether the form diverges from the last *parseable* snapshot on disk.
              onLog?.("warn", `Saved → ${fstPath.split("/").pop()} — file could not be validated (${err}). UI parameters were NOT updated. Fix the formatting and save again, or re-import from disk.`);
              throw err; // propagate so RawFileModal shows a warn toast
            }
          }}
        />
      )}

      {/* ── Tab bar ───────────────────────────────────────────────────────── */}
      <div className={s.tabBar}>
        {TABS.map(t => (
          <button
            key={t.id}
            className={`${s.tab} ${tab === t.id ? s.tabActive : ""}`}
            onClick={() => {
              const oldIdx = TABS.findIndex(x => x.id === tab);
              const newIdx = TABS.findIndex(x => x.id === t.id);
              tabDirRef.current = newIdx >= oldIdx ? 1 : -1;
              setTab(t.id);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Editor tabs: Simulation / Modules / Output ─────────────────── */}
      {tab !== "run" && tab !== "linearize" && (
        <div key={tab} className={`${s.formArea} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
          <div className={s.form}>

            {tab === "simulation" && (<>
              <SectionHead>Time settings</SectionHead>
              <div className={s.grid2}>
                <Field label="Total run time (TMax)" unit="s" info={{ param: "TMax", desc: "Total simulation time.", range: "> 0", unit: "s" }}>
                  <input type="number" value={p.TMax} min={1} step={10} onChange={setN("TMax")} />
                </Field>
                <Field label="Module time step (DT)" unit="s" info={{ param: "DT", desc: "Global fixed-step integration interval. All submodules use this step or a whole-number submultiple of it.", range: "> 0", unit: "s", note: "Smaller DT increases accuracy but proportionally increases computation time." }}>
                  <input type="number" value={p.DT} min={0.0001} step={0.001} onChange={setN("DT")} />
                </Field>
                <Field label="Output time step (DT_Out)" info={{ param: "DT_Out", desc: "Output write interval. 'default' uses DT; specify a value to downsample output.", default: '"default"', note: "When a number, must be a whole-number multiple of DT." }}>
                  <input type="text" value={p.DT_Out} onChange={e => setP(prev => ({ ...prev, DT_Out: e.target.value }))} onBlur={e => setP(prev => ({ ...prev, DT_Out: normalizeDtOut(e.target.value) }))} placeholder="default" />
                  <p className={s.hint}>"default" uses DT; enter a value (s) for coarser output</p>
                </Field>
                <Field label="Output start time (TStart)" unit="s" info={{ param: "TStart", desc: "Time at which output recording begins. Data before TStart is computed but not written to disk.", range: "≥ 0", unit: "s", default: "0.0" }}>
                  <input type="number" value={p.TStart} min={0} step={1} onChange={setN("TStart")} />
                </Field>
              </div>
              <SectionHead>Numerics</SectionHead>
              <div className={s.grid2}>
                <Field label="Interpolation order" info={{ param: "InterpOrder", desc: "Coupling data interpolation order between submodules.", range: "1 or 2", default: "2", note: "1 = linear (fast); 2 = quadratic (more accurate, especially when DT is large)." }}>
                  <select value={p.InterpOrder} onChange={setN("InterpOrder")}>
                    {INTERP_ORDERS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                  </select>
                </Field>
                <Field label="Corrector steps (NumCrctn)" info={{ param: "NumCorrSteps", desc: "Predictor–corrector iterations per time step.", range: "0–20", default: "0", note: "0 = explicit predictor only; ≥1 adds implicit correction passes for tighter module coupling." }}>
                  <input type="number" value={p.NumCorrSteps} min={0} max={20} step={1} onChange={setN("NumCorrSteps")} />
                  <p className={s.hint}>0 = explicit predictor only</p>
                </Field>
                <Field label="Jacobian interval (DT_UJac)" unit="s" title={p.NumCorrSteps === 0 ? "Unused when NumCrctn = 0 (explicit predictor). Set corrector steps ≥ 1 to activate." : undefined} info={{ param: "DT_UJac", desc: "How often the tight-coupling Jacobian is recomputed.", range: "> 0", unit: "s", default: "99999", note: "Set to 99999 to compute only once at initialisation." }}>
                  <input type="number" value={p.DT_UJac} min={0} step={1} onChange={setN("DT_UJac")} disabled={p.NumCorrSteps === 0} />
                  <p className={s.hint}>99999 = once at start</p>
                </Field>
                <Field label="Jacobian scale (UJacSclFact)" title={p.NumCorrSteps === 0 ? "Unused when NumCrctn = 0 (explicit predictor). Set corrector steps ≥ 1 to activate." : undefined} info={{ param: "UJacSclFact", desc: "Scale factor applied to Jacobian entries to improve matrix conditioning when mixing physical quantities of very different magnitudes.", range: "> 0", default: "1E+05" }}>
                  <input type="number" value={p.UJacSclFact} min={1} step={1e5} onChange={setN("UJacSclFact")} disabled={p.NumCorrSteps === 0} />
                </Field>
              </div>
              <SectionHead>Flags</SectionHead>
              <div className={s.toggleGrid}>
                <Toggle label="Echo input to .ech file" value={p.Echo} onChange={set("Echo")} info={{ param: "Echo", desc: "Write an echo of all parsed input files to <RootName>.ech.", default: "FALSE", note: "Useful for debugging input-file parsing errors. Produces a large text file." }} />
              </div>
              <Field label="Abort level" info={{ param: "AbortLevel", desc: "Error severity at which OpenFAST halts the simulation.", range: "WARNING · SEVERE · FATAL", default: "FATAL" }}>
                <select value={p.AbortLevel} onChange={setN("AbortLevel")}>
                  {ABORT_LEVELS.map((l, i) => <option key={i} value={i}>{l}</option>)}
                </select>
              </Field>
              <SectionHead>Environmental conditions</SectionHead>
              <div className={s.grid2}>
                <Field label="Gravity" unit="m/s²" info={{ param: "Gravity", desc: "Gravitational acceleration.", range: "≥ 0", unit: "m/s²", default: "9.80665" }}>
                  <input type="number" value={p.Gravity} step={0.001} onChange={setN("Gravity")} />
                </Field>
                <Field label="Air density (AirDens)" unit="kg/m³" info={{ param: "AirDens", desc: "Density of the working fluid.", range: "> 0", unit: "kg/m³", default: "1.225", note: "For wind turbines use air (~1.225 kg/m³ at sea level, 15 °C). For MHK turbines use water (~1025 kg/m³)." }}>
                  <input type="number" value={p.AirDens} step={0.001} min={0} onChange={setN("AirDens")} />
                </Field>
                <Field label="Kinematic viscosity (KinVisc)" unit="m²/s" info={{ param: "KinVisc", desc: "Kinematic viscosity of the working fluid.", range: "> 0", unit: "m²/s", default: "1.464E-5", note: "Air ≈ 1.464×10⁻⁵ m²/s; water ≈ 1×10⁻⁶ m²/s at 20 °C." }}>
                  <input type="number" value={p.KinVisc} step={1e-7} min={0} onChange={setN("KinVisc")} />
                </Field>
                <Field label="Speed of sound (SpdSound)" unit="m/s" info={{ param: "SpdSound", desc: "Speed of sound in the working fluid. Used for compressibility corrections in aerodynamic modules.", range: "> 0", unit: "m/s", default: "335.0" }}>
                  <input type="number" value={p.SpdSound} step={1} min={0} onChange={setN("SpdSound")} />
                </Field>
                <Field label="Water density (WtrDens)" unit="kg/m³" title={!isOffshore ? "Enable SeaState, HydroDyn, SubDyn, or MHK mode to activate water properties." : undefined} info={{ param: "WtrDens", desc: "Density of water. Used by HydroDyn and SubDyn for buoyancy and hydrodynamic load calculations.", range: "> 0", unit: "kg/m³", default: "1025.0", note: "Offshore / MHK simulations only." }}>
                  <input type="number" value={p.WtrDens} step={1} min={0} onChange={setN("WtrDens")} disabled={!isOffshore} />
                  <p className={s.hint}>Offshore / MHK only</p>
                </Field>
                <Field label="Water depth (WtrDpth)" unit="m" title={!isOffshore ? "Enable SeaState, HydroDyn, SubDyn, or MHK mode to activate water properties." : undefined} info={{ param: "WtrDpth", desc: "Water depth below still water level, positive downward.", range: "> 0", unit: "m", note: "Used by HydroDyn for wave kinematics and loading. Offshore / MHK only." }}>
                  <input type="number" value={p.WtrDpth} step={1} min={0} onChange={setN("WtrDpth")} disabled={!isOffshore} />
                  <p className={s.hint}>Offshore / MHK only</p>
                </Field>
                <Field label="Atm. pressure (Patm)" unit="Pa" title={!isMHK ? "Used only for MHK turbine cavitation checks. Enable MHK mode in the Modules tab." : undefined} info={{ param: "Patm", desc: "Atmospheric pressure.", range: "> 0", unit: "Pa", default: "103500.0", note: "Used only for MHK turbine cavitation index checks." }}>
                  <input type="number" value={p.Patm} step={100} min={0} onChange={setN("Patm")} disabled={!isMHK} />
                  <p className={s.hint}>MHK cavitation check only</p>
                </Field>
                <Field label="Vapour pressure (Pvap)" unit="Pa" title={!isMHK ? "Used only for MHK turbine cavitation checks. Enable MHK mode in the Modules tab." : undefined} info={{ param: "Pvap", desc: "Vapour pressure of the working fluid.", range: "≥ 0", unit: "Pa", default: "1700.0", note: "Used only for MHK cavitation inception checks." }}>
                  <input type="number" value={p.Pvap} step={10} min={0} onChange={setN("Pvap")} disabled={!isMHK} />
                  <p className={s.hint}>MHK cavitation check only</p>
                </Field>
                <Field label="MSL to SWL offset (MSL2SWL)" unit="m" title={!isOffshore ? "Enable SeaState, HydroDyn, SubDyn, or MHK mode to activate water properties." : undefined} info={{ param: "MSL2SWL", desc: "Vertical offset from mean sea level (MSL) to still water level (SWL), positive upward.", unit: "m", default: "0.0", note: "Offshore simulations only." }}>
                  <input type="number" value={p.MSL2SWL} step={0.1} onChange={setN("MSL2SWL")} disabled={!isOffshore} />
                  <p className={s.hint}>Positive upward; offshore only</p>
                </Field>
              </div>
            </>)}

            {tab === "modules" && (<>
              <SectionHead>Module coupling</SectionHead>
              <div className={s.moduleGrid}>
                <ModuleRow compact title="ElastoDyn"          compOptions={COMP_ELAST}   value={p.CompElast}   onChange={set("CompElast")}   fileKey="EDFile"      fileValue={p.EDFile}      onFileChange={v => setP(prev => ({ ...prev, EDFile:      v }))} onBrowse={() => browseFile("EDFile")}      />
                <ModuleRow compact title="InflowWind"         compOptions={COMP_INFLOW}  value={p.CompInflow}  onChange={setCompInflow}      fileKey="InflowFile"  fileValue={p.InflowFile}  onFileChange={v => setP(prev => ({ ...prev, InflowFile:  v }))} onBrowse={() => browseFile("InflowFile")}  />
                <ModuleRow compact title="AeroDyn"            compOptions={COMP_AERO}    value={p.CompAero}    onChange={set("CompAero")}    fileKey="AeroFile"    fileValue={p.AeroFile}    onFileChange={v => setP(prev => ({ ...prev, AeroFile:    v }))} onBrowse={() => browseFile("AeroFile")}
                  lockedAbove={p.CompInflow === 0 ? 1 : undefined}
                  lockedAboveTitle="AeroDyn requires InflowWind (CompInflow ≥ 1). Enable InflowWind first." />
                <ModuleRow compact title="ServoDyn"           compOptions={COMP_SERVO}   value={p.CompServo}   onChange={set("CompServo")}   fileKey="ServoFile"   fileValue={p.ServoFile}   onFileChange={v => setP(prev => ({ ...prev, ServoFile:   v }))} onBrowse={() => browseFile("ServoFile")}   />
                <ModuleRow compact title="SeaState"           compOptions={COMP_SEAST}   value={p.CompSeaSt}   onChange={setCompSeaSt}       fileKey="SeaStFile"   fileValue={p.SeaStFile}   onFileChange={v => setP(prev => ({ ...prev, SeaStFile:   v }))} onBrowse={() => browseFile("SeaStFile")}   />
                <ModuleRow compact title="HydroDyn"           compOptions={COMP_HYDRO}   value={p.CompHydro}   onChange={set("CompHydro")}   fileKey="HydroFile"   fileValue={p.HydroFile}   onFileChange={v => setP(prev => ({ ...prev, HydroFile:   v }))} onBrowse={() => browseFile("HydroFile")}
                  lockedReason={p.CompSeaSt === 0 ? "HydroDyn requires SeaState (CompSeaSt ≥ 1). Enable SeaState first." : undefined} />
                <ModuleRow compact title="SubDyn"             compOptions={COMP_SUB}     value={p.CompSub}     onChange={set("CompSub")}     fileKey="SubFile"     fileValue={p.SubFile}     onFileChange={v => setP(prev => ({ ...prev, SubFile:     v }))} onBrowse={() => browseFile("SubFile")}     />
                <ModuleRow compact title="MoorDyn / Mooring"  compOptions={COMP_MOORING} value={p.CompMooring} onChange={set("CompMooring")} fileKey="MooringFile" fileValue={p.MooringFile} onFileChange={v => setP(prev => ({ ...prev, MooringFile: v }))} onBrowse={() => browseFile("MooringFile")} />
                <ModuleRow compact title="IceFloe / IceDyn"   compOptions={COMP_ICE}     value={p.CompIce}     onChange={set("CompIce")}     fileKey="IceFile"     fileValue={p.IceFile}     onFileChange={v => setP(prev => ({ ...prev, IceFile:     v }))} onBrowse={() => browseFile("IceFile")}     />
              </div>
              <Collapsible title="BeamDyn blade files (CompElast = 2)">
                {p.CompElast !== 2 && (
                  <p className={s.hint} style={{ marginBottom: 12 }}>
                    Active only when CompElast = 2 (ElastoDyn + BeamDyn blades). Change the ElastoDyn selector above to unlock.
                  </p>
                )}
                <div className={s.grid1}>
                  {[["BDBldFile1","Blade 1"],["BDBldFile2","Blade 2"],["BDBldFile3","Blade 3"]].map(([key, label]) => (
                    <Field key={key} label={label} title={p.CompElast !== 2 ? "Active only when CompElast = 2 (ElastoDyn + BeamDyn blades). Change the ElastoDyn selector above to unlock." : undefined}>
                      <div className={s.fileRow}>
                        <input type="text" value={p[key]} onChange={e => setP(prev => ({ ...prev, [key]: e.target.value }))} disabled={p.CompElast !== 2} />
                        <button className={s.browseBtn} onClick={() => browseFile(key)} disabled={p.CompElast !== 2}><FolderOpen size={12} strokeWidth={1.8} /> Browse</button>
                      </div>
                    </Field>
                  ))}
                </div>
              </Collapsible>
              <Collapsible title="MHK settings">
                <Field label="MHK turbine type">
                  <select value={p.MHK} onChange={setN("MHK")}>
                    <option value={0}>0 — Not an MHK turbine</option>
                    <option value={1}>1 — Tidal MHK turbine</option>
                    <option value={2}>2 — Current MHK turbine</option>
                  </select>
                </Field>
              </Collapsible>
            </>)}

            {tab === "output" && (<>
              <SectionHead>Output format</SectionHead>
              <div className={s.grid2}>
                <Field label="Output file format" info={{ param: "OutFileFmt", desc: "Format of the time-series output file.", range: "1–5", default: "1", note: "1/3/5 include text (.out); 2/4 are binary only. Binary is smaller and faster to write. Options 4 and 5 use uncompressed binary (universally readable but larger than compressed)." }}>
                  <select value={p.OutFileFmt} onChange={setN("OutFileFmt")}>
                    {OUT_FMT_OPTS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                  </select>
                </Field>
                <Field label="Column format (OutFmt)" title={p.OutFileFmt === 2 || p.OutFileFmt === 4 ? "Applies to text output only. Switch to a format that includes .out (1, 3, or 5)." : undefined} info={{ param: "OutFmt", desc: "Fortran format specifier for each numeric output column.", default: '"ES10.3E2"', note: "The result must be exactly 10 characters wide (e.g. ES10.3E2, F10.4)." }}>
                  <input type="text" value={p.OutFmt} onChange={setE("OutFmt")} disabled={p.OutFileFmt === 2 || p.OutFileFmt === 4} />
                  <p className={s.hint}>Text output only — inactive when format is Binary</p>
                </Field>
              </div>
              <SectionHead>Flags</SectionHead>
              <div className={s.toggleGrid}>
                <Toggle label="Write .sum summary file (SumPrint)" value={p.SumPrint} onChange={set("SumPrint")} info={{ param: "SumPrint", desc: "Write a summary file (<RootName>.sum) containing model properties, DOF configuration, and time-integration info.", default: "FALSE" }} />
                <Toggle label="Tab-delimited text output (TabDelim)" value={p.TabDelim} onChange={set("TabDelim")} disabled={p.OutFileFmt === 2 || p.OutFileFmt === 4} title={p.OutFileFmt === 2 || p.OutFileFmt === 4 ? "Applies to text output only. Switch to a format that includes .out (1, 3, or 5)." : undefined} info={{ param: "TabDelim", desc: "Separate output columns with tab characters instead of spaces.", default: "TRUE", note: "Makes the .out file directly importable into Excel and most scientific data tools." }} />
              </div>
              <SectionHead>Timing</SectionHead>
              <div className={s.grid2}>
                <Field label="Screen status interval (SttsTime)" unit="s" info={{ param: "SttsTime", desc: "Interval for printing simulation progress to the terminal.", range: "≥ 0", unit: "s", default: "999.0", note: "Set to 0 to print status at every time step." }}>
                  <input type="number" value={p.SttsTime} min={0} step={1} onChange={setN("SttsTime")} />
                  <p className={s.hint}>0 = every time step</p>
                </Field>
                <Field label="Checkpoint interval (ChkptTime)" unit="s" info={{ param: "ChkptTime", desc: "Interval for writing binary restart checkpoint files.", range: "≥ 0", unit: "s", default: "99999.9", note: "Set to 99999.9 to disable. Checkpoint files allow resuming a simulation after a crash." }}>
                  <input type="number" value={p.ChkptTime} min={0} step={1000} onChange={setN("ChkptTime")} />
                  <p className={s.hint}>99999.9 = never</p>
                </Field>
              </div>
            </>)}

          </div>
        </div>
      )}

      {/* ── Linearize tab ────────────────────────────────────────────── */}
      {tab === "linearize" && (
        <div key={tab} className={`${s.formArea} ${s.tabEnterRight}`}>
          <div className={s.form}>
            <SectionHead>Linearization</SectionHead>
            <div className={s.toggleGrid}>
              <Toggle label="Enable linearization (Linearize)" value={p.Linearize} onChange={set("Linearize")} info={{ param: "Linearize", desc: "Activate linearization analysis. OpenFAST produces state-space matrices (A, B, C, D) at each specified azimuth angle.", default: "FALSE" }} />
              <Toggle label="Find steady-state operating point first (CalcSteady)" value={p.CalcSteady} onChange={set("CalcSteady")} disabled={!p.Linearize} title={!p.Linearize ? "Enable Linearize first." : undefined} info={{ param: "CalcSteady", desc: "Compute a periodic steady-state operating point before linearising.", default: "FALSE", note: "Required when rotor speed needs to be trimmed to rated. The trim routine runs before linearisation begins." }} />
            </div>
            <div className={s.grid2}>
              <Field label="Trim control (TrimCase)" title={!p.Linearize || !p.CalcSteady ? (!p.Linearize ? "Enable Linearize first, then enable CalcSteady." : "Enable CalcSteady to use trim settings.") : undefined} info={{ param: "TrimCase", desc: "Which actuator to use during the steady-state trim.", range: "1–3", default: "3", note: "1 = yaw angle; 2 = generator torque; 3 = collective blade pitch." }}>
                <select value={p.TrimCase} onChange={setN("TrimCase")} disabled={!p.Linearize || !p.CalcSteady}>
                  <option value={1}>1 — Yaw</option>
                  <option value={2}>2 — Torque</option>
                  <option value={3}>3 — Pitch</option>
                </select>
                <p className={s.hint}>Used only when CalcSteady = True</p>
              </Field>
              <Field label="Speed convergence tolerance (TrimTol)" title={!p.Linearize || !p.CalcSteady ? (!p.Linearize ? "Enable Linearize first, then enable CalcSteady." : "Enable CalcSteady to use trim settings.") : undefined} info={{ param: "TrimTol", desc: "Rotor speed error tolerance for the trim convergence criterion.", range: "> 0", default: "1.0E-4", note: "Smaller values give a more accurate operating point but take longer to converge." }}>
                <input type="number" value={p.TrimTol} step={0.0001} min={0} onChange={setN("TrimTol")} disabled={!p.Linearize || !p.CalcSteady} />
                <p className={s.hint}>Used only when CalcSteady = True</p>
              </Field>
              <Field label="Speed error gain (TrimGain)" title={!p.Linearize || !p.CalcSteady ? (!p.Linearize ? "Enable Linearize first, then enable CalcSteady." : "Enable CalcSteady to use trim settings.") : undefined} info={{ param: "TrimGain", desc: "Proportional gain for the trim feedback loop.", range: "> 0", default: "0.001", note: "Increase if convergence is slow; reduce if the trim oscillates." }}>
                <input type="number" value={p.TrimGain} step={0.001} min={0} onChange={setN("TrimGain")} disabled={!p.Linearize || !p.CalcSteady} />
              </Field>
              <Field label="Tower damping (Twr_Kdmp)" unit="N/(m/s)" title={!p.Linearize || !p.CalcSteady ? (!p.Linearize ? "Enable Linearize first, then enable CalcSteady." : "Enable CalcSteady to use trim settings.") : undefined} info={{ param: "Twr_Kdmp", desc: "Artificial dashpot gain added to tower DOFs during the trim phase to suppress transients.", range: "≥ 0", unit: "N/(m/s)", default: "0.0" }}>
                <input type="number" value={p.Twr_Kdmp} step={0.1} min={0} onChange={setN("Twr_Kdmp")} disabled={!p.Linearize || !p.CalcSteady} />
              </Field>
              <Field label="Blade damping (Bld_Kdmp)" unit="N/(m/s)" title={!p.Linearize || !p.CalcSteady ? (!p.Linearize ? "Enable Linearize first, then enable CalcSteady." : "Enable CalcSteady to use trim settings.") : undefined} info={{ param: "Bld_Kdmp", desc: "Artificial dashpot gain added to blade DOFs during the trim phase to suppress transients.", range: "≥ 0", unit: "N/(m/s)", default: "0.0" }}>
                <input type="number" value={p.Bld_Kdmp} step={0.1} min={0} onChange={setN("Bld_Kdmp")} disabled={!p.Linearize || !p.CalcSteady} />
              </Field>
            </div>
            <SectionHead>Linearization schedule</SectionHead>
            <div className={s.grid2}>
              <Field label="Number of linearization points (NLinTimes)" title={!p.Linearize ? "Enable Linearize first." : undefined} info={{ param: "NLinTimes", desc: "Number of azimuth angles per revolution at which to linearise.", range: "≥ 1", default: "2", note: "Points are evenly distributed from 0° to 360°. More points give better rotor-averaged matrices." }}>
                <input type="number" value={p.NLinTimes} step={1} min={1} onChange={setN("NLinTimes")} disabled={!p.Linearize} />
              </Field>
              <Field label="Linearization times (LinTimes)" unit="s" title={!p.Linearize ? "Enable Linearize first." : p.CalcSteady ? "CalcSteady = True — azimuth schedule is computed automatically; explicit times are ignored." : undefined} info={{ param: "LinTimes", desc: "Explicit simulation times at which to linearise, comma-separated.", unit: "s", default: "30, 60", note: "Ignored when CalcSteady is true — azimuth angles are used instead." }}>
                <input type="text" value={p.LinTimes} onChange={setE("LinTimes")} disabled={!p.Linearize || p.CalcSteady}
                  placeholder="e.g. 30, 60" />
                <p className={s.hint}>Unused when CalcSteady = True — azimuth schedule is computed instead</p>
              </Field>
            </div>
            <SectionHead>Linearization outputs</SectionHead>
            <div className={s.grid2}>
              <Field label="Inputs (LinInputs)" title={!p.Linearize ? "Enable Linearize first." : undefined} info={{ param: "LinInputs", desc: "Which system inputs to include in the linearized model.", range: "0–2", default: "1", note: "0 = none; 1 = standard control/disturbance inputs; 2 = all module inputs (large files, debug use)." }}>
                <select value={p.LinInputs} onChange={setN("LinInputs")} disabled={!p.Linearize}>
                  <option value={0}>0 — None</option>
                  <option value={1}>1 — Standard</option>
                  <option value={2}>2 — All module inputs (debug)</option>
                </select>
              </Field>
              <Field label="Outputs (LinOutputs)" title={!p.Linearize ? "Enable Linearize first." : undefined} info={{ param: "LinOutputs", desc: "Which system outputs to include in the linearized model.", range: "0–2", default: "1", note: "0 = none; 1 = user-defined OutList channels; 2 = all module outputs (large files, debug use)." }}>
                <select value={p.LinOutputs} onChange={setN("LinOutputs")} disabled={!p.Linearize}>
                  <option value={0}>0 — None</option>
                  <option value={1}>1 — From OutList</option>
                  <option value={2}>2 — All module outputs (debug)</option>
                </select>
              </Field>
            </div>
            <div className={s.toggleGrid}>
              <Toggle label="Write full Jacobians to linearization file (LinOutJac)" value={p.LinOutJac} onChange={set("LinOutJac")} disabled={!p.Linearize} title={!p.Linearize ? "Enable Linearize first." : undefined} info={{ param: "LinOutJac", desc: "Append the full input/output Jacobian matrices to the .lin file.", default: "FALSE", note: "Creates large files; mainly useful for debugging module coupling." }} />
              <Toggle label="Write module-level linearization files (LinOutMod)" value={p.LinOutMod} onChange={set("LinOutMod")} disabled={!p.Linearize} title={!p.Linearize ? "Enable Linearize first." : undefined} info={{ param: "LinOutMod", desc: "Write separate .lin files for each submodule (ElastoDyn, AeroDyn, etc.) in addition to the combined system file.", default: "FALSE" }} />
            </div>

            <SectionHead>VTK visualization</SectionHead>
            <div className={s.grid2}>
              <Field label="VTK output mode (WrVTK)" info={{ param: "WrVTK", desc: "Controls VTK file generation for 3-D visualization.", range: "0–3", default: "0", note: "0 = none; 1 = mesh geometry at init only; 2 = full animation; 3 = mode shape animation (requires linearization)." }}>
                <select value={p.WrVTK} onChange={setN("WrVTK")}>
                  <option value={0}>0 — None</option>
                  <option value={1}>1 — Initialization data only</option>
                  <option value={2}>2 — Animation</option>
                  <option value={3}>3 — Mode shapes</option>
                </select>
              </Field>
              <Field label="VTK data type (VTK_type)" info={{ param: "VTK_type", desc: "Level of mesh detail written to VTK files.", range: "1–3", default: "1", note: "1 = surface representations; 2 = basic line/point meshes; 3 = all internal mesh lines (debug, very large files)." }}>
                <select value={p.VTK_type} onChange={setN("VTK_type")} disabled={p.WrVTK === 0}>
                  <option value={1}>1 — Surfaces</option>
                  <option value={2}>2 — Basic meshes (lines/points)</option>
                  <option value={3}>3 — All meshes (debug)</option>
                </select>
              </Field>
              <Field label="Frame rate (VTK_fps)" unit="fps" info={{ param: "VTK_fps", desc: "Target animation frame rate for VTK output.", range: "> 0", unit: "fps", default: "15", note: "Rounded to the nearest integer multiple of DT. Only applies when WrVTK = 2 or 3." }}>
                <input type="number" value={p.VTK_fps} step={1} min={1} onChange={setN("VTK_fps")} disabled={p.WrVTK < 2} />
                <p className={s.hint}>Rounded to nearest integer multiple of DT; used when WrVTK = 2 or 3</p>
              </Field>
            </div>
            <div className={s.toggleGrid}>
              <Toggle label="Write mesh fields to VTK files (VTK_fields)" value={p.VTK_fields} onChange={set("VTK_fields")} disabled={p.WrVTK === 0} title={p.WrVTK === 0 ? "Select a VTK output mode first (WrVTK ≥ 1)." : undefined} info={{ param: "VTK_fields", desc: "Additionally write mesh field data (velocities, accelerations, forces) to VTK files.", default: "FALSE", note: "Significantly increases output file size." }} />
            </div>
          </div>
        </div>
      )}

      {/* ── Run tab: 4-row dashboard ─────────────────────────────────── */}
      {tab === "run" && (
        <div className={s.runTab}>

          {/* ── Row 1: Sim params (left) | Turbine SVG (right) ── */}
          <div className={s.runCardsRow} style={{ "--row-idx": 0 }}>

            {/* Left: simulation parameters — 2×2 grid */}
            <div className={s.runCard}>
              <span className={s.sectionHead}>Simulation parameters</span>
              <div className={s.paramGrid}>
                <EditableParam label="TMax"   unit="s" value={p.TMax}   step={10}    min={1}      onChange={v => setP(prev => ({ ...prev, TMax:   v }))} />
                <EditableParam label="DT"     unit="s" value={p.DT}     step={0.001} min={0.0001} onChange={v => setP(prev => ({ ...prev, DT:     v }))} />
                <EditableParam label="TStart" unit="s" value={p.TStart} step={1}     min={0}      onChange={v => setP(prev => ({ ...prev, TStart: v }))} />
                <EditableParam label="DT_Out"           value={p.DT_Out} isString                 onChange={v => setP(prev => ({ ...prev, DT_Out: normalizeDtOut(v) }))} />
              </div>
            </div>

            {/* Right: turbine SVG with absolute corner stats */}
            <div className={[s.runCard, s.turbineCard].join(" ")}>
              {/* SVG fills entire card */}
              <div className={s.turbineCardInner}>
                {running && <div className={s.heroPulse} />}
                <TurbineIcon
                  spinning={running}
                  className={[s.turbineScalable, running ? s.heroTurbineRunning : ""].join(" ")}
                />
              </div>
              {/* Corner stats */}
              <div className={[s.tcCorner, s.tcTopLeft].join(" ")}>
                <span className={s.tcVal}>
                  {windType === 1 ? hWindSpeed : windType === 3 ? "BTS" : windType === 2 ? "—" : "—"}
                </span>
                <span className={s.tcLabel}>Wind m/s</span>
              </div>
              <div className={[s.tcCorner, s.tcTopRight].join(" ")}>
                <span className={s.tcVal}>{p.TMax}</span>
                <span className={s.tcLabel}>Duration s</span>
              </div>
              <div className={[s.tcCorner, s.tcBottomLeft].join(" ")}>
                <span className={s.tcVal}>{modelMeta?.hubHeight ?? edHubHeight ?? "—"}</span>
                <span className={s.tcLabel}>Hub m</span>
              </div>
              <div className={[s.tcCorner, s.tcBottomRight].join(" ")}>
                <span className={s.tcVal}>{Math.round(p.TMax / p.DT).toLocaleString()}</span>
                <span className={s.tcLabel}>Steps</span>
              </div>
              {/* Bottom strip: progress bar when running, model meta otherwise */}
              <div className={s.tcBottom}>
                {running ? (
                  <div className={s.heroProgressWrap}>
                    <div className={s.heroRunning}>
                      <span className={s.heroRunningDot} />
                      <span style={{ flex: 1 }}>Running {effectiveCaseName}…</span>
                      <span className={s.heroPct}>{runPct}%</span>
                    </div>
                    <div className={s.heroBarTrack}>
                      <div className={s.heroBarFill} style={{ transform: `scaleX(${runPct / 100})` }} />
                    </div>
                  </div>
                ) : modelMeta ? (
                  <div className={s.heroMeta}>
                    {modelMeta.ratedPower    && <span>{(modelMeta.ratedPower / 1000).toFixed(1)} MW</span>}
                    {modelMeta.rotorDiameter && <span>Ø {modelMeta.rotorDiameter} m</span>}
                    {modelMeta.badge         && <span className={s.heroMetaBadge}>{modelMeta.badge}</span>}
                  </div>
                ) : null}
              </div>
            </div>

          </div>

          {/* ── Row 2: Wind source + Active modules (left) | Case name + Run (right) ── */}
          <div className={s.runCardsRow} style={{ "--row-idx": 1 }}>

            {/* Left: wind source (top) + active modules (bottom) */}
            <div className={s.runCard}>
              <span className={s.sectionHead}>Wind source</span>

              {/* Three-way segmented control: Steady | BTS | Uniform */}
              <div className={s.windSeg}>
                {[{ wt: 1, label: "Steady" }, { wt: 3, label: "BTS" }, { wt: 2, label: "Uniform" }].map(({ wt, label }) => (
                  <button
                    key={wt}
                    className={[s.windSegBtn, windType === wt ? s.windSegBtnActive : ""].join(" ")}
                    onClick={() => handleWindTypeChange(wt)}
                    disabled={!fstPath}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {windType === 1 && (
                <div>
                  <span className={s.rzLabel} style={{ marginBottom: 4, display: "block" }}>Wind speed</span>
                  <div className={s.windRow}>
                    <input
                      type="text"
                      inputMode="decimal"
                      className={s.rzInput}
                      value={hWindSpeed}
                      style={{ flex: 1 }}
                      onChange={e => setHWindSpeed(e.target.value)}
                      onBlur={handleHWindSpeedBlur}
                    />
                    <span className={s.windUnit}>m/s steady</span>
                  </div>
                </div>
              )}

              {windType === 3 && (
                <div>
                  <span className={s.rzLabel} style={{ marginBottom: 4, display: "block" }}>Wind file</span>
                  {btsOptions.length === 0
                    ? <p className={s.rzDim}>No .bts files — run TurbSim first</p>
                    : <select
                        className={s.rzSelect}
                        value={btsFile}
                        onChange={e => handleBtsFileChange(e.target.value)}
                      >
                        <option value="">— {btsOptions.length} file{btsOptions.length !== 1 ? "s" : ""} found —</option>
                        {btsOptions.map(o => (
                          <option key={o.path} value={o.name}>{o.rel}</option>
                        ))}
                      </select>
                  }
                  {/* TMax over-run hint — shown when BTS usable time < TMax */}
                  {btsTMaxOver && (
                    <div className={s.btsHint}>
                      <Wind size={13} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
                      <span>
                        BTS usable time <strong>{btsUsableTime.toFixed(1)} s</strong> — TMax is {p.TMax} s.
                        Reduce to avoid a fatal error.
                      </span>
                      <button
                        className={s.btsHintApply}
                        onClick={() => setP(prev => ({ ...prev, TMax: Math.floor(btsUsableTime) }))}
                      >
                        Apply {Math.floor(btsUsableTime)} s
                      </button>
                    </div>
                  )}
                </div>
              )}

              {windType === 2 && (
                <p className={s.rzDim} style={{ marginTop: 4 }}>
                  Uniform wind — configure in InflowWind →
                </p>
              )}

              {!fstPath && (
                <p className={s.rzDim}>Load a model first</p>
              )}

              <div className={s.cardDivider} />

              {/* Active modules — moved here from the right card */}
              <span className={s.sectionHead}>Active modules</span>
              {fstPath ? (
                <div className={s.pillsWrap}>
                  {MODULE_PILL_DEFS.map(m => {
                    const active        = p[m.comp] > 0;
                    const isWarnPill    = m.id === "servodyn" && !active && showServoDynWarn;
                    return (
                      <button
                        key={m.id}
                        className={[
                          s.modulePill,
                          active       ? s.modulePillOn   : s.modulePillOff,
                          isWarnPill   ? s.modulePillWarn : "",
                        ].join(" ")}
                        onClick={() => setP(prev => ({ ...prev, [m.comp]: active ? 0 : m.defaultVal }))}
                        title={
                          isWarnPill
                            ? "ServoDyn disabled — no pitch/torque control. Click to enable."
                            : active
                            ? `${m.label} enabled — click to disable`
                            : `${m.label} disabled — click to enable`
                        }
                      >
                        {isWarnPill && (
                          <AlertTriangle size={10} strokeWidth={2.5} style={{ flexShrink: 0 }} />
                        )}
                        {m.label}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className={s.rzDim}>Load a model first</p>
              )}
            </div>

            {/* Right: case name (top) + ServoDyn warning + run button (bottom) */}
            <div className={[s.runCard, s.runCardRight].join(" ")}>
              <span className={s.sectionHead}>Case name</span>
              <input
                className={s.rzInput}
                value={p.FilePrefix}
                placeholder={suggestedNames[0] ?? effectiveCaseName}
                onChange={setE("FilePrefix")}
              />
              <div className={s.suggestions}>
                {suggestedNames.map(name => (
                  <button key={name} className={s.suggestionChip}
                    onClick={() => setP(prev => ({ ...prev, FilePrefix: name }))}>
                    {name}
                  </button>
                ))}
              </div>
              <p className={s.rzHint}>
                → results/<strong>{effectiveCaseName}</strong>/outb/ &amp; inp/
              </p>

              <div style={{ flex: 1 }} />

              {/* Pre-run ServoDyn warning (B) */}
              {showServoDynWarn && !running && (
                <div className={s.servoDynWarn}>
                  <AlertTriangle size={13} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>
                    ServoDyn is off — no pitch control. Likely fatal above rated wind speed.
                  </span>
                  <button
                    className={s.servoDynWarnBtn}
                    onClick={() => setP(prev => ({ ...prev, CompServo: 1 }))}
                  >
                    Enable
                  </button>
                </div>
              )}

              <div className={s.runCardAction}>
                {!running ? (
                  <button
                    className={s.runBtnBig}
                    onClick={handleRun}
                    disabled={!ofBinPath || !project || !fstPath || (windType === 3 && !btsFile)}
                    title={
                      !project   ? "Open a project first" :
                      !fstPath   ? "Add a model from the sidebar first" :
                      !ofBinPath ? "OpenFAST binary not found" :
                      (windType === 3 && !btsFile) ? "Select a .bts file" : undefined
                    }
                  >
                    <Play size={14} strokeWidth={2} fill="currentColor" />
                    Run simulation
                  </button>
                ) : (
                  <button className={s.stopBtnBig} onClick={handleStop}>
                    <Square size={14} strokeWidth={2} fill="currentColor" />
                    Stop
                  </button>
                )}
              </div>
            </div>

          </div>

          {/* ── Row 3: Simulation flow (left) | Recent runs (right) ── */}
          <div className={s.runCardsRow} style={{ "--row-idx": 2 }}>

            {/* Left: dependency flow graph */}
            <div className={[s.runCard, s.depCard].join(" ")}>
              <span className={s.sectionHead}>Simulation flow</span>
              <div className={s.depGraph}>
                {(() => {
                  const di = windType === 3 ? 2 : 0;
                  return (<>

                {windType === 3 && (<>
                  <div
                    className={s.depNode}
                    style={{ "--dep-idx": 0 }}
                    onClick={() => onModuleSelect?.("turbsim")}
                    title="Open TurbSim"
                  >
                    <span className={s.depNodeLabel}>TurbSim</span>
                    <span className={s.depNodeFile}>{btsFile || "wind_field.bts"}</span>
                    <span className={s.depNodeMeta}>BTS wind file generator</span>
                  </div>
                  <div className={s.depArrow} style={{ "--dep-idx": 1 }} />
                </>)}

                <div
                  className={[s.depNode, p.CompInflow > 0 ? s.depNodeActive : s.depNodeOff].join(" ")}
                  style={{ "--dep-idx": di }}
                  onClick={() => p.CompInflow > 0 && onModuleSelect?.("inflowwind")}
                  title={p.CompInflow > 0 ? "Open InflowWind" : "InflowWind disabled"}
                >
                  <div className={s.depNodeHeader}>
                    <span className={s.depNodeLabel}>InflowWind</span>
                    {p.CompInflow > 0 && windType === 1 && <span className={s.depNodeMeta}>{hWindSpeed} m/s steady</span>}
                    {p.CompInflow > 0 && windType === 3 && <span className={s.depNodeMeta}>BTS</span>}
                    {p.CompInflow > 0 && windType === 2 && <span className={s.depNodeMeta}>uniform</span>}
                  </div>
                  <span className={s.depNodeFile}>{p.InflowFile || "inflowwind.dat"}</span>
                </div>
                <div className={s.depArrow} style={{ "--dep-idx": di + 1 }} />

                <div
                  className={[s.depNode, s.depNodeMain, fstPath ? s.depNodeActive : s.depNodeOff].join(" ")}
                  style={{ "--dep-idx": di + 2 }}
                  onClick={() => { if (!fstPath) return; tabDirRef.current = 1; setTab("simulation"); }}
                  title={fstPath ? "View Simulation settings" : "No model loaded"}
                >
                  <span className={s.depNodeLabel}>OpenFAST</span>
                  <span className={s.depNodeFile}>
                    {fstPath ? fstPath.replace(/\\/g, "/").split("/").pop() : "no model loaded"}
                  </span>
                  {fstPath && (
                    <span className={s.depNodeMeta}>
                      {p.TMax} s · {Math.round(p.TMax / p.DT).toLocaleString()} steps
                      {(modelMeta?.hubHeight ?? edHubHeight) ? ` · hub ${modelMeta?.hubHeight ?? edHubHeight} m` : ""}
                    </span>
                  )}
                </div>
                <div className={s.depArrow} style={{ "--dep-idx": di + 3 }} />

                <div className={s.depModuleRow} style={{ "--dep-idx": di + 4 }}>
                  {MODULE_PILL_DEFS.filter(m => m.id !== "inflowwind").map(m => {
                    const active    = p[m.comp] > 0;
                    const clickable = active && m.hasPanel;
                    const fileKeys  = { elastodyn: "EDFile", aerodyn: "AeroFile", servodyn: "ServoFile", seastate: "SeaStFile", hydrodyn: "HydroFile", subdyn: "SubFile", moordyn: "MooringFile", icedyn: "IceFile" };
                    const tipFile   = active && fileKeys[m.id] ? p[fileKeys[m.id]] : null;
                    return (
                      <div
                        key={m.id}
                        className={[
                          s.depModNode,
                          active    ? s.depModNodeActive    : s.depModNodeOff,
                          clickable ? s.depModNodeClickable : "",
                        ].join(" ")}
                        onClick={() => clickable && onModuleSelect?.(m.id)}
                        title={tipFile || (active ? m.label : `${m.label} disabled`)}
                      >
                        {m.label}
                      </div>
                    );
                  })}
                </div>
                <div className={s.depArrow} style={{ "--dep-idx": di + 5 }} />

                <div className={[s.depNode, fstPath ? s.depNodeOutput : s.depNodeOff].join(" ")} style={{ "--dep-idx": di + 6 }}>
                  <div className={s.depNodeHeader}>
                    <span className={s.depNodeLabel}>Output</span>
                    <span className={s.depNodeMeta}>
                      {p.OutFileFmt === 1 ? ".out" : p.OutFileFmt === 2 ? ".outb" : p.OutFileFmt === 4 ? ".outb (raw)" : ".out + .outb"}
                    </span>
                  </div>
                  <span className={s.depNodeFile}>{effectiveCaseName}</span>
                </div>

                  </>);
                })()}
              </div>
            </div>

            {/* Right: recent runs */}
            <div className={s.runCard}>
              <span className={s.sectionHead}>Recent runs</span>
              {recentRuns.length === 0 ? (
                <p className={s.rzDim}>No runs yet</p>
              ) : (
                <div className={s.runList}>
                  {recentRuns.map(r => (
                    <div key={r.name} className={s.runRecord}>
                      <span className={s.runRecName}>{r.name}</span>
                      <span className={s.runRecMeta}>
                        {r.wind?.type === "steady" ? `${r.wind.speed} m/s` : r.wind?.type === "bts" ? "TurbSim" : ""}
                        {r.params?.TMax ? ` · ${r.params.TMax} s` : ""}
                      </span>
                      <span className={s.runRecTime}>{relTime(r.finishedAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>

          {/* ── Row 4: Binary status (read-only) — full config in Settings ── */}
          <div className={s.runCard} style={{ padding: "10px 16px", "--row-idx": 3 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <span className={s.sectionHead} style={{ margin: 0 }}>OpenFAST binary</span>
              <span style={{ fontSize: 11, color: "var(--tx-5)" }}>
                Configure in <strong style={{ color: "var(--tx-3)", fontWeight: 600 }}>Settings ⚙</strong>
              </span>
            </div>
            {(() => {
              const ver       = ofBundledVersion ?? ofVersion ?? null;
              const srcLabel  = ofBinSource === "bundled"  ? "Bundled"
                              : ofBinSource === "system"   ? "System"
                              : ofBinSource === "override" ? "Override"
                              : "Not found";
              const ok  = ofBinSource !== "notfound" && !!ofBinPath;
              const clr = ok ? "#059669" : "#DC2626";
              const bg  = ok ? "rgba(16,185,129,0.10)" : "rgba(239,68,68,0.10)";
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 4,
                    background: bg, color: clr, flexShrink: 0,
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: clr, display: "inline-block" }} />
                    {srcLabel}
                    {ver && <span style={{ fontWeight: 400, opacity: 0.8 }}> · v{ver}</span>}
                  </span>
                  <span style={{
                    fontSize: 11, color: "var(--tx-5)",
                    fontFamily: "'SF Mono',ui-monospace,monospace",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {ofBinPath ? ofBinPath.replace(/\\/g, "/").split("/").slice(-2).join("/") : "—"}
                  </span>
                </div>
              );
            })()}
          </div>

        </div>
      )}

    </div>
  );
}
