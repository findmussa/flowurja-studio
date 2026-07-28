import { useState, useEffect, useCallback, useRef, useMemo, createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { invoke }             from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Activity, FolderOpen, Eye, Save, ChevronDown, ChevronRight, Link, Unlink, AlertTriangle, List,
} from "lucide-react";
import RawFileModal from "../RawFileModal";
import InfoPopover from "../InfoPopover";
import s from "./ElastoDynPanel.module.css";

const ACCENT = "#7F77DD";

// ── ElastoDyn output variable database ───────────────────────────────────────
const ED_OUT_VARS = [
  {
    group: "Performance & Power",
    vars: [
      { name: "GenSpeed",  unit: "rpm",  desc: "Generator speed (high-speed shaft)" },
      { name: "GenTq",     unit: "kN·m", desc: "Generator electrical torque" },
      { name: "GenPwr",    unit: "kW",   desc: "Generator electrical power output" },
      { name: "RotSpeed",  unit: "rpm",  desc: "Low-speed shaft (rotor) speed" },
      { name: "HSSBrTqC", unit: "kN·m", desc: "High-speed shaft brake torque (command)" },
      { name: "HSShftV",  unit: "rpm",  desc: "High-speed shaft speed" },
    ],
  },
  {
    group: "Rotor & Shaft",
    vars: [
      { name: "Azimuth",   unit: "deg",  desc: "Blade 1 azimuth angle" },
      { name: "RotThrust", unit: "kN",   desc: "Rotor thrust (low-speed shaft axis)" },
      { name: "RotTorq",  unit: "kN·m", desc: "Rotor torque (low-speed shaft)" },
      { name: "RotPwr",   unit: "kW",   desc: "Rotor aerodynamic power" },
      { name: "LSSTipPxa",unit: "deg",  desc: "Low-speed shaft tip azimuth" },
      { name: "LSSTipMya",unit: "kN·m", desc: "LSS tip tilt moment" },
      { name: "LSSTipMzs",unit: "kN·m", desc: "LSS tip yaw moment (non-rotating)" },
      { name: "LSShftFys",unit: "kN",   desc: "LSS shear force (y, non-rotating)" },
      { name: "LSShftFzs",unit: "kN",   desc: "LSS shear force (z, non-rotating)" },
    ],
  },
  {
    group: "Blade Root Loads — Blade 1",
    vars: [
      { name: "RootFxb1", unit: "kN",   desc: "Blade 1 root x-shear (body frame)" },
      { name: "RootFyb1", unit: "kN",   desc: "Blade 1 root y-shear (body frame)" },
      { name: "RootFzb1", unit: "kN",   desc: "Blade 1 root axial force (body frame)" },
      { name: "RootMxb1", unit: "kN·m", desc: "Blade 1 root edge moment (body frame)" },
      { name: "RootMyb1", unit: "kN·m", desc: "Blade 1 root flap moment (body frame)" },
      { name: "RootMzb1", unit: "kN·m", desc: "Blade 1 root torsion (body frame)" },
      { name: "RootFxc1", unit: "kN",   desc: "Blade 1 root x-shear (chord frame)" },
      { name: "RootFyc1", unit: "kN",   desc: "Blade 1 root y-shear (chord frame)" },
      { name: "RootMxc1", unit: "kN·m", desc: "Blade 1 root edge moment (chord frame)" },
      { name: "RootMyc1", unit: "kN·m", desc: "Blade 1 root flap moment (chord frame)" },
    ],
  },
  {
    group: "Blade Root Loads — Blades 2 & 3",
    vars: [
      { name: "RootFxb2", unit: "kN",   desc: "Blade 2 root x-shear (body frame)" },
      { name: "RootFyb2", unit: "kN",   desc: "Blade 2 root y-shear (body frame)" },
      { name: "RootMxb2", unit: "kN·m", desc: "Blade 2 root edge moment" },
      { name: "RootMyb2", unit: "kN·m", desc: "Blade 2 root flap moment" },
      { name: "RootFxb3", unit: "kN",   desc: "Blade 3 root x-shear (body frame)" },
      { name: "RootFyb3", unit: "kN",   desc: "Blade 3 root y-shear (body frame)" },
      { name: "RootMxb3", unit: "kN·m", desc: "Blade 3 root edge moment" },
      { name: "RootMyb3", unit: "kN·m", desc: "Blade 3 root flap moment" },
    ],
  },
  {
    group: "Blade Deflections & Pitch",
    vars: [
      { name: "OoPDefl1",  unit: "m",   desc: "Blade 1 out-of-plane tip deflection" },
      { name: "IPDefl1",   unit: "m",   desc: "Blade 1 in-plane tip deflection" },
      { name: "OoPDefl2",  unit: "m",   desc: "Blade 2 out-of-plane tip deflection" },
      { name: "IPDefl2",   unit: "m",   desc: "Blade 2 in-plane tip deflection" },
      { name: "OoPDefl3",  unit: "m",   desc: "Blade 3 out-of-plane tip deflection" },
      { name: "IPDefl3",   unit: "m",   desc: "Blade 3 in-plane tip deflection" },
      { name: "TipDxc1",  unit: "m",   desc: "Blade 1 tip flapwise deflection (chord frame)" },
      { name: "TipDyc1",  unit: "m",   desc: "Blade 1 tip edgewise deflection (chord frame)" },
      { name: "TipRDxb1", unit: "deg", desc: "Blade 1 tip flapwise rotation" },
      { name: "TipRDyb1", unit: "deg", desc: "Blade 1 tip edgewise rotation" },
      { name: "BldPitch1",unit: "deg", desc: "Blade 1 pitch angle" },
      { name: "BldPitch2",unit: "deg", desc: "Blade 2 pitch angle" },
      { name: "BldPitch3",unit: "deg", desc: "Blade 3 pitch angle" },
      { name: "TipClrnc1",unit: "m",   desc: "Blade 1 tip-to-tower clearance" },
    ],
  },
  {
    group: "Tower & Yaw Loads",
    vars: [
      { name: "TwrBsFxt",  unit: "kN",   desc: "Tower base fore-aft shear force" },
      { name: "TwrBsFyt",  unit: "kN",   desc: "Tower base side-to-side shear force" },
      { name: "TwrBsFzt",  unit: "kN",   desc: "Tower base vertical force" },
      { name: "TwrBsMxt",  unit: "kN·m", desc: "Tower base side-to-side bending moment" },
      { name: "TwrBsMyt",  unit: "kN·m", desc: "Tower base fore-aft bending moment" },
      { name: "TwrBsMzt",  unit: "kN·m", desc: "Tower base torsional moment" },
      { name: "YawBrFxp",  unit: "kN",   desc: "Yaw bearing fore-aft shear force" },
      { name: "YawBrFyp",  unit: "kN",   desc: "Yaw bearing side-to-side shear force" },
      { name: "YawBrFzp",  unit: "kN",   desc: "Yaw bearing vertical force" },
      { name: "YawBrMxp",  unit: "kN·m", desc: "Yaw bearing roll moment" },
      { name: "YawBrMyp",  unit: "kN·m", desc: "Yaw bearing pitch moment" },
      { name: "YawBrMzp",  unit: "kN·m", desc: "Yaw bearing yaw moment" },
      { name: "YawBrTDxp", unit: "m",    desc: "Tower-top fore-aft displacement" },
      { name: "YawBrTDyp", unit: "m",    desc: "Tower-top side-to-side displacement" },
      { name: "YawBrRDzt", unit: "deg",  desc: "Nacelle yaw angle (tower-top)" },
    ],
  },
  {
    group: "Nacelle & Tower Top",
    vars: [
      { name: "NacYaw",     unit: "deg",    desc: "Nacelle yaw angle" },
      { name: "NacYawErr",  unit: "deg",    desc: "Nacelle yaw error angle" },
      { name: "TTDspFA",    unit: "m",      desc: "Tower-top fore-aft displacement" },
      { name: "TTDspSS",    unit: "m",      desc: "Tower-top side-to-side displacement" },
      { name: "NacIMURAxs", unit: "deg/s²", desc: "Nacelle IMU roll acceleration" },
      { name: "NacIMURAys", unit: "deg/s²", desc: "Nacelle IMU pitch acceleration" },
      { name: "NacIMURAzs", unit: "deg/s²", desc: "Nacelle IMU yaw acceleration" },
      { name: "NcIMUTAxs",  unit: "m/s²",  desc: "Nacelle IMU translational x acceleration" },
      { name: "NcIMUTAys",  unit: "m/s²",  desc: "Nacelle IMU translational y acceleration" },
      { name: "NcIMUTAzs",  unit: "m/s²",  desc: "Nacelle IMU translational z acceleration" },
    ],
  },
  {
    group: "Platform (Offshore)",
    vars: [
      { name: "PtfmSurge", unit: "m",    desc: "Platform surge (fore-aft translation)" },
      { name: "PtfmSway",  unit: "m",    desc: "Platform sway (side-to-side translation)" },
      { name: "PtfmHeave", unit: "m",    desc: "Platform heave (vertical translation)" },
      { name: "PtfmRoll",  unit: "deg",  desc: "Platform roll rotation" },
      { name: "PtfmPitch", unit: "deg",  desc: "Platform pitch rotation" },
      { name: "PtfmYaw",   unit: "deg",  desc: "Platform yaw rotation" },
      { name: "PtfmFxt",   unit: "kN",   desc: "Platform mooring/hydro fore-aft force" },
      { name: "PtfmFyt",   unit: "kN",   desc: "Platform mooring/hydro side force" },
      { name: "PtfmFzt",   unit: "kN",   desc: "Platform mooring/hydro vertical force" },
      { name: "PtfmMxt",   unit: "kN·m", desc: "Platform roll moment" },
      { name: "PtfmMyt",   unit: "kN·m", desc: "Platform pitch moment" },
      { name: "PtfmMzt",   unit: "kN·m", desc: "Platform yaw moment" },
    ],
  },
];

// ── Blade node output variable database ──────────────────────────────────────
const ED_NODE_VARS = [
  {
    group: "Translational Deflection",
    vars: [
      { name: "TDx", unit: "m",   desc: "Local flapwise translational deflection (relative to undeflected position)" },
      { name: "TDy", unit: "m",   desc: "Local edgewise translational deflection (relative to undeflected position)" },
      { name: "TDz", unit: "m",   desc: "Local axial translational deflection (relative to undeflected position)" },
    ],
  },
  {
    group: "Rotational Deflection",
    vars: [
      { name: "RDx", unit: "deg", desc: "Local flapwise rotational deflection (relative to undeflected position)" },
      { name: "RDy", unit: "deg", desc: "Local edgewise rotational deflection (relative to undeflected position)" },
      { name: "RDz", unit: "deg", desc: "Local torsional rotational deflection (relative to undeflected position)" },
    ],
  },
  {
    group: "Translational Velocity",
    vars: [
      { name: "TVx", unit: "m/s",   desc: "Local flapwise translational velocity" },
      { name: "TVy", unit: "m/s",   desc: "Local edgewise translational velocity" },
      { name: "TVz", unit: "m/s",   desc: "Local axial translational velocity" },
    ],
  },
  {
    group: "Rotational Velocity",
    vars: [
      { name: "RVx", unit: "deg/s", desc: "Local flapwise rotational velocity" },
      { name: "RVy", unit: "deg/s", desc: "Local edgewise rotational velocity" },
      { name: "RVz", unit: "deg/s", desc: "Local torsional rotational velocity" },
    ],
  },
  {
    group: "Translational Acceleration",
    vars: [
      { name: "TAx", unit: "m/s²",   desc: "Local flapwise translational acceleration" },
      { name: "TAy", unit: "m/s²",   desc: "Local edgewise translational acceleration" },
      { name: "TAz", unit: "m/s²",   desc: "Local axial translational acceleration" },
    ],
  },
  {
    group: "Rotational Acceleration",
    vars: [
      { name: "RAx", unit: "deg/s²", desc: "Local flapwise rotational acceleration" },
      { name: "RAy", unit: "deg/s²", desc: "Local edgewise rotational acceleration" },
      { name: "RAz", unit: "deg/s²", desc: "Local torsional rotational acceleration" },
    ],
  },
  {
    group: "Internal Loads (Body Frame)",
    vars: [
      { name: "FxL", unit: "kN",   desc: "Flapwise shear force at node (blade body frame, x)" },
      { name: "FyL", unit: "kN",   desc: "Edgewise shear force at node (blade body frame, y)" },
      { name: "FzL", unit: "kN",   desc: "Axial force at node (blade body frame, z)" },
      { name: "MxL", unit: "kN·m", desc: "Edgewise bending moment at node" },
      { name: "MyL", unit: "kN·m", desc: "Flapwise bending moment at node" },
      { name: "MzL", unit: "kN·m", desc: "Torsional moment at node" },
    ],
  },
  {
    group: "Internal Loads (Global Frame)",
    vars: [
      { name: "FxN", unit: "kN",   desc: "X-direction force at node (inertial/global frame)" },
      { name: "FyN", unit: "kN",   desc: "Y-direction force at node (inertial/global frame)" },
      { name: "FzN", unit: "kN",   desc: "Z-direction force at node (inertial/global frame)" },
      { name: "MxN", unit: "kN·m", desc: "X-direction moment at node (inertial/global frame)" },
      { name: "MyN", unit: "kN·m", desc: "Y-direction moment at node (inertial/global frame)" },
      { name: "MzN", unit: "kN·m", desc: "Z-direction moment at node (inertial/global frame)" },
    ],
  },
];

