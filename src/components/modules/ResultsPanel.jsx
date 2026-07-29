import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, Children, cloneElement } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { downloadDir } from "@tauri-apps/api/path";
import { toast } from "sonner";
import {
  FolderOpen, LineChart, Search, BarChart2, X, RotateCcw,
  Eye, EyeOff, FolderSearch, Activity, Zap, Copy, Check,
  GitMerge, Bookmark, Plus, Trash2, ScatterChart as ScatterIcon,
  Download, ChevronDown, ChevronRight,
} from "lucide-react";
import s from "./ResultsPanel.module.css";

// ── Styled hover tooltip — replaces native title attributes ──────────────────
function HoverTip({ tip, children }) {
  const [pos, setPos] = useState(null);
  const tipRef = useRef(null);
  const child = Children.only(children);

  // Clamp tooltip so it never overflows the viewport edges.
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || !pos) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    let adj = pos.x;
    if (r.right  > window.innerWidth  - margin) adj -= r.right  - (window.innerWidth  - margin);
    if (r.left   < margin)                      adj += margin   - r.left;
    if (adj !== pos.x) el.style.left = adj + 'px';
  }, [pos]);

  return (
    <>
      {cloneElement(child, {
        onMouseEnter(e) {
          const r = e.currentTarget.getBoundingClientRect();
          setPos({ x: r.left + r.width / 2, y: r.top });
          child.props.onMouseEnter?.(e);
        },
        onMouseLeave(e) { setPos(null); child.props.onMouseLeave?.(e); },
      })}
      {pos && createPortal(
        <div ref={tipRef} style={{
          position:'fixed', left:pos.x, top:pos.y - 6, transform:'translate(-50%,-100%)',
          background:'var(--bg-popover, rgba(255,255,255,0.92))',
          WebkitBackdropFilter:'blur(16px) saturate(1.8)', backdropFilter:'blur(16px) saturate(1.8)',
          border:'0.5px solid var(--bd-popover, rgba(0,0,0,0.10))', borderRadius:8,
          padding:'5px 9px', fontSize:11, lineHeight:1.45, color:'var(--tx-2)',
          whiteSpace:'normal', maxWidth:190, boxShadow:'0 4px 20px rgba(0,0,0,0.14)',
          pointerEvents:'none', zIndex:99999,
          fontFamily:'-apple-system, BlinkMacSystemFont, sans-serif',
        }}>
          {tip}
        </div>,
        document.body
      )}
    </>
  );
}

// ── Theme-change → force canvas redraw ───────────────────────────────────────
function useThemeRedraw(drawFnRef) {
  useEffect(() => {
    const redraw = () => drawFnRef.current?.();
    const mo = new MutationObserver(redraw);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', redraw);
    return () => { mo.disconnect(); mq.removeEventListener('change', redraw); };
  }, []); // eslint-disable-line
}

// ── Colour palettes ───────────────────────────────────────────────────────────
const PALETTE = [
  "#0891B2","#1D9E75","#D97706","#7C3AED",
  "#EF4444","#EC4899","#F59E0B","#6366F1",
];
const RUN_COLORS    = ["#0891B2","#D97706","#7C3AED","#059669","#E11D48","#4F46E5"];
const DASH_PATTERNS = [[], [8,4], [4,4,2,4], [2,4]];

// ── Channel groups (OpenFAST naming conventions) ──────────────────────────────
const CHANNEL_GROUPS = [
  { id: 'wind',      label: 'Wind',          test: n => /^Wind/i.test(n) },
  { id: 'generator', label: 'Generator',     test: n => /^Gen/i.test(n) },
  { id: 'rotor',     label: 'Rotor / Shaft', test: n => /^(Rot|HSShft|LSShft)/i.test(n) },
  { id: 'blades',    label: 'Blades',        test: n => /^(Root|Tip|Spn|AB\d|B\d[NM])/i.test(n) },
  { id: 'tower',     label: 'Tower',         test: n => /^(TwrBs|TwrCl|YawBr|Nac)/i.test(n) },
  { id: 'platform',  label: 'Platform',      test: n => /^Ptfm/i.test(n) },
  { id: 'mooring',   label: 'Mooring',       test: n => /^(Fair|Anch|Line\d)/i.test(n) },
  { id: 'other',     label: 'Other',         test: () => true },
];

/** Canvas and text colour. All hues have ≥4:1 contrast on both white and #1a1a1c
 *  so no separate dark palette is needed — avoids theme-timing staleness bugs. */
function runColor(run)     { return RUN_COLORS[run.colorIdx % RUN_COLORS.length]; }
function runColorText(run) { return RUN_COLORS[run.colorIdx % RUN_COLORS.length]; }
function lineColor(run, chanSelIdx, nVisRuns) {
  return nVisRuns === 1 ? PALETTE[chanSelIdx % PALETTE.length] : runColor(run);
}
function lineDash(chanSelIdx, nVisRuns) {
  return nVisRuns === 1 ? [] : DASH_PATTERNS[chanSelIdx % DASH_PATTERNS.length];
}

// ── ChartLine: tiny SVG showing colour + dash pattern in tooltips / legends ──
// Used to communicate both dimensions (run=colour, channel=dash) at once.
function ChartLine({ color = 'currentColor', dash = [], width = 22, height = 10 }) {
  const sd = dash.length > 0 ? dash.join(' ') : undefined;
  return (
    <svg width={width} height={height} aria-hidden="true"
      style={{ flexShrink: 0, display: 'block' }}>
      <line x1={1} y1={height / 2} x2={width - 1} y2={height / 2}
        stroke={color} strokeWidth={2} strokeLinecap="round"
        strokeDasharray={sd} />
    </svg>
  );
}

// ── ASCII .out parser ─────────────────────────────────────────────────────────
function parseOutFile(text) {
  const lines = text.split(/\r?\n/);
  let chanLine = -1;
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    if (/^Time[\t ]/.test(lines[i].trim())) { chanLine = i; break; }
  }
  if (chanLine < 0) throw new Error("Could not find the 'Time' header row.");
  const splitH = r => {
    const t = r.trim();
    return t.includes("\t") ? t.split(/\t/).map(c => c.trim()).filter(Boolean)
                            : t.split(/\s{2,}/).map(c => c.trim()).filter(Boolean);
  };
  const channels = splitH(lines[chanLine]);
  const units    = splitH(lines[chanLine + 1] ?? '').map(u => u.replace(/[()]/g, ''));
  while (units.length < channels.length) units.push('');
  const nCols = channels.length;
  const raw = [];
  for (let i = chanLine + 2; i < lines.length; i++) {
    const ln = lines[i].trim(); if (!ln) continue;
    const nums = ln.split(/\s+/).map(Number);
    if (nums.length >= nCols && !nums.some(isNaN)) {
      const row = new Float64Array(nCols);
      for (let c = 0; c < nCols; c++) row[c] = nums[c];
      raw.push(row);
    }
  }
  if (raw.length === 0) throw new Error("No numeric data rows found.");
  const cols = channels.map((_, ci) => {
    const a = new Float64Array(raw.length);
    for (let r = 0; r < raw.length; r++) a[r] = raw[r][ci];
    return a;
  });
  return { channels, units, cols, nRows: raw.length };
}

// ── Axis helpers ─────────────────────────────────────────────────────────────
function niceTicks(lo, hi, target = 6) {
  if (hi <= lo) return [lo];
  const span = hi - lo, step0 = span / (target - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const res = step0 / mag;
  const step = res < 1.5 ? mag : res < 3 ? 2 * mag : res < 7 ? 5 * mag : 10 * mag;
  const start = Math.ceil(lo / step) * step;
  const out = [];
  for (let v = start; v <= hi + step * 1e-4; v += step) out.push(parseFloat(v.toPrecision(12)));
  return out;
}
function fmt(v) {
  if (!isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e5 || (a < 0.01 && a > 0)) return v.toExponential(3);
  return parseFloat(v.toPrecision(5)).toString();
}
function fmtFreq(f) {
  if (!isFinite(f) || f <= 0) return '—';
  if (f < 0.001) return f.toExponential(3);
  if (f < 1) return f.toPrecision(4);
  return f.toPrecision(5);
}
function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1e6)  return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1e9)  return `${(b / 1e6).toFixed(1)} MB`;
  return `${(b / 1e9).toFixed(2)} GB`;
}
function fmtDate(secs) {
  if (!secs) return '—';
  return new Date(secs * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
}

// ── Pure-JS Welch PSD ─────────────────────────────────────────────────────────
function fftInPlace(re, im) {
  const N = re.length;
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2 * Math.PI / len, wR = Math.cos(ang), wI = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cR = 1, cI = 0;
      for (let k = 0; k < (len >> 1); k++) {
        const u = i + k, v = i + k + (len >> 1);
        const vR = re[v] * cR - im[v] * cI, vI = re[v] * cI + im[v] * cR;
        re[v] = re[u] - vR; im[v] = im[u] - vI;
        re[u] += vR; im[u] += vI;
        const nR = cR * wR - cI * wI; cI = cR * wI + cI * wR; cR = nR;
      }
    }
  }
}
function welchPSD(signal, dt) {
  const N = signal.length;
  if (N < 16) return null;
  let L = 1; while (L < N / 4) L <<= 1; if (L > 8192) L = 8192;
  const hop = L >> 1;
  const win = new Float64Array(L); let wPow = 0;
  for (let i = 0; i < L; i++) { win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (L - 1))); wPow += win[i] * win[i]; }
  const nF = (L >> 1) + 1, acc = new Float64Array(nF);
  let nSeg = 0;
  const re = new Float64Array(L), im = new Float64Array(L);
  for (let seg = 0; seg + L <= N; seg += hop) {
    for (let i = 0; i < L; i++) { re[i] = signal[seg + i] * win[i]; im[i] = 0; }
    fftInPlace(re, im);
    for (let k = 0; k < nF; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    nSeg++;
  }
  if (!nSeg) return null;
  const df = 1 / (L * dt), freqs = new Float64Array(nF), psd = new Float64Array(nF);
  const sc = dt / (wPow * nSeg);
  for (let k = 0; k < nF; k++) {
    freqs[k] = k * df;
    psd[k] = acc[k] * sc * (k > 0 && k < nF - 1 ? 2 : 1);
  }
  return { freqs, psd };
}
function find1P(visRuns) {
  for (const run of visRuns) {
    const ci = run.parsed.channels.findIndex(c => c === 'GenSpeed' || c === 'RotSpeed' || c === 'HSShftV');
    if (ci < 0) continue;
    const col = run.parsed.cols[ci];
    if (!col) continue;
    let sum = 0; for (let i = 0; i < col.length; i++) sum += col[i];
    const rpm = sum / col.length;
    if (rpm > 0) return rpm / 60;
  }
  return null;
}

