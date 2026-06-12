/**
 * OutVarPicker — searchable, categorised output-variable picker
 *
 * Props
 *   open        boolean
 *   onClose     () => void
 *   onApply     (names: string[]) => void   — called with the newly selected names
 *   mode        "add" | "replace"           — default "add"
 *   currentVars string[]                    — currently active variable names (pre-ticked)
 */
import { useState, useMemo, useCallback } from "react";
import { X, Search, ChevronDown, ChevronRight, Check } from "lucide-react";
import s from "./OutVarPicker.module.css";

// ── Comprehensive OpenFAST output variable database ───────────────────────────
// Sourced from OpenFAST v3 documentation & OutListParameters.xlsx
const CATEGORIES = [
  {
    id: "perf",
    label: "Performance & Power",
    icon: "⚡",
    vars: [
      { name: "GenSpeed",   unit: "rpm",  desc: "Generator speed (high-speed shaft)" },
      { name: "GenTq",      unit: "kN·m", desc: "Generator electrical torque" },
      { name: "GenPwr",     unit: "kW",   desc: "Generator electrical power output" },
      { name: "RotSpeed",   unit: "rpm",  desc: "Low-speed shaft (rotor) speed" },
      { name: "RtAeroCp",   unit: "-",    desc: "Rotor aerodynamic power coefficient Cp" },
      { name: "RtAeroCt",   unit: "-",    desc: "Rotor aerodynamic thrust coefficient Ct" },
      { name: "RtTSR",      unit: "-",    desc: "Rotor tip-speed ratio" },
      { name: "RtVAvgxh",   unit: "m/s",  desc: "Rotor-averaged wind speed (hub frame, x)" },
      { name: "HSSBrTqC",   unit: "kN·m", desc: "High-speed shaft brake torque (command)" },
      { name: "HSShftV",    unit: "rpm",  desc: "High-speed shaft speed" },
    ],
  },
  {
    id: "rotor",
    label: "Rotor & Shaft",
    icon: "🔄",
    vars: [
      { name: "Azimuth",    unit: "deg",  desc: "Blade 1 azimuth angle" },
      { name: "LSSTipPxa",  unit: "deg",  desc: "Low-speed shaft tip azimuth (from first blade)" },
      { name: "LSSGagMya",  unit: "kN·m", desc: "LSS gauge tilt moment (in rotating frame)" },
      { name: "LSSGagMza",  unit: "kN·m", desc: "LSS gauge yaw moment (in rotating frame)" },
      { name: "LSSTipMya",  unit: "kN·m", desc: "LSS tip tilt moment" },
      { name: "LSSTipMzs",  unit: "kN·m", desc: "LSS tip yaw moment (non-rotating)" },
      { name: "RotThrust",  unit: "kN",   desc: "Rotor thrust (low-speed shaft axis)" },
      { name: "RotTorq",    unit: "kN·m", desc: "Rotor torque (low-speed shaft)" },
      { name: "RotPwr",     unit: "kW",   desc: "Rotor aerodynamic power" },
    ],
  },
  {
    id: "blade_loads",
    label: "Blade Root Loads",
    icon: "🌀",
    vars: [
      { name: "RootFxb1",  unit: "kN",   desc: "Blade 1 root x-shear (body frame)" },
      { name: "RootFyb1",  unit: "kN",   desc: "Blade 1 root y-shear (body frame)" },
      { name: "RootFzb1",  unit: "kN",   desc: "Blade 1 root axial force (body frame)" },
      { name: "RootMxb1",  unit: "kN·m", desc: "Blade 1 root edge moment (body frame)" },
      { name: "RootMyb1",  unit: "kN·m", desc: "Blade 1 root flap moment (body frame)" },
      { name: "RootMzb1",  unit: "kN·m", desc: "Blade 1 root torsion (body frame)" },
      { name: "RootFxc1",  unit: "kN",   desc: "Blade 1 root x-shear (rotating chord frame)" },
      { name: "RootFyc1",  unit: "kN",   desc: "Blade 1 root y-shear (rotating chord frame)" },
      { name: "RootFzc1",  unit: "kN",   desc: "Blade 1 root axial force (chord frame)" },
      { name: "RootMxc1",  unit: "kN·m", desc: "Blade 1 root edge moment (chord frame)" },
      { name: "RootMyc1",  unit: "kN·m", desc: "Blade 1 root flap moment (chord frame)" },
      { name: "RootMzc1",  unit: "kN·m", desc: "Blade 1 root torsion (chord frame)" },
      { name: "RootFxb2",  unit: "kN",   desc: "Blade 2 root x-shear" },
      { name: "RootFyb2",  unit: "kN",   desc: "Blade 2 root y-shear" },
      { name: "RootMxb2",  unit: "kN·m", desc: "Blade 2 root edge moment" },
      { name: "RootMyb2",  unit: "kN·m", desc: "Blade 2 root flap moment" },
      { name: "RootFxb3",  unit: "kN",   desc: "Blade 3 root x-shear" },
      { name: "RootFyb3",  unit: "kN",   desc: "Blade 3 root y-shear" },
      { name: "RootMxb3",  unit: "kN·m", desc: "Blade 3 root edge moment" },
      { name: "RootMyb3",  unit: "kN·m", desc: "Blade 3 root flap moment" },
    ],
  },
  {
    id: "blade_defl",
    label: "Blade Deflections & Pitch",
    icon: "📐",
    vars: [
      { name: "TipDxc1",    unit: "m",   desc: "Blade 1 tip flapwise deflection (chord frame)" },
      { name: "TipDyc1",    unit: "m",   desc: "Blade 1 tip edgewise deflection (chord frame)" },
      { name: "TipDzc1",    unit: "m",   desc: "Blade 1 tip axial deflection" },
      { name: "TipRDxb1",   unit: "deg", desc: "Blade 1 tip flapwise rotation angle" },
      { name: "TipRDyb1",   unit: "deg", desc: "Blade 1 tip edgewise rotation angle" },
      { name: "TipDxc2",    unit: "m",   desc: "Blade 2 tip flapwise deflection" },
      { name: "TipDyc2",    unit: "m",   desc: "Blade 2 tip edgewise deflection" },
      { name: "TipDxc3",    unit: "m",   desc: "Blade 3 tip flapwise deflection" },
      { name: "TipDyc3",    unit: "m",   desc: "Blade 3 tip edgewise deflection" },
      { name: "OoPDefl1",   unit: "m",   desc: "Blade 1 out-of-plane tip deflection" },
      { name: "IPDefl1",    unit: "m",   desc: "Blade 1 in-plane tip deflection" },
      { name: "OoPDefl2",   unit: "m",   desc: "Blade 2 out-of-plane tip deflection" },
      { name: "IPDefl2",    unit: "m",   desc: "Blade 2 in-plane tip deflection" },
      { name: "BldPitch1",  unit: "deg", desc: "Blade 1 pitch angle" },
      { name: "BldPitch2",  unit: "deg", desc: "Blade 2 pitch angle" },
      { name: "BldPitch3",  unit: "deg", desc: "Blade 3 pitch angle" },
      { name: "BlPitchCom1",unit: "deg", desc: "Blade 1 pitch command (ServoDyn)" },
      { name: "BlPitchCom2",unit: "deg", desc: "Blade 2 pitch command" },
      { name: "BlPitchCom3",unit: "deg", desc: "Blade 3 pitch command" },
    ],
  },
  {
    id: "tower",
    label: "Tower Loads",
    icon: "🗼",
    vars: [
      { name: "TwrBsFxt",  unit: "kN",   desc: "Tower base fore-aft shear force" },
      { name: "TwrBsFyt",  unit: "kN",   desc: "Tower base side-to-side shear force" },
      { name: "TwrBsFzt",  unit: "kN",   desc: "Tower base vertical (axial) force" },
      { name: "TwrBsMxt",  unit: "kN·m", desc: "Tower base side-to-side bending moment" },
      { name: "TwrBsMyt",  unit: "kN·m", desc: "Tower base fore-aft bending moment (overturning)" },
      { name: "TwrBsMzt",  unit: "kN·m", desc: "Tower base torsional moment" },
      { name: "YawBrFxp",  unit: "kN",   desc: "Yaw bearing fore-aft shear force" },
      { name: "YawBrFyp",  unit: "kN",   desc: "Yaw bearing side-to-side shear force" },
      { name: "YawBrFzp",  unit: "kN",   desc: "Yaw bearing vertical force" },
      { name: "YawBrMxp",  unit: "kN·m", desc: "Yaw bearing roll moment" },
      { name: "YawBrMyp",  unit: "kN·m", desc: "Yaw bearing pitch moment" },
      { name: "YawBrMzp",  unit: "kN·m", desc: "Yaw bearing yaw moment" },
      { name: "YawBrTDxp", unit: "m",    desc: "Tower-top fore-aft displacement (yaw bearing)" },
      { name: "YawBrTDyp", unit: "m",    desc: "Tower-top side-to-side displacement" },
      { name: "YawBrRDzt", unit: "deg",  desc: "Nacelle yaw angle (tower-top)" },
    ],
  },
  {
    id: "nacelle",
    label: "Nacelle & Yaw",
    icon: "🏠",
    vars: [
      { name: "NacYaw",    unit: "deg",     desc: "Nacelle yaw angle" },
      { name: "NacYawErr", unit: "deg",     desc: "Nacelle yaw error angle" },
      { name: "TTDspFA",   unit: "m",       desc: "Tower-top fore-aft displacement" },
      { name: "TTDspSS",   unit: "m",       desc: "Tower-top side-to-side displacement" },
      { name: "NacIMURAxs",unit: "deg/s²",  desc: "Nacelle IMU roll acceleration" },
      { name: "NacIMURAys",unit: "deg/s²",  desc: "Nacelle IMU pitch acceleration" },
      { name: "NacIMURAzs",unit: "deg/s²",  desc: "Nacelle IMU yaw acceleration" },
      { name: "NcIMUTAxs", unit: "m/s²",   desc: "Nacelle IMU translational x acceleration" },
      { name: "NcIMUTAys", unit: "m/s²",   desc: "Nacelle IMU translational y acceleration" },
      { name: "NcIMUTAzs", unit: "m/s²",   desc: "Nacelle IMU translational z acceleration" },
    ],
  },
  {
    id: "wind",
    label: "Wind Conditions",
    icon: "💨",
    vars: [
      { name: "Wind1VelX", unit: "m/s", desc: "Hub-height streamwise wind speed (InflowWind point 1)" },
      { name: "Wind1VelY", unit: "m/s", desc: "Hub-height lateral wind speed" },
      { name: "Wind1VelZ", unit: "m/s", desc: "Hub-height vertical wind speed" },
      { name: "Wind2VelX", unit: "m/s", desc: "InflowWind point 2 streamwise speed" },
      { name: "Wind2VelY", unit: "m/s", desc: "InflowWind point 2 lateral speed" },
      { name: "Wind2VelZ", unit: "m/s", desc: "InflowWind point 2 vertical speed" },
    ],
  },
  {
    id: "aero",
    label: "Rotor Aerodynamics",
    icon: "🌬",
    vars: [
      { name: "RtAeroFxh", unit: "kN",   desc: "Rotor aerodynamic thrust (hub frame, x)" },
      { name: "RtAeroFyh", unit: "kN",   desc: "Rotor aerodynamic side force (hub frame, y)" },
      { name: "RtAeroFzh", unit: "kN",   desc: "Rotor aerodynamic vertical force (hub frame, z)" },
      { name: "RtAeroMxh", unit: "kN·m", desc: "Rotor aerodynamic torque (hub frame, x)" },
      { name: "RtAeroMyh", unit: "kN·m", desc: "Rotor aerodynamic tilt moment (hub frame, y)" },
      { name: "RtAeroMzh", unit: "kN·m", desc: "Rotor aerodynamic yaw moment (hub frame, z)" },
      { name: "RtAeroCp",  unit: "-",    desc: "Rotor power coefficient Cp" },
      { name: "RtAeroCt",  unit: "-",    desc: "Rotor thrust coefficient Ct" },
      { name: "RtTSR",     unit: "-",    desc: "Tip-speed ratio" },
      { name: "RtVAvgxh",  unit: "m/s",  desc: "Rotor-averaged streamwise wind speed" },
      { name: "B1N001Alpha",unit:"deg",  desc: "Blade 1 node 1 angle of attack" },
      { name: "B1N001Cl",  unit: "-",    desc: "Blade 1 node 1 lift coefficient" },
      { name: "B1N001Cd",  unit: "-",    desc: "Blade 1 node 1 drag coefficient" },
      { name: "B1N001Vrel",unit: "m/s",  desc: "Blade 1 node 1 relative wind speed" },
    ],
  },
  {
    id: "platform",
    label: "Platform (Offshore)",
    icon: "🌊",
    vars: [
      { name: "PtfmSurge", unit: "m",   desc: "Platform surge (fore-aft translation)" },
      { name: "PtfmSway",  unit: "m",   desc: "Platform sway (side-to-side translation)" },
      { name: "PtfmHeave", unit: "m",   desc: "Platform heave (vertical translation)" },
      { name: "PtfmRoll",  unit: "deg", desc: "Platform roll rotation" },
      { name: "PtfmPitch", unit: "deg", desc: "Platform pitch rotation" },
      { name: "PtfmYaw",   unit: "deg", desc: "Platform yaw rotation" },
      { name: "PtfmFxt",   unit: "kN",  desc: "Platform mooring/hydro fore-aft force" },
      { name: "PtfmFyt",   unit: "kN",  desc: "Platform mooring/hydro side force" },
      { name: "PtfmFzt",   unit: "kN",  desc: "Platform mooring/hydro vertical force" },
      { name: "PtfmMxt",   unit: "kN·m",desc: "Platform roll moment" },
      { name: "PtfmMyt",   unit: "kN·m",desc: "Platform pitch moment" },
      { name: "PtfmMzt",   unit: "kN·m",desc: "Platform yaw moment" },
    ],
  },
];

