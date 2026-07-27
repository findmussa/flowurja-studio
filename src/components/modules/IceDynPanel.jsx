import { useState, useEffect, useCallback, useRef } from "react";
import { invoke }             from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Snowflake, FolderOpen, Eye, Save, ChevronDown, ChevronRight,
} from "lucide-react";
import RawFileModal  from "../RawFileModal";
import InfoPopover   from "../InfoPopover";
import s from "./IceDynPanel.module.css";

const ACCENT = "#4B9CD3";

// ── Tabs ──────────────────────────────────────────────────────────────────────
const TABS = [
  { id: "overview",   label: "Overview"       },
  { id: "iceprops",  label: "Ice Properties" },
  { id: "output",    label: "Output"          },
];

// ── Ice model metadata ────────────────────────────────────────────────────────
const ICE_MODELS = [
  { v: 1, label: "1 – Crushable ice (intermittent crushing)" },
  { v: 2, label: "2 – Lock-in (frequency lock-in with structure)" },
  { v: 3, label: "3 – Sloped structure (bending failure on cone/slope)" },
  { v: 4, label: "4 – Random ice crushing (stochastic Model 1)" },
  { v: 5, label: "5 – Stress-based ice failure (stochastic)" },
];

const iceModelShortName = (m) => (
  ["–", "Crushable", "Lock-in", "Sloped", "Random", "Stress"][m] ?? "–"
);

// ── InfoPopover content ───────────────────────────────────────────────────────
const INFO = {
  IceModel: {
    param: "IceModel", desc: "Ice loading model type.",
    range: "1–5", default: "1",
    note: "1=Crushable ice (intermittent crushing against structure) · 2=Lock-in (frequency lock-in with structural vibration) · 3=Sloped structure (ice bending failure on cone/slope) · 4=Random crushing (stochastic model 1) · 5=Stress-based (stochastic failure)",
  },
  IceDens: {
    param: "IceDens", desc: "Density of sea ice.",
    range: "850–950 kg/m³", default: "917 (freshwater ice: 917)", unit: "kg/m³",
    note: "Typical sea ice density: 910–940 kg/m³. Freshwater (river) ice: ~917 kg/m³. Use 900 kg/m³ for conservative estimates.",
  },
  IceThickM: {
    param: "IceThickM", desc: "Mean ice sheet thickness.",
    range: ">0 m", default: "0.5", unit: "m",
    note: "Typical Baltic sea ice: 0.3–0.7 m. Arctic first-year ice: 1–2 m. This is the primary driver of ice loads — check site-specific metocean data.",
  },
  IceThickS: {
    param: "IceThickS", desc: "Standard deviation of ice sheet thickness (stochastic models only).",
    range: "≥0 m", default: "0.05", unit: "m",
    note: "Only used in Models 2, 4, 5. For Models 1 and 3 (deterministic loading), this parameter is ignored.",
  },
  IceVelM: {
    param: "IceVelM", desc: "Mean ice drift velocity.",
    range: ">0 m/s", default: "0.3", unit: "m/s",
    note: "Baltic Sea typical: 0.05–0.5 m/s. Arctic: up to 1 m/s. Higher velocities generally produce higher crushing forces. Site-specific climatology required.",
  },
  IceVelS: {
    param: "IceVelS", desc: "Standard deviation of ice drift velocity (stochastic models only).",
    range: "≥0 m/s", default: "0.0", unit: "m/s",
    note: "Only used in Models 2, 4, 5. For Models 1 and 3, set to 0.",
  },
  IceFDmult: {
    param: "IceFDmult", desc: "Multiplier on design ice force (sloped structure only).",
    range: ">0", default: "1.0",
    note: "Only active for IceModel=3 (sloped structure). Scales the computed ice force for design margin.",
  },
  Kice: {
    param: "Kice", desc: "Ice stiffness (crushing spring constant).",
    range: ">0 N/m³", default: "900000", unit: "N/m³",
    note: "Used in Models 1, 2, 3. Represents the local stiffness of ice in the contact region. Not applicable for stochastic models (4, 5).",
  },
  sigf: {
    param: "sigf", desc: "Flexural (bending) strength of ice (for sloped structures, IceModel=3).",
    range: ">0 Pa", default: "1.5e6", unit: "Pa",
    note: "Flexural failure of ice against a sloped structure (cone) produces lower loads than crushing. Typical sea ice: 0.5–1.5 MPa. Lower loads than for vertical pile: advantage of using a cone on the waterline.",
  },
  Pf: {
    param: "Pf", desc: "Ice pressure at failure (crushing strength).",
    range: ">0 Pa", default: "500000", unit: "Pa",
    note: "For freshwater ice: ~500–1500 kPa. For sea ice: ~200–800 kPa. Depends strongly on ice temperature, salinity, and loading rate. Use values from IEC 61400-3-1 or site metocean report.",
  },
  delMax: {
    param: "delMax", desc: "Maximum ice deflection before break-off (sloped structure, IceModel=3).",
    range: ">0 m", default: "0.25", unit: "m",
    note: "The maximum elastic deflection of the ice sheet before it breaks in bending. Only for IceModel=3.",
  },
  Phi: {
    param: "Phi", desc: "Structure slope angle from horizontal (for IceModel=3 sloped structure).",
    range: "15–75 deg", default: "30", unit: "deg",
    note: "A shallower slope (lower Phi) produces lower ice loads by promoting bending failure over crushing. Typical ice-breaking cone: 30–55°. Below 15° ice may ride up without breaking.",
  },
  Zr: {
    param: "Zr", desc: "Height of ice rubble pile above waterline (IceModel=3).",
    range: "≥0 m", default: "2.0", unit: "m",
    note: "Rubble riding up the cone increases the total force. Use site-specific estimates. Only for IceModel=3.",
  },
};

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEFAULT = {
  Echo:       false,
  IceModel:   1,
  IceSumFile: "icedyn.sum",
  IceDens:    900,
  IceThickM:  0.5,
  IceThickS:  0.05,
  IceVelM:    0.3,
  IceVelS:    0.0,
  IceFDmult:  1.0,
  Kice:       900000,
  sigf:       1500000,
  Pf:         500000,
  delMax:     0.25,
  Phi:        30,
  Zr:         2.0,
  SumPrint:   false,
  OutFile:    1,
  TabDelim:   true,
  OutFmt:     "ES11.4e2",
  TStart:     0,
  OutList:    '"IceF_Fx"',
};

