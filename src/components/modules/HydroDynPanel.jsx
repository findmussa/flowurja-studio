import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { invoke }             from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Droplets, FolderOpen, Eye, Save, ChevronDown, ChevronRight, List,
} from "lucide-react";
import RawFileModal from "../RawFileModal";
import InfoPopover from "../InfoPopover";
import s from "./HydroDynPanel.module.css";

const ACCENT = "#1878C5";

// ── InfoPopover content dictionary ────────────────────────────────────────────
const INFO = {
  PotMod: {
    param: "PotMod",
    desc: "Selects the hydrodynamic model. Strip-theory (Morison) is applied to all members regardless; PotMod controls whether WAMIT-based potential-flow loads are added on top.",
    range: "0, 1, 2",
    default: "0",
    note: "0 = Morison only (monopile, jacket) · 1 = WAMIT-based potential flow (semi-sub, spar, barge) · 2 = Fluid-impulse theory (FIT). Set to 0 for fixed-bottom monopiles.",
  },
  ExctnMod: {
    param: "ExctnMod",
    desc: "Method for computing wave excitation forces. Only active when PotMod = 1.",
    range: "0–2",
    default: "0",
    note: "0 = none · 1 = DFT-based (interpolated from WAMIT QTFs) · 2 = state-space approximation (requires *.ssexctn file from WAMIT post-processor). Not used when PotMod ≠ 1.",
  },
  RdtnMod: {
    param: "RdtnMod",
    desc: "Method for computing radiation memory (retardation) effect. Only active when PotMod = 1.",
    range: "0–2",
    default: "0",
    note: "0 = no memory effect (added-mass only) · 1 = convolution of impulse-response function (most common) · 2 = state-space approximation (requires *.ss file). Not used when PotMod ≠ 1.",
  },
  RdtnTMax: {
    param: "RdtnTMax",
    desc: "Time over which the radiation impulse-response function (IRF) is computed and stored.",
    range: "> 0",
    default: "60.0",
    unit: "s",
    note: "Should be long enough for the IRF to decay to zero — typically 60–120 s. Increasing this improves low-frequency radiation accuracy but increases memory and startup cost. Only used when RdtnMod = 1.",
  },
  PotFile: {
    param: "PotFile",
    desc: "Root path to WAMIT output files (without extension). HydroDyn appends .1, .3, .hst, .4 etc.",
    default: "unused",
    note: "Must match the path given when running WAMIT. Provide an absolute path or a path relative to the HydroDyn input file. Not used when PotMod = 0.",
  },
  WaveDisp: {
    param: "WaveDisp",
    desc: "Determines where wave kinematics are evaluated for Morison elements.",
    range: "0, 1",
    default: "0",
    note: "0 = undisplaced (mean) position — computationally cheaper, adequate for small-amplitude platform motion. 1 = instantaneous displaced position — recommended for floating platforms with large surge/sway.",
  },
  AMMod: {
    param: "AMMod",
    desc: "Controls how added-mass (inertia) forces are distributed along Morison members near the free surface.",
    range: "0, 2",
    default: "0",
    note: "0 = only nodes below mean SWL contribute to added-mass forces (always correct for still water or WaveMod=0). 2 = extends contributions to the instantaneous free surface — must match WaveDisp=1. Set to 0 when WaveMod=0.",
  },
  NBodyMod: {
    param: "NBodyMod",
    desc: "Coupling model for multiple WAMIT bodies (NBody > 1).",
    range: "1–3",
    default: "1",
    note: "1 = fully coupled (single WAMIT run with all bodies together) · 2 = decoupled, XBODY coordinates = 0 · 3 = decoupled, XBODY coordinates ≠ 0. Ignored when NBody = 1.",
  },
};

// ── Tabs ──────────────────────────────────────────────────────────────────────
const TABS = [
  { id: "overview",  label: "Overview"        },
  { id: "potflow",   label: "Potential Flow"  },
  { id: "strip",     label: "Strip Theory"    },
  { id: "output",    label: "Output"          },
];

// ── Defaults (HydroDyn v2.03, strip-theory only / monopile) ──────────────────
const DEFAULT = {
  Echo: false,
  // Potential flow
  PotMod:       0,
  ExctnMod:     0,
  ExctnDisp:    0,
  ExctnCutOff:  10,
  PtfmYMod:     0,
  PtfmRefY:     0,
  PtfmYCutOff:  0.01,
  NExctnHdg:    36,
  RdtnMod:      0,
  RdtnTMax:     60,
  RdtnDT:       0,
  NBody:        1,
  NBodyMod:     1,
  PotFile:      "unused",
  WAMITULEN:    1,
  PtfmRefxt:    0,
  PtfmRefyt:    0,
  PtfmRefzt:    0,
  PtfmRefztRot: 0,
  PtfmVol0:     0,
  PtfmCOBxt:    0,
  PtfmCOByt:    0,
  // 2nd-order forces
  MnDrift:      0,
  NewmanApp:    0,
  DiffQTF:      0,
  SumQTF:       0,
  // Strip theory
  WaveDisp:     0,
  AMMod:        0,
  // Parsed structure info (read-only, from file)
  NJoints:      0,
  NMembers:     0,
  NAxCoef:      1,
  NJOutputs:    0,
  JOutLst:      "",
  // Output
  HDSum:     false,
  OutAll:    false,
  OutSwtch:  2,
  OutFmt:    "ES11.4e2",
  OutSFmt:   "A11",
  // Output channels (like ServoDyn's OutList)
  OutList:   "",
};

// ── Parser: extracts KV pairs and structural counts from HydroDyn file ────────
function parseHydroDynFile(content) {
  const kv = {};
  const lines = content.split(/\r?\n/);
  let inOutChannels = false;
  const outLines = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Detect "OUTPUT CHANNELS" or similar end-section
    if (inOutChannels) {
      if (/^END\b/i.test(line)) { inOutChannels = false; break; }
      const m = line.match(/^"([^"]+)"/);
      if (m) outLines.push(`"${m[1]}"`);
      continue;
    }

    // Detect start of output channels section
    if (/OUTPUT\s+CHANNEL/i.test(line) && !line.startsWith("!")) {
      inOutChannels = true;
      continue;
    }

    // Skip blank lines, comments, and section dividers
    if (!line || line.startsWith("!") || /^={4,}/.test(line) || /^-{4,}/.test(line)) continue;

    // Parse value + key
    let rest = line;
    let value;

    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      if (end < 0) continue;
      value = rest.slice(1, end);
      rest  = rest.slice(end + 1).trim();
    } else {
      // Split at first whitespace — handle tab-prefixed lines
      const sp = rest.search(/\s/);
      if (sp < 0) continue;
      value = rest.slice(0, sp);
      rest  = rest.slice(sp).trim();
    }

    const keyMatch = rest.match(/^(\w[\w_()]*)/);
    if (!keyMatch) continue;
    const key = keyMatch[1];
    kv[key] = value;
  }

  if (outLines.length) kv["__OutList__"] = outLines.join("\n");
  return kv;
}