// ── isDark helper (shared by canvas draw fns) ────────────────────────────────
function isDark() {
  return document.documentElement.getAttribute('data-theme') === 'dark'
    || (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

// ── Rainflow cycle counting (ASTM E1049-85 four-point method) ────────────────
function rainflowCount(signal) {
  if (signal.length < 4) return [];
  // Extract turning points
  const tp = [signal[0]];
  for (let i = 1; i < signal.length - 1; i++) {
    const a = signal[i - 1], b = signal[i], c = signal[i + 1];
    if ((b > a && b >= c) || (b < a && b <= c)) tp.push(b);
  }
  tp.push(signal[signal.length - 1]);
  if (tp.length < 3) return [];
  const cycles = [];
  const st = [...tp];
  // Four-point extraction
  let i = 0;
  while (i + 2 < st.length) {
    const Y = Math.abs(st[i] - st[i + 1]);
    const X = Math.abs(st[i + 1] - st[i + 2]);
    if (X >= Y) {
      cycles.push({ range: Y, mean: (st[i] + st[i + 1]) / 2, count: 0.5 });
      st.splice(i, 1);
      if (i > 0) i--;
    } else {
      i++;
    }
  }
  // Remaining residue half-cycles
  for (let j = 0; j < st.length - 1; j++) {
    cycles.push({ range: Math.abs(st[j + 1] - st[j]), mean: (st[j] + st[j + 1]) / 2, count: 0.5 });
  }
  return cycles;
}

// ── DEL: Damage Equivalent Load ───────────────────────────────────────────────
// DEL = ( Σ(range^m · count) / feq )^(1/m)
// feq: equivalent cycles/s normalisation frequency (default 1 → raw).
function computeDEL(cycles, m, feq = 1) {
  if (!cycles.length) return null;
  let sum = 0;
  for (const { range, count } of cycles) { if (range > 0) sum += Math.pow(range, m) * count; }
  return Math.pow(sum / feq, 1 / m);
}

// ── Delta run computation ─────────────────────────────────────────────────────
// Creates a synthetic run whose channels are RunA − RunB (RunB interpolated to
// RunA's time axis so they don't need the same sampling rate).
function computeDeltaRun(runA, runB, colorIdx) {
  const tA = runA.parsed.cols[0];
  const tB = runB.parsed.cols[0];
  if (!tA || !tB) return null;
  const channels = ['Time'];
  const units    = [runA.parsed.units[0]];
  const cols     = [Float64Array.from(tA)];

  const bMap = new Map();
  for (let ci = 1; ci < runB.parsed.channels.length; ci++) bMap.set(runB.parsed.channels[ci], ci);

  for (let ci = 1; ci < runA.parsed.channels.length; ci++) {
    const name = runA.parsed.channels[ci];
    const aCol = runA.parsed.cols[ci];
    if (!aCol) { channels.push(name); units.push(runA.parsed.units[ci]); cols.push(new Float64Array(tA.length)); continue; }
    const bci  = bMap.get(name);
    const delta = new Float64Array(tA.length);

    if (bci !== undefined) {
      const bCol = runB.parsed.cols[bci];
      if (!bCol) { channels.push(name); units.push(runA.parsed.units[ci]); cols.push(delta); continue; }
      for (let i = 0; i < tA.length; i++) {
        const t = tA[i];
        // Binary search t in tB
        let lo = 0, hi = tB.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (tB[mid] < t) lo = mid + 1; else hi = mid; }
        let bv;
        if (lo === 0 || tB[lo] === t) { bv = bCol[lo]; }
        else { const f = (t - tB[lo - 1]) / (tB[lo] - tB[lo - 1]); bv = bCol[lo - 1] + f * (bCol[lo] - bCol[lo - 1]); }
        delta[i] = aCol[i] - bv;
      }
    }
    // If channel absent in B, delta stays 0
    channels.push(name);
    units.push(runA.parsed.units[ci]);
    cols.push(delta);
  }

  return {
    id: makeRunId(),
    label: `Δ ${runA.label} − ${runB.label}`,
    filePath: '',
    isDelta: true,
    parsed: { channels, units, cols, nRows: tA.length },
    colorIdx,
    visible: true,
  };
}

// ── Time-series chart ─────────────────────────────────────────────────────────
function TimeSeriesChart({ runs, selectedNames, trimCommon, transientTime, onResetRef, onCaptureRef }) {
  const canvasRef  = useRef(null);
  const wrapRef    = useRef(null);
  const drawFnRef  = useRef(null);
  const viewRef    = useRef(null);
  const hovRef     = useRef(null);
  const dragging   = useRef(false);
  const dragOrigin = useRef({ mx: 0, xMin: 0, xMax: 0 });
  const [hovTick,  setHovTick]  = useState(0);
  const [viewTick, setViewTick] = useState(0);
  const PAD = { l: 68, r: 18, t: 16, b: 38 };

  useThemeRedraw(drawFnRef);

  // Size canvas buffer synchronously before first paint so no blurry frame is ever shown.
  useLayoutEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap || !wrap.clientWidth || !wrap.clientHeight) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(wrap.clientWidth * dpr);
    canvas.height = Math.round(wrap.clientHeight * dpr);
  }, []);

  const visRuns = useMemo(() => runs.filter(r => r.visible), [runs]);
  const selArr  = useMemo(() => [...selectedNames], [selectedNames]);

  const { gMin, gMax } = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const r of visRuns) { const t = r.parsed.cols[0]; if (t && t.length) { if (t[0] < lo) lo = t[0]; if (t[t.length - 1] > hi) hi = t[t.length - 1]; } }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    return { gMin: lo, gMax: hi };
  }, [visRuns]);

  const { cMin, cMax } = useMemo(() => {
    let lo = -Infinity, hi = Infinity;
    for (const r of visRuns) { const t = r.parsed.cols[0]; if (t && t.length) { if (t[0] > lo) lo = t[0]; if (t[t.length - 1] < hi) hi = t[t.length - 1]; } }
    if (!isFinite(lo) || lo > hi) { lo = gMin; hi = gMax; }
    return { cMin: lo, cMax: hi };
  }, [visRuns, gMin, gMax]);

  const tMin = Math.max(trimCommon ? cMin : gMin, transientTime ?? 0);
  const tMax = trimCommon ? cMax : gMax;

  const autoY = useCallback((xLo, xHi) => {
    let lo = Infinity, hi = -Infinity;
    for (const r of visRuns) {
      const t = r.parsed.cols[0];
      if (!t) continue;
      for (const name of selArr) {
        const ci = r.parsed.channels.indexOf(name); if (ci < 0) continue;
        const col = r.parsed.cols[ci];
        if (!col) continue;
        for (let i = 0; i < t.length; i++) {
          if (t[i] < xLo - 1e-10 || t[i] > xHi + 1e-10) continue;
          if (trimCommon && (t[i] < cMin - 1e-10 || t[i] > cMax + 1e-10)) continue;
          if (col[i] < lo) lo = col[i]; if (col[i] > hi) hi = col[i];
        }
      }
    }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (lo === hi) { lo -= 1; hi += 1; }
    const p = (hi - lo) * 0.1;
    return { yMin: lo - p, yMax: hi + p };
  }, [visRuns, selArr, trimCommon, cMin, cMax]);

  useEffect(() => { viewRef.current = null; hovRef.current = null; setViewTick(n => n + 1); setHovTick(n => n + 1); }, [runs, selArr.join(','), transientTime]); // eslint-disable-line
  useEffect(() => { if (onResetRef) onResetRef.current = () => { viewRef.current = null; hovRef.current = null; setViewTick(n => n + 1); setHovTick(n => n + 1); }; }, [onResetRef]);
  useEffect(() => { if (onCaptureRef) onCaptureRef.current = () => canvasRef.current; }, [onCaptureRef]);

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current; if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      // Guard: resize canvas buffer if ResizeObserver hasn't fired yet after data load.
      // Skip when wrap has no layout yet (clientWidth === 0) — writing 0 to canvas
      // collapses the container, preventing ResizeObserver from ever recovering it.
      const wrap = wrapRef.current;
      if (wrap && wrap.clientWidth > 0 && wrap.clientHeight > 0 &&
          (canvas.width !== Math.round(wrap.clientWidth * dpr) || canvas.height !== Math.round(wrap.clientHeight * dpr))) {
        canvas.width = wrap.clientWidth * dpr; canvas.height = wrap.clientHeight * dpr;
        }
      const W = canvas.width / dpr, H = canvas.height / dpr;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (visRuns.length === 0 || selArr.length === 0) return;
      const xMin = viewRef.current?.xMin ?? tMin;
      const xMax = viewRef.current?.xMax ?? tMax;
      const { yMin, yMax } = autoY(xMin, xMax);
      const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
      if (plotW <= 0 || plotH <= 0) return;
      const cx = tv => PAD.l + (tv - xMin) / (xMax - xMin) * plotW;
      const cy = yv => PAD.t + (1 - (yv - yMin) / (yMax - yMin)) * plotH;
      const dark = isDark();
      const gClr  = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
      const aClr  = dark ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.18)';
      const lbClr = dark ? 'rgba(255,255,255,0.44)' : 'rgba(0,0,0,0.44)';
      ctx.font = `10.5px -apple-system,system-ui,sans-serif`;
      // Y grid
      const yTicks = niceTicks(yMin, yMax, Math.max(4, Math.floor(plotH / 48)));
      for (const tv of yTicks) {
        const py = cy(tv);
        ctx.strokeStyle = gClr; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(PAD.l, py); ctx.lineTo(PAD.l + plotW, py); ctx.stroke();
        ctx.fillStyle = lbClr; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(fmt(tv), PAD.l - 6, py);
      }
      // X grid
      const xTicks = niceTicks(xMin, xMax, Math.max(4, Math.floor(plotW / 80)));
      for (const tv of xTicks) {
        const px = cx(tv);
        ctx.strokeStyle = gClr; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px, PAD.t); ctx.lineTo(px, PAD.t + plotH); ctx.stroke();
        ctx.fillStyle = lbClr; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(fmt(tv), px, PAD.t + plotH + 6);
      }
      ctx.strokeStyle = aClr; ctx.lineWidth = 0.75;
      ctx.strokeRect(PAD.l, PAD.t, plotW, plotH);
      ctx.fillStyle = lbClr; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('Time (s)', PAD.l + plotW / 2, H - 2);
      ctx.save();
      ctx.beginPath(); ctx.rect(PAD.l, PAD.t, plotW, plotH); ctx.clip();
      const nVis = visRuns.length;
      for (let ri = 0; ri < nVis; ri++) {
        const run = visRuns[ri];
        const t = run.parsed.cols[0]; if (!t || !t.length) continue;
        const n = t.length;
        let iA = 0, iB = n - 1;
        for (let i = 0; i < n; i++) if (t[i] >= xMin) { iA = Math.max(0, i - 1); break; }
        for (let i = n - 1; i >= 0; i--) if (t[i] <= xMax) { iB = Math.min(n - 1, i + 1); break; }
        const vis = iB - iA + 1, skip = Math.max(1, Math.floor(vis / 3000));
        for (let si = 0; si < selArr.length; si++) {
          const name = selArr[si];
          const ci = run.parsed.channels.indexOf(name); if (ci < 0) continue;
          const col = run.parsed.cols[ci]; if (!col) continue;
          ctx.strokeStyle = lineColor(run, si, nVis);
          ctx.lineWidth = nVis === 1 && selArr.length === 1 ? 1.7 : 1.3;
          ctx.setLineDash(lineDash(si, nVis));
          ctx.lineJoin = 'round';
          ctx.beginPath(); let first = true;
          for (let i = iA; i <= iB; i += skip) {
            if (trimCommon && (t[i] < cMin - 1e-10 || t[i] > cMax + 1e-10)) { first = true; continue; }
            const px = cx(t[i]), py = cy(col[i]);
            if (first) { ctx.moveTo(px, py); first = false; } else ctx.lineTo(px, py);
          }
          ctx.stroke(); ctx.setLineDash([]);
        }
      }
      // Run end markers
      if (nVis > 1) {
        for (const run of visRuns) {
          const t = run.parsed.cols[0]; if (!t || !t.length) continue;
          const tEnd = t[t.length - 1];
          if (Math.abs(tEnd - tMax) < 1e-10) continue;
          const px = cx(tEnd);
          if (px < PAD.l || px > PAD.l + plotW) continue;
          ctx.strokeStyle = runColor(run) + '80';
          ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
          ctx.beginPath(); ctx.moveTo(px, PAD.t); ctx.lineTo(px, PAD.t + plotH); ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      // Hover crosshair + dots
      const hov = hovRef.current;
      if (hov !== null) {
        const hpx = cx(hov.tHov);
        ctx.strokeStyle = dark ? 'rgba(255,255,255,0.32)' : 'rgba(0,0,0,0.22)';
        ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(hpx, PAD.t); ctx.lineTo(hpx, PAD.t + plotH); ctx.stroke();
        ctx.setLineDash([]);
        for (let ri = 0; ri < nVis; ri++) {
          const run = visRuns[ri];
          const t = run.parsed.cols[0]; if (!t) continue;
          let best = 0, bestD = Infinity;
          for (let i = 0; i < t.length; i++) { const d = Math.abs(t[i] - hov.tHov); if (d < bestD) { bestD = d; best = i; } }
          if (t[best] < xMin - 1e-10 || t[best] > xMax + 1e-10) continue;
          const dotX = cx(t[best]);
          for (let si = 0; si < selArr.length; si++) {
            const ci = run.parsed.channels.indexOf(selArr[si]); if (ci < 0) continue;
            const col_ci = run.parsed.cols[ci]; if (!col_ci) continue;
            const py = cy(col_ci[best]);
            const cl = lineColor(run, si, nVis);
            ctx.fillStyle = cl; ctx.strokeStyle = dark ? '#1a1a1c' : '#fff'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(dotX, py, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          }
        }
      }
      ctx.restore();
    };
    drawFnRef.current = draw; draw();
  }, [visRuns, selArr, hovTick, viewTick, autoY, tMin, tMax, trimCommon, cMin, cMax]);

  useEffect(() => {
    const wrap = wrapRef.current; if (!wrap) return;
    const ro = new ResizeObserver(() => {
      const canvas = canvasRef.current; if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = wrap.clientWidth * dpr; canvas.height = wrap.clientHeight * dpr;
      drawFnRef.current?.();
    });
    ro.observe(wrap); return () => ro.disconnect();
  }, []);

  const onWheel = useCallback(e => {
    e.preventDefault();
    if (visRuns.length === 0) return;
    const canvas = canvasRef.current; const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr, plotW = W - PAD.l - PAD.r;
    const cur = viewRef.current;
    const xMin = cur?.xMin ?? tMin, xMax = cur?.xMax ?? tMax;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const tHov = xMin + (mx - PAD.l) / plotW * (xMax - xMin);
    const factor = e.deltaY > 0 ? 1.25 : 1 / 1.25;
    const nMin = Math.max(tMin, tHov - (tHov - xMin) * factor);
    const nMax = Math.min(tMax, tHov + (xMax - tHov) * factor);
    if (nMax - nMin < 1e-6) return;
    viewRef.current = { xMin: nMin, xMax: nMax }; setViewTick(n => n + 1);
  }, [visRuns, tMin, tMax]);

  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  const onMouseDown = useCallback(e => {
    if (visRuns.length === 0 || e.button !== 0) return;
    const cur = viewRef.current;
    dragging.current = true;
    dragOrigin.current = { mx: e.clientX, xMin: cur?.xMin ?? tMin, xMax: cur?.xMax ?? tMax };
  }, [visRuns, tMin, tMax]);

  const onMouseMove = useCallback(e => {
    const canvas = canvasRef.current; if (!canvas || visRuns.length === 0) return;
    const dpr = window.devicePixelRatio || 1, W = canvas.width / dpr, plotW = W - PAD.l - PAD.r;
    const cur = viewRef.current;
    const xMin = cur?.xMin ?? tMin, xMax = cur?.xMax ?? tMax;
    if (dragging.current) {
      const dx = e.clientX - dragOrigin.current.mx;
      const dT = (dx / plotW) * (dragOrigin.current.xMax - dragOrigin.current.xMin);
      const span = dragOrigin.current.xMax - dragOrigin.current.xMin;
      let nMin = dragOrigin.current.xMin - dT, nMax = dragOrigin.current.xMax - dT;
      if (nMin < tMin) { nMin = tMin; nMax = tMin + span; }
      if (nMax > tMax) { nMax = tMax; nMin = tMax - span; }
      viewRef.current = { xMin: nMin, xMax: nMax }; setViewTick(n => n + 1); return;
    }
    const rect = canvas.getBoundingClientRect(), mx = e.clientX - rect.left;
    if (mx < PAD.l || mx > PAD.l + plotW) { if (hovRef.current !== null) { hovRef.current = null; setHovTick(n => n + 1); } return; }
    const tHov = xMin + (mx - PAD.l) / plotW * (xMax - xMin);
    if (hovRef.current?.tHov !== tHov || hovRef.current?.mx !== mx) { hovRef.current = { tHov, mx }; setHovTick(n => n + 1); }
  }, [visRuns, tMin, tMax]);

  const onMouseUp    = useCallback(() => { dragging.current = false; }, []);
  const onMouseLeave = useCallback(() => { dragging.current = false; if (hovRef.current !== null) { hovRef.current = null; setHovTick(n => n + 1); } }, []);

  const hov = hovRef.current;
  const nVis = visRuns.length;
  const hovRows = useMemo(() => {
    if (!hov || nVis === 0 || selArr.length === 0) return null;
    const rows = [];
    for (const run of visRuns) {
      const t = run.parsed.cols[0]; if (!t) continue;
      let best = 0, bestD = Infinity;
      for (let i = 0; i < t.length; i++) { const d = Math.abs(t[i] - hov.tHov); if (d < bestD) { bestD = d; best = i; } }
      for (let si = 0; si < selArr.length; si++) {
        const name = selArr[si];
        const ci = run.parsed.channels.indexOf(name);
        const col_ci = ci >= 0 ? run.parsed.cols[ci] : null;
        rows.push({
          runId: run.id, run, name, si,
          val: col_ci ? col_ci[best] : null,
          unit: ci >= 0 ? run.parsed.units[ci] : '',
          t: t[best],
        });
      }
    }
    return rows;
  }, [hov, visRuns, selArr, nVis, hovTick]); // eslint-disable-line

  const tooltipLeft = useMemo(() => {
    if (!hov || !canvasRef.current) return 80;
    return Math.min((hov.mx ?? 80) + 14, (canvasRef.current.clientWidth ?? 600) - 200);
  }, [hov]);

  return (
    <div ref={wrapRef} className={s.chartWrap}>
      <canvas ref={canvasRef} className={s.chartCanvas}
        style={{ cursor: dragging.current ? 'grabbing' : 'crosshair' }}
        onMouseDown={onMouseDown} onMouseMove={onMouseMove}
        onMouseUp={onMouseUp} onMouseLeave={onMouseLeave} />
      {hovRows && (
        <div className={s.tooltip} style={{ left: tooltipLeft }}>
          <div className={s.tooltipTime}>t = {fmt(hovRows[0]?.t ?? 0)} s</div>
          {nVis === 1
            ? hovRows.map((r, i) => (
                <div key={i} className={s.tooltipRow}>
                  <ChartLine color={lineColor(r.run, r.si, 1)} dash={[]} width={18} height={8} />
                  <span className={s.tooltipName}>{r.name}</span>
                  <span className={s.tooltipVal}>{r.val !== null ? fmt(r.val) : '—'}</span>
                  <span className={s.tooltipUnit}>{r.unit}</span>
                </div>
              ))
            : visRuns.map(run => (
                <div key={run.id} className={s.tooltipRunGroup}>
                  <div className={s.tooltipRunLabel} style={{ color: runColorText(run) }}>{run.label}</div>
                  {hovRows.filter(r => r.runId === run.id).map((r, i) => (
                    <div key={i} className={s.tooltipRow}>
                      {/* Line with run colour + channel dash pattern — both dimensions at once */}
                      <ChartLine color={runColor(run)} dash={lineDash(r.si, nVis)} width={18} height={8} />
                      <span className={s.tooltipName}>{r.name}</span>
                      <span className={s.tooltipVal}>{r.val !== null ? fmt(r.val) : '—'}</span>
                      <span className={s.tooltipUnit}>{r.unit}</span>
                    </div>
                  ))}
                </div>
              ))
          }
        </div>
      )}
    </div>
  );
}