// ── Conditional logic helpers ─────────────────────────────────────────────────
// Returns true when the field should be DISABLED for the given IceModel value.
function isDisabled(field, iceModel) {
  switch (field) {
    case "IceThickS":  return iceModel === 1 || iceModel === 3;
    case "IceVelS":    return iceModel === 1 || iceModel === 3;
    case "IceFDmult":  return iceModel !== 3;
    case "Kice":       return iceModel === 4 || iceModel === 5;
    case "sigf":       return iceModel !== 3;
    case "Pf":         return iceModel === 3;
    case "delMax":     return iceModel !== 3;
    case "Phi":        return iceModel !== 3;
    case "Zr":         return iceModel !== 3;
    default:           return false;
  }
}

function disabledStyle(disabled) {
  return { opacity: disabled ? 0.38 : 1, pointerEvents: disabled ? "none" : "auto" };
}

// ── Parser: KV pair extractor ─────────────────────────────────────────────────
function parseIceDynFile(content) {
  const kv = {};
  const lines = content.split(/\r?\n/);
  let inOutList = false;
  const outLines = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Detect OutList section end
    if (inOutList) {
      if (/^END\b/i.test(line)) { inOutList = false; break; }
      const m = line.match(/^"([^"]+)"/);
      if (m) outLines.push(`"${m[1]}"`);
      continue;
    }

    // Detect start of OutList block — line containing the key "OutList"
    // but not starting with a comment
    if (!line.startsWith("!") && /\bOutList\b/i.test(line) && !/^"/.test(line)) {
      inOutList = true;
      continue;
    }

    // Skip blanks, comments, section dividers
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
      const sp = rest.search(/\s/);
      if (sp < 0) continue;
      value = rest.slice(0, sp);
      rest  = rest.slice(sp).trim();
    }

    const keyMatch = rest.match(/^(\w[\w_]*)/);
    if (!keyMatch) continue;
    const key = keyMatch[1];
    kv[key] = value;
  }

  if (outLines.length) kv["__OutList__"] = outLines.join("\n");
  return kv;
}