function hdParsedToState(kv) {
  const st = { ...DEFAULT };
  const b = v => typeof v === "string" && v.toLowerCase() === "true";
  const n = v => v !== undefined && !isNaN(Number(v)) ? Number(v) : undefined;

  const boolKeys = ["Echo", "HDSum", "OutAll"];
  for (const k of boolKeys) {
    if (kv[k] !== undefined) st[k] = b(kv[k]);
  }

  const intKeys = [
    "PotMod", "ExctnMod", "ExctnDisp", "NExctnHdg", "PtfmYMod",
    "RdtnMod", "NBody", "NBodyMod",
    "MnDrift", "NewmanApp", "DiffQTF", "SumQTF",
    "WaveDisp", "AMMod",
    "NJoints", "NMembers", "NAxCoef",
    "NJOutputs", "OutSwtch",
  ];
  for (const k of intKeys) {
    const v = n(kv[k]); if (v !== undefined) st[k] = Math.round(v);
  }

  const floatKeys = [
    "ExctnCutOff", "PtfmRefY", "PtfmYCutOff",
    "RdtnTMax", "RdtnDT",
    "WAMITULEN", "PtfmRefxt", "PtfmRefyt", "PtfmRefzt", "PtfmRefztRot",
    "PtfmVol0", "PtfmCOBxt", "PtfmCOByt",
  ];
  for (const k of floatKeys) {
    const v = n(kv[k]); if (v !== undefined) st[k] = v;
  }

  // String fields
  if (kv["PotFile"] !== undefined) st.PotFile = kv["PotFile"];
  if (kv["OutFmt"]  !== undefined) st.OutFmt  = kv["OutFmt"];
  if (kv["OutSFmt"] !== undefined) st.OutSFmt = kv["OutSFmt"];

  // JOutLst: might be "1,2" or "1" etc. — keep as string
  if (kv["JOutLst"] !== undefined) st.JOutLst = kv["JOutLst"];

  if (kv["__OutList__"]) st.OutList = kv["__OutList__"];

  return st;
}

// ── File builder: line-by-line substitution preserving tables ─────────────────
// Only replaces lines whose key matches our managed set; all else passes through.
function buildHydroDynContent(originalContent, p) {
  // Map: file-key → new formatted value string
  const SUBS = {
    Echo:        () => p.Echo    ? "True " : "False",
    HDSum:       () => p.HDSum   ? "True " : "False",
    OutAll:      () => p.OutAll  ? "True " : "False",
    PotMod:      () => String(p.PotMod),
    ExctnMod:    () => String(p.ExctnMod),
    ExctnDisp:   () => String(p.ExctnDisp),
    ExctnCutOff: () => String(p.ExctnCutOff),
    PtfmYMod:    () => String(p.PtfmYMod),
    PtfmRefY:    () => String(p.PtfmRefY),
    PtfmYCutOff: () => String(p.PtfmYCutOff),
    NExctnHdg:   () => String(p.NExctnHdg),
    RdtnMod:     () => String(p.RdtnMod),
    RdtnTMax:    () => String(p.RdtnTMax),
    RdtnDT:      () => String(p.RdtnDT),
    NBodyMod:    () => String(p.NBodyMod),
    PotFile:     () => `"${p.PotFile}"`,
    WAMITULEN:   () => String(p.WAMITULEN),
    PtfmRefxt:   () => String(p.PtfmRefxt),
    PtfmRefyt:   () => String(p.PtfmRefyt),
    PtfmRefzt:   () => String(p.PtfmRefzt),
    PtfmRefztRot:() => String(p.PtfmRefztRot),
    PtfmVol0:    () => String(p.PtfmVol0),
    PtfmCOBxt:   () => String(p.PtfmCOBxt),
    PtfmCOByt:   () => String(p.PtfmCOByt),
    MnDrift:     () => String(p.MnDrift),
    NewmanApp:   () => String(p.NewmanApp),
    DiffQTF:     () => String(p.DiffQTF),
    SumQTF:      () => String(p.SumQTF),
    WaveDisp:    () => String(p.WaveDisp),
    AMMod:       () => String(p.AMMod),
    OutSwtch:    () => String(p.OutSwtch),
    OutFmt:      () => `"${p.OutFmt}"`,
    OutSFmt:     () => `"${p.OutSFmt}"`,
    JOutLst:     () => p.JOutLst || "none",
    NJOutputs:   () => String(p.NJOutputs),
  };

  const lines = originalContent.split(/\r?\n/);
  const result = [];
  let inOutChannels = false;
  let outListInserted = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    // Handle OUTPUT CHANNELS section
    if (inOutChannels) {
      if (/^END\b/i.test(trimmed)) {
        // Insert new channel list before END
        if (!outListInserted) {
          const newChannels = (p.OutList || "")
            .split("\n").map(l => l.trim()).filter(l => l)
            .map(l => l.startsWith('"') ? l : `"${l}"`);
          result.push(...newChannels);
          outListInserted = true;
        }
        result.push(rawLine); // keep original END line
        inOutChannels = false;
      }
      // Skip all original channel entries (replaced above)
      continue;
    }

    // Detect start of output channels section
    if (/OUTPUT\s+CHANNEL/i.test(trimmed) && !trimmed.startsWith("!")) {
      result.push(rawLine);
      inOutChannels = true;
      outListInserted = false;
      // Insert channels immediately after header
      const newChannels = (p.OutList || "")
        .split("\n").map(l => l.trim()).filter(l => l)
        .map(l => l.startsWith('"') ? l : `"${l}"`);
      result.push(...newChannels);
      outListInserted = true;
      continue;
    }

    // Skip blank lines, comments, section dividers — pass through unchanged
    if (!trimmed || trimmed.startsWith("!") || /^={4,}/.test(trimmed) || /^-{4,}/.test(trimmed)) {
      result.push(rawLine);
      continue;
    }

    // Try to match: [whitespace] ("quoted" | word) [whitespace] KEY [rest...]
    // The key is the FIRST identifier-like token after the value
    const m = rawLine.match(/^(\s*)("[^"]*"|\S+)(\s+)([\w][\w_()]*)([\s!].*)?$/);
    if (m) {
      const key = m[4];
      if (Object.prototype.hasOwnProperty.call(SUBS, key)) {
        const newVal = SUBS[key]();
        // Preserve original alignment — pad new value to at least old value width
        const oldVal = m[2];
        const padLen = Math.max(oldVal.length, newVal.length);
        const padded = newVal.padEnd(padLen);
        result.push(`${m[1]}${padded}${m[3]}${key}${m[5] || ""}`);
        continue;
      }
    }

    // Not a substitution target — pass through unchanged (preserves all tables)
    result.push(rawLine);
  }

  return result.join("\n");
}

