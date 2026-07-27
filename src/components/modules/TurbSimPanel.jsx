import { useState, useMemo, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Wind, Square, ChevronDown, ChevronRight, Eye, Plus, Info, Play } from "lucide-react";
import RawFileModal from "../RawFileModal";
import InfoPopover from "../InfoPopover";
// BinaryRow removed — binary config now lives in Settings (⚙)
import { useBinarySettings } from "../../hooks/useBinarySettings";
import { IsolineHero, IsolineMini, _isoColor, _lerp } from "../IsolineAnimation";
import s from "./TurbSimPanel.module.css";

const TABS = [
  { id: "dashboard", label: "Dashboard"      },
  { id: "wind",      label: "Wind field"     },
  { id: "spectral",  label: "Spectral model" },
  { id: "grid",      label: "Grid & time"    },
  { id: "runtime",   label: "Advanced"       },
];

const TURB_MODELS    = ["IECKAI","IECVKM","GP_LLJ","NWTCUP","SMOOTH","WF_UPW","WF_07D","WF_14D","TIDAL","API","NONE"];
const TURB_CLASSES   = ["A — High intensity","B — Medium intensity","C — Low intensity","Custom TI %"];
const IEC_STANDARDS  = ["1 — Ed.3 (2019)","2","3","1-Ed2","1-Ed3"];
const IEC_WIND_TYPES = ["NTM — Normal","1ETM","2ETM","3ETM","1EWM1","1EWM50"];
const WIND_PROFILES  = ["PL — Power law","LOG — Logarithmic","JET — Low-level jet","H2L — Log (tidal)","API","IEC"];

const INFO = {
  URef:        { param:"URef", desc:"Mean wind speed at the reference height. For IEC NTM this is the 10-minute average hub-height wind speed.", range:"1 – 35 m/s", default:"12 m/s", unit:"m/s", note:"For JET profile use 'default'. For API model must be 1-hour mean." },
  RefHt:       { param:"RefHt", desc:"Height at which URef is defined. Should equal HubHt for standard IEC load cases.", range:"> 0 m", default:"= HubHt", unit:"m" },
  PLExp:       { param:"PLExp", desc:"Exponent in the power law profile U(z) = URef × (z/RefHt)^PLExp.", range:"0.0 – 0.5", default:'"default" ≈ 0.2', unit:"−", note:"Use 0.10–0.14 offshore, 0.20 neutral onshore, 0.30 stable atmosphere." },
  Z0:          { param:"Z0", desc:"Surface roughness length for the logarithmic wind profile.", range:"0.0001 – 1.0 m", default:'"default"', unit:"m", note:"Open sea ≈ 0.0002 m, flat land ≈ 0.03 m, suburban ≈ 0.1–0.3 m." },
  WindProfile: { param:"WindProfileType", desc:"Vertical wind speed profile model across the grid.", range:"PL, LOG, JET, H2L, API, IEC, USR", default:"PL", note:"USR set automatically when gTI ≠ 1.0." },
  gTI:         { param:"gTI", desc:"Rotor TI asymmetry: ratio of σu at rotor bottom to top. 1.0 = uniform turbulence intensity across the rotor disk.", range:"1.0 – 2.0", default:"1.0", unit:"−", note:"When gTI ≠ 1.0 switches to TurbModel=USRVKM and WindProfileType=USR, writes a 3-column profile (z, U, σu) with a linear σu gradient anchored to the IEC class at hub height." },
  RICH_NO:     { param:"RICH_NO", desc:"Gradient Richardson number. Positive = stable, negative = unstable, 0 = neutral.", range:"−1 to +1", default:"0.05", unit:"−", note:"Used by GP_LLJ, NWTCUP, WF_* models. Ignored by IECKAI/IECVKM." },
  Latitude:    { param:"Latitude", desc:"Site latitude. Used by some spectral models for Coriolis effects.", range:"−90 to +90", default:'"default"', unit:"degrees" },
  UStar:       { param:"UStar", desc:"Friction velocity. Influences spectral scaling in site-specific models.", range:"> 0 m/s", default:'"default"', unit:"m/s" },
  ZI:          { param:"ZI", desc:"Convective mixing layer depth. Relevant for unstable conditions and GP_LLJ model.", range:"100 – 5000 m", default:'"default"', unit:"m" },
  PC_UW:       { param:"PC_UW", desc:"u'w' Reynolds stress. Vertical flux of streamwise momentum. Negative in neutral ABL.", range:"typically −2 to 0 m²/s²", default:'"default"', unit:"m²/s²" },
  PC_UV:       { param:"PC_UV", desc:"u'v' Reynolds stress. Horizontal momentum flux.", range:"typically small", default:'"default"', unit:"m²/s²" },
  PC_VW:       { param:"PC_VW", desc:"v'w' Reynolds stress. Vertical flux of lateral momentum.", range:"typically small", default:'"default"', unit:"m²/s²" },
  HFlowAng:    { param:"HFlowAng", desc:"Horizontal mean flow skew angle relative to rotor normal.", range:"−45 to +45", default:"0", unit:"degrees" },
  ZJetMax:     { param:"ZJetMax", desc:"Low-level jet maximum height. Only used when WindProfileType = JET.", range:"70 – 490 m", default:'"default"', unit:"m" },
  ETMc:        { param:"ETMc", desc:"IEC ETM 'c' parameter. Only used when IEC_WindType = xETM.", range:"> 0 m/s", default:'"default" = 2.0 m/s', unit:"m/s" },
  NumGrid_Z:   { param:"NumGrid_Z", desc:"Number of vertical grid points (nodes).", range:"3 – 99 (odd recommended)", default:"31", unit:"nodes" },
  NumGrid_Y:   { param:"NumGrid_Y", desc:"Number of horizontal (lateral) grid points (nodes).", range:"3 – 99 (odd recommended)", default:"31", unit:"nodes" },
  GridHeight:  { param:"GridHeight", desc:"Total vertical extent of the turbulence grid in metres.", range:"> 0 m", default:"150 m", unit:"m", note:"Should be ≥ rotor diameter." },
  GridWidth:   { param:"GridWidth", desc:"Total lateral extent of the turbulence grid in metres.", range:"> 0 m", default:"150 m", unit:"m" },
  HubHt:       { param:"HubHt", desc:"Hub height above ground in metres.", range:"> 0.5×GridHeight", default:"90 m", unit:"m" },
  VFlowAng:    { param:"VFlowAng", desc:"Vertical mean flow uptilt angle. Simulates upslope inflow.", range:"−45 to +45", default:"0", unit:"degrees" },
  TimeStep:    { param:"TimeStep", desc:"Temporal resolution of the generated wind field.", range:"0.001 – 1.0 s", default:"0.05 s (20 Hz)", unit:"s" },
  AnalysisTime:{ param:"AnalysisTime", desc:"Total duration. May be extended: MAX(AnalysisTime, UsableTime + GridWidth/MeanHHWS).", range:"> UsableTime", default:"630 s", unit:"s" },
  UsableTime:  { param:"UsableTime", desc:"Usable output duration extracted from the analysis series.", range:"> 0 s", default:"600 s", unit:"s" },
  RandSeed1:   { param:"RandSeed1", desc:"First random seed. Change to generate different realisations.", range:"−2147483648 to 2147483647", default:"123456", note:"Use different seeds for ensemble realisations at identical conditions." },
  RandSeed2:   { param:"RandSeed2", desc:"Second random seed or alternative PRNG.", range:'"RanLux", "RNSNLW", or integer', default:'"RanLux"' },
  TurbModel:   { param:"TurbModel", desc:"Spectral model determining power spectral density shape.", range:"IECKAI, IECVKM, USRVKM, GP_LLJ, NWTCUP, SMOOTH, WF_*, API, NONE", default:"IECKAI", note:"Overridden to USRVKM automatically when gTI ≠ 1.0." },
  IECturbc:    { param:"IECturbc", desc:"IEC turbulence class. Sets TI level for the Normal Turbulence Model.", range:"A (high), B (medium), C (low), or a custom TI% as a number (e.g. 12 for 12%)", default:"A", note:"A: Iref=0.16, B: 0.14, C: 0.12. Custom TI% overrides the class-based value." },
  IECstandard: { param:"IECstandard", desc:"IEC 61400 standard edition.", range:"1, 2, 3, 1-Ed2, 1-Ed3", default:"1 (Ed.3 2019)" },
  IEC_WindType:{ param:"IEC_WindType", desc:"IEC design wind condition. NTM for fatigue; ETM/EWM for ultimate.", range:"NTM, xETM, xEWM1, xEWM50", default:"NTM" },
  ScaleIEC:    { param:"ScaleIEC", desc:"Scale turbulence to match exact IEC target standard deviation.", range:"0, 1, or 2", default:"0", note:"0 = none, 1 = hub uniform, 2 = each component independently." },
  WrBLFF:      { param:"WrBLFF", desc:"Write .wnd binary file (BLADED/AeroDyn format).", default:"False" },
  WrHAWCFF:    { param:"WrHAWCFF", desc:"Write HAWC2 binary files (-u.bin, -v.bin, -w.bin, .hawc).", default:"False" },
  WrFMTFF:     { param:"WrFMTFF", desc:"Write ASCII formatted files (.u, .v, .w). Large but human-readable.", default:"False" },
  WrADTWR:     { param:"WrADTWR", desc:"Write tower wind file (.twr) for ElastoDyn tower loads.", default:"False" },
  WrBHHTP:     { param:"WrBHHTP", desc:"Write hub-height turbulence parameters in binary form (.bin).", default:"False" },
  WrFHHTP:     { param:"WrFHHTP", desc:"Write hub-height turbulence parameters in formatted form (.dat).", default:"False" },
  WrADHH:      { param:"WrADHH", desc:"Write hub-height time-series in AeroDyn format (.hh). Legacy; prefer WrADFF.", default:"False" },
  WrACT:       { param:"WrACT", desc:"Write coherent turbulence time-steps (.cts).", default:"False" },
  Echo:        { param:"Echo", desc:"Echo all inputs to a .ech file for debugging.", default:"False" },
  CTEventPath: { param:"CTEventPath", desc:"Path to coherent turbulence event data files.", default:'".\\EventData"' },
  CTEventFile: { param:"CTEventFile", desc:"Type of coherent turbulence event files.", range:'"LES", "DNS", "RANDOM"', default:'"les"' },
  Randomize:   { param:"Randomize", desc:"Randomise scale and location of coherent structures. When true, DistScl/CTLy/CTLz are ignored.", default:"true" },
  DistScl:     { param:"DistScl", desc:"Disturbance scale (event height / rotor diameter). Only when Randomize = false.", range:"0.1 – 2.0", default:"1.0" },
  CTLy:        { param:"CTLy", desc:"Fractional lateral tower location in event dataset. Only when Randomize = false.", range:"0.0 – 1.0", default:"0.5" },
  CTLz:        { param:"CTLz", desc:"Fractional hub height location in event dataset. Only when Randomize = false.", range:"0.0 – 1.0", default:"0.5" },
  CTStartTime: { param:"CTStartTime", desc:"Minimum time before first coherent event is injected.", range:"> 0 s", default:"10 s", unit:"s" },
};

