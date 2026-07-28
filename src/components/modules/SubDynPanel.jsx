import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Layers, FolderOpen, Eye, Save, ChevronDown, ChevronRight } from "lucide-react";
import RawFileModal from "../RawFileModal";
import InfoPopover from "../InfoPopover";
import s from "./SubDynPanel.module.css";

const ACCENT = "#7C5CBF";

// ── Tabs ──────────────────────────────────────────────────────────────────────
const TABS = [
  { id: "overview",    label: "Overview"      },
  { id: "fem",         label: "FEM & Damping" },
  { id: "output",      label: "Output"        },
];

// ── InfoPopover content dictionary ────────────────────────────────────────────
const INFO = {
  SDdeltaT: {
    param: "SDdeltaT",
    desc: 'Local integration time step. "DEFAULT" uses the glue-code (OpenFAST) time step.',
    default: "DEFAULT",
    note: "SubDyn uses an independent integrator. Smaller steps may be needed for stiff structures. Keep DEFAULT unless convergence issues arise.",
  },
  IntMethod: {
    param: "IntMethod",
    desc: "Integration method for SubDyn equations of motion.",
    range: "1–4",
    default: "3",
    note: "1=RK4 (explicit, robust) · 2=AB4 (Adams-Bashforth) · 3=ABM4 (Adams-Bashforth-Moulton, recommended) · 4=AM2 (Adams-Moulton, implicit)",
  },
  FEMMod: {
    param: "FEMMod",
    desc: "Finite element model for beam elements.",
    range: "1, 3, 4",
    default: "3",
    note: "1=Euler-Bernoulli (no shear deformation, good for slender members) · 3=2-node Timoshenko (includes shear, recommended for monopiles) · 4=tapered Timoshenko",
  },
  Nmodes: {
    param: "Nmodes",
    desc: "Number of Craig-Bampton internal modes to retain.",
    range: "0 or ≥1",
    default: "0",
    note: "0=Guyan (static) reduction — fastest, suitable for most fixed-bottom structures. >0 retains dynamic internal modes for flexible substructures. <0 retains all modes (expensive).",
  },
  JDampings: {
    param: "JDampings",
    desc: "Damping ratio for each retained CB mode (% of critical damping).",
    range: ">0",
    default: "1.0",
    unit: "%",
    note: "Apply one value to all modes, or a list (one per mode). 1% is typical structural damping for steel. Only used when Nmodes>0.",
  },
  GuyanDampMod: {
    param: "GuyanDampMod",
    desc: "Guyan damping model at the interface/reaction nodes.",
    range: "0–2",
    default: "0",
    note: "0=none · 1=Rayleigh proportional damping (α·M + β·K) · 2=user-specified 6×6 damping matrix in global coords",
  },
  SttcSolve: {
    param: "SttcSolve",
    desc: "Solve equations of motion about static equilibrium rather than undeformed position.",
    default: "True",
    note: "Strongly recommended (True). Ensures the structure starts at rest under gravity and mean loads, avoiding initial transients.",
  },
};

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEFAULT = {
  Echo:          false,
  SDdeltaT:      "DEFAULT",
  IntMethod:     3,
  SttcSolve:     true,
  // FEM & Craig-Bampton
  FEMMod:        3,
  NDiv:          1,
  Nmodes:        0,
  JDampings:     "1.0",
  GuyanDampMod:  0,
  RayleighDampM: "0.0",
  RayleighDampK: "0.0",
  GuyanDampSize: 6,
  // Parsed structure info (read-only, from file)
  NJoints:       0,
  NReact:        0,
  NInterf:       0,
  NMembers:      0,
  NPropSets:     0,
  // Output
  SSSum:         true,
  OutCOSM:       true,
  OutSwtch:      2,
  TabDelim:      true,
  OutFmt:        "ES11.4e2",
  OutSFmt:       "A11",
  OutAll:        false,
  NModes:        0,
  StartGround:   1,
  NMOutputs:     0,
  NJOutputs:     0,
  // Output channels
  OutList:       "",
};