// ── Sub-components ────────────────────────────────────────────────────────────
function SectionHead({ children }) {
  return <h3 className={s.sectionHead}>{children}</h3>;
}

function DisabledHintPortal({ text, rect }) {
  const tipW = 230;
  const left = Math.min(rect.left + rect.width / 2 - tipW / 2, window.innerWidth - tipW - 10);
  const top  = rect.top - 6;
  return createPortal(
    <div style={{
      position: "fixed", left, top, transform: "translateY(-100%)",
      width: tipW,
      background: "color-mix(in srgb, var(--bg-surface) 88%, transparent)",
      backdropFilter: "blur(20px) saturate(1.8)",
      WebkitBackdropFilter: "blur(20px) saturate(1.8)",
      border: "0.5px solid var(--bd)", borderRadius: 9,
      padding: "7px 10px", fontSize: 11.5, color: "var(--tx-3)",
      lineHeight: 1.45, zIndex: 9999, pointerEvents: "none",
      boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
    }}>
      <span style={{ color: ACCENT, fontWeight: 600 }}>Disabled — </span>{text}
    </div>,
    document.body
  );
}

function Field({ label, unit, children, hint, info, disabled = false, disabledHint }) {
  const rowRef = useRef(null);
  const [hintRect, setHintRect] = useState(null);
  const isOff = disabled || !!disabledHint;
  return (
    <div
      ref={rowRef}
      className={[s.field, isOff ? s.fieldDisabled : ""].join(" ")}
      onMouseEnter={() => disabledHint && rowRef.current && setHintRect(rowRef.current.getBoundingClientRect())}
      onMouseLeave={() => setHintRect(null)}
    >
      <div className={s.fieldHeader}>
        <span className={s.fieldLabel}>{label}</span>
        {unit && <span className={s.unit}>{unit}</span>}
        {info && <InfoPopover content={info} accentColor={ACCENT} />}
        {disabled && !disabledHint && <span className={s.naTag}>n/a</span>}
      </div>
      {children}
      {hint && <span className={s.hint}>{hint}</span>}
      {disabledHint && hintRect && <DisabledHintPortal text={disabledHint} rect={hintRect} />}
    </div>
  );
}

function Toggle({ label, value, onChange, note, disabled = false, disabledHint }) {
  const rowRef = useRef(null);
  const [hintRect, setHintRect] = useState(null);
  const isOff = disabled || !!disabledHint;
  return (
    <div
      ref={rowRef}
      className={[s.toggleRow, isOff ? s.fieldDisabled : ""].join(" ")}
      onMouseEnter={() => disabledHint && rowRef.current && setHintRect(rowRef.current.getBoundingClientRect())}
      onMouseLeave={() => setHintRect(null)}
    >
      <button
        className={[s.toggle, value ? s.on : ""].join(" ")}
        onClick={() => !isOff && onChange(!value)}
        type="button"
      >
        <span className={s.toggleThumb} />
      </button>
      <span className={s.toggleLabel}>{label}</span>
      {note && <span className={s.toggleNote}>{note}</span>}
      {disabled && !disabledHint && <span className={s.naTag}>n/a</span>}
      {disabledHint && hintRect && <DisabledHintPortal text={disabledHint} rect={hintRect} />}
    </div>
  );
}