// ── State mapper ─────────────────────────────────────────────────────────────
function iceParsedToState(kv) {
  const st = { ...DEFAULT };
  const b = v => typeof v === "string" && v.toLowerCase() === "true";
  const n = v => v !== undefined && !isNaN(Number(v)) ? Number(v) : undefined;

  const boolKeys = ["Echo", "SumPrint", "TabDelim"];
  for (const k of boolKeys) {
    if (kv[k] !== undefined) st[k] = b(kv[k]);
  }

  const intKeys = ["IceModel", "OutFile"];
  for (const k of intKeys) {
    const v = n(kv[k]); if (v !== undefined) st[k] = Math.round(v);
  }

  const floatKeys = [
    "IceDens", "IceThickM", "IceThickS", "IceVelM", "IceVelS",
    "IceFDmult", "Kice", "sigf", "Pf", "delMax", "Phi", "Zr", "TStart",
  ];
  for (const k of floatKeys) {
    const v = n(kv[k]); if (v !== undefined) st[k] = v;
  }

  if (kv["IceSumFile"] !== undefined) st.IceSumFile = kv["IceSumFile"];
  if (kv["OutFmt"]     !== undefined) st.OutFmt     = kv["OutFmt"];
  if (kv["__OutList__"])              st.OutList    = kv["__OutList__"];

  return st;
}

// ── File builder: line-by-line substitution ───────────────────────────────────
function buildIceDynContent(originalContent, p) {
  const SUBS = {
    Echo:       () => p.Echo      ? "True " : "False",
    SumPrint:   () => p.SumPrint  ? "True " : "False",
    TabDelim:   () => p.TabDelim  ? "True " : "False",
    IceModel:   () => String(p.IceModel),
    IceSumFile: () => `"${p.IceSumFile}"`,
    IceDens:    () => String(p.IceDens),
    IceThickM:  () => String(p.IceThickM),
    IceThickS:  () => String(p.IceThickS),
    IceVelM:    () => String(p.IceVelM),
    IceVelS:    () => String(p.IceVelS),
    IceFDmult:  () => String(p.IceFDmult),
    Kice:       () => String(p.Kice),
    sigf:       () => String(p.sigf),
    Pf:         () => String(p.Pf),
    delMax:     () => String(p.delMax),
    Phi:        () => String(p.Phi),
    Zr:         () => String(p.Zr),
    OutFile:    () => String(p.OutFile),
    OutFmt:     () => `"${p.OutFmt}"`,
    TStart:     () => String(p.TStart),
  };

  const lines = originalContent.split(/\r?\n/);
  const result = [];
  let inOutList = false;
  let outListInserted = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    // Handle OutList block
    if (inOutList) {
      if (/^END\b/i.test(trimmed)) {
        // Insert updated channels before END
        if (!outListInserted) {
          const newChannels = (p.OutList || "")
            .split("\n").map(l => l.trim()).filter(l => l)
            .map(l => l.startsWith('"') ? l : `"${l}"`);
          result.push(...newChannels);
          outListInserted = true;
        }
        result.push(rawLine);
        inOutList = false;
      }
      // Skip all original channel entries — replaced above
      continue;
    }

    // Detect OutList section header — key "OutList" on a non-quoted, non-comment line
    if (!trimmed.startsWith("!") && !trimmed.startsWith('"') && /\bOutList\b/i.test(trimmed)) {
      result.push(rawLine);
      inOutList = true;
      outListInserted = false;
      // Insert channels immediately after header line
      const newChannels = (p.OutList || "")
        .split("\n").map(l => l.trim()).filter(l => l)
        .map(l => l.startsWith('"') ? l : `"${l}"`);
      result.push(...newChannels);
      outListInserted = true;
      continue;
    }

    // Pass through blanks, comments, section dividers unchanged
    if (!trimmed || trimmed.startsWith("!") || /^={4,}/.test(trimmed) || /^-{4,}/.test(trimmed)) {
      result.push(rawLine);
      continue;
    }

    // Match: [indent] ("quoted"|word) [ws] KEY [rest...]
    const m = rawLine.match(/^(\s*)("[^"]*"|\S+)(\s+)([\w][\w_]*)([\s!].*)?$/);
    if (m) {
      const key = m[4];
      if (Object.prototype.hasOwnProperty.call(SUBS, key)) {
        const newVal  = SUBS[key]();
        const oldVal  = m[2];
        const padLen  = Math.max(oldVal.length, newVal.length);
        const padded  = newVal.padEnd(padLen);
        result.push(`${m[1]}${padded}${m[3]}${key}${m[5] || ""}`);
        continue;
      }
    }

    // Not a substitution target — pass through unchanged
    result.push(rawLine);
  }

  return result.join("\n");
}

