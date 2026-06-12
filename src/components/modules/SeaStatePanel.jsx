import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Waves, FolderOpen, Eye, Save, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import RawFileModal from "../RawFileModal";
import InfoPopover from "../InfoPopover";
import s from "./SeaStatePanel.module.css";

const ACCENT = "#0B948B";

// ── Tabs ──────────────────────────────────────────────────────────────────────
const TABS = [
  { id: "quick",   label: "Quick"   },
  { id: "waves",   label: "Waves"   },
  { id: "current", label: "Current" },
  { id: "output",  label: "Output"  },
];

// ── Wave model names ──────────────────────────────────────────────────────────
const WAVE_MOD_NAMES = {
  0: "Still water",
  1: "Regular",
  2: "JONSWAP",
  3: "White noise",
  4: "User-defined",
  5: "Ext elevation",
  6: "Ext kinematics",
};

const CURR_MOD_NAMES = {
  0: "None",
  1: "Standard",
  2: "User-defined",
};

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEFAULT = {
  Echo: false,
  // Environmental conditions
  WtrDens:      "default",
  WtrDpth:      "default",
  MSL2SWL:      "default",
  // Spatial discretization
  X_HalfWidth:  5,
  Y_HalfWidth:  5,
  Z_Depth:      "default",
  NX:           2,
  NY:           2,
  NZ:           15,
  // Waves
  WaveMod:      2,
  WaveStMod:    0,
  WaveTMax:     3630,
  WaveDT:       0.25,
  WaveHs:       4.52,
  WaveTp:       9.45,
  WavePkShp:    "DEFAULT",
  WvLowCOff:    0.15708,
  WvHiCOff:     3.2,
  WaveDir:      0,
  WaveDirMod:   0,
  WaveDirSpread:1,
  WaveNDir:     1,
  WaveDirRange: 90,
  WaveSeed1:    123456789,
  WaveSeed2:    "RANLUX",
  WaveNDAmp:    true,
  WvKinFile:    "",
  // 2nd-order waves
  WvDiffQTF:    false,
  WvSumQTF:     false,
  WvLowCOffD:   0,
  WvHiCOffD:    3.04292,
  WvLowCOffS:   0.314159,
  WvHiCOffS:    3.2,
  // Constrained waves
  ConstWaveMod: 0,
  CrestHmax:    1,
  CrestTime:    60,
  CrestXi:      0,
  CrestYi:      0,
  // Current
  CurrMod:      0,
  CurrSSV0:     0,
  CurrSSDir:    "DEFAULT",
  CurrNSRef:    20,
  CurrNSV0:     0,
  CurrNSDir:    0,
  CurrDIV:      0,
  CurrDIDir:    0,
  // MacCamy-Fuchs
  MCFD:         0,
  // Output
  SeaStSum:     false,
  OutSwtch:     2,
  OutFmt:       "ES11.4e2",
  OutSFmt:      "A11",
  NWaveElev:    1,
  WaveElevxi:   "0",
  WaveElevyi:   "0",
  NWaveKin:     2,
  // Output channels
  OutList:      '"Wave1Elev"',
};

// ── InfoPopover content ───────────────────────────────────────────────────────
const INFO = {
  WaveMod: {
    param: "WaveMod",
    desc: "Incident wave kinematics model.",
    range: "0–6",
    default: "2",
    note: "0=still water · 1=regular periodic · 2=JONSWAP irregular · 3=White noise · 4=user-defined · 5=ext elevation time series · 6=ext full kinematics (invalid with PotMod≠0)",
  },
  WaveHs: {
    param: "WaveHs",
    desc: "Significant wave height of incident waves.",
    range: ">0 m",
    default: "4.52",
    unit: "m",
    note: "Used only when WaveMod∈{1,2,3}. For JONSWAP, this is the total Hs. Typical North Sea operational: 4–8 m, extreme: 14–16 m.",
  },
  WaveTp: {
    param: "WaveTp",
    desc: "Peak-spectral period of incident waves.",
    range: ">0 s",
    default: "9.45",
    unit: "s",
    note: "Used when WaveMod=1 or 2. Related to Hs by Hs/Tp²≈0.05 for fully developed sea (Pierson-Moskowitz).",
  },
  WavePkShp: {
    param: "WavePkShp",
    desc: 'Peak-shape parameter (gamma) of JONSWAP spectrum. Use "DEFAULT" to compute from Hs/Tp per DNV guidelines, or 1.0 for Pierson-Moskowitz.',
    range: "1–7",
    default: "DEFAULT",
    note: "JONSWAP gamma: 1.0=PM, 3.3=typical JONSWAP, 7.0=very peaked sea.",
  },
  WaveSeed1: {
    param: "WaveSeed(1)",
    desc: "First random seed for stochastic wave generation.",
    range: "any integer",
    default: "123456789",
    note: "Change seeds between runs to get statistically independent wave realizations for fatigue DEL averaging.",
  },
  WaveSeed2: {
    param: "WaveSeed(2)",
    desc: 'Second random seed. Use "RANLUX" for the RANLUX luxury random number generator (recommended), or any integer for the basic generator.',
    range: "integer or RANLUX",
    default: "RANLUX",
    note: "RANLUX produces higher-quality random numbers and is strongly recommended for production runs.",
  },
  WaveNDAmp: {
    param: "WaveNDAmp",
    desc: "Flag for normally distributed amplitudes in stochastic wave generation.",
    range: "True / False",
    default: "True",
    note: "When True, wave amplitudes are drawn from a Rayleigh distribution (physically correct for JONSWAP). When False, all amplitudes equal Hs/(2√N).",
  },
  WvLowCOff: {
    param: "WvLowCOff",
    desc: "Low-frequency cut-off for wave spectrum, below which spectral energy is zeroed.",
    range: ">0 rad/s",
    default: "0.15708",
    unit: "rad/s",
    note: "≈ 0.157 rad/s corresponds to T=40 s. Unused when WaveMod∈{0,1,6}.",
  },
  WvHiCOff: {
    param: "WvHiCOff",
    desc: "High-frequency cut-off for wave spectrum.",
    range: ">WvLowCOff rad/s",
    default: "3.2",
    unit: "rad/s",
    note: "≈ 3.2 rad/s corresponds to T≈2 s. Unused when WaveMod∈{0,1,6}.",
  },
  WaveDir: {
    param: "WaveDir",
    desc: "Incident wave propagation heading direction.",
    range: "−180 to 180 °",
    default: "0",
    unit: "°",
    note: "0° = positive x-axis. Unused when WaveMod∈{0,6}.",
  },
  WaveDirMod: {
    param: "WaveDirMod",
    desc: "Directional spreading model for multi-directional seas.",
    range: "0, 1",
    default: "0",
    note: "0=long-crested (uni-directional) · 1=COS2S directional spreading. Only used when WaveMod∈{2,3,4}.",
  },
  WaveTMax: {
    param: "WaveTMax",
    desc: "Total duration of the incident wave time series.",
    range: ">0 s",
    default: "3630",
    unit: "s",
    note: "Should be ≥ TMax in the .fst file. Extra 30 s allows for startup transient removal.",
  },
  WaveDT: {
    param: "WaveDT",
    desc: "Time step for incident wave calculations.",
    range: ">0 s",
    default: "0.25",
    unit: "s",
    note: "Should be ≤ DT in the .fst. Nyquist: WaveDT ≤ π/WvHiCOff.",
  },
  WaveStMod: {
    param: "WaveStMod",
    desc: "Model for stretching incident wave kinematics above SWL.",
    range: "0–3",
    default: "0",
    note: "0=none · 1=vertical (extrapolate vertically) · 2=extrapolation stretching · 3=Wheeler stretching (recommended for shallow water)",
  },
  WvDiffQTF: {
    param: "WvDiffQTF",
    desc: "Flag for second-order difference-frequency wave kinematics (WAMIT QTF).",
    range: "True / False",
    default: "False",
    note: "Requires WAMIT QTF files. Significantly increases computation time. Unused with WaveMod∈{0,6}.",
  },
  WvSumQTF: {
    param: "WvSumQTF",
    desc: "Flag for second-order sum-frequency wave kinematics.",
    range: "True / False",
    default: "False",
    note: "Sum-frequency effects drive ringing in stiff structures. Requires WAMIT QTF files.",
  },
  ConstWaveMod: {
    param: "ConstWaveMod",
    desc: "Constrained wave model for embedding a deterministic extreme wave in a random sea.",
    range: "0–2",
    default: "0",
    note: "0=none · 1=constrain by crest elevation · 2=constrain by peak-to-trough height. Useful for ultimate load cases (ULS).",
  },
  CurrMod: {
    param: "CurrMod",
    desc: "Current profile model.",
    range: "0–2",
    default: "0",
    note: "0=none · 1=standard profile (sub-surface + near-surface + depth-independent) · 2=user-defined via UserCurrent routine",
  },
  MCFD: {
    param: "MCFD",
    desc: "MacCamy-Fuchs diffraction correction diameter.",
    range: "≥0 m (ignored if ≤0)",
    default: "0",
    unit: "m",
    note: "Applies the MacCamy-Fuchs correction to reduce the inertia coefficient for large-diameter members where diffraction is significant (D/λ > 0.2).",
  },
  WtrDens: {
    param: "WtrDens",
    desc: "Water density.",
    range: ">0 kg/m³",
    default: "default",
    unit: "kg/m³",
    note: 'Use "default" to inherit from the OpenFAST .fst environmental conditions. Typical seawater: 1025 kg/m³.',
  },
  WtrDpth: {
    param: "WtrDpth",
    desc: "Water depth below the SWL.",
    range: ">0 m",
    default: "default",
    unit: "m",
    note: 'Use "default" to inherit from the .fst file. Shallow water: <50 m; intermediate: 50–200 m; deep: >200 m.',
  },
  MSL2SWL: {
    param: "MSL2SWL",
    desc: "Offset between the mean sea level (MSL) and the still-water level (SWL).",
    range: "any m",
    default: "default",
    unit: "m",
    note: 'Positive upward. "default" = 0 m. Usually 0 for fixed structures; may differ for floating platforms with mean offset.',
  },
  WvKinFile: {
    param: "WvKinFile",
    desc: "Root name of the file(s) containing externally generated wave kinematics.",
    range: "file path string",
    default: '""',
    note: "Only used when WaveMod=5 (ext elevation) or WaveMod=6 (ext full kinematics). The file must be in the expected OpenFAST format.",
  },
  SeaStSum: {
    param: "SeaStSum",
    desc: "Flag to write a SeaState summary file.",
    range: "True / False",
    default: "False",
    note: "The summary file (.SeaSt.sum) contains wave spectrum information, sea state properties, and output channel definitions.",
  },
  OutSwtch: {
    param: "OutSwtch",
    desc: "Output file destination switch.",
    range: "1–3",
    default: "2",
    note: "1=SeaState.out · 2=GlueCode.out (appended to .out) · 3=both files",
  },
};

