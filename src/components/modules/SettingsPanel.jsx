import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Settings, Cpu, Info, RefreshCw, ExternalLink } from "lucide-react";
import BinaryRow from "../BinaryRow";
import { useBinarySettings } from "../../hooks/useBinarySettings";

const APP_VERSION = "1.0.0";
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

// ── Section card ──────────────────────────────────────────────────────────────
function Card({ title, icon: Icon, children }) {
  return (
    <div style={{
      border: "0.5px solid var(--bd-subtle)",
      borderRadius: 12,
      overflow: "hidden",
      marginBottom: 14,
      background: "var(--bg-surface)",
      boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "10px 16px",
        background: "var(--bg-muted)",
        borderBottom: "0.5px solid var(--bd-subtle)",
      }}>
        <Icon size={13} strokeWidth={2} style={{ color: "var(--tx-4)", flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--tx-2)", letterSpacing: "-0.01em" }}>
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
      fontSize: 10.5, fontWeight: 700, color: "var(--tx-5)",
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
      padding: "7px 0",
      borderBottom: "0.5px solid var(--bd-subtle)",
      fontSize: 13,
    }}>
      <span style={{ color: "var(--tx-4)", flex: 1 }}>{label}</span>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" style={{
          color: "#0891B2", textDecoration: "none", fontSize: 12,
          fontFamily: mono ? "'SF Mono', ui-monospace, monospace" : "inherit",
          display: "flex", alignItems: "center", gap: 4,
        }}>
          {value}
          <ExternalLink size={10} strokeWidth={2} />
        </a>
      ) : (
        <span style={{
          color: "var(--tx-2)",
          fontFamily: mono ? "'SF Mono', ui-monospace, monospace" : "inherit",
          fontSize: mono ? 11.5 : 13,
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
        <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
          <button
            onClick={() => pick(Math.max(1, val - 1))}
            disabled={val <= 1}
            style={{ width: 28, height: 28, borderRadius: "7px 0 0 7px", border: "0.5px solid var(--bd)", background: "var(--bg-surface)", color: "var(--tx-2)", cursor: "pointer", fontSize: 16, lineHeight: 1, fontFamily: "inherit", opacity: val <= 1 ? 0.35 : 1 }}
          >−</button>
          <div style={{ width: 36, height: 28, display: "flex", alignItems: "center", justifyContent: "center", borderTop: "0.5px solid var(--bd)", borderBottom: "0.5px solid var(--bd)", background: "rgba(124,58,237,0.08)", fontSize: 13, fontWeight: 700, color: "#7C3AED" }}>{val}</div>
          <button
            onClick={() => pick(Math.min(cpuCores ?? 64, val + 1))}
            disabled={cpuCores !== null && val >= cpuCores}
            style={{ width: 28, height: 28, borderRadius: "0 7px 7px 0", border: "0.5px solid var(--bd)", background: "var(--bg-surface)", color: "var(--tx-2)", cursor: "pointer", fontSize: 16, lineHeight: 1, fontFamily: "inherit", opacity: (cpuCores !== null && val >= cpuCores) ? 0.35 : 1 }}
          >+</button>
        </div>
        <span style={{ fontSize: 11.5, color: "var(--tx-5)" }}>
          {val === 1 ? "sequential — one case at a time" : `${val} simultaneous OpenFAST processes`}
          {cpuCores !== null && (
            <span style={{ marginLeft: 6, opacity: 0.7 }}>
              <Cpu size={10} style={{ verticalAlign: "middle", marginRight: 2 }} />
              {cpuCores} cores detected
            </span>
          )}
        </span>
      </div>
      <p style={{ fontSize: 11, color: "var(--tx-5)", marginTop: 6 }}>
        Applied as the default when a new Simulation Batch session starts.
        Can be changed per-session in the Batch Run panel.
      </p>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function SettingsPanel({ onLog }) {
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
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "12px 20px",
        borderBottom: "0.5px solid var(--bd-subtle)",
        flexShrink: 0,
        WebkitAppRegion: "drag",
      }}>
        <Settings size={15} strokeWidth={1.8} style={{ color: "var(--tx-4)" }} />
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--tx-1)", letterSpacing: "-0.02em", WebkitAppRegion: "no-drag" }}>
          Settings
        </span>
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "18px 20px 40px" }}>

        {/* ── Binaries ── */}
        <Card title="Binaries" icon={Cpu}>
          <p style={{ fontSize: 12, color: "var(--tx-4)", marginBottom: 14, lineHeight: 1.6 }}>
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
        <Card title="Defaults" icon={RefreshCw}>
          <WorkersPicker />
        </Card>

        {/* ── About ── */}
        <Card title="About" icon={Info}>

          {/* App info */}
          <div style={{ marginBottom: 20 }}>
            <AboutRow label="FlowUrja Studio"   value={`v${APP_VERSION}`} />
            <AboutRow label="Bundled OpenFAST"  value={`v${OF_COMPAT}`}  mono />
            <AboutRow label="Bundled TurbSim"   value={`v${TS_COMPAT}`}  mono />
            <AboutRow label="Platform"          value="macOS 13+ · Windows 10/11" />
            <AboutRow label="License"           value="Apache 2.0" />
          </div>

          {/* Developer */}
          <p style={{ fontSize: 10.5, fontWeight: 700, color: "var(--tx-5)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
            Developer
          </p>
          <div style={{
            background: "var(--bg-muted)", border: "0.5px solid var(--bd-subtle)",
            borderRadius: 10, padding: "12px 14px", marginBottom: 20,
          }}>
            <p style={{ fontSize: 13.5, fontWeight: 700, color: "var(--tx-1)", marginBottom: 10 }}>
              {DEVELOPER.name}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
              {[
                { label: DEVELOPER.website,           href: `https://${DEVELOPER.website}` },
                { label: DEVELOPER.email,             href: `mailto:${DEVELOPER.email}` },
                { label: DEVELOPER.web,               href: `https://${DEVELOPER.web}` },
                { label: DEVELOPER.github,            href: `https://${DEVELOPER.github}` },
                { label: DEVELOPER.linkedin,          href: `https://${DEVELOPER.linkedin}` },
                { label: `ORCID ${DEVELOPER.orcid}`, href: `https://orcid.org/${DEVELOPER.orcid}` },
              ].map(({ label, href }) => (
                <a key={href} href={href} target="_blank" rel="noreferrer" style={{
                  fontSize: 11.5, color: "#0891B2", textDecoration: "none",
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
            fontSize: 11, color: "var(--tx-5)", lineHeight: 1.8,
          }}>
            <div style={{ fontWeight: 600, color: "var(--tx-4)", marginBottom: 4 }}>
              Third-party components
            </div>
            <div><strong style={{ color: "var(--tx-4)" }}>OpenFAST &amp; TurbSim v4.2.0</strong> — NREL · Apache 2.0</div>
            <div><strong style={{ color: "var(--tx-4)" }}>ROSCO v2.10.1</strong> — NREL (Abbas et al., 2022) · Apache 2.0</div>
            <div style={{ marginTop: 6, fontWeight: 600, color: "var(--tx-4)" }}>
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
