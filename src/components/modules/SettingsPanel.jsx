import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Settings, Cpu, Info, RefreshCw, ExternalLink } from "lucide-react";
import BinaryRow from "../BinaryRow";
import { useBinarySettings } from "../../hooks/useBinarySettings";

const APP_VERSION = "1.1.0";
const OF_COMPAT   = "4.2.0";
const TS_COMPAT   = "4.2.0";

const DEVELOPER = {
  name:     "Nur Mahammad Mussa Kalimullah, PhD",
  email:    "findmussa@gmail.com",
  website:  "www.flowurjastudio.com",
  web:      "findmussa.github.io",
  github:   "github.com/findmussa/flowurja-studio",
  linkedin: "linkedin.com/in/findmussa",
  orcid:    "0000-0003-0447-6527",
};

const SPRING = "cubic-bezier(0.34, 1.56, 0.64, 1)";

const SP_STYLES = `
  @keyframes sp-card-in {
    from { opacity: 0; transform: translateY(10px); }
    to   { opacity: 1; transform: translateY(0);    }
  }
  .sp-btn {
    transition: transform 0.45s ${SPRING}, opacity 0.15s;
  }
  .sp-btn:active {
    transform: scale(0.94) !important;
    transition-duration: 0.07s !important;
  }
  .sp-btn:disabled { pointer-events: none; }
  .sp-stepper {
    display: flex;
    align-items: center;
    border: 1px solid var(--bd-input);
    border-radius: 9px;
    overflow: hidden;
    height: 32px;
  }
  .sp-stepper-btn {
    width: 32px;
    height: 32px;
    background: var(--bg-pill);
    border: none;
    color: var(--tx-2);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    font-family: inherit;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, color 0.12s, transform 0.4s ${SPRING};
    flex-shrink: 0;
  }
  .sp-stepper-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--tx-1);
  }
  .sp-stepper-btn:active:not(:disabled) {
    transform: scale(0.88);
    transition-duration: 0.07s;
  }
  .sp-stepper-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .sp-stepper-sep {
    width: 1px;
    height: 20px;
    background: var(--bd-input);
    flex-shrink: 0;
  }
  .sp-stepper-val {
    min-width: 38px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13.5px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
  }
  .sp-link {
    position: relative;
    transition: opacity 0.15s;
  }
  .sp-link::after {
    content: '';
    position: absolute;
    bottom: -1px; left: 0;
    width: 0; height: 1px;
    background: currentColor;
    transition: width 0.2s ease-out;
    border-radius: 1px;
  }
  .sp-link:hover { opacity: 0.85; }
  .sp-link:hover::after { width: 100%; }
  .sp-action-btn {
    display: block;
    width: 100%;
    margin-bottom: 20px;
    padding: 9px 0;
    border-radius: 9px;
    border: 0.5px solid rgba(0,0,0,0.12);
    background: rgba(0,0,0,0.05);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.70);
    color: var(--tx-2);
    font-size: 13px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    text-align: center;
    letter-spacing: -0.01em;
    transition: background 0.15s, color 0.12s, transform 0.45s ${SPRING};
  }
  .sp-action-btn:hover { background: rgba(0,0,0,0.09); color: var(--tx-1); }
  .sp-action-btn:active { transform: scale(0.97); transition-duration: 0.07s; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .sp-action-btn {
      background: rgba(255,255,255,0.08);
      border-color: rgba(255,255,255,0.16);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.35);
    }
    :root:not([data-theme="light"]) .sp-action-btn:hover { background: rgba(255,255,255,0.14); }
  }
  :root[data-theme="dark"] .sp-action-btn {
    background: rgba(255,255,255,0.08);
    border-color: rgba(255,255,255,0.16);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.35);
  }
  :root[data-theme="dark"] .sp-action-btn:hover { background: rgba(255,255,255,0.14); }
`;

// ── Section card ──────────────────────────────────────────────────────────────
function Card({ title, icon: Icon, index = 0, children }) {
  return (
    <div style={{
      border: "0.5px solid var(--bd-subtle)",
      borderRadius: 12,
      overflow: "hidden",
      marginBottom: 14,
      background: "var(--bg-surface)",
      boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
      animation: `sp-card-in 0.38s ${SPRING} both`,
      animationDelay: `${index * 75}ms`,
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "10px 16px",
        background: "var(--bg-muted)",
        borderBottom: "0.5px solid var(--bd-subtle)",
      }}>
        <Icon size={13} strokeWidth={2} style={{ color: "var(--tx-3)", flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--tx-1)", letterSpacing: "-0.015em" }}>
          {title}
        </span>
      </div>
      <div style={{ padding: "14px 16px" }}>
        {children}
      </div>
    </div>
  );
}

function FieldLabel({ children }) {
  return (
    <p style={{
      fontSize: 11, fontWeight: 700, color: "var(--tx-5)",
      textTransform: "uppercase", letterSpacing: "0.07em",
      marginBottom: 8,
    }}>
      {children}
    </p>
  );
}

function AboutRow({ label, value, mono, href }) {
  return (
    <div style={{
      display: "flex", alignItems: "center",
      padding: "9px 0",
      borderBottom: "0.5px solid var(--bd-subtle)",
      fontSize: 13.5,
      letterSpacing: "-0.01em",
    }}>
      <span style={{ color: "var(--tx-3)", fontWeight: 400, flex: 1 }}>{label}</span>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" style={{
          color: "#0891B2", textDecoration: "none", fontSize: 13,
          fontFamily: mono ? "'SF Mono', ui-monospace, monospace" : "inherit",
          display: "flex", alignItems: "center", gap: 4,
          fontWeight: 500,
        }}>
          {value}
          <ExternalLink size={10} strokeWidth={2} />
        </a>
      ) : (
        <span style={{
          color: "var(--tx-1)",
          fontFamily: mono ? "'SF Mono', ui-monospace, monospace" : "inherit",
          fontSize: mono ? 12.5 : 13.5,
          fontWeight: mono ? 500 : 500,
          letterSpacing: mono ? "0.01em" : "-0.01em",
        }}>
          {value}
        </span>
      )}
    </div>
  );
}