// ── Parser ────────────────────────────────────────────────────────────────────
function parseSubDynFile(content) {
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

    // Detect output channel section — standard modules use "OUTPUT CHANNELS",
    // SubDyn uses "SSOutList" or "SDOutList" (variant depends on file version)
    // embedded in a dashed divider line. Must check BEFORE the divider-skip
    // so the dashes don't hide the keyword.
    if ((/OUTPUT\s+CHANNEL/i.test(line) || /\bS[DS]OutList\b/i.test(line)) && !line.startsWith("!")) {
      inOutChannels = true;
      continue;
    }

    // Skip blank lines, comments, section dividers
    if (!line || line.startsWith("!") || /^={4,}/.test(line) || /^-{4,}/.test(line)) continue;

    let rest = line;
    let value;

    // Quoted value
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      if (end < 0) continue;
      value = rest.slice(1, end);
      rest  = rest.slice(end + 1).trim();
    } else {
      // Comma-separated pair (e.g. RayleighDamp "0.0, 0.0")
      // First try splitting on whitespace
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

// ── Parser for RayleighDamp — two comma-separated values on one line ──────────
// Handles "0.0, 0.0  RayleighDamp" which the generic parser reads only the first token.
function parseSubDynFileExtra(content) {
  const extra = {};
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    // Match: value1, value2  RayleighDamp ...
    const m = rawLine.match(/^\s*([\d.eE+\-]+)\s*,\s*([\d.eE+\-]+)\s+RayleighDamp\b/i);
    if (m) {
      extra.RayleighDampM = m[1];
      extra.RayleighDampK = m[2];
    }
  }
  return extra;
}

// ── State hydrator ────────────────────────────────────────────────────────────
function sdynParsedToState(kv) {
  const st = { ...DEFAULT };
  const b = v => typeof v === "string" && v.toLowerCase() === "true";
  const n = v => v !== undefined && !isNaN(Number(v)) ? Number(v) : undefined;

  const boolKeys = ["Echo", "SttcSolve", "SSSum", "OutCOSM", "TabDelim", "OutAll"];
  for (const k of boolKeys) {
    if (kv[k] !== undefined) st[k] = b(kv[k]);
  }

  const intKeys = [
    "IntMethod", "FEMMod", "NDiv", "Nmodes", "GuyanDampMod", "GuyanDampSize",
    "NJoints", "NReact", "NInterf", "NMembers", "NPropSets",
    "OutSwtch", "OutAll", "NModes", "StartGround", "NMOutputs", "NJOutputs",
  ];
  for (const k of intKeys) {
    const v = n(kv[k]);
    if (v !== undefined) st[k] = Math.round(v);
  }

  // SDdeltaT — keep as string ("DEFAULT" or numeric)
  if (kv["SDdeltaT"] !== undefined) st.SDdeltaT = kv["SDdeltaT"];

  // JDampings — keep as string (could be list)
  if (kv["JDampings"] !== undefined) st.JDampings = kv["JDampings"];

  // Rayleigh damping coefficients
  if (kv["RayleighDampM"] !== undefined) st.RayleighDampM = kv["RayleighDampM"];
  if (kv["RayleighDampK"] !== undefined) st.RayleighDampK = kv["RayleighDampK"];

  // String output fields
  if (kv["OutFmt"]  !== undefined) st.OutFmt  = kv["OutFmt"];
  if (kv["OutSFmt"] !== undefined) st.OutSFmt = kv["OutSFmt"];

  if (kv["__OutList__"]) st.OutList = kv["__OutList__"];

  return st;
}

