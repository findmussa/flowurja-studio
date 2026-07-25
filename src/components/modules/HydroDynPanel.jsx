import { useState, useEffect, useCallback, useRef } from "react";
import { invoke }             from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Droplets, FolderOpen, Eye, Save, ChevronDown, ChevronRight,
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

function Field({ label, unit, children, hint, info }) {
  return (
    <div className={s.field}>
      <div className={s.fieldHeader}>
        <span className={s.fieldLabel}>{label}</span>
        {unit && <span className={s.unit}>{unit}</span>}
        {info && <InfoPopover content={info} accentColor={ACCENT} />}
      </div>
      {children}
      {hint && <span className={s.hint}>{hint}</span>}
    </div>
  );
}

// ── Guided-simulation: visually disable a group of fields when inapplicable ──
function FieldDisabled({ disabled, reason, children }) {
  return (
    <div style={disabled
      ? { opacity: 0.38, pointerEvents: "none", position: "relative" }
      : {}}>
      {children}
      {disabled && reason && (
        <p className={s.hint} style={{ marginTop: 4, fontStyle: "italic" }}>{reason}</p>
      )}
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

function SelField({ label, value, onChange, options, hint, info }) {
  return (
    <Field label={label} hint={hint} info={info}>
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

// ── Main component ────────────────────────────────────────────────────────────
export default function HydroDynPanel({ onLog, project, filePathFromProject, onDirtyChange, onRegisterSave, simRunning = false }) {
  const [tab,           setTab]           = useState("overview");
  const [p,             _setP]            = useState(DEFAULT);
  const [filePath,      setFilePath]      = useState("");
  const [isDirtyFlag,   setIsDirtyFlag]   = useState(false);
  const [rawOpen,       setRawOpen]       = useState(false);
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
    <div className={s.form}>
      <div className={s.callout}>
        HydroDyn computes hydrodynamic loads on the substructure. Wave and current
        conditions are defined in the <strong>SeaState</strong> module (in the .fst file).
        For strip-theory monopiles, set PotMod=0. For floating platforms, enable
        potential flow (PotMod=1) and point to WAMIT output files.
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
        <FieldDisabled disabled={p.PotMod !== 1} reason="Requires PotMod = 1 (WAMIT)">
          <SelField
            label="Wave excitation model (ExctnMod)"
            value={p.ExctnMod}
            onChange={v => set("ExctnMod", v)}
            info={INFO.ExctnMod}
            options={[
              { v: 0, label: "0 – None" },
              { v: 1, label: "1 – DFT" },
              { v: 2, label: "2 – State-space" },
            ]}
          />
        </FieldDisabled>
        <FieldDisabled disabled={p.PotMod !== 1} reason="Requires PotMod = 1 (WAMIT)">
          <SelField
            label="Radiation model (RdtnMod)"
            value={p.RdtnMod}
            onChange={v => set("RdtnMod", v)}
            info={INFO.RdtnMod}
            options={[
              { v: 0, label: "0 – No memory effect" },
              { v: 1, label: "1 – Convolution" },
              { v: 2, label: "2 – State-space" },
            ]}
          />
        </FieldDisabled>
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
            The file defines <strong>{p.NJoints}</strong> joint{p.NJoints !== 1 ? "s" : ""},&nbsp;
            <strong>{p.NMembers}</strong> member{p.NMembers !== 1 ? "s" : ""}, and&nbsp;
            <strong>{p.NAxCoef}</strong> axial coefficient set{p.NAxCoef !== 1 ? "s" : ""}.
            Edit these tables directly in the .dat file — use <em>View</em> to open the raw text.
          </div>
        </>
      )}
    </div>
  );

  const renderPotentialFlow = () => (
    <div className={s.form}>
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
        <FieldDisabled disabled={p.PotMod === 0} reason="Not used when PotMod = 0">
          <Field label="WAMIT file root path (PotFile)" hint="Unused when PotMod=0" info={INFO.PotFile}>
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
        </FieldDisabled>
        <FieldDisabled disabled={p.PotMod === 0} reason="Not used when PotMod = 0">
          <Field label="Body length scale (WAMITULEN)" unit="m" hint="Used to redimensionalize WAMIT output">
            <input className={s.inp} value={p.WAMITULEN}
              onChange={e => set("WAMITULEN", parseFloat(e.target.value) || p.WAMITULEN)} />
          </Field>
        </FieldDisabled>
        <FieldDisabled disabled={p.PotMod === 0} reason="Not used when PotMod = 0">
          <Field label="Body coupling model (NBodyMod)"
            hint="1=coupled, 2=decoupled (XBODY=0), 3=decoupled (XBODY≠0)"
            info={INFO.NBodyMod}>
            <select className={s.select} value={p.NBodyMod} onChange={e => set("NBodyMod", Number(e.target.value))}>
              {[{ v: 1, l: "1 – Coupled" }, { v: 2, l: "2 – Decoupled XBODY=0" }, { v: 3, l: "3 – Decoupled XBODY≠0" }]
                .map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </Field>
        </FieldDisabled>
      </div>

      <Collapsible title="Wave excitation & radiation" defaultOpen={p.PotMod === 1}>
        <FieldDisabled disabled={p.PotMod !== 1} reason="These settings only apply when PotMod = 1 (WAMIT-based potential flow)">
          <div className={s.grid2}>
            <SelField
              label="Wave excitation model (ExctnMod)"
              value={p.ExctnMod}
              onChange={v => set("ExctnMod", v)}
              info={INFO.ExctnMod}
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
              options={[
                { v: 0, label: "0 – Undisplaced position" },
                { v: 1, label: "1 – Displaced position" },
                { v: 2, label: "2 – Low-pass filtered displaced" },
              ]}
              hint="Used when ExctnMod>0"
            />
            <FieldDisabled disabled={p.ExctnDisp !== 2} reason="Only active when ExctnDisp = 2">
              <Field label="Excitation cut-off frequency (ExctnCutOff)" unit="Hz">
                <input className={s.inp} value={p.ExctnCutOff}
                  onChange={e => set("ExctnCutOff", parseFloat(e.target.value) || p.ExctnCutOff)} />
              </Field>
            </FieldDisabled>
            <SelField
              label="Radiation memory model (RdtnMod)"
              value={p.RdtnMod}
              onChange={v => set("RdtnMod", v)}
              info={INFO.RdtnMod}
              options={[
                { v: 0, label: "0 – No memory effect" },
                { v: 1, label: "1 – Convolution" },
                { v: 2, label: "2 – State-space (*.ss required)" },
              ]}
            />
            <FieldDisabled disabled={p.RdtnMod === 0} reason="Only active when RdtnMod ≠ 0">
              <Field label="Radiation analysis time (RdtnTMax)" unit="s"
                hint="Should be long enough for IRF to decay to zero"
                info={INFO.RdtnTMax}>
                <input className={s.inp} value={p.RdtnTMax}
                  onChange={e => set("RdtnTMax", parseFloat(e.target.value) || p.RdtnTMax)} />
              </Field>
            </FieldDisabled>
            <FieldDisabled disabled={p.RdtnMod === 0} reason="Only active when RdtnMod ≠ 0">
              <Field label="Radiation time step (RdtnDT)" unit="s"
                hint="DT ≤ RdtnDT ≤ 0.1 recommended">
                <input className={s.inp} value={p.RdtnDT}
                  onChange={e => set("RdtnDT", parseFloat(e.target.value) || 0)} />
              </Field>
            </FieldDisabled>
          </div>
        </FieldDisabled>
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
        <FieldDisabled disabled={p.PotMod !== 1} reason="Platform yaw model only applies to potential-flow bodies (PotMod = 1)">
          <div className={s.grid2}>
            <SelField
              label="Platform yaw model (PtfmYMod)"
              value={p.PtfmYMod}
              onChange={v => set("PtfmYMod", v)}
              options={[
                { v: 0, label: "0 – Static reference yaw (PtfmRefY)" },
                { v: 1, label: "1 – Dynamic low-pass filtered yaw" },
              ]}
            />
            <Field label="Reference yaw offset (PtfmRefY)" unit="deg">
              <input className={s.inp} value={p.PtfmRefY}
                onChange={e => set("PtfmRefY", parseFloat(e.target.value) || 0)} />
            </Field>
            <FieldDisabled disabled={p.PtfmYMod !== 1} reason="Only active when PtfmYMod = 1">
              <Field label="Yaw cut-off frequency (PtfmYCutOff)" unit="Hz">
                <input className={s.inp} value={p.PtfmYCutOff}
                  onChange={e => set("PtfmYCutOff", parseFloat(e.target.value) || p.PtfmYCutOff)} />
              </Field>
            </FieldDisabled>
            <FieldDisabled disabled={p.PtfmYMod !== 1} reason="Only active when PtfmYMod = 1">
              <Field label="N heading angles (NExctnHdg)" hint="Evenly distributed over ±180°">
                <input className={s.inp} value={p.NExctnHdg}
                  onChange={e => set("NExctnHdg", parseInt(e.target.value) || p.NExctnHdg)} />
              </Field>
            </FieldDisabled>
          </div>
        </FieldDisabled>
      </Collapsible>

      <Collapsible title="2nd-order floating platform forces">
        <FieldDisabled disabled={p.PotMod !== 1} reason="2nd-order QTF forces require PotMod = 1 (WAMIT-based potential flow)">
          <div className={s.grid2}>
            {[
              ["MnDrift",   "Mean-drift 2nd-order (MnDrift)", "0=none, 7–12=WAMIT file number"],
              ["NewmanApp", "Newman's approximation (NewmanApp)", "0=none, 7–12=WAMIT file"],
              ["DiffQTF",   "Full difference-freq. QTF (DiffQTF)", "0=none, 10–12=WAMIT file"],
              ["SumQTF",    "Full summation-freq. QTF (SumQTF)", "0=none, 10–12=WAMIT file"],
            ].map(([k, lbl, hint]) => (
              <Field key={k} label={lbl} hint={hint}>
                <input className={s.inp} value={p[k]}
                  onChange={e => set(k, parseInt(e.target.value) || 0)} />
              </Field>
            ))}
          </div>
        </FieldDisabled>
      </Collapsible>
    </div>
  );

  const renderStrip = () => (
    <div className={s.form}>
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
        The Morison member tables (joints, members, cross-section properties, hydrodynamic
        coefficients) are complex multi-column data and are <strong>not editable in this
        panel</strong>. They are preserved verbatim when saving. Use <em>View</em> to
        inspect or edit them directly in the raw file.
        {filePath && (
          <span style={{ marginLeft: 6 }}>
            Currently loaded: <strong>{p.NJoints}</strong> joints,&nbsp;
            <strong>{p.NMembers}</strong> members.
          </span>
        )}
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
    <div className={s.form}>
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

      <Field
        label="Output channel names (OutList)"
        hint='One quoted channel name per line, e.g. "Wave1Elev"'>
        <textarea
          className={s.outListArea}
          value={p.OutList}
          onChange={e => set("OutList", e.target.value)}
        />
      </Field>
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
            onClick={() => setTab(t.id)} type="button">
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
          onClose={() => setRawOpen(false)}
        />
      )}
    </div>
  );
}
