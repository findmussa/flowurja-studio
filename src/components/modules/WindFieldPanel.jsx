import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Play, Pause, SkipBack, SkipForward, FolderOpen, Search, X,
  ChevronUp, ChevronDown, Lock, Unlock, Download, RotateCcw,
  RefreshCw, Maximize2, Plus, Spline, Layers,
} from "lucide-react";
import s from "./WindFieldPanel.module.css";

// ── File colour palette (mirrors ResultsPanel RUN_COLORS) ─────────────────────
const FILE_COLORS = ["#0891B2","#D97706","#7C3AED","#059669","#E11D48","#4F46E5"];
function makeFileId() { return Math.random().toString(36).slice(2, 9); }

// ── Custom icon ────────────────────────────────────────────────────────────────
function WindFieldIcon({ size = 14, className, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none"
         className={className} style={style} aria-hidden="true">
      <rect x="1" y="2.5" width="12" height="9" rx="1.2"
            stroke="currentColor" strokeWidth="1.1"/>
      <circle cx="3.5"  cy="4.75" r="0.75" fill="currentColor"/>
      <circle cx="7"    cy="4.75" r="0.75" fill="currentColor"/>
      <circle cx="10.5" cy="4.75" r="0.75" fill="currentColor"/>
      <circle cx="3.5"  cy="7"    r="0.75" fill="currentColor"/>
      <circle cx="7"    cy="7"    r="1.25" fill="currentColor"/>
      <circle cx="10.5" cy="7"    r="0.75" fill="currentColor"/>
      <circle cx="3.5"  cy="9.25" r="0.75" fill="currentColor"/>
      <circle cx="7"    cy="9.25" r="0.75" fill="currentColor"/>
      <circle cx="10.5" cy="9.25" r="0.75" fill="currentColor"/>
    </svg>
  );
}

// ── Colourmap LUTs (256 × RGBA) ───────────────────────────────────────────────
function buildLUT(stops) {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let lo = stops[0], hi = stops[stops.length - 1];
    for (let j = 0; j < stops.length - 1; j++) {
      if (t <= stops[j + 1][0]) { lo = stops[j]; hi = stops[j + 1]; break; }
    }
    const f = lo[0] >= hi[0] ? 0 : (t - lo[0]) / (hi[0] - lo[0]);
    lut[i*4+0] = Math.round(lo[1] + (hi[1] - lo[1]) * f);
    lut[i*4+1] = Math.round(lo[2] + (hi[2] - lo[2]) * f);
    lut[i*4+2] = Math.round(lo[3] + (hi[3] - lo[3]) * f);
    lut[i*4+3] = 255;
  }
  return lut;
}

const LUTS = {
  viridis: buildLUT([
    [0.000,  68,   1,  84],[0.067,  71,  15, 101],[0.133,  72,  32, 115],
    [0.200,  68,  55, 129],[0.267,  61,  77, 138],[0.333,  53,  97, 141],
    [0.400,  46, 114, 142],[0.467,  40, 130, 142],[0.533,  33, 148, 141],
    [0.600,  28, 164, 133],[0.667,  37, 181, 120],[0.733,  65, 197, 102],
    [0.800, 102, 210,  80],[0.867, 141, 219,  55],[0.933, 183, 224,  32],
    [1.000, 253, 231,  37],
  ]),
  coolwarm: buildLUT([
    [0.000,  59,  76, 192],[0.125, 116, 149, 238],[0.250, 168, 196, 252],
    [0.375, 213, 224, 245],[0.500, 246, 244, 231],[0.625, 253, 212, 186],
    [0.750, 244, 160, 127],[0.875, 222,  94,  69],[1.000, 180,   4,  38],
  ]),
  plasma: buildLUT([
    [0.000,  13,   8, 135],[0.250, 126,   3, 168],
    [0.500, 215,  39,  96],[0.750, 251, 148,  13],[1.000, 240, 249,  33],
  ]),
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function isDark() {
  const a = document.documentElement.getAttribute('data-theme');
  if (a === 'dark') return true;
  if (a === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function niceTicks(lo, hi, target = 5) {
  if (lo >= hi) return [lo];
  const span = hi - lo;
  const raw  = span / target;
  const mag  = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm < 2 ? mag : norm < 5 ? 2 * mag : 5 * mag;
  const start = Math.ceil(lo / step) * step;
  const ticks = [];
  for (let v = start; v <= hi + step * 0.001; v += step) ticks.push(+v.toPrecision(10));
  return ticks;
}

function logTicks(fmin, fmax) {
  const result = [];
  const dMin = Math.floor(Math.log10(fmin));
  const dMax = Math.ceil(Math.log10(fmax));
  for (let d = dMin; d <= dMax; d++) {
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, d);
      if (v >= fmin * 0.5 && v <= fmax * 2.0) result.push(v);
    }
  }
  return result;
}

function fmtNum(v, dec = 1) {
  if (!isFinite(v)) return '—';
  return v.toFixed(dec);
}

function fmtFreq(f) {
  if (f <= 0) return '0';
  if (f >= 1)   return f.toFixed(0);
  if (f >= 0.1) return f.toFixed(2);
  return f.toExponential(1);
}

function decodeF32(b64) {
  const bin = atob(b64);
  const ab  = new ArrayBuffer(bin.length);
  const u8  = new Uint8Array(ab);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(ab);
}

function setupCanvas(canvas, container) {
  if (!canvas || !container) return;
  const dpr = window.devicePixelRatio || 1;
  const w = container.clientWidth;
  const h = container.clientHeight;
  canvas.width  = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width  = `${w}px`;
  canvas.style.height = `${h}px`;
}

// ── FFT / PSD / Kaimal ────────────────────────────────────────────────────────
function fft(re, im) {
  const N = re.length;
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let uRe = 1, uIm = 0;
      for (let k = 0; k < (len >> 1); k++) {
        const tRe = uRe * re[i+k+(len>>1)] - uIm * im[i+k+(len>>1)];
        const tIm = uRe * im[i+k+(len>>1)] + uIm * re[i+k+(len>>1)];
        re[i+k+(len>>1)] = re[i+k] - tRe;
        im[i+k+(len>>1)] = im[i+k] - tIm;
        re[i+k] += tRe; im[i+k] += tIm;
        const nr = uRe * wRe - uIm * wIm;
        uIm = uRe * wIm + uIm * wRe;
        uRe = nr;
      }
    }
  }
}

function computeWelchPSD(signal, fs) {
  const nt = signal.length;
  let M = 64;
  while (M * 8 <= nt) M <<= 1;
  M = Math.max(M >> 1, 64);
  const step = M >> 1;
  const nF   = (M >> 1) + 1;
  const freqs = new Float64Array(nF);
  for (let k = 0; k < nF; k++) freqs[k] = k * fs / M;

  const psdSum = new Float64Array(nF);
  let nSeg = 0, wsum2 = 0;
  for (let i = 0; i < M; i++) { const w = 0.5 - 0.5 * Math.cos(2*Math.PI*i/(M-1)); wsum2 += w*w; }

  for (let start = 0; start + M <= nt; start += step) {
    const re = new Float64Array(M), im = new Float64Array(M);
    for (let i = 0; i < M; i++) {
      const w = 0.5 - 0.5 * Math.cos(2*Math.PI*i/(M-1));
      re[i] = signal[start + i] * w;
    }
    fft(re, im);
    for (let k = 0; k < nF; k++) {
      const pw = re[k]*re[k] + im[k]*im[k];
      psdSum[k] += (k === 0 || k === M>>1) ? pw : 2*pw;
    }
    nSeg++;
  }

  const scale = 1 / (fs * wsum2 * nSeg);
  const psd   = new Float64Array(nF);
  for (let k = 0; k < nF; k++) psd[k] = psdSum[k] * scale;
  return { freqs, psd, nSeg, M };
}

function computeWelchCoherence(sig1, sig2, fs) {
  const nt = sig1.length;
  let M = 64;
  while (M * 8 <= nt) M <<= 1;
  M = Math.max(M >> 1, 64);
  const step = M >> 1;
  const nF   = (M >> 1) + 1;
  const freqs = new Float64Array(nF);
  for (let k = 0; k < nF; k++) freqs[k] = k * fs / M;

  const gxx  = new Float64Array(nF);
  const gyy  = new Float64Array(nF);
  const gxyR = new Float64Array(nF);
  const gxyI = new Float64Array(nF);
  let nSeg = 0;

  for (let start = 0; start + M <= nt; start += step) {
    const re1 = new Float64Array(M), im1 = new Float64Array(M);
    const re2 = new Float64Array(M), im2 = new Float64Array(M);
    for (let i = 0; i < M; i++) {
      const w = 0.5 - 0.5 * Math.cos(2*Math.PI*i/(M-1));
      re1[i] = sig1[start+i]*w; re2[i] = sig2[start+i]*w;
    }
    fft(re1, im1); fft(re2, im2);
    for (let k = 0; k < nF; k++) {
      gxx[k]  += re1[k]*re1[k] + im1[k]*im1[k];
      gyy[k]  += re2[k]*re2[k] + im2[k]*im2[k];
      gxyR[k] += re1[k]*re2[k] + im1[k]*im2[k];
      gxyI[k] += im1[k]*re2[k] - re1[k]*im2[k];
    }
    nSeg++;
  }

  const coh = new Float64Array(nF);
  for (let k = 0; k < nF; k++) {
    const denom = gxx[k] * gyy[k];
    coh[k] = denom > 0 ? Math.min(1, (gxyR[k]*gxyR[k] + gxyI[k]*gxyI[k]) / denom) : 0;
  }
  return { freqs, coh, nSeg, M };
}

function kaimalSpectrum(freqs, sigma_u, uhub, zhub) {
  const L1  = Math.min(0.7 * zhub, 42.0);
  const Lu  = 8.1 * L1;
  const psd = new Float64Array(freqs.length);
  for (let k = 0; k < freqs.length; k++) {
    const f = freqs[k];
    if (f <= 0) continue;
    const fL = f * Lu / uhub;
    psd[k] = sigma_u * sigma_u * 4 * fL / (Math.pow(1 + 6 * fL, 5 / 3)) / f;
  }
  return psd;
}