// ── Inline output-variable picker modal (createPortal to escape scroll clip) ─
function EdOutVarModal({ current, onClose, onApply, vars = ED_OUT_VARS, title = "Output variable picker" }) {
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
  const filteredGroups = vars.map(g => ({
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
          <span className={s.modalTitle}>{title}</span>
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
              placeholder="Search variables… (name, description, unit)"
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
            <p className={s.varNoMatch}>No variables match "{query}"</p>
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

// ── Missing-fields context — lets Field read the set without prop-drilling ───
const MissingCtx = createContext(new Set());

// NodeOutList is stored as __NodeOut__ in rawKV (not a direct key), so the
// missing-fields check can never find it — exclude it from that scan.
const NO_UI_FIELDS = new Set(["NodeOutList"]);

// Which tab each DEFAULT key lives on — used to jump to the right place from the banner.
const FIELD_TAB = {
  // quick
  RotSpeed:"quick", NacYaw:"quick", Azimuth:"quick",
  GBRatio:"quick",  GBoxEff:"quick", TStart:"quick", DecFact:"quick",
  // geometry
  NumBl:"geometry",  TipRad:"geometry",   HubRad:"geometry",
  PreCone1:"geometry", PreCone2:"geometry", PreCone3:"geometry",
  OverHang:"geometry", ShftTilt:"geometry", Twr2Shft:"geometry", ShftGagL:"geometry",
  TowerHt:"geometry",  TowerBsHt:"geometry",
  NacCMxn:"geometry",  NacCMyn:"geometry",  NacCMzn:"geometry",
  NcIMUxn:"geometry",  NcIMUyn:"geometry",  NcIMUzn:"geometry",
  HubCM:"geometry",    AzimB1Up:"geometry", Delta3:"geometry",   UndSling:"geometry",
  PtfmCMxt:"geometry", PtfmCMyt:"geometry", PtfmCMzt:"geometry", PtfmRefzt:"geometry",
  // dofs
  FlapDOF1:"dofs", FlapDOF2:"dofs", EdgeDOF:"dofs",  TeetDOF:"dofs",
  DrTrDOF:"dofs",  GenDOF:"dofs",   YawDOF:"dofs",
  TwFADOF1:"dofs", TwFADOF2:"dofs", TwSSDOF1:"dofs", TwSSDOF2:"dofs",
  PtfmSgDOF:"dofs", PtfmSwDOF:"dofs", PtfmHvDOF:"dofs",
  PtfmRDOF:"dofs",  PtfmPDOF:"dofs",  PtfmYDOF:"dofs",
  OoPDefl:"dofs",  IPDefl:"dofs",   TeetDefl:"dofs",
  TTDspFA:"dofs",  TTDspSS:"dofs",
  BlPitch1:"dofs", BlPitch2:"dofs", BlPitch3:"dofs",
  PtfmSurge:"dofs", PtfmSway:"dofs", PtfmHeave:"dofs",
  PtfmRoll:"dofs",  PtfmPitch:"dofs", PtfmYaw:"dofs",
  // mass
  TipMass1:"mass", TipMass2:"mass", TipMass3:"mass",
  HubMass:"mass",  HubIner:"mass",  GenIner:"mass",
  NacMass:"mass",  NacYIner:"mass", YawBrMass:"mass",
  PtfmMass:"mass", PtfmRIner:"mass", PtfmPIner:"mass", PtfmYIner:"mass",
  DTTorSpr:"mass", DTTorDmp:"mass",
  TeetMod:"mass",  TeetDmpP:"mass", TeetDmp:"mass",  TeetCDmp:"mass",
  TeetSStP:"mass", TeetHStP:"mass", TeetSSSp:"mass", TeetHSSp:"mass",
  YawFrctMod:"mass", M_CSmax:"mass", M_FCSmax:"mass", M_MCSmax:"mass",
  M_CD:"mass",     M_FCD:"mass",    M_MCD:"mass",
  sig_v:"mass",    sig_v2:"mass",   OmgCut:"mass",
  // files
  BldNodes:"files", BldFile1:"files", BldFile2:"files", BldFile3:"files",
  TwrNodes:"files", TwrFile:"files",  Furling:"files",  FurlFile:"files",
  OutFile:"files",  OutFmt:"files",
  SumPrint:"files", TabDelim:"files", Echo:"files",
  NTwGages:"files", TwrGagNd:"files", NBlGages:"files", BldGagNd:"files",
  BldNd_BladesOut:"files", BldNd_BlOutNd:"files",
  Method:"files",   DT:"files",
};

// ── Tabs ─────────────────────────────────────────────────────────────────────
const TABS = [
  { id: "quick",    label: "Quick"         },
  { id: "geometry", label: "Geometry"      },
  { id: "dofs",     label: "DOFs"          },
  { id: "mass",     label: "Mass & Drive"  },
  { id: "files",    label: "Files & Output"},
];

const INTEGRATION_METHODS = [
  { v: 1, label: "1 — RK4"  },
  { v: 2, label: "2 — AB4"  },
  { v: 3, label: "3 — ABM4" },
];

// ── Defaults (NREL 5 MW Baseline values) ────────────────────────────────────
const DEFAULT = {
  // Simulation control
  Echo: false, Method: 3, DT: "default",

  // DOFs — blade
  FlapDOF1: true, FlapDOF2: true, EdgeDOF: true, TeetDOF: false,
  // DOFs — drivetrain / generator / yaw
  DrTrDOF: true, GenDOF: true, YawDOF: true,
  // DOFs — tower
  TwFADOF1: true, TwFADOF2: true, TwSSDOF1: true, TwSSDOF2: true,
  // DOFs — platform (offshore)
  PtfmSgDOF: false, PtfmSwDOF: false, PtfmHvDOF: false,
  PtfmRDOF:  false, PtfmPDOF:  false, PtfmYDOF:  false,

  // Initial conditions
  OoPDefl: 0, IPDefl: 0,
  BlPitch1: 0, BlPitch2: 0, BlPitch3: 0,
  TeetDefl: 0, Azimuth: 0, RotSpeed: 10.0, NacYaw: 0,
  TTDspFA: 0, TTDspSS: 0,
  PtfmSurge: 0, PtfmSway: 0, PtfmHeave: 0,
  PtfmRoll: 0, PtfmPitch: 0, PtfmYaw: 0,

  // Turbine configuration (NREL 5 MW)
  NumBl: 3,
  TipRad: 63.0, HubRad: 1.5,
  PreCone1: -2.5, PreCone2: -2.5, PreCone3: -2.5,
  HubCM: 0, UndSling: 0, Delta3: 0, AzimB1Up: 0,
  OverHang: -5.0191, ShftGagL: 1.912, ShftTilt: -5.0,
  NacCMxn: 1.9, NacCMyn: 0, NacCMzn: 1.75,
  NcIMUxn: -3.09528, NcIMUyn: 0, NcIMUzn: 2.23336,
  Twr2Shft: 1.96256, TowerHt: 87.6, TowerBsHt: 0,
  PtfmCMxt: 0, PtfmCMyt: 0, PtfmCMzt: 0, PtfmRefzt: 0,

  // Mass and inertia
  TipMass1: 0, TipMass2: 0, TipMass3: 0,
  HubMass: 56780, HubIner: 115926, GenIner: 534.116,
  NacMass: 240000, NacYIner: 2607890, YawBrMass: 0,
  PtfmMass: 0, PtfmRIner: 0, PtfmPIner: 0, PtfmYIner: 0,

  // Blade
  BldNodes: 17,
  BldFile1: "blade.dat", BldFile2: "blade.dat", BldFile3: "blade.dat",

  // Rotor-teeter
  TeetMod: 0, TeetDmpP: 0, TeetDmp: 0, TeetCDmp: 0,
  TeetSStP: 0, TeetHStP: 0, TeetSSSp: 0, TeetHSSp: 0,

  // Drivetrain
  GBoxEff: 100, GBRatio: 97.0,
  DTTorSpr: "8.67637E+08", DTTorDmp: "6.215E+06",

  // Furling
  Furling: false, FurlFile: "unused",

  // Tower
  TwrNodes: 20, TwrFile: "tower.dat",

  // Yaw friction (IEA 15 MW)
  YawFrctMod: 0, M_CSmax: 300, M_FCSmax: 0, M_MCSmax: 0,
  M_CD: 40, M_FCD: 0, M_MCD: 0,
  sig_v: 0, sig_v2: 0, OmgCut: 0,

  // Output
  SumPrint: false, OutFile: 1, TabDelim: true,
  OutFmt: "ES10.3E2", TStart: 30, DecFact: 1,
  NTwGages: 0, TwrGagNd: "",
  NBlGages: 0, BldGagNd: "",
  OutList: '"BldPitch1"\n"BldPitch2"\n"BldPitch3"\n"Azimuth"\n"RotSpeed"\n"GenSpeed"\n"NacYaw"\n"OoPDefl1"\n"IPDefl1"\n"TTDspFA"\n"TTDspSS"',

  // Blade-node outputs (IEA 15 MW)
  BldNd_BladesOut: 0, BldNd_BlOutNd: "All", NodeOutList: "",
};

// ── Shared robust key-value parser (handles multi-value lines like BldGagNd) ─
function parseDatLine(line) {
  if (!line || line.startsWith("!") || /^-{4,}/.test(line) || /^={4,}/.test(line)) return null;

  let rest = line.trim();
  let value;

  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    if (end < 0) return null;
    value = rest.slice(1, end);
    rest  = rest.slice(end + 1).trim();
  } else {
    // Multi-value aware: collect numeric / path / boolean tokens, stop at first identifier
    const tokens = rest.split(/\s+/).filter(t => t);
    const valueTokens = [];
    let keyIdx = -1;
    for (let j = 0; j < tokens.length; j++) {
      const t = tokens[j];
      // An identifier starts with a letter/underscore, is NOT a boolean/default,
      // and does NOT look like a filename (no dots or path separators)
      if (/^[A-Za-z_]/.test(t) && !/^(true|false|default)$/i.test(t) && !/[./\\]/.test(t)) {
        keyIdx = j; break;
      }
      valueTokens.push(t);
    }
    if (keyIdx < 0) return null;
    // Strip trailing commas from each token, join with ", "
    value = valueTokens.map(v => v.replace(/,+$/, "")).join(", ");
    rest  = tokens.slice(keyIdx).join(" ");
  }

  const keyMatch = rest.match(/^([A-Za-z_]\S*)/);
  if (!keyMatch) return null;
  return { key: keyMatch[1], value };
}

// ── ElastoDyn .dat parser ────────────────────────────────────────────────────
function parseElastoDynFile(content) {
  const kv  = {};
  const lines = content.split("\n");
  let inOutList    = false;
  let inNodeOut    = false;   // after the 2nd OutList (blade-node section)
  let endsSeen     = 0;
  const outListLines    = [];
  const nodeOutLines    = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (inNodeOut) {
      if (/^END\b/i.test(line)) { inNodeOut = false; continue; }
      const m = line.match(/^"([^"]+)"/);
      if (m) nodeOutLines.push(`"${m[1]}"`);
      continue;
    }

    if (inOutList) {
      if (/^END\b/i.test(line)) {
        inOutList = false;
        endsSeen++;
        continue;
      }
      const m = line.match(/^"([^"]+)"/);
      if (m) outListLines.push(`"${m[1]}"`);
      continue;
    }

    // Skip dividers / blanks
    if (!line || line.startsWith("!") || /^-{4,}/.test(line) || /^={4,}/.test(line)) continue;

    const parsed = parseDatLine(line);
    if (!parsed) continue;
    const { key, value } = parsed;
    const kl = key.toLowerCase();

    if (kl === "outlist") {
      if (endsSeen === 0) { inOutList = true; }
      else                { inNodeOut = true; }
      continue;
    }

    kv[key] = value;
  }

  if (outListLines.length) kv["__OutList__"]  = outListLines.join("\n");
  if (nodeOutLines.length) kv["__NodeOut__"]  = nodeOutLines.join("\n");
  return kv;
}