// ── InfoPopover bridge — maps infoKey → shared InfoPopover ────────────────────
// TurbSimPanel passes infoKey (string) while the shared component takes content (object)
function TurbInfoPopover({ infoKey }) {
  const content = INFO[infoKey];
  if (!content) return null;
  return <InfoPopover content={content} accentColor="#185FA5" />;
}

// ── SliderField — slider + exact editable input ───────────────────────────────
function SliderField({ label, unit, infoKey, min, max, step, value, onChange, wide }) {
  const [inputVal, setInputVal] = useState(String(value));

  useEffect(() => { setInputVal(String(value)); }, [value]);

  const handleSlider = (e) => {
    const v = Number(e.target.value);
    setInputVal(String(v));
    onChange(v);
  };

  const commit = () => {
    const v = parseFloat(inputVal);
    if (!isNaN(v)) {
      const clamped = Math.min(max, Math.max(min, v));
      setInputVal(String(clamped));
      onChange(clamped);
    } else {
      setInputVal(String(value));
    }
  };

  return (
    <div className={`${s.field} ${wide ? s.sliderWide : ""}`}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
        <div style={{ display:"flex", alignItems:"center", gap:5, flex:1, minWidth:0 }}>
          <label style={{ fontSize:13, fontWeight:500, color:"var(--tx-2)",
            lineHeight:1.3, whiteSpace:"nowrap" }}>
            {label}{unit && <span style={{ fontSize:12, color:"var(--tx-4)", marginLeft:2 }}>{unit}</span>}
          </label>
          {infoKey && <TurbInfoPopover infoKey={infoKey} />}
        </div>
        <input
          type="text"
          value={inputVal}
          onChange={e => setInputVal(e.target.value)}
          onBlur={commit}
          onKeyDown={e => e.key === "Enter" && e.target.blur()}
          style={{
            width:58, textAlign:"right", fontSize:13, fontWeight:600, color:"var(--tx-1)",
            background:"var(--bg-hover)", border:"0.5px solid var(--bd)",
            borderRadius:5, padding:"1px 6px", fontFamily:"inherit", outline:"none",
          }}
        />
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={handleSlider}
        style={{ width: "100%" }} />
    </div>
  );
}

// ── Field ─────────────────────────────────────────────────────────────────────
function Field({ label, unit, infoKey, children }) {
  return (
    <div className={s.field}>
      <div className={s.fieldHeader}>
        <label className={s.fieldLabel}>
          {label}{unit && <span className={s.unit}> {unit}</span>}
        </label>
        {infoKey && <TurbInfoPopover infoKey={infoKey} />}
      </div>
      {children}
    </div>
  );
}

// ── Toggle ────────────────────────────────────────────────────────────────────
function Toggle({ label, infoKey, value, onChange, locked }) {
  return (
    <div className={s.toggleRow}>
      <button className={`${s.toggle} ${value?s.toggleOn:""} ${locked?s.toggleLocked:""}`}
        onClick={() => !locked && onChange(!value)} disabled={locked}>
        <span className={s.toggleThumb} />
      </button>
      <span className={s.toggleLabel}>{label}</span>
      {infoKey && <TurbInfoPopover infoKey={infoKey} />}
      {locked && <span className={s.toggleLockedBadge}>always on</span>}
    </div>
  );
}

function SectionHead({ children }) { return <p className={s.sectionHead}>{children}</p>; }

function Collapsible({ title, children, defaultOpen=false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={s.collapsible}>
      <button className={s.collapsibleHead} onClick={() => setOpen(o=>!o)}>
        {open ? <ChevronDown size={13} strokeWidth={2}/> : <ChevronRight size={13} strokeWidth={2}/>}
        {title}
      </button>
      {open && <div className={s.collapsibleBody}>{children}</div>}
    </div>
  );
}

function Callout({ type="info", children }) {
  const color  = type==="warn" ? "#7A4B00" : "#185FA5";
  const bg     = type==="warn" ? "rgba(186,117,23,0.07)" : "rgba(24,95,165,0.06)";
  const border = type==="warn" ? "rgba(186,117,23,0.18)" : "rgba(24,95,165,0.15)";
  return (
    <div style={{ display:"flex", gap:9, alignItems:"flex-start", background:bg,
      border:`0.5px solid ${border}`, borderRadius:8, padding:"10px 13px", marginBottom:14 }}>
      <Info size={13} strokeWidth={1.8} style={{ color, flexShrink:0, marginTop:1 }} />
      <p style={{ fontSize:12, color, lineHeight:1.55, margin:0 }}>{children}</p>
    </div>
  );
}

// ── Colour helper (kept for WindGridMini below) ───────────────────────────────
const _cellColor = (v) => {
  const c = Math.max(0, Math.min(1, v));
  if (c <= 0.5) {
    const t = c * 2;
    return `rgb(${_lerp(24,29,t)},${_lerp(95,158,t)},${_lerp(165,117,t)})`;
  }
  const t = (c - 0.5) * 2;
  return `rgb(${_lerp(29,245,t)},${_lerp(158,158,t)},${_lerp(117,11,t)})`;
};