function SelField({ label, value, onChange, options, hint, info, disabledHint, disabled = false }) {
  return (
    <Field label={label} hint={hint} info={info} disabledHint={disabledHint} disabled={disabled}>
      <select className={s.select} value={value} onChange={e => onChange(Number(e.target.value))}>
        {options.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
    </Field>
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

// ── Offshore monopile SVG schematic ──────────────────────────────────────────
function OffshoreSchematic() {
  const c = ACCENT;
  return (
    <svg viewBox="0 0 100 120" width="100%" height="180" style={{ display: "block" }}>
      {/* Sky / water gradient regions */}
      <rect x="0" y="60" width="100" height="60" fill={c} fillOpacity="0.07" rx="4" />
      {/* Water surface line */}
      <path d="M0 60 Q15 57 25 60 Q40 63 55 60 Q70 57 85 60 Q95 63 100 60" stroke={c} strokeWidth="1.2" fill="none" strokeOpacity="0.5" />
      {/* Seabed */}
      <rect x="0" y="108" width="100" height="12" fill={c} fillOpacity="0.12" />
      {/* Monopile substructure */}
      <rect x="44" y="58" width="12" height="52" fill={c} fillOpacity="0.18" stroke={c} strokeWidth="0.8" strokeOpacity="0.50" />
      {/* Tower above water */}
      <rect x="46" y="20" width="8" height="42" fill={c} fillOpacity="0.28" stroke={c} strokeWidth="0.8" strokeOpacity="0.60" />
      {/* Nacelle */}
      <rect x="42" y="16" width="16" height="7" rx="2" fill={c} fillOpacity="0.35" />
      {/* Hub */}
      <circle cx="50" cy="19" r="2.8" fill={c} />
      {/* Blades */}
      <line x1="50" y1="16" x2="50" y2="4"   stroke={c} strokeWidth="2.5" strokeLinecap="round" />
      <line x1="47" y1="21" x2="36" y2="27"  stroke={c} strokeWidth="2.5" strokeLinecap="round" />
      <line x1="53" y1="21" x2="64" y2="27"  stroke={c} strokeWidth="2.5" strokeLinecap="round" />
      {/* Wave crests */}
      <path d="M8 64 Q14 61 20 64" stroke={c} strokeWidth="0.8" fill="none" strokeOpacity="0.4" />
      <path d="M30 62 Q36 59 42 62" stroke={c} strokeWidth="0.8" fill="none" strokeOpacity="0.4" />
      <path d="M60 64 Q66 61 72 64" stroke={c} strokeWidth="0.8" fill="none" strokeOpacity="0.4" />
      <path d="M78 62 Q84 59 90 62" stroke={c} strokeWidth="0.8" fill="none" strokeOpacity="0.4" />
      {/* Label */}
      <text x="4" y="118" fontSize="6" fill={c} fontFamily="-apple-system,sans-serif" opacity="0.7">HydroDyn</text>
    </svg>
  );
}

// ── HydroDyn output variable catalogue ───────────────────────────────────────
const HD_OUT_VARS = [
  { group: "Total Hydrodynamic Loads", vars: [
    { name: "HydroFxi",  unit: "N",   desc: "Total hydrodynamic X-force at platform reference point" },
    { name: "HydroFyi",  unit: "N",   desc: "Total hydrodynamic Y-force at platform reference point" },
    { name: "HydroFzi",  unit: "N",   desc: "Total hydrodynamic Z-force at platform reference point" },
    { name: "HydroMxi",  unit: "N·m", desc: "Total hydrodynamic X-moment at platform reference point" },
    { name: "HydroMyi",  unit: "N·m", desc: "Total hydrodynamic Y-moment at platform reference point" },
    { name: "HydroMzi",  unit: "N·m", desc: "Total hydrodynamic Z-moment at platform reference point" },
  ]},
  { group: "Wave Elevation", vars: [
    { name: "Wave1Elev", unit: "m", desc: "Wave surface elevation at output point 1" },
    { name: "Wave2Elev", unit: "m", desc: "Wave surface elevation at output point 2" },
    { name: "Wave3Elev", unit: "m", desc: "Wave surface elevation at output point 3" },
    { name: "Wave4Elev", unit: "m", desc: "Wave surface elevation at output point 4" },
    { name: "Wave5Elev", unit: "m", desc: "Wave surface elevation at output point 5" },
  ]},
  { group: "Potential Flow — Body 1 Wave Excitation (PotMod=1)", vars: [
    { name: "B1WaveF1xi", unit: "N",   desc: "WAMIT wave excitation X-force on body 1" },
    { name: "B1WaveF1yi", unit: "N",   desc: "WAMIT wave excitation Y-force on body 1" },
    { name: "B1WaveF1zi", unit: "N",   desc: "WAMIT wave excitation Z-force on body 1" },
    { name: "B1WaveMxi",  unit: "N·m", desc: "WAMIT wave excitation roll moment on body 1" },
    { name: "B1WaveMyi",  unit: "N·m", desc: "WAMIT wave excitation pitch moment on body 1" },
    { name: "B1WaveMzi",  unit: "N·m", desc: "WAMIT wave excitation yaw moment on body 1" },
  ]},
  { group: "Potential Flow — Body 1 Radiation (PotMod=1, RdtnMod≠0)", vars: [
    { name: "B1RadF1xi",  unit: "N",   desc: "WAMIT radiation X-force on body 1" },
    { name: "B1RadF1yi",  unit: "N",   desc: "WAMIT radiation Y-force on body 1" },
    { name: "B1RadF1zi",  unit: "N",   desc: "WAMIT radiation Z-force on body 1" },
    { name: "B1RadMxi",   unit: "N·m", desc: "WAMIT radiation roll moment on body 1" },
    { name: "B1RadMyi",   unit: "N·m", desc: "WAMIT radiation pitch moment on body 1" },
    { name: "B1RadMzi",   unit: "N·m", desc: "WAMIT radiation yaw moment on body 1" },
  ]},
  { group: "Potential Flow — Body 1 Added Mass (PotMod=1)", vars: [
    { name: "B1AMF1xi",   unit: "N",   desc: "Added-mass X-force on body 1" },
    { name: "B1AMF1yi",   unit: "N",   desc: "Added-mass Y-force on body 1" },
    { name: "B1AMF1zi",   unit: "N",   desc: "Added-mass Z-force on body 1" },
    { name: "B1AMMxi",    unit: "N·m", desc: "Added-mass roll moment on body 1" },
    { name: "B1AMMyi",    unit: "N·m", desc: "Added-mass pitch moment on body 1" },
    { name: "B1AMMzi",    unit: "N·m", desc: "Added-mass yaw moment on body 1" },
  ]},
  { group: "Strip Theory Joint Outputs — Joint 1 (NJOutputs≥1)", vars: [
    { name: "J1VelX",  unit: "m/s",  desc: "Fluid particle X-velocity at output joint 1" },
    { name: "J1VelY",  unit: "m/s",  desc: "Fluid particle Y-velocity at output joint 1" },
    { name: "J1VelZ",  unit: "m/s",  desc: "Fluid particle Z-velocity at output joint 1" },
    { name: "J1AccX",  unit: "m/s²", desc: "Fluid particle X-acceleration at output joint 1" },
    { name: "J1AccY",  unit: "m/s²", desc: "Fluid particle Y-acceleration at output joint 1" },
    { name: "J1AccZ",  unit: "m/s²", desc: "Fluid particle Z-acceleration at output joint 1" },
    { name: "J1DynP",  unit: "Pa",   desc: "Hydrodynamic dynamic pressure at output joint 1" },
  ]},
  { group: "Strip Theory Joint Outputs — Joint 2 (NJOutputs≥2)", vars: [
    { name: "J2VelX",  unit: "m/s",  desc: "Fluid particle X-velocity at output joint 2" },
    { name: "J2VelY",  unit: "m/s",  desc: "Fluid particle Y-velocity at output joint 2" },
    { name: "J2VelZ",  unit: "m/s",  desc: "Fluid particle Z-velocity at output joint 2" },
    { name: "J2AccX",  unit: "m/s²", desc: "Fluid particle X-acceleration at output joint 2" },
    { name: "J2AccY",  unit: "m/s²", desc: "Fluid particle Y-acceleration at output joint 2" },
    { name: "J2AccZ",  unit: "m/s²", desc: "Fluid particle Z-acceleration at output joint 2" },
    { name: "J2DynP",  unit: "Pa",   desc: "Hydrodynamic dynamic pressure at output joint 2" },
  ]},
];

// ── Output variable picker modal (Liquid Glass, identical to ElastoDyn) ───────
function HdOutVarModal({ current, onClose, onApply }) {
  const [selected,  setSelected]  = useState(() => {
    const names = (current || "").split("\n")
      .map(l => l.trim().replace(/^"|"$/g, "")).filter(Boolean);
    return new Set(names);
  });
  const [query,     setQuery]     = useState("");
  const [visible,   setVisible]   = useState(false);
  const [collapsed, setCollapsed] = useState(new Set());

  const toggleGroup = (groupName) =>
    setCollapsed(prev => { const n = new Set(prev); n.has(groupName) ? n.delete(groupName) : n.add(groupName); return n; });

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleClose = () => {
    setVisible(false);
    setTimeout(onClose, 220);
  };

  const handleApply = () => {
    const outList = [...selected].map(n => `"${n}"`).join("\n");
    onApply(outList);
    handleClose();
  };

  const toggle = (name) =>
    setSelected(prev => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; });

  const q = query.toLowerCase();
  const filteredGroups = HD_OUT_VARS.map(g => ({
    ...g,
    vars: q ? g.vars.filter(v =>
      v.name.toLowerCase().includes(q) || v.desc.toLowerCase().includes(q) || v.unit.toLowerCase().includes(q)
    ) : g.vars,
  })).filter(g => g.vars.length > 0);

  return createPortal(
    <div
      className={`${s.modalOverlay} ${visible ? s.modalOverlayVisible : ""}`}
      onClick={handleClose}
    >
      <div
        className={`${s.modal} ${visible ? s.modalVisible : ""}`}
        onClick={e => e.stopPropagation()}
      >
        <div className={s.modalHeader}>
          <span className={s.modalTitle}>HydroDyn — Output variable picker</span>
          <span className={s.modalCount}>{selected.size} selected</span>
          <div style={{ flex: 1 }} />
          <button className={s.modalClose} onClick={handleClose} type="button">✕</button>
        </div>

        <div className={s.modalSearch}>
          <div className={s.modalSearchBox}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, opacity: 0.4 }}>
              <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.5"/>
              <line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <input
              className={s.modalSearchInput}
              placeholder="Search channels… (name, description, unit)"
              value={query}
              onChange={e => setQuery(e.target.value)}
              autoFocus
            />
          </div>
        </div>

        <div className={s.modalBody}>
          {filteredGroups.map(g => {
            const allOn  = g.vars.every(v => selected.has(v.name));
            const someOn = g.vars.some(v => selected.has(v.name));
            const isOpen = q ? true : !collapsed.has(g.group);
            return (
              <div key={g.group} className={s.varGroup}>
                <div className={s.varGroupHead} onClick={() => toggleGroup(g.group)}>
                  <button
                    type="button"
                    className={`${s.groupCheck} ${allOn ? s.groupCheckAll : someOn ? s.groupCheckSome : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelected(prev => {
                        const n = new Set(prev);
                        if (allOn) g.vars.forEach(v => n.delete(v.name));
                        else       g.vars.forEach(v => n.add(v.name));
                        return n;
                      });
                    }}
                  />
                  <span className={s.groupLabel}>{g.group}</span>
                  <span className={s.varGroupCount}>{g.vars.filter(v => selected.has(v.name)).length}/{g.vars.length}</span>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
                    className={`${s.groupChevron} ${isOpen ? s.groupChevronOpen : ""}`}>
                    <polyline points="2,4 6,8 10,4" stroke="currentColor" strokeWidth="1.5"
                      strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                <div className={`${s.varGroupBody} ${!isOpen ? s.varGroupBodyCollapsed : ""}`}>
                  <div className={s.varGroupBodyInner}>
                    {g.vars.map(v => (
                      <label key={v.name} className={`${s.varRow} ${selected.has(v.name) ? s.varRowOn : ""}`}>
                        <input
                          type="checkbox"
                          className={s.varCheck}
                          checked={selected.has(v.name)}
                          onChange={() => toggle(v.name)}
                        />
                        <span className={s.varName}>{v.name}</span>
                        <span className={s.varUnit}>{v.unit}</span>
                        <span className={s.varDesc}>{v.desc}</span>
                        {selected.has(v.name) && (
                          <svg width="11" height="11" viewBox="0 0 12 12" className={s.varCheck__mark}>
                            <polyline points="1.5,6 4.5,9 10.5,3" stroke={ACCENT} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
          {filteredGroups.length === 0 && (
            <p className={s.varNoMatch}>No channels match &quot;{query}&quot;</p>
          )}
        </div>

        <div className={s.modalFooter}>
          <button className={s.modalCancelBtn} onClick={handleClose} type="button">Cancel</button>
          <button className={s.modalApplyBtn} onClick={handleApply} type="button">
            Apply {selected.size} channel{selected.size !== 1 ? "s" : ""}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function HydroDynPanel({ onLog, project, filePathFromProject, onDirtyChange, onRegisterSave, simRunning = false }) {
  const [tab,           setTab]           = useState("overview");
  const tabDirRef = useRef(1);
  const [p,             _setP]            = useState(DEFAULT);
  const [filePath,      setFilePath]      = useState("");
  const [isDirtyFlag,   setIsDirtyFlag]   = useState(false);
  const [rawOpen,       setRawOpen]       = useState(false);
  const [showOutVarModal, setShowOutVarModal] = useState(false);
  const rawContent    = useRef("");  // the actual file text from disk
  const originalRef   = useRef(null); // JSON snapshot of last loaded / saved state

  // Dirty-marking wrapper — direct state sets (loadFileFromPath) bypass this
  const setP = useCallback((updater) => {
    _setP(updater);
    setIsDirtyFlag(true);
  }, []);

  const isDirty = !!filePath && isDirtyFlag &&
    originalRef.current !== null && JSON.stringify(p) !== originalRef.current;

  // Revert detection
  useEffect(() => {
    if (!isDirtyFlag || originalRef.current === null) return;
    if (JSON.stringify(p) === originalRef.current) setIsDirtyFlag(false);
  }, [p, isDirtyFlag]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = useCallback((key, val) => setP(prev => ({ ...prev, [key]: val })), []);

  // ── Core file loader ──────────────────────────────────────────────────────
  const loadFileFromPath = useCallback(async (path) => {
    try {
      const content = await invoke("read_text_file", { path });
      rawContent.current = content;
      const kv     = parseHydroDynFile(content);
      const parsed = hdParsedToState(kv);
      originalRef.current = JSON.stringify(parsed);
      _setP(parsed);
      setIsDirtyFlag(false);
      setFilePath(path);
      onLog?.("ok", `Loaded ${path.split("/").pop()}`);
    } catch (e) {
      onLog?.("error", String(e));
    }
  }, [onLog]);

  // ── Open .dat (user-initiated via Browse) ─────────────────────────────────
  const handleOpen = async () => {
    try {
      const f = await openDialog({
        multiple: false,
        filters: [{ name: "HydroDyn", extensions: ["dat", "inp", "txt"] }],
      });
      if (!f) return;
      await loadFileFromPath(f);
    } catch (e) {
      onLog?.("error", String(e));
    }
  };

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (simRunning) {
      onLog?.("warn", "⚠ OpenFAST is running — save blocked to protect the active simulation.");
      return;
    }
    if (!filePath) return;
    try {
      // Re-read the on-disk file so we substitute into the latest version
      // (handles the case where the file was modified outside the app)
      const diskContent = await invoke("read_text_file", { path: filePath }).catch(() => rawContent.current);
      const content = buildHydroDynContent(diskContent, p);
      await invoke("write_text_file", { path: filePath, content });
      rawContent.current = content;
      originalRef.current = JSON.stringify(p);
      setIsDirtyFlag(false);
      onLog?.("info", `Saved ${filePath.split("/").pop()}`);
    } catch (e) {
      onLog?.("error", String(e));
    }
  }, [filePath, p, onLog, simRunning]);

  // ⌘S shortcut
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); handleSave(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  // ── Project integration ───────────────────────────────────────────────────
  useEffect(() => {
    if (!filePathFromProject) return;
    loadFileFromPath(filePathFromProject);
  }, [filePathFromProject]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onRegisterSave?.(handleSave); }, [handleSave]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived names ─────────────────────────────────────────────────────────
  const potModName  = ["None (strip theory only)", "WAMIT-based", "Fluid-impulse (FIT)"][p.PotMod] ?? "–";
  const rdtnModName = ["None", "Convolution", "State-space"][p.RdtnMod] ?? "–";
  const exctnModName= ["None", "DFT", "State-space"][p.ExctnMod] ?? "–";
  const waveDispName= ["Undisplaced position", "Displaced position"][p.WaveDisp] ?? "–";

  // ── Tab renders ───────────────────────────────────────────────────────────
  const renderOverview = () => (
    <div className={`${s.form} ${s.tabEnterFirst}`}>
      <div className={s.callout}>
        HydroDyn computes hydrodynamic loads on the substructure. Wave and current
        conditions (WaveMod, TMax, seeds) are set in the SeaState module.
        For fixed-bottom monopiles use PotMod = 0 (strip theory only).
        For floating platforms set PotMod = 1 and configure WAMIT files in the Potential Flow tab.
      </div>

      <SectionHead>Hydrodynamic Model</SectionHead>
      <div className={s.grid2}>
        <SelField
          label="Potential-flow model (PotMod)"
          value={p.PotMod}
          onChange={v => set("PotMod", v)}
          info={INFO.PotMod}
          options={[
            { v: 0, label: "0 – None (strip theory only)" },
            { v: 1, label: "1 – WAMIT-based" },
            { v: 2, label: "2 – Fluid-impulse (FIT)" },
          ]}
        />
        <SelField
          label="Wave excitation model (ExctnMod)"
          value={p.ExctnMod}
          onChange={v => set("ExctnMod", v)}
          info={INFO.ExctnMod}
          disabledHint={p.PotMod !== 1 ? "Set Potential-flow model (PotMod) to 1 – WAMIT-based to enable wave excitation settings" : undefined}
          options={[
            { v: 0, label: "0 – None" },
            { v: 1, label: "1 – DFT" },
            { v: 2, label: "2 – State-space" },
          ]}
        />
        <SelField
          label="Radiation model (RdtnMod)"
          value={p.RdtnMod}
          onChange={v => set("RdtnMod", v)}
          info={INFO.RdtnMod}
          disabledHint={p.PotMod !== 1 ? "Set Potential-flow model (PotMod) to 1 – WAMIT-based to enable radiation memory settings" : undefined}
          options={[
            { v: 0, label: "0 – No memory effect" },
            { v: 1, label: "1 – Convolution" },
            { v: 2, label: "2 – State-space" },
          ]}
        />
      </div>

      <SectionHead>Strip Theory</SectionHead>
      <div className={s.grid2}>
        <SelField
          label="Wave kinematics method (WaveDisp)"
          value={p.WaveDisp}
          onChange={v => set("WaveDisp", v)}
          info={INFO.WaveDisp}
          options={[
            { v: 0, label: "0 – Undisplaced position" },
            { v: 1, label: "1 – Displaced position" },
          ]}
        />
        <SelField
          label="Added-mass force method (AMMod)"
          value={p.AMMod}
          onChange={v => set("AMMod", v)}
          info={INFO.AMMod}
          options={[
            { v: 0, label: "0 – Nodes below SWL only" },
            { v: 2, label: "2 – Up to instantaneous free surface" },
          ]}
          hint="Set to 0 when WaveMod=0 or WaveStMod=0"
        />
      </div>

      {filePath && (
        <>
          <SectionHead>Morison Structure (from file)</SectionHead>
          <div className={s.calloutInfo}>
            {`Loaded from file: ${p.NJoints} joint${p.NJoints !== 1 ? "s" : ""}, ${p.NMembers} member${p.NMembers !== 1 ? "s" : ""}, and ${p.NAxCoef} axial coefficient set${p.NAxCoef !== 1 ? "s" : ""}. Structural geometry tables are preserved verbatim when saving.`}
          </div>
        </>
      )}
    </div>
  );

  const renderPotentialFlow = () => (
    <div className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
      {p.PotMod === 0 && (
        <div className={s.calloutInfo}>
          Potential-flow model is disabled (PotMod = 0). Enable it above to configure
          WAMIT-based hydrodynamics for a floating platform.
        </div>
      )}

      <SectionHead>Potential Flow Configuration</SectionHead>
      <div className={s.grid2}>
        <SelField
          label="Potential-flow model (PotMod)"
          value={p.PotMod}
          onChange={v => set("PotMod", v)}
          info={INFO.PotMod}
          options={[
            { v: 0, label: "0 – None" },
            { v: 1, label: "1 – WAMIT-based" },
            { v: 2, label: "2 – Fluid-impulse (FIT)" },
          ]}
        />
        <Field
          label="WAMIT file root path (PotFile)"
          hint="Unused when PotMod=0"
          info={INFO.PotFile}
          disabledHint={p.PotMod === 0 ? "Set Potential-flow model (PotMod) to 1 or 2 to enable WAMIT file configuration" : undefined}
        >
          <div className={s.fileRow}>
            <input className={s.inp} value={p.PotFile} onChange={e => set("PotFile", e.target.value)} />
            <button className={s.browseBtn} type="button"
              onClick={async () => {
                const f = await openDialog({ multiple: false });
                if (f) set("PotFile", f);
              }}>
              <FolderOpen size={12} strokeWidth={1.8} />
            </button>
          </div>
        </Field>
        <Field
          label="Body length scale (WAMITULEN)"
          unit="m"
          hint="Used to redimensionalize WAMIT output"
          disabledHint={p.PotMod === 0 ? "Set Potential-flow model (PotMod) to 1 or 2 to enable WAMIT file configuration" : undefined}
        >
          <input className={s.inp} value={p.WAMITULEN}
            onChange={e => set("WAMITULEN", parseFloat(e.target.value) || p.WAMITULEN)} />
        </Field>
        <Field
          label="Body coupling model (NBodyMod)"
          hint="1=coupled, 2=decoupled (XBODY=0), 3=decoupled (XBODY≠0)"
          info={INFO.NBodyMod}
          disabledHint={p.PotMod === 0 ? "Set Potential-flow model (PotMod) to 1 or 2 to enable WAMIT file configuration" : undefined}
        >
          <select className={s.select} value={p.NBodyMod} onChange={e => set("NBodyMod", Number(e.target.value))}>
            {[{ v: 1, l: "1 – Coupled" }, { v: 2, l: "2 – Decoupled XBODY=0" }, { v: 3, l: "3 – Decoupled XBODY≠0" }]
              .map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
        </Field>
      </div>

      <Collapsible title="Wave excitation & radiation" defaultOpen={p.PotMod === 1}>
        <div className={s.grid2}>
          <SelField
            label="Wave excitation model (ExctnMod)"
            value={p.ExctnMod}
            onChange={v => set("ExctnMod", v)}
            info={INFO.ExctnMod}
            disabledHint={p.PotMod !== 1 ? "Set Potential-flow model (PotMod) to 1 – WAMIT-based to enable wave excitation settings" : undefined}
            options={[
              { v: 0, label: "0 – None" },
              { v: 1, label: "1 – DFT" },
              { v: 2, label: "2 – State-space (*.ssexctn required)" },
            ]}
          />
          <SelField
            label="Wave excitation displacement (ExctnDisp)"
            value={p.ExctnDisp}
            onChange={v => set("ExctnDisp", v)}
            hint="Used when ExctnMod>0"
            disabledHint={p.PotMod !== 1 ? "Set Potential-flow model (PotMod) to 1 – WAMIT-based to enable wave excitation settings" : undefined}
            options={[
              { v: 0, label: "0 – Undisplaced position" },
              { v: 1, label: "1 – Displaced position" },
              { v: 2, label: "2 – Low-pass filtered displaced" },
            ]}
          />
          <Field
            label="Excitation cut-off frequency (ExctnCutOff)"
            unit="Hz"
            disabledHint={p.PotMod !== 1 ? "Set Potential-flow model (PotMod) to 1 – WAMIT-based to enable wave excitation settings" : p.ExctnDisp !== 2 ? "Set ExctnDisp to 2 (Low-pass filtered displaced) to enable excitation cut-off frequency" : undefined}
          >
            <input className={s.inp} value={p.ExctnCutOff}
              onChange={e => set("ExctnCutOff", parseFloat(e.target.value) || p.ExctnCutOff)} />
          </Field>
          <SelField
            label="Radiation memory model (RdtnMod)"
            value={p.RdtnMod}
            onChange={v => set("RdtnMod", v)}
            info={INFO.RdtnMod}
            disabledHint={p.PotMod !== 1 ? "Set Potential-flow model (PotMod) to 1 – WAMIT-based to enable radiation settings" : undefined}
            options={[
              { v: 0, label: "0 – No memory effect" },
              { v: 1, label: "1 – Convolution" },
              { v: 2, label: "2 – State-space (*.ss required)" },
            ]}
          />
          <Field
            label="Radiation analysis time (RdtnTMax)"
            unit="s"
            hint="Should be long enough for IRF to decay to zero"
            info={INFO.RdtnTMax}
            disabledHint={p.PotMod !== 1 ? "Set Potential-flow model (PotMod) to 1 – WAMIT-based to enable radiation settings" : p.RdtnMod === 0 ? "Set Radiation model (RdtnMod) to 1 (Convolution) or 2 (State-space) to enable radiation time parameters" : undefined}
          >
            <input className={s.inp} value={p.RdtnTMax}
              onChange={e => set("RdtnTMax", parseFloat(e.target.value) || p.RdtnTMax)} />
          </Field>
          <Field
            label="Radiation time step (RdtnDT)"
            unit="s"
            hint="DT ≤ RdtnDT ≤ 0.1 recommended"
            disabledHint={p.PotMod !== 1 ? "Set Potential-flow model (PotMod) to 1 – WAMIT-based to enable radiation settings" : p.RdtnMod === 0 ? "Set Radiation model (RdtnMod) to 1 (Convolution) or 2 (State-space) to enable radiation time parameters" : undefined}
          >
            <input className={s.inp} value={p.RdtnDT}
              onChange={e => set("RdtnDT", parseFloat(e.target.value) || 0)} />
          </Field>
        </div>
      </Collapsible>

      <Collapsible title="Platform reference offsets (WAMIT origin → platform origin)">
        <div className={s.grid3}>
          {[
            ["PtfmRefxt",    "x offset",  "m"],
            ["PtfmRefyt",    "y offset",  "m"],
            ["PtfmRefzt",    "z offset",  "m"],
            ["PtfmRefztRot", "zt rotation","deg"],
            ["PtfmVol0",     "Displaced volume", "m³"],
            ["PtfmCOBxt",    "COB x",     "m"],
            ["PtfmCOByt",    "COB y",     "m"],
          ].map(([k, lbl, unit]) => (
            <Field key={k} label={`${lbl} (${k})`} unit={unit}>
              <input className={s.inp} value={p[k]}
                onChange={e => set(k, parseFloat(e.target.value) || 0)} />
            </Field>
          ))}
        </div>
      </Collapsible>

      <Collapsible title="Platform yaw offset model (PtfmYMod)">
        <div className={s.grid2}>
          <SelField
            label="Platform yaw model (PtfmYMod)"
            value={p.PtfmYMod}
            onChange={v => set("PtfmYMod", v)}
            disabledHint={p.PotMod !== 1 ? "Set Potential-flow model (PotMod) to 1 – WAMIT-based to enable platform yaw model settings" : undefined}
            options={[
              { v: 0, label: "0 – Static reference yaw (PtfmRefY)" },
              { v: 1, label: "1 – Dynamic low-pass filtered yaw" },
            ]}
          />
          <Field
            label="Reference yaw offset (PtfmRefY)"
            unit="deg"
            disabledHint={p.PotMod !== 1 ? "Set Potential-flow model (PotMod) to 1 – WAMIT-based to enable platform yaw model settings" : undefined}
          >
            <input className={s.inp} value={p.PtfmRefY}
              onChange={e => set("PtfmRefY", parseFloat(e.target.value) || 0)} />
          </Field>
          <Field
            label="Yaw cut-off frequency (PtfmYCutOff)"
            unit="Hz"
            disabledHint={p.PotMod !== 1 ? "Set Potential-flow model (PotMod) to 1 – WAMIT-based to enable platform yaw model settings" : p.PtfmYMod !== 1 ? "Set PtfmYMod to 1 (Dynamic low-pass filtered yaw) to enable yaw cut-off frequency" : undefined}
          >
            <input className={s.inp} value={p.PtfmYCutOff}
              onChange={e => set("PtfmYCutOff", parseFloat(e.target.value) || p.PtfmYCutOff)} />
          </Field>
          <Field
            label="N heading angles (NExctnHdg)"
            hint="Evenly distributed over ±180°"
            disabledHint={p.PotMod !== 1 ? "Set Potential-flow model (PotMod) to 1 – WAMIT-based to enable platform yaw model settings" : p.PtfmYMod !== 1 ? "Set PtfmYMod to 1 (Dynamic low-pass filtered yaw) to enable number of excitation heading angles" : undefined}
          >
            <input className={s.inp} value={p.NExctnHdg}
              onChange={e => set("NExctnHdg", parseInt(e.target.value) || p.NExctnHdg)} />
          </Field>
        </div>
      </Collapsible>

      <Collapsible title="2nd-order floating platform forces">
        <div className={s.grid2}>
          {[
            ["MnDrift",   "Mean-drift 2nd-order (MnDrift)", "0=none, 7–12=WAMIT file number"],
            ["NewmanApp", "Newman's approximation (NewmanApp)", "0=none, 7–12=WAMIT file"],
            ["DiffQTF",   "Full difference-freq. QTF (DiffQTF)", "0=none, 10–12=WAMIT file"],
            ["SumQTF",    "Full summation-freq. QTF (SumQTF)", "0=none, 10–12=WAMIT file"],
          ].map(([k, lbl, hint]) => (
            <Field
              key={k}
              label={lbl}
              hint={hint}
              disabledHint={p.PotMod !== 1 ? "Set Potential-flow model (PotMod) to 1 – WAMIT-based to enable 2nd-order QTF force configuration" : undefined}
            >
              <input className={s.inp} value={p[k]}
                onChange={e => set(k, parseInt(e.target.value) || 0)} />
            </Field>
          ))}
        </div>
      </Collapsible>
    </div>
  );

  const renderStrip = () => (
    <div className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
      <SectionHead>Strip Theory (Morison)</SectionHead>
      <div className={s.grid2}>
        <SelField
          label="Wave kinematics method (WaveDisp)"
          value={p.WaveDisp}
          onChange={v => set("WaveDisp", v)}
          info={INFO.WaveDisp}
          options={[
            { v: 0, label: "0 – Undisplaced position" },
            { v: 1, label: "1 – Displaced position" },
          ]}
        />
        <SelField
          label="Added-mass method (AMMod)"
          value={p.AMMod}
          onChange={v => set("AMMod", v)}
          info={INFO.AMMod}
          options={[
            { v: 0, label: "0 – Only nodes below SWL" },
            { v: 2, label: "2 – Up to instantaneous free surface" },
          ]}
          hint="Auto-overridden to 0 when WaveMod=0 or WaveStMod=0"
        />
      </div>

      <SectionHead>Morison Member Summary</SectionHead>
      <div className={s.calloutInfo}>
        {filePath
          ? `Loaded: ${p.NJoints} joint${p.NJoints !== 1 ? "s" : ""} and ${p.NMembers} member${p.NMembers !== 1 ? "s" : ""}. Morison geometry tables (joints, members, cross-sections, hydrodynamic coefficients) cannot be edited here yet — use the View button above to edit the raw file directly. In-panel table editing is coming in a future update.`
          : "Morison geometry tables (joints, members, cross-sections, hydrodynamic coefficients) cannot be edited here yet — use the View button above to edit the raw file directly. In-panel table editing is coming in a future update."}
      </div>

      <Collapsible title="Member output list">
        <div className={s.grid2}>
          <Field label="Number of joint outputs (NJOutputs)" hint="Must be < 10">
            <input className={s.inp} value={p.NJOutputs}
              onChange={e => set("NJOutputs", parseInt(e.target.value) || 0)} />
          </Field>
          <Field label="Joint output IDs (JOutLst)" hint="Comma-separated joint IDs, e.g. 1,2">
            <input className={s.inp} value={p.JOutLst}
              onChange={e => set("JOutLst", e.target.value)} />
          </Field>
        </div>
      </Collapsible>
    </div>
  );

  const renderOutput = () => (
    <div className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
      <SectionHead>Output Options</SectionHead>
      <div className={s.grid2}>
        <Field label="Output destination (OutSwtch)"
          hint="1=HydroDyn.out, 2=GlueCode.out, 3=both">
          <select className={s.select} value={p.OutSwtch}
            onChange={e => set("OutSwtch", Number(e.target.value))}>
            <option value={1}>1 – HydroDyn.out</option>
            <option value={2}>2 – GlueCode.out</option>
            <option value={3}>3 – Both files</option>
          </select>
        </Field>
        <Field label="Numeric format (OutFmt)">
          <input className={s.inp} value={p.OutFmt} onChange={e => set("OutFmt", e.target.value)} />
        </Field>
        <Field label="Header format (OutSFmt)">
          <input className={s.inp} value={p.OutSFmt} onChange={e => set("OutSFmt", e.target.value)} />
        </Field>
      </div>

      <div className={s.toggleGrid}>
        <Toggle label="Write summary file (HDSum)" value={p.HDSum} onChange={v => set("HDSum", v)} />
        <Toggle label="Output all member/joint loads (OutAll)" value={p.OutAll} onChange={v => set("OutAll", v)}
          note="Member end loads only, not interior" />
        <Toggle label="Echo input file (Echo)" value={p.Echo} onChange={v => set("Echo", v)} />
      </div>

      <SectionHead>Output Channel List (OutList)</SectionHead>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <button type="button" className={s.pickVarsBtn} onClick={() => setShowOutVarModal(true)}>
          <List size={12} strokeWidth={2} />
          Pick variables…
        </button>
        <span style={{ fontSize: 11.5, color: "var(--tx-4)" }}>One quoted channel name per line</span>
      </div>
      <textarea
        className={s.outListArea}
        value={p.OutList}
        onChange={e => set("OutList", e.target.value)}
        spellCheck={false}
      />
      {showOutVarModal && (
        <HdOutVarModal
          current={p.OutList}
          onClose={() => setShowOutVarModal(false)}
          onApply={(outList) => set("OutList", outList)}
        />
      )}
    </div>
  );

  return (
    <div className={s.panel}>
      {/* Header */}
      <div className={s.header}>
        <Droplets size={16} strokeWidth={1.8} style={{ color: ACCENT }} />
        <h1 className={s.title}>HydroDyn</h1>
        <span className={s.desc}>Offshore hydrodynamics</span>
        <span className={s.badge}>sub-module</span>
        <div style={{ flex: 1 }} />
        <button className={`${s.headerBtn} ${s.headerBtnPrimary}`} onClick={handleOpen} type="button">
          <FolderOpen size={12} strokeWidth={2} /> Open .dat
        </button>
        <button className={`${s.headerBtn} ${s.headerBtnSecondary}`} type="button"
          onClick={async () => {
            if (!filePath) {
              onLog?.("warn", "Load a HydroDyn file first — then View will show the actual file on disk.");
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
          {filePath || "No file loaded — open a HydroDyn .dat file"}
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

      {/* Content */}
      <div className={s.contentRow}>
        <div className={s.formArea}>
          {tab === "overview" && renderOverview()}
          {tab === "potflow" && renderPotentialFlow()}
          {tab === "strip"   && renderStrip()}
          {tab === "output"  && renderOutput()}
        </div>

        {/* Stats panel */}
        <div className={s.statsPanel}>
          <p className={s.statsLabel}>Quick stats</p>
          <div className={s.turbineWrap}>
            <OffshoreSchematic />
          </div>
          <div className={s.statsGrid}>
            {[
              ["Pot. flow",   potModName.split(" ")[0]],
              ["Excitation",  exctnModName],
              ["Radiation",   rdtnModName],
              ["WaveDisp",    waveDispName.split(" ")[0]],
              ["AMMod",       p.AMMod === 0 ? "Below SWL" : "Free surf."],
              ["NJoints",     filePath ? String(p.NJoints) : "—"],
              ["NMembers",    filePath ? String(p.NMembers) : "—"],
              ["HDSum",       p.HDSum ? "Yes" : "No"],
            ].map(([k, v]) => (
              <div key={k} className={s.statCard}>
                <span className={s.statKey}>{k}</span>
                <span className={s.statVal}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {rawOpen && (
        <RawFileModal
          content={rawContent.current}
          filename={filePath ? filePath.split("/").pop() : "HydroDyn.dat"}
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
