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

        /* ── Glass card ── */
        .ud-card {
          position: relative;
          overflow: hidden;
          border: none;
          background: rgba(238,238,242,0.92);
          backdrop-filter: blur(32px) saturate(160%);
          -webkit-backdrop-filter: blur(32px) saturate(160%);
          box-shadow:
            inset 0  1.5px 0  0  rgba(255,255,255,0.80),
            inset 0 -1px   0  0  rgba(0,0,0,0.05),
            inset 1px  0   0  0  rgba(255,255,255,0.22),
            inset -1px 0   0  0  rgba(0,0,0,0.04),
            0  2px   4px  rgba(0,0,0,0.04),
            0  4px   8px  rgba(0,0,0,0.05),
            0  8px  16px  rgba(0,0,0,0.05),
            0 12px  28px  rgba(0,0,0,0.06),
            0 24px  48px  rgba(0,0,0,0.07),
            0 40px  80px  rgba(0,0,0,0.08),
            0 60px 120px  rgba(0,0,0,0.09);
        }
        .ud-card::after {
          content: '';
          position: absolute;
          inset: 0;
          border-radius: 16px;
          pointer-events: none;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='128' height='128'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='128' height='128' filter='url(%23g)' opacity='1'/%3E%3C/svg%3E");
          background-size: 128px 128px;
          opacity: 0.055;
          mix-blend-mode: overlay;
          z-index: 9999;
        }
        @media (prefers-color-scheme: dark) {
          :root:not([data-theme="light"]) .ud-card {
            background: rgba(48,48,54,0.92);
            box-shadow:
              inset 0  1.5px 0  0  rgba(255,255,255,0.28),
              inset 0 -1px   0  0  rgba(0,0,0,0.40),
              inset 1px  0   0  0  rgba(255,255,255,0.08),
              inset -1px 0   0  0  rgba(0,0,0,0.24),
              0  2px   4px  rgba(0,0,0,0.10),
              0  4px   8px  rgba(0,0,0,0.12),
              0  8px  16px  rgba(0,0,0,0.14),
              0 12px  28px  rgba(0,0,0,0.16),
              0 24px  48px  rgba(0,0,0,0.18),
              0 40px  80px  rgba(0,0,0,0.20),
              0 60px 120px  rgba(0,0,0,0.22);
          }
        }
        :root[data-theme="dark"] .ud-card {
          background: rgba(48,48,54,0.92);
          box-shadow:
            inset 0  1.5px 0  0  rgba(255,255,255,0.28),
            inset 0 -1px   0  0  rgba(0,0,0,0.40),
            inset 1px  0   0  0  rgba(255,255,255,0.08),
            inset -1px 0   0  0  rgba(0,0,0,0.24),
            0  2px   4px  rgba(0,0,0,0.10),
            0  4px   8px  rgba(0,0,0,0.12),
            0  8px  16px  rgba(0,0,0,0.14),
            0 12px  28px  rgba(0,0,0,0.16),
            0 24px  48px  rgba(0,0,0,0.18),
            0 40px  80px  rgba(0,0,0,0.20),
            0 60px 120px  rgba(0,0,0,0.22);
        }

        /* ── Version comparison box (glass inset field) ── */
        .ud-version-box {
          border-radius: 10px;
          padding: 12px 14px;
          margin-bottom: 20px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: rgba(0,0,0,0.05);
          border: 0.5px solid rgba(0,0,0,0.12);
          box-shadow: inset 0 1px 0 0 rgba(255,255,255,0.80), inset 0 -0.5px 0 0 rgba(0,0,0,0.06);
        }
        @media (prefers-color-scheme: dark) {
          :root:not([data-theme="light"]) .ud-version-box {
            background: rgba(255,255,255,0.07);
            border-color: rgba(255,255,255,0.14);
            box-shadow: inset 0 1px 0 0 rgba(255,255,255,0.35), inset 0 -0.5px 0 0 rgba(0,0,0,0.20);
          }
        }
        :root[data-theme="dark"] .ud-version-box {
          background: rgba(255,255,255,0.07);
          border-color: rgba(255,255,255,0.14);
          box-shadow: inset 0 1px 0 0 rgba(255,255,255,0.35), inset 0 -0.5px 0 0 rgba(0,0,0,0.20);
        }

        /* ── Buttons ── */
        .ud-btn-secondary {
          flex: 1;
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
          letter-spacing: -0.01em;
          transition: background 0.15s, color 0.12s, transform 0.45s ${SPRING};
        }
        .ud-btn-secondary:hover { background: rgba(0,0,0,0.09); color: var(--tx-1); }
        .ud-btn-secondary:active { transform: scale(0.96); transition-duration: 0.07s; }
        @media (prefers-color-scheme: dark) {
          :root:not([data-theme="light"]) .ud-btn-secondary {
            background: rgba(255,255,255,0.08);
            border-color: rgba(255,255,255,0.16);
            box-shadow: inset 0 1px 0 rgba(255,255,255,0.35);
          }
          :root:not([data-theme="light"]) .ud-btn-secondary:hover { background: rgba(255,255,255,0.14); }
        }
        :root[data-theme="dark"] .ud-btn-secondary {
          background: rgba(255,255,255,0.08);
          border-color: rgba(255,255,255,0.16);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.35);
        }
        :root[data-theme="dark"] .ud-btn-secondary:hover { background: rgba(255,255,255,0.14); }

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
          className="ud-card"
          style={{
            borderRadius: 16,
            padding: "28px 28px 22px",
            width: 360,
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
              <div className="ud-version-box">
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