// ── Animated mini wind-grid for sidebar (kept for reference) ──────────────────
function WindGridMini({ running }) {
  const COLS = 9, ROWS = 6, N = COLS * ROWS;
  const W = 100, H = 70, CW = W / COLS, CH = H / ROWS;
  const rectsRef = useRef([]);
  const phaseRef = useRef(Array.from({ length: N }, (_, i) =>
    (Math.abs(Math.sin(i * 89.3) * 31728.1) % 1) * Math.PI * 2));
  const speedRef = useRef(Array.from({ length: N }, (_, i) =>
    0.2 + (Math.abs(Math.sin(i * 241.5) * 51234.7) % 1) * 0.5));
  const tRef   = useRef(0);
  const runRef = useRef(running);

  useEffect(() => { runRef.current = running; }, [running]);

  useEffect(() => {
    let raf;
    const animate = () => {
      tRef.current += runRef.current ? 0.025 : 0.006;
      const t = tRef.current;
      rectsRef.current.forEach((rect, i) => {
        if (!rect) return;
        const v = 0.5 + 0.18 * Math.sin(t * speedRef.current[i] + phaseRef.current[i]);
        rect.setAttribute("fill", _cellColor(v));
      });
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%"
      preserveAspectRatio="xMidYMid slice" style={{ display:"block" }}>
      {Array.from({ length: N }, (_, i) => {
        const col = i % COLS, row = Math.floor(i / COLS);
        const initV = 0.5 + 0.1 * Math.sin(phaseRef.current[i]);
        return (
          <rect key={i}
            ref={el => { rectsRef.current[i] = el; }}
            x={col * CW + 0.5} y={row * CH + 0.5}
            width={CW - 1} height={CH - 1}
            fill={_cellColor(initV)} opacity={0.85} />
        );
      })}
      <circle cx={W / 2} cy={H / 2} r={H * 0.37}
        fill="none" stroke="rgba(255,255,255,0.22)"
        strokeWidth={1} strokeDasharray="4 3" />
      <circle cx={W / 2} cy={H / 2} r={3} fill="rgba(255,255,255,0.45)" />
    </svg>
  );
}

// ── Rotor TI asymmetry diagram (for dashboard TI card) ────────────────────────
function RotorTIDiagram({ tiAsymmetry }) {
  const active  = tiAsymmetry > 1.0;
  const botFrac = active ? Math.min((tiAsymmetry - 1) / 1.0, 1) : 0;
  const cx = 55, cy = 44, r = 34;
  return (
    <svg viewBox="0 0 120 90" width="110" height="82" style={{ display:"block" }}>
      <defs>
        <clipPath id="rClipTS">
          <circle cx={cx} cy={cy} r={r} />
        </clipPath>
      </defs>
      {/* Top half — baseline TI */}
      <rect x={cx - r} y={cy - r} width={r * 2} height={r}
        fill="rgba(24,95,165,0.14)" clipPath="url(#rClipTS)" />
      {/* Bottom half — amplified TI when active */}
      <rect x={cx - r} y={cy} width={r * 2} height={r}
        fill={active ? `rgba(245,158,11,${0.12 + botFrac * 0.22})` : "rgba(24,95,165,0.10)"}
        clipPath="url(#rClipTS)" />
      {/* Divider */}
      <line x1={cx - r} y1={cy} x2={cx + r} y2={cy}
        stroke={active ? "rgba(24,95,165,0.40)" : "var(--bd-subtle)"}
        strokeWidth={0.8} strokeDasharray="3 2" />
      {/* Rotor circle */}
      <circle cx={cx} cy={cy} r={r}
        fill="none"
        stroke={active ? "#185FA5" : "var(--bd)"}
        strokeWidth={active ? 1.5 : 1} />
      {/* Hub */}
      <circle cx={cx} cy={cy} r={3.5} fill={active ? "#185FA5" : "var(--tx-5)"} />
      {/* Side labels */}
      <text x={cx + r + 4} y={cy - 7} fontSize="7.5"
        fill="var(--tx-3)" fontFamily="-apple-system,sans-serif">TI</text>
      <text x={cx + r + 4} y={cy + 17} fontSize="7.5"
        fill={active ? "#F59E0B" : "var(--tx-3)"}
        fontFamily="-apple-system,sans-serif">
        {active ? `${tiAsymmetry.toFixed(2)}×` : "TI"}
      </text>
    </svg>
  );
}

// ── Editable param cell (bold sim-params style, mirrors OpenFAST) ─────────────
function TSEditableParam({ label, unit, value, onChange, step, min, max }) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState("");
  const handleStart  = () => { setDraft(String(value)); setEditing(true); };
  const handleCommit = () => {
    setEditing(false);
    const n = parseFloat(draft);
    if (!isNaN(n)) {
      const clamped = (min !== undefined && max !== undefined)
        ? Math.min(max, Math.max(min, n)) : n;
      onChange(clamped);
    }
  };
  return (
    <div className={s.paramCell} onClick={!editing ? handleStart : undefined}>
      <span className={s.paramLabel}>
        {label}{unit && <span className={s.paramUnit}> {unit}</span>}
      </span>
      {editing ? (
        <input autoFocus className={s.paramInput} type="number"
          value={draft} step={step} min={min} max={max}
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

// ── Build .inp preview client-side (mirrors fus_io.py exactly) ──────────────
function buildInpContent(p, effectivePrefix) {
  const TMODELS = ["IECKAI","IECVKM","GP_LLJ","NWTCUP","SMOOTH","WF_UPW","WF_07D","WF_14D","TIDAL","API","NONE"];
  const ISTDS   = ["1","2","3","1-Ed2","1-Ed3"];
  const ICLS    = ["A","B","C"];
  const IWT     = ["NTM","1ETM","2ETM","3ETM","1EWM1","1EWM50"];
  const WPROF   = ["PL","LOG","JET","H2L","API","IEC"];

  const useGTI    = p.gTI !== 1.0;
  // USRVKM reads U(z) + sigma_u(z) from ProfileFile; WindProfileType=USR tells TurbSim
  // to use ProfileFile for the mean wind profile as well.
  const turbModel = useGTI ? "USRVKM" : TMODELS[p.TurbModel];
  const windProf  = useGTI ? "USR"    : WPROF[p.WindProfileType];
  const iecCls    = p.IECturbc_custom || ICLS[p.IECturbc] || "A";
  const iecStd    = ISTDS[p.IECstandard];
  const iecWT     = IWT[p.IEC_WindType];

  const b  = (v) => v ? "True" : "False";
  const d  = (v) => (typeof v === "string" && v.toLowerCase() === "default") ? '"default"' : String(v);
  const pad = (v, n=13) => String(v).padEnd(n);

  const lines = [
    `---------TurbSim v2 (OpenFAST) Input File------------------`,
    `FlowUrja Studio — ${effectivePrefix}  [${turbModel} | ${iecCls} | ${p.URef} m/s | ${p.HubHt} m hub | gTI=${p.gTI}]`,
    `---------Runtime Options-----------------------------------`,
    `${pad(b(p.Echo))} Echo            - Echo input data to <RootName>.ech (flag)`,
    `${pad(p.RandSeed1)} RandSeed1       - First random seed  (-2147483648 to 2147483647)`,
    `${pad('"'+p.RandSeed2+'"')} RandSeed2       - Second random seed or pRNG: "RanLux" or "RNSNLW"`,
    `${pad(b(p.WrBHHTP))} WrBHHTP         - Output hub-height turbulence parameters in binary form?`,
    `${pad(b(p.WrFHHTP))} WrFHHTP         - Output hub-height turbulence parameters in formatted form?`,
    `${pad(b(p.WrADHH))} WrADHH          - Output hub-height time-series data in AeroDyn form?`,
    `${pad(b(p.WrADFF))} WrADFF          - Output full-field time-series data in TurbSim/AeroDyn form? (Generates RootName.bts)`,
    `${pad(b(p.WrBLFF))} WrBLFF          - Output full-field time-series data in BLADED/AeroDyn form?  (Generates RootName.wnd)`,
    `${pad(b(p.WrADTWR))} WrADTWR         - Output tower time-series data? (Generates RootName.twr)`,
    `${pad(b(p.WrHAWCFF))} WrHAWCFF        - Output full-field time-series data in HAWC form?`,
    `${pad(b(p.WrFMTFF))} WrFMTFF         - Output full-field time-series data in formatted (readable) form?`,
    `${pad(b(p.WrACT))} WrACT           - Output coherent turbulence time steps in AeroDyn form?`,
    `          ${p.ScaleIEC}   ScaleIEC        - Scale IEC turbulence models to exact target standard deviation?`,
    ``,
    `--------Turbine/Model Specifications-----------------------`,
    `         ${p.NumGrid_Z}   NumGrid_Z       - Vertical grid-point matrix dimension`,
    `         ${p.NumGrid_Y}   NumGrid_Y       - Horizontal grid-point matrix dimension`,
    `       ${p.TimeStep}   TimeStep        - Time step [seconds]`,
    `        ${p.AnalysisTime}   AnalysisTime    - Length of analysis time series [seconds]`,
    `        ${p.UsableTime}   UsableTime      - Usable length of output time series [seconds]`,
    `        ${p.HubHt}   HubHt           - Hub height [m] (should be > 0.5*GridHeight)`,
    `        ${p.GridHeight}   GridHeight      - Grid height [m]`,
    `        ${p.GridWidth}   GridWidth       - Grid width [m]`,
    `          ${p.VFlowAng}   VFlowAng        - Vertical mean flow (uptilt) angle [degrees]`,
    `          ${p.HFlowAng}   HFlowAng        - Horizontal mean flow (skew) angle [degrees]`,
    ``,
    `--------Meteorological Boundary Conditions-------------------`,
    `"${turbModel}"      TurbModel       - Turbulence model`,
    `"TurbSim_User.spectra", "TurbSim_User.timeSeriesInput"    UserFile`,
    `          ${iecStd}   IECstandard     - Number of IEC 61400-x standard`,
    `"${iecCls}"           IECturbc        - IEC turbulence characteristic`,
    `"${iecWT}"         IEC_WindType    - IEC turbulence type`,
    `${pad(d(p.ETMc))} ETMc            - IEC Extreme Turbulence Model "c" parameter [m/s]`,
    `"${windProf}"          WindProfileType - Velocity profile type`,
    `"TurbSim_User.profiles"      ProfileFile     - User-defined profile file`,
    `        ${p.RefHt}   RefHt           - Height of the reference velocity (URef) [m]`,
    `         ${p.URef}   URef            - Mean (total) velocity at the reference height [m/s]`,
    `${pad(d(p.ZJetMax))} ZJetMax         - Jet height [m] (used only for JET velocity profile)`,
    `${pad(d(p.PLExp))} PLExp           - Power law exponent [-] (or "default")`,
    `${pad(d(p.Z0))}              Z0              - Surface roughness length [m] (or "default")`,
    ``,
    `--------Non-IEC Meteorological Boundary Conditions------------`,
    `${pad(d(p.Latitude))} Latitude        - Site latitude [degrees] (or "default")`,
    `       ${p.RICH_NO}   RICH_NO         - Gradient Richardson number [-]`,
    `${pad(d(p.UStar))} UStar           - Friction or shear velocity [m/s] (or "default")`,
    `${pad(d(p.ZI))} ZI              - Mixing layer depth [m] (or "default")`,
    `${pad(d(p.PC_UW))} PC_UW           - Hub mean u'w' Reynolds stress [m^2/s^2]`,
    `${pad(d(p.PC_UV))} PC_UV           - Hub mean u'v' Reynolds stress [m^2/s^2]`,
    `${pad(d(p.PC_VW))} PC_VW           - Hub mean v'w' Reynolds stress [m^2/s^2]`,
    ``,
    `--------Spatial Coherence Parameters----------------------------`,
    `"default"     SCMod1           - u-component coherence model`,
    `"default"     SCMod2           - v-component coherence model`,
    `"default"     SCMod3           - w-component coherence model`,
    `"default"     InCDec1          - u-component coherence parameters`,
    `"default"     InCDec2          - v-component coherence parameters`,
    `"default"     InCDec3          - w-component coherence parameters`,
    `"default"     CohExp           - Coherence exponent for general model [-]`,
    ``,
    `--------Coherent Turbulence Scaling Parameters-------------------`,
    `"${p.CTEventPath}"    CTEventPath     - Name of the path where event data files are located`,
    `"${p.CTEventFile}"         CTEventFile     - Type of event files ("LES", "DNS", or "RANDOM")`,
    `${pad(p.Randomize ? "true" : "false")} Randomize       - Randomize the disturbance scale and locations?`,
    `          ${p.DistScl}   DistScl         - Disturbance scale [-]`,
    `        ${p.CTLy}   CTLy            - Fractional location of tower centerline from right [-]`,
    `        ${p.CTLz}   CTLz            - Fractional location of hub height from the bottom [-]`,
    `         ${p.CTStartTime}   CTStartTime     - Minimum start time for coherent structures [seconds]`,
    ``,
    `====================================================`,
    `! NOTE: Do not add or remove any lines in this file!`,
    `====================================================`,
  ];
  return lines.join("\n");
}


// buildProfileContent removed — profile generation is now fully handled by the Python sidecar
// (write_user_profiles in fus_io.py) which writes the correct 3-column USRVKM format
// with sigma_u(z) TI gradient. No client-side profile writing needed.

// ── Defaults ──────────────────────────────────────────────────────────────────
// ── Parse a TurbSim .inp back into a partial params object ───────────────────
// Each line is: <value>   <ParamName>   - description
// Quoted values arrive already stripped of their surrounding quotes.
function parseInpContent(text) {
  const TMODELS = ["IECKAI","IECVKM","GP_LLJ","NWTCUP","SMOOTH","WF_UPW","WF_07D","WF_14D","TIDAL","API","NONE"];
  const ISTDS   = ["1","2","3","1-Ed2","1-Ed3"];
  const ICLS    = ["A","B","C"];
  const IWT     = ["NTM","1ETM","2ETM","3ETM","1EWM1","1EWM50"];
  const WPROF   = ["PL","LOG","JET","H2L","API","IEC"];

  const SKIP_PARAMS = new Set([
    "UserFile","ProfileFile",
    "SCMod1","SCMod2","SCMod3",
    "InCDec1","InCDec2","InCDec3","CohExp",
  ]);
  const BOOL_PARAMS = new Set([
    "Echo","WrBHHTP","WrFHHTP","WrADHH","WrADFF","WrBLFF",
    "WrADTWR","WrHAWCFF","WrFMTFF","WrACT","Randomize",
  ]);
  const INT_PARAMS   = new Set(["RandSeed1","NumGrid_Z","NumGrid_Y","ScaleIEC"]);
  const FLOAT_PARAMS = new Set([
    "TimeStep","AnalysisTime","UsableTime","HubHt","GridHeight","GridWidth",
    "VFlowAng","HFlowAng","RefHt","URef","RICH_NO","DistScl","CTLy","CTLz","CTStartTime",
  ]);
  const STRING_PARAMS = new Set([
    "PLExp","Z0","Latitude","UStar","ZI","PC_UW","PC_UV","PC_VW","ZJetMax","ETMc",
    "RandSeed2","CTEventPath","CTEventFile",
  ]);

  const updates = {};

  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('-') || trimmed.startsWith('=') || trimmed.startsWith('!')) continue;
    if (trimmed.includes('TurbSim v2') || trimmed.startsWith('FlowUrja')) continue;

    let rest = trimmed;
    let rawValue;

    if (rest.startsWith('"')) {
      const closeIdx = rest.indexOf('"', 1);
      if (closeIdx === -1) continue;
      rawValue = rest.slice(1, closeIdx);
      rest = rest.slice(closeIdx + 1).trimStart();
    } else {
      const spaceIdx = rest.search(/\s/);
      if (spaceIdx === -1) continue;
      rawValue = rest.slice(0, spaceIdx);
      rest = rest.slice(spaceIdx).trimStart();
    }

    if (!rest) continue;
    const paramName = rest.split(/\s/)[0];
    if (!paramName || paramName === '-' || paramName === ',') continue;

    if (SKIP_PARAMS.has(paramName)) continue;

    if (BOOL_PARAMS.has(paramName)) {
      updates[paramName] = rawValue.toLowerCase() === "true";
    } else if (INT_PARAMS.has(paramName)) {
      const v = parseInt(rawValue, 10);
      if (!isNaN(v)) updates[paramName] = v;
    } else if (FLOAT_PARAMS.has(paramName)) {
      const v = parseFloat(rawValue);
      if (!isNaN(v)) updates[paramName] = v;
    } else if (STRING_PARAMS.has(paramName)) {
      updates[paramName] = rawValue;
    } else if (paramName === "TurbModel") {
      const idx = TMODELS.indexOf(rawValue);
      if (idx !== -1) {
        updates.TurbModel = idx;
        updates.gTI = 1.0;
      }
      // "USRVKM" → gTI-derived, leave as-is
    } else if (paramName === "WindProfileType") {
      const idx = WPROF.indexOf(rawValue);
      if (idx !== -1) updates.WindProfileType = idx;
      // "USR" → gTI-derived, leave as-is
    } else if (paramName === "IECstandard") {
      const idx = ISTDS.indexOf(rawValue);
      if (idx !== -1) updates.IECstandard = idx;
    } else if (paramName === "IECturbc") {
      const idx = ICLS.indexOf(rawValue);
      if (idx !== -1) {
        updates.IECturbc = idx;
        updates.IECturbc_custom = "";
      } else {
        updates.IECturbc = 3;
        updates.IECturbc_custom = rawValue;
      }
    } else if (paramName === "IEC_WindType") {
      const idx = IWT.indexOf(rawValue);
      if (idx !== -1) updates.IEC_WindType = idx;
    }
  }

  return updates;
}

const DEFAULT = {
  URef:12.0, RefHt:90.0, PLExp:"default", Z0:"default",
  WindProfileType:0, gTI:1.0,
  RICH_NO:0.05, Latitude:"default", UStar:"default",
  ZI:"default", PC_UW:"default", PC_UV:"default", PC_VW:"default",
  HFlowAng:0.0, ZJetMax:"default", ETMc:"default",
  TurbModel:0, IECturbc:0, IECturbc_custom:"", IECstandard:0, IEC_WindType:0,
  NumGrid_Z:31, NumGrid_Y:31, GridHeight:150.0, GridWidth:150.0,
  HubHt:90.0, VFlowAng:0.0,
  TimeStep:0.05, AnalysisTime:630.0, UsableTime:600.0,
  RandSeed1:123456, RandSeed2:"RanLux",
  Echo:false, WrBHHTP:false, WrFHHTP:false, WrADHH:false,
  WrADFF:true, WrBLFF:false, WrADTWR:false,
  WrHAWCFF:false, WrFMTFF:false, WrACT:false, ScaleIEC:0,
  CTEventPath:".\\EventData", CTEventFile:"les",
  Randomize:true, DistScl:1.0, CTLy:0.5, CTLz:0.5, CTStartTime:10.0,
  OutputDir:"", FilePrefix:"",
};

function autoPrefix(p) {
  const model    = TURB_MODELS[p.TurbModel] || "IECKAI";
  const cls      = p.IECturbc === 3
    ? (p.IECturbc_custom ? `TI${String(p.IECturbc_custom).replace(".","p")}pct` : "TIcustom")
    : (["A","B","C"][p.IECturbc] || "A");
  const windType = ["NTM","ETM","ETM","ETM","EWM1","EWM50"][p.IEC_WindType] || "NTM";
  const uref     = String(p.URef).replace(".","p");
  const hub      = Math.round(p.HubHt);
  const usable   = Math.round(p.UsableTime);
  const grid     = `${p.NumGrid_Z}x${p.NumGrid_Y}`;
  const gtiStr   = p.gTI!==1.0 ? `_TIr${String(p.gTI).replace(".","p")}` : "";
  return `TurbSim_${model}_${cls}_${windType}_${uref}ms_${hub}m_${usable}s_${grid}${gtiStr}`;
}


// ── Hint parser: extract turbine geometry from an ElastoDyn .dat file ────────
function parseTurbineHints(content) {
  const kv = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/!.*$/, "").trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 2) continue;
    const val = parseFloat(tokens[0]);
    if (isNaN(val)) continue;
    kv[tokens[1]] = val;
  }
  return kv;
}