function elParsedToState(kv) {
  const st = { ...DEFAULT };

  const b = (v) => typeof v === "string" && v.toLowerCase() === "true";
  const n = (v) => v !== undefined && !isNaN(Number(v)) ? Number(v) : undefined;

  // Booleans
  for (const k of ["Echo","Furling","SumPrint","TabDelim",
      "FlapDOF1","FlapDOF2","EdgeDOF","TeetDOF","DrTrDOF","GenDOF","YawDOF",
      "TwFADOF1","TwFADOF2","TwSSDOF1","TwSSDOF2",
      "PtfmSgDOF","PtfmSwDOF","PtfmHvDOF","PtfmRDOF","PtfmPDOF","PtfmYDOF"]) {
    if (kv[k] !== undefined) st[k] = b(kv[k]);
  }

  // Numbers
  for (const k of [
    "Method","OoPDefl","IPDefl","TeetDefl","Azimuth","RotSpeed","NacYaw",
    "TTDspFA","TTDspSS","PtfmSurge","PtfmSway","PtfmHeave","PtfmRoll","PtfmPitch","PtfmYaw",
    "NumBl","TipRad","HubRad","HubCM","UndSling","Delta3","AzimB1Up",
    "OverHang","ShftGagL","ShftTilt","NacCMxn","NacCMyn","NacCMzn",
    "NcIMUxn","NcIMUyn","NcIMUzn","Twr2Shft","TowerHt","TowerBsHt",
    "PtfmCMxt","PtfmCMyt","PtfmCMzt","PtfmRefzt",
    "HubMass","HubIner","HubIner_Teeter","GenIner","NacMass","NacYIner","YawBrMass",
    "PtfmMass","PtfmRIner","PtfmPIner","PtfmYIner","PtfmXYIner","PtfmYZIner","PtfmXZIner",
    "BldNodes","TeetMod","TeetDmpP","TeetDmp","TeetCDmp","TeetSStP","TeetHStP","TeetSSSp","TeetHSSp",
    "GBoxEff","GBRatio","TwrNodes","OutFile","TStart","DecFact","NTwGages","NBlGages",
    "YawFrctMod","M_CSmax","M_FCSmax","M_MCSmax","M_CD","M_FCD","M_MCD","sig_v","sig_v2","OmgCut",
    "BldNd_BladesOut",
  ]) {
    const v = n(kv[k]); if (v !== undefined) st[k] = v;
  }

  // DT: may be "default" or a number string
  if (kv.DT !== undefined) st.DT = kv.DT === "default" ? "default" : kv.DT;

  // OutFmt: quoted string
  if (kv.OutFmt !== undefined) st.OutFmt = kv.OutFmt;

  // Strings
  if (kv.FurlFile)  st.FurlFile  = kv.FurlFile;
  if (kv.TwrFile)   st.TwrFile   = kv.TwrFile;
  if (kv.TwrGagNd)  st.TwrGagNd  = kv.TwrGagNd;
  if (kv.BldGagNd)  st.BldGagNd  = kv.BldGagNd;

  // Drivetrain spring/damper — store as strings to preserve scientific notation
  if (kv.DTTorSpr)  st.DTTorSpr  = kv.DTTorSpr;
  if (kv.DTTorDmp)  st.DTTorDmp  = kv.DTTorDmp;

  // Platform inertia can also be in sci-notation
  if (kv.NacYIner)  st.NacYIner  = n(kv.NacYIner) ?? st.NacYIner;
  if (kv.PtfmMass)  st.PtfmMass  = n(kv.PtfmMass) ?? st.PtfmMass;

  // Parenthesised keys → state fields (e.g. NREL 5 MW uses BldFile(1) style)
  const paren = {
    "BlPitch(1)":"BlPitch1","BlPitch(2)":"BlPitch2","BlPitch(3)":"BlPitch3",
    "PreCone(1)":"PreCone1","PreCone(2)":"PreCone2","PreCone(3)":"PreCone3",
    "TipMass(1)":"TipMass1","TipMass(2)":"TipMass2","TipMass(3)":"TipMass3",
    "BldFile(1)":"BldFile1","BldFile(2)":"BldFile2","BldFile(3)":"BldFile3",
  };
  for (const [fk, sk] of Object.entries(paren)) {
    if (kv[fk] !== undefined) {
      const v = n(kv[fk]);
      st[sk] = v !== undefined ? v : kv[fk];
    }
  }

  // Non-parenthesised variants (e.g. IEA 15 MW uses BldFile1/BldFile2/BldFile3 directly)
  for (const k of ["BlPitch1","BlPitch2","BlPitch3",
                   "PreCone1","PreCone2","PreCone3",
                   "TipMass1","TipMass2","TipMass3",
                   "BldFile1","BldFile2","BldFile3"]) {
    if (kv[k] !== undefined) {
      const v = n(kv[k]);
      st[k] = v !== undefined ? v : kv[k];
    }
  }

  if (kv.BldNd_BlOutNd !== undefined) st.BldNd_BlOutNd = kv.BldNd_BlOutNd;

  // OutList
  if (kv["__OutList__"]) st.OutList    = kv["__OutList__"];
  if (kv["__NodeOut__"]) st.NodeOutList = kv["__NodeOut__"];

  // Preserve the full raw kv so the builder can write back any params not shown in the UI
  st.__rawKV__ = { ...kv };

  return st;
}