// ── FFT chart (log-log PSD, with pan / zoom / crosshair / tooltip) ────────────
function FFTChart({ runs, selectedNames, transientTime, onResetRef, onCaptureRef }) {
  const canvasRef  = useRef(null);
  const wrapRef    = useRef(null);
  const drawFnRef  = useRef(null);
  // viewRef: null = auto-range; or {lFlo,lFhi,lPlo,lPhi} (log10 extents)
  const viewRef    = useRef(null);
  // autoRangeRef: always-fresh copy of the autoRange memo, for use in event handlers
  const autoRangeRef = useRef(null);
  const hovRef     = useRef(null);       // {mx, fHov}
  const dragging   = useRef(false);
  const dragOrigin = useRef({});
  const [hovTick,  setHovTick]  = useState(0);
  const [viewTick, setViewTick] = useState(0);
  const PAD = { l: 68, r: 18, t: 20, b: 38 };

  useThemeRedraw(drawFnRef);

  useLayoutEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap || !wrap.clientWidth || !wrap.clientHeight) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(wrap.clientWidth * dpr);
    canvas.height = Math.round(wrap.clientHeight * dpr);
  }, []);

  const visRuns = useMemo(() => runs.filter(r => r.visible), [runs]);
  const selArr  = useMemo(() => [...selectedNames], [selectedNames]);
  const nVis    = visRuns.length;

  // ── Compute PSDs ────────────────────────────────────────────────────────────
  const psds = useMemo(() => {
    if (visRuns.length === 0 || selArr.length === 0) return [];
    const tt = transientTime ?? 0;
    const out = [];
    for (const run of visRuns) {
      const t = run.parsed.cols[0]; if (!t) continue;
      const dt = t.length >= 2 ? (t[1] - t[0]) : 0.05;
      const iStart = tt > 0 ? Math.max(0, t.findIndex(v => v >= tt)) : 0;
      for (let si = 0; si < selArr.length; si++) {
        const name = selArr[si];
        const ci = run.parsed.channels.indexOf(name); if (ci < 0) continue;
        const col = run.parsed.cols[ci]; if (!col) continue;
        const sliced = iStart > 0 ? col.subarray(iStart) : col;
        const psd = welchPSD(sliced, dt); if (!psd) continue;
        out.push({ run, name, si, freqs: psd.freqs, psd: psd.psd, unit: run.parsed.units[ci] });
      }
    }
    return out;
  }, [visRuns, selArr, transientTime]); // eslint-disable-line

  const oneP = useMemo(() => find1P(visRuns), [visRuns]);

  // ── Auto range (log10 extents of the data) ──────────────────────────────────
  const autoRange = useMemo(() => {
    let fMin = Infinity, fMax = -Infinity, pMin = Infinity, pMax = -Infinity;
    for (const { freqs, psd } of psds) {
      for (let k = 1; k < freqs.length; k++) {
        if (freqs[k] <= 0) continue;
        if (freqs[k] < fMin) fMin = freqs[k]; if (freqs[k] > fMax) fMax = freqs[k];
        if (psd[k] > 0) { if (psd[k] < pMin) pMin = psd[k]; if (psd[k] > pMax) pMax = psd[k]; }
      }
    }
    if (!isFinite(fMin) || fMin <= 0) return null;
    return {
      lFlo: Math.floor(Math.log10(fMin)),
      lFhi: Math.ceil(Math.log10(fMax)),
      lPlo: Math.floor(Math.log10(pMin)),
      lPhi: Math.ceil(Math.log10(pMax)) + 1,
    };
  }, [psds]);

  // Keep autoRangeRef in sync for event handlers
  useEffect(() => { autoRangeRef.current = autoRange; }, [autoRange]);

  // Reset view whenever the PSD data changes
  useEffect(() => {
    viewRef.current = null;
    hovRef.current  = null;
    setViewTick(n => n + 1);
    setHovTick(n => n + 1);
  }, [psds]);

  // Expose reset + capture to parent
  useEffect(() => {
    if (onResetRef) onResetRef.current = () => {
      viewRef.current = null;
      hovRef.current  = null;
      setViewTick(n => n + 1);
      setHovTick(n => n + 1);
    };
  }, [onResetRef]);
  useEffect(() => { if (onCaptureRef) onCaptureRef.current = () => canvasRef.current; }, [onCaptureRef]);

  // ── Main draw ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current; if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      // Guard: resize canvas buffer if ResizeObserver hasn't fired yet after data load.
      // Skip when wrap has no layout yet (clientWidth === 0) — writing 0 to canvas
      // collapses the container, preventing ResizeObserver from ever recovering it.
      const wrap = wrapRef.current;
      if (wrap && wrap.clientWidth > 0 && wrap.clientHeight > 0 &&
          (canvas.width !== Math.round(wrap.clientWidth * dpr) || canvas.height !== Math.round(wrap.clientHeight * dpr))) {
        canvas.width = wrap.clientWidth * dpr; canvas.height = wrap.clientHeight * dpr;
        }
      const W = canvas.width / dpr, H = canvas.height / dpr;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (psds.length === 0) return;
      const ar = autoRange; if (!ar) return;

      const lFlo = viewRef.current?.lFlo ?? ar.lFlo;
      const lFhi = viewRef.current?.lFhi ?? ar.lFhi;
      const lPlo = viewRef.current?.lPlo ?? ar.lPlo;
      const lPhi = viewRef.current?.lPhi ?? ar.lPhi;
      // Keep ref fresh so handlers can read effective range
      autoRangeRef.current = { lFlo, lFhi, lPlo, lPhi };

      const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
      if (plotW <= 0 || plotH <= 0) return;
      const cxF = f  => PAD.l + (Math.log10(f) - lFlo) / (lFhi - lFlo) * plotW;
      const cyP = p  => PAD.t + (1 - (Math.log10(p) - lPlo) / (lPhi - lPlo)) * plotH;

      const dark  = isDark();
      const gClr  = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
      const gClr2 = dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)';
      const aClr  = dark ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.18)';
      const lbClr = dark ? 'rgba(255,255,255,0.44)' : 'rgba(0,0,0,0.44)';
      ctx.font = `10.5px -apple-system,system-ui,sans-serif`;

      // Frequency grid (log)
      for (let lf = Math.ceil(lFlo - 0.01); lf <= Math.floor(lFhi + 0.01); lf++) {
        const f = Math.pow(10, lf), px = cxF(f);
        if (px < PAD.l - 1 || px > PAD.l + plotW + 1) continue;
        ctx.strokeStyle = gClr; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px, PAD.t); ctx.lineTo(px, PAD.t + plotH); ctx.stroke();
        ctx.fillStyle = lbClr; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const label = f < 0.01 ? f.toExponential(0) : f < 1 ? f.toPrecision(2) : String(f);
        ctx.fillText(label, px, PAD.t + plotH + 5);
        for (const m of [2, 3, 5, 7]) {
          const fm = f * m; if (fm > Math.pow(10, lFhi + 0.1)) continue;
          const pmx = cxF(fm);
          if (pmx < PAD.l || pmx > PAD.l + plotW) continue;
          ctx.strokeStyle = gClr2; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(pmx, PAD.t); ctx.lineTo(pmx, PAD.t + plotH); ctx.stroke();
        }
      }
      // PSD grid (log)
      for (let lp = Math.ceil(lPlo - 0.01); lp <= Math.floor(lPhi + 0.01); lp++) {
        const p = Math.pow(10, lp), py = cyP(p);
        if (py < PAD.t - 1 || py > PAD.t + plotH + 1) continue;
        ctx.strokeStyle = gClr; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(PAD.l, py); ctx.lineTo(PAD.l + plotW, py); ctx.stroke();
        ctx.fillStyle = lbClr; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(lp === 0 ? '1' : `1e${lp}`, PAD.l - 5, py);
      }
      // Axis border + X-label
      ctx.strokeStyle = aClr; ctx.lineWidth = 0.75;
      ctx.strokeRect(PAD.l, PAD.t, plotW, plotH);
      ctx.fillStyle = lbClr; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('Frequency (Hz)', PAD.l + plotW / 2, H - 2);

      // 1P / 3P / 6P markers
      if (oneP) {
        const amber    = dark ? 'rgba(251,191,36,0.55)' : 'rgba(180,83,9,0.45)';
        const amberLbl = dark ? 'rgba(251,191,36,0.9)'  : 'rgba(180,83,9,0.8)';
        for (const [h, lbl] of [[1, '1P'], [3, '3P'], [6, '6P']]) {
          const fH = oneP * h;
          if (fH <= 0 || Math.log10(fH) < lFlo || Math.log10(fH) > lFhi) continue;
          const px = cxF(fH);
          ctx.strokeStyle = amber; ctx.lineWidth = 1.2; ctx.setLineDash([5, 3]);
          ctx.beginPath(); ctx.moveTo(px, PAD.t); ctx.lineTo(px, PAD.t + plotH); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = amberLbl; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          ctx.font = `9.5px -apple-system,system-ui,sans-serif`;
          ctx.fillText(lbl, px, PAD.t + 3);
          ctx.font = `10.5px -apple-system,system-ui,sans-serif`;
        }
      }

      // PSD lines
      ctx.save();
      ctx.beginPath(); ctx.rect(PAD.l, PAD.t, plotW, plotH); ctx.clip();
      for (const { run, si, freqs, psd } of psds) {
        ctx.strokeStyle = lineColor(run, si, nVis);
        ctx.lineWidth = 1.3;
        ctx.setLineDash(lineDash(si, nVis));
        ctx.lineJoin = 'round';
        ctx.beginPath(); let first = true;
        for (let k = 1; k < freqs.length; k++) {
          if (freqs[k] <= 0 || psd[k] <= 0) continue;
          const lf = Math.log10(freqs[k]);
          if (lf < lFlo - 0.01 || lf > lFhi + 0.01) { first = true; continue; }
          const px = cxF(freqs[k]);
          const lp = Math.log10(psd[k]);
          const py = PAD.t + (1 - (lp - lPlo) / (lPhi - lPlo)) * plotH;
          if (py < PAD.t - 60 || py > PAD.t + plotH + 60) { first = true; continue; }
          if (first) { ctx.moveTo(px, py); first = false; } else ctx.lineTo(px, py);
        }
        ctx.stroke(); ctx.setLineDash([]);
      }

      // Hover crosshair + dots
      const hov = hovRef.current;
      if (hov && hov.fHov > 0) {
        const lFHov = Math.log10(hov.fHov);
        if (lFHov >= lFlo && lFHov <= lFhi) {
          const hpx = cxF(hov.fHov);
          ctx.strokeStyle = dark ? 'rgba(255,255,255,0.32)' : 'rgba(0,0,0,0.22)';
          ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.moveTo(hpx, PAD.t); ctx.lineTo(hpx, PAD.t + plotH); ctx.stroke();
          ctx.setLineDash([]);
          for (const { run, si, freqs, psd } of psds) {
            let best = 1, bestD = Infinity;
            for (let k = 1; k < freqs.length; k++) {
              if (freqs[k] <= 0) continue;
              const d = Math.abs(Math.log10(freqs[k]) - lFHov);
              if (d < bestD) { bestD = d; best = k; }
            }
            if (psd[best] <= 0) continue;
            const px = cxF(freqs[best]);
            const lp = Math.log10(psd[best]);
            const py = PAD.t + (1 - (lp - lPlo) / (lPhi - lPlo)) * plotH;
            if (py < PAD.t || py > PAD.t + plotH) continue;
            const cl = lineColor(run, si, nVis);
            ctx.fillStyle = cl; ctx.strokeStyle = dark ? '#1a1a1c' : '#fff'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          }
        }
      }
      ctx.restore();
    };
    drawFnRef.current = draw; draw();
  }, [psds, oneP, nVis, autoRange, hovTick, viewTick]);

  // Resize observer
  useEffect(() => {
    const wrap = wrapRef.current; if (!wrap) return;
    const ro = new ResizeObserver(() => {
      const canvas = canvasRef.current; if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = wrap.clientWidth * dpr; canvas.height = wrap.clientHeight * dpr;
      drawFnRef.current?.();
    });
    ro.observe(wrap); return () => ro.disconnect();
  }, []);

  // ── Wheel zoom (frequency axis) ─────────────────────────────────────────────
  const onWheel = useCallback(e => {
    e.preventDefault();
    if (psds.length === 0) return;
    const ar = autoRangeRef.current; if (!ar) return;
    const canvas = canvasRef.current; const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr, plotW = W - PAD.l - PAD.r;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const frac = Math.max(0, Math.min(1, (mx - PAD.l) / plotW));
    const lFHov = ar.lFlo + frac * (ar.lFhi - ar.lFlo);
    const factor = e.deltaY > 0 ? 1.3 : 1 / 1.3; // expand or contract log range
    const nLFlo = lFHov - (lFHov - ar.lFlo) * factor;
    const nLFhi = lFHov + (ar.lFhi - lFHov) * factor;
    if (nLFhi - nLFlo < 0.05) return;
    viewRef.current = { lFlo: nLFlo, lFhi: nLFhi, lPlo: ar.lPlo, lPhi: ar.lPhi };
    setViewTick(n => n + 1);
  }, [psds]);

  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  // ── Drag pan (both axes) ────────────────────────────────────────────────────
  const onMouseDown = useCallback(e => {
    if (psds.length === 0 || e.button !== 0) return;
    const ar = autoRangeRef.current; if (!ar) return;
    dragging.current = true;
    dragOrigin.current = { mx: e.clientX, my: e.clientY, ...ar };
  }, [psds]);

  const onMouseMove = useCallback(e => {
    const canvas = canvasRef.current; if (!canvas || psds.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr, H = canvas.height / dpr;
    const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
    const ar = autoRangeRef.current; if (!ar) return;

    if (dragging.current) {
      const dx = e.clientX - dragOrigin.current.mx;
      const dy = e.clientY - dragOrigin.current.my;
      // dx > 0 means mouse moved right → shift frequency view left (smaller freq)
      const dLF = -(dx / plotW) * (dragOrigin.current.lFhi - dragOrigin.current.lFlo);
      // dy > 0 means mouse moved down → PSD axis shifts up
      const dLP =  (dy / plotH) * (dragOrigin.current.lPhi - dragOrigin.current.lPlo);
      viewRef.current = {
        lFlo: dragOrigin.current.lFlo + dLF,
        lFhi: dragOrigin.current.lFhi + dLF,
        lPlo: dragOrigin.current.lPlo + dLP,
        lPhi: dragOrigin.current.lPhi + dLP,
      };
      setViewTick(n => n + 1); return;
    }

    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    if (mx < PAD.l || mx > PAD.l + plotW) {
      if (hovRef.current !== null) { hovRef.current = null; setHovTick(n => n + 1); }
      return;
    }
    const lFHov = ar.lFlo + (mx - PAD.l) / plotW * (ar.lFhi - ar.lFlo);
    hovRef.current = { mx, fHov: Math.pow(10, lFHov) };
    setHovTick(n => n + 1);
  }, [psds]);

  const onMouseUp    = useCallback(() => { dragging.current = false; }, []);
  const onMouseLeave = useCallback(() => {
    dragging.current = false;
    if (hovRef.current !== null) { hovRef.current = null; setHovTick(n => n + 1); }
  }, []);

  // ── Tooltip data ────────────────────────────────────────────────────────────
  const hov = hovRef.current;
  const hovRows = useMemo(() => {
    if (!hov || psds.length === 0) return null;
    return psds.map(({ run, name, si, freqs, psd, unit }) => {
      let best = 1, bestD = Infinity;
      for (let k = 1; k < freqs.length; k++) {
        if (freqs[k] <= 0) continue;
        const d = Math.abs(Math.log10(freqs[k] / hov.fHov));
        if (d < bestD) { bestD = d; best = k; }
      }
      return { run, name, si, freq: freqs[best], psdVal: psd[best], unit };
    });
  }, [hov, psds, hovTick]); // eslint-disable-line

  const tooltipLeft = useMemo(() => {
    if (!hov || !canvasRef.current) return 80;
    return Math.min((hov.mx ?? 80) + 14, (canvasRef.current.clientWidth ?? 600) - 210);
  }, [hov]);

  return (
    <div ref={wrapRef} className={s.chartWrap}>
      <canvas ref={canvasRef} className={s.chartCanvas}
        style={{ cursor: dragging.current ? 'grabbing' : 'crosshair' }}
        onMouseDown={onMouseDown} onMouseMove={onMouseMove}
        onMouseUp={onMouseUp} onMouseLeave={onMouseLeave} />

      {psds.length === 0 && (
        <div className={s.chartPlaceholder}>
          {visRuns.length === 0 ? 'Load a run to see the power spectrum' : 'Select channels to compute PSD'}
        </div>
      )}

      {hovRows && (
        <div className={s.tooltip} style={{ left: tooltipLeft }}>
          <div className={s.tooltipTime}>f = {fmtFreq(hov.fHov)} Hz</div>
          {nVis === 1
            ? hovRows.map((r, i) => (
                <div key={i} className={s.tooltipRow}>
                  <ChartLine color={lineColor(r.run, r.si, 1)} dash={[]} width={18} height={8} />
                  <span className={s.tooltipName}>{r.name}</span>
                  <span className={s.tooltipVal}>{r.psdVal > 0 ? r.psdVal.toExponential(3) : '—'}</span>
                  <span className={s.tooltipUnit}>{r.unit}²/Hz</span>
                </div>
              ))
            : visRuns.map(run => (
                <div key={run.id} className={s.tooltipRunGroup}>
                  <div className={s.tooltipRunLabel} style={{ color: runColorText(run) }}>{run.label}</div>
                  {hovRows.filter(r => r.run.id === run.id).map((r, i) => (
                    <div key={i} className={s.tooltipRow}>
                      <ChartLine color={runColor(run)} dash={lineDash(r.si, nVis)} width={18} height={8} />
                      <span className={s.tooltipName}>{r.name}</span>
                      <span className={s.tooltipVal}>{r.psdVal > 0 ? r.psdVal.toExponential(3) : '—'}</span>
                      <span className={s.tooltipUnit}>{r.unit}²/Hz</span>
                    </div>
                  ))}
                </div>
              ))
          }
        </div>
      )}

      {oneP && (
        <div className={s.fftHint}>
          1P = {oneP.toFixed(4)} Hz · 3P = {(3 * oneP).toFixed(4)} Hz
        </div>
      )}
    </div>
  );
}