// ── Stats computation (called once per file on load) ─────────────────────────
function computeBtsStats(bts) {
  const { nz, ny, nt, dz, zbottom, zhub, uhub, u, v, w } = bts;

  const gm = {};
  for (const [k, arr] of [['u', u], ['v', v], ['w', w]]) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] < mn) mn = arr[i];
      if (arr[i] > mx) mx = arr[i];
    }
    gm[k] = { min: mn, max: mx };
  }

  const iz_hub = Math.min(nz - 1, Math.max(0, Math.round((zhub - zbottom) / dz)));
  const iy_hub = Math.floor((ny - 1) / 2);

  const uts = new Float64Array(nt);
  const vts = new Float64Array(nt);
  const wts = new Float64Array(nt);
  for (let t = 0; t < nt; t++) {
    const base = t * nz * ny + iz_hub * ny + iy_hub;
    uts[t] = u[base]; vts[t] = v[base]; wts[t] = w[base];
  }

  const mean = a => { let s = 0; for (const x of a) s += x; return s / a.length; };
  const sig  = (a, m) => { let s = 0; for (const x of a) s += (x-m)**2; return Math.sqrt(s/a.length); };
  const mu = mean(uts), mv = mean(vts), mw = mean(wts);
  const su = sig(uts, mu), sv = sig(vts, mv), sw = sig(wts, mw);

  const absU = Math.abs(mu);
  const uRef = (uhub > 0.5 && absU < 0.5 * uhub) ? uhub : Math.max(absU, 0.01);
  const TI_u = su / uRef, TI_v = sv / uRef, TI_w = sw / uRef;

  const ubar_z = new Float32Array(nz);
  const sig_z  = new Float32Array(nz);
  const ti_z   = new Float32Array(nz);
  for (let iz = 0; iz < nz; iz++) {
    let s = 0;
    for (let t = 0; t < nt; t++)
      for (let iy = 0; iy < ny; iy++) s += u[t * nz * ny + iz * ny + iy];
    const ub = s / (nt * ny);
    ubar_z[iz] = ub;
    let s2 = 0;
    for (let t = 0; t < nt; t++)
      for (let iy = 0; iy < ny; iy++) { const d = u[t * nz * ny + iz * ny + iy] - ub; s2 += d*d; }
    const sg = Math.sqrt(s2 / (nt * ny));
    sig_z[iz] = sg;
    ti_z[iz]  = uRef > 0.01 ? sg / uRef : 0;
  }

  const maxUbar = ubar_z.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const storesFluct = uhub > 0.5 && maxUbar < 0.3 * uhub;

  const udisp_z = new Float32Array(ubar_z);
  if (storesFluct && zhub > 0) {
    for (let iz = 0; iz < nz; iz++) {
      const z = zbottom + iz * dz;
      udisp_z[iz] = z > 0 ? uhub * Math.pow(z / zhub, 0.143) : 0;
    }
  }

  const z_vals = Array.from({ length: nz }, (_, iz) => zbottom + iz * dz);
  const pairs  = z_vals.map((z, iz) => [Math.log(Math.max(z, 0.1)), Math.log(Math.max(Math.abs(udisp_z[iz]), 0.1))]);
  let alpha = 0.143;
  { const n = pairs.length;
    const sx = pairs.reduce((a,[x])=>a+x,0), sy = pairs.reduce((a,[,y])=>a+y,0);
    const sxy = pairs.reduce((a,[x,y])=>a+x*y,0), sxx = pairs.reduce((a,[x])=>a+x*x,0);
    const den = n*sxx - sx*sx;
    if (Math.abs(den) > 1e-10) alpha = (n*sxy - sx*sy) / den; }

  return {
    iz_hub, iy_hub, mu, mv, mw, su, sv, sw, TI_u, TI_v, TI_w, alpha,
    ubar_z, udisp_z, sig_z, ti_z, z_vals, uts, vts, wts, storesFluct,
    globalMM: gm,
  };
}

// ── Canvas renderers ──────────────────────────────────────────────────────────
const FP = { l: 52, r: 76, t: 16, b: 34 };

// Marching-squares contour lines.
// MS_CASES[idx] = [[edgeA,edgeB], ...] segments for each of the 16 corner bitmask cases.
// Corner bits: 0=BL(iz,iy) 1=BR(iz,iy+1) 2=TR(iz+1,iy+1) 3=TL(iz+1,iy)
// Edges: 0=bottom(BL→BR) 1=right(BR→TR) 2=top(TL→TR) 3=left(BL→TL)
const MS_CASES = [
  [],[[3,0]],[[0,1]],[[3,1]],[[1,2]],[[3,0],[1,2]],[[0,2]],[[3,2]],
  [[2,3]],[[2,0]],[[0,1],[2,3]],[[2,1]],[[1,3]],[[0,1]],[[0,3]],[],
];

function drawContours(ctx, slice, nz, ny, vmin, vmax, FP, plotW, plotH, nLevels) {
  const cx  = (y) => FP.l + (y + 0.5) * plotW / ny;
  const cy  = (z) => FP.t + (nz - 0.5 - z) * plotH / nz;
  const t01 = (a, b, lv) => b === a ? 0.5 : Math.max(0, Math.min(1, (lv - a) / (b - a)));

  ctx.lineWidth = 0.85;
  for (let li = 1; li < nLevels; li++) {
    const lv = vmin + (li / nLevels) * (vmax - vmin);
    ctx.beginPath();
    for (let iz = 0; iz < nz - 1; iz++) {
      for (let iy = 0; iy < ny - 1; iy++) {
        const v00 = slice[ iz      * ny + iy    ];  // BL
        const v10 = slice[ iz      * ny + iy + 1];  // BR
        const v11 = slice[(iz + 1) * ny + iy + 1];  // TR
        const v01 = slice[(iz + 1) * ny + iy    ];  // TL
        let idx =
          ((v00 >= lv) ? 1 : 0) | ((v10 >= lv) ? 2 : 0) |
          ((v11 >= lv) ? 4 : 0) | ((v01 >= lv) ? 8 : 0);
        // Resolve saddle ambiguity (cases 5, 10) using cell average
        if (idx === 5 || idx === 10) {
          const avg = (v00 + v10 + v11 + v01) / 4;
          if (avg >= lv) idx = idx === 5 ? 10 : 5;
        }
        const segs = MS_CASES[idx];
        if (!segs.length) continue;
        const ep = (e) => {
          switch (e) {
            case 0: return [cx(iy + t01(v00, v10, lv)),       cy(iz)      ];
            case 1: return [cx(iy + 1),                        cy(iz + t01(v10, v11, lv))];
            case 2: return [cx(iy + t01(v01, v11, lv)),       cy(iz + 1)  ];
            case 3: return [cx(iy),                            cy(iz + t01(v00, v01, lv))];
            default: return [0, 0];
          }
        };
        for (const [eA, eB] of segs) {
          const [x1, y1] = ep(eA); const [x2, y2] = ep(eB);
          ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        }
      }
    }
    ctx.stroke();
  }
}

function renderField(canvas, bts, compArr, frame, lut, lockedMin, lockedMax, pinnedPt, hover, opts = {}) {
  if (!canvas || !bts || !compArr) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.width  / dpr;
  const H   = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const { nz, ny, dz, dy, zbottom, zhub } = bts;
  const plotW = W - FP.l - FP.r;
  const plotH = H - FP.t - FP.b;
  if (plotW < 4 || plotH < 4) return;

  const offset = frame * nz * ny;
  const slice  = compArr.subarray(offset, offset + nz * ny);

  let vmin = lockedMin, vmax = lockedMax;
  if (vmin === null || vmax === null) {
    vmin = Infinity; vmax = -Infinity;
    for (let i = 0; i < slice.length; i++) {
      if (slice[i] < vmin) vmin = slice[i];
      if (slice[i] > vmax) vmax = slice[i];
    }
  }
  const range = vmax === vmin ? 1 : vmax - vmin;

  const img = new ImageData(ny, nz);
  for (let iz = 0; iz < nz; iz++) {
    const row = nz - 1 - iz;
    for (let iy = 0; iy < ny; iy++) {
      const t  = Math.max(0, Math.min(1, (slice[iz * ny + iy] - vmin) / range));
      const ci = Math.round(t * 255) * 4;
      const px = (row * ny + iy) * 4;
      img.data[px]   = lut[ci];
      img.data[px+1] = lut[ci+1];
      img.data[px+2] = lut[ci+2];
      img.data[px+3] = 255;
    }
  }
  const tmp = document.createElement('canvas');
  tmp.width = ny; tmp.height = nz;
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = opts.smooth || ny < 8 || nz < 8;
  if (ctx.imageSmoothingEnabled) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tmp, FP.l, FP.t, plotW, plotH);

  if (opts.contours) {
    ctx.save();
    ctx.beginPath(); ctx.rect(FP.l, FP.t, plotW, plotH); ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.52)';
    drawContours(ctx, slice, nz, ny, vmin, vmax, FP, plotW, plotH, 10);
    ctx.restore();
  }

  const dark  = isDark();
  const lbClr = dark ? 'rgba(255,255,255,0.82)' : 'rgba(0,0,0,0.60)';
  const bdClr = dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.17)';
  const gClr  = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.07)';
  ctx.font = `10px -apple-system,system-ui,sans-serif`;

  const zTop  = zbottom + (nz - 1) * dz;
  const halfY = (ny - 1) * dy / 2;
  const zToY  = z    => FP.t + (nz - 0.5 - (z - zbottom) / dz) * plotH / nz;
  const yToX  = ypos => FP.l + (ypos / dy + (ny - 1) / 2 + 0.5) * plotW / ny;
  const izVal = iz   => zbottom + iz * dz;
  const iyVal = iy   => -halfY + iy * dy;

  const zStep = Math.max(1, Math.ceil(nz / Math.max(3, Math.floor(plotH / 50))));
  const yStep = Math.max(1, Math.ceil(ny / Math.max(3, Math.floor(plotW / 60))));

  ctx.fillStyle = lbClr; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let iz = 0; iz < nz; iz += zStep) {
    const z  = izVal(iz);
    const py = zToY(z);
    ctx.strokeStyle = gClr; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(FP.l, py); ctx.lineTo(FP.l + plotW, py); ctx.stroke();
    ctx.fillStyle = lbClr;
    ctx.fillText(Math.round(z), FP.l - 4, py);
  }
  ctx.save(); ctx.translate(11, FP.t + plotH / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = lbClr;
  ctx.fillText('Height (m)', 0, 0); ctx.restore();

  ctx.fillStyle = lbClr; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let iy = 0; iy < ny; iy += yStep) {
    const ypos = iyVal(iy);
    const px   = yToX(ypos);
    ctx.strokeStyle = gClr; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, FP.t); ctx.lineTo(px, FP.t + plotH); ctx.stroke();
    ctx.fillStyle = lbClr;
    ctx.fillText(Math.round(ypos), px, FP.t + plotH + 3);
  }
  ctx.fillStyle = lbClr; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText('Lateral y (m)', FP.l + plotW / 2, H - 1);

  if (zhub >= zbottom && zhub <= zTop) {
    const py = zToY(zhub);
    ctx.strokeStyle = dark ? 'rgba(250,204,21,0.7)' : 'rgba(180,140,0,0.8)';
    ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(FP.l, py); ctx.lineTo(FP.l + plotW, py); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = dark ? 'rgba(250,204,21,0.8)' : 'rgba(160,120,0,0.85)';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.font = '9px -apple-system,system-ui,sans-serif';
    ctx.fillText(`zhub=${Math.round(zhub)}m`, FP.l + 3, py - 1);
    ctx.font = `10px -apple-system,system-ui,sans-serif`;
  }

  const cbX = FP.l + plotW + 8;
  const cbW = 12;
  const cbH = plotH;
  const grad = ctx.createLinearGradient(0, FP.t + cbH, 0, FP.t);
  for (let i = 0; i <= 12; i++) {
    const t  = i / 12;
    const ci = Math.round(t * 255) * 4;
    grad.addColorStop(t, `rgb(${lut[ci]},${lut[ci+1]},${lut[ci+2]})`);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(cbX, FP.t, cbW, cbH);
  ctx.strokeStyle = bdClr; ctx.lineWidth = 0.5;
  ctx.strokeRect(cbX, FP.t, cbW, cbH);
  const cbTicks = niceTicks(vmin, vmax, 5);
  ctx.fillStyle = lbClr; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const tv of cbTicks) {
    const frac = (tv - vmin) / (vmax - vmin);
    const py   = FP.t + (1 - frac) * cbH;
    ctx.fillText(fmtNum(tv), cbX + cbW + 3, py);
  }

  if (pinnedPt) {
    const px = FP.l + (pinnedPt.iy + 0.5) * plotW / ny;
    const py = FP.t + (nz - 0.5 - pinnedPt.iz) * plotH / nz;
    ctx.strokeStyle = '#FACC15'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(250,204,21,0.25)';
    ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
  }

  ctx.strokeStyle = bdClr; ctx.lineWidth = 0.75;
  ctx.strokeRect(FP.l, FP.t, plotW, plotH);

  if (hover) {
    const hx = FP.l + (hover.iy + 0.5) * plotW / ny;
    const hy = FP.t + (nz - 0.5 - hover.iz) * plotH / nz;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(hx, FP.t); ctx.lineTo(hx, FP.t + plotH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(FP.l, hy); ctx.lineTo(FP.l + plotW, hy); ctx.stroke();
    ctx.setLineDash([]);
    const tip  = `z=${fmtNum(hover.z, 1)}m  y=${fmtNum(hover.y, 1)}m  ${fmtNum(hover.vel, 2)} m/s`;
    ctx.font = '10.5px -apple-system,system-ui,sans-serif';
    const tw = ctx.measureText(tip).width + 12;
    const th = 18;
    let tx = hx + 10, ty = hy - th / 2 - 4;
    if (tx + tw > W - 4) tx = hx - tw - 6;
    if (ty < FP.t) ty = hy + 8;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.beginPath();
    ctx.roundRect?.(tx - 2, ty, tw, th, 4) ?? ctx.fillRect(tx - 2, ty, tw, th);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(tip, tx + 4, ty + th / 2);
    ctx.font = `10px -apple-system,system-ui,sans-serif`;
  }
}