// ── Build .dat content ───────────────────────────────────────────────────────
function buildElastoDynContent(p, description = "Generated by FlowUrja Studio") {
  const b  = v => v ? "True " : "False";
  const q  = v => `"${v}"`;
  const r  = (v, w = 14) => String(v).padStart(w);
  const pad = (v, n = 14) => String(v).padEnd(n);

  // gage node line: single value or comma-separated list, right-padded to 14 chars
  const gagLine = (count, val) => {
    if (!count) return "             0";
    const str = String(val || 0).trim();
    // If multi-value (contains comma or space), just pad the whole thing
    return str.includes(",") || str.includes(" ")
      ? str.padStart(Math.max(14, str.length))
      : r(str);
  };

  const outLines = (p.OutList || "")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l)
    .map(l => l.startsWith('"') ? l : `"${l}"`);

  const lines = [
    `------- ELASTODYN for OpenFAST INPUT FILE -------------------------------------------`,
    description,
    `---------------------- SIMULATION CONTROL --------------------------------------`,
    `${pad(b(p.Echo))} Echo        - Echo input data to "<RootName>.ech" (flag)`,
    `${r(p.Method)}   Method      - Integration method: {1: RK4, 2: AB4, or 3: ABM4} (-)`,
    `${pad(q(p.DT))} DT          - Integration time step (s)`,
    `---------------------- DEGREES OF FREEDOM --------------------------------------`,
    `${pad(b(p.FlapDOF1))} FlapDOF1    - First flapwise blade mode DOF (flag)`,
    `${pad(b(p.FlapDOF2))} FlapDOF2    - Second flapwise blade mode DOF (flag)`,
    `${pad(b(p.EdgeDOF))} EdgeDOF     - First edgewise blade mode DOF (flag)`,
    `${pad(b(p.TeetDOF))} TeetDOF     - Rotor-teeter DOF (flag) [unused for 3 blades]`,
    `${pad(b(p.DrTrDOF))} DrTrDOF     - Drivetrain rotational-flexibility DOF (flag)`,
    `${pad(b(p.GenDOF))} GenDOF      - Generator DOF (flag)`,
    `${pad(b(p.YawDOF))} YawDOF      - Yaw DOF (flag)`,
    `${pad(b(p.TwFADOF1))} TwFADOF1    - First fore-aft tower bending-mode DOF (flag)`,
    `${pad(b(p.TwFADOF2))} TwFADOF2    - Second fore-aft tower bending-mode DOF (flag)`,
    `${pad(b(p.TwSSDOF1))} TwSSDOF1    - First side-to-side tower bending-mode DOF (flag)`,
    `${pad(b(p.TwSSDOF2))} TwSSDOF2    - Second side-to-side tower bending-mode DOF (flag)`,
    `${pad(b(p.PtfmSgDOF))} PtfmSgDOF   - Platform horizontal surge translation DOF (flag)`,
    `${pad(b(p.PtfmSwDOF))} PtfmSwDOF   - Platform horizontal sway translation DOF (flag)`,
    `${pad(b(p.PtfmHvDOF))} PtfmHvDOF   - Platform vertical heave translation DOF (flag)`,
    `${pad(b(p.PtfmRDOF))} PtfmRDOF    - Platform roll tilt rotation DOF (flag)`,
    `${pad(b(p.PtfmPDOF))} PtfmPDOF    - Platform pitch tilt rotation DOF (flag)`,
    `${pad(b(p.PtfmYDOF))} PtfmYDOF    - Platform yaw rotation DOF (flag)`,
    `---------------------- INITIAL CONDITIONS --------------------------------------`,
    `${r(p.OoPDefl)}   OoPDefl     - Initial out-of-plane blade-tip displacement (meters)`,
    `${r(p.IPDefl)}   IPDefl      - Initial in-plane blade-tip deflection (meters)`,
    `${r(p.BlPitch1)}   BlPitch(1)  - Blade 1 initial pitch (degrees)`,
    `${r(p.BlPitch2)}   BlPitch(2)  - Blade 2 initial pitch (degrees)`,
    `${r(p.BlPitch3)}   BlPitch(3)  - Blade 3 initial pitch (degrees) [unused for 2 blades]`,
    `${r(p.TeetDefl)}   TeetDefl    - Initial or fixed teeter angle (degrees) [unused for 3 blades]`,
    `${r(p.Azimuth)}   Azimuth     - Initial azimuth angle for blade 1 (degrees)`,
    `${r(p.RotSpeed)}   RotSpeed    - Initial or fixed rotor speed (rpm)`,
    `${r(p.NacYaw)}   NacYaw      - Initial or fixed nacelle-yaw angle (degrees)`,
    `${r(p.TTDspFA)}   TTDspFA     - Initial fore-aft tower-top displacement (meters)`,
    `${r(p.TTDspSS)}   TTDspSS     - Initial side-to-side tower-top displacement (meters)`,
    `${r(p.PtfmSurge)}   PtfmSurge   - Initial or fixed horizontal surge displacement of platform (meters)`,
    `${r(p.PtfmSway)}   PtfmSway    - Initial or fixed horizontal sway displacement of platform (meters)`,
    `${r(p.PtfmHeave)}   PtfmHeave   - Initial or fixed vertical heave displacement of platform (meters)`,
    `${r(p.PtfmRoll)}   PtfmRoll    - Initial or fixed roll tilt displacement of platform (degrees)`,
    `${r(p.PtfmPitch)}   PtfmPitch   - Initial or fixed pitch tilt displacement of platform (degrees)`,
    `${r(p.PtfmYaw)}   PtfmYaw     - Initial or fixed yaw displacement of platform (degrees)`,
    `---------------------- TURBINE CONFIGURATION -----------------------------------`,
    `${r(p.NumBl)}   NumBl       - Number of blades (-)`,
    `${r(p.TipRad)}   TipRad      - The distance from the rotor apex to the blade tip (meters)`,
    `${r(p.HubRad)}   HubRad      - The distance from the rotor apex to the blade root (meters)`,
    `${r(p.PreCone1)}   PreCone(1)  - Blade 1 cone angle (degrees)`,
    `${r(p.PreCone2)}   PreCone(2)  - Blade 2 cone angle (degrees)`,
    `${r(p.PreCone3)}   PreCone(3)  - Blade 3 cone angle (degrees) [unused for 2 blades]`,
    `${r(p.HubCM)}   HubCM       - Distance from rotor apex to hub mass [positive downwind] (meters)`,
    `${r(p.UndSling)}   UndSling    - Undersling length (meters) [unused for 3 blades]`,
    `${r(p.Delta3)}   Delta3      - Delta-3 angle for teetering rotors (degrees) [unused for 3 blades]`,
    `${r(p.AzimB1Up)}   AzimB1Up    - Azimuth value to use for I/O when blade 1 points up (degrees)`,
    `${r(p.OverHang)}   OverHang    - Distance from yaw axis to rotor apex (meters)`,
    `${r(p.ShftGagL)}   ShftGagL    - Distance from rotor apex to shaft strain gages (meters)`,
    `${r(p.ShftTilt)}   ShftTilt    - Rotor shaft tilt angle (degrees)`,
    `${r(p.NacCMxn)}   NacCMxn     - Downwind distance from tower-top to nacelle CM (meters)`,
    `${r(p.NacCMyn)}   NacCMyn     - Lateral distance from tower-top to nacelle CM (meters)`,
    `${r(p.NacCMzn)}   NacCMzn     - Vertical distance from tower-top to nacelle CM (meters)`,
    `${r(p.NcIMUxn)}   NcIMUxn     - Downwind distance from tower-top to nacelle IMU (meters)`,
    `${r(p.NcIMUyn)}   NcIMUyn     - Lateral distance from tower-top to nacelle IMU (meters)`,
    `${r(p.NcIMUzn)}   NcIMUzn     - Vertical distance from tower-top to nacelle IMU (meters)`,
    `${r(p.Twr2Shft)}   Twr2Shft    - Vertical distance from tower-top to rotor shaft (meters)`,
    `${r(p.TowerHt)}   TowerHt     - Height of tower above ground level (meters)`,
    `${r(p.TowerBsHt)}   TowerBsHt   - Height of tower base above ground level (meters)`,
    `${r(p.PtfmCMxt)}   PtfmCMxt    - Downwind distance to the platform CM (meters)`,
    `${r(p.PtfmCMyt)}   PtfmCMyt    - Lateral distance to the platform CM (meters)`,
    `${r(p.PtfmCMzt)}   PtfmCMzt    - Vertical distance to the platform CM (meters)`,
    `${r(p.PtfmRefzt)}   PtfmRefzt   - Vertical distance to the platform reference point (meters)`,
    `---------------------- MASS AND INERTIA ----------------------------------------`,
    `${r(p.TipMass1)}   TipMass(1)  - Tip-brake mass, blade 1 (kg)`,
    `${r(p.TipMass2)}   TipMass(2)  - Tip-brake mass, blade 2 (kg)`,
    `${r(p.TipMass3)}   TipMass(3)  - Tip-brake mass, blade 3 (kg) [unused for 2 blades]`,
    `${r(p.HubMass)}   HubMass     - Hub mass (kg)`,
    `${r(p.HubIner)}   HubIner     - Hub inertia about rotor axis [3 blades] or teeter axis [2 blades] (kg m^2)`,
    `${r(p.HubIner_Teeter ?? 0)}   HubIner_Teeter - Hub inertia about teeter axis (2-blades) (kg m^2)`,
    `${r(p.GenIner)}   GenIner     - Generator inertia about HSS (kg m^2)`,
    `${r(p.NacMass)}   NacMass     - Nacelle mass (kg)`,
    `${r(p.NacYIner)}   NacYIner    - Nacelle inertia about yaw axis (kg m^2)`,
    `${r(p.YawBrMass)}   YawBrMass   - Yaw bearing mass (kg)`,
    `${r(p.PtfmMass)}   PtfmMass    - Platform mass (kg)`,
    `${r(p.PtfmRIner)}   PtfmRIner   - Platform roll inertia (kg m^2)`,
    `${r(p.PtfmPIner)}   PtfmPIner   - Platform pitch inertia (kg m^2)`,
    `${r(p.PtfmYIner)}   PtfmYIner   - Platform yaw inertia (kg m^2)`,
    `${r(p.PtfmXYIner ?? 0)}   PtfmXYIner  - Platform xy moment of inertia about the platform CM (=-int(xydm)) (kg m^2)`,
    `${r(p.PtfmYZIner ?? 0)}   PtfmYZIner  - Platform yz moment of inertia about the platform CM (=-int(yzdm)) (kg m^2)`,
    `${r(p.PtfmXZIner ?? 0)}   PtfmXZIner  - Platform xz moment of inertia about the platform CM (=-int(xzdm)) (kg m^2)`,
    `---------------------- BLADE ---------------------------------------------------`,
    `${r(p.BldNodes)}   BldNodes    - Number of blade nodes (per blade) used for analysis (-)`,
    `${pad(q(p.BldFile1))} BldFile(1)  - Name of file containing properties for blade 1 (quoted string)`,
    `${pad(q(p.BldFile2))} BldFile(2)  - Name of file containing properties for blade 2 (quoted string)`,
    `${pad(q(p.BldFile3))} BldFile(3)  - Name of file containing properties for blade 3 (quoted string) [unused for 2 blades]`,
    `---------------------- ROTOR-TEETER --------------------------------------------`,
    `${r(p.TeetMod)}   TeetMod     - Rotor-teeter spring/damper model {0: none, 1: standard, 2: user-defined} (switch) [unused for 3 blades]`,
    `${r(p.TeetDmpP)}   TeetDmpP    - Rotor-teeter damper position (degrees)`,
    `${r(p.TeetDmp)}   TeetDmp     - Rotor-teeter damping constant (N-m/(rad/s))`,
    `${r(p.TeetCDmp)}   TeetCDmp    - Rotor-teeter Coulomb-damping moment (N-m)`,
    `${r(p.TeetSStP)}   TeetSStP    - Rotor-teeter soft-stop position (degrees)`,
    `${r(p.TeetHStP)}   TeetHStP    - Rotor-teeter hard-stop position (degrees)`,
    `${r(p.TeetSSSp)}   TeetSSSp    - Rotor-teeter soft-stop spring constant (N-m/rad)`,
    `${r(p.TeetHSSp)}   TeetHSSp    - Rotor-teeter hard-stop spring constant (N-m/rad)`,
    `---------------------- YAW-FRICTION --------------------------------------------`,
    `${r(p.YawFrctMod ?? 0)}   YawFrctMod  - Yaw-friction model {0: none, 1: friction independent of loads, 2: Coulomb terms, 3: user defined} (switch)`,
    `${r(p.M_CSmax ?? 300)}   M_CSmax     - Maximum static Coulomb friction torque (N-m)`,
    `${r(p.M_FCSmax ?? 0)}   M_FCSmax    - Maximum static Coulomb friction torque proportional to yaw bearing shear force (N-m)`,
    `${r(p.M_MCSmax ?? 0)}   M_MCSmax    - Maximum static Coulomb friction torque proportional to yaw bearing bending moment (N-m)`,
    `${r(p.M_CD ?? 40)}   M_CD        - Dynamic Coulomb friction moment (N-m)`,
    `${r(p.M_FCD ?? 0)}   M_FCD       - Dynamic Coulomb friction moment proportional to yaw bearing shear force (N-m)`,
    `${r(p.M_MCD ?? 0)}   M_MCD       - Dynamic Coulomb friction moment proportional to yaw bearing bending moment (N-m)`,
    `${r(p.sig_v ?? 0)}   sig_v       - Linear viscous friction coefficient (N-m/(rad/s))`,
    `${r(p.sig_v2 ?? 0)}   sig_v2      - Quadratic viscous friction coefficient (N-m/(rad/s)^2)`,
    `${r(p.OmgCut ?? 0)}   OmgCut      - Yaw angular velocity cutoff below which viscous friction is linearized (rad/s)`,
    `---------------------- DRIVETRAIN ----------------------------------------------`,
    `${r(p.GBoxEff)}   GBoxEff     - Gearbox efficiency (%)`,
    `${r(p.GBRatio)}   GBRatio     - Gearbox ratio (-)`,
    `${r(p.DTTorSpr)}   DTTorSpr    - Drivetrain torsional spring (N-m/rad)`,
    `${r(p.DTTorDmp)}   DTTorDmp    - Drivetrain torsional damper (N-m/(rad/s))`,
    `---------------------- FURLING -------------------------------------------------`,
    `${pad(b(p.Furling))} Furling     - Read in additional model properties for furling turbine (flag) [must currently be FALSE)`,
    `${pad(q(p.FurlFile))} FurlFile    - Name of file containing furling properties (quoted string) [unused when Furling=False]`,
    `---------------------- TOWER ---------------------------------------------------`,
    `${r(p.TwrNodes)}   TwrNodes    - Number of tower nodes used for analysis (-)`,
    `${pad(q(p.TwrFile))} TwrFile     - Name of file containing tower properties (quoted string)`,
    `---------------------- OUTPUT --------------------------------------------------`,
    `${pad(b(p.SumPrint))} SumPrint    - Print summary data to "<RootName>.sum" (flag)`,
    `${r(p.OutFile)}   OutFile     - Switch to determine where output will be placed: {1: module; 2: glue code; 3: both} (-)`,
    `${pad(b(p.TabDelim))} TabDelim    - Use tab delimiters in text tabular output file? (flag)`,
    `${pad(q(p.OutFmt))} OutFmt      - Format used for text tabular output`,
    `${r(p.TStart)}   TStart      - Time to begin tabular output (s)`,
    `${r(p.DecFact)}   DecFact     - Decimation factor for tabular output {1: every time step} (-)`,
    `${r(p.NTwGages)}   NTwGages    - Number of tower nodes with strain gages [0 to 9] (-)`,
    `${gagLine(p.NTwGages, p.TwrGagNd)}   TwrGagNd    - List of tower gauge nodes [unused if NTwGages=0]`,
    `${r(p.NBlGages)}   NBlGages    - Number of blade nodes with strain gages [0 to 9] (-)`,
    `${gagLine(p.NBlGages, p.BldGagNd)}   BldGagNd    - List of blade gauge nodes [unused if NBlGages=0]`,
    `              OutList     - The next line(s) contains a list of output parameters.`,
    ...outLines,
    `END of input file (the word "END" must appear in the first 3 columns of this last OutList line)`,
    `---------------------- NODE OUTPUTS --------------------------------------------`,
    `${r(p.BldNd_BladesOut ?? 0)}   BldNd_BladesOut  - Blades to output all node information at`,
    `${pad(q(p.BldNd_BlOutNd || "All"))} BldNd_BlOutNd   - Blade nodes on each blade`,
    `              OutList     - The next line(s) contains a list of output parameters.`,
    ...(p.NodeOutList || "").split("\n").map(l => l.trim()).filter(l => l).map(l => l.startsWith('"') ? l : `"${l}"`),
    `END of input file (the word "END" must appear in the first 3 columns of this last OutList line)`,
    `---------------------------------------------------------------------------------------`,
  ];

  // ── Passthrough: write back any params from the original file not shown in the UI ──
  const WRITTEN_ED = new Set([
    "Echo","Method","DT",
    "FlapDOF1","FlapDOF2","EdgeDOF","TeetDOF","DrTrDOF","GenDOF","YawDOF",
    "TwFADOF1","TwFADOF2","TwSSDOF1","TwSSDOF2",
    "PtfmSgDOF","PtfmSwDOF","PtfmHvDOF","PtfmRDOF","PtfmPDOF","PtfmYDOF",
    "OoPDefl","IPDefl","BlPitch(1)","BlPitch(2)","BlPitch(3)","TeetDefl",
    "Azimuth","RotSpeed","NacYaw","TTDspFA","TTDspSS",
    "PtfmSurge","PtfmSway","PtfmHeave","PtfmRoll","PtfmPitch","PtfmYaw",
    "NumBl","TipRad","HubRad","PreCone(1)","PreCone(2)","PreCone(3)",
    "HubCM","UndSling","Delta3","AzimB1Up","OverHang","ShftGagL","ShftTilt",
    "NacCMxn","NacCMyn","NacCMzn","NcIMUxn","NcIMUyn","NcIMUzn",
    "Twr2Shft","TowerHt","TowerBsHt","PtfmCMxt","PtfmCMyt","PtfmCMzt","PtfmRefzt",
    "TipMass(1)","TipMass(2)","TipMass(3)",
    "HubMass","HubIner","HubIner_Teeter","GenIner","NacMass","NacYIner","YawBrMass",
    "PtfmMass","PtfmRIner","PtfmPIner","PtfmYIner","PtfmXYIner","PtfmYZIner","PtfmXZIner",
    "BldNodes","BldFile(1)","BldFile(2)","BldFile(3)",
    "TeetMod","TeetDmpP","TeetDmp","TeetCDmp","TeetSStP","TeetHStP","TeetSSSp","TeetHSSp",
    "YawFrctMod","M_CSmax","M_FCSmax","M_MCSmax","M_CD","M_FCD","M_MCD","sig_v","sig_v2","OmgCut",
    "GBoxEff","GBRatio","DTTorSpr","DTTorDmp",
    "Furling","FurlFile","TwrNodes","TwrFile",
    "SumPrint","OutFile","TabDelim","OutFmt","TStart","DecFact",
    "NTwGages","TwrGagNd","NBlGages","BldGagNd","OutList",
    "BldNd_BladesOut","BldNd_BlOutNd","NodeOutList",
    // non-paren variants (IEA-style files use these directly)
    "BlPitch1","BlPitch2","BlPitch3","PreCone1","PreCone2","PreCone3",
    "TipMass1","TipMass2","TipMass3","BldFile1","BldFile2","BldFile3",
  ]);
  const rawED = p.__rawKV__ || {};
  const passED = Object.entries(rawED)
    .filter(([k]) => !WRITTEN_ED.has(k) && !k.startsWith("__"))
    .map(([k, v]) => `${String(v).padEnd(14)} ${k}`);
  if (passED.length) {
    lines.push(
      "!--- Parameters not editable in this UI (preserved verbatim from original file) ---",
      ...passED,
    );
  }
  return lines.join("\n");
}

