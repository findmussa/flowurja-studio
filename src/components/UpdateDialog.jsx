import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import logo from "../assets/logo.png";

const SPRING = "cubic-bezier(0.34, 1.56, 0.64, 1)";
const EXIT   = "cubic-bezier(0.55, 0, 1, 0.45)";

export default function UpdateDialog({ currentVersion, latestVersion, releaseUrl, upToDate, onClose }) {
  const [closing, setClosing] = useState(false);

  const close = () => {
    setClosing(true);
    setTimeout(onClose, 190);
  };

  const download = () => {
    invoke("open_in_finder", { path: releaseUrl }).catch(() => {});
    close();
  };

  return (
    <>
      <style>{`
        @keyframes ud-backdrop-in  { from { background: rgba(0,0,0,0); } to { background: rgba(0,0,0,0.45); } }
        @keyframes ud-backdrop-out { from { background: rgba(0,0,0,0.45); } to { background: rgba(0,0,0,0); } }
        @keyframes ud-enter { from { opacity: 0; transform: scale(0.92) translateY(10px); } to { opacity: 1; transform: scale(1) translateY(0); } }
        @keyframes ud-exit  { from { opacity: 1; transform: scale(1) translateY(0); } to { opacity: 0; transform: scale(0.96) translateY(4px); } }
        .ud-btn-secondary {
          flex: 1;
          padding: 9px 0;
          border-radius: 9px;
          border: 1px solid var(--bd-input);
          background: var(--bg-pill);
          color: var(--tx-2);
          font-size: 13px;
          font-weight: 500;
          font-family: inherit;
          cursor: pointer;
          letter-spacing: -0.01em;
          transition: background 0.15s, color 0.12s, transform 0.45s ${SPRING};
        }
        .ud-btn-secondary:hover { background: var(--bg-hover); color: var(--tx-1); }
        .ud-btn-secondary:active { transform: scale(0.96); transition-duration: 0.07s; }
        .ud-btn-primary {
          flex: 2;
          padding: 9px 0;
          border-radius: 9px;
          border: none;
          background: #0891B2;
          color: #fff;
          font-size: 13px;
          font-weight: 600;
          font-family: inherit;
          cursor: pointer;
          letter-spacing: -0.01em;
          transition: background 0.15s, transform 0.45s ${SPRING};
        }
        .ud-btn-primary:hover { background: #0777A3; }
        .ud-btn-primary:active { transform: scale(0.96); transition-duration: 0.07s; }
      `}</style>

      {/* Backdrop */}
      <div
        onClick={close}
        style={{
          position: "fixed", inset: 0, zIndex: 9999,
          display: "flex", alignItems: "center", justifyContent: "center",
          animation: `${closing ? "ud-backdrop-out" : "ud-backdrop-in"} ${closing ? "0.19s" : "0.2s"} forwards`,
          background: closing ? "rgba(0,0,0,0)" : "rgba(0,0,0,0.45)",
        }}
      >
        {/* Dialog */}
        <div
          onClick={e => e.stopPropagation()}
          style={{
            background: "var(--bg-surface)",
            backdropFilter: "blur(40px) saturate(2)",
            WebkitBackdropFilter: "blur(40px) saturate(2)",
            border: "0.5px solid var(--bd-popover)",
            borderRadius: 16,
            padding: "28px 28px 22px",
            width: 360,
            boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
            animation: `${closing ? "ud-exit" : "ud-enter"} ${closing ? `0.19s ${EXIT}` : `0.38s ${SPRING}`} forwards`,
            transformOrigin: "center center",
          }}
        >
          {/* Icon + title */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <img src={logo} alt="" style={{ width: 44, height: 44, borderRadius: 10 }} />
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--tx-1)" }}>
                {upToDate ? "You're up to date" : "Update Available"}
              </div>
              <div style={{ fontSize: 12, color: "var(--tx-3)", marginTop: 2 }}>
                FlowUrja Studio
              </div>
            </div>
          </div>

          {upToDate ? (
            <div style={{ fontSize: 12.5, color: "var(--tx-3)", lineHeight: 1.55, marginBottom: 20 }}>
              You're running the latest version —{" "}
              <span style={{ fontFamily: "monospace", color: "var(--tx-2)" }}>v{currentVersion}</span>.
            </div>
          ) : (
            <>
              {/* Version comparison */}
              <div style={{
                background: "var(--bg-muted)", border: "0.5px solid var(--bd)",
                borderRadius: 10, padding: "12px 14px", marginBottom: 20,
                display: "flex", justifyContent: "space-between", alignItems: "center",
              }}>
                <div style={{ textAlign: "center", flex: 1 }}>
                  <div style={{ fontSize: 10.5, color: "var(--tx-4)", marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.06em" }}>Current</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--tx-2)", fontFamily: "monospace" }}>v{currentVersion}</div>
                </div>
                <div style={{ color: "var(--tx-4)", fontSize: 18, paddingBottom: 2 }}>→</div>
                <div style={{ textAlign: "center", flex: 1 }}>
                  <div style={{ fontSize: 10.5, color: "var(--tx-4)", marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.06em" }}>Latest</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#0891B2", fontFamily: "monospace" }}>v{latestVersion}</div>
                </div>
              </div>
              <div style={{ fontSize: 12.5, color: "var(--tx-3)", lineHeight: 1.55, marginBottom: 20 }}>
                A new version of FlowUrja Studio is available. Click Download to get the installer directly — then run it to update.
              </div>
            </>
          )}

          {/* Buttons */}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="ud-btn-secondary" onClick={close}>
              {upToDate ? "OK" : "Later"}
            </button>
            {!upToDate && (
              <button className="ud-btn-primary" onClick={download}>
                Download v{latestVersion}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
