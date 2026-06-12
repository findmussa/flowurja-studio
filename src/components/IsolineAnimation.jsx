/**
 * Shared isoline-animation components — used by TurbSimPanel and WindFieldBatchPanel.
 *
 * All animation is driven imperatively via requestAnimationFrame + useRef so that
 * no React re-render is triggered per frame.
 */

import { useRef, useEffect } from "react";

// ── Colour helpers ─────────────────────────────────────────────────────────────
export const _lerp = (a, b, t) => Math.round(a + (b - a) * t);

/** Blue (#185FA5) top → teal (#1D9E75) bottom.
 *  When tiAsymm > 1 the lower lines warm toward amber (#F59E0B). */
export const _isoColor = (rowFrac, tiAsymm) => {
  const r0 = Math.round(24  + (29  - 24)  * rowFrac);
  const g0 = Math.round(95  + (158 - 95)  * rowFrac);
  const b0 = Math.round(165 + (117 - 165) * rowFrac);
  if (!tiAsymm || tiAsymm <= 1.0) return `rgb(${r0},${g0},${b0})`;
  const inf = Math.max(0, (rowFrac - 0.35) / 0.65) * Math.min(tiAsymm - 1, 1);
  return `rgb(${Math.round(r0+(245-r0)*inf)},${Math.round(g0+(158-g0)*inf)},${Math.round(b0+(11-b0)*inf)})`;
};

// ── IsolineHero ────────────────────────────────────────────────────────────────
/** Full-size flowing isoline hero (300×180 viewBox).
 *  Used in TurbSim dashboard and Wind Field Batch hero card. */