// ── Sub-components ────────────────────────────────────────────────────────────
function SectionHead({ children }) {
  return <p className={s.sectionHead}>{children}</p>;
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return createPortal(
    <div
      ref={popRef}
      style={{
        position: "fixed", top, left, zIndex: 99998, width: W,
        background: "var(--bg-popover, rgba(255,255,255,0.82))",
        WebkitBackdropFilter: "blur(20px) saturate(1.8)",
        backdropFilter: "blur(20px) saturate(1.8)",
        border: "0.5px solid var(--bd-popover, rgba(0,0,0,0.10))",
        borderRadius: 10,
        padding: "10px 12px",
        boxShadow: "0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.10)",
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        fontSize: 12, lineHeight: 1.5,
        color: "var(--tx-2)",
        pointerEvents: "none",
      }}
    >
      {text}
    </div>,
    document.body,
  );
}

function Field({ label, unit, children, hint, info, fieldKey, disabledHint }) {
  const missingSet = useContext(MissingCtx);
  const fieldRef   = useRef(null);
  const [hintRect, setHintRect] = useState(null);
  // Auto-extract key from "(KeyName)" at end of label when no explicit fieldKey given
  const key = fieldKey || label.match(/\(([A-Za-z_][A-Za-z_0-9]*)\)\s*$/)?.[1];
  const isMissing = key && missingSet.size > 0 && missingSet.has(key);

  const showHint = () => {
    if (disabledHint && fieldRef.current)
      setHintRect(fieldRef.current.getBoundingClientRect());
  };

  return (
    <div
      ref={fieldRef}
      className={`${s.field} ${disabledHint ? s.fieldDisabled : ""}`}
      onMouseEnter={showHint}
      onMouseLeave={() => setHintRect(null)}
    >
      <div className={s.fieldHeader}>
        <label className={s.fieldLabel}>
          {label}{unit && <span className={s.unit}> {unit}</span>}
        </label>
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
      {disabledHint && hintRect && (
        <DisabledHintPortal text={disabledHint} rect={hintRect} />
      )}
    </div>
  );
}

function Toggle({ label, value, onChange, note }) {
  return (
    <div className={s.toggleRow}>
      <button
        className={`${s.toggle} ${value ? s.on : ""}`}
        onClick={() => onChange(!value)}
      >
        <span className={s.toggleThumb} />
      </button>
      <span className={s.toggleLabel}>{label}</span>
      {note && <span className={s.toggleNote}>{note}</span>}
    </div>
  );
}

function DofGroup({ title, children }) {
  return (
    <div className={s.dofGroup}>
      <div className={s.dofGroupTitle}>{title}</div>
      {children}
    </div>
  );
}