// ── Parser ────────────────────────────────────────────────────────────────────
function parseSeaStateFile(content) {
  const kv = {};
  const lines = content.split(/\r?\n/);
  let inOutChannels = false;
  const outLines = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (inOutChannels) {
      if (/^END\b/i.test(line)) { inOutChannels = false; break; }
      const m = line.match(/^"([^"]+)"/);
      if (m) outLines.push(`"${m[1]}"`);
      continue;
    }

    if (/OUTPUT\s+CHANNEL/i.test(line) && !line.startsWith("!")) {
      inOutChannels = true;
      continue;
    }

    if (!line || line.startsWith("!") || /^={4,}/.test(line) || /^-{4,}/.test(line)) continue;

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
    }

    // Key may have parens: WaveSeed(1), WaveSeed(2)
    const keyMatch = rest.match(/^([\w][\w_()]*)/);
    if (!keyMatch) continue;
    const key = keyMatch[1];
    kv[key] = value;
  }

  if (outLines.length) kv["__OutList__"] = outLines.join("\n");
  return kv;
}

// ── State mapper ──────────────────────────────────────────────────────────────
function ssParsedToState(kv) {
  const st = { ...DEFAULT };
  const b = v => typeof v === "string" && v.toLowerCase() === "true";
  const n = v => v !== undefined && !isNaN(Number(v)) ? Number(v) : undefined;

  const boolKeys = ["Echo", "WaveNDAmp", "WvDiffQTF", "WvSumQTF", "SeaStSum"];
  for (const k of boolKeys) {
    if (kv[k] !== undefined) st[k] = b(kv[k]);
  }

  const intKeys = [
    "NX", "NY", "NZ",
    "WaveMod", "WaveStMod", "WaveDirMod", "WaveNDir",
    "WaveDirRange", "WaveDirSpread",
    "ConstWaveMod",
    "CurrMod", "CurrNSRef",
    "OutSwtch", "NWaveElev", "NWaveKin",
  ];
  for (const k of intKeys) {
    const v = n(kv[k]); if (v !== undefined) st[k] = Math.round(v);
  }

  const floatKeys = [
    "X_HalfWidth", "Y_HalfWidth",
    "WaveTMax", "WaveDT",
    "WaveHs", "WaveTp",
    "WvLowCOff", "WvHiCOff",
    "WaveDir",
    "WvLowCOffD", "WvHiCOffD", "WvLowCOffS", "WvHiCOffS",
    "CrestHmax", "CrestTime", "CrestXi", "CrestYi",
    "CurrSSV0", "CurrNSV0", "CurrNSDir", "CurrDIV", "CurrDIDir",
    "MCFD",
  ];
  for (const k of floatKeys) {
    const v = n(kv[k]); if (v !== undefined) st[k] = v;
  }

  // "default"-able string fields
  const defaultableStr = ["WtrDens", "WtrDpth", "MSL2SWL", "Z_Depth", "CurrSSDir"];
  for (const k of defaultableStr) {
    if (kv[k] !== undefined) st[k] = kv[k]; // store as-is (may be "default" or a number string)
  }

  // WaveSeed(1) — store as number
  if (kv["WaveSeed(1)"] !== undefined) {
    const sv = Number(kv["WaveSeed(1)"]);
    st.WaveSeed1 = isNaN(sv) ? DEFAULT.WaveSeed1 : Math.round(sv);
  }

  // WaveSeed(2) — string ("RANLUX" or integer)
  if (kv["WaveSeed(2)"] !== undefined) st.WaveSeed2 = kv["WaveSeed(2)"];

  // WavePkShp — string ("DEFAULT") or float
  if (kv["WavePkShp"] !== undefined) st.WavePkShp = kv["WavePkShp"];

  // String fields
  if (kv["WvKinFile"] !== undefined) st.WvKinFile = kv["WvKinFile"];
  if (kv["OutFmt"]    !== undefined) st.OutFmt    = kv["OutFmt"];
  if (kv["OutSFmt"]   !== undefined) st.OutSFmt   = kv["OutSFmt"];

  // WaveElevxi / WaveElevyi — may be space-separated list
  if (kv["WaveElevxi"] !== undefined) st.WaveElevxi = kv["WaveElevxi"];
  if (kv["WaveElevyi"] !== undefined) st.WaveElevyi = kv["WaveElevyi"];

  if (kv["__OutList__"]) st.OutList = kv["__OutList__"];

  return st;
}