// ── Sub-components ────────────────────────────────────────────────────────────
function SectionHead({ children }) {
  return <h3 className={s.sectionHead}>{children}</h3>;
}

function Field({ label, unit, children, hint, info, iceModel, disabledKey }) {
  const disabled = disabledKey ? isDisabled(disabledKey, iceModel) : false;
  return (
    <div className={s.field} style={disabledStyle(disabled)}>
      <div className={s.fieldHeader}>
        <span className={s.fieldLabel}>{label}</span>
        {unit && <span className={s.unit}>{unit}</span>}
        {info && <InfoPopover content={info} accentColor={ACCENT} />}
      </div>
      {children}
      {hint && <span className={s.hint}>{hint}</span>}
      {disabled && disabledKey && (
        <span className={s.disabledNote}>
          Not used for IceModel {iceModel}
        </span>
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

function SelField({ label, value, onChange, options, hint, info, iceModel, disabledKey }) {
  const disabled = disabledKey ? isDisabled(disabledKey, iceModel) : false;
  return (
    <div className={s.field} style={disabledStyle(disabled)}>
      <div className={s.fieldHeader}>
        <span className={s.fieldLabel}>{label}</span>
        {info && <InfoPopover content={info} accentColor={ACCENT} />}
      </div>
      <select className={s.select} value={value} onChange={e => onChange(Number(e.target.value))}>
        {options.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
      {hint && <span className={s.hint}>{hint}</span>}
      {disabled && disabledKey && (
        <span className={s.disabledNote}>Not used for IceModel {iceModel}</span>
      )}
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

// ── Ice schematic SVG ─────────────────────────────────────────────────────────
function IceSchematic({ iceModel }) {
  const c = ACCENT;
  const isSloped = iceModel === 3;

  return (
    <svg viewBox="0 0 100 120" width="100%" height="180" style={{ display: "block" }}>
      {/* Sky background */}
      <rect x="0" y="0" width="100" height="120" fill={c} fillOpacity="0.04" rx="4" />

      {/* Water body (below waterline at y=60) */}
      <rect x="0" y="60" width="100" height="60" fill={c} fillOpacity="0.08" />

      {/* Waterline */}
      <line x1="0" y1="60" x2="100" y2="60" stroke={c} strokeWidth="1" strokeOpacity="0.40" />

      {/* Ice sheet — horizontal rectangle approaching from left */}
      <rect x="2" y="48" width="46" height="14" rx="2"
        fill={c} fillOpacity="0.22" stroke={c} strokeWidth="0.8" strokeOpacity="0.55" />
      {/* Ice sheet interior hatch lines */}
      <line x1="10" y1="48" x2="10" y2="62" stroke={c} strokeWidth="0.4" strokeOpacity="0.30" />
      <line x1="20" y1="48" x2="20" y2="62" stroke={c} strokeWidth="0.4" strokeOpacity="0.30" />
      <line x1="30" y1="48" x2="30" y2="62" stroke={c} strokeWidth="0.4" strokeOpacity="0.30" />
      <line x1="40" y1="48" x2="40" y2="62" stroke={c} strokeWidth="0.4" strokeOpacity="0.30" />

      {/* Ice force arrow */}
      <line x1="6" y1="55" x2="42" y2="55" stroke={c} strokeWidth="1.4" strokeOpacity="0.80"
        markerEnd="url(#arrowhead)" />
      <defs>
        <marker id="arrowhead" markerWidth="5" markerHeight="5" refX="3" refY="2.5" orient="auto">
          <polygon points="0 0, 5 2.5, 0 5" fill={c} fillOpacity="0.80" />
        </marker>
      </defs>

      {/* Structure — pile (vertical) or sloped cone */}
      {isSloped ? (
        // Sloped cone shape
        <path
          d="M48 22 L58 60 L48 60 Z"
          fill={c} fillOpacity="0.28" stroke={c} strokeWidth="0.8" strokeOpacity="0.60"
        />
      ) : (
        // Vertical pile
        <rect x="46" y="22" width="14" height="80" rx="2"
          fill={c} fillOpacity="0.22" stroke={c} strokeWidth="0.8" strokeOpacity="0.60" />
      )}

      {/* Seabed */}
      <rect x="0" y="108" width="100" height="12" fill={c} fillOpacity="0.18" />
      {/* Seabed hatch */}
      {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90].map(x => (
        <line key={x} x1={x} y1="108" x2={x + 7} y2="115" stroke={c} strokeWidth="0.5" strokeOpacity="0.30" />
      ))}

      {/* Label */}
      <text x="4" y="118" fontSize="6" fill={c} fontFamily="-apple-system,sans-serif" opacity="0.70">
        IceDyn {isSloped ? "(sloped)" : "(pile)"}
      </text>
    </svg>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function IceDynPanel({ onLog, project, filePathFromProject, onDirtyChange, onRegisterSave, simRunning = false }) {
  const [tab,          setTab]          = useState("overview");
  const tabDirRef = useRef(1);
  const [p,            _setP]           = useState(DEFAULT);
  const [filePath,     setFilePath]     = useState("");
  const [isDirtyFlag,  setIsDirtyFlag]  = useState(false);
  const [rawOpen,      setRawOpen]      = useState(false);
  const rawContent  = useRef("");
  const originalRef = useRef(null);

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

  const set = useCallback((key, val) => setP(prev => ({ ...prev, [key]: val })), [setP]);

  // ── Core file loader ──────────────────────────────────────────────────────
  const loadFileFromPath = useCallback(async (path) => {
    try {
      const content = await invoke("read_text_file", { path });
      rawContent.current = content;
      const kv     = parseIceDynFile(content);
      const parsed = iceParsedToState(kv);
      originalRef.current = JSON.stringify(parsed);
      _setP(parsed);
      setIsDirtyFlag(false);
      setFilePath(path);
      onLog?.("ok", `Loaded ${path.split("/").pop()}`);
    } catch (e) {
      onLog?.("error", String(e));
    }
  }, [onLog]);

  // ── Open file (Browse) ────────────────────────────────────────────────────
  const handleOpen = async () => {
    try {
      const f = await openDialog({
        multiple: false,
        filters: [{ name: "IceDyn", extensions: ["dat", "inp", "txt"] }],
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
      const diskContent = await invoke("read_text_file", { path: filePath }).catch(() => rawContent.current);
      const content     = buildIceDynContent(diskContent, p);
      await invoke("write_text_file", { path: filePath, content });
      rawContent.current    = content;
      originalRef.current   = JSON.stringify(p);
      setIsDirtyFlag(false);
      onLog?.("info", `Saved ${filePath.split("/").pop()}`);
    } catch (e) {
      onLog?.("error", String(e));
    }
  }, [filePath, p, onLog, simRunning]);

  // ⌘S / Ctrl+S shortcut
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

  // ── Tab renders ───────────────────────────────────────────────────────────

  const renderOverview = () => (
    <div className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
      {/* Module callout */}
      <div className={s.callout}>
        <strong>IceDyn</strong> is an arctic / sub-arctic module used for structures experiencing
        sea ice loads. It is only active when <code>CompIce=2</code> in the .fst file.
        IceDyn models are highly site-specific — always calibrate ice properties against local
        metocean data and relevant standards (<strong>IEC 61400-3-1</strong> or <strong>ISO 19906</strong>).
      </div>

      {/* Ice model selector */}
      <SectionHead>Ice Loading Model</SectionHead>
      <div className={s.grid1wide}>
        <div className={s.field}>
          <div className={s.fieldHeader}>
            <span className={s.fieldLabel}>IceModel — Loading model type</span>
            <InfoPopover content={INFO.IceModel} accentColor={ACCENT} />
          </div>
          <select
            className={s.selectLg}
            value={p.IceModel}
            onChange={e => set("IceModel", Number(e.target.value))}
          >
            {ICE_MODELS.map(o => (
              <option key={o.v} value={o.v}>{o.label}</option>
            ))}
          </select>
          <div className={s.modelBadge}>
            {p.IceModel === 1 && "Deterministic: intermittent ice crushing loads against a vertical pile. Most common for Baltic monopiles."}
            {p.IceModel === 2 && "Frequency lock-in: ice forcing locks onto structural natural frequency, producing resonance-like behaviour."}
            {p.IceModel === 3 && "Sloped structure: ice bends and breaks against a conical waterline feature. Produces lower loads than crushing — used for ice-breaking cones."}
            {p.IceModel === 4 && "Stochastic random crushing: Monte-Carlo variant of Model 1 for probabilistic design load estimation."}
            {p.IceModel === 5 && "Stress-based stochastic failure: failure determined by ice stress field for more physically detailed probabilistic assessment."}
          </div>
        </div>
      </div>

      {/* General */}
      <SectionHead>General</SectionHead>
      <div className={s.grid2}>
        <div className={s.toggleRow}>
          <button
            className={[s.toggle, p.Echo ? s.on : ""].join(" ")}
            onClick={() => set("Echo", !p.Echo)}
            type="button"
          >
            <span className={s.toggleThumb} />
          </button>
          <span className={s.toggleLabel}>Echo input file (Echo)</span>
        </div>

        <div className={s.field}>
          <div className={s.fieldHeader}>
            <span className={s.fieldLabel}>Summary file (IceSumFile)</span>
          </div>
          <input
            className={s.inp}
            value={p.IceSumFile}
            onChange={e => set("IceSumFile", e.target.value)}
          />
        </div>
      </div>

      {/* Key ice properties summary on overview */}
      <SectionHead>Key Ice Properties</SectionHead>
      <div className={s.grid2}>
        <Field label="Ice density (IceDens)" unit="kg/m³" info={INFO.IceDens}>
          <input className={s.inp} value={p.IceDens}
            onChange={e => set("IceDens", parseFloat(e.target.value) || p.IceDens)} />
        </Field>
        <Field label="Mean ice thickness (IceThickM)" unit="m" info={INFO.IceThickM}>
          <input className={s.inp} value={p.IceThickM}
            onChange={e => set("IceThickM", parseFloat(e.target.value) || p.IceThickM)} />
        </Field>
        <Field label="Mean ice velocity (IceVelM)" unit="m/s" info={INFO.IceVelM}>
          <input className={s.inp} value={p.IceVelM}
            onChange={e => set("IceVelM", parseFloat(e.target.value) || p.IceVelM)} />
        </Field>
        <Field label="Ice failure pressure (Pf)" unit="Pa" info={INFO.Pf}
          iceModel={p.IceModel} disabledKey="Pf">
          <input className={s.inp} value={p.Pf}
            onChange={e => set("Pf", parseFloat(e.target.value) || p.Pf)} />
        </Field>
      </div>
    </div>
  );

  const renderIceProps = () => {
    const model = p.IceModel;
    return (
      <div className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>

        {/* Section: Ice Geometry */}
        <SectionHead>Ice Geometry</SectionHead>
        <div className={s.grid2}>
          <Field label="Mean ice thickness (IceThickM)" unit="m" info={INFO.IceThickM}>
            <input className={s.inp} value={p.IceThickM}
              onChange={e => set("IceThickM", parseFloat(e.target.value) || p.IceThickM)} />
          </Field>

          <Field label="Thickness std dev (IceThickS)" unit="m" info={INFO.IceThickS}
            iceModel={model} disabledKey="IceThickS"
            hint="Stochastic models (2, 4, 5) only">
            <input className={s.inp} value={p.IceThickS}
              onChange={e => set("IceThickS", parseFloat(e.target.value) || 0)} />
          </Field>

          <Field label="Mean ice velocity (IceVelM)" unit="m/s" info={INFO.IceVelM}>
            <input className={s.inp} value={p.IceVelM}
              onChange={e => set("IceVelM", parseFloat(e.target.value) || p.IceVelM)} />
          </Field>

          <Field label="Velocity std dev (IceVelS)" unit="m/s" info={INFO.IceVelS}
            iceModel={model} disabledKey="IceVelS"
            hint="Stochastic models (2, 4, 5) only">
            <input className={s.inp} value={p.IceVelS}
              onChange={e => set("IceVelS", parseFloat(e.target.value) || 0)} />
          </Field>
        </div>

        {/* Section: Failure Parameters */}
        <SectionHead>Failure Parameters</SectionHead>
        <div className={s.grid2}>
          <Field label="Force multiplier (IceFDmult)" info={INFO.IceFDmult}
            iceModel={model} disabledKey="IceFDmult"
            hint="Design margin — IceModel=3 only">
            <input className={s.inp} value={p.IceFDmult}
              onChange={e => set("IceFDmult", parseFloat(e.target.value) || p.IceFDmult)} />
          </Field>

          <Field label="Ice stiffness (Kice)" unit="N/m³" info={INFO.Kice}
            iceModel={model} disabledKey="Kice"
            hint="Models 1, 2, 3 only">
            <input className={s.inp} value={p.Kice}
              onChange={e => set("Kice", parseFloat(e.target.value) || p.Kice)} />
          </Field>

          <Field label="Failure pressure (Pf)" unit="Pa" info={INFO.Pf}
            iceModel={model} disabledKey="Pf"
            hint="Models 1, 2, 4, 5 only">
            <input className={s.inp} value={p.Pf}
              onChange={e => set("Pf", parseFloat(e.target.value) || p.Pf)} />
          </Field>

          <Field label="Flexural strength (sigf)" unit="Pa" info={INFO.sigf}
            iceModel={model} disabledKey="sigf"
            hint="IceModel=3 (sloped structure) only">
            <input className={s.inp} value={p.sigf}
              onChange={e => set("sigf", parseFloat(e.target.value) || p.sigf)} />
          </Field>

          <Field label="Max ice deflection (delMax)" unit="m" info={INFO.delMax}
            iceModel={model} disabledKey="delMax"
            hint="IceModel=3 only">
            <input className={s.inp} value={p.delMax}
              onChange={e => set("delMax", parseFloat(e.target.value) || p.delMax)} />
          </Field>
        </div>

        {/* Section: Sloped Structure — visually dimmed when not Model 3 */}
        <div style={disabledStyle(model !== 3)}>
          <SectionHead>Sloped Structure (IceModel=3 only)</SectionHead>
          {model !== 3 && (
            <div className={s.calloutInfo} style={{ marginBottom: 12 }}>
              These parameters are only active when IceModel=3. Switch the model in the
              Overview tab to enable this section.
            </div>
          )}
          <div className={s.grid2}>
            <Field label="Slope angle from horizontal (Phi)" unit="deg" info={INFO.Phi}>
              <input className={s.inp} value={p.Phi}
                onChange={e => set("Phi", parseFloat(e.target.value) || p.Phi)} />
            </Field>

            <Field label="Rubble height above waterline (Zr)" unit="m" info={INFO.Zr}>
              <input className={s.inp} value={p.Zr}
                onChange={e => set("Zr", parseFloat(e.target.value) || 0)} />
            </Field>
          </div>
        </div>

        {/* Ice density in properties tab too */}
        <SectionHead>Ice Material</SectionHead>
        <div className={s.grid2}>
          <Field label="Ice density (IceDens)" unit="kg/m³" info={INFO.IceDens}>
            <input className={s.inp} value={p.IceDens}
              onChange={e => set("IceDens", parseFloat(e.target.value) || p.IceDens)} />
          </Field>
        </div>
      </div>
    );
  };

  const renderOutput = () => (
    <div className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
      <SectionHead>Output Options</SectionHead>
      <div className={s.grid2}>
        <SelField
          label="Output destination (OutFile)"
          value={p.OutFile}
          onChange={v => set("OutFile", v)}
          options={[
            { v: 1, label: "1 – IceDyn.out" },
            { v: 2, label: "2 – Glue code file" },
            { v: 3, label: "3 – Both files" },
          ]}
          hint="Where to write time-series output"
        />
        <Field label="Output format (OutFmt)" hint='e.g. "ES11.4e2"'>
          <input className={s.inp} value={p.OutFmt}
            onChange={e => set("OutFmt", e.target.value)} />
        </Field>
        <Field label="Output start time (TStart)" unit="s" hint="Channels written after this time">
          <input className={s.inp} value={p.TStart}
            onChange={e => set("TStart", parseFloat(e.target.value) || 0)} />
        </Field>
      </div>

      <div className={s.toggleGrid}>
        <Toggle label="Write summary file (SumPrint)" value={p.SumPrint}
          onChange={v => set("SumPrint", v)} />
        <Toggle label="Tab-delimited output (TabDelim)" value={p.TabDelim}
          onChange={v => set("TabDelim", v)} />
      </div>

      <Field
        label="Output channel names (OutList)"
        hint='One quoted channel name per line, e.g. "IceF_Fx"'>
        <textarea
          className={s.outListArea}
          value={p.OutList}
          onChange={e => set("OutList", e.target.value)}
        />
      </Field>

      <Collapsible title="Common IceDyn output channels">
        <div className={s.channelGrid}>
          {[
            ["IceF_Fx",   "Ice force in surge (X)"],
            ["IceF_Fy",   "Ice force in sway (Y)"],
            ["IceF_Fz",   "Ice force in heave (Z)"],
            ["IceF_Mx",   "Ice moment about X"],
            ["IceF_My",   "Ice moment about Y"],
            ["IceF_Mz",   "Ice moment about Z"],
          ].map(([ch, desc]) => (
            <div key={ch} className={s.channelRow}>
              <code className={s.channelCode}>{`"${ch}"`}</code>
              <span className={s.channelDesc}>{desc}</span>
              <button
                className={s.channelAdd}
                type="button"
                onClick={() => {
                  const quoted = `"${ch}"`;
                  const lines = p.OutList.split("\n").map(l => l.trim()).filter(l => l);
                  if (!lines.includes(quoted)) {
                    set("OutList", [...lines, quoted].join("\n"));
                  }
                }}
              >
                + Add
              </button>
            </div>
          ))}
        </div>
      </Collapsible>
    </div>
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={s.panel}>
      {/* Header */}
      <div className={s.header}>
        <Snowflake size={16} strokeWidth={1.8} style={{ color: ACCENT }} />
        <h1 className={s.title}>IceDyn</h1>
        <span className={s.desc}>Sea ice loading</span>
        <span className={s.badge}>sub-module</span>
        <div style={{ flex: 1 }} />
        <button className={`${s.headerBtn} ${s.headerBtnPrimary}`} onClick={handleOpen} type="button">
          <FolderOpen size={12} strokeWidth={2} /> Open .dat
        </button>
        <button
          className={`${s.headerBtn} ${s.headerBtnSecondary}`}
          type="button"
          onClick={async () => {
            if (!filePath) {
              onLog?.("warn", "Load an IceDyn file first — then View will show the actual file on disk.");
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
          {filePath || "No file loaded — open an IceDyn .dat file"}
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

      {/* Sim-running banner */}
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

      {/* No-file banner */}
      {!filePath && (
        <div style={{
          display: "flex", alignItems: "flex-start", gap: 8,
          padding: "8px 20px",
          background: "rgba(75,156,211,0.06)",
          borderBottom: "0.5px solid rgba(75,156,211,0.18)",
          flexShrink: 0,
        }}>
          <Snowflake size={13} strokeWidth={1.8} style={{ color: ACCENT, marginTop: 1, flexShrink: 0 }} />
          <span style={{ fontSize: 12, color: "rgba(75,156,211,0.90)", lineHeight: 1.55 }}>
            No IceDyn file loaded. Open a .dat file above, or point the .fst file to one.
            Since IceDyn is rarely used, no bundled template is provided — you can configure
            defaults here and save to a new file location.
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
          {tab === "overview"  && renderOverview()}
          {tab === "iceprops" && renderIceProps()}
          {tab === "output"    && renderOutput()}
        </div>

        {/* Stats panel */}
        <div className={s.statsPanel}>
          <p className={s.statsLabel}>Quick stats</p>
          <div className={s.turbineWrap}>
            <IceSchematic iceModel={p.IceModel} />
          </div>
          <div className={s.statsGrid}>
            {[
              ["Model",     iceModelShortName(p.IceModel)],
              ["Thickness", `${p.IceThickM} m`],
              ["Velocity",  `${p.IceVelM} m/s`],
              ["Pf",        `${(p.Pf / 1000).toFixed(0)} kPa`],
              ["IceDens",   `${p.IceDens} kg/m³`],
              ["OutFile",   p.OutFile === 1 ? ".out" : p.OutFile === 2 ? "glue" : "both"],
            ].map(([k, v]) => (
              <div key={k} className={s.statCard}>
                <span className={s.statKey}>{k}</span>
                <span className={s.statVal}>{v}</span>
              </div>
            ))}
          </div>

          {/* Model-specific guidance note */}
          <div className={s.guidanceCard}>
            <div className={s.guidanceTitle}>Active model</div>
            <div className={s.guidanceName}>{iceModelShortName(p.IceModel)}</div>
            {p.IceModel === 3 && (
              <div className={s.guidanceNote}>
                Sloped structure — Phi ({p.Phi}°), Zr ({p.Zr} m) and sigf
                ({(p.sigf / 1e6).toFixed(2)} MPa) are all active.
              </div>
            )}
            {(p.IceModel === 4 || p.IceModel === 5) && (
              <div className={s.guidanceNote}>
                Stochastic model — IceThickS ({p.IceThickS} m) and IceVelS ({p.IceVelS} m/s) enabled.
              </div>
            )}
            {(p.IceModel === 1 || p.IceModel === 2) && (
              <div className={s.guidanceNote}>
                Deterministic — thickness and velocity std devs not used.
              </div>
            )}
          </div>
        </div>
      </div>

      {rawOpen && (
        <RawFileModal
          content={rawContent.current}
          filename={filePath ? filePath.split("/").pop() : "IceDyn.dat"}
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