function Collapsible({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
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

// Triple blade input (PreCone, BlPitch, etc.) with sync-lock toggle
function BladeTriple({ label, unit, keys, p, setP, allowText = false }) {
  const [synced, setSynced] = useState(
    p[keys[0]] === p[keys[1]] && p[keys[1]] === p[keys[2]]
  );

  const handleChange = (idx, val) => {
    const parsed = allowText ? val : (val === "" ? "" : Number(val));
    if (synced && idx === 0) {
      setP(prev => ({ ...prev, [keys[0]]: parsed, [keys[1]]: parsed, [keys[2]]: parsed }));
    } else {
      setP(prev => ({ ...prev, [keys[idx]]: parsed }));
    }
  };

  return (
    <div className={s.field}>
      <div className={s.fieldHeader}>
        <label className={s.fieldLabel}>
          {label}{unit && <span className={s.unit}> {unit}</span>}
        </label>
        <button
          className={`${s.syncBtn} ${synced ? s.synced : ""}`}
          onClick={() => setSynced(v => !v)}
          title={synced ? "Click to edit blades independently" : "Click to sync all blades"}
        >
          {synced ? <Link size={10} strokeWidth={2} /> : <Unlink size={10} strokeWidth={2} />}
          {synced ? "linked" : "free"}
        </button>
      </div>
      <div className={s.bladeRow}>
        {keys.map((k, i) => (
          <div key={k} className={s.bladeCell}>
            <span className={s.bladeIdx}>Blade {i + 1}</span>
            <input
              type={allowText ? "text" : "number"}
              value={p[k]}
              step={0.1}
              onChange={e => handleChange(i, e.target.value)}
              disabled={synced && i > 0}
              style={{ opacity: synced && i > 0 ? 0.45 : 1 }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// Triple file browse (BldFile)
function FileTriple({ label, keys, p, setP }) {
  const [synced, setSynced] = useState(
    p[keys[0]] === p[keys[1]] && p[keys[1]] === p[keys[2]]
  );

  const handleChange = (idx, val) => {
    if (synced && idx === 0) {
      setP(prev => ({ ...prev, [keys[0]]: val, [keys[1]]: val, [keys[2]]: val }));
    } else {
      setP(prev => ({ ...prev, [keys[idx]]: val }));
    }
  };

  const handleBrowse = async (idx) => {
    try {
      const f = await openDialog({ multiple: false, directory: false });
      if (f) handleChange(idx, f);
    } catch {}
  };

  return (
    <div className={s.field}>
      <div className={s.fieldHeader}>
        <label className={s.fieldLabel}>{label}</label>
        <button
          className={`${s.syncBtn} ${synced ? s.synced : ""}`}
          onClick={() => setSynced(v => !v)}
        >
          {synced ? <Link size={10} strokeWidth={2} /> : <Unlink size={10} strokeWidth={2} />}
          {synced ? "linked" : "free"}
        </button>
      </div>
      {keys.map((k, i) => (
        <div key={k} className={s.fileRow} style={{ marginBottom: i < keys.length - 1 ? 6 : 0 }}>
          <span className={s.bladeIdx} style={{ width: 54, flexShrink: 0 }}>Blade {i + 1}</span>
          <input
            type="text"
            value={p[k]}
            onChange={e => handleChange(i, e.target.value)}
            disabled={synced && i > 0}
            style={{ opacity: synced && i > 0 ? 0.45 : 1 }}
          />
          {(!synced || i === 0) && (
            <button className={s.browseBtn} onClick={() => handleBrowse(i)}>
              <FolderOpen size={12} strokeWidth={1.8} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// Turbine schematic SVG — matches TurbSim panel proportions (viewBox 0 0 100 110, height 180)
function TurbineSchematic({ tipRad, towerHt, twr2Shft, rotSpeed }) {
  const c = "#7F77DD";
  const hubHt = (towerHt || 0) + (twr2Shft || 0);
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
      {/* Blades — one up, two down at 120° */}
      <line x1="50" y1="48" x2="50" y2="14" stroke={c} strokeWidth="3" strokeLinecap="round"/>
      <line x1="47" y1="55" x2="18" y2="73" stroke={c} strokeWidth="3" strokeLinecap="round"/>
      <line x1="53" y1="55" x2="82" y2="73" stroke={c} strokeWidth="3" strokeLinecap="round"/>
      {/* Rotor radius dashed line + label */}
      <line x1="50" y1="14" x2="82" y2="14"
        stroke={c} strokeWidth="0.5" strokeDasharray="2,2"/>
      <text x="84" y="17" fontSize="6"
        style={{ fill: "var(--tx-4)" }} fontFamily="-apple-system,sans-serif">
        {(tipRad || 0).toFixed(0)}m
      </text>
      {/* Hub height label */}
      <text x="55" y="79" fontSize="7"
        style={{ fill: "var(--tx-3)" }} fontFamily="-apple-system,sans-serif">
        {hubHt.toFixed(0)}m
      </text>
      {/* RPM */}
      <text x="4" y="100" fontSize="6"
        style={{ fill: c }} fontFamily="-apple-system,sans-serif">
        {(rotSpeed || 0)} rpm
      </text>
    </svg>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function ElastoDynPanel({ onLog, project, filePathFromProject, onDirtyChange, onRegisterSave, simRunning = false }) {
  const [tab,      setTab]      = useState("quick");
  const tabDirRef = useRef(1);
  const [p,        _setP]       = useState(DEFAULT);
  const [filePath, setFilePath] = useState("");
  const [isDirtyFlag, setIsDirtyFlag] = useState(false);
  const [showRaw,          setShowRaw]          = useState(false);
  const [showOutVarModal,  setShowOutVarModal]  = useState(false);
  const [showNodeVarModal, setShowNodeVarModal] = useState(false);
  const [rawContent, setRawContent] = useState("");

  // Ref holds a JSON snapshot of the last loaded/saved state.
  // Using a ref (not state) means the snapshot is updated synchronously —
  // no batching race between setP and the snapshot update.
  const originalRef = useRef(null);

  // All user-driven field changes go through this wrapper.
  // It sets isDirtyFlag=true which triggers a re-render, at which point
  // isDirty is re-evaluated against the up-to-date p and originalRef.
  const setP = useCallback((updater) => {
    _setP(updater);
    setIsDirtyFlag(true);
  }, []);

  // isDirty requires ALL of:
  //   1. a file is open
  //   2. the user has touched at least one field (isDirtyFlag)
  //   3. a snapshot exists AND the current state actually differs from it
  //
  // Condition 3 acts as a double-guard:
  //   • if the ref is null (snapshot not yet written — file still loading) → NOT dirty
  //   • if p already matches the snapshot (load batching race, or user reverted) → NOT dirty
  // This means a brief isDirtyFlag=true during file loading can never produce a false positive.
  const isDirty = !!filePath && isDirtyFlag &&
    originalRef.current !== null && JSON.stringify(p) !== originalRef.current;

  // Detect UI fields that have no counterpart in the loaded file (showing defaults)
  const missingFields = useMemo(() => {
    if (!filePath || !p.__rawKV__) return [];
    const rawKeys = new Set(Object.keys(p.__rawKV__));
    // Normalise paren keys so BldFile(1) also covers BldFile1
    for (const k of [...rawKeys]) {
      const m = k.match(/^([A-Za-z_]+)\((\d+)\)$/);
      if (m) rawKeys.add(`${m[1]}${m[2]}`);
    }
    return Object.keys(DEFAULT).filter(k => {
      if (k.startsWith("__")) return false;
      // Skip fields with no UI representation
      if (NO_UI_FIELDS.has(k)) return false;
      // Skip multiline text blocks (OutList etc.)
      if (typeof DEFAULT[k] === "string" && DEFAULT[k].includes("\n")) return false;
      return !rawKeys.has(k);
    });
  }, [filePath, p.__rawKV__]);

  // Revert detection: if the user touched something (isDirtyFlag) but the current
  // state now matches the saved snapshot exactly, clear the flag automatically.
  // Runs asynchronously after render so it never blocks or races with state updates.
  useEffect(() => {
    if (!isDirtyFlag || originalRef.current === null) return;
    if (JSON.stringify(p) === originalRef.current) {
      setIsDirtyFlag(false);
    }
  }, [p, isDirtyFlag]); // eslint-disable-line react-hooks/exhaustive-deps

  // Helpers
  const set  = k => v  => setP(prev => ({ ...prev, [k]: v }));
  const setN = k => e  => setP(prev => ({ ...prev, [k]: Number(e.target.value) }));
  const setE = k => e  => setP(prev => ({ ...prev, [k]: e.target.value }));
  const setS = k => v  => setP(prev => ({ ...prev, [k]: v }));

  // Load a .dat file.
  // Snapshot is written to a ref (synchronous) so there's no batching race.
  // setIsDirtyFlag(false) fires last, triggering a single clean re-render.
  const loadFile = async (path) => {
    try {
      const content = await invoke("read_text_file", { path });
      const kv      = parseElastoDynFile(content);
      const newState = elParsedToState(kv);
      originalRef.current = JSON.stringify(newState); // synchronous — no race
      _setP(newState);
      setIsDirtyFlag(false);
      onLog?.("ok", `Loaded ${path.split("/").pop()}`);
    } catch (err) {
      onLog?.("error", `Could not read ${path}: ${String(err)}`);
    }
  };

  const handleOpen = async () => {
    try {
      const f = await openDialog({
        multiple: false, directory: false,
        filters: [{ name: "ElastoDyn input", extensions: ["dat"] }],
      });
      if (!f) return;
      setFilePath(f);
      await loadFile(f);
    } catch {}
  };

  const handleSave = useCallback(async () => {
    if (simRunning) { onLog?.("warn", "⚠ OpenFAST is running — save blocked to protect the active simulation."); return; }
    if (!filePath) { onLog?.("warn", "No file path set — use Open to load a file first."); return; }
    const content = buildElastoDynContent(p);
    try {
      await invoke("write_text_file", { path: filePath, content });
      originalRef.current = JSON.stringify(p); // advance snapshot to what was written
      setIsDirtyFlag(false);
      onLog?.("ok", `Saved ${filePath.split("/").pop()}`);
    } catch (err) {
      onLog?.("error", `Save failed: ${String(err)}`);
    }
  }, [filePath, p]);

  const handleSaveAs = async () => {
    const content = buildElastoDynContent(p);
    try {
      const f = await openDialog({ multiple: false, directory: false });
      if (!f) return;
      const outPath = f.endsWith(".dat") ? f : f + ".dat";
      await invoke("write_text_file", { path: outPath, content });
      originalRef.current = JSON.stringify(p);
      setFilePath(outPath);
      setIsDirtyFlag(false);
      onLog?.("ok", `Saved → ${outPath}`);
    } catch (err) {
      onLog?.("error", `Save as failed: ${String(err)}`);
    }
  };

  const handleViewRaw = async () => {
    if (!filePath) {
      onLog?.("warn", "Load or save the ElastoDyn file first — then View will show the actual file on disk.");
      return;
    }
    try {
      const content = await invoke("read_text_file", { path: filePath });
      setRawContent(content);
      setShowRaw(true);
    } catch (err) {
      onLog?.("error", `Cannot read file: ${err}`);
    }
  };

  // Cmd+S to save
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); handleSave(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  // ── Project integration effects ────────────────────────────────────────────
  // Auto-load when App.jsx detects this panel's file from an imported .fst.
  // loadFile omitted from deps — only re-trigger when the path itself changes.
  useEffect(() => {
    if (!filePathFromProject) return;
    setFilePath(filePathFromProject);
    loadFile(filePathFromProject);
  }, [filePathFromProject]); // eslint-disable-line react-hooks/exhaustive-deps

  // Propagate dirty state up.
  // onDirtyChange omitted from deps — stable (useCallback in App.jsx) to avoid render loops.
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty]); // eslint-disable-line react-hooks/exhaustive-deps

  // Register the current save function so App.jsx can call it from the dialog.
  // onRegisterSave omitted — stable by construction.
  useEffect(() => {
    onRegisterSave?.(handleSave);
  }, [handleSave]); // eslint-disable-line react-hooks/exhaustive-deps

  const displayPath = filePath
    ? filePath.replace(/\\/g, "/").split("/").slice(-3).join("/")
    : "";

  const hubHt = (p.TowerHt || 0) + (p.Twr2Shft || 0);
  const rotorDia = 2 * (p.TipRad || 0);

  return (
    <div className={s.panel}>

      {/* ── Header ────────────────────────────────────────── */}
      <div className={s.header}>
        <Activity size={16} strokeWidth={1.8} style={{ color: ACCENT }} />
        <h1 className={s.title}>ElastoDyn</h1>
        <span className={s.desc}>Structural dynamics</span>
        <span className={s.badge}>sub-module</span>
        <div style={{ flex: 1 }} />
        <button className={`${s.headerBtn} ${s.headerBtnPrimary}`} onClick={handleOpen} type="button">
          <FolderOpen size={12} strokeWidth={1.8} /> Open .dat
        </button>
        <button className={`${s.headerBtn} ${s.headerBtnSecondary}`} onClick={handleViewRaw} type="button">
          <Eye size={12} strokeWidth={1.8} /> View .dat
        </button>
      </div>

      {/* ── File bar ──────────────────────────────────────── */}
      <div className={[s.fileBar, filePath ? s.fileBarLoaded : ""].join(" ")}>
        <span className={`${s.filePath} ${filePath ? s.filePathSet : ""}`}>
          {filePath ? displayPath : "No file open — click Open .dat or drag a file"}
        </span>
        <span className={s.dirtyDot} style={{ opacity: isDirty ? 1 : 0 }} title="Unsaved changes" />
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

      {showRaw && (
        <RawFileModal
          content={rawContent}
          filename={filePath ? filePath.split("/").pop() : "ElastoDyn.dat"}
          fromDisk={!!filePath}
          hasDirtyWarning={isDirty}
          filePath={filePath}
          onSaved={(newContent) => { setRawContent(newContent); loadFile(filePath); }}
          onClose={() => setShowRaw(false)}
        />
      )}

      {/* ── Tab bar ────────────────────────────────────────── */}
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

      {/* ── Content ────────────────────────────────────────── */}
      <div className={s.contentRow}>
        <div className={s.formArea}>
        <MissingCtx.Provider value={new Set(missingFields)}>

          {/* ── Quick Access tab ──────────────────────────── */}
          {tab === "quick" && (
            <div className={`${s.form} ${s.tabEnterFirst}`}>
              <div className={s.callout}>
                Most-used parameters for day-to-day simulations — full control on other tabs.
              </div>

              <SectionHead>Initial Conditions</SectionHead>
              <div className={s.grid2}>
                <Field label="Rotor speed (RotSpeed)" unit="rpm"
                  info={{ param: "RotSpeed", desc: "Initial or fixed rotor speed for the simulation.", range: "≥ 0 rpm", default: "12.1 (NREL 5 MW) · 7.56 (IEA 15 MW)", unit: "rpm", note: "For power-production DLCs this should match rated rotor speed; for parked/idling set near 0." }}>
                  <input type="number" value={p.RotSpeed} step={0.1} min={0}
                    onChange={setN("RotSpeed")} />
                </Field>
                <Field label="Nacelle yaw (NacYaw)" unit="°"
                  info={{ param: "NacYaw", desc: "Initial or fixed nacelle-yaw angle. Zero = rotor aligned with wind direction.", range: "−180 to 180°", default: "0", unit: "degrees" }}>
                  <input type="number" value={p.NacYaw} step={1} onChange={setN("NacYaw")} />
                </Field>
                <Field label="Initial azimuth (Azimuth)" unit="°"
                  info={{ param: "Azimuth", desc: "Initial azimuth angle for blade 1. Blade 1 points straight up when Azimuth = 0°.", range: "0–360°", default: "0", unit: "degrees" }}>
                  <input type="number" value={p.Azimuth} step={1} min={0} max={360}
                    onChange={setN("Azimuth")} />
                </Field>
              </div>
              <BladeTriple
                label="Initial blade pitch (BlPitch)" unit="°"
                keys={["BlPitch1","BlPitch2","BlPitch3"]}
                p={p} setP={setP}
              />

              <div style={{ marginBottom: 18 }} />
              <SectionHead>Key DOFs</SectionHead>
              <div className={s.dofGroup}>
                <div className={s.toggleGrid}>
                  <Toggle label="GenDOF — generator speed DOF"
                    value={p.GenDOF} onChange={set("GenDOF")}
                    note={p.GenDOF ? "free" : "locked"} />
                  <Toggle label="DrTrDOF — drivetrain rotational flexibility"
                    value={p.DrTrDOF} onChange={set("DrTrDOF")}
                    note="disabled for direct-drive (GBRatio=1)" />
                  <Toggle label="YawDOF — nacelle yaw"
                    value={p.YawDOF} onChange={set("YawDOF")} />
                  <Toggle label="FlapDOF1/2, EdgeDOF — blade modes"
                    value={p.FlapDOF1 && p.FlapDOF2 && p.EdgeDOF}
                    onChange={v => setP(prev => ({
                      ...prev, FlapDOF1:v, FlapDOF2:v, EdgeDOF:v
                    }))}
                    note="all blade modes together" />
                </div>
              </div>

              <SectionHead>Drivetrain</SectionHead>
              <div className={s.grid2}>
                <Field label="Gearbox ratio (GBRatio)"
                  info={{ param: "GBRatio", desc: "Gearbox ratio (HSS speed ÷ LSS speed). Set to 1.0 for direct-drive turbines — there is no gearbox.", range: "≥ 1.0", default: "97.0 (NREL 5 MW) · 1.0 (IEA 15 MW)", note: "For direct-drive, also set DrTrDOF = False since there is no torsional shaft flexibility." }}>
                  <input type="number" value={p.GBRatio} step={0.1} min={1}
                    onChange={setN("GBRatio")} />
                </Field>
                <Field label="Gearbox efficiency (GBoxEff)" unit="%"
                  info={{ param: "GBoxEff", desc: "Mechanical efficiency of the gearbox (%). Power lost as heat = (1 − GBoxEff/100) × shaft power.", range: "0–100 %", default: "100 (NREL 5 MW uses 100; real gearboxes 96–99%)", unit: "%" }}>
                  <input type="number" value={p.GBoxEff} step={0.1} min={0} max={100}
                    onChange={setN("GBoxEff")} />
                </Field>
              </div>

              <SectionHead>Output Timing</SectionHead>
              <div className={s.grid2}>
                <Field label="Output start time (TStart)" unit="s"
                  info={{ param: "TStart", desc: "Time to begin writing tabular output. Data before this time is simulated but not saved, allowing transients to decay.", range: "≥ 0 s", default: "30", unit: "s", note: "Typical values: 30–100 s for turbulent-wind DLCs, 0 for fault/emergency simulations." }}>
                  <input type="number" value={p.TStart} step={10} min={0}
                    onChange={setN("TStart")} />
                </Field>
                <Field label="Decimation factor (DecFact)"
                  info={{ param: "DecFact", desc: "Output is written every DecFact time steps. DecFact = 1 writes every step (largest files). Increase to reduce output size.", range: "≥ 1 (integer)", default: "1", note: "DecFact = 10 with DT = 0.01 s → effective output rate = 10 Hz." }}>
                  <input type="number" value={p.DecFact} step={1} min={1}
                    onChange={setN("DecFact")} />
                </Field>
              </div>
            </div>
          )}

          {/* ── Geometry tab ──────────────────────────────── */}
          {tab === "geometry" && (
            <div className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
              <SectionHead>Rotor</SectionHead>
              <div className={s.grid2}>
                <Field label="Number of blades (NumBl)">
                  <select value={p.NumBl} onChange={setN("NumBl")}>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                  </select>
                </Field>
                <Field label="Tip radius (TipRad)" unit="m">
                  <input type="number" value={p.TipRad} step={0.5} min={1} onChange={setN("TipRad")} />
                </Field>
                <Field label="Hub radius (HubRad)" unit="m">
                  <input type="number" value={p.HubRad} step={0.1} min={0} onChange={setN("HubRad")} />
                </Field>
              </div>

              <BladeTriple
                label="Precone angle (PreCone)" unit="°"
                keys={["PreCone1","PreCone2","PreCone3"]}
                p={p} setP={setP}
              />

              <div style={{ marginBottom: 22 }} />
              <SectionHead>Shaft & Nacelle</SectionHead>
              <div className={s.grid2}>
                <Field label="Shaft overhang (OverHang)" unit="m"
                  hint="Negative = upwind rotor (conventional)">
                  <input type="number" value={p.OverHang} step={0.1} onChange={setN("OverHang")} />
                </Field>
                <Field label="Shaft tilt (ShftTilt)" unit="°">
                  <input type="number" value={p.ShftTilt} step={0.5} onChange={setN("ShftTilt")} />
                </Field>
                <Field label="Tower-top to shaft (Twr2Shft)" unit="m">
                  <input type="number" value={p.Twr2Shft} step={0.01} min={0} onChange={setN("Twr2Shft")} />
                </Field>
                <Field label="Shaft gage location (ShftGagL)" unit="m">
                  <input type="number" value={p.ShftGagL} step={0.1} onChange={setN("ShftGagL")} />
                </Field>
              </div>

              <SectionHead>Tower</SectionHead>
              <div className={s.grid2}>
                <Field label="Tower height (TowerHt)" unit="m">
                  <input type="number" value={p.TowerHt} step={1} min={1} onChange={setN("TowerHt")} />
                </Field>
                <Field label="Tower base height (TowerBsHt)" unit="m">
                  <input type="number" value={p.TowerBsHt} step={0.5} onChange={setN("TowerBsHt")} />
                </Field>
              </div>

              <Collapsible title="Nacelle CM & IMU offsets">
                <div className={s.grid2}>
                  <Field label="NacCMxn — downwind" unit="m">
                    <input type="number" value={p.NacCMxn} step={0.1} onChange={setN("NacCMxn")} />
                  </Field>
                  <Field label="NacCMyn — lateral" unit="m">
                    <input type="number" value={p.NacCMyn} step={0.1} onChange={setN("NacCMyn")} />
                  </Field>
                  <Field label="NacCMzn — vertical" unit="m">
                    <input type="number" value={p.NacCMzn} step={0.1} onChange={setN("NacCMzn")} />
                  </Field>
                  <Field label="NcIMUxn — downwind" unit="m">
                    <input type="number" value={p.NcIMUxn} step={0.1} onChange={setN("NcIMUxn")} />
                  </Field>
                  <Field label="NcIMUyn — lateral" unit="m">
                    <input type="number" value={p.NcIMUyn} step={0.1} onChange={setN("NcIMUyn")} />
                  </Field>
                  <Field label="NcIMUzn — vertical" unit="m">
                    <input type="number" value={p.NcIMUzn} step={0.1} onChange={setN("NcIMUzn")} />
                  </Field>
                </div>
              </Collapsible>

              <Collapsible title="Miscellaneous geometry">
                <div className={s.grid2}>
                  <Field label="HubCM" unit="m">
                    <input type="number" value={p.HubCM} step={0.1} onChange={setN("HubCM")} />
                  </Field>
                  <Field label="AzimB1Up" unit="°">
                    <input type="number" value={p.AzimB1Up} step={1} onChange={setN("AzimB1Up")} />
                  </Field>
                  <Field label="Delta3 (2-blade teeter)" unit="°">
                    <input type="number" value={p.Delta3} step={0.5} onChange={setN("Delta3")} />
                  </Field>
                  <Field label="UndSling (2-blade)" unit="m">
                    <input type="number" value={p.UndSling} step={0.1} onChange={setN("UndSling")} />
                  </Field>
                </div>
              </Collapsible>
            </div>
          )}

          {/* ── DOFs tab ──────────────────────────────────── */}
          {tab === "dofs" && (
            <div className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
              <SectionHead>Degrees of freedom</SectionHead>

              <DofGroup title="Blade">
                <div className={s.toggleGrid}>
                  <Toggle label="FlapDOF1 — 1st flapwise mode"   value={p.FlapDOF1} onChange={set("FlapDOF1")} />
                  <Toggle label="FlapDOF2 — 2nd flapwise mode"   value={p.FlapDOF2} onChange={set("FlapDOF2")} />
                  <Toggle label="EdgeDOF  — 1st edgewise mode"   value={p.EdgeDOF}  onChange={set("EdgeDOF")}  />
                  <Toggle label="TeetDOF  — rotor teeter"        value={p.TeetDOF}  onChange={set("TeetDOF")}
                    note="unused for 3-blade" />
                </div>
              </DofGroup>

              <DofGroup title="Drivetrain & Generator">
                <div className={s.toggleGrid}>
                  <Toggle label="DrTrDOF — drivetrain flex"  value={p.DrTrDOF} onChange={set("DrTrDOF")} />
                  <Toggle label="GenDOF  — generator speed"  value={p.GenDOF}  onChange={set("GenDOF")}  />
                </div>
              </DofGroup>

              <DofGroup title="Yaw">
                <div className={s.toggleGrid}>
                  <Toggle label="YawDOF — nacelle yaw" value={p.YawDOF} onChange={set("YawDOF")} />
                </div>
              </DofGroup>

              <DofGroup title="Tower">
                <div className={s.toggleGrid}>
                  <Toggle label="TwFADOF1 — 1st fore-aft mode"      value={p.TwFADOF1} onChange={set("TwFADOF1")} />
                  <Toggle label="TwFADOF2 — 2nd fore-aft mode"      value={p.TwFADOF2} onChange={set("TwFADOF2")} />
                  <Toggle label="TwSSDOF1 — 1st side-to-side mode"  value={p.TwSSDOF1} onChange={set("TwSSDOF1")} />
                  <Toggle label="TwSSDOF2 — 2nd side-to-side mode"  value={p.TwSSDOF2} onChange={set("TwSSDOF2")} />
                </div>
              </DofGroup>

              <Collapsible title="Platform DOFs (offshore)">
                <div className={s.toggleGrid}>
                  <Toggle label="PtfmSgDOF — surge"  value={p.PtfmSgDOF} onChange={set("PtfmSgDOF")} />
                  <Toggle label="PtfmSwDOF — sway"   value={p.PtfmSwDOF} onChange={set("PtfmSwDOF")} />
                  <Toggle label="PtfmHvDOF — heave"  value={p.PtfmHvDOF} onChange={set("PtfmHvDOF")} />
                  <Toggle label="PtfmRDOF  — roll"   value={p.PtfmRDOF}  onChange={set("PtfmRDOF")}  />
                  <Toggle label="PtfmPDOF  — pitch"  value={p.PtfmPDOF}  onChange={set("PtfmPDOF")}  />
                  <Toggle label="PtfmYDOF  — yaw"    value={p.PtfmYDOF}  onChange={set("PtfmYDOF")}  />
                </div>
              </Collapsible>

              <SectionHead>Initial conditions</SectionHead>
              <div className={s.grid2}>
                <Field label="Initial rotor speed (RotSpeed)" unit="rpm">
                  <input type="number" value={p.RotSpeed} step={0.1} min={0} onChange={setN("RotSpeed")} />
                </Field>
                <Field label="Initial azimuth (Azimuth)" unit="°">
                  <input type="number" value={p.Azimuth} step={1} min={0} max={360} onChange={setN("Azimuth")} />
                </Field>
                <Field label="Nacelle yaw (NacYaw)" unit="°">
                  <input type="number" value={p.NacYaw} step={1} onChange={setN("NacYaw")} />
                </Field>
              </div>

              <BladeTriple
                label="Initial blade pitch (BlPitch)" unit="°"
                keys={["BlPitch1","BlPitch2","BlPitch3"]}
                p={p} setP={setP}
              />

              <div style={{ marginBottom: 12 }} />
              <Collapsible title="Tower & platform initial displacements">
                <div className={s.grid2}>
                  <Field label="OoPDefl" unit="m">
                    <input type="number" value={p.OoPDefl} step={0.01} onChange={setN("OoPDefl")} />
                  </Field>
                  <Field label="IPDefl" unit="m">
                    <input type="number" value={p.IPDefl} step={0.01} onChange={setN("IPDefl")} />
                  </Field>
                  <Field label="TTDspFA" unit="m">
                    <input type="number" value={p.TTDspFA} step={0.01} onChange={setN("TTDspFA")} />
                  </Field>
                  <Field label="TTDspSS" unit="m">
                    <input type="number" value={p.TTDspSS} step={0.01} onChange={setN("TTDspSS")} />
                  </Field>
                  <Field label="PtfmSurge" unit="m">
                    <input type="number" value={p.PtfmSurge} step={0.1} onChange={setN("PtfmSurge")} />
                  </Field>
                  <Field label="PtfmHeave" unit="m">
                    <input type="number" value={p.PtfmHeave} step={0.1} onChange={setN("PtfmHeave")} />
                  </Field>
                  <Field label="PtfmPitch" unit="°">
                    <input type="number" value={p.PtfmPitch} step={0.1} onChange={setN("PtfmPitch")} />
                  </Field>
                  <Field label="PtfmYaw" unit="°">
                    <input type="number" value={p.PtfmYaw} step={0.1} onChange={setN("PtfmYaw")} />
                  </Field>
                </div>
              </Collapsible>
            </div>
          )}

          {/* ── Mass & Drive tab ──────────────────────────── */}
          {tab === "mass" && (
            <div className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
              <SectionHead>Hub</SectionHead>
              <div className={s.grid2}>
                <Field label="Hub mass (HubMass)" unit="kg"
                  info="Hub structural mass (kg). NREL 5 MW = 56,780 kg. IEA 15 MW ≈ 109,000 kg.">
                  <input type="number" value={p.HubMass} step={100} min={0} onChange={setN("HubMass")} />
                </Field>
                <Field label="Hub inertia (HubIner)" unit="kg·m²"
                  info="Hub inertia about rotor axis [3-blade] or teeter axis [2-blade] (kg·m²).">
                  <input type="number" value={p.HubIner} step={100} min={0} onChange={setN("HubIner")} />
                </Field>
                <Field label="Hub teeter inertia (HubIner_Teeter)" unit="kg·m²"
                  info="Hub inertia about teeter axis for 2-blade turbines. Leave 0 for 3-blade turbines.">
                  <input type="number" value={p.HubIner_Teeter ?? 0} step={100} min={0} onChange={setN("HubIner_Teeter")} />
                </Field>
              </div>

              <SectionHead>Nacelle</SectionHead>
              <div className={s.grid2}>
                <Field label="Nacelle mass (NacMass)" unit="kg">
                  <input type="number" value={p.NacMass} step={100} min={0} onChange={setN("NacMass")} />
                </Field>
                <Field label="Nacelle yaw inertia (NacYIner)" unit="kg·m²">
                  <input type="number" value={p.NacYIner} step={1000} min={0} onChange={setN("NacYIner")} />
                </Field>
                <Field label="Yaw bearing mass (YawBrMass)" unit="kg">
                  <input type="number" value={p.YawBrMass} step={10} min={0} onChange={setN("YawBrMass")} />
                </Field>
                <Field label="Generator inertia (GenIner)" unit="kg·m²"
                  hint="About high-speed shaft">
                  <input type="number" value={p.GenIner} step={1} min={0} onChange={setN("GenIner")} />
                </Field>
              </div>

              <SectionHead>Drivetrain</SectionHead>
              <div className={s.grid2}>
                <Field label="Gearbox ratio (GBRatio)">
                  <input type="number" value={p.GBRatio} step={0.1} min={1} onChange={setN("GBRatio")} />
                </Field>
                <Field label="Gearbox efficiency (GBoxEff)" unit="%">
                  <input type="number" value={p.GBoxEff} step={0.1} min={0} max={100} onChange={setN("GBoxEff")} />
                </Field>
                <Field label="Torsional spring (DTTorSpr)" unit="N·m/rad">
                  <input type="text" value={p.DTTorSpr} onChange={setE("DTTorSpr")} />
                </Field>
                <Field label="Torsional damper (DTTorDmp)" unit="N·m·s/rad">
                  <input type="text" value={p.DTTorDmp} onChange={setE("DTTorDmp")} />
                </Field>
              </div>

              <Collapsible title="Tip-brake masses">
                <BladeTriple
                  label="Tip mass (TipMass)" unit="kg"
                  keys={["TipMass1","TipMass2","TipMass3"]}
                  p={p} setP={setP}
                />
              </Collapsible>

              <Collapsible title="Platform mass & inertia (offshore)">
                <div className={s.grid2}>
                  <Field label="PtfmMass" unit="kg">
                    <input type="number" value={p.PtfmMass} step={1000} min={0} onChange={setN("PtfmMass")} />
                  </Field>
                  <Field label="PtfmRIner" unit="kg·m²">
                    <input type="number" value={p.PtfmRIner} step={1e6} min={0} onChange={setN("PtfmRIner")} />
                  </Field>
                  <Field label="PtfmPIner" unit="kg·m²">
                    <input type="number" value={p.PtfmPIner} step={1e6} min={0} onChange={setN("PtfmPIner")} />
                  </Field>
                  <Field label="PtfmYIner" unit="kg·m²">
                    <input type="number" value={p.PtfmYIner} step={1e6} min={0} onChange={setN("PtfmYIner")} />
                  </Field>
                  <Field label="PtfmXYIner" unit="kg·m²"
                    info="Platform cross-inertia xy (=-∫xydm) about platform CM. Usually 0 for symmetric platforms.">
                    <input type="number" value={p.PtfmXYIner ?? 0} step={1e5} onChange={setN("PtfmXYIner")} />
                  </Field>
                  <Field label="PtfmYZIner" unit="kg·m²"
                    info="Platform cross-inertia yz (=-∫yzdm) about platform CM. Usually 0 for symmetric platforms.">
                    <input type="number" value={p.PtfmYZIner ?? 0} step={1e5} onChange={setN("PtfmYZIner")} />
                  </Field>
                  <Field label="PtfmXZIner" unit="kg·m²"
                    info="Platform cross-inertia xz (=-∫xzdm) about platform CM. Usually 0 for symmetric platforms.">
                    <input type="number" value={p.PtfmXZIner ?? 0} step={1e5} onChange={setN("PtfmXZIner")} />
                  </Field>
                </div>
              </Collapsible>

              <Collapsible title="Yaw friction (IEA 15 MW / advanced)"
                defaultOpen={p.YawFrctMod > 0}>
                <p className={s.hint} style={{ marginBottom: 12 }}>
                  Yaw bearing friction model. Set YawFrctMod=0 to disable (default for NREL 5 MW).
                  IEA 15 MW uses YawFrctMod=1 with Coulomb + viscous terms.
                </p>
                <div className={s.grid2}>
                  <Field label="YawFrctMod"
                    info="0=none, 1=friction independent of loads (Coulomb+viscous), 2=Coulomb friction proportional to loads, 3=user-defined">
                    <select value={p.YawFrctMod ?? 0} onChange={setN("YawFrctMod")}>
                      <option value={0}>0 — None</option>
                      <option value={1}>1 — Coulomb + viscous</option>
                      <option value={2}>2 — Load-dependent Coulomb</option>
                      <option value={3}>3 — User-defined</option>
                    </select>
                  </Field>
                  <Field label="M_CSmax" unit="N·m"
                    info="Maximum static Coulomb friction torque (N·m). Active when YawFrctMod=1 or 2.">
                    <input type="number" value={p.M_CSmax ?? 300} step={10} min={0}
                      onChange={setN("M_CSmax")} disabled={!p.YawFrctMod} />
                  </Field>
                  <Field label="M_FCSmax" unit="N·m"
                    info="Static Coulomb friction torque per unit yaw-bearing shear force (N·m / N). Used when YawFrctMod=2.">
                    <input type="number" value={p.M_FCSmax ?? 0} step={1} onChange={setN("M_FCSmax")}
                      disabled={!p.YawFrctMod} />
                  </Field>
                  <Field label="M_MCSmax" unit="N·m"
                    info="Static Coulomb friction torque per unit yaw-bearing bending moment (N·m / N·m). Used when YawFrctMod=2.">
                    <input type="number" value={p.M_MCSmax ?? 0} step={0.1} onChange={setN("M_MCSmax")}
                      disabled={!p.YawFrctMod} />
                  </Field>
                  <Field label="M_CD" unit="N·m"
                    info="Dynamic Coulomb friction moment (N·m).">
                    <input type="number" value={p.M_CD ?? 40} step={1} min={0}
                      onChange={setN("M_CD")} disabled={!p.YawFrctMod} />
                  </Field>
                  <Field label="M_FCD" unit="N·m"
                    info="Dynamic Coulomb friction per unit shear force (N·m / N). Used when YawFrctMod=2.">
                    <input type="number" value={p.M_FCD ?? 0} step={1} onChange={setN("M_FCD")}
                      disabled={!p.YawFrctMod} />
                  </Field>
                  <Field label="M_MCD" unit="N·m"
                    info="Dynamic Coulomb friction per unit bending moment (N·m / N·m). Used when YawFrctMod=2.">
                    <input type="number" value={p.M_MCD ?? 0} step={0.1} onChange={setN("M_MCD")}
                      disabled={!p.YawFrctMod} />
                  </Field>
                  <Field label="sig_v" unit="N·m·s/rad"
                    info="Linear viscous friction coefficient (N·m/(rad/s)). Creates a braking torque proportional to yaw rate.">
                    <input type="number" value={p.sig_v ?? 0} step={0.1} min={0}
                      onChange={setN("sig_v")} disabled={!p.YawFrctMod} />
                  </Field>
                  <Field label="sig_v2" unit="N·m·s²/rad²"
                    info="Quadratic viscous friction coefficient (N·m/(rad/s)²).">
                    <input type="number" value={p.sig_v2 ?? 0} step={0.01} min={0}
                      onChange={setN("sig_v2")} disabled={!p.YawFrctMod} />
                  </Field>
                  <Field label="OmgCut" unit="rad/s"
                    info="Yaw angular velocity cutoff below which viscous friction is linearised (prevents singularity near zero velocity).">
                    <input type="number" value={p.OmgCut ?? 0} step={0.001} min={0}
                      onChange={setN("OmgCut")} disabled={!p.YawFrctMod} />
                  </Field>
                </div>
              </Collapsible>

              <Collapsible title="Rotor-teeter spring/damper (2-blade)">
                <div className={s.grid2}>
                  <Field label="TeetMod">
                    <select value={p.TeetMod} onChange={setN("TeetMod")}>
                      <option value={0}>0 — None</option>
                      <option value={1}>1 — Standard</option>
                      <option value={2}>2 — User-defined</option>
                    </select>
                  </Field>
                  <Field label="TeetDmpP" unit="°"><input type="number" value={p.TeetDmpP} onChange={setN("TeetDmpP")}/></Field>
                  <Field label="TeetDmp" unit="N·m·s/rad"><input type="number" value={p.TeetDmp} onChange={setN("TeetDmp")}/></Field>
                  <Field label="TeetCDmp" unit="N·m"><input type="number" value={p.TeetCDmp} onChange={setN("TeetCDmp")}/></Field>
                  <Field label="TeetSStP" unit="°"><input type="number" value={p.TeetSStP} onChange={setN("TeetSStP")}/></Field>
                  <Field label="TeetHStP" unit="°"><input type="number" value={p.TeetHStP} onChange={setN("TeetHStP")}/></Field>
                </div>
              </Collapsible>
            </div>
          )}

          {/* ── Files & Output tab ────────────────────────── */}
          {tab === "files" && (
            <div className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
              <SectionHead>Integration</SectionHead>
              <div className={s.grid2}>
                <Field label="Integration method (Method)">
                  <select value={p.Method} onChange={setN("Method")}>
                    {INTEGRATION_METHODS.map(o => (
                      <option key={o.v} value={o.v}>{o.label}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Time step (DT)" hint='"default" uses the OpenFAST DT'>
                  <input type="text" value={p.DT} onChange={setE("DT")} />
                </Field>
              </div>

              <SectionHead>Blade files</SectionHead>
              <div className={s.grid1}>
                <Field label="Blade nodes (BldNodes)">
                  <input type="number" value={p.BldNodes} step={1} min={3} onChange={setN("BldNodes")} />
                </Field>
                <FileTriple
                  label="Blade definition files (BldFile)"
                  keys={["BldFile1","BldFile2","BldFile3"]}
                  p={p} setP={setP}
                />
              </div>

              <SectionHead>Tower file</SectionHead>
              <div className={s.grid1}>
                <Field label="Tower nodes (TwrNodes)">
                  <input type="number" value={p.TwrNodes} step={1} min={3} onChange={setN("TwrNodes")} />
                </Field>
                <Field label="Tower definition file (TwrFile)">
                  <div className={s.fileRow}>
                    <input type="text" value={p.TwrFile} onChange={setE("TwrFile")} />
                    <button className={s.browseBtn} onClick={async () => {
                      try { const f = await openDialog({ multiple: false }); if (f) setP(prev => ({ ...prev, TwrFile: f })); } catch {}
                    }}>
                      <FolderOpen size={12} strokeWidth={1.8} />
                    </button>
                  </div>
                </Field>
              </div>

              <SectionHead>Output settings</SectionHead>
              <div className={s.grid2}>
                <Field label="Output file (OutFile)">
                  <select value={p.OutFile} onChange={setN("OutFile")}>
                    <option value={1}>1 — Module file only</option>
                    <option value={2}>2 — Glue-code file only</option>
                    <option value={3}>3 — Both</option>
                  </select>
                </Field>
                <Field label="Column format (OutFmt)">
                  <input type="text" value={p.OutFmt} onChange={setE("OutFmt")} />
                </Field>
                <Field label="Output start time (TStart)" unit="s">
                  <input type="number" value={p.TStart} step={1} min={0} onChange={setN("TStart")} />
                </Field>
                <Field label="Decimation factor (DecFact)">
                  <input type="number" value={p.DecFact} step={1} min={1} onChange={setN("DecFact")} />
                </Field>
              </div>
              <div className={s.toggleGrid}>
                <Toggle label="SumPrint — write .sum summary file" value={p.SumPrint} onChange={set("SumPrint")} />
                <Toggle label="TabDelim — tab-delimited text output" value={p.TabDelim} onChange={set("TabDelim")} />
                <Toggle label="Echo — echo inputs to .ech file"     value={p.Echo}     onChange={set("Echo")}     />
              </div>

              <Collapsible title="Strain gauge nodes">
                <div className={s.grid2}>
                  <Field label="NTwGages — tower gauge count">
                    <input type="number" value={p.NTwGages} step={1} min={0} max={9} onChange={setN("NTwGages")} />
                  </Field>
                  <Field label="TwrGagNd — tower gauge nodes" hint="Space-separated node numbers">
                    <input type="text" value={p.TwrGagNd} onChange={setE("TwrGagNd")}
                      disabled={p.NTwGages === 0} />
                  </Field>
                  <Field label="NBlGages — blade gauge count">
                    <input type="number" value={p.NBlGages} step={1} min={0} max={9} onChange={setN("NBlGages")} />
                  </Field>
                  <Field label="BldGagNd — blade gauge nodes" hint="Space-separated node numbers">
                    <input type="text" value={p.BldGagNd} onChange={setE("BldGagNd")}
                      disabled={p.NBlGages === 0} />
                  </Field>
                </div>
              </Collapsible>

              <SectionHead>Output channels (OutList)</SectionHead>
              <p className={s.hint} style={{ marginBottom: 8 }}>
                One channel per line. Quotes are optional — added automatically on save.
              </p>
              <button
                className={s.pickVarsBtn}
                type="button"
                onClick={() => setShowOutVarModal(true)}
                style={{ marginBottom: 8, alignSelf: "flex-start" }}
              >
                <List size={11} strokeWidth={2} />
                Pick variables
              </button>
              <textarea
                className={s.outListArea}
                value={p.OutList}
                onChange={setE("OutList")}
                spellCheck={false}
              />
              {showOutVarModal && (
                <EdOutVarModal
                  current={p.OutList}
                  onClose={() => setShowOutVarModal(false)}
                  onApply={outList => setP(prev => ({ ...prev, OutList: outList }))}
                />
              )}

              <SectionHead>Blade node outputs (NodeOutList)</SectionHead>
              <p className={s.hint} style={{ marginBottom: 10 }}>
                Outputs time series at individual blade nodes — useful for distributed load and deflection analysis.
              </p>
              <div className={s.fieldGrid}>
                <Field
                  label="BldNd_BladesOut — blades to output"
                  hint="0 = disabled; 1, 2, or 3 to output that many blades"
                  fieldKey="BldNd_BladesOut"
                >
                  <input
                    type="number"
                    value={p.BldNd_BladesOut ?? 0}
                    step={1} min={0} max={3}
                    onChange={setN("BldNd_BladesOut")}
                  />
                </Field>
                <Field
                  label="BldNd_BlOutNd — node indices"
                  hint={`"All" or space-separated node numbers (e.g. "1 5 10 20 30 36")`}
                  fieldKey="BldNd_BlOutNd"
                  disabledHint={(p.BldNd_BladesOut ?? 0) === 0
                    ? "Set BldNd_BladesOut ≥ 1 to select which blade nodes to output"
                    : undefined}
                >
                  <input
                    type="text"
                    value={p.BldNd_BlOutNd ?? "All"}
                    onChange={setE("BldNd_BlOutNd")}
                    disabled={(p.BldNd_BladesOut ?? 0) === 0}
                  />
                </Field>
              </div>
              <button
                className={s.pickVarsBtn}
                type="button"
                onClick={() => (p.BldNd_BladesOut ?? 0) > 0 && setShowNodeVarModal(true)}
                style={{
                  marginBottom: 8, marginTop: 4, alignSelf: "flex-start",
                  opacity: (p.BldNd_BladesOut ?? 0) === 0 ? 0.38 : 1,
                  cursor:  (p.BldNd_BladesOut ?? 0) === 0 ? "not-allowed" : "pointer",
                }}
                title={(p.BldNd_BladesOut ?? 0) === 0 ? "Set BldNd_BladesOut ≥ 1 to enable" : undefined}
              >
                <List size={11} strokeWidth={2} />
                Pick node variables
              </button>
              <textarea
                className={s.outListArea}
                value={p.NodeOutList}
                onChange={setE("NodeOutList")}
                spellCheck={false}
                disabled={(p.BldNd_BladesOut ?? 0) === 0}
                placeholder={(p.BldNd_BladesOut ?? 0) === 0 ? "Set BldNd_BladesOut ≥ 1 to enable node outputs" : 'e.g. "TDx"\n"TDy"\n"RDz"'}
              />
              {showNodeVarModal && (
                <EdOutVarModal
                  vars={ED_NODE_VARS}
                  title="Blade node variable picker"
                  current={p.NodeOutList}
                  onClose={() => setShowNodeVarModal(false)}
                  onApply={outList => setP(prev => ({ ...prev, NodeOutList: outList }))}
                />
              )}
            </div>
          )}

        </MissingCtx.Provider>
        </div>

        {/* ── Right stats panel ────────────────────────────── */}
        <div className={s.statsPanel}>
          <p className={s.statsLabel}>Quick stats</p>

          <div className={s.turbineWrap}>
            <TurbineSchematic
              tipRad={p.TipRad} towerHt={p.TowerHt}
              twr2Shft={p.Twr2Shft} rotSpeed={p.RotSpeed}
            />
          </div>

          <div className={s.statsGrid}>
            {[
              { k: "Rotor dia.",  v: `${rotorDia.toFixed(1)} m`       },
              { k: "Hub height",  v: `${hubHt.toFixed(2)} m`          },
              { k: "TipRad",      v: `${p.TipRad} m`                  },
              { k: "RotSpeed",    v: `${p.RotSpeed} rpm`              },
              { k: "GBRatio",     v: String(p.GBRatio)                },
              { k: "GBoxEff",     v: `${p.GBoxEff} %`                 },
              { k: "HubMass",     v: `${(p.HubMass/1e3).toFixed(1)} t`},
              { k: "NacMass",     v: `${(p.NacMass/1e3).toFixed(1)} t`},
              { k: "NumBl",       v: String(p.NumBl)                  },
              { k: "PreCone",     v: `${p.PreCone1}°`                 },
              { k: "ShftTilt",    v: `${p.ShftTilt}°`                 },
            ].map(c => (
              <div key={c.k} className={s.statCard}>
                <span className={s.statKey}>{c.k}</span>
                <span className={s.statVal}>{c.v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