// ── File builder ──────────────────────────────────────────────────────────────
function buildSeaStateContent(originalContent, p) {
  // WtrDens/WtrDpth special: if "default" keep quoted; else numeric
  const fmtDefault = (v) =>
    (String(v).toLowerCase() === "default") ? '"default"' : String(v);

  const SUBS = {
    Echo:         () => p.Echo         ? "True " : "False",
    WtrDens:      () => fmtDefault(p.WtrDens),
    WtrDpth:      () => fmtDefault(p.WtrDpth),
    MSL2SWL:      () => fmtDefault(p.MSL2SWL),
    X_HalfWidth:  () => String(p.X_HalfWidth),
    Y_HalfWidth:  () => String(p.Y_HalfWidth),
    Z_Depth:      () => fmtDefault(p.Z_Depth),
    NX:           () => String(p.NX),
    NY:           () => String(p.NY),
    NZ:           () => String(p.NZ),
    WaveMod:      () => String(p.WaveMod),
    WaveStMod:    () => String(p.WaveStMod),
    WaveTMax:     () => String(p.WaveTMax),
    WaveDT:       () => String(p.WaveDT),
    WaveHs:       () => String(p.WaveHs),
    WaveTp:       () => String(p.WaveTp),
    WavePkShp:    () => (String(p.WavePkShp).toUpperCase() === "DEFAULT") ? '"DEFAULT"' : String(p.WavePkShp),
    WvLowCOff:    () => String(p.WvLowCOff),
    WvHiCOff:     () => String(p.WvHiCOff),
    WaveDir:      () => String(p.WaveDir),
    WaveDirMod:   () => String(p.WaveDirMod),
    WaveDirSpread:() => String(p.WaveDirSpread),
    WaveNDir:     () => String(p.WaveNDir),
    WaveDirRange: () => String(p.WaveDirRange),
    "WaveSeed(1)":() => String(p.WaveSeed1),
    "WaveSeed(2)":() => /^[0-9-]/.test(String(p.WaveSeed2).trim())
                          ? String(p.WaveSeed2)
                          : String(p.WaveSeed2).toUpperCase() === "RANLUX"
                            ? "RANLUX"
                            : String(p.WaveSeed2),
    WaveNDAmp:    () => p.WaveNDAmp ? "TRUE " : "FALSE",
    WvKinFile:    () => `"${p.WvKinFile}"`,
    WvDiffQTF:    () => p.WvDiffQTF ? "True " : "False",
    WvSumQTF:     () => p.WvSumQTF  ? "True " : "False",
    WvLowCOffD:   () => String(p.WvLowCOffD),
    WvHiCOffD:    () => String(p.WvHiCOffD),
    WvLowCOffS:   () => String(p.WvLowCOffS),
    WvHiCOffS:    () => String(p.WvHiCOffS),
    ConstWaveMod: () => String(p.ConstWaveMod),
    CrestHmax:    () => String(p.CrestHmax),
    CrestTime:    () => String(p.CrestTime),
    CrestXi:      () => String(p.CrestXi),
    CrestYi:      () => String(p.CrestYi),
    CurrMod:      () => String(p.CurrMod),
    CurrSSV0:     () => String(p.CurrSSV0),
    CurrSSDir:    () => (String(p.CurrSSDir).toUpperCase() === "DEFAULT") ? '"DEFAULT"' : String(p.CurrSSDir),
    CurrNSRef:    () => String(p.CurrNSRef),
    CurrNSV0:     () => String(p.CurrNSV0),
    CurrNSDir:    () => String(p.CurrNSDir),
    CurrDIV:      () => String(p.CurrDIV),
    CurrDIDir:    () => String(p.CurrDIDir),
    MCFD:         () => String(p.MCFD),
    SeaStSum:     () => p.SeaStSum ? "True " : "False",
    OutSwtch:     () => String(p.OutSwtch),
    OutFmt:       () => `"${p.OutFmt}"`,
    OutSFmt:      () => `"${p.OutSFmt}"`,
    NWaveElev:    () => String(p.NWaveElev),
    WaveElevxi:   () => String(p.WaveElevxi),
    WaveElevyi:   () => String(p.WaveElevyi),
    NWaveKin:     () => String(p.NWaveKin),
  };

  const lines = originalContent.split(/\r?\n/);
  const result = [];
  let inOutChannels = false;
  let outListInserted = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (inOutChannels) {
      if (/^END\b/i.test(trimmed)) {
        if (!outListInserted) {
          const newChannels = (p.OutList || "")
            .split("\n").map(l => l.trim()).filter(l => l)
            .map(l => l.startsWith('"') ? l : `"${l}"`);
          result.push(...newChannels);
          outListInserted = true;
        }
        result.push(rawLine);
        inOutChannels = false;
      }
      continue;
    }

    if (/OUTPUT\s+CHANNEL/i.test(trimmed) && !trimmed.startsWith("!")) {
      result.push(rawLine);
      inOutChannels = true;
      outListInserted = false;
      const newChannels = (p.OutList || "")
        .split("\n").map(l => l.trim()).filter(l => l)
        .map(l => l.startsWith('"') ? l : `"${l}"`);
      result.push(...newChannels);
      outListInserted = true;
      continue;
    }

    if (!trimmed || trimmed.startsWith("!") || /^={4,}/.test(trimmed) || /^-{4,}/.test(trimmed)) {
      result.push(rawLine);
      continue;
    }

    // Match value + key — key may include parens like WaveSeed(1)
    const m = rawLine.match(/^(\s*)("[^"]*"|\S+)(\s+)([\w][\w_()\d]*)([\s!].*)?$/);
    if (m) {
      const key = m[4];
      if (Object.prototype.hasOwnProperty.call(SUBS, key)) {
        const newVal = SUBS[key]();
        const oldVal = m[2];
        const padLen = Math.max(oldVal.length, newVal.length);
        const padded = newVal.padEnd(padLen);
        result.push(`${m[1]}${padded}${m[3]}${key}${m[5] || ""}`);
        continue;
      }
    }

    result.push(rawLine);
  }

  return result.join("\n");
}

// ── Sub-components ────────────────────────────────────────────────────────────
function SectionHead({ children }) {
  return <h3 className={s.sectionHead}>{children}</h3>;
}

/**
 * FieldRow — wraps a form field with guided-simulation disabling.
 * When disabled=true: opacity 0.38, pointer-events none, cursor not-allowed.
 * Shows a small "n/a" tag next to the label to educate the user.
 */
function FieldRow({ label, unit, children, hint, disabled = false, info }) {
  return (
    <div className={[s.field, disabled ? s.fieldDisabled : ""].join(" ")}>
      <div className={s.fieldHeader}>
        <span className={s.fieldLabel}>{label}</span>
        {unit && <span className={s.unit}>{unit}</span>}
        {info && <InfoPopover content={info} accentColor={ACCENT} />}
        {disabled && <span className={s.naTag}>n/a</span>}
      </div>
      {children}
      {hint && <span className={s.hint}>{hint}</span>}
    </div>
  );
}

function Toggle({ label, value, onChange, note, disabled = false }) {
  return (
    <div className={[s.toggleRow, disabled ? s.fieldDisabled : ""].join(" ")}>
      <button
        className={[s.toggle, value ? s.on : ""].join(" ")}
        onClick={() => !disabled && onChange(!value)}
        type="button"
      >
        <span className={s.toggleThumb} />
      </button>
      <span className={s.toggleLabel}>{label}</span>
      {note && <span className={s.toggleNote}>{note}</span>}
      {disabled && <span className={s.naTag}>n/a</span>}
    </div>
  );
}

function Collapsible({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={s.collapsible}>
      <button className={s.collapsibleHead} onClick={() => setOpen(v => !v)} type="button">
        {open ? <ChevronDown size={13} strokeWidth={2} /> : <ChevronRight size={13} strokeWidth={2} />}
        {title}
      </button>
      {open && <div className={s.collapsibleBody}>{children}</div>}
    </div>
  );
}