// ── File builder: line-by-line substitution ────────────────────────────────────
function buildSubDynContent(originalContent, p) {
  const SUBS = {
    Echo:         () => p.Echo        ? "True " : "False",
    SDdeltaT:     () => `"${p.SDdeltaT}"`,
    IntMethod:    () => String(p.IntMethod),
    SttcSolve:    () => p.SttcSolve   ? "True " : "False",
    FEMMod:       () => String(p.FEMMod),
    NDiv:         () => String(p.NDiv),
    Nmodes:       () => String(p.Nmodes),
    JDampings:    () => String(p.JDampings),
    GuyanDampMod: () => String(p.GuyanDampMod),
    GuyanDampSize:() => String(p.GuyanDampSize),
    SSSum:        () => p.SSSum        ? "True " : "False",
    OutCOSM:      () => p.OutCOSM      ? "True " : "False",
    OutSwtch:     () => String(p.OutSwtch),
    TabDelim:     () => p.TabDelim     ? "True " : "False",
    OutFmt:       () => `"${p.OutFmt}"`,
    OutSFmt:      () => `"${p.OutSFmt}"`,
    OutAll:       () => String(p.OutAll ? 1 : 0),
    NModes:       () => String(p.NModes),
    StartGround:  () => String(p.StartGround),
  };

  const lines = originalContent.split(/\r?\n/);
  const result = [];
  let inOutChannels = false;
  let outListInserted = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    // ── Output channels section ──
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
      // Skip original channel entries
      continue;
    }

    if ((/OUTPUT\s+CHANNEL/i.test(trimmed) || /\bS[DS]OutList\b/i.test(trimmed)) && !trimmed.startsWith("!")) {
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

    // Pass through blank, comment, and divider lines unchanged
    if (!trimmed || trimmed.startsWith("!") || /^={4,}/.test(trimmed) || /^-{4,}/.test(trimmed)) {
      result.push(rawLine);
      continue;
    }

    // Special case: RayleighDamp — two comma-separated values
    {
      const rm = rawLine.match(/^(\s*)([\d.eE+\-]+)\s*,\s*([\d.eE+\-]+)(\s+)(RayleighDamp\b)([\s!].*)?$/i);
      if (rm) {
        const newVal = `${p.RayleighDampM}, ${p.RayleighDampK}`;
        result.push(`${rm[1]}${newVal}${rm[4]}${rm[5]}${rm[6] || ""}`);
        continue;
      }
    }

    // General KV substitution
    const m = rawLine.match(/^(\s*)("[^"]*"|\S+)(\s+)([\w][\w_()]*)([\s!].*)?$/);
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

    // Pass through unchanged (preserves all table sections verbatim)
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
      width: tipW, background: "color-mix(in srgb, var(--bg-surface) 88%, transparent)",
      backdropFilter: "blur(20px) saturate(1.8)", WebkitBackdropFilter: "blur(20px) saturate(1.8)",
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

function Field({ label, unit, children, hint, popover, disabled = false, disabledHint }) {
  const rowRef = useRef(null);
  const [hintRect, setHintRect] = useState(null);
  const isOff = disabled || !!disabledHint;
  return (
    <div ref={rowRef}
      className={[s.field, isOff ? s.fieldDisabled : ""].join(" ")}
      onMouseEnter={() => disabledHint && rowRef.current && setHintRect(rowRef.current.getBoundingClientRect())}
      onMouseLeave={() => setHintRect(null)}>
      <div className={s.fieldHeader}>
        <span className={s.fieldLabel}>{label}</span>
        {unit && <span className={s.unit}>{unit}</span>}
        {popover && <InfoPopover content={popover} accentColor={ACCENT} />}
        {disabled && !disabledHint && <span className={s.naTag}>n/a</span>}
      </div>
      {children}
      {hint && <span className={s.hint}>{hint}</span>}
      {disabledHint && hintRect && <DisabledHintPortal text={disabledHint} rect={hintRect} />}
    </div>
  );
}

function Toggle({ label, value, onChange, note, popover, disabled = false, disabledHint }) {
  const rowRef = useRef(null);
  const [hintRect, setHintRect] = useState(null);
  const isOff = disabled || !!disabledHint;
  return (
    <div ref={rowRef}
      className={[s.toggleRow, isOff ? s.fieldDisabled : ""].join(" ")}
      onMouseEnter={() => disabledHint && rowRef.current && setHintRect(rowRef.current.getBoundingClientRect())}
      onMouseLeave={() => setHintRect(null)}>
      <button
        className={[s.toggle, value ? s.on : ""].join(" ")}
        onClick={() => !isOff && onChange(!value)}
        type="button"
      >
        <span className={s.toggleThumb} />
      </button>
      <span className={s.toggleLabel}>{label}</span>
      {popover && <InfoPopover content={popover} accentColor={ACCENT} />}
      {note && <span className={s.toggleNote}>{note}</span>}
      {disabledHint && hintRect && <DisabledHintPortal text={disabledHint} rect={hintRect} />}
    </div>
  );
}

function SelField({ label, value, onChange, options, hint, popover, disabledHint }) {
  return (
    <Field label={label} hint={hint} popover={popover} disabledHint={disabledHint}>
      <select
        className={s.select}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
      >
        {options.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
    </Field>
  );
}

function Collapsible({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={s.collapsible}>
      <button
        className={s.collapsibleHead}
        onClick={() => setOpen(v => !v)}
        type="button"
      >
        {open
          ? <ChevronDown  size={13} strokeWidth={2} />
          : <ChevronRight size={13} strokeWidth={2} />}
        {title}
      </button>
      {open && <div className={s.collapsibleBody}>{children}</div>}
    </div>
  );
}

// ── Substructure column SVG schematic ─────────────────────────────────────────
function SubstructureSchematic({ femModName, nmodesLabel, intMethodName, nJoints, nMembers, fileLoaded }) {
  const c = ACCENT;
  return (
    <svg viewBox="0 0 100 160" width="100%" height="200" style={{ display: "block" }}>
      {/* Sky */}
      <rect x="0" y="0" width="100" height="80" fill={c} fillOpacity="0.04" />
      {/* Sea */}
      <rect x="0" y="80" width="100" height="80" fill={c} fillOpacity="0.07" rx="0" />
      {/* Seabed */}
      <rect x="0" y="146" width="100" height="14" fill={c} fillOpacity="0.15" />

      {/* Tower */}
      <rect x="44" y="22" width="12" height="62" fill={c} fillOpacity="0.22" stroke={c} strokeWidth="0.8" strokeOpacity="0.55" />

      {/* Transition piece */}
      <rect x="40" y="76" width="20" height="10" rx="1" fill={c} fillOpacity="0.30" stroke={c} strokeWidth="0.8" strokeOpacity="0.60" />

      {/* Monopile below water */}
      <rect x="44" y="84" width="12" height="64" fill={c} fillOpacity="0.18" stroke={c} strokeWidth="0.8" strokeOpacity="0.40" />

      {/* Seabed embedment hatch lines */}
      <line x1="44" y1="148" x2="56" y2="148" stroke={c} strokeWidth="0.6" strokeOpacity="0.35" />
      <line x1="44" y1="152" x2="56" y2="152" stroke={c} strokeWidth="0.6" strokeOpacity="0.25" />
      <line x1="44" y1="156" x2="56" y2="156" stroke={c} strokeWidth="0.6" strokeOpacity="0.15" />

      {/* Nacelle */}
      <rect x="40" y="16" width="20" height="8" rx="2" fill={c} fillOpacity="0.35" />
      {/* Hub */}
      <circle cx="50" cy="20" r="3" fill={c} />
      {/* Blades */}
      <line x1="50" y1="16" x2="50" y2="4"  stroke={c} strokeWidth="2.5" strokeLinecap="round" />
      <line x1="47" y1="23" x2="36" y2="30" stroke={c} strokeWidth="2.5" strokeLinecap="round" />
      <line x1="53" y1="23" x2="64" y2="30" stroke={c} strokeWidth="2.5" strokeLinecap="round" />

      {/* Water surface */}
      <path d="M0 80 Q12 77 22 80 Q35 83 48 80 Q62 77 76 80 Q88 83 100 80"
        stroke={c} strokeWidth="1.2" fill="none" strokeOpacity="0.5" />

      {/* Joint markers on monopile */}
      <circle cx="50" cy="84"  r="1.5" fill={c} fillOpacity="0.70" />
      <circle cx="50" cy="100" r="1.5" fill={c} fillOpacity="0.55" />
      <circle cx="50" cy="116" r="1.5" fill={c} fillOpacity="0.40" />
      <circle cx="50" cy="132" r="1.5" fill={c} fillOpacity="0.30" />

      {/* Annotation: MWL */}
      <text x="4" y="79" fontSize="5" fill={c} fontFamily="-apple-system,sans-serif" opacity="0.55">MWL</text>

      {/* Label */}
      <text x="4" y="158" fontSize="5.5" fill={c} fontFamily="-apple-system,sans-serif" opacity="0.6">SubDyn</text>

      {/* Stats overlay */}
      {fileLoaded && (
        <>
          <text x="60" y="95"  fontSize="5" fill={c} fontFamily="-apple-system,sans-serif" opacity="0.65">{nJoints} jts</text>
          <text x="60" y="103" fontSize="5" fill={c} fontFamily="-apple-system,sans-serif" opacity="0.55">{nMembers} mb</text>
        </>
      )}
    </svg>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function SubDynPanel({
  onLog,
  project,
  filePathFromProject,
  onDirtyChange,
  onRegisterSave,
  simRunning = false,
}) {
  const [tab,             setTab]             = useState("overview");
  const tabDirRef = useRef(1);
  const [p,               _setP]              = useState(DEFAULT);
  const [filePath,        setFilePath]        = useState("");
  const [isDirtyFlag,     setIsDirtyFlag]     = useState(false);
  const [rawOpen,         setRawOpen]         = useState(false);

  const rawContent  = useRef("");
  const originalRef = useRef(null);

  // Dirty-marking wrapper
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

  const set = useCallback((key, val) => setP(prev => ({ ...prev, [key]: val })), [setP]);

  // ── Core file loader ────────────────────────────────────────────────────────
  const loadFileFromPath = useCallback(async (path) => {
    try {
      const content = await invoke("read_text_file", { path });
      rawContent.current = content;
      const kv     = parseSubDynFile(content);
      const extra  = parseSubDynFileExtra(content);
      const merged = { ...kv, ...extra };
      const parsed = sdynParsedToState(merged);
      originalRef.current = JSON.stringify(parsed);
      _setP(parsed);
      setIsDirtyFlag(false);
      setFilePath(path);
      onLog?.("ok", `Loaded ${path.split("/").pop()}`);
    } catch (e) {
      onLog?.("error", String(e));
    }
  }, [onLog]);

  // ── Save ────────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (simRunning) {
      onLog?.("warn", "OpenFAST is running — save blocked to protect the active simulation.");
      return;
    }
    if (!filePath) return;
    try {
      const diskContent = await invoke("read_text_file", { path: filePath }).catch(() => rawContent.current);
      const content = buildSubDynContent(diskContent, p);
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

  // ── Project integration ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!filePathFromProject) return;
    loadFileFromPath(filePathFromProject);
  }, [filePathFromProject]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onRegisterSave?.(handleSave); }, [handleSave]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived display strings ─────────────────────────────────────────────────
  const femModName = {
    1: "Euler-Bernoulli",
    3: "Timoshenko",
    4: "Tap. Timoshenko",
  }[p.FEMMod] ?? String(p.FEMMod);

  const intMethodName = {
    1: "RK4",
    2: "AB4",
    3: "ABM4",
    4: "AM2",
  }[p.IntMethod] ?? String(p.IntMethod);

  const nmodesLabel = p.Nmodes === 0 ? "Guyan" : p.Nmodes < 0 ? "All" : String(p.Nmodes);

  // ── Conditional logic ───────────────────────────────────────────────────────
  const usingGuyan         = p.Nmodes <= 0;
  const rayleighActive     = p.GuyanDampMod === 1;
  const guyanMatrixActive  = p.GuyanDampMod === 2;
  const nmodesOutputActive = p.SSSum;

  // ── Tab renders ─────────────────────────────────────────────────────────────

  const renderOverview = () => (
    <div className={`${s.form} ${s.tabEnterFirst}`}>
      <div className={s.callout}>
        SubDyn computes substructure dynamics for fixed-bottom offshore wind turbines
        using Craig-Bampton (CB) reduction or Guyan static condensation. The structural
        tables (joints, members, cross-sections, boundary conditions) are complex
        multi-column data — they are preserved verbatim when saving.
        Use View to inspect or edit them in the raw file.
      </div>

      <SectionHead>Simulation Control</SectionHead>
      <div className={s.grid2}>
        <Field
          label="Integration time step (SDdeltaT)"
          hint={'"DEFAULT" inherits the OpenFAST glue-code time step'}
          popover={INFO.SDdeltaT}
        >
          <input
            className={s.inp}
            value={p.SDdeltaT}
            onChange={e => set("SDdeltaT", e.target.value)}
          />
        </Field>

        <SelField
          label="Integration method (IntMethod)"
          value={p.IntMethod}
          onChange={v => set("IntMethod", v)}
          options={[
            { v: 1, label: "1 – RK4 (explicit, robust)" },
            { v: 2, label: "2 – AB4 (Adams-Bashforth)" },
            { v: 3, label: "3 – ABM4 (recommended)" },
            { v: 4, label: "4 – AM2 (Adams-Moulton, implicit)" },
          ]}
          popover={INFO.IntMethod}
        />
      </div>

      <div className={s.toggleGrid}>
        <Toggle
          label="Echo input file (Echo)"
          value={p.Echo}
          onChange={v => set("Echo", v)}
        />
        <Toggle
          label="Solve about static equilibrium (SttcSolve)"
          value={p.SttcSolve}
          onChange={v => set("SttcSolve", v)}
          note="Strongly recommended"
          popover={INFO.SttcSolve}
        />
      </div>

      {filePath && (
        <>
          <SectionHead>Structure Summary (from file)</SectionHead>
          <div className={s.calloutInfo}>
            {`The file defines ${p.NJoints} joint${p.NJoints !== 1 ? "s" : ""}, ${p.NMembers} member${p.NMembers !== 1 ? "s" : ""}, ${p.NPropSets} cross-section property set${p.NPropSets !== 1 ? "s" : ""}, ${p.NReact} base reaction joint${p.NReact !== 1 ? "s" : ""}, and ${p.NInterf} interface joint${p.NInterf !== 1 ? "s" : ""}. Structural tables are complex multi-column data — they are preserved verbatim in the file. Use View to inspect or edit them in the raw text.`}
          </div>

          <div className={s.grid2}>
            {[
              ["Joints (NJoints)",            p.NJoints],
              ["Members (NMembers)",           p.NMembers],
              ["Cross-sections (NPropSets)",   p.NPropSets],
              ["Base reactions (NReact)",      p.NReact],
              ["Interface joints (NInterf)",   p.NInterf],
            ].map(([lbl, val]) => (
              <div key={lbl} className={s.statCard} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <span className={s.statKey} style={{ flex: 1 }}>{lbl}</span>
                <span className={s.statVal} style={{ fontSize: 15, fontWeight: 600, color: ACCENT }}>{val}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );

  const renderFEM = () => (
    <div className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
      <SectionHead>Finite Element Model</SectionHead>
      <div className={s.grid2}>
        <SelField
          label="FEM element model (FEMMod)"
          value={p.FEMMod}
          onChange={v => set("FEMMod", v)}
          options={[
            { v: 1, label: "1 – Euler-Bernoulli" },
            { v: 3, label: "3 – Timoshenko (recommended)" },
            { v: 4, label: "4 – Tapered Timoshenko" },
          ]}
          hint="Timoshenko (3) is recommended for offshore monopiles (includes shear deformation)"
          popover={INFO.FEMMod}
        />
        <Field
          label="Sub-elements per member (NDiv)"
          hint="Must be ≥ 1. Increase for large-diameter or tapered members."
        >
          <input
            className={s.inp}
            type="number"
            min={1}
            step={1}
            value={p.NDiv}
            onChange={e => set("NDiv", Math.max(1, parseInt(e.target.value) || 1))}
          />
        </Field>
      </div>

      <SectionHead>Craig-Bampton Reduction</SectionHead>
      <div className={s.grid2}>
        <Field
          label="Internal modes retained (Nmodes)"
          hint="0 = Guyan static reduction. >0 retains dynamic CB modes. <0 = all modes (expensive)."
          popover={INFO.Nmodes}
        >
          <input
            className={s.inp}
            type="number"
            step={1}
            value={p.Nmodes}
            onChange={e => set("Nmodes", parseInt(e.target.value) || 0)}
          />
        </Field>

        <Field
          label="Modal damping ratio (JDampings)"
          unit="%"
          hint="% of critical damping for each retained CB mode"
          popover={INFO.JDampings}
          disabledHint={usingGuyan ? "Set Nmodes > 0 to retain Craig-Bampton dynamic modes and enable per-mode damping ratios" : undefined}
        >
          <input
            className={s.inp}
            value={p.JDampings}
            onChange={e => set("JDampings", e.target.value)}
          />
        </Field>
      </div>

      <SectionHead>Guyan Damping</SectionHead>
      <div className={s.grid2}>
        <SelField
          label="Guyan damping model (GuyanDampMod)"
          value={p.GuyanDampMod}
          onChange={v => set("GuyanDampMod", v)}
          options={[
            { v: 0, label: "0 – None" },
            { v: 1, label: "1 – Rayleigh (α·M + β·K)" },
            { v: 2, label: "2 – User 6×6 matrix" },
          ]}
          popover={INFO.GuyanDampMod}
        />

        <div className={s.grid2} style={{ margin: 0 }}>
          <Field
            label="Mass coeff. α (RayleighDamp M)"
            hint="α·M term"
            disabledHint={!rayleighActive ? (p.GuyanDampMod === 2 ? "Using user 6×6 matrix — Rayleigh coefficients not applicable. Set GuyanDampMod to 1 to use Rayleigh damping instead" : "Set Guyan damping model (GuyanDampMod) to 1 – Rayleigh to enable α and β coefficients") : undefined}
          >
            <input
              className={s.inp}
              value={p.RayleighDampM}
              onChange={e => set("RayleighDampM", e.target.value)}
            />
          </Field>
          <Field
            label="Stiffness coeff. β (RayleighDamp K)"
            hint="β·K term"
            disabledHint={!rayleighActive ? (p.GuyanDampMod === 2 ? "Using user 6×6 matrix — Rayleigh coefficients not applicable. Set GuyanDampMod to 1 to use Rayleigh damping instead" : "Set Guyan damping model (GuyanDampMod) to 1 – Rayleigh to enable α and β coefficients") : undefined}
          >
            <input
              className={s.inp}
              value={p.RayleighDampK}
              onChange={e => set("RayleighDampK", e.target.value)}
            />
          </Field>
        </div>
      </div>

      <Collapsible title="User 6×6 Guyan damping matrix" defaultOpen={guyanMatrixActive}>
        <div className={s.calloutInfo}>
          When GuyanDampMod = 2, a 6×6 symmetric damping matrix (in global coordinates,
          at the interface DOFs) must follow the GuyanDampSize line in the file.
          In-panel matrix editing is coming in a future update — use the View button above
          to edit the raw file directly in the meantime.
        </div>
        <Field
          label="Matrix size indicator (GuyanDampSize)"
          hint="Always 6 for a 6×6 matrix"
          disabledHint={!guyanMatrixActive ? "Set Guyan damping model (GuyanDampMod) to 2 – User 6×6 matrix to enable this section" : undefined}
        >
          <input
            className={s.inp}
            type="number"
            value={p.GuyanDampSize}
            onChange={e => set("GuyanDampSize", parseInt(e.target.value) || 6)}
          />
        </Field>
      </Collapsible>
    </div>
  );

  const renderOutput = () => (
    <div className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
      <SectionHead>Output Flags</SectionHead>
      <div className={s.toggleGrid}>
        <Toggle
          label="Write SubDyn summary file (SSSum)"
          value={p.SSSum}
          onChange={v => set("SSSum", v)}
          note="Strongly recommended for verification"
        />
        <Toggle
          label="Output member cosine matrices (OutCOSM)"
          value={p.OutCOSM}
          onChange={v => set("OutCOSM", v)}
        />
        <Toggle
          label="Output all interface and base joint reactions (OutAll)"
          value={p.OutAll}
          onChange={v => set("OutAll", v)}
        />
        <Toggle
          label="Tab-delimited output (TabDelim)"
          value={p.TabDelim}
          onChange={v => set("TabDelim", v)}
        />
        <Toggle
          label="Output all member forces (StartGround=1)"
          value={p.StartGround === 1}
          onChange={v => set("StartGround", v ? 1 : 0)}
          note="0 = only members listed in MemberOuts"
        />
      </div>

      <SectionHead>Output Settings</SectionHead>
      <div className={s.grid2}>
        <SelField
          label="Output destination (OutSwtch)"
          value={p.OutSwtch}
          onChange={v => set("OutSwtch", v)}
          options={[
            { v: 1, label: "1 – SubDyn.out" },
            { v: 2, label: "2 – GlueCode.out" },
            { v: 3, label: "3 – Both files" },
          ]}
        />
        <Field label="Numeric format (OutFmt)">
          <input
            className={s.inp}
            value={p.OutFmt}
            onChange={e => set("OutFmt", e.target.value)}
          />
        </Field>
        <Field label="Header format (OutSFmt)">
          <input
            className={s.inp}
            value={p.OutSFmt}
            onChange={e => set("OutSFmt", e.target.value)}
          />
        </Field>

        <Field
          label="Modes to output (NModes)"
          hint="Number of CB modes written to summary — requires SSSum=True"
          disabledHint={!nmodesOutputActive ? "Enable Write SubDyn summary file (SSSum) to configure modal output count" : undefined}
        >
          <input
            className={s.inp}
            type="number"
            min={0}
            step={1}
            value={p.NModes}
            onChange={e => set("NModes", Math.max(0, parseInt(e.target.value) || 0))}
          />
        </Field>
      </div>

      <SectionHead>Member & Joint Output Lists (from file)</SectionHead>
      <div className={s.calloutInfo}>
        {`Member output list (NMOutputs = ${p.NMOutputs}) and joint output list (NJOutputs = ${p.NJOutputs}) are multi-column tables in the file and are preserved verbatim when saving. In-panel table editing is coming in a future update — use the View button above to edit them in the raw file directly.`}
      </div>

      <SectionHead>Output Channel List (OutList)</SectionHead>
      <span style={{ fontSize: 11.5, color: "var(--tx-4)", display: "block", marginBottom: 6 }}>
        Quoted channel strings, one per line — preserve signs and comments as-is
      </span>
      <textarea
        className={s.outListArea}
        value={p.OutList}
        onChange={e => set("OutList", e.target.value)}
        spellCheck={false}
      />
    </div>
  );

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className={s.panel}>
      {/* Header */}
      <div className={s.header}>
        <Layers size={16} strokeWidth={1.8} style={{ color: ACCENT }} />
        <h1 className={s.title}>SubDyn</h1>
        <span className={s.desc}>Substructure dynamics</span>
        <span className={s.badge}>sub-module</span>
        <div style={{ flex: 1 }} />
        <button
          className={`${s.headerBtn} ${s.headerBtnPrimary}`}
          onClick={async () => {
            try {
              const f = await openDialog({
                multiple: false,
                filters: [{ name: "SubDyn", extensions: ["dat", "inp", "txt"] }],
              });
              if (!f) return;
              await loadFileFromPath(f);
            } catch (e) {
              onLog?.("error", String(e));
            }
          }}
          type="button"
        >
          <FolderOpen size={12} strokeWidth={2} /> Open .dat
        </button>
        <button
          className={`${s.headerBtn} ${s.headerBtnSecondary}`}
          type="button"
          onClick={async () => {
            if (!filePath) {
              onLog?.("warn", "Load a SubDyn file first — then View will show the actual file on disk.");
              return;
            }
            try {
              rawContent.current = await invoke("read_text_file", { path: filePath });
              setRawOpen(true);
            } catch (err) {
              onLog?.("error", `Cannot read file: ${err}`);
            }
          }}
        >
          <Eye size={12} strokeWidth={2} /> View .dat
        </button>
      </div>

      {/* File bar */}
      <div className={[s.fileBar, filePath ? s.fileBarLoaded : ""].join(" ")}>
        <span className={[s.filePath, filePath ? s.filePathSet : ""].join(" ")}>
          {filePath || "No file loaded — open a SubDyn .dat file"}
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

      {/* Simulation running banner */}
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
          <button
            key={t.id}
            className={[s.tab, tab === t.id ? s.tabActive : ""].join(" ")}
            onClick={() => {
              const oldIdx = TABS.findIndex(x => x.id === tab);
              const newIdx = TABS.findIndex(x => x.id === t.id);
              tabDirRef.current = newIdx >= oldIdx ? 1 : -1;
              setTab(t.id);
            }}
            type="button"
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className={s.contentRow}>
        <div className={s.formArea}>
          {tab === "overview" && renderOverview()}
          {tab === "fem"      && renderFEM()}
          {tab === "output"   && renderOutput()}
        </div>

        {/* Stats panel */}
        <div className={s.statsPanel}>
          <p className={s.statsLabel}>Quick stats</p>
          <div className={s.turbineWrap}>
            <SubstructureSchematic
              femModName={femModName}
              nmodesLabel={nmodesLabel}
              intMethodName={intMethodName}
              nJoints={p.NJoints}
              nMembers={p.NMembers}
              fileLoaded={!!filePath}
            />
          </div>
          <div className={s.statsGrid}>
            {[
              ["FEM model",   femModName],
              ["Reduction",   nmodesLabel === "Guyan" ? "Guyan" : `${nmodesLabel} modes`],
              ["Integrator",  intMethodName],
              ["SttcSolve",   p.SttcSolve ? "Yes" : "No"],
              ["NJoints",     filePath ? String(p.NJoints)  : "—"],
              ["NMembers",    filePath ? String(p.NMembers) : "—"],
              ["NPropSets",   filePath ? String(p.NPropSets): "—"],
              ["SSSum",       p.SSSum ? "On" : "Off"],
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
          filename={filePath ? filePath.split("/").pop() : "SubDyn.dat"}
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