// Flatten all vars for search
const ALL_VARS = CATEGORIES.flatMap(cat =>
  cat.vars.map(v => ({ ...v, catId: cat.id, catLabel: cat.label }))
);

export default function OutVarPicker({ open, onClose, onApply, mode = "add", currentVars = [] }) {
  const [search,    setSearch]    = useState("");
  const [expanded,  setExpanded]  = useState(() => new Set(["tower", "blade_loads", "perf"]));
  const [checked,   setChecked]   = useState(() => new Set(currentVars));

  // Re-sync checked when currentVars changes (modal re-opened)
  // (handled via key prop on the modal in parent)

  const toggleExpand = (id) => setExpanded(prev => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  const toggleVar = useCallback((name) => {
    setChecked(prev => {
      const n = new Set(prev);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });
  }, []);

  const toggleAll = useCallback((catVars, value) => {
    setChecked(prev => {
      const n = new Set(prev);
      for (const v of catVars) value ? n.add(v.name) : n.delete(v.name);
      return n;
    });
  }, []);

  const filteredCats = useMemo(() => {
    if (!search) return CATEGORIES;
    const q = search.toLowerCase();
    return CATEGORIES.map(cat => ({
      ...cat,
      vars: cat.vars.filter(v =>
        v.name.toLowerCase().includes(q) ||
        v.desc.toLowerCase().includes(q) ||
        v.unit.toLowerCase().includes(q)
      ),
    })).filter(cat => cat.vars.length > 0);
  }, [search]);

  const handleApply = () => {
    onApply([...checked]);
    onClose();
  };

  if (!open) return null;

  return (
    <div className={s.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={s.modal}>
        {/* Header */}
        <div className={s.header}>
          <div className={s.headerLeft}>
            <span className={s.title}>Output variable picker</span>
            <span className={s.badge}>{checked.size} selected</span>
          </div>
          <button className={s.closeBtn} onClick={onClose} title="Close">
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        {/* Search */}
        <div className={s.searchRow}>
          <Search size={12} strokeWidth={1.8} className={s.searchIcon} />
          <input
            className={s.searchInput}
            placeholder="Search variables… (name, description, unit)"
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
          />
          {search && (
            <button className={s.searchClear} onClick={() => setSearch("")}>
              <X size={10} strokeWidth={2.5} />
            </button>
          )}
        </div>

        {/* Category list */}
        <div className={s.catList}>
          {filteredCats.map(cat => {
            const isOpen = search ? true : expanded.has(cat.id);
            const allChecked = cat.vars.every(v => checked.has(v.name));
            const someChecked = cat.vars.some(v => checked.has(v.name));
            return (
              <div key={cat.id} className={s.catGroup}>
                {/* Category header */}
                <div
                  className={s.catHead}
                  onClick={() => !search && toggleExpand(cat.id)}
                  style={{ cursor: search ? "default" : "pointer" }}
                >
                  <input
                    type="checkbox"
                    className={s.catCheck}
                    checked={allChecked}
                    ref={el => { if (el) el.indeterminate = someChecked && !allChecked; }}
                    onChange={e => { e.stopPropagation(); toggleAll(cat.vars, e.target.checked); }}
                    onClick={e => e.stopPropagation()}
                  />
                  <span className={s.catIcon}>{cat.icon}</span>
                  <span className={s.catLabel}>{cat.label}</span>
                  <span className={s.catCount}>{cat.vars.filter(v => checked.has(v.name)).length}/{cat.vars.length}</span>
                  {!search && (
                    <span className={s.catChevron}>
                      {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </span>
                  )}
                </div>

                {/* Variable rows */}
                {isOpen && (
                  <div className={s.varRows}>
                    {cat.vars.map(v => (
                      <label key={v.name} className={s.varRow}>
                        <input
                          type="checkbox"
                          className={s.varCheck}
                          checked={checked.has(v.name)}
                          onChange={() => toggleVar(v.name)}
                        />
                        <span className={s.varName}>{v.name}</span>
                        <span className={s.varUnit}>{v.unit}</span>
                        <span className={s.varDesc}>{v.desc}</span>
                        {checked.has(v.name) && (
                          <Check size={10} strokeWidth={2.5} className={s.varCheckIcon} />
                        )}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {filteredCats.length === 0 && (
            <div className={s.noResults}>No variables match "{search}"</div>
          )}
        </div>

        {/* Footer */}
        <div className={s.footer}>
          <button className={s.clearBtn} onClick={() => setChecked(new Set())}>
            Clear all
          </button>
          <div className={s.footerRight}>
            <button className={s.cancelBtn} onClick={onClose}>Cancel</button>
            <button className={s.applyBtn} onClick={handleApply} disabled={checked.size === 0}>
              {mode === "replace" ? "Replace OutList" : `Add ${checked.size} to OutList`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