export function IsolineHero({ running, tiAsymmetry = 1.0 }) {
  const W = 300, H = 180, N_LINES = 8, N_PTS = 42;

  const polysRef  = useRef([]);
  const paramsRef = useRef(Array.from({ length: N_LINES }, (_, i) => ({
    ph1: (i * 1.3 + 0.5) % (Math.PI * 2),
    ph2: (i * 2.7 + 1.1) % (Math.PI * 2),
    sp1: 0.38 + i * 0.07,
    sp2: 0.71 + i * 0.04,
    k1:  0.024 + i * 0.003,
    k2:  0.051 + i * 0.002,
  })));
  const tRef   = useRef(0);
  const runRef = useRef(running);
  const tiRef  = useRef(tiAsymmetry);

  useEffect(() => { runRef.current = running;      }, [running]);
  useEffect(() => { tiRef.current  = tiAsymmetry;  }, [tiAsymmetry]);

  useEffect(() => {
    let raf;
    const animate = () => {
      tRef.current += runRef.current ? 0.042 : 0.009;
      const t  = tRef.current;
      const ti = tiRef.current;
      const runScale = runRef.current ? 2.0 : 1.0;

      polysRef.current.forEach((poly, li) => {
        if (!poly) return;
        const rowFrac = li / (N_LINES - 1);
        const tiScale = ti > 1 ? 1 + (ti - 1) * rowFrac * 0.65 : 1;
        const amp     = (8 + rowFrac * 4) * tiScale * runScale;
        const pr      = paramsRef.current[li];
        const baseY   = H * 0.1 + rowFrac * H * 0.8;

        const pts = Array.from({ length: N_PTS + 1 }, (_, j) => {
          const x = (j / N_PTS) * W;
          const y = baseY
            + amp       * Math.sin(pr.k1 * x + pr.ph1 + t * pr.sp1)
            + amp * 0.4 * Math.sin(pr.k2 * x + pr.ph2 + t * pr.sp2);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(" ");

        poly.setAttribute("points", pts);
        poly.setAttribute("stroke", _isoColor(rowFrac, ti));
        const sw = (1.0 + rowFrac * 0.8)
          + (ti > 1 ? Math.max(0, rowFrac - 0.3) * (ti - 1) * 1.2 : 0);
        poly.setAttribute("stroke-width", sw.toFixed(2));
      });

      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, []); // all dynamic values via refs

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%"
      preserveAspectRatio="xMidYMid slice" style={{ display: "block" }}>
      <defs>
        <linearGradient id="isoHeroBg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="rgba(24,95,165,0.06)" />
          <stop offset="100%" stopColor="rgba(29,158,117,0.09)" />
        </linearGradient>
        <clipPath id="isoClipTS">
          <rect x={0} y={0} width={W} height={H} rx={11} />
        </clipPath>
      </defs>
      <rect width={W} height={H} fill="url(#isoHeroBg)" />
      <g clipPath="url(#isoClipTS)">
        {Array.from({ length: N_LINES }, (_, li) => {
          const rowFrac = li / (N_LINES - 1);
          return (
            <polyline key={li}
              ref={el => { polysRef.current[li] = el; }}
              fill="none"
              stroke={_isoColor(rowFrac, tiAsymmetry)}
              strokeWidth={(1.0 + rowFrac * 0.8).toFixed(2)}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.72}
              points=""
            />
          );
        })}
        <circle cx={W / 2} cy={H / 2} r={H * 0.36}
          fill="none" stroke="rgba(180,220,255,0.30)"
          strokeWidth={1.2} strokeDasharray="5 4" />
        <circle cx={W / 2} cy={H / 2} r={4} fill="rgba(180,220,255,0.40)" />
      </g>
    </svg>
  );
}

// ── IsolineMini ────────────────────────────────────────────────────────────────
/** Compact isoline animation for sidebars (100×70 viewBox). */
export function IsolineMini({ running }) {
  const W = 100, H = 70, N_LINES = 6, N_PTS = 30;
  const polysRef  = useRef([]);
  const paramsRef = useRef(Array.from({ length: N_LINES }, (_, i) => ({
    ph1: (i * 1.3 + 0.5) % (Math.PI * 2),
    ph2: (i * 2.7 + 1.1) % (Math.PI * 2),
    sp1: 0.38 + i * 0.07,
    sp2: 0.71 + i * 0.04,
    k1:  0.030 + i * 0.004,
    k2:  0.060 + i * 0.003,
  })));
  const tRef   = useRef(0);
  const runRef = useRef(running);

  useEffect(() => { runRef.current = running; }, [running]);

  useEffect(() => {
    let raf;
    const animate = () => {
      tRef.current += runRef.current ? 0.032 : 0.007;
      const t  = tRef.current;
      const rs = runRef.current ? 1.8 : 1.0;
      polysRef.current.forEach((poly, li) => {
        if (!poly) return;
        const rowFrac = li / (N_LINES - 1);
        const amp   = (2.5 + rowFrac * 2.0) * rs;
        const pr    = paramsRef.current[li];
        const baseY = H * 0.12 + rowFrac * H * 0.76;
        const pts   = Array.from({ length: N_PTS + 1 }, (_, j) => {
          const x = (j / N_PTS) * W;
          const y = baseY
            + amp       * Math.sin(pr.k1 * x + pr.ph1 + t * pr.sp1)
            + amp * 0.4 * Math.sin(pr.k2 * x + pr.ph2 + t * pr.sp2);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(" ");
        poly.setAttribute("points", pts);
        poly.setAttribute("stroke", _isoColor(rowFrac, 1.0));
      });
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%"
      preserveAspectRatio="xMidYMid slice" style={{ display: "block" }}>
      <defs>
        <linearGradient id="isoMiniBg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="rgba(24,95,165,0.05)" />
          <stop offset="100%" stopColor="rgba(29,158,117,0.09)" />
        </linearGradient>
        <clipPath id="isoMiniClip">
          <rect x={0} y={0} width={W} height={H} rx={9} />
        </clipPath>
      </defs>
      <rect width={W} height={H} fill="url(#isoMiniBg)" />
      <g clipPath="url(#isoMiniClip)">
        {Array.from({ length: N_LINES }, (_, li) => {
          const rowFrac = li / (N_LINES - 1);
          return (
            <polyline key={li}
              ref={el => { polysRef.current[li] = el; }}
              fill="none"
              stroke={_isoColor(rowFrac, 1.0)}
              strokeWidth={(0.8 + rowFrac * 0.5).toFixed(2)}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.70}
              points=""
            />
          );
        })}
        <circle cx={W / 2} cy={H / 2} r={H * 0.34}
          fill="none" stroke="rgba(24,95,165,0.15)"
          strokeWidth={0.8} strokeDasharray="3 3" />
      </g>
    </svg>
  );
}