// ── Delta-run modal ───────────────────────────────────────────────────────────
function DeltaModal({ runs, onClose, onAdd }) {
  const real = runs.filter(r => !r.isDelta);
  const [aId, setAId] = useState(real[0]?.id ?? '');
  const [bId, setBId] = useState(real[1]?.id ?? real[0]?.id ?? '');

  const create = () => {
    const runA = real.find(r => r.id === aId);
    const runB = real.find(r => r.id === bId);
    if (!runA || !runB || runA.id === runB.id) return;
    onAdd(computeDeltaRun(runA, runB, runs.length % RUN_COLORS.length));
    onClose();
  };

  return (
    <div className={s.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={s.deltaModal}>
        <div className={s.deltaModalHeader}>
          <GitMerge size={14} strokeWidth={1.8} />
          <span>Create delta run</span>
          <button className={s.closeBtn2} onClick={onClose}><X size={13} strokeWidth={2} /></button>
        </div>
        {real.length < 2
          ? <div className={s.deltaBody}><p style={{ color: 'var(--tx-4)', fontSize: 13 }}>Load at least 2 runs to create a delta.</p></div>
          : <>
              <div className={s.deltaBody}>
                <label className={s.deltaLabel}>Run A (minuend)</label>
                <select className={s.deltaSelect} value={aId} onChange={e => setAId(e.target.value)}>
                  {real.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
                <label className={s.deltaLabel}>Run B (subtracted)</label>
                <select className={s.deltaSelect} value={bId} onChange={e => setBId(e.target.value)}>
                  {real.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
                <p className={s.deltaHint}>
                  Creates a virtual run <strong>Δ = A − B</strong> for all shared channels,
                  with RunB interpolated to RunA's time axis.
                </p>
              </div>
              <div className={s.deltaFooter}>
                <button className={s.deltaCancelBtn} onClick={onClose}>Cancel</button>
                <button className={s.deltaCreateBtn} disabled={!aId || !bId || aId === bId} onClick={create}>
                  Create Δ run
                </button>
              </div>
            </>
        }
      </div>
    </div>
  );
}

// ── Channel preset popup ──────────────────────────────────────────────────────
//
// Rendered via createPortal to escape ancestor overflow:hidden clipping
// (.chanPanel clips otherwise). Position is fixed and derived from the
// anchor button's bounding rect — same pattern as InfoPopover.
function PresetPopup({ presets, currentChannels, onSave, onApply, onDelete, onClose, anchorRef }) {
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [pos, setPos] = useState(null);
  const popupRef = useRef(null);

  // Position synchronously before paint so the popup never flashes at origin.
  useLayoutEffect(() => {
    const r = anchorRef?.current?.getBoundingClientRect();
    if (!r) return;
    const POPUP_W = 230;
    let left = r.right - POPUP_W;          // right-align with the button
    if (left < 8) left = 8;
    if (left + POPUP_W > window.innerWidth - 8) left = window.innerWidth - POPUP_W - 8;
    setPos({ top: r.bottom + 5, left });
  }, [anchorRef]);

  // Close on outside click (matches InfoPopover pattern)
  useEffect(() => {
    const onDown = (e) => {
      if (popupRef.current?.contains(e.target)) return;
      if (anchorRef?.current?.contains(e.target)) return;
      onClose();
    };
    const id = setTimeout(() => document.addEventListener('mousedown', onDown), 10);
    return () => { clearTimeout(id); document.removeEventListener('mousedown', onDown); };
  }, [anchorRef, onClose]);

  const confirm = () => {
    if (!newName.trim()) return;
    onSave(newName.trim(), currentChannels);
    setSaving(false); setNewName(''); onClose();
  };

  if (!pos) return null;

  return createPortal(
    <div
      ref={popupRef}
      className={s.presetPopup}
      style={{ position: 'fixed', top: pos.top, left: pos.left, right: 'auto', width: 230 }}
      onMouseDown={e => e.stopPropagation()}
    >
      <div className={s.presetHeader}>
        <span className={s.presetTitle}>Channel presets</span>
        <button className={s.presetCloseBtn} onClick={onClose}><X size={11} strokeWidth={2.5} /></button>
      </div>
      {presets.length === 0 && !saving && (
        <div className={s.presetEmpty}>No saved presets — save your current selection below.</div>
      )}
      {presets.map(p => (
        <div key={p.name} className={s.presetRow}>
          <button className={s.presetApplyBtn} onClick={() => { onApply(p.channels); onClose(); }}>
            {p.name}
            <span className={s.presetCount}>{p.channels.length} ch</span>
          </button>
          <button className={s.presetDeleteBtn} onClick={() => onDelete(p.name)} title="Delete preset">
            <Trash2 size={10} strokeWidth={2} />
          </button>
        </div>
      ))}
      {saving
        ? (
          <div className={s.presetSaveRow}>
            <input className={s.presetNameInput} value={newName} autoFocus
              placeholder="Preset name…"
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') { setSaving(false); setNewName(''); } }} />
            <button className={s.presetSaveConfirmBtn} disabled={!newName.trim()} onClick={confirm}>Save</button>
          </div>
        )
        : (
          <div className={s.presetNewBtnWrap}>
            <button className={s.presetNewBtn} disabled={currentChannels.length === 0} onClick={() => setSaving(true)}>
              <Plus size={11} strokeWidth={2.5} /> Save current selection
            </button>
          </div>
        )
      }
    </div>,
    document.body
  );
}

// ── Scatter / correlation chart ───────────────────────────────────────────────
function ScatterChart({ runs, xName, yName, onCaptureRef }) {
  const canvasRef = useRef(null);
  const wrapRef   = useRef(null);
  const drawFnRef = useRef(null);
  const hovRef    = useRef(null);
  const [hovTick, setHovTick] = useState(0);
  const PAD = { l: 68, r: 18, t: 16, b: 38 };

  useThemeRedraw(drawFnRef);

  useLayoutEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap || !wrap.clientWidth || !wrap.clientHeight) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(wrap.clientWidth * dpr);
    canvas.height = Math.round(wrap.clientHeight * dpr);
  }, []);

  const visRuns = useMemo(() => runs.filter(r => r.visible), [runs]);

  // Flatten points from all visible runs
  const data = useMemo(() => {
    const pts = [];
    for (const run of visRuns) {
      const xi = run.parsed.channels.indexOf(xName);
      const yi = run.parsed.channels.indexOf(yName);
      if (xi < 0 || yi < 0) continue;
      const xc = run.parsed.cols[xi], yc = run.parsed.cols[yi];
      if (!xc || !yc) continue;
      for (let i = 0; i < xc.length; i++) pts.push({ x: xc[i], y: yc[i], run });
    }
    return pts;
  }, [visRuns, xName, yName]);

  const { xMin, xMax, yMin, yMax } = useMemo(() => {
    if (!data.length) return { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of data) {
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    if (x0 === x1) { x0 -= 1; x1 += 1; }
    if (y0 === y1) { y0 -= 1; y1 += 1; }
    const xp = (x1 - x0) * 0.06, yp = (y1 - y0) * 0.06;
    return { xMin: x0 - xp, xMax: x1 + xp, yMin: y0 - yp, yMax: y1 + yp };
  }, [data]);

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current; if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      // Guard: resize canvas buffer if ResizeObserver hasn't fired yet after data load.
      // Skip when wrap has no layout yet (clientWidth === 0) — writing 0 to canvas
      // collapses the container, preventing ResizeObserver from ever recovering it.
      const wrap = wrapRef.current;
      if (wrap && wrap.clientWidth > 0 && wrap.clientHeight > 0 &&
          (canvas.width !== Math.round(wrap.clientWidth * dpr) || canvas.height !== Math.round(wrap.clientHeight * dpr))) {
        canvas.width = wrap.clientWidth * dpr; canvas.height = wrap.clientHeight * dpr;
        }
      const W = canvas.width / dpr, H = canvas.height / dpr;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (!data.length) return;
      const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
      if (plotW <= 0 || plotH <= 0) return;
      const cx = v => PAD.l + (v - xMin) / (xMax - xMin) * plotW;
      const cy = v => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * plotH;
      const dark  = isDark();
      const gClr  = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
      const aClr  = dark ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.18)';
      const lbClr = dark ? 'rgba(255,255,255,0.44)' : 'rgba(0,0,0,0.44)';
      ctx.font = `10.5px -apple-system,system-ui,sans-serif`;
      // Grid
      for (const tv of niceTicks(xMin, xMax, 5)) {
        const px = cx(tv);
        ctx.strokeStyle = gClr; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px, PAD.t); ctx.lineTo(px, PAD.t + plotH); ctx.stroke();
        ctx.fillStyle = lbClr; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(fmt(tv), px, PAD.t + plotH + 5);
      }
      for (const tv of niceTicks(yMin, yMax, 5)) {
        const py = cy(tv);
        ctx.strokeStyle = gClr; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(PAD.l, py); ctx.lineTo(PAD.l + plotW, py); ctx.stroke();
        ctx.fillStyle = lbClr; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(fmt(tv), PAD.l - 5, py);
      }
      ctx.strokeStyle = aClr; ctx.lineWidth = 0.75;
      ctx.strokeRect(PAD.l, PAD.t, plotW, plotH);
      ctx.fillStyle = lbClr; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(xName, PAD.l + plotW / 2, H - 2);
      // Points (decimate for large datasets)
      ctx.save(); ctx.beginPath(); ctx.rect(PAD.l, PAD.t, plotW, plotH); ctx.clip();
      const skip = Math.max(1, Math.floor(data.length / 6000));
      for (let i = 0; i < data.length; i += skip) {
        const p = data[i];
        ctx.fillStyle = runColor(p.run) + 'aa';
        ctx.beginPath(); ctx.arc(cx(p.x), cy(p.y), 2, 0, Math.PI * 2); ctx.fill();
      }
      // Hover dot
      const hov = hovRef.current;
      if (hov) {
        const dark2 = isDark();
        ctx.fillStyle = runColor(hov.run);
        ctx.strokeStyle = dark2 ? '#1a1a1c' : '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx(hov.x), cy(hov.y), 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    };
    drawFnRef.current = draw; draw();
  }, [data, xMin, xMax, yMin, yMax, xName, hovTick]);

  useEffect(() => {
    const wrap = wrapRef.current; if (!wrap) return;
    const ro = new ResizeObserver(() => {
      const c = canvasRef.current; if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      c.width = wrap.clientWidth * dpr; c.height = wrap.clientHeight * dpr;
      c.style.width = `${wrap.clientWidth}px`; c.style.height = `${wrap.clientHeight}px`;
      drawFnRef.current?.();
    });
    ro.observe(wrap); return () => ro.disconnect();
  }, []);
  useEffect(() => { if (onCaptureRef) onCaptureRef.current = () => canvasRef.current; }, [onCaptureRef]);

  const onMouseMove = useCallback(e => {
    const canvas = canvasRef.current; if (!canvas || !data.length) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr, H = canvas.height / dpr;
    const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left - PAD.l;
    const my = e.clientY - rect.top - PAD.t;
    if (mx < 0 || mx > plotW || my < 0 || my > plotH) {
      if (hovRef.current) { hovRef.current = null; setHovTick(n => n + 1); }
      return;
    }
    // Find nearest point in pixel space
    const cx0 = v => (v - xMin) / (xMax - xMin) * plotW;
    const cy0 = v => (1 - (v - yMin) / (yMax - yMin)) * plotH;
    let best = null, bestD = Infinity;
    const skip = Math.max(1, Math.floor(data.length / 6000));
    for (let i = 0; i < data.length; i += skip) {
      const dx = cx0(data[i].x) - mx, dy = cy0(data[i].y) - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = data[i]; }
    }
    if (best && Math.sqrt(bestD) < 22) { hovRef.current = best; }
    else { best = null; hovRef.current = null; }
    setHovTick(n => n + 1);
  }, [data, xMin, xMax, yMin, yMax]);

  const onMouseLeave = useCallback(() => { if (hovRef.current) { hovRef.current = null; setHovTick(n => n + 1); } }, []);

  const hov = hovRef.current;

  const xUnit = useMemo(() => {
    for (const run of visRuns) { const ci = run.parsed.channels.indexOf(xName); if (ci >= 0) return run.parsed.units[ci]; } return '';
  }, [visRuns, xName]);
  const yUnit = useMemo(() => {
    for (const run of visRuns) { const ci = run.parsed.channels.indexOf(yName); if (ci >= 0) return run.parsed.units[ci]; } return '';
  }, [visRuns, yName]);

  const tipLeft = useMemo(() => {
    if (!hov || !canvasRef.current) return 80;
    const dpr = window.devicePixelRatio || 1;
    const plotW = canvasRef.current.width / dpr - PAD.l - PAD.r;
    const px = PAD.l + (hov.x - xMin) / (xMax - xMin) * plotW;
    return Math.min(px + 12, (canvasRef.current.clientWidth ?? 600) - 200);
  }, [hov, xMin, xMax]);

  return (
    <div ref={wrapRef} className={s.chartWrap}>
      <canvas ref={canvasRef} className={s.chartCanvas} style={{ cursor: 'crosshair' }}
        onMouseMove={onMouseMove} onMouseLeave={onMouseLeave} />
      {!data.length && (
        <div className={s.chartPlaceholder}>
          {!visRuns.length ? 'Load a run to see the scatter plot'
            : !xName || !yName ? 'Select X and Y channels above'
            : `Channel "${xName || yName}" not found in any visible run`}
        </div>
      )}
      {hov && (
        <div className={s.tooltip} style={{ left: tipLeft }}>
          <div className={s.tooltipRunLabel} style={{ color: runColorText(hov.run) }}>{hov.run.label}</div>
          <div className={s.tooltipRow}>
            <span className={s.tooltipName}>{xName}</span>
            <span className={s.tooltipVal}>{fmt(hov.x)}</span>
            <span className={s.tooltipUnit}>{xUnit}</span>
          </div>
          <div className={s.tooltipRow}>
            <span className={s.tooltipName}>{yName}</span>
            <span className={s.tooltipVal}>{fmt(hov.y)}</span>
            <span className={s.tooltipUnit}>{yUnit}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Folder scanner modal ──────────────────────────────────────────────────────
function FolderScannerModal({ open, defaultDir, onClose, onLoadRuns, loadedPaths = new Set() }) {
  const [closing,   setClosing]   = useState(false);
  const [scanDir,   setScanDir]   = useState(defaultDir || '');
  const [files,     setFiles]     = useState([]);
  const [scanning,  setScanning]  = useState(false);
  const [selected,  setSelected]  = useState(new Set());
  const [scanErr,   setScanErr]   = useState('');
  const [collapsed, setCollapsed] = useState(new Set());

  const handleClose = () => { if (closing) return; setClosing(true); setTimeout(onClose, 200); };

  useEffect(() => { if (open) setClosing(false); }, [open]);

  const toggleGroup = (folder) => setCollapsed(prev => {
    const next = new Set(prev);
    next.has(folder) ? next.delete(folder) : next.add(folder);
    return next;
  });

  const handlePickDir = async () => {
    const fp = await openDialog({ directory: true, title: 'Select folder to scan' });
    if (fp) { setScanDir(fp); setFiles([]); setSelected(new Set()); }
  };

  const handleScan = async () => {
    if (!scanDir) return;
    setScanning(true); setScanErr(''); setFiles([]); setSelected(new Set());
    try {
      const res = await invoke('scan_output_files', { dir: scanDir });
      setFiles(res);
      if (res.length === 0) {
        setScanErr('No .out or .outb files found in this folder.');
      } else {
        // Start all groups collapsed — user expands only what they need
        const folders = new Set();
        for (const f of res) {
          const parts = (f.rel_path || f.name).replace(/\\/g, '/').split('/');
          folders.add(parts.length > 1 ? parts.slice(0, -1).join(' / ') : '(root)');
        }
        setCollapsed(folders);
      }
    } catch (e) { setScanErr(String(e?.message ?? e)); }
    setScanning(false);
  };

  const toggleSelect = path => setSelected(prev => {
    const n = new Set(prev); n.has(path) ? n.delete(path) : n.add(path); return n;
  });
  const toggleAll = () => {
    if (selected.size === files.length) setSelected(new Set());
    else setSelected(new Set(files.map(f => f.path)));
  };
  const toggleFolder = (folderFiles) => {
    const paths = folderFiles.map(f => f.path);
    const allSel = paths.every(p => selected.has(p));
    setSelected(prev => {
      const n = new Set(prev);
      if (allSel) paths.forEach(p => n.delete(p));
      else paths.forEach(p => n.add(p));
      return n;
    });
  };

  // Group files by folder (using rel_path, identical to Wind Field scanner)
  const grouped = useMemo(() => {
    const map = new Map();
    for (const f of files) {
      const parts = (f.rel_path || f.name).replace(/\\/g, '/').split('/');
      const folder = parts.length > 1 ? parts.slice(0, -1).join(' / ') : '(root)';
      if (!map.has(folder)) map.set(folder, []);
      map.get(folder).push(f);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [files]);

  const handleLoad = () => {
    onLoadRuns(files.filter(f => selected.has(f.path) && !loadedPaths.has(f.path)));
    handleClose();
  };

  if (!open) return null;
  return (
    <div className={`${s.overlay}${closing ? ` ${s.overlayExit}` : ''}`} onClick={e => { if (e.target === e.currentTarget) handleClose(); }}>
      <div className={`${s.scannerModal}${closing ? ` ${s.scannerModalExit}` : ''}`}>
        <div className={s.scannerHeader}>
          <span className={s.scannerTitle}>
            <FolderSearch size={14} strokeWidth={1.8} />
            Scan for output files
          </span>
          <button className={s.closeBtn2} onClick={handleClose}><X size={13} strokeWidth={2} /></button>
        </div>
        <div className={s.scannerPath}>
          <input className={s.scannerDirInput} value={scanDir} onChange={e => setScanDir(e.target.value)}
            placeholder="Folder path…" />
          <button className={s.scannerPickBtn} onClick={handlePickDir}>Browse</button>
          <button className={s.scannerScanBtn} onClick={handleScan} disabled={!scanDir || scanning}>
            {scanning ? <RotateCcw size={12} className={s.spin}/> : <Search size={12}/>}
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
        </div>
        {scanErr && <div className={s.scanErr}>{scanErr}</div>}
        {files.length > 0 && (
          <>
            {/* Directory-grouped file list */}
            <div className={s.scannerGroupedWrap}>
              {grouped.map(([folder, folderFiles]) => {
                const allSel    = folderFiles.every(f => selected.has(f.path));
                const someSel   = folderFiles.some(f => selected.has(f.path));
                const isCollapsed = collapsed.has(folder);
                return (
                  <div key={folder} className={s.scannerFolderGroup}>
                    {/* Folder header — chevron | name(flex:1) | count | checkbox */}
                    <div className={s.scannerFolderHead} onClick={() => toggleGroup(folder)}>
                      <ChevronDown
                        size={9} strokeWidth={2.5}
                        className={[s.scannerFolderChevron, isCollapsed ? s.scannerFolderChevronClosed : ''].join(' ')}
                      />
                      <span className={s.scannerFolderName}>{folder}</span>
                      <span className={s.scannerFolderCount}>{folderFiles.length}</span>
                      <input
                        type="checkbox"
                        className={s.scannerFolderCheck}
                        checked={allSel}
                        ref={el => { if (el) el.indeterminate = !allSel && someSel; }}
                        onChange={() => toggleFolder(folderFiles)}
                        onClick={e => e.stopPropagation()}
                        title={allSel ? 'Deselect all in group' : 'Select all in group'}
                      />
                    </div>
                    {/* Files in folder — animated collapse */}
                    <div className={`${s.scannerGroupBody}${isCollapsed ? ` ${s.scannerGroupBodyCollapsed}` : ''}`}>
                      <div className={s.scannerGroupBodyInner}>
                        {folderFiles.map(f => {
                          const isLoaded = loadedPaths.has(f.path);
                          return (
                            <div key={f.path}
                              className={[s.scannerFileRow, isLoaded ? s.scannerFileRowLoaded : selected.has(f.path) ? s.scannerFileRowSel : ''].join(' ')}
                              onClick={() => !isLoaded && toggleSelect(f.path)}
                            >
                              <input type="checkbox" className={s.scannerFileCheck}
                                checked={isLoaded || selected.has(f.path)}
                                disabled={isLoaded}
                                onChange={() => !isLoaded && toggleSelect(f.path)}
                                onClick={e => e.stopPropagation()}
                              />
                              <span className={s.scannerFileName} title={f.path}>{f.name}</span>
                              <span className={s.scannerFileMeta}>
                                {fmtSize(f.size_bytes)}
                                {f.num_chans != null ? ` · ${f.num_chans} ch` : ''}
                                {f.time_span != null ? ` · ${f.time_span.toFixed(0)}s` : ''}
                              </span>
                              <span className={s.scannerFileDate}>{fmtDate(f.modified_secs)}</span>
                              {isLoaded
                                ? <span className={s.scannerLoadedBadge}>✓ Loaded</span>
                                : <button className={s.scannerAddBtn}
                                    onClick={e => { e.stopPropagation(); onLoadRuns([f]); onClose(); }}
                                  >Add</button>
                              }
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {selected.size > 0 && (
              <div className={s.scannerFooter}>
                <span className={s.scanCount}>{selected.size} file{selected.size > 1 ? 's' : ''} selected</span>
                <button className={s.scannerClearBtn} onClick={() => setSelected(new Set())}>Clear</button>
                <button className={s.scannerLoadBtn} onClick={handleLoad}>
                  Load {selected.size} selected as run{selected.size > 1 ? 's' : ''}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Stats bar + comparison table ──────────────────────────────────────────────
const WOHLER_OPTIONS = [3, 4, 6, 8, 10, 12];
const STAT_KEYS      = ['mean', 'std', 'min', 'max'];
const STAT_LABELS    = ['mean', 'σ', 'min', 'max'];

// ── Stats drawer: one card per channel, unified for single + multi run ────────
function StatsArea({ runs, selectedNames, wohlerM, onWohlerM, transientTime, onTransientTime, dtOut }) {
  const [copied, setCopied] = useState(false);
  const [trimInput, setTrimInput] = useState(String(transientTime ?? 0));
  const visRuns = runs.filter(r => r.visible);
  const selArr  = [...selectedNames];

  useEffect(() => { setTrimInput(String(transientTime ?? 0)); }, [transientTime]);

  if (visRuns.length === 0 || selArr.length === 0) return null;
  const isSingle = visRuns.length === 1;

  const stats = useMemo(() => {
    const tt = transientTime ?? 0;
    return selArr.map(name => {
      const row = { name };
      for (const run of visRuns) {
        const ci = run.parsed.channels.indexOf(name);
        if (ci < 0) { row[run.id] = null; continue; }
        const col = run.parsed.cols[ci];
        if (!col) { row[run.id] = null; continue; }
        const t = run.parsed.cols[0];
        const iStart = (tt > 0 && t) ? Math.max(0, t.findIndex(v => v >= tt)) : 0;
        const n = col.length;
        const count = n - iStart;
        if (count <= 0) { row[run.id] = null; continue; }
        let lo = Infinity, hi = -Infinity, sum = 0;
        for (let i = iStart; i < n; i++) {
          if (col[i] < lo) lo = col[i]; if (col[i] > hi) hi = col[i]; sum += col[i];
        }
        const mean = sum / count; let ssq = 0;
        for (let i = iStart; i < n; i++) ssq += (col[i] - mean) ** 2;
        const cycles = rainflowCount(Array.from(col.subarray(iStart)));
        const T = (t && t.length >= 2) ? (t[n - 1] - Math.max(t[0], tt)) : 1;
        const del = computeDEL(cycles, wohlerM, T > 0 ? T : 1);
        row[run.id] = { mean, std: Math.sqrt(ssq / count), min: lo, max: hi, del, unit: run.parsed.units[ci] };
      }
      return row;
    });
  }, [visRuns, selArr, wohlerM, transientTime]); // eslint-disable-line

  const handleTrimCommit = () => {
    const raw = parseFloat(trimInput);
    if (!isFinite(raw)) { setTrimInput(String(transientTime ?? 0)); return; }
    const dt = dtOut || 0;
    const t0 = visRuns[0]?.parsed.cols[0];
    const tMax = t0 ? t0[t0.length - 1] : 0;
    const snapped = dt > 0 ? Math.round(raw / dt) * dt : raw;
    const clamped = +Math.max(0, Math.min(snapped, tMax > dt ? tMax - dt : tMax)).toFixed(4);
    onTransientTime(clamped);
    setTrimInput(String(clamped));
  };

  const handleCopy = () => {
    const hdr = ['Channel', 'Unit', ...visRuns.flatMap(r =>
      [`${r.label}_mean`, `${r.label}_σ`, `${r.label}_min`, `${r.label}_max`, `${r.label}_DEL(m=${wohlerM})`]
    )].join('\t');
    const rows = stats.map(row => {
      const unit = visRuns.map(r => row[r.id]?.unit).find(Boolean) ?? '';
      return [row.name, unit, ...visRuns.flatMap(r => {
        const st = row[r.id];
        return st ? [fmt(st.mean), fmt(st.std), fmt(st.min), fmt(st.max), st.del != null ? fmt(st.del) : '—']
                  : ['—', '—', '—', '—', '—'];
      })].join('\t');
    });
    navigator.clipboard.writeText([hdr, ...rows].join('\n'))
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); });
  };

  return (
    <div className={s.statsDrawer}>
      {/* ── Drawer header ── */}
      <div className={s.statsDrawerHead}>
        <span className={s.statsDrawerTitle}>Statistics</span>

        {/* Centre: trim control */}
        <div className={s.trimControl}>
          <HoverTip tip="Exclude initial seconds from analysis. Snaps to dt_out.">
            <label className={s.trimLabel}>
              Trim Initial Transient
              <input
                className={s.trimInput}
                type="number"
                min={0}
                step={dtOut || 0.05}
                value={trimInput}
                onChange={e => setTrimInput(e.target.value)}
                onBlur={handleTrimCommit}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              />
              s
            </label>
          </HoverTip>
          <HoverTip tip="Apply trim value">
            <button className={s.trimSetBtn} onClick={handleTrimCommit}>Set</button>
          </HoverTip>
        </div>

        {/* Right: DEL + copy */}
        <div className={s.statsDrawerRight}>
          <HoverTip tip="Wöhler m for DEL — 3: welded, 4: cast iron">
            <label className={s.wohlerLabel}>
              DEL m =
              <select className={s.wohlerSelect} value={wohlerM} onChange={e => onWohlerM(+e.target.value)}>
                {WOHLER_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          </HoverTip>
          <button className={s.copyBtn} onClick={handleCopy}>
            {copied ? <Check size={11} /> : <Copy size={11} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      {/* ── Channel cards (horizontal scroll) ── */}
      <div className={s.statsCards}>
        {stats.map((row, si) => {
          const color = PALETTE[si % PALETTE.length];
          const unit  = visRuns.map(r => row[r.id]?.unit).find(Boolean) ?? '';
          return (
            <div key={row.name} className={s.statCard}>
              {/* Card label bar */}
              <div className={s.statCardHead}>
                <span className={s.statCardDot} style={{ background: color }} />
                <span className={s.statCardName}>{row.name}</span>
                {unit && <span className={s.statCardUnit}>{unit}</span>}
              </div>
              {/* Mini data table */}
              <table className={s.statCardTable}>
                <thead>
                  <tr>
                    {!isSingle && <th className={s.statColRun} />}
                    {STAT_LABELS.map(l => <th key={l} className={s.statColHdr}>{l}</th>)}
                    <th className={s.statColHdrDEL}>DEL</th>
                  </tr>
                </thead>
                <tbody>
                  {visRuns.map(run => {
                    const st = row[run.id];
                    return (
                      <tr key={run.id} className={s.statDataRow}>
                        {!isSingle && (
                          <td className={s.statColRun} style={{ color: runColorText(run) }}>
                            {run.label}
                          </td>
                        )}
                        {STAT_KEYS.map(k => (
                          <td key={k} className={s.statColVal}>{st ? fmt(st[k]) : '—'}</td>
                        ))}
                        <td className={`${s.statColVal} ${s.statColDEL}`}>
                          {st?.del != null ? fmt(st.del) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main ResultsPanel ─────────────────────────────────────────────────────────
let _runCounter = 0;
function makeRunId() { return `run-${++_runCounter}-${Date.now()}`; }

export default function ResultsPanel({ onLog, project, onFileLoaded }) {
  const [runs,          setRuns]          = useState([]);
  const [selectedNames, setSelectedNames] = useState(new Set());
  const [chartMode,     setChartMode]     = useState('time');
  const [trimCommon,    setTrimCommon]    = useState(false);
  const [search,        setSearch]        = useState('');
  const [loadingPath,   setLoadingPath]   = useState('');
  const [error,         setError]         = useState('');
  const [showScanner,   setShowScanner]   = useState(false);
  const [editingId,     setEditingId]     = useState(null);
  const [editLabel,     setEditLabel]     = useState('');
  // Feature: delta run
  const [showDeltaModal, setShowDeltaModal] = useState(false);
  // Feature: channel presets (persisted in localStorage)
  const [presets,       setPresets]       = useState(() => {
    try { return JSON.parse(localStorage.getItem('fws-result-presets') || '[]'); } catch { return []; }
  });
  const [showPresets,   setShowPresets]   = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState(() => {
    try {
      const saved = localStorage.getItem('fws-chan-collapsed');
      if (saved !== null) return new Set(JSON.parse(saved));
    } catch {}
    return new Set(CHANNEL_GROUPS.map(g => g.id)); // all collapsed by default
  });
  // Feature: scatter plot
  const [scatterX,      setScatterX]      = useState('');
  const [scatterY,      setScatterY]      = useState('');
  // Feature: Wöhler exponent for DEL
  const [wohlerM,       setWohlerM]       = useState(4);
  // Feature: trim initial transient
  const [transientTime, setTransientTime] = useState(0);
  const dtOut = useMemo(() => {
    let dt = 0;
    for (const run of runs) {
      const t = run.parsed.cols[0];
      if (t && t.length >= 2) dt = Math.max(dt, t[1] - t[0]);
    }
    return dt;
  }, [runs]);

  const resetZoomRef   = useRef(null);
  const resetFftRef    = useRef(null);
  const captureRef     = useRef(null); // set by active chart via onCaptureRef → returns canvas element
  const chanClickTimer = useRef(null); // debounce single-click vs double-click on channel rows
  const presetBtnRef  = useRef(null);
  useEffect(() => { onFileLoaded?.(runs.length > 0 ? 'loaded' : null); }, [runs.length, onFileLoaded]);

  // On-demand column loading: fires when a new run is added OR when the selected
  // channel set changes. Fetches any columns that are needed but not yet loaded.
  useEffect(() => {
    for (const run of runs) {
      if (!run.parsed._path) continue; // .out text files have all cols already
      const needed = [];
      for (let i = 0; i < run.parsed.channels.length; i++) {
        if (!run.parsed._loaded.has(i) && (i === 0 || selectedNames.has(run.parsed.channels[i]))) {
          needed.push(i);
        }
      }
      if (needed.length) loadRunColumns(run.id, run.parsed._path, needed);
    }
  }, [runs, selectedNames]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load scatter X/Y columns on demand — scatterX/Y are independent of selectedNames.
  useEffect(() => {
    if (!scatterX && !scatterY) return;
    for (const run of runs) {
      if (!run.parsed._path) continue;
      const needed = [];
      for (const name of [scatterX, scatterY]) {
        if (!name) continue;
        const ci = run.parsed.channels.indexOf(name);
        if (ci >= 0 && !run.parsed._loaded.has(ci)) needed.push(ci);
      }
      if (needed.length) loadRunColumns(run.id, run.parsed._path, needed);
    }
  }, [runs, scatterX, scatterY]); // eslint-disable-line react-hooks/exhaustive-deps

  const unionChannels = useMemo(() => {
    const map = new Map();
    for (const run of runs) {
      for (let ci = 1; ci < run.parsed.channels.length; ci++) {
        const name = run.parsed.channels[ci], unit = run.parsed.units[ci];
        if (!map.has(name)) map.set(name, { unit, inRuns: new Set() });
        map.get(name).inRuns.add(run.id);
      }
    }
    return [...map.entries()].map(([name, v]) => ({ name, unit: v.unit, inRuns: v.inRuns }));
  }, [runs]);

  const unionChannelsMap = useMemo(
    () => new Map(unionChannels.map(ch => [ch.name, ch])),
    [unionChannels]
  );

  // Grouped view (used when search is empty). Each channel is assigned to the
  // FIRST matching group only — prevents "Other" from swallowing everything.
  const groupedChannels = useMemo(() => {
    if (search) return null;
    const unselected = unionChannels.filter(ch => !selectedNames.has(ch.name));
    const buckets = CHANNEL_GROUPS.map(g => ({ ...g, channels: [] }));
    for (const ch of unselected) {
      const bucket = buckets.find(b => b.test(ch.name));
      if (bucket) bucket.channels.push(ch);
    }
    return buckets.filter(b => b.channels.length > 0);
  }, [unionChannels, search, selectedNames]);

  const filteredChannels = useMemo(() => {
    const matched = unionChannels.filter(ch =>
      !search || ch.name.toLowerCase().includes(search.toLowerCase())
    );
    if (selectedNames.size === 0) return matched;
    return [
      ...matched.filter(ch => selectedNames.has(ch.name)),
      ...matched.filter(ch => !selectedNames.has(ch.name)),
    ];
  }, [unionChannels, search, selectedNames]);

  const visRuns     = useMemo(() => runs.filter(r => r.visible), [runs]);
  const selArr      = useMemo(() => [...selectedNames], [selectedNames]);
  const loadedPaths = useMemo(() => new Set(runs.map(r => r.filePath)), [runs]);

  const toggleGroupCollapse = useCallback((id) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem('fws-chan-collapsed', JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  // Merge column data returned by read_outb_columns into the matching run.
  const mergeOutbCols = useCallback((runId, nRows, rawIndices, base64Data) => {
    const allVals = new Float64Array(
      Uint8Array.from(atob(base64Data), c => c.charCodeAt(0)).buffer
    );
    setRuns(prev => prev.map(run => {
      if (run.id !== runId) return run;
      const cols = [...run.parsed.cols];
      for (let i = 0; i < rawIndices.length; i++) {
        cols[rawIndices[i]] = allVals.slice(i * nRows, (i + 1) * nRows);
      }
      const loaded = new Set(run.parsed._loaded);
      rawIndices.forEach(idx => loaded.add(idx));
      return { ...run, parsed: { ...run.parsed, cols, _loaded: loaded } };
    }));
  }, []);

  // Fetch specific column indices for an already-registered outb run.
  const loadRunColumns = useCallback(async (runId, filePath, indices) => {
    if (!indices.length) return;
    try {
      const raw = await invoke('read_outb_columns', { path: filePath, indices });
      if (raw.data) mergeOutbCols(runId, raw.nRows, raw.indices, raw.data);
    } catch (e) {
      onLog?.('error', `Results: column load failed — ${e?.message ?? e}`);
    }
  }, [mergeOutbCols, onLog]);

  const loadFile = useCallback(async (fp, colorIdx) => {
    setLoadingPath(fp); setError('');
    try {
      let parsed;
      if (fp.toLowerCase().endsWith('.outb')) {
        // Phase 1 — header only (KB of memory, instant).
        const hdr = await invoke('read_outb_header', { path: fp });
        const nCols = hdr.nCols;
        // cols is sparse: null until the channel is loaded on demand.
        const cols = new Array(nCols).fill(null);
        parsed = {
          channels: hdr.channels, units: hdr.units,
          nRows: hdr.nRows, nCols,
          cols,
          _path: fp,             // kept for on-demand column fetches
          _loaded: new Set(),    // which indices have been fetched
        };
        const parts = fp.replace(/\\/g, '/').split('/');
        const name = parts[parts.length - 1].replace(/\.(outb|out)$/i, '');
        const runId = makeRunId();
        const run = { id: runId, label: name, filePath: fp, parsed, colorIdx, visible: true };
        setRuns(prev => [...prev, run]);
        // Auto-select first data channel name (if nothing selected yet).
        setSelectedNames(prev => {
          if (prev.size > 0) return prev;
          const first = hdr.channels[1] ?? null;
          return first ? new Set([first]) : prev;
        });
        onLog?.('info', `Results: opened ${parts[parts.length - 1]} — ${nCols - 1} channels, ${hdr.nRows.toLocaleString()} steps`);
      } else {
        const text = await invoke('read_text_file', { path: fp });
        parsed = parseOutFile(text);
        const parts = fp.replace(/\\/g, '/').split('/');
        const name = parts[parts.length - 1].replace(/\.(outb|out)$/i, '');
        const run = { id: makeRunId(), label: name, filePath: fp, parsed, colorIdx, visible: true };
        setRuns(prev => [...prev, run]);
        setSelectedNames(prev => {
          if (prev.size > 0) return prev;
          const first = parsed.channels[1] ?? null;
          return first ? new Set([first]) : prev;
        });
        onLog?.('info', `Results: loaded ${parts[parts.length - 1]} — ${parsed.channels.length - 1} channels, ${parsed.nRows.toLocaleString()} steps`);
      }
      return true;
    } catch (e) {
      const msg = e?.message ?? String(e);
      setError(`Failed to load ${fp.split('/').pop()}: ${msg}`);
      onLog?.('error', `Results: ${msg}`);
      return false;
    } finally { setLoadingPath(''); }
  }, [onLog, loadRunColumns]);

  const handleOpen = async () => {
    try {
      const fp = await openDialog({
        directory: false, multiple: false,
        title: 'Open OpenFAST output file',
        filters: [{ name: 'OpenFAST output', extensions: ['out', 'outb'] }, { name: 'All files', extensions: ['*'] }],
        defaultPath: project?.resultsDir || project?.dir || undefined,
      });
      if (!fp) return;
      await loadFile(fp, runs.length % RUN_COLORS.length);
    } catch { /* cancelled */ }
  };

  const handleLoadFromScanner = useCallback(async (fileMetas) => {
    for (let i = 0; i < fileMetas.length; i++) {
      await loadFile(fileMetas[i].path, (runs.length + i) % RUN_COLORS.length);
    }
  }, [loadFile, runs.length]);

  const removeRun      = id => setRuns(prev => prev.filter(r => r.id !== id));
  const toggleRunVisible = id => setRuns(prev => prev.map(r => r.id === id ? { ...r, visible: !r.visible } : r));
  const startRename    = run => { setEditingId(run.id); setEditLabel(run.label); };
  const commitRename   = () => {
    if (editLabel.trim()) setRuns(prev => prev.map(r => r.id === editingId ? { ...r, label: editLabel.trim() } : r));
    setEditingId(null);
  };

  const toggleChannel = name => {
    setSelectedNames(prev => {
      const n = new Set(prev);
      if (n.has(name)) { if (n.size > 1) n.delete(name); } else n.add(name);
      return n;
    });
  };
  const selectOnly = name => setSelectedNames(new Set([name]));

  // Preset handlers
  const savePreset = useCallback((name, channels) => {
    setPresets(prev => {
      const next = [...prev.filter(p => p.name !== name), { name, channels }];
      try { localStorage.setItem('fws-result-presets', JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);
  const applyPreset = useCallback((channels) => {
    const avail = new Set(unionChannels.map(c => c.name));
    const valid = channels.filter(c => avail.has(c));
    if (valid.length) setSelectedNames(new Set(valid));
  }, [unionChannels]);
  const deletePreset = useCallback((name) => {
    setPresets(prev => {
      const next = prev.filter(p => p.name !== name);
      try { localStorage.setItem('fws-result-presets', JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  // Delta add handler
  const handleAddDelta = useCallback((deltaRun) => {
    setRuns(prev => [...prev, deltaRun]);
  }, []);

  // Keep scatter defaults in sync with selected channels
  useEffect(() => {
    const arr = [...selectedNames];
    if (arr.length >= 2) {
      if (!arr.includes(scatterX)) setScatterX(arr[0]);
      if (!arr.includes(scatterY)) setScatterY(arr[1]);
    } else if (arr.length === 1) {
      const allCh = unionChannels.map(c => c.name);
      if (!arr.includes(scatterX)) setScatterX(arr[0]);
      if (!scatterY || scatterY === scatterX) setScatterY(allCh.find(c => c !== arr[0]) ?? arr[0]);
    }
  }, [selectedNames, unionChannels]); // eslint-disable-line

  const handleResetZoom = () => {
    if (chartMode === 'time') resetZoomRef.current?.();
    else resetFftRef.current?.();
  };

  // ── Save chart as PNG ───────────────────────────────────────────────────────
  const [savingPng, setSavingPng] = useState(false);
  const handleSavePNG = useCallback(async () => {
    const srcCanvas = captureRef.current?.();
    if (!srcCanvas) return;
    setSavingPng(true);
    try {
      // Composite onto an opaque background (transparent chart looks bad in PNG)
      const off = document.createElement('canvas');
      off.width  = srcCanvas.width;
      off.height = srcCanvas.height;
      const ctx = off.getContext('2d');
      const dark = document.documentElement.getAttribute('data-theme') === 'dark'
        || (!document.documentElement.getAttribute('data-theme')
            && window.matchMedia('(prefers-color-scheme: dark)').matches);
      ctx.fillStyle = dark ? '#1a1a1c' : '#ffffff';
      ctx.fillRect(0, 0, off.width, off.height);
      ctx.drawImage(srcCanvas, 0, 0);

      // canvas → PNG blob → ArrayBuffer → base64 (chunked to avoid stack overflow)
      const blob = await new Promise(res => off.toBlob(res, 'image/png'));
      const ab   = await blob.arrayBuffer();
      const u8   = new Uint8Array(ab);
      const CHUNK = 0x8000;
      let b64 = '';
      for (let i = 0; i < u8.length; i += CHUNK) {
        b64 += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
      }
      b64 = btoa(b64);

      // Auto-save to Downloads with a timestamped filename
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dlDir = await downloadDir();
      const outPath = `${dlDir}/flowurja_${chartMode}_${ts}.png`;
      await invoke('write_binary_file', { path: outPath, dataB64: b64 });
      onLog?.('ok', `Chart saved → ${outPath}`);
      toast.success('Chart saved', { description: outPath });
    } catch (e) {
      onLog?.('error', `PNG save failed: ${e?.message ?? e}`);
    } finally {
      setSavingPng(false);
    }
  }, [chartMode, onLog]);

  return (
    <div className={s.root}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className={s.header}>
        <div className={s.headerLeft}>
          <LineChart size={14} strokeWidth={1.8} className={s.headerIcon} />
          <span className={s.title}>Results</span>
          {runs.length > 0 && (
            <span className={s.metaTag}>{runs.length} run{runs.length !== 1 ? 's' : ''} · {unionChannels.length} channels</span>
          )}
        </div>
        <div className={s.headerRight}>
          {runs.length > 1 && (
            <HoverTip tip="Trim all runs to their common time window">
              <label className={s.trimToggle}>
                <input type="checkbox" checked={trimCommon} onChange={e => setTrimCommon(e.target.checked)} />
                Trim to common
              </label>
            </HoverTip>
          )}
          <HoverTip tip="Scan folder for .outb result files">
            <button className={s.scanBtn} onClick={() => setShowScanner(true)}>
              <Search size={12} strokeWidth={1.8} />
              Scan folder
            </button>
          </HoverTip>
          <button className={s.openBtn} onClick={handleOpen} disabled={!!loadingPath}>
            <FolderOpen size={12} strokeWidth={1.8} />
            {loadingPath ? 'Loading…' : 'Open .outb'}
          </button>
          {runs.length >= 2 && (
            <HoverTip tip="Create a Δ (A − B) virtual run">
              <button className={s.deltaBtn} onClick={() => setShowDeltaModal(true)}>
                <GitMerge size={12} strokeWidth={1.8} />
                Δ run
              </button>
            </HoverTip>
          )}
        </div>
      </div>

      {/* ── Error bar ──────────────────────────────────────────────────────── */}
      {error && (
        <div className={s.errorBar}>
          <span>{error}</span>
          <button className={s.errorClose} onClick={() => setError('')}><X size={11} strokeWidth={2.5} /></button>
        </div>
      )}

      {/* ── Run rack ───────────────────────────────────────────────────────── */}
      {runs.length > 0 && (
        <div className={s.runRack}>
          {runs.map(run => (
            <div key={run.id} className={[s.runPill, !run.visible ? s.runPillDim : ''].join(' ')}>
              {run.isDelta && (
                <HoverTip tip="Virtual Δ run (A − B)">
                  <span className={s.deltaBadge}>Δ</span>
                </HoverTip>
              )}
              {editingId === run.id
                ? <input className={s.runLabelInput} value={editLabel} autoFocus
                    onChange={e => setEditLabel(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingId(null); }} />
                : <HoverTip tip={run.isDelta ? run.label : 'Double-click to rename'}>
                    <span className={s.runLabelText} style={{ borderLeft: `3px solid ${runColorText(run)}` }}
                      onDoubleClick={() => !run.isDelta && startRename(run)}>
                      {run.label}
                    </span>
                  </HoverTip>
              }
              <HoverTip tip={run.visible ? 'Hide run' : 'Show run'}>
                <button className={s.runEye} onClick={() => toggleRunVisible(run.id)}>
                  {run.visible ? <Eye size={10} strokeWidth={2} /> : <EyeOff size={10} strokeWidth={2} />}
                </button>
              </HoverTip>
              <HoverTip tip="Remove run">
                <button className={s.runX} onClick={() => removeRun(run.id)}>
                  <X size={10} strokeWidth={2.5} />
                </button>
              </HoverTip>
            </div>
          ))}
          <HoverTip tip="Scan folder for more result files">
            <button className={s.runAdd} onClick={() => setShowScanner(true)} disabled={!!loadingPath}>
              {loadingPath ? <RotateCcw size={11} className={s.spin}/> : <Plus size={12} strokeWidth={2}/>}
            </button>
          </HoverTip>
        </div>
      )}

      {/* ── Empty state ────────────────────────────────────────────────────── */}
      {runs.length === 0 && !loadingPath && (
        <div className={s.emptyState}>
          <BarChart2 size={44} strokeWidth={1} className={s.emptyIcon} />
          <p className={s.emptyTitle}>No output files loaded</p>
          <p className={s.emptyHint}>
            Open <code>.outb</code> or <code>.out</code> files to visualise time-series data.
            Load multiple runs to compare them side-by-side.
          </p>
          <div className={s.emptyActions}>
            <button className={s.emptyBtn} onClick={() => setShowScanner(true)}>
              <Search size={13} strokeWidth={1.8} /> Scan folder
            </button>
            <button className={s.emptyBtn} onClick={handleOpen}>
              <FolderOpen size={13} strokeWidth={1.8} /> Open .outb
            </button>
          </div>
        </div>
      )}

      {/* ── Loading ────────────────────────────────────────────────────────── */}
      {loadingPath && (
        <div className={s.loadingBar}>Loading {loadingPath.split('/').pop()}…</div>
      )}

      {/* ── Main content ───────────────────────────────────────────────────── */}
      {runs.length > 0 && (
        <div className={s.content}>

          {/* Left: channel browser */}
          <div className={s.chanPanel}>
            <div className={s.chanPanelHead}>
              <span className={s.chanPanelLabel} style={{ color: '#E11D48' }}>Channels</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span className={s.chanBadge}>{unionChannels.length}</span>
                <div style={{ position: 'relative' }}>
                  <button ref={presetBtnRef} className={s.presetTriggerBtn}
                    title="Channel presets" onClick={() => setShowPresets(p => !p)}>
                    <Bookmark size={10} strokeWidth={2} />
                  </button>
                  {showPresets && (
                    <PresetPopup
                      presets={presets}
                      currentChannels={selArr}
                      onSave={savePreset}
                      onApply={applyPreset}
                      onDelete={deletePreset}
                      onClose={() => setShowPresets(false)}
                      anchorRef={presetBtnRef}
                    />
                  )}
                </div>
              </div>
            </div>
            <div className={s.searchRow}>
              <Search size={11} strokeWidth={1.8} className={s.searchIcon} />
              <input className={s.searchInput} placeholder="Filter channels…"
                value={search} onChange={e => setSearch(e.target.value)} />
              {search && <button className={s.searchClear} onClick={() => setSearch('')}><X size={10} strokeWidth={2.5} /></button>}
            </div>
            <ul className={s.chanList}>
              {(() => {
                // Plain render function — NOT a React component — so React never
                // unmounts/remounts rows on re-render (avoids click lag).
                //
                // Single-click vs double-click: delay the toggle by 220ms so a
                // second click can cancel it and isolate instead. Without this,
                // the first click of a double-click deselects the channel and
                // moves it out of "Selected" before onDoubleClick fires.
                const handleChanClick = (name) => {
                  if (chanClickTimer.current) {
                    clearTimeout(chanClickTimer.current);
                    chanClickTimer.current = null;
                    selectOnly(name);
                  } else {
                    chanClickTimer.current = setTimeout(() => {
                      chanClickTimer.current = null;
                      toggleChannel(name);
                    }, 220);
                  }
                };

                const renderChan = (name, unit, inRuns) => {
                  const sel = selectedNames.has(name);
                  const selIdx = selArr.indexOf(name);
                  const swatch = sel && visRuns.length === 1 ? PALETTE[selIdx % PALETTE.length] : undefined;
                  const partial = inRuns.size < runs.length;
                  return (
                    <li key={name} className={[s.chanItem, sel ? s.chanItemSel : ''].join(' ')}
                      onClick={() => handleChanClick(name)}
                      title={`${name} (${unit}) · in ${inRuns.size}/${runs.length} runs — click to toggle, double-click to isolate`}>
                      {visRuns.length <= 1
                        ? <span className={s.chanSwatch} style={{ background: sel ? swatch : 'transparent', borderColor: sel ? swatch : 'var(--bd-strong)' }} />
                        : sel
                          ? <ChartLine color={RUN_COLORS[0]} dash={DASH_PATTERNS[selIdx % DASH_PATTERNS.length]} width={14} height={10} />
                          : <span className={s.chanSwatch} style={{ background: 'transparent', borderColor: 'var(--bd-strong)' }} />
                      }
                      <span className={s.chanName}>{name}</span>
                      <span className={s.chanUnit}>{unit}</span>
                      {partial && <span className={s.chanPartial} title={`Only in ${inRuns.size} of ${runs.length} runs`}>partial</span>}
                    </li>
                  );
                };

                // ── Search active: flat filtered list ──────────────────────────
                if (search) {
                  if (filteredChannels.length === 0)
                    return <li className={s.chanEmpty}>No channels match "{search}"</li>;
                  return filteredChannels.map(ch => renderChan(ch.name, ch.unit, ch.inRuns));
                }

                // ── No search: grouped view ────────────────────────────────────
                return (
                  <>
                    {/* Selected group — always at top, never collapsed */}
                    {selArr.length > 0 && (
                      <>
                        <li className={[s.chanGroupHeader, s.chanGroupHeaderSel].join(' ')}>
                          <span className={s.chanGroupLabel}>Selected</span>
                          <span className={s.chanGroupCount}>{selArr.length}</span>
                        </li>
                        {selArr.map(name => {
                          const ch = unionChannelsMap.get(name);
                          return ch ? renderChan(ch.name, ch.unit, ch.inRuns) : null;
                        })}
                      </>
                    )}

                    {/* Component groups */}
                    {groupedChannels?.map(group => {
                      const collapsed = collapsedGroups.has(group.id);
                      return (
                        <li key={group.id} className={s.chanGroupWrap}>
                          <button
                            className={s.chanGroupHeader}
                            onClick={() => toggleGroupCollapse(group.id)}
                            title={collapsed ? `Expand ${group.label}` : `Collapse ${group.label}`}
                          >
                            <ChevronRight size={9} strokeWidth={2.5}
                              className={collapsed ? s.chevronCollapsed : s.chevronExpanded} />
                            <span className={s.chanGroupLabel}>{group.label}</span>
                            <span className={s.chanGroupCount}>{group.channels.length}</span>
                          </button>
                          {!collapsed && (
                            <ul className={s.chanGroupList}>
                              {group.channels.map(ch => renderChan(ch.name, ch.unit, ch.inRuns))}
                            </ul>
                          )}
                        </li>
                      );
                    })}

                    {/* Nothing at all */}
                    {selArr.length === 0 && unionChannels.length === 0 && (
                      <li className={s.chanEmpty}>Load a results file to see channels.</li>
                    )}
                  </>
                );
              })()}
            </ul>
            <div className={s.chanHint}>Click · double-click to isolate</div>
          </div>

          {/* Right: chart column */}
          <div className={s.chartCol}>

            {/* Chart mode bar */}
            <div className={s.chartBar}>
              <div className={s.modeToggle}>
                <button className={[s.modeBtn, chartMode === 'time' ? s.modeBtnActive : ''].join(' ')}
                  onClick={() => setChartMode('time')}>
                  <Activity size={11} strokeWidth={2} /> Time
                </button>
                <button className={[s.modeBtn, chartMode === 'freq' ? s.modeBtnActive : ''].join(' ')}
                  onClick={() => setChartMode('freq')}>
                  <Zap size={11} strokeWidth={2} /> Frequency
                </button>
                <button className={[s.modeBtn, chartMode === 'scatter' ? s.modeBtnActive : ''].join(' ')}
                  onClick={() => setChartMode('scatter')}>
                  <ScatterIcon size={11} strokeWidth={2} /> Scatter
                </button>
              </div>
              {/* Scatter axis selectors */}
              {chartMode === 'scatter' && (
                <div className={s.scatterSelectors}>
                  <span className={s.scatterSelectorLabel}>X</span>
                  <select className={s.scatterSelect} value={scatterX} onChange={e => setScatterX(e.target.value)}>
                    {unionChannels.map(ch => <option key={ch.name} value={ch.name}>{ch.name}</option>)}
                  </select>
                  <span className={s.scatterSelectorLabel}>Y</span>
                  <select className={s.scatterSelect} value={scatterY} onChange={e => setScatterY(e.target.value)}>
                    {unionChannels.map(ch => <option key={ch.name} value={ch.name}>{ch.name}</option>)}
                  </select>
                </div>
              )}
              {/* Reset zoom — only for time/freq */}
              {chartMode !== 'scatter' && (
                <button className={s.resetZoomBtn} onClick={handleResetZoom}>
                  <RotateCcw size={11} strokeWidth={2} /> Reset zoom
                </button>
              )}
              {/* Save PNG */}
              <HoverTip tip="Export chart as PNG">
                <button className={s.savePngBtn} onClick={handleSavePNG} disabled={savingPng}>
                  <Download size={11} strokeWidth={2} />
                  {savingPng ? 'Saving…' : 'PNG'}
                </button>
              </HoverTip>
            </div>

            {/* Channel dash-pattern legend — shown only in multi-run + multi-channel */}
            {visRuns.length > 1 && selArr.length > 1 && (
              <div className={s.chanLegend}>
                <span className={s.chanLegendLabel}>Channels:</span>
                {selArr.map((name, si) => (
                  <span key={name} className={s.chanLegendItem}>
                    <ChartLine color="currentColor" dash={DASH_PATTERNS[si % DASH_PATTERNS.length]} width={22} height={9} />
                    <span>{name}</span>
                  </span>
                ))}
                <span className={s.chanLegendSep}>·</span>
                <span className={s.chanLegendLabel}>Runs:</span>
                {visRuns.map(run => (
                  <span key={run.id} className={s.chanLegendItem} style={{ color: runColorText(run) }}>
                    {run.label}
                  </span>
                ))}
              </div>
            )}

            {/* Chart — or placeholder when all runs are hidden */}
            {visRuns.length === 0
              ? (
                <div className={s.allHiddenPlaceholder}>
                  <EyeOff size={36} strokeWidth={1} className={s.allHiddenIcon} />
                  <p className={s.allHiddenTitle}>All runs hidden</p>
                  <p className={s.allHiddenHint}>Toggle the eye icon in the run rack to show a run</p>
                </div>
              )
              : chartMode === 'time'
                ? <TimeSeriesChart runs={runs} selectedNames={selectedNames}
                    trimCommon={trimCommon} transientTime={transientTime} onResetRef={resetZoomRef} onCaptureRef={captureRef} />
                : chartMode === 'freq'
                  ? <FFTChart runs={runs} selectedNames={selectedNames} transientTime={transientTime} onResetRef={resetFftRef} onCaptureRef={captureRef} />
                  : <ScatterChart runs={runs} xName={scatterX} yName={scatterY} onCaptureRef={captureRef} />
            }

            {/* Stats area */}
            {visRuns.length > 0 && <StatsArea runs={runs} selectedNames={selectedNames} wohlerM={wohlerM} onWohlerM={setWohlerM}
              transientTime={transientTime} onTransientTime={setTransientTime} dtOut={dtOut} />}

          </div>
        </div>
      )}

      {/* ── Delta run modal ─────────────────────────────────────────────────── */}
      {showDeltaModal && (
        <DeltaModal runs={runs} onClose={() => setShowDeltaModal(false)} onAdd={handleAddDelta} />
      )}

      {/* ── Folder scanner modal ────────────────────────────────────────────── */}
      <FolderScannerModal
        open={showScanner}
        defaultDir={project?.resultsDir || project?.dir || ''}
        onClose={() => setShowScanner(false)}
        onLoadRuns={handleLoadFromScanner}
        loadedPaths={loadedPaths}
      />
    </div>
  );
}