// Module-level: persists across remounts so the binary path is only logged once.
let _loggedTurbsimPath = null;

// ── Main component ────────────────────────────────────────────────────────────
export default function TurbSimPanel({ onLog, project, moduleFiles }) {
  const [tab,     setTab]   = useState("dashboard");
  const tabDirRef = useRef(1);
  const [p,       setP]     = useState(DEFAULT);
  const [running, setRunning] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  // ── Binary resolution (bundled → override → system) ──────────────────────
  const {
    resolvedPath:   turbsimPath,
    source:         turbsimSource,
    bundledVersion: turbsimBundledVersion,
  } = useBinarySettings("turbsim");
  const [rawContent,   setRawContent]   = useState("");
  // Hints propagated from ElastoDyn / FST when moduleFiles is available
  const [turbineHints, setTurbineHints] = useState(null);   // { HubHt, GridHeight, GridWidth, RefHt, AnalysisTime }
  const [hintDismissed, setHintDismissed] = useState(false);

  // ── Project / cases ──────────────────────────────────────────────────────
  const [cases,        setCases]        = useState([]);
  const [activeCaseId, setActiveCaseId] = useState(null);
  const casesRef        = useRef([]);
  const activeCaseIdRef = useRef(null);
  const projectRef      = useRef(null);
  const skipNextSave    = useRef(false);
  const saveTimer       = useRef(null);

  // Keep refs in sync (no extra renders)
  casesRef.current        = cases;
  activeCaseIdRef.current = activeCaseId;
  projectRef.current      = project;

  const scheduleSave = (updatedCases, aId) => {
    const proj = projectRef.current;
    if (!proj) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const data = { version: 1, name: proj.name, workingDir: proj.workingDir, cases: updatedCases, activeCaseId: aId };
      await invoke("write_text_file", {
        path: `${proj.workingDir}/turbsim.json`,
        content: JSON.stringify(data, null, 2),
      }).catch(() => {});
    }, 800);
  };

  // Load / reset when project changes
  useEffect(() => {
    if (!project) { setCases([]); setActiveCaseId(null); return; }
    (async () => {
      const newPath    = `${project.workingDir}/turbsim.json`;
      const legacyPath = `${project.workingDir}/project.nurja`;
      let data;
      try {
        // Try new canonical filename first; fall back to legacy "project.nurja"
        // so existing projects migrate automatically on first open.
        let raw;
        try       { raw = await invoke("read_text_file", { path: newPath }); }
        catch     { raw = await invoke("read_text_file", { path: legacyPath }); }
        data = JSON.parse(raw);
      } catch {
        const first = { id: `ts_${Date.now()}`, label: "Case 1",
          params: { ...DEFAULT },
          ran: false, outputBts: null };
        data = { version: 1, name: project.name, workingDir: project.workingDir,
          cases: [first], activeCaseId: first.id };
        await invoke("write_text_file", { path: newPath, content: JSON.stringify(data, null, 2) }).catch(() => {});
      }
      const activeCase = data.cases.find(c => c.id === data.activeCaseId) || data.cases[0];
      setCases(data.cases);
      setActiveCaseId(activeCase?.id ?? null);
      skipNextSave.current = true;
      // Always merge saved params ON TOP OF DEFAULT so fields added to DEFAULT
      // after a case was first saved don't come back as undefined (→ render crash).
      setP({ ...DEFAULT, ...(activeCase?.params ?? {}) });
    })();
  }, [project]);

  // Auto-save params to active case on every p change
  useEffect(() => {
    if (skipNextSave.current) { skipNextSave.current = false; return; }
    const aId = activeCaseIdRef.current;
    const cs  = casesRef.current;
    if (!aId || cs.length === 0) return;
    const updated = cs.map(c => c.id === aId ? { ...c, params: p } : c);
    casesRef.current = updated;
    scheduleSave(updated, aId);
  }, [p]);

  const switchCase = (id) => {
    if (id === activeCaseId) return;
    const saved = casesRef.current.map(c => c.id === activeCaseId ? { ...c, params: p } : c);
    const target = saved.find(c => c.id === id);
    if (!target) return;
    casesRef.current = saved;
    setCases(saved);
    setActiveCaseId(id);
    skipNextSave.current = true;
    setP({ ...DEFAULT, ...target.params });
    scheduleSave(saved, id);
  };

  const addCase = () => {
    const saved = casesRef.current.map(c => c.id === activeCaseId ? { ...c, params: p } : c);
    const id    = `ts_${Date.now()}`;
    // Find the first unused case number (fills gaps left by deleted cases)
    const usedNums = new Set(saved.map(c => {
      const m = c.label.match(/^Case (\d+)$/);
      return m ? parseInt(m[1]) : NaN;
    }).filter(n => !isNaN(n)));
    let nextN = 1;
    while (usedNums.has(nextN)) nextN++;
    const newCase = { id, label: `Case ${nextN}`,
      params: { ...DEFAULT },
      ran: false, outputBts: null };
    const updated = [...saved, newCase];
    casesRef.current = updated;
    setCases(updated);
    setActiveCaseId(id);
    skipNextSave.current = true;
    setP(newCase.params);
    scheduleSave(updated, id);
  };

  const removeCase = (id) => {
    const cs = casesRef.current;
    if (cs.length <= 1) return; // keep at least one case
    const updated = cs.filter(c => c.id !== id);
    casesRef.current = updated;
    setCases(updated);
    if (id === activeCaseIdRef.current) {
      // switch to adjacent case
      const removedIdx = cs.findIndex(c => c.id === id);
      const next = updated[Math.min(removedIdx, updated.length - 1)];
      setActiveCaseId(next.id);
      skipNextSave.current = true;
      setP({ ...DEFAULT, ...next.params });
      scheduleSave(updated, next.id);
    } else {
      scheduleSave(updated, activeCaseIdRef.current);
    }
  };
  const handleViewRaw = () => {
    setRawContent(buildInpContent(p, effectivePrefix));
    setShowRaw(true);
  };

  const handleApply = (editedContent) => {
    const updates = parseInpContent(editedContent);
    if (!Object.keys(updates).length) throw new Error("No recognizable parameters found");
    setP(prev => ({ ...prev, ...updates }));
  };
  // ── Propagate turbine geometry from ElastoDyn / FST whenever moduleFiles changes ─
  // We store "actioned" (applied OR dismissed) in sessionStorage keyed by file path so that
  // the bar stays hidden across component remounts within the same app session, but reappears
  // automatically whenever a different ElastoDyn file is loaded.
  const prevElastodynPath = useRef("");
  useEffect(() => {
    const edPath = moduleFiles?.elastodyn;
    if (!edPath) return;

    const storageKey = `ts_hint_actioned:${edPath}`;
    const alreadyActioned = sessionStorage.getItem(storageKey) === "1";

    // If the path hasn't changed since last render (remount scenario) and the user
    // already actioned this file's hints, just restore the dismissed state silently.
    if (edPath === prevElastodynPath.current) {
      if (alreadyActioned) setHintDismissed(true);
      return;
    }
    prevElastodynPath.current = edPath;

    // New file — reset dismissed state (respecting prior actioned state)
    setHintDismissed(alreadyActioned);

    (async () => {
      try {
        const content = await invoke("read_text_file", { path: edPath });
        const kv = parseTurbineHints(content);

        const towerHt  = kv["TowerHt"];
        const twr2shft = kv["Twr2Shft"];
        const tipRad   = kv["TipRad"];

        if (towerHt === undefined && tipRad === undefined) return;   // file has no geometry

        const hubHt    = (towerHt !== undefined && twr2shft !== undefined)
          ? +(towerHt + twr2shft).toFixed(2) : undefined;
        const gridSize = tipRad !== undefined
          ? Math.ceil((2.2 * tipRad) / 5) * 5 : undefined;

        // Also try to read TMax from the FST file
        let analysisTime;
        const fstPath = moduleFiles?.fstPath;
        if (fstPath) {
          try {
            const fstContent = await invoke("read_text_file", { path: fstPath });
            const fstKV = parseTurbineHints(fstContent);
            if (fstKV["TMax"] !== undefined) analysisTime = fstKV["TMax"];
          } catch { /* ignore */ }
        }

        const hints = {};
        if (hubHt !== undefined)        { hints.HubHt = hubHt; hints.RefHt = hubHt; }
        if (gridSize !== undefined)     { hints.GridHeight = gridSize; hints.GridWidth = gridSize; }
        if (analysisTime !== undefined) {
          hints.UsableTime    = analysisTime;
          hints.AnalysisTime  = analysisTime + 30;
        }

        if (Object.keys(hints).length > 0) setTurbineHints(hints);
      } catch { /* file unreadable — silently ignore */ }
    })();
  }, [moduleFiles?.elastodyn, moduleFiles?.fstPath]);

  const unlistenRef = useRef([]);

  // Log binary resolution result — only once per unique path across remounts.
  useEffect(() => {
    if (!turbsimPath || _loggedTurbsimPath === turbsimPath) return;
    _loggedTurbsimPath = turbsimPath;
    const src = turbsimSource === "bundled" ? "bundled"
              : turbsimSource === "override" ? "override"
              : "system";
    const verStr = turbsimSource === "bundled" && turbsimBundledVersion
      ? ` v${turbsimBundledVersion}` : "";
    onLog?.("ok", `TurbSim${verStr} → ${turbsimPath}  [${src}]`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turbsimPath]);

  const set    = k => v => setP(prev => ({ ...prev, [k]: v }));
  const setN   = k => e => setP(prev => ({ ...prev, [k]: Number(e.target.value) }));
  const setS   = k => e => setP(prev => ({ ...prev, [k]: e.target.value }));
  const setSel = k => e => setP(prev => ({ ...prev, [k]: Number(e.target.value) }));
  const setB   = k => v => setP(prev => ({ ...prev, [k]: v }));
  const setDef = k => e => {
    const v = e.target.value;
    setP(prev => ({ ...prev, [k]: v===""||isNaN(Number(v)) ? v : Number(v) }));
  };

  const stats = useMemo(() => {
    const steps  = Math.round(p.AnalysisTime / p.TimeStep);
    const bts_mb = (p.NumGrid_Z * p.NumGrid_Y * steps * 3 * 2) / 1e6;
    return { steps, bts_mb };
  }, [p]);

  const effectivePrefix = (p.FilePrefix ?? "").trim() || autoPrefix(p);

  // Next available run sequence number — only scans explicitly typed FilePrefix values
  // for a _rNNN suffix. Skips auto-named cases to avoid matching grid dimensions
  // (e.g. autoPrefix ends in "_31x31" which would falsely yield sequence 32).
  const nextSeq = useMemo(() => {
    let max = 0;
    for (const c of cases) {
      const prefix = (c.params?.FilePrefix ?? "").trim();
      if (!prefix) continue;
      const m = prefix.match(/_r(\d+)$/i);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return String(max + 1).padStart(3, "0");
  }, [cases]);

  // Clickable name suggestions: descriptive auto-name + short sequence fallback
  const suggestedNames = useMemo(() => {
    const names = [autoPrefix(p), `ts_r${nextSeq}`];
    return [...new Set(names)];
  }, [p, nextSeq]);

  const useGTI = p.gTI !== 1.0;
  const windDirShort = project
    ? (project.windDir ?? `${project.workingDir}/turbsim`).replace(/\\/g, "/").split("/").pop()
    : "wind";

  const hintStorageKey = moduleFiles?.elastodyn ? `ts_hint_actioned:${moduleFiles.elastodyn}` : null;

  const applyHints = () => {
    if (!turbineHints) return;
    setP(prev => ({ ...prev, ...turbineHints }));
    setHintDismissed(true);
    if (hintStorageKey) sessionStorage.setItem(hintStorageKey, "1");
    onLog?.("info", `TurbSim ← ElastoDyn: ${Object.entries(turbineHints).map(([k,v])=>`${k}=${v}`).join(", ")}`);
  };

  const handleDismissHints = () => {
    setHintDismissed(true);
    if (hintStorageKey) sessionStorage.setItem(hintStorageKey, "1");
  };

  const reshowHints = () => {
    setHintDismissed(false);
    if (hintStorageKey) sessionStorage.removeItem(hintStorageKey);
  };

  const showPropBar = turbineHints && !hintDismissed;

  const handleRun = async () => {
    if (!turbsimPath) { onLog?.("error", "TurbSim binary not found — open Settings (⚙ in the sidebar footer) to configure the binary path."); return; }
    setRunning(true);
    const outDir  = project ? (project.windDir ?? `${project.workingDir}/turbsim`) : ".";
    const inpPath = `${outDir}/${effectivePrefix}.inp`;
    try {
      onLog?.("info", `Writing ${effectivePrefix}.inp …`);
      // The Python sidecar auto-switches to USRVKM + USR and writes the 3-column
      // sigma_u(z) profile file whenever gTI != 1.0 — no React-side override needed.
      const sidecarParams = { ...p, FilePrefix: effectivePrefix };
      const raw = await invoke("sidecar_call", {
        payload: JSON.stringify({ cmd: "write_turbsim_inp", params: sidecarParams, path: inpPath }),
      });
      let result;
      try { result = JSON.parse(raw); } catch { result = { ok: false, error: "invalid sidecar response" }; }
      if (!result.ok) throw new Error(result.error || "sidecar failed to write .inp");

      onLog?.("ok", `Input → ${inpPath}`);

      const btsPath = `${outDir}/${effectivePrefix}.bts`;
      const ul1 = await listen("binary-stdout", evt => onLog?.("info", evt.payload));
      const ul2 = await listen("binary-stderr", evt => onLog?.("warn", `[stderr] ${evt.payload}`));
      const ul3 = await listen("binary-done", async () => {
        ul1(); ul2(); ul3();
        setRunning(false);
        // Verify the .bts was actually created — TurbSim may ABORT (non-zero exit)
        // but the process still fires binary-done, so check file existence.
        try {
          await invoke("read_text_file", { path: `${btsPath}.check_exists_dummy` });
        } catch (_) { /* expected */ }
        let btsExists = false;
        try {
          const stat = await invoke("read_bts_duration", { path: btsPath });
          btsExists = stat > 0;
        } catch { /* file not created = TurbSim aborted */ }

        if (btsExists) {
          onLog?.("ok", `TurbSim complete → ${effectivePrefix}.bts`);
          const aId = activeCaseIdRef.current;
          if (aId) {
            const updated = casesRef.current.map(c =>
              c.id === aId ? { ...c, ran: true, outputBts: btsPath } : c
            );
            casesRef.current = updated;
            setCases(updated);
            scheduleSave(updated, aId);
          }
        } else {
          onLog?.("error", `TurbSim aborted — no .bts generated. Check the log above for the error.`);
        }
      });
      unlistenRef.current = [ul1, ul2, ul3];

      onLog?.("info", `Running: ${turbsimPath} ${inpPath}`);
      await invoke("run_binary", { binary: turbsimPath, args: [inpPath] });
    } catch(err) { onLog?.("error", String(err)); setRunning(false); }
  };

  const handleStop = () => {
    unlistenRef.current.forEach(fn => fn?.());
    setRunning(false);
    onLog?.("warn", "Stopped by user.");
  };

  return (
    <div className={s.panel}>
      {/* Header */}
      <div className={s.header}>
        <Wind size={16} strokeWidth={1.8} style={{ color:"var(--c-turbsim)" }} />
        <h1 className={s.title}>TurbSim</h1>
        <span className={s.desc}>Wind field generation</span>
        <span className={s.badge}>v4.2.0 format</span>
        <div style={{ flex: 1 }} />
        <button className={`${s.headerBtn} ${s.headerBtnSecondary}`} onClick={handleViewRaw}>
          <Eye size={12} strokeWidth={1.8} /> View .inp
        </button>
      </div>

      {showRaw && (
        <RawFileModal
          content={rawContent}
          filename={`${effectivePrefix}.inp`}
          onClose={() => setShowRaw(false)}
          onApply={handleApply}
          warnSoftware="TurbSim"
        />
      )}

      {/* Cases bar — visible only when a project is loaded */}
      {project && (
        <div className={s.casesBar}>
          <button className={s.caseAddBtn} onClick={addCase}>
            <Plus size={11} strokeWidth={2} /> Case
          </button>
          <div className={s.casesList}>
            {cases.map(c => (
              <button
                key={c.id}
                className={`${s.caseTab} ${c.id === activeCaseId ? s.caseTabActive : ""}`}
                onClick={() => switchCase(c.id)}
              >
                {c.ran && <span className={s.caseRanDot} />}
                <span>{c.label}</span>
                {cases.length > 1 && (
                  <span
                    className={s.caseRemove}
                    onClick={e => { e.stopPropagation(); removeCase(c.id); }}
                    title="Remove case"
                  >×</span>
                )}
              </button>
            ))}
          </div>
          {turbineHints && hintDismissed && (
            <button className={`${s.caseHintBtn}`} onClick={reshowHints} title="Re-show turbine parameter suggestions">
              <Wind size={11} strokeWidth={1.8} /> Turbine hints
            </button>
          )}
        </div>
      )}

      {/* Propagation hint bar */}
      {showPropBar && (
        <div className={s.propBar}>
          <Wind size={12} strokeWidth={1.8} style={{ flexShrink:0, marginTop:1 }} />
          <span className={s.propBarText}>
            <strong>From loaded turbine:</strong>{" "}
            {Object.entries(turbineHints).map(([k, v]) => (
              <span key={k} className={s.propBadge}>{k} = {v}{k.includes("Ht") || k.includes("Height") || k.includes("Width") ? " m" : k === "UsableTime" ? " s" : ""}</span>
            ))}
          </span>
          <button className={s.propApplyBtn} onClick={applyHints}>Apply to case</button>
          <button className={s.propDismissBtn} onClick={handleDismissHints} title="Dismiss">×</button>
        </div>
      )}

      <div className={s.tabBar}>
        {TABS.map(t => (
          <button key={t.id} className={`${s.tab} ${tab===t.id?s.tabActive:""}`} onClick={() => {
              const oldIdx = TABS.findIndex(x => x.id === tab);
              const newIdx = TABS.findIndex(x => x.id === t.id);
              tabDirRef.current = newIdx >= oldIdx ? 1 : -1;
              setTab(t.id);
            }}>
            {t.label}
          </button>
        ))}
      </div>

      <div className={s.contentRow}>
        <div className={s.formArea}>

          {tab === "dashboard" && (
            <div key="dashboard" className={s.dashTab}>

              {/* ── Row 1: Key parameters (left) | Isoline hero (right) ── */}
              <div className={s.dashRow}>

                {/* Left: bold editable 2×2 param cells (narrow column) */}
                <div className={`${s.dashCard} ${s.paramCard}`}>
                  <span className={s.dashCardHead}>Parameters</span>
                  <div className={s.paramGrid}>
                    <TSEditableParam label="URef" unit="m/s" value={p.URef}
                      step={0.5} min={1} max={35}
                      onChange={v => setP(prev => ({ ...prev, URef: v }))} />
                    <TSEditableParam label="Usable time" unit="s" value={p.UsableTime}
                      step={10} min={60}
                      onChange={v => setP(prev => ({ ...prev, UsableTime: v, AnalysisTime: v + 30 }))} />
                    <TSEditableParam label="Grid Z" unit="nodes" value={p.NumGrid_Z}
                      step={2} min={3} max={99}
                      onChange={v => setP(prev => ({ ...prev, NumGrid_Z: Math.round(v) }))} />
                    <TSEditableParam label="Grid Y" unit="nodes" value={p.NumGrid_Y}
                      step={2} min={3} max={99}
                      onChange={v => setP(prev => ({ ...prev, NumGrid_Y: Math.round(v) }))} />
                  </div>
                </div>

                {/* Right: isoline animation hero */}
                <div className={`${s.dashCard} ${s.heroCard}`}>
                  <div className={s.heroGridWrap}>
                    <IsolineHero running={running} tiAsymmetry={p.gTI} />
                  </div>
                  {/* Corner stats */}
                  <div className={`${s.tcCorner} ${s.tcTopLeft}`}>
                    <span className={s.tcVal}>{p.URef}</span>
                    <span className={s.tcLabel}>Wind m/s</span>
                  </div>
                  <div className={`${s.tcCorner} ${s.tcTopRight}`}>
                    <span className={s.tcVal}>{p.NumGrid_Z}×{p.NumGrid_Y}</span>
                    <span className={s.tcLabel}>Grid</span>
                  </div>
                  <div className={`${s.tcCorner} ${s.tcBottomLeft}`}>
                    <span className={s.tcVal}>{p.HubHt}</span>
                    <span className={s.tcLabel}>Hub m</span>
                  </div>
                  <div className={`${s.tcCorner} ${s.tcBottomRight}`}>
                    <span className={s.tcVal}>~{stats.bts_mb.toFixed(0)} MB</span>
                    <span className={s.tcLabel}>Est. .bts</span>
                  </div>
                </div>

              </div>

              {/* ── Row 2: IEC + TI asymmetry (left) | Output + Binary (right column) ── */}
              <div className={s.dashRow}>

                {/* Left: IEC settings (top) + Rotor TI asymmetry (bottom) */}
                <div className={`${s.dashCard} ${s.tiCard} ${useGTI ? s.tiCardActive : ""}`}>

                  {/* IEC & turbulence section */}
                  <span className={s.dashCardHead}>IEC &amp; turbulence</span>
                  <div className={s.dashGrid2}>
                    <Field label="Turbulence class" infoKey="IECturbc">
                      <select value={p.IECturbc} onChange={e => {
                        const idx = Number(e.target.value);
                        setP(prev => ({ ...prev, IECturbc: idx, IECturbc_custom: idx !== 3 ? "" : prev.IECturbc_custom }));
                      }}>
                        {TURB_CLASSES.map((v,i) => <option key={i} value={i}>{v}</option>)}
                      </select>
                      {p.IECturbc === 3 && (
                        <input type="number" min={1} max={50} step={0.5}
                          value={p.IECturbc_custom} placeholder="e.g. 12 (= 12%)"
                          onChange={e => setP(prev => ({ ...prev, IECturbc_custom: e.target.value }))}
                          style={{ marginTop: 6 }} />
                      )}
                    </Field>
                    <Field label="IEC wind type" infoKey="IEC_WindType">
                      <select value={p.IEC_WindType} onChange={setSel("IEC_WindType")}>
                        {IEC_WIND_TYPES.map((v,i) => <option key={i} value={i}>{v}</option>)}
                      </select>
                    </Field>
                    <Field label="Turbulence model" infoKey="TurbModel">
                      <select value={p.TurbModel} onChange={setSel("TurbModel")} disabled={useGTI}>
                        {TURB_MODELS.map((v,i) => <option key={i} value={i}>{v}</option>)}
                      </select>
                    </Field>
                    <Field label="Random seed" infoKey="RandSeed1">
                      <input type="number" value={p.RandSeed1} onChange={setN("RandSeed1")} />
                    </Field>
                  </div>

                  {/* Divider */}
                  <div className={s.cardDivider} />

                  {/* Rotor TI asymmetry section */}
                  <div className={s.tiCardHead} style={{ marginTop: 14 }}>
                    <span className={s.dashCardHead} style={{ margin: 0 }}>Rotor TI asymmetry</span>
                    {useGTI && <span className={s.tiActiveBadge}>active</span>}
                  </div>
                  <div className={s.tiCardBody}>
                    <div className={s.tiDiagramWrap}>
                      <RotorTIDiagram tiAsymmetry={p.gTI} />
                    </div>
                    <div className={s.tiControls}>
                      <SliderField label="TI asymmetry ratio" infoKey="gTI"
                        min={1.0} max={2.0} step={0.05} value={p.gTI} onChange={set("gTI")} wide />
                      {!useGTI && (
                        <p style={{ fontSize:12, color:"var(--tx-4)", margin:"8px 0 0", lineHeight:1.5 }}>
                          Set above 1.0 to apply a vertical TI gradient across the rotor disk.
                        </p>
                      )}
                      {useGTI && (
                        <Callout type="info">
                          Ratio = {p.gTI} — switches to <strong>USRVKM</strong> + <strong>USR profile</strong>.
                          σ<sub>u</sub>(z) gradient: bottom TI is {p.gTI}× top TI, anchored to IEC class at hub.
                        </Callout>
                      )}
                    </div>
                  </div>

                </div>

                {/* Right column: two stacked sub-cards */}
                <div className={s.dashColRight}>

                  {/* Output sub-card: file prefix + run button */}
                  <div className={s.dashCard} style={{ display: "flex", flexDirection: "column" }}>
                    <span className={s.dashCardHead}>Output</span>
                    <Field label="File prefix">
                      <input type="text" value={p.FilePrefix} placeholder={suggestedNames[0]} onChange={setS("FilePrefix")} />
                      <div className={s.suggestions}>
                        {suggestedNames.map(name => (
                          <button key={name} className={s.suggestionChip}
                            onClick={() => setP(prev => ({ ...prev, FilePrefix: name }))}>
                            {name}
                          </button>
                        ))}
                      </div>
                      <p className={s.hint}>→ {windDirShort}/{effectivePrefix}</p>
                    </Field>
                    {/* marginTop:auto pushes the run button to the card bottom as card grows */}
                    <div style={{ marginTop: "auto", paddingTop: 14 }}>
                      {!running ? (
                        <button
                          className={s.runDashBtn}
                          onClick={handleRun}
                          disabled={!turbsimPath || !project}
                          title={
                            !project     ? "Select a project folder first" :
                            !turbsimPath ? "Set the TurbSim binary first" : undefined
                          }
                        >
                          <Play size={14} strokeWidth={2} fill="currentColor" />
                          Run TurbSim
                        </button>
                      ) : (
                        <button className={`${s.runDashBtn} ${s.stopDashBtn}`} onClick={handleStop}>
                          <Square size={13} strokeWidth={2} fill="currentColor" />
                          Stop · {effectivePrefix}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Binary status (read-only) — configure in Settings */}
                  <div className={s.dashCard} style={{ flex: "0 0 auto", padding: "10px 14px" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                      <span className={s.dashCardHead} style={{ marginBottom: 0 }}>TurbSim binary</span>
                      <span style={{ fontSize: 11, color: "var(--tx-5)" }}>
                        Configure in <strong style={{ color: "var(--tx-3)", fontWeight: 600 }}>Settings ⚙</strong>
                      </span>
                    </div>
                    {(() => {
                      const ver      = turbsimBundledVersion ?? null;
                      const srcLabel = turbsimSource === "bundled"  ? "Bundled"
                                     : turbsimSource === "system"   ? "System"
                                     : turbsimSource === "override" ? "Override"
                                     : "Not found";
                      const ok  = turbsimSource !== "notfound" && !!turbsimPath;
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
                            {turbsimPath ? turbsimPath.replace(/\\/g, "/").split("/").slice(-2).join("/") : "—"}
                          </span>
                        </div>
                      );
                    })()}
                  </div>

                </div>

              </div>

            </div>
          )}

          {tab === "wind" && (
            <div key="wind" className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
              <SectionHead>Reference wind conditions</SectionHead>
              <div className={s.grid2}>
                <SliderField label="Mean wind speed (URef)" unit="m/s" infoKey="URef"
                  min={1} max={35} step={0.5} value={p.URef} onChange={set("URef")} wide />
                <Field label="Reference height (RefHt)" unit="m" infoKey="RefHt">
                  <input type="number" value={p.RefHt} min={1} max={500} onChange={setN("RefHt")} />
                </Field>
                <Field label="Wind profile type" infoKey="WindProfile">
                  <select value={p.WindProfileType} onChange={setSel("WindProfileType")} disabled={useGTI}>
                    {WIND_PROFILES.map((v,i) => <option key={i} value={i}>{v}</option>)}
                  </select>
                </Field>
                <Field label="Power law exponent (PLExp)" infoKey="PLExp">
                  <input type="text" value={p.PLExp} onChange={setDef("PLExp")} />
                </Field>
                <Field label="Surface roughness (Z0)" infoKey="Z0">
                  <input type="text" value={p.Z0} onChange={setDef("Z0")} />
                </Field>
              </div>

              <SectionHead>Random seeds</SectionHead>
              <div className={s.grid2}>
                <Field label="RandSeed1" infoKey="RandSeed1">
                  <input type="number" value={p.RandSeed1} onChange={setN("RandSeed1")} />
                </Field>
                <Field label="RandSeed2" infoKey="RandSeed2">
                  <input type="text" value={p.RandSeed2} onChange={setS("RandSeed2")} />
                </Field>
              </div>

              <Collapsible title="Advanced meteorological parameters">
                <div className={s.grid2}>
                  <Field label="Latitude" infoKey="Latitude">
                    <input type="text" value={p.Latitude} onChange={setDef("Latitude")} />
                  </Field>
                  <Field label="Friction velocity (UStar)" unit="m/s" infoKey="UStar">
                    <input type="text" value={p.UStar} onChange={setDef("UStar")} />
                  </Field>
                  <Field label="Mixing layer depth (ZI)" unit="m" infoKey="ZI">
                    <input type="text" value={p.ZI} onChange={setDef("ZI")} />
                  </Field>
                  <Field label="Horizontal flow angle" unit="°" infoKey="HFlowAng">
                    <input type="number" value={p.HFlowAng} step={0.5} onChange={setN("HFlowAng")} />
                  </Field>
                  <Field label="Jet max height (ZJetMax)" unit="m" infoKey="ZJetMax">
                    <input type="text" value={p.ZJetMax} onChange={setDef("ZJetMax")} />
                  </Field>
                  <Field label="ETM c parameter (ETMc)" unit="m/s" infoKey="ETMc">
                    <input type="text" value={p.ETMc} onChange={setDef("ETMc")} />
                  </Field>
                  <Field label="Reynolds stress PC_UW" unit="m²/s²" infoKey="PC_UW">
                    <input type="text" value={p.PC_UW} onChange={setDef("PC_UW")} />
                  </Field>
                  <Field label="Reynolds stress PC_UV" unit="m²/s²" infoKey="PC_UV">
                    <input type="text" value={p.PC_UV} onChange={setDef("PC_UV")} />
                  </Field>
                  <Field label="Reynolds stress PC_VW" unit="m²/s²" infoKey="PC_VW">
                    <input type="text" value={p.PC_VW} onChange={setDef("PC_VW")} />
                  </Field>
                </div>
              </Collapsible>
            </div>
          )}

          {tab === "spectral" && (
            <div key="spectral" className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
              <SectionHead>Turbulence model</SectionHead>

              <div className={s.grid2}>
                <Field label="TurbModel" infoKey="TurbModel">
                  <select value={p.TurbModel} onChange={setSel("TurbModel")} disabled={useGTI}>
                    {TURB_MODELS.map((v,i) => <option key={i} value={i}>{v}</option>)}
                  </select>
                </Field>
                <Field label="IEC turbulence class (IECturbc)" infoKey="IECturbc">
                  <select value={p.IECturbc} onChange={e => {
                    const idx = Number(e.target.value);
                    setP(prev => ({ ...prev, IECturbc: idx, IECturbc_custom: idx !== 3 ? "" : prev.IECturbc_custom }));
                  }}>
                    {TURB_CLASSES.map((v,i) => <option key={i} value={i}>{v}</option>)}
                  </select>
                  {p.IECturbc === 3 && (
                    <input
                      type="number"
                      min={1} max={50} step={0.5}
                      value={p.IECturbc_custom}
                      placeholder="e.g. 12  (= 12%)"
                      onChange={e => setP(prev => ({ ...prev, IECturbc_custom: e.target.value }))}
                      style={{ marginTop: 6 }}
                    />
                  )}
                </Field>
                <Field label="IEC standard (IECstandard)" infoKey="IECstandard">
                  <select value={p.IECstandard} onChange={setSel("IECstandard")}>
                    {IEC_STANDARDS.map((v,i) => <option key={i} value={i}>{v}</option>)}
                  </select>
                </Field>
                <Field label="IEC wind type (IEC_WindType)" infoKey="IEC_WindType">
                  <select value={p.IEC_WindType} onChange={setSel("IEC_WindType")}>
                    {IEC_WIND_TYPES.map((v,i) => <option key={i} value={i}>{v}</option>)}
                  </select>
                </Field>
              </div>

              <SectionHead>Atmospheric stability</SectionHead>
              <div className={s.grid2}>
                <Field label="Richardson number (RICH_NO)" infoKey="RICH_NO">
                  <input type="number" value={p.RICH_NO} step={0.01} min={-1} max={1} onChange={setN("RICH_NO")} />
                </Field>
              </div>

              <SectionHead>Rotor TI asymmetry</SectionHead>
              <div className={s.grid2}>
                <SliderField label="TI asymmetry ratio" infoKey="gTI"
                  min={1.0} max={2.0} step={0.05} value={p.gTI} onChange={set("gTI")} wide />
              </div>
              {useGTI && (
                <Callout type="info">
                  gTI = {p.gTI} — TurbSim will use <strong>USRVKM</strong> (user-defined von Kármán) with
                  a <strong>3-column profile</strong>: U(z) power law + σ<sub>u</sub>(z) gradient anchored
                  to IEC class at hub. Bottom σ<sub>u</sub> is {p.gTI}× top σ<sub>u</sub>.
                  TurbModel and WindProfileType are set automatically.
                </Callout>
              )}
            </div>
          )}

          {tab === "grid" && (
            <div key="grid" className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
              <SectionHead>Spatial grid</SectionHead>
              <div className={s.grid2}>
                <Field label="NumGrid_Z" unit="nodes" infoKey="NumGrid_Z">
                  <input type="number" value={p.NumGrid_Z} min={3} max={99} step={2} onChange={setN("NumGrid_Z")} />
                </Field>
                <Field label="NumGrid_Y" unit="nodes" infoKey="NumGrid_Y">
                  <input type="number" value={p.NumGrid_Y} min={3} max={99} step={2} onChange={setN("NumGrid_Y")} />
                </Field>
                <Field label="GridHeight" unit="m" infoKey="GridHeight">
                  <input type="number" value={p.GridHeight} min={10} onChange={setN("GridHeight")} />
                </Field>
                <Field label="GridWidth" unit="m" infoKey="GridWidth">
                  <input type="number" value={p.GridWidth} min={10} onChange={setN("GridWidth")} />
                </Field>
                <Field label="HubHt" unit="m" infoKey="HubHt">
                  <input type="number" value={p.HubHt} min={1} onChange={setN("HubHt")} />
                </Field>
                <Field label="VFlowAng" unit="°" infoKey="VFlowAng">
                  <input type="number" value={p.VFlowAng} step={0.5} onChange={setN("VFlowAng")} />
                </Field>
              </div>
              <SectionHead>Time</SectionHead>
              <div className={s.grid2}>
                <Field label="TimeStep" unit="s" infoKey="TimeStep">
                  <input type="number" value={p.TimeStep} step={0.005} min={0.001} onChange={setN("TimeStep")} />
                </Field>
                <Field label="AnalysisTime" unit="s" infoKey="AnalysisTime">
                  <input type="number" value={p.AnalysisTime} min={60} onChange={setN("AnalysisTime")} />
                </Field>
                <Field label="UsableTime" unit="s" infoKey="UsableTime">
                  <input type="number" value={p.UsableTime} min={60}
                    onChange={e => {
                      const v = Number(e.target.value);
                      setP(prev => ({ ...prev, UsableTime: v, AnalysisTime: v + 30 }));
                    }} />
                </Field>
              </div>
              <Callout type="warn">
                TurbSim may extend AnalysisTime: MAX(AnalysisTime, UsableTime + GridWidth / MeanHHWS)
              </Callout>
            </div>
          )}

          {tab === "runtime" && (
            <div key="runtime" className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
              <SectionHead>Scaling</SectionHead>
              <Field label="ScaleIEC" infoKey="ScaleIEC">
                <select value={p.ScaleIEC} onChange={e => setP(prev => ({ ...prev, ScaleIEC: Number(e.target.value) }))}>
                  <option value={0}>0 — No additional scaling</option>
                  <option value={1}>1 — Hub uniform scaling</option>
                  <option value={2}>2 — Individual component scaling</option>
                </select>
              </Field>

              <div style={{ marginTop: 18 }} />
              <Collapsible title="Additional output formats &amp; flags">
                <div className={s.toggleGrid}>
                  <Toggle label="WrADTWR — .twr tower file"        infoKey="WrADTWR"  value={p.WrADTWR}  onChange={setB("WrADTWR")} />
                  <Toggle label="Echo — write .ech debug file"      infoKey="Echo"     value={p.Echo}     onChange={setB("Echo")} />
                  <Toggle label="WrBHHTP — hub-height binary"       infoKey="WrBHHTP"  value={p.WrBHHTP}  onChange={setB("WrBHHTP")} />
                  <Toggle label="WrFHHTP — hub-height formatted"    infoKey="WrFHHTP"  value={p.WrFHHTP}  onChange={setB("WrFHHTP")} />
                  <Toggle label="WrADHH — AeroDyn hub-height"       infoKey="WrADHH"   value={p.WrADHH}   onChange={setB("WrADHH")} />
                  <Toggle label="WrACT — coherent turbulence .cts"  infoKey="WrACT"    value={p.WrACT}    onChange={setB("WrACT")} />
                </div>
              </Collapsible>

              <Collapsible title="Coherent turbulence parameters">
                <div className={s.grid2}>
                  <Field label="CTEventPath" infoKey="CTEventPath">
                    <input type="text" value={p.CTEventPath} onChange={setS("CTEventPath")} />
                  </Field>
                  <Field label="CTEventFile" infoKey="CTEventFile">
                    <select value={p.CTEventFile} onChange={setS("CTEventFile")}>
                      <option value="les">LES</option>
                      <option value="dns">DNS</option>
                      <option value="random">RANDOM</option>
                    </select>
                  </Field>
                  <Field label="Randomize" infoKey="Randomize">
                    <select value={p.Randomize?"true":"false"} onChange={e => setP(prev => ({ ...prev, Randomize:e.target.value==="true" }))}>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  </Field>
                  <Field label="DistScl" infoKey="DistScl">
                    <input type="number" value={p.DistScl} step={0.1} min={0.1} onChange={setN("DistScl")} disabled={p.Randomize} />
                  </Field>
                  <Field label="CTLy" infoKey="CTLy">
                    <input type="number" value={p.CTLy} step={0.1} min={0} max={1} onChange={setN("CTLy")} disabled={p.Randomize} />
                  </Field>
                  <Field label="CTLz" infoKey="CTLz">
                    <input type="number" value={p.CTLz} step={0.1} min={0} max={1} onChange={setN("CTLz")} disabled={p.Randomize} />
                  </Field>
                  <Field label="CTStartTime" unit="s" infoKey="CTStartTime">
                    <input type="number" value={p.CTStartTime} min={0} onChange={setN("CTStartTime")} />
                  </Field>
                </div>
              </Collapsible>
            </div>
          )}
        </div>

        {/* Stats sidebar — hidden on dashboard (dashboard has its own hero stats) */}
        {tab !== "dashboard" && (
          <div className={s.statsPanel}>
            <p className={s.statsLabel}>Quick stats</p>
            <div className={s.windGridWrap}>
              <IsolineMini running={running} />
            </div>
            <div className={s.statsGrid}>
              {[
                { k:"Hub height",  v:`${p.HubHt} m`                  },
                { k:"Wind speed",  v:`${p.URef} m/s`                  },
                { k:"Grid",        v:`${p.NumGrid_Z}×${p.NumGrid_Y}`   },
                { k:"Duration",    v:`${p.AnalysisTime} s`             },
                { k:"Time steps",  v:stats.steps.toLocaleString()      },
                { k:"Est. .bts",   v:`~${stats.bts_mb.toFixed(0)} MB`  },
                { k:"TI asymm.",   v:p.gTI!==1.0 ? `${p.gTI}×` : "uniform" },
                { k:"Turb. class", v:p.IECturbc===3 ? (p.IECturbc_custom?`${p.IECturbc_custom}%`:"custom") : (["A","B","C"][p.IECturbc]||"A") },
              ].map(c => (
                <div key={c.k} className={s.statCard}>
                  <span className={s.statKey}>{c.k}</span>
                  <span className={s.statVal}>{c.v}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