// ── Ocean wave SVG schematic ──────────────────────────────────────────────────
function OceanSchematic({ waveHs, waveTp, waveMod }) {
  const c = ACCENT;
  const waveLabel = WAVE_MOD_NAMES[waveMod] ?? "–";

  // Amplitude in SVG coords proportional to Hs (capped for display)
  const amp = Math.min(Math.max(waveHs * 1.8, 3), 18);

  // Build a sinusoidal path across the SVG (width 100, baseline at y=65)
  const buildWavePath = (amplitude, phase, nCycles) => {
    const pts = [];
    for (let x = 0; x <= 100; x += 2) {
      const y = 65 - amplitude * Math.sin((x / 100) * nCycles * 2 * Math.PI + phase);
      pts.push(`${x === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return pts.join(" ");
  };

  return (
    <svg viewBox="0 0 100 120" width="100%" height="180" style={{ display: "block" }}>
      {/* Ocean body */}
      <rect x="0" y="65" width="100" height="55" fill={c} fillOpacity="0.08" />
      {/* Seabed */}
      <rect x="0" y="108" width="100" height="12" fill={c} fillOpacity="0.14" />
      {/* Background wave (lighter) */}
      <path d={buildWavePath(amp * 0.55, Math.PI * 0.4, 2.5)}
        stroke={c} strokeWidth="0.8" fill="none" strokeOpacity="0.25" />
      {/* Main wave */}
      <path d={buildWavePath(amp, 0, 2)}
        stroke={c} strokeWidth="1.5" fill="none" strokeOpacity="0.7" />

      {/* Hs arrow — vertical from trough to crest */}
      {amp > 4 && (
        <>
          <line x1="78" y1={65 - amp} x2="78" y2={65 + amp}
            stroke={c} strokeWidth="0.8" strokeDasharray="1.5,1.5" strokeOpacity="0.55" />
          <line x1="74" y1={65 - amp} x2="82" y2={65 - amp}
            stroke={c} strokeWidth="0.8" strokeOpacity="0.55" />
          <line x1="74" y1={65 + amp} x2="82" y2={65 + amp}
            stroke={c} strokeWidth="0.8" strokeOpacity="0.55" />
          <text x="83" y={65} fontSize="5.5" fill={c} opacity="0.7"
            fontFamily="-apple-system,sans-serif" dominantBaseline="middle">Hs</text>
        </>
      )}

      {/* Tp arc indicator at surface */}
      <path d="M20 65 Q37.5 55 55 65" stroke={c} strokeWidth="0.9" fill="none"
        strokeDasharray="2,1.5" strokeOpacity="0.45" />
      <text x="33" y="58" fontSize="5" fill={c} opacity="0.6"
        fontFamily="-apple-system,sans-serif" textAnchor="middle">Tp</text>

      {/* SWL line */}
      <line x1="0" y1="65" x2="100" y2="65"
        stroke={c} strokeWidth="0.5" strokeDasharray="3,2" strokeOpacity="0.35" />
      <text x="2" y="63" fontSize="4.5" fill={c} opacity="0.5"
        fontFamily="-apple-system,sans-serif">SWL</text>

      {/* Water column depth indicator */}
      <line x1="5" y1="65" x2="5" y2="108"
        stroke={c} strokeWidth="0.6" strokeOpacity="0.30" />
      <line x1="2" y1="108" x2="8" y2="108"
        stroke={c} strokeWidth="0.6" strokeOpacity="0.30" />
      <text x="7" y="90" fontSize="4.5" fill={c} opacity="0.45"
        fontFamily="-apple-system,sans-serif" writingMode="tb">depth</text>

      {/* Label */}
      <text x="4" y="118" fontSize="6" fill={c} fontFamily="-apple-system,sans-serif" opacity="0.7">
        SeaState
      </text>
      <text x="4" y="106" fontSize="5" fill={c} fontFamily="-apple-system,sans-serif" opacity="0.5">
        {waveLabel}
      </text>
    </svg>
  );
}

// ── Guided-simulation helpers ─────────────────────────────────────────────────
/**
 * Returns true if WaveHs/WaveTp/WavePkShp are active (WaveMod ∈ {1,2,3})
 */
const activeHsTp      = wm => [1, 2, 3].includes(wm);
const activePkShp     = wm => wm === 2;
const activeFreqCutOff= wm => [2, 3, 4].includes(wm);
const activeWaveDir   = wm => ![0, 6].includes(wm);
const activeDirMod    = wm => [2, 3, 4].includes(wm);
const activeDirSpread = (wm, wdm) => [2, 3, 4].includes(wm) && wdm === 1;
const activeSeed      = wm => [2, 3, 4].includes(wm);
const activeKinFile   = wm => [5, 6].includes(wm);
const active2ndOrder  = wm => ![0, 6].includes(wm);

// ── Main component ────────────────────────────────────────────────────────────
export default function SeaStatePanel({
  onLog,
  project,
  filePathFromProject,
  onDirtyChange,
  onRegisterSave,
  simRunning = false,
}) {
  const [tab,         setTab]         = useState("quick");
  const [p,           _setP]          = useState(DEFAULT);
  const [filePath,    setFilePath]    = useState("");
  const [isDirtyFlag, setIsDirtyFlag] = useState(false);
  const [rawOpen,     setRawOpen]     = useState(false);
  const rawContent  = useRef("");
  const originalRef = useRef(null);

  // Dirty-marking wrapper
  const setP = useCallback((updater) => {
    _setP(updater);
    setIsDirtyFlag(true);
  }, []);

  const isDirty = !!filePath && isDirtyFlag &&
    originalRef.current !== null && JSON.stringify(p) !== originalRef.current;

  useEffect(() => {
    if (!isDirtyFlag || originalRef.current === null) return;
    if (JSON.stringify(p) === originalRef.current) setIsDirtyFlag(false);
  }, [p, isDirtyFlag]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = useCallback((key, val) => setP(prev => ({ ...prev, [key]: val })), [setP]);

  // ── File loader ─────────────────────────────────────────────────────────────
  const loadFileFromPath = useCallback(async (path) => {
    try {
      const content = await invoke("read_text_file", { path });
      rawContent.current = content;
      const kv     = parseSeaStateFile(content);
      const parsed = ssParsedToState(kv);
      originalRef.current = JSON.stringify(parsed);
      _setP(parsed);
      setIsDirtyFlag(false);
      setFilePath(path);
      onLog?.("info", `Opened ${path.split("/").pop()}`);
    } catch (e) {
      onLog?.("error", String(e));
    }
  }, [onLog]);

  // ── Browse ──────────────────────────────────────────────────────────────────
  const handleOpen = async () => {
    try {
      const f = await openDialog({
        multiple: false,
        filters: [{ name: "SeaState", extensions: ["dat", "inp", "txt"] }],
      });
      if (!f) return;
      await loadFileFromPath(f);
    } catch (e) {
      onLog?.("error", String(e));
    }
  };

  // ── Save ────────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (simRunning) {
      onLog?.("warn", "OpenFAST is running — save blocked to protect the active simulation.");
      return;
    }
    if (!filePath) return;
    try {
      const diskContent = await invoke("read_text_file", { path: filePath }).catch(() => rawContent.current);
      const content = buildSeaStateContent(diskContent, p);
      await invoke("write_text_file", { path: filePath, content });
      rawContent.current = content;
      originalRef.current = JSON.stringify(p);
      setIsDirtyFlag(false);
      onLog?.("info", `Saved ${filePath.split("/").pop()}`);
    } catch (e) {
      onLog?.("error", String(e));
    }
  }, [filePath, p, onLog, simRunning]);

  // ⌘S
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); handleSave(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  // ── Project integration ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!filePathFromProject) return;
    loadFileFromPath(filePathFromProject);
  }, [filePathFromProject]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onRegisterSave?.(handleSave); }, [handleSave]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Tab: Quick ──────────────────────────────────────────────────────────────
  const renderQuick = () => {
    const wm = p.WaveMod;
    return (
      <div className={s.form}>
        <div className={s.callout}>
          Wave kinematics are defined here and passed to HydroDyn. WtrDens and WtrDpth here
          override the .fst values when not set to <strong>"default"</strong>. The guided
          simulation panel dims fields that have no effect for your chosen wave model.
        </div>

        <SectionHead>Wave Model</SectionHead>
        <div className={s.grid2}>
          <FieldRow label="Wave kinematics model (WaveMod)" info={INFO.WaveMod}>
            <select className={s.select} value={wm}
              onChange={e => set("WaveMod", Number(e.target.value))}>
              <option value={0}>0 – Still water</option>
              <option value={1}>1 – Regular periodic</option>
              <option value={2}>2 – JONSWAP irregular</option>
              <option value={3}>3 – White noise</option>
              <option value={4}>4 – User-defined spectrum</option>
              <option value={5}>5 – Ext elevation time series</option>
              <option value={6}>6 – Ext full kinematics</option>
            </select>
          </FieldRow>

          <FieldRow label="Significant wave height (WaveHs)" unit="m"
            disabled={!activeHsTp(wm)} info={INFO.WaveHs}>
            <input className={s.inp} type="number" value={p.WaveHs}
              onChange={e => set("WaveHs", parseFloat(e.target.value) || p.WaveHs)} />
          </FieldRow>

          <FieldRow label="Peak spectral period (WaveTp)" unit="s"
            disabled={!activeHsTp(wm)} info={INFO.WaveTp}>
            <input className={s.inp} type="number" value={p.WaveTp}
              onChange={e => set("WaveTp", parseFloat(e.target.value) || p.WaveTp)} />
          </FieldRow>

          <FieldRow label="Wave direction (WaveDir)" unit="°"
            disabled={!activeWaveDir(wm)} info={INFO.WaveDir}>
            <input className={s.inp} type="number" value={p.WaveDir}
              onChange={e => set("WaveDir", parseFloat(e.target.value) || 0)} />
          </FieldRow>
        </div>

        <SectionHead>Stochastic Seeds</SectionHead>
        <div className={s.grid2}>
          <FieldRow label="Random seed 1 — WaveSeed(1)"
            disabled={!activeSeed(wm)} info={INFO.WaveSeed1}>
            <input className={s.inp} type="number" value={p.WaveSeed1}
              onChange={e => set("WaveSeed1", parseInt(e.target.value) || 0)} />
          </FieldRow>

          <FieldRow label="Random seed 2 — WaveSeed(2)"
            hint="Integer or RANLUX"
            disabled={!activeSeed(wm)} info={INFO.WaveSeed2}>
            <input className={s.inp} value={p.WaveSeed2}
              onChange={e => set("WaveSeed2", e.target.value)} />
          </FieldRow>
        </div>

        <SectionHead>Current</SectionHead>
        <div className={s.grid2}>
          <FieldRow label="Current model (CurrMod)" info={INFO.CurrMod}>
            <select className={s.select} value={p.CurrMod}
              onChange={e => set("CurrMod", Number(e.target.value))}>
              <option value={0}>0 – None</option>
              <option value={1}>1 – Standard profile</option>
              <option value={2}>2 – User-defined</option>
            </select>
          </FieldRow>
        </div>
      </div>
    );
  };

  // ── Tab: Waves ──────────────────────────────────────────────────────────────
  const renderWaves = () => {
    const wm  = p.WaveMod;
    const wdm = p.WaveDirMod;
    return (
      <div className={s.form}>
        <SectionHead>Environmental Conditions</SectionHead>
        <div className={s.grid3}>
          <FieldRow label="Water density (WtrDens)" unit="kg/m³"
            hint={`"default" = use .fst value`} info={INFO.WtrDens}>
            <input className={s.inp} value={p.WtrDens}
              onChange={e => set("WtrDens", e.target.value)} />
          </FieldRow>
          <FieldRow label="Water depth (WtrDpth)" unit="m"
            hint={`"default" = use .fst value`} info={INFO.WtrDpth}>
            <input className={s.inp} value={p.WtrDpth}
              onChange={e => set("WtrDpth", e.target.value)} />
          </FieldRow>
          <FieldRow label="MSL to SWL offset (MSL2SWL)" unit="m"
            hint={`"default" = 0 m`} info={INFO.MSL2SWL}>
            <input className={s.inp} value={p.MSL2SWL}
              onChange={e => set("MSL2SWL", e.target.value)} />
          </FieldRow>
        </div>

        <SectionHead>Spatial Discretization</SectionHead>
        <div className={s.grid3}>
          <FieldRow label="X half-width (X_HalfWidth)" unit="m">
            <input className={s.inp} type="number" value={p.X_HalfWidth}
              onChange={e => set("X_HalfWidth", parseFloat(e.target.value) || 0)} />
          </FieldRow>
          <FieldRow label="Y half-width (Y_HalfWidth)" unit="m">
            <input className={s.inp} type="number" value={p.Y_HalfWidth}
              onChange={e => set("Y_HalfWidth", parseFloat(e.target.value) || 0)} />
          </FieldRow>
          <FieldRow label="Z depth (Z_Depth)" unit="m" hint={`"default" = WtrDpth`}>
            <input className={s.inp} value={p.Z_Depth}
              onChange={e => set("Z_Depth", e.target.value)} />
          </FieldRow>
          <FieldRow label="X nodes (NX)">
            <input className={s.inp} type="number" value={p.NX}
              onChange={e => set("NX", parseInt(e.target.value) || 1)} />
          </FieldRow>
          <FieldRow label="Y nodes (NY)">
            <input className={s.inp} type="number" value={p.NY}
              onChange={e => set("NY", parseInt(e.target.value) || 1)} />
          </FieldRow>
          <FieldRow label="Z nodes (NZ)">
            <input className={s.inp} type="number" value={p.NZ}
              onChange={e => set("NZ", parseInt(e.target.value) || 1)} />
          </FieldRow>
        </div>

        <SectionHead>Wave Model & Time</SectionHead>
        <div className={s.grid2}>
          <FieldRow label="Wave model (WaveMod)" info={INFO.WaveMod}>
            <select className={s.select} value={wm}
              onChange={e => set("WaveMod", Number(e.target.value))}>
              <option value={0}>0 – Still water</option>
              <option value={1}>1 – Regular periodic</option>
              <option value={2}>2 – JONSWAP irregular</option>
              <option value={3}>3 – White noise</option>
              <option value={4}>4 – User-defined spectrum</option>
              <option value={5}>5 – Ext elevation time series</option>
              <option value={6}>6 – Ext full kinematics</option>
            </select>
          </FieldRow>

          <FieldRow label="Stretching model (WaveStMod)" info={INFO.WaveStMod}>
            <select className={s.select} value={p.WaveStMod}
              onChange={e => set("WaveStMod", Number(e.target.value))}>
              <option value={0}>0 – None</option>
              <option value={1}>1 – Vertical</option>
              <option value={2}>2 – Extrapolation</option>
              <option value={3}>3 – Wheeler stretching</option>
            </select>
          </FieldRow>

          <FieldRow label="Wave time series length (WaveTMax)" unit="s" info={INFO.WaveTMax}>
            <input className={s.inp} type="number" value={p.WaveTMax}
              onChange={e => set("WaveTMax", parseFloat(e.target.value) || p.WaveTMax)} />
          </FieldRow>

          <FieldRow label="Wave time step (WaveDT)" unit="s" info={INFO.WaveDT}>
            <input className={s.inp} type="number" value={p.WaveDT}
              onChange={e => set("WaveDT", parseFloat(e.target.value) || p.WaveDT)} />
          </FieldRow>
        </div>

        <SectionHead>Sea State Parameters</SectionHead>
        <div className={s.grid2}>
          <FieldRow label="Significant wave height (WaveHs)" unit="m"
            disabled={!activeHsTp(wm)} info={INFO.WaveHs}>
            <input className={s.inp} type="number" value={p.WaveHs}
              onChange={e => set("WaveHs", parseFloat(e.target.value) || p.WaveHs)} />
          </FieldRow>

          <FieldRow label="Peak spectral period (WaveTp)" unit="s"
            disabled={!activeHsTp(wm)} info={INFO.WaveTp}>
            <input className={s.inp} type="number" value={p.WaveTp}
              onChange={e => set("WaveTp", parseFloat(e.target.value) || p.WaveTp)} />
          </FieldRow>

          <FieldRow label='JONSWAP peak shape γ (WavePkShp)'
            hint='"DEFAULT" → DNV formula · 1.0 = Pierson-Moskowitz'
            disabled={!activePkShp(wm)} info={INFO.WavePkShp}>
            <input className={s.inp} value={p.WavePkShp}
              onChange={e => set("WavePkShp", e.target.value)} />
          </FieldRow>

          <FieldRow label="Low freq. cut-off (WvLowCOff)" unit="rad/s"
            disabled={!activeFreqCutOff(wm)} info={INFO.WvLowCOff}>
            <input className={s.inp} type="number" value={p.WvLowCOff}
              onChange={e => set("WvLowCOff", parseFloat(e.target.value) || p.WvLowCOff)} />
          </FieldRow>

          <FieldRow label="High freq. cut-off (WvHiCOff)" unit="rad/s"
            disabled={!activeFreqCutOff(wm)} info={INFO.WvHiCOff}>
            <input className={s.inp} type="number" value={p.WvHiCOff}
              onChange={e => set("WvHiCOff", parseFloat(e.target.value) || p.WvHiCOff)} />
          </FieldRow>

          <FieldRow label="Wave propagation direction (WaveDir)" unit="°"
            disabled={!activeWaveDir(wm)} info={INFO.WaveDir}>
            <input className={s.inp} type="number" value={p.WaveDir}
              onChange={e => set("WaveDir", parseFloat(e.target.value) || 0)} />
          </FieldRow>
        </div>

        <SectionHead>Directional Spreading</SectionHead>
        <div className={s.grid2}>
          <FieldRow label="Directional spreading model (WaveDirMod)"
            disabled={!activeDirMod(wm)} info={INFO.WaveDirMod}>
            <select className={s.select} value={p.WaveDirMod}
              onChange={e => set("WaveDirMod", Number(e.target.value))}
              disabled={!activeDirMod(wm)}>
              <option value={0}>0 – None (long-crested)</option>
              <option value={1}>1 – COS2S spreading</option>
            </select>
          </FieldRow>

          <FieldRow label="Spreading exponent (WaveDirSpread)"
            disabled={!activeDirSpread(wm, wdm)}
            hint="Only used when WaveDirMod=1">
            <input className={s.inp} type="number" value={p.WaveDirSpread}
              onChange={e => set("WaveDirSpread", parseInt(e.target.value) || 1)} />
          </FieldRow>

          <FieldRow label="Number of wave directions (WaveNDir)"
            disabled={!activeDirSpread(wm, wdm)}
            hint="Must be odd; only used when WaveDirMod=1">
            <input className={s.inp} type="number" value={p.WaveNDir}
              onChange={e => set("WaveNDir", parseInt(e.target.value) || 1)} />
          </FieldRow>

          <FieldRow label="Total directional range (WaveDirRange)" unit="°"
            disabled={!activeDirSpread(wm, wdm)}
            hint="Only used when WaveDirMod=1">
            <input className={s.inp} type="number" value={p.WaveDirRange}
              onChange={e => set("WaveDirRange", parseFloat(e.target.value) || 0)} />
          </FieldRow>
        </div>

        <SectionHead>Stochastic Generation</SectionHead>
        <div className={s.grid2}>
          <FieldRow label="Random seed 1 — WaveSeed(1)"
            disabled={!activeSeed(wm)} info={INFO.WaveSeed1}>
            <input className={s.inp} type="number" value={p.WaveSeed1}
              onChange={e => set("WaveSeed1", parseInt(e.target.value) || 0)} />
          </FieldRow>

          <FieldRow label="Random seed 2 — WaveSeed(2)"
            hint="Integer or RANLUX"
            disabled={!activeSeed(wm)} info={INFO.WaveSeed2}>
            <input className={s.inp} value={p.WaveSeed2}
              onChange={e => set("WaveSeed2", e.target.value)} />
          </FieldRow>
        </div>

        <div className={s.toggleGrid}>
          <Toggle label="Normally-distributed amplitudes (WaveNDAmp)"
            value={p.WaveNDAmp} onChange={v => set("WaveNDAmp", v)}
            disabled={!activeSeed(wm)}
            note="Rayleigh-distributed amplitudes (physically correct)" />
        </div>

        <FieldRow label="External kinematics file (WvKinFile)"
          hint="Only used when WaveMod=5 or 6"
          disabled={!activeKinFile(wm)} info={INFO.WvKinFile}>
          <div className={s.fileRow}>
            <input className={s.inp} value={p.WvKinFile}
              onChange={e => set("WvKinFile", e.target.value)} />
            <button className={s.browseBtn} type="button"
              onClick={async () => {
                if (!activeKinFile(p.WaveMod)) return;
                const f = await openDialog({ multiple: false });
                if (f) set("WvKinFile", f);
              }}>
              <FolderOpen size={12} strokeWidth={1.8} />
            </button>
          </div>
        </FieldRow>

        <Collapsible title="2nd-order waves (QTF)" defaultOpen={false}>
          <div className={s.calloutInfo} style={{ marginBottom: 12 }}>
            Second-order wave effects require WAMIT QTF files and significantly increase
            computation time. Disabled when WaveMod∈&#123;0,6&#125;.
          </div>
          <div className={s.toggleGrid} style={{ marginBottom: 12 }}>
            <Toggle label="Difference-frequency 2nd-order kinematics (WvDiffQTF)"
              value={p.WvDiffQTF} onChange={v => set("WvDiffQTF", v)}
              disabled={!active2ndOrder(p.WaveMod)} />
            <Toggle label="Sum-frequency 2nd-order kinematics (WvSumQTF)"
              value={p.WvSumQTF} onChange={v => set("WvSumQTF", v)}
              disabled={!active2ndOrder(p.WaveMod)} />
          </div>
          <div className={s.grid2}>
            <FieldRow label="Diff-freq low cut-off (WvLowCOffD)" unit="rad/s"
              disabled={!active2ndOrder(p.WaveMod)}>
              <input className={s.inp} type="number" value={p.WvLowCOffD}
                onChange={e => set("WvLowCOffD", parseFloat(e.target.value) || 0)} />
            </FieldRow>
            <FieldRow label="Diff-freq high cut-off (WvHiCOffD)" unit="rad/s"
              disabled={!active2ndOrder(p.WaveMod)}>
              <input className={s.inp} type="number" value={p.WvHiCOffD}
                onChange={e => set("WvHiCOffD", parseFloat(e.target.value) || 0)} />
            </FieldRow>
            <FieldRow label="Sum-freq low cut-off (WvLowCOffS)" unit="rad/s"
              disabled={!active2ndOrder(p.WaveMod)}>
              <input className={s.inp} type="number" value={p.WvLowCOffS}
                onChange={e => set("WvLowCOffS", parseFloat(e.target.value) || 0)} />
            </FieldRow>
            <FieldRow label="Sum-freq high cut-off (WvHiCOffS)" unit="rad/s"
              disabled={!active2ndOrder(p.WaveMod)}>
              <input className={s.inp} type="number" value={p.WvHiCOffS}
                onChange={e => set("WvHiCOffS", parseFloat(e.target.value) || 0)} />
            </FieldRow>
          </div>
        </Collapsible>

        <Collapsible title="Constrained waves (ULS embedded deterministic wave)" defaultOpen={false}>
          <div className={s.calloutInfo} style={{ marginBottom: 12 }}>
            Embeds a deterministic extreme wave into the random sea. Useful for
            ultimate-limit-state (ULS) and extreme-load analyses.
          </div>
          <div className={s.grid2}>
            <FieldRow label="Constrained wave model (ConstWaveMod)" info={INFO.ConstWaveMod}>
              <select className={s.select} value={p.ConstWaveMod}
                onChange={e => set("ConstWaveMod", Number(e.target.value))}>
                <option value={0}>0 – None</option>
                <option value={1}>1 – Crest elevation</option>
                <option value={2}>2 – Peak-to-trough</option>
              </select>
            </FieldRow>

            <FieldRow label="Max crest height (CrestHmax)" unit="m"
              disabled={p.ConstWaveMod === 0}
              hint="Only used when ConstWaveMod > 0">
              <input className={s.inp} type="number" value={p.CrestHmax}
                onChange={e => set("CrestHmax", parseFloat(e.target.value) || 0)} />
            </FieldRow>

            <FieldRow label="Crest time (CrestTime)" unit="s"
              disabled={p.ConstWaveMod === 0}>
              <input className={s.inp} type="number" value={p.CrestTime}
                onChange={e => set("CrestTime", parseFloat(e.target.value) || 0)} />
            </FieldRow>

            <FieldRow label="Crest X position (CrestXi)" unit="m"
              disabled={p.ConstWaveMod === 0}>
              <input className={s.inp} type="number" value={p.CrestXi}
                onChange={e => set("CrestXi", parseFloat(e.target.value) || 0)} />
            </FieldRow>

            <FieldRow label="Crest Y position (CrestYi)" unit="m"
              disabled={p.ConstWaveMod === 0}>
              <input className={s.inp} type="number" value={p.CrestYi}
                onChange={e => set("CrestYi", parseFloat(e.target.value) || 0)} />
            </FieldRow>
          </div>
        </Collapsible>
      </div>
    );
  };

  // ── Tab: Current ────────────────────────────────────────────────────────────
  const renderCurrent = () => {
    const cm = p.CurrMod;
    const stdActive = cm === 1;
    return (
      <div className={s.form}>
        <SectionHead>Current Model</SectionHead>
        <div className={s.grid2}>
          <FieldRow label="Current model (CurrMod)" info={INFO.CurrMod}>
            <select className={s.select} value={cm}
              onChange={e => set("CurrMod", Number(e.target.value))}>
              <option value={0}>0 – None</option>
              <option value={1}>1 – Standard profile</option>
              <option value={2}>2 – User-defined</option>
            </select>
          </FieldRow>
        </div>

        {cm === 0 && (
          <div className={s.calloutInfo}>
            Current model is disabled (CurrMod = 0). Select a standard or user-defined
            profile to configure current loading.
          </div>
        )}

        <SectionHead>Standard Current Profile</SectionHead>
        <div className={s.callout} style={{ marginBottom: 14, fontSize: 11.5 }}>
          The standard profile comprises three layers: sub-surface (power-law),
          near-surface (linear), and depth-independent. All fields below are only
          active when CurrMod = 1.
        </div>
        <div className={s.grid2}>
          <FieldRow label="Sub-surface current speed at SWL (CurrSSV0)" unit="m/s"
            disabled={!stdActive}>
            <input className={s.inp} type="number" value={p.CurrSSV0}
              onChange={e => set("CurrSSV0", parseFloat(e.target.value) || 0)} />
          </FieldRow>

          <FieldRow label="Sub-surface current direction (CurrSSDir)" unit="° or DEFAULT"
            hint={`"DEFAULT" = same as WaveDir`}
            disabled={!stdActive}>
            <input className={s.inp} value={p.CurrSSDir}
              onChange={e => set("CurrSSDir", e.target.value)} />
          </FieldRow>

          <FieldRow label="Near-surface reference depth (CurrNSRef)" unit="m"
            disabled={!stdActive}
            hint="Depth below SWL at which near-surface profile begins">
            <input className={s.inp} type="number" value={p.CurrNSRef}
              onChange={e => set("CurrNSRef", parseFloat(e.target.value) || 0)} />
          </FieldRow>

          <FieldRow label="Near-surface speed at SWL (CurrNSV0)" unit="m/s"
            disabled={!stdActive}>
            <input className={s.inp} type="number" value={p.CurrNSV0}
              onChange={e => set("CurrNSV0", parseFloat(e.target.value) || 0)} />
          </FieldRow>

          <FieldRow label="Near-surface direction (CurrNSDir)" unit="°"
            disabled={!stdActive}>
            <input className={s.inp} type="number" value={p.CurrNSDir}
              onChange={e => set("CurrNSDir", parseFloat(e.target.value) || 0)} />
          </FieldRow>

          <FieldRow label="Depth-independent speed (CurrDIV)" unit="m/s"
            disabled={!stdActive}>
            <input className={s.inp} type="number" value={p.CurrDIV}
              onChange={e => set("CurrDIV", parseFloat(e.target.value) || 0)} />
          </FieldRow>

          <FieldRow label="Depth-independent direction (CurrDIDir)" unit="°"
            disabled={!stdActive}>
            <input className={s.inp} type="number" value={p.CurrDIDir}
              onChange={e => set("CurrDIDir", parseFloat(e.target.value) || 0)} />
          </FieldRow>
        </div>

        <SectionHead>MacCamy-Fuchs Correction</SectionHead>
        <div className={s.grid2}>
          <FieldRow label="MacCamy-Fuchs diameter (MCFD)" unit="m" info={INFO.MCFD}>
            <input className={s.inp} type="number" value={p.MCFD}
              onChange={e => set("MCFD", parseFloat(e.target.value) || 0)} />
          </FieldRow>
        </div>

        <SectionHead>External Kinematics File</SectionHead>
        <FieldRow label="Wave kinematics file (WvKinFile)"
          hint="Required when WaveMod=5 or WaveMod=6"
          disabled={!activeKinFile(p.WaveMod)} info={INFO.WvKinFile}>
          <div className={s.fileRow}>
            <input className={s.inp} value={p.WvKinFile}
              onChange={e => set("WvKinFile", e.target.value)} />
            <button className={s.browseBtn} type="button"
              onClick={async () => {
                if (!activeKinFile(p.WaveMod)) return;
                const f = await openDialog({ multiple: false });
                if (f) set("WvKinFile", f);
              }}>
              <FolderOpen size={12} strokeWidth={1.8} />
            </button>
          </div>
        </FieldRow>
      </div>
    );
  };

  // ── Tab: Output ─────────────────────────────────────────────────────────────
  const renderOutput = () => (
    <div className={s.form}>
      <SectionHead>Output Options</SectionHead>
      <div className={s.grid2}>
        <FieldRow label="Output destination (OutSwtch)" info={INFO.OutSwtch}>
          <select className={s.select} value={p.OutSwtch}
            onChange={e => set("OutSwtch", Number(e.target.value))}>
            <option value={1}>1 – SeaState.out</option>
            <option value={2}>2 – GlueCode.out</option>
            <option value={3}>3 – Both files</option>
          </select>
        </FieldRow>

        <FieldRow label="Numeric output format (OutFmt)">
          <input className={s.inp} value={p.OutFmt}
            onChange={e => set("OutFmt", e.target.value)} />
        </FieldRow>

        <FieldRow label="Header string format (OutSFmt)">
          <input className={s.inp} value={p.OutSFmt}
            onChange={e => set("OutSFmt", e.target.value)} />
        </FieldRow>
      </div>

      <div className={s.toggleGrid}>
        <Toggle label="Write SeaState summary file (SeaStSum)"
          value={p.SeaStSum} onChange={v => set("SeaStSum", v)}
          note=".SeaSt.sum — wave spectrum + channel list" />
        <Toggle label="Echo input file (Echo)"
          value={p.Echo} onChange={v => set("Echo", v)}
          note="Writes .ech file; useful for debugging" />
      </div>

      <Collapsible title="Wave elevation output points" defaultOpen={true}>
        <div className={s.grid2}>
          <FieldRow label="Number of wave elevation points (NWaveElev)">
            <input className={s.inp} type="number" value={p.NWaveElev}
              onChange={e => set("NWaveElev", parseInt(e.target.value) || 0)} />
          </FieldRow>
          <div />
          <FieldRow label="Elevation X coordinates (WaveElevxi)" unit="m"
            hint="Space-separated list, one per NWaveElev">
            <input className={s.inp} value={p.WaveElevxi}
              onChange={e => set("WaveElevxi", e.target.value)} />
          </FieldRow>
          <FieldRow label="Elevation Y coordinates (WaveElevyi)" unit="m"
            hint="Space-separated list, one per NWaveElev">
            <input className={s.inp} value={p.WaveElevyi}
              onChange={e => set("WaveElevyi", e.target.value)} />
          </FieldRow>
        </div>
      </Collapsible>

      <Collapsible title="Wave kinematics output points" defaultOpen={false}>
        <div className={s.grid2}>
          <FieldRow label="Number of wave kinematics points (NWaveKin)"
            hint="Kinematics output locations (x/y/z specified in file)">
            <input className={s.inp} type="number" value={p.NWaveKin}
              onChange={e => set("NWaveKin", parseInt(e.target.value) || 0)} />
          </FieldRow>
        </div>
        <div className={s.calloutInfo}>
          The x, y, z coordinates of each NWaveKin point are defined as multi-column
          table rows in the raw .dat file and are preserved verbatim by the GUI.
          Use <em>View</em> to inspect or edit them directly.
        </div>
      </Collapsible>

      <FieldRow
        label="Output channel names (OutList)"
        hint='One quoted channel name per line, e.g. "Wave1Elev"'>
        <textarea
          className={s.outListArea}
          value={p.OutList}
          onChange={e => set("OutList", e.target.value)}
        />
      </FieldRow>
    </div>
  );

  // ── Derived stats ─────────────────────────────────────────────────────────
  const waveModName = WAVE_MOD_NAMES[p.WaveMod] ?? "–";
  const currModName = CURR_MOD_NAMES[p.CurrMod] ?? "–";
  const secondOrder = (p.WvDiffQTF || p.WvSumQTF) && active2ndOrder(p.WaveMod) ? "Yes" : "No";

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={s.panel}>
      {/* Header */}
      <div className={s.header}>
        <Waves size={16} strokeWidth={1.8} style={{ color: ACCENT }} />
        <h1 className={s.title}>SeaState</h1>
        <span className={s.desc}>Incident wave &amp; current conditions</span>
        <span className={s.badge}>sub-module</span>
        <div style={{ flex: 1 }} />
        <button className={`${s.headerBtn} ${s.headerBtnPrimary}`} onClick={handleOpen} type="button">
          <FolderOpen size={12} strokeWidth={2} /> Open .dat
        </button>
        <button className={`${s.headerBtn} ${s.headerBtnSecondary}`} type="button"
          onClick={async () => {
            if (!filePath) {
              onLog?.("warn", "Load a SeaState file first — then View will show the actual file on disk.");
              return;
            }
            try {
              rawContent.current = await invoke("read_text_file", { path: filePath });
              setRawOpen(true);
            } catch (err) {
              onLog?.("error", `Cannot read file: ${err}`);
            }
          }}>
          <Eye size={12} strokeWidth={2} /> View
        </button>
      </div>

      {/* File bar */}
      <div className={[s.fileBar, filePath ? s.fileBarLoaded : ""].join(" ")}>
        <span className={[s.filePath, filePath ? s.filePathSet : ""].join(" ")}>
          {filePath || "No file loaded — open a SeaState .dat file"}
        </span>
        <span className={s.dirtyDot} style={{ opacity: isDirty ? 1 : 0 }} />
        <button
          className={[s.saveBtn, (!isDirty || simRunning) ? s.saveBtnInactive : ""].join(" ")}
          onClick={(!isDirty || simRunning) ? undefined : handleSave}
          type="button"
          title={simRunning ? "OpenFAST is running — save blocked" : "Save (⌘S)"}
        >
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
          <AlertTriangle size={13} style={{ color: "#92400E", flexShrink: 0 }} />
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
            onClick={() => setTab(t.id)} type="button">
            {t.label}
          </button>
        ))}
      </div>

      {/* Content + stats panel */}
      <div className={s.contentRow}>
        <div className={s.formArea}>
          {tab === "quick"   && renderQuick()}
          {tab === "waves"   && renderWaves()}
          {tab === "current" && renderCurrent()}
          {tab === "output"  && renderOutput()}
        </div>

        {/* Right-hand stats panel */}
        <div className={s.statsPanel}>
          <p className={s.statsLabel}>Quick stats</p>
          <div className={s.turbineWrap}>
            <OceanSchematic
              waveHs={activeHsTp(p.WaveMod) ? p.WaveHs : 2}
              waveTp={p.WaveTp}
              waveMod={p.WaveMod}
            />
          </div>
          <div className={s.statsGrid}>
            {[
              ["Model",      waveModName],
              ["Hs",         activeHsTp(p.WaveMod) ? `${p.WaveHs} m` : "—"],
              ["Tp",         activeHsTp(p.WaveMod) ? `${p.WaveTp} s` : "—"],
              ["Dir",        activeWaveDir(p.WaveMod) ? `${p.WaveDir}°` : "—"],
              ["Current",    currModName],
              ["2nd order",  secondOrder],
              ["WaveTMax",   `${p.WaveTMax} s`],
              ["WaveDT",     `${p.WaveDT} s`],
            ].map(([k, v]) => (
              <div key={k} className={s.statCard}>
                <span className={s.statKey}>{k}</span>
                <span className={s.statVal}>{v}</span>
              </div>
            ))}
          </div>

          {/* Guided simulation hint */}
          <div style={{
            marginTop: 4,
            padding: "8px 10px",
            background: `rgba(11,148,139,0.06)`,
            border: `0.5px solid rgba(11,148,139,0.18)`,
            borderRadius: 8,
          }}>
            <p style={{ fontSize: 10.5, color: ACCENT, fontWeight: 600, marginBottom: 4 }}>
              Guided simulation
            </p>
            <p style={{ fontSize: 10.5, color: "var(--tx-4)", lineHeight: 1.5 }}>
              Fields tagged <span style={{
                fontSize: 9.5, fontWeight: 600,
                background: "var(--bg-muted)",
                border: "0.5px solid var(--bd-subtle)",
                borderRadius: 4, padding: "1px 5px",
                color: "var(--tx-6)",
              }}>n/a</span> have no effect for WaveMod={p.WaveMod} ({waveModName}) and are
              visually disabled to reduce configuration errors.
            </p>
          </div>
        </div>
      </div>

      {rawOpen && (
        <RawFileModal
          content={rawContent.current}
          filename={filePath ? filePath.split("/").pop() : "SeaState.dat"}
          fromDisk={!!filePath}
          hasDirtyWarning={isDirty}
          onClose={() => setRawOpen(false)}
        />
      )}
    </div>
  );
}