// ── Workers default ───────────────────────────────────────────────────────────
const WORKERS_KEY = "fws-default-workers";

function WorkersPicker() {
  const [val, setVal] = useState(() => {
    try { return Number(localStorage.getItem(WORKERS_KEY)) || 2; }
    catch { return 2; }
  });
  const [cpuCores, setCpuCores] = useState(null);

  useEffect(() => {
    invoke("detect_cpu_cores")
      .then(n => {
        setCpuCores(n);
        const stored = localStorage.getItem(WORKERS_KEY);
        if (!stored) {
          const def = Math.max(1, Math.floor(n / 2));
          setVal(def);
          try { localStorage.setItem(WORKERS_KEY, String(def)); } catch {}
        }
      })
      .catch(() => {});
  }, []);

  const pick = n => {
    setVal(n);
    try { localStorage.setItem(WORKERS_KEY, String(n)); } catch {}
  };

  return (
    <div>
      <FieldLabel>Default parallel workers</FieldLabel>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div className="sp-stepper">
          <button
            className="sp-stepper-btn"
            onClick={() => pick(Math.max(1, val - 1))}
            disabled={val <= 1}
          >−</button>
          <div className="sp-stepper-sep" />
          <div className="sp-stepper-val" style={{ color: "#7C3AED", background: "rgba(124,58,237,0.07)" }}>
            {val}
          </div>
          <div className="sp-stepper-sep" />
          <button
            className="sp-stepper-btn"
            onClick={() => pick(Math.min(cpuCores ?? 64, val + 1))}
            disabled={cpuCores !== null && val >= cpuCores}
          >+</button>
        </div>
        <span style={{ fontSize: 12.5, color: "var(--tx-3)", letterSpacing: "-0.005em" }}>
          {val === 1 ? "sequential — one case at a time" : `${val} simultaneous OpenFAST processes`}
          {cpuCores !== null && (
            <span style={{ marginLeft: 6, color: "var(--tx-4)" }}>
              <Cpu size={10} style={{ verticalAlign: "middle", marginRight: 2 }} />
              {cpuCores} cores detected
            </span>
          )}
        </span>
      </div>
      <p style={{ fontSize: 12, color: "var(--tx-4)", marginTop: 6, letterSpacing: "-0.005em" }}>
        Applied as the default when a new Simulation Batch session starts.
        Can be changed per-session in the Batch Run panel.
      </p>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function SettingsPanel({ onLog, onCheckForUpdates }) {
  const {
    resolvedPath: ofPath,
    source:       ofSource,
    overridePath: ofOverride,
    bundledVersion: ofBundled,
    setOverride:  ofSetOverride,
  } = useBinarySettings("openfast");

  const {
    resolvedPath: tsPath,
    source:       tsSource,
    overridePath: tsOverride,
    bundledVersion: tsBundled,
    setOverride:  tsSetOverride,
  } = useBinarySettings("turbsim");

  // Derive version string: prefer bundledVersion, else parse from path
  const ofVersion = ofBundled ?? (ofPath ? OF_COMPAT : null);
  const tsVersion = tsBundled ?? null;

  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column",
      overflow: "hidden", minHeight: 0,
    }}>
      <style>{SP_STYLES}</style>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "12px 20px",
        borderBottom: "0.5px solid var(--bd-subtle)",
        flexShrink: 0,
        WebkitAppRegion: "drag",
      }}>
        <Settings size={15} strokeWidth={1.8} style={{ color: "var(--tx-4)" }} />
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--tx-1)", letterSpacing: "-0.025em", WebkitAppRegion: "no-drag" }}>
          Settings
        </span>
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "18px 20px 40px" }}>

        {/* ── Binaries ── */}
        <Card title="Binaries" icon={Cpu} index={0}>
          <p style={{ fontSize: 13, color: "var(--tx-3)", marginBottom: 14, lineHeight: 1.6, letterSpacing: "-0.005em" }}>
            FlowUrja Studio ships with bundled versions of OpenFAST and TurbSim.
            Override to use a different build — useful for custom patches or newer releases.
          </p>

          <FieldLabel>OpenFAST</FieldLabel>
          <BinaryRow
            resolvedPath={ofPath}
            source={ofSource}
            version={ofVersion}
            overridePath={ofOverride}
            onSetOverride={path => {
              ofSetOverride(path);
              onLog?.("ok", path ? `OpenFAST override set → ${path}` : "OpenFAST override cleared — using bundled binary");
            }}
          />

          <div style={{ marginTop: 14 }}>
            <FieldLabel>TurbSim</FieldLabel>
            <BinaryRow
              resolvedPath={tsPath}
              source={tsSource}
              version={tsVersion}
              overridePath={tsOverride}
              onSetOverride={path => {
                tsSetOverride(path);
                onLog?.("ok", path ? `TurbSim override set → ${path}` : "TurbSim override cleared — using bundled binary");
              }}
            />
          </div>
        </Card>

        {/* ── Defaults ── */}
        <Card title="Defaults" icon={RefreshCw} index={1}>
          <WorkersPicker />
        </Card>

        {/* ── About ── */}
        <Card title="About" icon={Info} index={2}>

          {/* App info */}
          <div style={{ marginBottom: 16 }}>
            <AboutRow label="FlowUrja Studio"   value={`v${APP_VERSION}`} />
            <AboutRow label="Bundled OpenFAST"  value={`v${OF_COMPAT}`}  mono />
            <AboutRow label="Bundled TurbSim"   value={`v${TS_COMPAT}`}  mono />
            <AboutRow label="Platform"          value="macOS 13+ · Windows 10/11" />
            <AboutRow label="License"           value="Apache 2.0" />
          </div>
          {onCheckForUpdates && (
            <button className="sp-action-btn" onClick={onCheckForUpdates}>
              Check for Updates…
            </button>
          )}

          {/* Developer */}
          <p style={{ fontSize: 11, fontWeight: 700, color: "var(--tx-5)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
            Developer
          </p>
          <div style={{
            background: "var(--bg-muted)", border: "0.5px solid var(--bd-subtle)",
            borderRadius: 10, padding: "12px 14px", marginBottom: 20,
          }}>
            <p style={{ fontSize: 14, fontWeight: 600, color: "var(--tx-1)", marginBottom: 10, letterSpacing: "-0.02em" }}>
              {DEVELOPER.name}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
              {[
                { label: DEVELOPER.website,  href: `https://${DEVELOPER.website}` },
                { label: DEVELOPER.github,   href: `https://${DEVELOPER.github}` },
                { label: DEVELOPER.linkedin, href: `https://${DEVELOPER.linkedin}` },
              ].map(({ label, href }) => (
                <a key={href} href={href} target="_blank" rel="noreferrer" className="sp-link" style={{
                  fontSize: 12, color: "#0891B2", textDecoration: "none",
                  display: "flex", alignItems: "center", gap: 3,
                }}>
                  <ExternalLink size={9} strokeWidth={2} />
                  {label}
                </a>
              ))}
            </div>
          </div>

          {/* Third-party attribution */}
          <div style={{
            borderTop: "0.5px solid var(--bd-subtle)", paddingTop: 12, marginTop: 4,
            fontSize: 12, color: "var(--tx-4)", lineHeight: 1.8, letterSpacing: "-0.005em",
          }}>
            <div style={{ fontWeight: 600, color: "var(--tx-3)", marginBottom: 4, letterSpacing: "-0.005em" }}>
              Third-party components
            </div>
            <div><strong style={{ color: "var(--tx-4)" }}>OpenFAST &amp; TurbSim v4.2.0</strong> — NREL · Apache 2.0</div>
            <div><strong style={{ color: "var(--tx-4)" }}>ROSCO v2.10.1</strong> — NREL (Abbas et al., 2022) · Apache 2.0</div>
            <div style={{ marginTop: 6, fontWeight: 600, color: "var(--tx-3)", letterSpacing: "-0.005em" }}>
              Bundled reference turbines
            </div>
            <div><strong style={{ color: "var(--tx-4)" }}>NREL 5MW</strong> — Jonkman et al. (2009) NREL/TP-500-38060 · Apache 2.0</div>
            <div><strong style={{ color: "var(--tx-4)" }}>IEA 10MW</strong> — Bortolotti et al. (2019) NREL/TP-73492 · CC BY 4.0</div>
            <div><strong style={{ color: "var(--tx-4)" }}>IEA 15MW</strong> — Gaertner et al. (2020) NREL/TP-75698 · CC BY 4.0</div>
            <div><strong style={{ color: "var(--tx-4)" }}>IEA 22MW</strong> — Zahle et al. (2024) DTU E-0243 · CC BY 4.0</div>
            <div style={{ marginTop: 6, color: "var(--tx-6)" }}>
              FlowUrja Studio is an independent open-source project and is not
              affiliated with or endorsed by NREL or IEA Wind.
            </div>
          </div>

        </Card>

      </div>
    </div>
  );
}