const TP = { l: 44, r: 14, t: 8, b: 22 };

function renderTimeSeries(canvas, ts, frame, dt, compKey) {
  if (!canvas || !ts || ts.length <= 1) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.width  / dpr;
  const H   = canvas.height / dpr;
  if (W < 4 || H < 4) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const nt    = ts.length;
  const plotW = W - TP.l - TP.r;
  const plotH = H - TP.t - TP.b;
  if (plotW < 4 || plotH < 4) return;

  let vmin = Infinity, vmax = -Infinity;
  for (let i = 0; i < nt; i++) {
    if (ts[i] < vmin) vmin = ts[i];
    if (ts[i] > vmax) vmax = ts[i];
  }
  const range = vmax === vmin ? 1 : vmax - vmin;
  const xAt   = i => TP.l + (i / (nt - 1)) * plotW;
  const yAt   = v => TP.t + (1 - (v - vmin) / range) * plotH;

  const dark  = isDark();
  const lbClr = dark ? 'rgba(255,255,255,0.82)' : 'rgba(0,0,0,0.60)';
  const gClr  = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.07)';
  const lnClr = compKey === 'v' ? '#059669' : compKey === 'w' ? '#7C3AED' : '#0891B2';

  ctx.font = `10px -apple-system,system-ui,sans-serif`;

  const yTks = niceTicks(vmin, vmax, 3);
  ctx.fillStyle = lbClr; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of yTks) {
    const y = yAt(v);
    ctx.strokeStyle = gClr; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(TP.l, y); ctx.lineTo(TP.l + plotW, y); ctx.stroke();
    ctx.fillStyle = lbClr; ctx.fillText(fmtNum(v), TP.l - 4, y);
  }
  const tTks = niceTicks(0, (nt - 1) * dt, 5);
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const t of tTks) {
    const x = xAt(t / dt);
    ctx.strokeStyle = gClr; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(x, TP.t); ctx.lineTo(x, TP.t + plotH); ctx.stroke();
    ctx.fillStyle = lbClr; ctx.fillText(fmtNum(t, 0), x, TP.t + plotH + 2);
  }
  ctx.beginPath(); ctx.strokeStyle = lnClr; ctx.lineWidth = 1.2;
  for (let i = 0; i < nt; i++) {
    const x = xAt(i), y = yAt(ts[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  const sx = xAt(frame);
  ctx.strokeStyle = '#FACC15'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(sx, TP.t); ctx.lineTo(sx, TP.t + plotH); ctx.stroke();
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 0.5; ctx.strokeRect(TP.l, TP.t, plotW, plotH);
  ctx.fillStyle = lbClr; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText('Time (s)', TP.l + plotW / 2, H - 1);
}

// ── Profile: renders all visible files overlaid ───────────────────────────────
// entries: [{ stats, bts, color, label }]
const PP = { l: 56, r: 128, t: 24, b: 34 };

function renderProfiles(canvas, entries) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.width  / dpr;
  const H   = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const valid = (entries ?? []).filter(e => e.stats && e.bts && e.stats.z_vals?.length);
  if (!valid.length) return;

  const plotW = W - PP.l - PP.r;
  const plotH = H - PP.t - PP.b;
  if (plotW < 4 || plotH < 4) return;

  const dark  = isDark();
  const lbClr = dark ? 'rgba(255,255,255,0.82)' : 'rgba(0,0,0,0.60)';
  const gClr  = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.07)';

  // Global axis ranges across all entries
  let uMin = Infinity, uMax = -Infinity, zMin = Infinity, zMax = -Infinity, sigMax = 0;
  for (const { stats } of valid) {
    const { z_vals, udisp_z, sig_z } = stats;
    for (let i = 0; i < z_vals.length; i++) {
      if (z_vals[i] < zMin) zMin = z_vals[i];
      if (z_vals[i] > zMax) zMax = z_vals[i];
      if (udisp_z[i] < uMin) uMin = udisp_z[i];
      if (udisp_z[i] > uMax) uMax = udisp_z[i];
    }
    for (let i = 0; i < sig_z.length; i++) if (sig_z[i] > sigMax) sigMax = sig_z[i];
  }
  const uRng = uMax - uMin || 1;
  const uLo  = uMin - uRng * 0.08, uHi = uMax + uRng * 0.08;
  const zRng = zMax - zMin || 1;
  sigMax = sigMax * 1.2 || 1;

  const xAt = u => PP.l + (u - uLo) / (uHi - uLo) * plotW;
  const yAt = z => PP.t + (1 - (z - zMin) / zRng) * plotH;
  const sigAxisW = PP.r - 18;
  const sX = sg => PP.l + plotW + (sg / sigMax) * sigAxisW;

  ctx.font = '10px -apple-system,system-ui,sans-serif';

  // U-axis ticks
  for (const u of niceTicks(uLo, uHi, 5)) {
    const x = xAt(u);
    ctx.strokeStyle = gClr; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(x, PP.t); ctx.lineTo(x, PP.t + plotH); ctx.stroke();
    ctx.fillStyle = lbClr; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(fmtNum(u, 1), x, PP.t + plotH + 3);
  }
  // Z-axis ticks
  for (const z of niceTicks(zMin, zMax, 5)) {
    const y = yAt(z);
    ctx.strokeStyle = gClr; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(PP.l, y); ctx.lineTo(PP.l + plotW, y); ctx.stroke();
    ctx.fillStyle = lbClr; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(Math.round(z), PP.l - 4, y);
  }

  // σᵤ secondary axis ticks
  ctx.font = '9.5px -apple-system,system-ui,sans-serif';
  ctx.fillStyle = '#A78BFA';
  for (const st of niceTicks(0, sigMax / 1.2, 2)) {
    if (st < 0) continue;
    const x = sX(st);
    ctx.strokeStyle = 'rgba(167,139,250,0.10)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(x, PP.t); ctx.lineTo(x, PP.t + plotH); ctx.stroke();
    ctx.strokeStyle = 'rgba(167,139,250,0.55)'; ctx.lineWidth = 0.75;
    ctx.beginPath(); ctx.moveTo(x, PP.t); ctx.lineTo(x, PP.t + 4); ctx.stroke();
    ctx.fillStyle = '#A78BFA'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(fmtNum(st, 1), x, PP.t + 6);
  }
  // σᵤ axis header
  ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.fillText('σᵤ (m/s) →', PP.l + plotW + sigAxisW, 1);
  // σᵤ separator
  ctx.strokeStyle = 'rgba(167,139,250,0.4)'; ctx.lineWidth = 0.75;
  ctx.beginPath(); ctx.moveTo(PP.l + plotW, PP.t); ctx.lineTo(PP.l + plotW, PP.t + plotH); ctx.stroke();

  // Plot border
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 0.5; ctx.strokeRect(PP.l, PP.t, plotW, plotH);

  ctx.font = '10px -apple-system,system-ui,sans-serif';

  // Draw each file's profiles
  for (const { stats, bts, color } of valid) {
    const { z_vals, udisp_z, sig_z } = stats;
    const { nz, zhub } = bts;

    // Hub height (subtle)
    if (zhub >= zMin && zhub <= zMax) {
      ctx.strokeStyle = color + '55'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(PP.l, yAt(zhub)); ctx.lineTo(PP.l + plotW, yAt(zhub)); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Ū(z) — solid, clipped to main plot
    ctx.save();
    ctx.beginPath(); ctx.rect(PP.l, PP.t, plotW, plotH); ctx.clip();
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2.2;
    for (let iz = 0; iz < nz; iz++) {
      const x = xAt(udisp_z[iz]), y = yAt(z_vals[iz]);
      iz === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    // σᵤ(z) — dashed, clipped to secondary axis area
    ctx.save();
    ctx.beginPath(); ctx.rect(PP.l + plotW, PP.t, sigAxisW + 2, plotH); ctx.clip();
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
    for (let iz = 0; iz < nz; iz++) {
      const x = sX(sig_z[iz]), y = yAt(z_vals[iz]);
      iz === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.setLineDash([]); ctx.restore();
  }

  // Legend (top-left of main plot)
  ctx.font = '11px -apple-system,system-ui,sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const lineH = 15, swatchW = 18, padL = PP.l + 6, padT = PP.t + 6;
  valid.forEach(({ color, label }, i) => {
    const y = padT + i * lineH;
    ctx.strokeStyle = color; ctx.lineWidth = 2.2; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(padL, y + 5.5); ctx.lineTo(padL + swatchW, y + 5.5); ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(label, padL + swatchW + 4, y);
  });

  // Axis labels
  ctx.font = '10px -apple-system,system-ui,sans-serif';
  ctx.fillStyle = lbClr; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText('Wind speed (m/s)', PP.l + plotW / 2, H - 1);
  ctx.save(); ctx.translate(11, PP.t + plotH / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = lbClr;
  ctx.fillText('Height (m)', 0, 0); ctx.restore();
  ctx.lineWidth = 1;
}

// ── Spectrum: renders all visible files' PSDs overlaid ────────────────────────
// psdEntries: [{ result: { freqs, psd, nSeg }, kaimal, color, label }]
const SP = { l: 56, r: 18, t: 18, b: 36 };

function renderSpectrum(canvas, psdEntries, specMode, cohResult) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.width  / dpr;
  const H   = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const dark  = isDark();
  const lbClr = dark ? 'rgba(255,255,255,0.82)' : 'rgba(0,0,0,0.60)';
  const gClr  = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.07)';
  const plotW = W - SP.l - SP.r;
  const plotH = H - SP.t - SP.b;
  if (plotW < 4 || plotH < 4) return;

  if (specMode === 'coherence' && cohResult) {
    const { freqs, coh, nSeg: cohNSeg } = cohResult;
    const fmin = freqs[1] || 1e-5, fmax = freqs[freqs.length - 1];
    const lfMin = Math.log10(fmin), lfMax = Math.log10(fmax);
    const xAt = f  => SP.l + (Math.log10(f) - lfMin) / (lfMax - lfMin) * plotW;
    const yAt = c  => SP.t + (1 - c) * plotH;

    ctx.font = `10px -apple-system,system-ui,sans-serif`;
    for (const f of logTicks(fmin, fmax)) {
      const x = xAt(f);
      ctx.strokeStyle = gClr; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(x, SP.t); ctx.lineTo(x, SP.t + plotH); ctx.stroke();
      if ([1,2,5].includes(Math.round(f / Math.pow(10, Math.floor(Math.log10(f)))))) {
        const lbl = fmtFreq(f);
        const hw = ctx.measureText(lbl).width / 2;
        if (x - hw >= 0 && x + hw <= W) {
          ctx.fillStyle = lbClr; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          ctx.fillText(lbl, x, SP.t + plotH + 3);
        }
      }
    }
    for (const c of [0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
      const y = yAt(c);
      ctx.strokeStyle = gClr; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(SP.l, y); ctx.lineTo(SP.l + plotW, y); ctx.stroke();
      ctx.fillStyle = lbClr; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(c.toFixed(1), SP.l - 4, y);
    }
    ctx.beginPath(); ctx.strokeStyle = '#7C3AED'; ctx.lineWidth = 1.5;
    let first = true;
    for (let k = 1; k < freqs.length; k++) {
      if (freqs[k] < fmin) continue;
      const x = xAt(freqs[k]), y = yAt(Math.max(0, Math.min(1, coh[k])));
      first ? (ctx.moveTo(x, y), first = false) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 0.5; ctx.strokeRect(SP.l, SP.t, plotW, plotH);
    ctx.fillStyle = lbClr; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('Frequency (Hz)', SP.l + plotW / 2, H - 1);
    ctx.save(); ctx.translate(11, SP.t + plotH / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('Coherence γ²', 0, 0); ctx.restore();
    ctx.font = '9.5px -apple-system,system-ui,sans-serif';
    ctx.fillStyle = lbClr; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    if (cohNSeg) ctx.fillText(`Welch · ${cohNSeg} segments`, SP.l + 4, SP.t + 3);

  } else if (psdEntries?.length) {
    // Compute combined log ranges across all entries
    let fmin = Infinity, fmax = -Infinity, pmin = Infinity, pmax = -Infinity;
    for (const { result } of psdEntries) {
      const { freqs, psd } = result;
      for (let k = 1; k < freqs.length; k++) {
        if (freqs[k] <= 0) continue;
        if (freqs[k] < fmin) fmin = freqs[k];
        if (freqs[k] > fmax) fmax = freqs[k];
        if (psd[k] > 0) { if (psd[k] < pmin) pmin = psd[k]; if (psd[k] > pmax) pmax = psd[k]; }
      }
    }
    if (!isFinite(fmin)) return;
    const lfMin = Math.log10(fmin), lfMax = Math.log10(fmax);
    const lpMin = Math.floor(Math.log10(pmin)), lpMax = Math.ceil(Math.log10(pmax));
    const xAt = f => SP.l + (Math.log10(f) - lfMin) / (lfMax - lfMin) * plotW;
    const yAt = p => SP.t + (1 - (Math.log10(Math.max(p, 1e-30)) - lpMin) / (lpMax - lpMin)) * plotH;

    ctx.font = `10px -apple-system,system-ui,sans-serif`;
    for (const f of logTicks(fmin, fmax)) {
      const x = xAt(f);
      ctx.strokeStyle = gClr; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(x, SP.t); ctx.lineTo(x, SP.t + plotH); ctx.stroke();
      if ([1,2,5].includes(Math.round(f / Math.pow(10, Math.floor(Math.log10(f)))))) {
        const lbl = fmtFreq(f);
        const hw = ctx.measureText(lbl).width / 2;
        if (x - hw >= 0 && x + hw <= W) {
          ctx.fillStyle = lbClr; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          ctx.fillText(lbl, x, SP.t + plotH + 3);
        }
      }
    }
    for (let p = lpMin; p <= lpMax; p++) {
      const y = yAt(Math.pow(10, p));
      ctx.strokeStyle = gClr; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(SP.l, y); ctx.lineTo(SP.l + plotW, y); ctx.stroke();
      ctx.fillStyle = lbClr; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(`1e${p}`, SP.l - 4, y);
    }
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 0.5; ctx.strokeRect(SP.l, SP.t, plotW, plotH);
    ctx.fillStyle = lbClr; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('Frequency (Hz)', SP.l + plotW / 2, H - 1);
    ctx.save(); ctx.translate(11, SP.t + plotH / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('PSD (m²/s²/Hz)', 0, 0); ctx.restore();

    ctx.save();
    ctx.beginPath(); ctx.rect(SP.l, SP.t, plotW, plotH); ctx.clip();

    // PSD lines — one per entry in file colour
    for (const { result, color } of psdEntries) {
      const { freqs, psd } = result;
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.5;
      let first = true;
      for (let k = 1; k < freqs.length; k++) {
        if (psd[k] <= 0) continue;
        const logP = Math.log10(psd[k]);
        if (logP > lpMax || logP < lpMin) { first = true; continue; }
        const x = xAt(freqs[k]), y = yAt(psd[k]);
        first ? (ctx.moveTo(x, y), first = false) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Kaimal: only when a single file is visible (avoids clutter)
    if (psdEntries.length === 1 && psdEntries[0].kaimal) {
      const { kaimal, result: { freqs } } = psdEntries[0];
      ctx.beginPath(); ctx.strokeStyle = 'rgba(249,115,22,0.9)'; ctx.lineWidth = 1.8;
      ctx.setLineDash([5, 3]); let first = true;
      for (let k = 1; k < freqs.length; k++) {
        const p = kaimal[k];
        if (p <= 0 || freqs[k] < fmin) continue;
        const logP = Math.log10(p);
        if (logP > lpMax || logP < lpMin) { first = true; continue; }
        const x = xAt(freqs[k]), y = yAt(p);
        first ? (ctx.moveTo(x, y), first = false) : ctx.lineTo(x, y);
      }
      ctx.stroke(); ctx.setLineDash([]);
    }

    ctx.restore();

    // Legend top-right
    ctx.setLineDash([]);
    ctx.font = '10px -apple-system,system-ui,sans-serif'; ctx.textBaseline = 'top';
    const showKaimal = psdEntries.length === 1 && psdEntries[0].kaimal;
    const items = [
      ...psdEntries.map(e => ({ clr: e.color, dash: false, lbl: e.label })),
      ...(showKaimal ? [{ clr: 'rgba(249,115,22,0.9)', dash: true, lbl: 'IEC Kaimal' }] : []),
    ];
    const swW = 16, pad = 6;
    items.forEach(({ clr, dash, lbl }, i) => {
      const tw = ctx.measureText(lbl).width;
      const x2 = SP.l + plotW - pad;
      const x1 = x2 - tw - swW - 5;
      const y  = SP.t + pad + i * 14;
      ctx.strokeStyle = clr; ctx.lineWidth = dash ? 1.5 : 2;
      if (dash) ctx.setLineDash([4, 3]); else ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x1, y + 5); ctx.lineTo(x1 + swW, y + 5); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = clr; ctx.textAlign = 'left';
      ctx.fillText(lbl, x1 + swW + 4, y);
    });
  }
}

// ── BTS Scanner Modal ─────────────────────────────────────────────────────────
function BtsScannerModal({ onClose, onLoad, loadedPaths, initialDir = '' }) {
  const [closing,    setClosing]    = useState(false);
  const [dir,        setDir]        = useState(initialDir);
  const [results,    setResults]    = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [adding,     setAdding]     = useState(false);
  const [err,        setErr]        = useState('');
  const [hasScanned, setHasScanned] = useState(false);
  const [collapsed,  setCollapsed]  = useState(new Set());
  const [pending,    setPending]    = useState(new Set()); // checked for bulk add

  const handleClose = () => { if (closing) return; setClosing(true); setTimeout(onClose, 200); };

  const toggleGroup = (folder) => setCollapsed(prev => {
    const next = new Set(prev);
    next.has(folder) ? next.delete(folder) : next.add(folder);
    return next;
  });

  const togglePending = (path) => setPending(prev => {
    const next = new Set(prev);
    next.has(path) ? next.delete(path) : next.add(path);
    return next;
  });

  const toggleGroupPending = (files) => {
    const unloaded = files.filter(f => !loadedPaths.has(f.path)).map(f => f.path);
    const allChecked = unloaded.every(p => pending.has(p));
    setPending(prev => {
      const next = new Set(prev);
      allChecked ? unloaded.forEach(p => next.delete(p)) : unloaded.forEach(p => next.add(p));
      return next;
    });
  };

  const handleAddSelected = async () => {
    setAdding(true);
    for (const path of pending) {
      if (!loadedPaths.has(path)) await onLoad(path);
    }
    setPending(new Set());
    setAdding(false);
    handleClose();
  };

  const handleBrowse = async () => {
    const d = await openDialog({ directory: true, title: 'Select folder to scan' });
    if (d) setDir(d);
  };

  const handleScan = async () => {
    if (!dir) return;
    setLoading(true); setErr(''); setResults([]);
    try {
      const files = await invoke('scan_bts_files', { dir });
      setResults(files);
      const folders = new Set();
      for (const f of files) {
        const parts = f.rel_path.replace(/\\/g, '/').split('/');
        folders.add(parts.length > 1 ? parts.slice(0, -1).join(' / ') : '(root)');
      }
      setCollapsed(folders);
    } catch (e) { setErr(String(e)); }
    finally { setLoading(false); setHasScanned(true); }
  };

  const grouped = useMemo(() => {
    const map = new Map();
    for (const f of results) {
      const parts = f.rel_path.replace(/\\/g, '/').split('/');
      const folder = parts.length > 1 ? parts.slice(0, -1).join(' / ') : '(root)';
      if (!map.has(folder)) map.set(folder, []);
      map.get(folder).push(f);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [results]);

  return (
    <div className={`${s.scanOverlay}${closing ? ` ${s.scanOverlayExit}` : ''}`} onClick={e => { if (e.target === e.currentTarget) handleClose(); }}>
      <div className={`${s.scanModal}${closing ? ` ${s.scanModalExit}` : ''}`}>
        <div className={s.scanHead}>
          <span className={s.scanTitle}>Scan for .bts files</span>
          <button className={s.scanClose} onClick={handleClose}><X size={13}/></button>
        </div>
        <div className={s.scanDirRow}>
          <input className={s.scanDirInput} value={dir} readOnly placeholder="Select a directory to scan…" />
          <button className={s.scanBtn} onClick={handleBrowse}>Browse</button>
          <button className={s.scanBtn} onClick={handleScan} disabled={!dir || loading}>
            {loading ? <RefreshCw size={12} className={s.spin}/> : <Search size={12}/>}
            {loading ? 'Scanning…' : 'Scan'}
          </button>
        </div>
        {err && <div className={s.scanErr}>{err}</div>}
        <div className={s.scanResults}>
          {grouped.length === 0 && !loading && hasScanned && (
            <div className={s.scanEmpty}>No .bts files found in that directory.</div>
          )}
          {grouped.map(([folder, files]) => {
            const isCollapsed = collapsed.has(folder);
            const unloaded = files.filter(f => !loadedPaths.has(f.path));
            const allChecked = unloaded.length > 0 && unloaded.every(f => pending.has(f.path));
            const someChecked = !allChecked && unloaded.some(f => pending.has(f.path));
            return (
              <div key={folder} className={s.scanGroup}>
                <div className={s.scanGroupLabel} onClick={() => toggleGroup(folder)}>
                  <ChevronDown
                    size={9} strokeWidth={2.5}
                    className={[s.scanGroupChevron, isCollapsed ? s.scanGroupChevronClosed : ''].join(' ')}
                  />
                  <span className={s.scanGroupName}>{folder}</span>
                  <span className={s.scanGroupCount}>{files.length}</span>
                  {unloaded.length > 0 && (
                    <input
                      type="checkbox"
                      className={s.scanGroupCheck}
                      checked={allChecked}
                      ref={el => { if (el) el.indeterminate = someChecked; }}
                      onChange={e => { e.stopPropagation(); toggleGroupPending(files); }}
                      onClick={e => e.stopPropagation()}
                      title={allChecked ? 'Deselect all in group' : 'Select all in group'}
                    />
                  )}
                </div>
                <div className={`${s.scanGroupBody}${isCollapsed ? ` ${s.scanGroupBodyCollapsed}` : ''}`}>
                  <div className={s.scanGroupBodyInner}>
                    {files.map(f => {
                      const isLoaded = loadedPaths.has(f.path);
                      const isChecked = pending.has(f.path);
                      return (
                        <div key={f.path}
                          className={[s.scanRow, isLoaded ? s.scanRowCurrent : '', isChecked ? s.scanRowChecked : ''].join(' ')}
                          onClick={() => !isLoaded && togglePending(f.path)}>
                          <input
                            type="checkbox"
                            className={s.scanRowCheck}
                            checked={isLoaded || isChecked}
                            disabled={isLoaded}
                            onChange={() => !isLoaded && togglePending(f.path)}
                            onClick={e => e.stopPropagation()}
                          />
                          <span className={s.scanFileName} title={f.path}>{f.name}</span>
                          <span className={s.scanMeta}>
                            {f.nz}×{f.ny} · {fmtNum(f.uhub, 1)} m/s · {fmtNum(f.duration, 0)}s
                          </span>
                          {isLoaded
                            ? <span className={s.scanLoadedBadge}>✓ Loaded</span>
                            : <button className={s.scanLoadBtn}
                                onClick={e => { e.stopPropagation(); onLoad(f.path); }}
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
        {pending.size > 0 && (
          <div className={s.scanFooter}>
            <span className={s.scanFooterHint}>{pending.size} file{pending.size > 1 ? 's' : ''} selected</span>
            <button className={s.scanFooterClear} onClick={() => setPending(new Set())}>Clear</button>
            <button className={s.scanFooterAdd} onClick={handleAddSelected} disabled={adding}>
              {adding ? <RefreshCw size={12} className={s.spin}/> : null}
              {adding ? 'Loading…' : `Add ${pending.size} file${pending.size > 1 ? 's' : ''}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function WindFieldPanel({ onLog, project, onFileLoaded }) {
  // Canvas refs
  const canvasRef   = useRef(null);
  const wrapRef     = useRef(null);
  const tsCanvasRef = useRef(null);
  const tsWrapRef   = useRef(null);
  const prCanvasRef = useRef(null);
  const prWrapRef   = useRef(null);
  const spCanvasRef = useRef(null);
  const spWrapRef   = useRef(null);
  const drawFnRef   = useRef(null);
  const spDrawFnRef = useRef(null);
  const rafRef      = useRef(null);
  const lastTick    = useRef(0);
  const pingDir     = useRef(1);
  const hoverRef    = useRef(null);
  const colorIdxRef = useRef(0);

  // ── Multi-file state ──────────────────────────────────────────────────────
  // Each entry: { id, label, path, bts, stats, globalMM, psd, colorIdx, visible }
  const [files,     setFiles]     = useState([]);
  const [activeId,  setActiveId]  = useState(null);
  const [editingId, setEditingId] = useState(null);

  // ── Panel-level UI state ──────────────────────────────────────────────────
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const [viewTab,  setViewTab]  = useState('field');
  const [comp,     setComp]     = useState('u');
  const [colormap, setColormap] = useState('viridis');
  const [rangeLock,setRangeLock]= useState(false);
  const [frame,    setFrame]    = useState(0);
  const [playing,  setPlaying]  = useState(false);
  const [playMode, setPlayMode] = useState('loop');
  const [fps,      setFps]      = useState(24);
  const [pinnedPt, setPinnedPt] = useState(null);
  const [showTS,   setShowTS]   = useState(true);
  const [scanOpen,   setScanOpen]   = useState(false);
  const [fitSquare,    setFitSquare]    = useState(false);
  const [smoothField,  setSmoothField]  = useState(false);
  const [showContours, setShowContours] = useState(false);
  const [specMode,   setSpecMode]   = useState('psd');
  const [cohIz,    setCohIz]    = useState(0);
  const [cohIy,    setCohIy]    = useState(0);
  const [cohResult, setCohResult] = useState(null);

  // ── Derived active-file values ────────────────────────────────────────────
  const activeFile = useMemo(() => files.find(f => f.id === activeId) ?? null, [files, activeId]);
  const bts        = activeFile?.bts      ?? null;
  const stats      = activeFile?.stats    ?? null;
  const globalMM   = activeFile?.globalMM ?? null;

  // Profile and spectrum show only the active file — each tab is independent
  const profileEntries = useMemo(() =>
    activeFile?.stats ? [{
      stats: activeFile.stats,
      bts:   activeFile.bts,
      color: FILE_COLORS[activeFile.colorIdx % FILE_COLORS.length],
      label: activeFile.label,
    }] : [],
    [activeFile]);

  const psdEntries = useMemo(() =>
    activeFile?.psd ? [{
      result: activeFile.psd.result,
      kaimal: activeFile.psd.kaimal,
      color:  FILE_COLORS[activeFile.colorIdx % FILE_COLORS.length],
      label:  activeFile.label,
    }] : [],
    [activeFile]);

  // Loaded paths set (for scanner modal to show which files are already loaded)
  const loadedPaths = useMemo(() => new Set(files.map(f => f.path)), [files]);

  // Report active file path to parent
  useEffect(() => { onFileLoaded?.(activeFile?.path ?? null); }, [activeFile?.path, onFileLoaded]);

  // Refs mirroring state (for callbacks / animation)
  const btsRef      = useRef(null);
  const compRef     = useRef('u');
  const frameRef    = useRef(0);
  const playRef     = useRef(false);
  const modeRef     = useRef('loop');
  const fpsRef      = useRef(24);
  const gmRef       = useRef(null);
  const rlRef       = useRef(false);
  const cmRef       = useRef('viridis');
  const pinnedRef    = useRef(null);
  const statsRef     = useRef(null);
  const smoothRef    = useRef(false);
  const contoursRef  = useRef(false);

  useEffect(() => { btsRef.current    = bts;          }, [bts]);
  useEffect(() => { compRef.current   = comp;      }, [comp]);
  useEffect(() => { frameRef.current  = frame;     }, [frame]);
  useEffect(() => { playRef.current   = playing;   }, [playing]);
  useEffect(() => { modeRef.current   = playMode;  }, [playMode]);
  useEffect(() => { fpsRef.current    = fps;       }, [fps]);
  useEffect(() => { gmRef.current     = globalMM;  }, [globalMM]);
  useEffect(() => { rlRef.current     = rangeLock; }, [rangeLock]);
  useEffect(() => { cmRef.current     = colormap;  }, [colormap]);
  useEffect(() => { pinnedRef.current   = pinnedPt;     }, [pinnedPt]);
  useEffect(() => { statsRef.current    = stats;        }, [stats]);
  useEffect(() => { smoothRef.current   = smoothField;  }, [smoothField]);
  useEffect(() => { contoursRef.current = showContours; }, [showContours]);

  const compArr = useMemo(() => {
    if (!bts) return null;
    return bts[comp];
  }, [bts, comp]);

  // ── Reset per-file UI when active tab switches ────────────────────────────
  useEffect(() => {
    if (!activeFile) { setPinnedPt(null); return; }
    const { stats: st } = activeFile;
    if (!st) { setPinnedPt(null); return; }
    setPinnedPt({ iz: st.iz_hub, iy: st.iy_hub });
    setFrame(0);
    setPlaying(false);
    setCohIz(st.iz_hub);
    setCohIy(Math.max(0, st.iy_hub - 2));
    setCohResult(null);
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Compute PSD for active file when switching to spectrum tab ───────────
  useEffect(() => {
    if (viewTab !== 'spectrum' || !activeFile?.stats || activeFile.psd) return;
    const fs = 1 / activeFile.bts.dt;
    const result = computeWelchPSD(activeFile.stats.uts, fs);
    const kaimal = kaimalSpectrum(result.freqs, activeFile.stats.su, activeFile.bts.uhub, activeFile.bts.zhub);
    setFiles(prev => prev.map(f => f.id === activeFile.id ? { ...f, psd: { result, kaimal } } : f));
  }, [viewTab, activeFile]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Coherence (active file only) ─────────────────────────────────────────
  useEffect(() => {
    if (specMode !== 'coherence' || !activeFile?.psd || !stats || !bts) return;
    const { nz, ny, nt } = bts;
    const sig2 = new Float64Array(nt);
    for (let t = 0; t < nt; t++) sig2[t] = bts.u[t * nz * ny + cohIz * ny + cohIy];
    setCohResult(computeWelchCoherence(stats.uts, sig2, 1 / bts.dt));
  }, [specMode, cohIz, cohIy, activeFile?.psd, stats, bts]);

  // ── Field canvas draw ─────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const b = btsRef.current;
    if (!b) return;
    const arr = b[compRef.current];
    const lut = LUTS[cmRef.current] ?? LUTS.viridis;
    let vmin = null, vmax = null;
    const mm = gmRef.current;
    if (rlRef.current && mm) {
      const c = compRef.current;
      vmin = mm[c].min; vmax = mm[c].max;
    }
    renderField(canvasRef.current, b, arr, frameRef.current, lut, vmin, vmax,
                pinnedRef.current, hoverRef.current,
                { smooth: smoothRef.current, contours: contoursRef.current });
  }, []);
  drawFnRef.current = draw;

  useEffect(() => { drawFnRef.current?.(); },
    [bts, compArr, frame, colormap, rangeLock, globalMM, pinnedPt, smoothField, showContours]);

  // Time series redraw
  useEffect(() => {
    if (!stats || !pinnedPt || !bts) return;
    if (tsCanvasRef.current && tsWrapRef.current) {
      setupCanvas(tsCanvasRef.current, tsWrapRef.current);
    }
    const { nz, ny } = bts;
    const ts = new Float32Array(bts.nt);
    const arr = bts[comp];
    for (let t = 0; t < bts.nt; t++)
      ts[t] = arr[t * nz * ny + pinnedPt.iz * ny + pinnedPt.iy];
    renderTimeSeries(tsCanvasRef.current, ts, frame, bts.dt, comp);
  }, [stats, pinnedPt, bts, comp, frame, showTS]);

  // Profile redraw (all visible files)
  useEffect(() => {
    if (viewTab === 'profile' && prCanvasRef.current) {
      renderProfiles(prCanvasRef.current, profileEntries);
    }
  }, [viewTab, profileEntries]);

  // Spectrum redraw
  useEffect(() => {
    const fn = () => renderSpectrum(spCanvasRef.current, psdEntries, specMode, cohResult);
    spDrawFnRef.current = fn;
    if (viewTab === 'spectrum') fn();
  }, [viewTab, psdEntries, specMode, cohResult]);

  // Theme-change redraw
  useEffect(() => {
    const redrawAll = () => {
      drawFnRef.current?.();
      const b = btsRef.current, pin = pinnedRef.current;
      if (b && pin) {
        const { nz, ny } = b;
        const ts = new Float32Array(b.nt);
        const arr = b[compRef.current];
        for (let t = 0; t < b.nt; t++) ts[t] = arr[t * nz * ny + pin.iz * ny + pin.iy];
        renderTimeSeries(tsCanvasRef.current, ts, frameRef.current, b.dt, compRef.current);
      }
      renderProfiles(prCanvasRef.current, profileEntries);
      spDrawFnRef.current?.();
    };
    const mo = new MutationObserver(redrawAll);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', redrawAll);
    return () => { mo.disconnect(); mq.removeEventListener('change', redrawAll); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Canvas resize observers ──────────────────────────────────────────────
  const hasBts = !!bts;

  useEffect(() => {
    if (!hasBts || viewTab !== 'field') return;
    const wrap = wrapRef.current; if (!wrap) return;
    const parent = wrap.parentElement;

    const clearStyles = () => {
      wrap.style.flex = ''; wrap.style.alignSelf = '';
      wrap.style.width = ''; wrap.style.height = '';
    };

    if (!fitSquare) {
      clearStyles();
      setupCanvas(canvasRef.current, wrap);
      drawFnRef.current?.();
      const ro = new ResizeObserver(() => { setupCanvas(canvasRef.current, wrap); drawFnRef.current?.(); });
      ro.observe(wrap);
      return () => { ro.disconnect(); clearStyles(); };
    }

    const computeDims = () => {
      let availH = parent ? parent.clientHeight : wrap.offsetHeight;
      if (parent) for (const sib of parent.children) if (sib !== wrap) availH -= sib.getBoundingClientRect().height + 4;
      const availW = parent ? parent.clientWidth : wrap.offsetWidth;
      const S = Math.max(Math.min(availW - FP.l - FP.r, Math.max(availH - FP.t - FP.b, 0)), 60);
      return { w: S + FP.l + FP.r, h: S + FP.t + FP.b };
    };

    const applySquare = ({ w, h }) => {
      wrap.style.flex = 'none'; wrap.style.alignSelf = 'center';
      wrap.style.width = `${w}px`; wrap.style.height = `${h}px`;
      setupCanvas(canvasRef.current, wrap); drawFnRef.current?.();
    };

    applySquare(computeDims());
    const ro = new ResizeObserver(() => applySquare(computeDims()));
    if (parent) ro.observe(parent);
    return () => { ro.disconnect(); clearStyles(); };
  }, [hasBts, viewTab, fitSquare]);

  useEffect(() => {
    if (!hasBts || !showTS || viewTab !== 'field') return;
    const wrap = tsWrapRef.current; if (!wrap) return;
    setupCanvas(tsCanvasRef.current, wrap);
    const drawTs = () => {
      const b = btsRef.current, pin = pinnedRef.current;
      if (!b || !pin) return;
      const { nz, ny } = b;
      const ts = new Float32Array(b.nt);
      const arr = b[compRef.current];
      for (let t = 0; t < b.nt; t++) ts[t] = arr[t * nz * ny + pin.iz * ny + pin.iy];
      renderTimeSeries(tsCanvasRef.current, ts, frameRef.current, b.dt, compRef.current);
    };
    drawTs();
    const ro = new ResizeObserver(() => { setupCanvas(tsCanvasRef.current, wrap); drawTs(); });
    ro.observe(wrap); return () => ro.disconnect();
  }, [hasBts, showTS, viewTab]);

  useEffect(() => {
    if (!hasBts || viewTab !== 'profile') return;
    const wrap = prWrapRef.current; if (!wrap) return;
    setupCanvas(prCanvasRef.current, wrap);
    renderProfiles(prCanvasRef.current, profileEntries);
    const ro = new ResizeObserver(() => {
      setupCanvas(prCanvasRef.current, wrap);
      renderProfiles(prCanvasRef.current, profileEntries);
    });
    ro.observe(wrap); return () => ro.disconnect();
  }, [hasBts, viewTab, profileEntries]);

  useEffect(() => {
    if (!hasBts || viewTab !== 'spectrum') return;
    const wrap = spWrapRef.current; if (!wrap) return;
    setupCanvas(spCanvasRef.current, wrap);
    spDrawFnRef.current?.();
    const ro = new ResizeObserver(() => { setupCanvas(spCanvasRef.current, wrap); spDrawFnRef.current?.(); });
    ro.observe(wrap); return () => ro.disconnect();
  }, [hasBts, viewTab]);

  // ── Animation loop ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing || !bts) return;
    const tick = (now) => {
      const interval = 1000 / fpsRef.current;
      if (now - lastTick.current >= interval) {
        lastTick.current = now;
        const nt = btsRef.current?.nt ?? 1;
        setFrame(f => {
          const next = f + pingDir.current;
          if (modeRef.current === 'pingpong') {
            if (next >= nt) { pingDir.current = -1; return Math.max(0, nt - 2); }
            if (next < 0)   { pingDir.current =  1; return Math.min(nt - 1, 1); }
            return next;
          }
          return next >= nt ? 0 : next < 0 ? nt - 1 : next;
        });
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    lastTick.current = performance.now();
    pingDir.current = 1;
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [playing, bts]);

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (!btsRef.current) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
      const nt = btsRef.current.nt;
      if (e.code === 'Space') { e.preventDefault(); setPlaying(p => !p); }
      else if (e.code === 'ArrowRight') {
        e.preventDefault(); setPlaying(false);
        setFrame(f => Math.min(nt - 1, f + (e.shiftKey ? 10 : 1)));
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault(); setPlaying(false);
        setFrame(f => Math.max(0, f - (e.shiftKey ? 10 : 1)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── File management handlers ─────────────────────────────────────────────
  const loadBtsFile = useCallback(async (path) => {
    if (loadedPaths.has(path)) return; // already loaded — no-op
    setLoading(true); setError('');
    try {
      const raw = await invoke('read_bts_file', { path });
      const u = decodeF32(raw.u), v = decodeF32(raw.v), w = decodeF32(raw.w);
      const bts = { ...raw, u, v, w };
      const { globalMM, ...stats } = computeBtsStats(bts);
      const id       = makeFileId();
      const label    = path.split('/').pop().replace(/\.bts$/i, '');
      const colorIdx = colorIdxRef.current++;
      setFiles(prev => [...prev, { id, label, path, bts, stats, globalMM, psd: null, colorIdx, visible: true }]);
      setActiveId(id);
      setScanOpen(false);
      onLog?.('info', `BTS loaded: ${label} — ${raw.nz}×${raw.ny} grid, ${raw.nt} steps`);
    } catch (e) {
      const msg = String(e?.message ?? e);
      setError(msg);
      onLog?.('error', `BTS load failed: ${msg}`);
    } finally { setLoading(false); }
  }, [loadedPaths, onLog]);

  const removeFile = useCallback((id) => {
    setFiles(prev => {
      const next = prev.filter(f => f.id !== id);
      setActiveId(aid => {
        if (aid !== id) return aid;
        return next[0]?.id ?? null;
      });
      return next;
    });
  }, []);

  const renameFile = useCallback((id, label) => {
    setFiles(prev => prev.map(f => f.id === id ? { ...f, label } : f));
  }, []);

  const handleOpen = useCallback(async () => {
    try {
      const path = await openDialog({
        title: 'Open TurbSim wind field', multiple: false,
        filters: [{ name: 'TurbSim BTS', extensions: ['bts'] }],
      });
      if (!path) return;
      await loadBtsFile(path);
    } catch (e) { setError(String(e)); }
  }, [loadBtsFile]);

  // ── Mouse / click handlers ───────────────────────────────────────────────
  const handleMouseMove = useCallback((e) => {
    const b = btsRef.current;
    if (!b) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const { nz, ny, dz, dy, zbottom } = b;
    const plotW = rect.width  - FP.l - FP.r;
    const plotH = rect.height - FP.t - FP.b;
    if (mx < FP.l || mx > FP.l + plotW || my < FP.t || my > FP.t + plotH) {
      hoverRef.current = null; drawFnRef.current?.(); return;
    }
    const iy  = Math.min(ny-1, Math.max(0, Math.floor((mx - FP.l) / plotW * ny)));
    const iz  = Math.min(nz-1, Math.max(0, Math.floor((1 - (my - FP.t) / plotH) * nz)));
    const y   = -(ny-1)/2*dy + iy*dy;
    const z   = zbottom + iz*dz;
    const arr = btsRef.current[compRef.current];
    const vel = arr[frameRef.current * nz * ny + iz * ny + iy];
    hoverRef.current = { iz, iy, y, z, vel };
    drawFnRef.current?.();
  }, []);

  const handleMouseLeave = useCallback(() => {
    hoverRef.current = null; drawFnRef.current?.();
  }, []);

  const handleCanvasClick = useCallback((e) => {
    const b = btsRef.current;
    if (!b) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const { nz, ny } = b;
    const plotW = rect.width  - FP.l - FP.r;
    const plotH = rect.height - FP.t - FP.b;
    if (mx < FP.l || mx > FP.l + plotW || my < FP.t || my > FP.t + plotH) return;
    const iy = Math.min(ny-1, Math.max(0, Math.floor((mx - FP.l) / plotW * ny)));
    const iz = Math.min(nz-1, Math.max(0, Math.floor((1 - (my - FP.t) / plotH) * nz)));
    setPinnedPt({ iz, iy }); setShowTS(true);
  }, []);

  const handleTsClick = useCallback((e) => {
    const b = btsRef.current;
    if (!b) return;
    const canvas = tsCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const plotW = rect.width - TP.l - TP.r;
    if (mx < TP.l || mx > TP.l + plotW) return;
    const t = Math.min(b.nt-1, Math.max(0, Math.round((mx - TP.l) / plotW * (b.nt-1))));
    setPlaying(false); setFrame(t);
  }, []);

  const handleExport = useCallback(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `windfield_frame${frameRef.current}.png`;
    a.click();
  }, []);

  // ── Derived display ──────────────────────────────────────────────────────
  const currentT = bts ? fmtNum(frame * bts.dt, 2) : '0';
  const hasFiles = files.length > 0;

  // ── JSX ──────────────────────────────────────────────────────────────────
  return (
    <div className={s.root}>

      {scanOpen && (
        <BtsScannerModal
          onClose={() => setScanOpen(false)}
          onLoad={loadBtsFile}
          loadedPaths={loadedPaths}
          initialDir={
            project?.dir ||
            (activeFile?.path ? activeFile.path.split('/').slice(0, -1).join('/') : '') ||
            ''
          }
        />
      )}

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className={s.header}>
        <div className={s.headerLeft}>
          <WindFieldIcon size={14} className={s.headerIcon}/>
          <span className={s.title}>Wind Field</span>
          {hasFiles && (
            <span className={s.headerStat}>
              {files.length} {files.length === 1 ? 'file' : 'files'}
            </span>
          )}
        </div>
        <div className={s.headerRight}>
          <button className={s.headerBtn} onClick={() => setScanOpen(true)}>
            <Search size={11} strokeWidth={1.8}/> Scan .bts
          </button>
          <button className={s.headerBtn} onClick={handleOpen} disabled={loading}>
            <FolderOpen size={11} strokeWidth={1.8}/>
            {loading ? 'Loading…' : 'Open .bts'}
          </button>
        </div>
      </div>

      {/* ── File tab row ────────────────────────────────────────────────── */}
      {hasFiles && (
        <div className={s.tabRow}>
          {files.map(f => {
            const color = FILE_COLORS[f.colorIdx % FILE_COLORS.length];
            const isActive = f.id === activeId;
            return (
              <div key={f.id}
                className={[s.fileTab, isActive ? s.fileTabActive : ''].join(' ')}
                onClick={() => setActiveId(f.id)}>
                <div className={s.fileTabAccent} style={{ background: color }}/>
                {editingId === f.id ? (
                  <input
                    className={s.fileTabInput}
                    value={f.label}
                    autoFocus
                    onChange={e => renameFile(f.id, e.target.value)}
                    onBlur={() => setEditingId(null)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') setEditingId(null); }}
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className={s.fileTabLabel}
                    title={f.path}
                    onDoubleClick={e => { e.stopPropagation(); setEditingId(f.id); }}>
                    {f.label}
                  </span>
                )}
                <button
                  className={s.fileTabClose}
                  onClick={e => { e.stopPropagation(); removeFile(f.id); }}
                  title="Remove">
                  <X size={9} strokeWidth={2.5}/>
                </button>
              </div>
            );
          })}
          <button className={s.fileTabAdd} onClick={() => setScanOpen(true)} disabled={loading} title="Scan for .bts files">
            {loading
              ? <RefreshCw size={11} className={s.spin}/>
              : <Plus size={12} strokeWidth={2}/>}
          </button>
        </div>
      )}

      {/* ── Error bar ───────────────────────────────────────────────────── */}
      {error && (
        <div className={s.errorBar}>
          <span>{error}</span>
          <button className={s.errClose} onClick={() => setError('')}>×</button>
        </div>
      )}

      {/* ── Empty state ─────────────────────────────────────────────────── */}
      {!hasFiles && !loading && (
        <div className={s.emptyState}>
          <WindFieldIcon size={46} className={s.emptyIcon}/>
          <p className={s.emptyTitle}>No wind field loaded</p>
          <p className={s.emptyHint}>
            Scan your project folder for <code>.bts</code> files, or open one directly.
          </p>
          <div className={s.emptyBtns}>
            <button className={s.emptyBtn} onClick={() => setScanOpen(true)}>
              <Search size={13}/> Scan project
            </button>
            <button className={s.emptyBtn} onClick={handleOpen}>
              <FolderOpen size={13}/> Open .bts
            </button>
          </div>
        </div>
      )}

      {/* ── Main body ───────────────────────────────────────────────────── */}
      {hasFiles && (
        <div className={s.body}>

          {/* ── Sidebar ────────────────────────────────────────────────── */}
          <div className={s.sidebar}>

            <div className={s.sideCard}>
              <div className={s.cardHead} style={{ color: '#0891B2' }}>Grid &amp; Wind</div>
              {bts ? (
                <div className={s.metaGrid}>
                  <span className={s.mk}>Size</span>
                  <span className={s.mv}>{bts.nz}×{bts.ny}</span>
                  <span className={s.mk}>dZ / dY</span>
                  <span className={s.mv}>{fmtNum(bts.dz,1)} / {fmtNum(bts.dy,1)} m</span>
                  <span className={s.mk}>Z range</span>
                  <span className={s.mv}>{fmtNum(bts.zbottom,0)}–{fmtNum(bts.zbottom+(bts.nz-1)*bts.dz,0)} m</span>
                  <span className={s.mk}>U<sub>hub</sub></span>
                  <span className={s.mv}>{fmtNum(bts.uhub,1)} m/s</span>
                  <span className={s.mk}>Z<sub>hub</sub></span>
                  <span className={s.mv}>{fmtNum(bts.zhub,0)} m</span>
                  <span className={s.mk}>dt</span>
                  <span className={s.mv}>{bts.dt.toFixed(4)} s</span>
                  <span className={s.mk}>Duration</span>
                  <span className={s.mv}>{fmtNum((bts.nt-1)*bts.dt,1)} s</span>
                  <span className={s.mk}>Frames</span>
                  <span className={s.mv}>{bts.nt.toLocaleString()}</span>
                </div>
              ) : (
                <div className={s.statsLoading}>Select a tab to view metadata</div>
              )}
            </div>

            <div className={s.sideCard}>
              <div className={s.cardHead} style={{ color: comp === 'v' ? '#059669' : comp === 'w' ? '#7C3AED' : '#0891B2' }}>Component</div>
              <div className={s.compRow}>
                {[['u','Stream'],['v','Lateral'],['w','Vertical']].map(([c,lbl]) => (
                  <button key={c}
                    className={[s.compBtn, comp===c ? s.compBtnOn : ''].join(' ')}
                    onClick={() => {
                      setComp(c);
                      if (c !== 'u') setColormap('coolwarm');
                      else setColormap('viridis');
                    }}>
                    <span className={s.compLetter}>{c.toUpperCase()}</span>
                    <span className={s.compSub}>{lbl}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className={s.sideCard}>
              <div className={s.cardHead} style={{ color: colormap === 'coolwarm' ? '#ef4444' : colormap === 'plasma' ? '#a855f7' : '#3b82f6' }}>Colormap</div>
              <div className={s.cmRow}>
                {[['viridis','Viridis','#3b82f6'],['coolwarm','Coolwarm','#ef4444'],['plasma','Plasma','#a855f7']].map(([id,lbl,clr]) => (
                  <button key={id}
                    className={[s.cmBtn, colormap===id ? s.cmBtnOn : ''].join(' ')}
                    style={{ '--cm-clr': clr }}
                    onClick={() => setColormap(id)}>
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            <div className={s.sideCard}>
              <button className={[s.rangeLockBtn, rangeLock ? s.rangeLockOn : ''].join(' ')}
                onClick={() => setRangeLock(r => !r)}>
                {rangeLock ? <Lock size={10}/> : <Unlock size={10}/>}
                {rangeLock ? 'Global range (locked)' : 'Per-frame range'}
              </button>
            </div>

            <div className={s.sideCard}>
              <div className={s.cardHead} style={{ color: '#D97706' }}>
                Analysis
                {!stats && <span className={s.cardNote}> hub point</span>}
                {stats  && <span className={s.cardNote}> hub point</span>}
              </div>
              {stats ? (
                <div className={s.metaGrid}>
                  <span className={s.mk}>Ū<sub>hub</sub></span>
                  <span className={s.mv}>{fmtNum(bts.uhub,2)} m/s</span>
                  <span className={s.mk}>TI<sub>u</sub></span>
                  <span className={[s.mv, s.mvAccent].join(' ')}>{(stats.TI_u*100).toFixed(1)}%</span>
                  <span className={s.mk}>TI<sub>v</sub></span>
                  <span className={s.mv}>{(stats.TI_v*100).toFixed(1)}%</span>
                  <span className={s.mk}>TI<sub>w</sub></span>
                  <span className={s.mv}>{(stats.TI_w*100).toFixed(1)}%</span>
                  <span className={s.mk}>Shear α</span>
                  <span className={s.mv}>{stats.alpha.toFixed(3)}</span>
                  <span className={s.mk}>σ<sub>u</sub></span>
                  <span className={s.mv}>{fmtNum(stats.su,2)} m/s</span>
                </div>
              ) : (
                <div className={s.statsLoading}>Select a tab</div>
              )}
            </div>

            {viewTab === 'field' && bts && (
              <div className={s.sideCard}>
                <button
                  className={[s.exportBtn, fitSquare ? s.exportBtnOn : ''].join(' ')}
                  onClick={() => setFitSquare(f => !f)}>
                  <Maximize2 size={11}/> Square view
                </button>
                <button
                  className={[s.exportBtn, smoothField ? s.exportBtnOn : ''].join(' ')}
                  onClick={() => setSmoothField(f => !f)}
                  title="Bilinear interpolation between grid points">
                  <Spline size={11}/> Smooth
                </button>
                <button
                  className={[s.exportBtn, showContours ? s.exportBtnOn : ''].join(' ')}
                  onClick={() => setShowContours(f => !f)}
                  title="Draw contour isolines at 10 evenly-spaced levels">
                  <Layers size={11}/> Contours
                </button>
                <button className={s.exportBtn} onClick={handleExport}>
                  <Download size={11}/> Export frame PNG
                </button>
              </div>
            )}
          </div>

          {/* ── Chart column ────────────────────────────────────────────── */}
          <div className={s.chartCol}>

            {/* View switcher — Field / Profile / Spectrum */}
            <div className={s.viewBar}>
              {[['field','Field'],['profile','Profile'],['spectrum','Spectrum']].map(([id,label]) => (
                <button key={id}
                  className={[s.viewBtn, viewTab === id ? s.viewBtnOn : ''].join(' ')}
                  onClick={() => setViewTab(id)}>
                  {label}
                </button>
              ))}
            </div>

            {/* Field view */}
            {viewTab === 'field' && bts && (
              <>
                <div className={s.fieldArea}>
                  <div className={s.canvasWrap} ref={wrapRef}>
                    <canvas ref={canvasRef} className={s.canvas}
                      onMouseMove={handleMouseMove}
                      onMouseLeave={handleMouseLeave}
                      onClick={handleCanvasClick}
                      style={{ cursor: 'crosshair' }}
                    />
                  </div>

                  {showTS && pinnedPt && (
                    <div className={s.tsPanel}>
                      <div className={s.tsPanelHead}>
                        <span className={s.tsPanelLabel}>{comp.toUpperCase()}</span>
                        <label className={s.tsPtInput}>
                          iz
                          <input type="number" min={0} max={bts.nz - 1}
                            value={pinnedPt.iz}
                            onChange={e => setPinnedPt(p => ({
                              ...p, iz: Math.min(bts.nz-1, Math.max(0, +e.target.value))
                            }))}/>
                        </label>
                        <label className={s.tsPtInput}>
                          iy
                          <input type="number" min={0} max={bts.ny - 1}
                            value={pinnedPt.iy}
                            onChange={e => setPinnedPt(p => ({
                              ...p, iy: Math.min(bts.ny-1, Math.max(0, +e.target.value))
                            }))}/>
                        </label>
                        <span className={s.tsPtCoords}>
                          z={fmtNum(bts.zbottom+pinnedPt.iz*bts.dz,1)}m&nbsp;
                          y={fmtNum(-(bts.ny-1)/2*bts.dy+pinnedPt.iy*bts.dy,1)}m
                        </span>
                        <button className={s.tsPanelClose} onClick={() => setShowTS(false)}>
                          <ChevronDown size={12}/>
                        </button>
                      </div>
                      <div className={s.tsCanvasWrap} ref={tsWrapRef}>
                        <canvas ref={tsCanvasRef} className={s.canvas}
                          onClick={handleTsClick} style={{ cursor: 'col-resize' }}/>
                      </div>
                    </div>
                  )}

                  {(!showTS || !pinnedPt) && (
                    <button className={s.tsRevealBtn} onClick={() => setShowTS(true)}>
                      <ChevronUp size={11}/>
                      {pinnedPt
                        ? `Time series (iz=${pinnedPt.iz} iy=${pinnedPt.iy})`
                        : 'Click heatmap to pin a point'}
                    </button>
                  )}
                </div>

                <div className={s.timeBar}>
                  <div className={s.tbLeft}>
                    <button className={s.ctrlBtn} onClick={() => { setPlaying(false); setFrame(0); }} title="First">
                      <SkipBack size={11} strokeWidth={2}/>
                    </button>
                    <button className={s.ctrlBtn} onClick={() => { setPlaying(false); setFrame(f => Math.max(0, f-1)); }} title="Prev (←)">
                      ‹
                    </button>
                    <button className={[s.ctrlBtn, s.playBtn].join(' ')} onClick={() => setPlaying(p => !p)} title="Play/Pause (Space)">
                      {playing ? <Pause size={12} strokeWidth={2}/> : <Play size={12} strokeWidth={2}/>}
                    </button>
                    <button className={s.ctrlBtn} onClick={() => { setPlaying(false); setFrame(f => Math.min(bts.nt-1, f+1)); }} title="Next (→)">
                      ›
                    </button>
                    <button className={s.ctrlBtn} onClick={() => { setPlaying(false); setFrame(bts.nt-1); }} title="Last">
                      <SkipForward size={11} strokeWidth={2}/>
                    </button>
                  </div>

                  <input type="range" className={s.slider}
                    min={0} max={bts.nt - 1} value={frame}
                    onChange={e => { setPlaying(false); setFrame(+e.target.value); }}
                  />

                  <div className={s.tbRight}>
                    <button
                      className={[s.modeBtn, playMode==='pingpong' ? s.modeBtnOn : ''].join(' ')}
                      onClick={() => setPlayMode(m => m==='loop' ? 'pingpong' : 'loop')}
                      title={playMode==='loop' ? 'Loop' : 'Ping-pong'}>
                      {playMode === 'pingpong' ? '↔' : <RotateCcw size={10}/>}
                    </button>
                    <select className={s.fpsSelect} value={fps} onChange={e => setFps(+e.target.value)}>
                      {[12,24,30,60].map(f => <option key={f} value={f}>{f} fps</option>)}
                    </select>
                  </div>
                  <span className={s.timeLabel}>{currentT}s · {frame+1}/{bts.nt}</span>
                </div>
              </>
            )}

            {/* Field placeholder when no active file's bts (shouldn't normally occur) */}
            {viewTab === 'field' && !bts && (
              <div className={s.fullCanvasWrap}>
                <div className={s.tabLoading}>Select a file tab above</div>
              </div>
            )}

            {/* Profile view */}
            {viewTab === 'profile' && (
              <div className={s.fullCanvasWrap} ref={prWrapRef}>
                {profileEntries.length === 0 && (
                  <div className={s.tabLoading}>No visible files — toggle 👁 on a tab</div>
                )}
                <canvas ref={prCanvasRef} className={s.canvas}/>
              </div>
            )}

            {/* Spectrum view */}
            {viewTab === 'spectrum' && (
              <div className={s.specLayout}>
                <div className={s.specTop}>
                  <div className={s.specControls}>
                    <div className={s.specModeRow}>
                      <button className={[s.specBtn, specMode==='psd'?s.specBtnOn:''].join(' ')}
                        onClick={() => setSpecMode('psd')}>PSD</button>
                      <button className={[s.specBtn, specMode==='coherence'?s.specBtnOn:''].join(' ')}
                        onClick={() => setSpecMode('coherence')}>Coherence</button>
                    </div>
                    {specMode === 'coherence' && bts && stats && (
                      <div className={s.cohControls}>
                        <span className={s.cohLabel}>Pt 1: hub (iz={stats.iz_hub} iy={stats.iy_hub})</span>
                        <span className={s.cohLabel}>Pt 2:</span>
                        <label className={s.cohInput}>
                          iz&nbsp;
                          <input type="number" min={0} max={bts.nz-1} value={cohIz}
                            onChange={e => setCohIz(Math.min(bts.nz-1, Math.max(0, +e.target.value)))}/>
                        </label>
                        <label className={s.cohInput}>
                          iy&nbsp;
                          <input type="number" min={0} max={bts.ny-1} value={cohIy}
                            onChange={e => setCohIy(Math.min(bts.ny-1, Math.max(0, +e.target.value)))}/>
                        </label>
                      </div>
                    )}
                    {specMode === 'psd' && psdEntries.length === 0 && (
                      <div className={s.specNote}>Computing spectra…</div>
                    )}
                  </div>
                </div>
                <div className={s.fullCanvasWrap} ref={spWrapRef}>
                  <canvas ref={spCanvasRef} className={s.canvas}/>
                </div>
              </div>
            )}

          </div>
        </div>
      )}
    </div>
  );
}
