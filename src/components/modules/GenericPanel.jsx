import { Cloud, Zap, Activity, Cpu, Droplets, ArrowDown, Wrench } from "lucide-react";
import s from "./GenericPanel.module.css";

const META = {
  inflowwind: { label: "InflowWind", color: "var(--c-inflow)",    icon: Cloud,    desc: "Defines inflow wind conditions fed to AeroDyn.",            phase: "Phase 1" },
  aerodyn:    { label: "AeroDyn",    color: "var(--c-aerodyn)",   icon: Zap,      desc: "Computes aerodynamic loads on the rotor blades.",            phase: "Phase 1" },
  elastodyn:  { label: "ElastoDyn",  color: "var(--c-elastodyn)", icon: Activity, desc: "Models structural dynamics and degrees of freedom.",          phase: "Phase 1" },
  servodyn:   { label: "ServoDyn",   color: "var(--c-servodyn)",  icon: Cpu,      desc: "Handles control systems, pitch actuators, and the generator.",phase: "Phase 1" },
  hydrodyn:   { label: "HydroDyn",   color: "var(--c-disabled)",  icon: Droplets, desc: "Computes hydrodynamic loads for offshore turbines.",          phase: "Phase 2" },
  subdyn:     { label: "SubDyn",     color: "var(--c-disabled)",  icon: ArrowDown,desc: "Models the substructure dynamics for offshore foundations.",   phase: "Phase 2" },
};

const COMING = {
  inflowwind: ["Wind type selection (TurbSim / uniform / steady)", "TurbSim .bts file path", "Mean wind speed profile", "Shear exponent", "Upflow angle"],
  aerodyn:    ["Blade geometry file (.dat)", "Wake model (OLAF / BEM)", "Tower influence", "Tip-loss correction", "Hub-loss correction", "Skew wake correction"],
  elastodyn:  ["Degrees of freedom toggles (all 24)", "Blade structural properties file", "Tower structural properties file", "Initial rotor speed", "Initial pitch angles"],
  servodyn:   ["Generator model (simple / ROSCO)", "Pitch control gains (Kp, Ki)", "Torque control mode", "Blade-pitch actuator model", "Electrical efficiency"],
  hydrodyn:   ["Sea state parameters (Hs, Tp, direction)", "WAMIT output files", "Strip theory / Morison elements", "Current profile"],
  subdyn:     ["Substructure model type", "Tower-base connection DOFs", "Soil-pile interaction springs", "Member cross-sections"],
};

export default function GenericPanel({ module }) {
  const m = META[module];
  if (!m) return null;
  const Icon = m.icon;
  const items = COMING[module] || [];

  return (
    <div className={s.panel}>
      <div className={s.header} data-tauri-drag-region>
        <Icon size={16} strokeWidth={1.8} style={{ color: m.color }} />
        <h1 className={s.title}>{m.label}</h1>
        <span className={s.desc}>{m.desc}</span>
        <span className={s.badge} style={{ background: `${m.color}18`, color: m.color }}>{m.phase}</span>
      </div>

      <div className={s.body}>
        <div className={s.card}>
          <Wrench size={28} strokeWidth={1.4} style={{ color: m.color, opacity: 0.6, marginBottom: 14 }} />
          <h2 className={s.cardTitle}>{m.label} configuration</h2>
          <p className={s.cardSub}>Form editor coming in {m.phase}.</p>
          <div className={s.comingList}>
            <p className={s.comingLabel}>Parameters to be included</p>
            {items.map((item, i) => (
              <div key={i} className={s.comingItem}>
                <span className={s.comingDot} style={{ background: m.color }} />
                {item}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
