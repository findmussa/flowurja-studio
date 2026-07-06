import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke }             from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Cpu, FolderOpen, Eye, Save, ChevronDown, ChevronRight, AlertTriangle,
} from "lucide-react";
import RawFileModal from "../RawFileModal";
import InfoPopover from "../InfoPopover";
import OutVarPicker from "../OutVarPicker";
import s from "./ServoDynPanel.module.css";

const ACCENT = "#4F72C5";

// ── Tabs ─────────────────────────────────────────────────────────────────────
const TABS = [
  { id: "quick",     label: "Quick"          },
  { id: "pitch",     label: "Pitch & Gen"    },
  { id: "models",    label: "Control Models" },
  { id: "yaw",       label: "Yaw & Flow"     },
  { id: "interface", label: "Interface & Out"},
];

// ── Defaults (NREL 5 MW values) ───────────────────────────────────────────────
const DEFAULT = {
  Echo: false,
  DT: "default",

  // Pitch control
  PCMode: 0, TPCOn: 0,
  TPitManS1: 9999.9, TPitManS2: 9999.9, TPitManS3: 9999.9,
  PitManRat1: 8, PitManRat2: 8, PitManRat3: 8,
  BlPitchF1: 0, BlPitchF2: 0, BlPitchF3: 0,

  // Generator & torque
  VSContrl: 0, GenModel: 2, GenEff: 94.4,
  GenTiStr: true, GenTiStp: true,
  SpdGenOn: 9999.9, TimGenOn: 9999.0, TimGenOf: 9999.9,

  // Simple VS control (VSContrl=1)
  VS_RtGnSp: 9999.9, VS_RtTq: 9999.9, VS_Rgn2K: 9999.9, VS_SlPc: 9999.9,

  // Simple induction generator (VSContrl=0, GenModel=1)
  SIG_SlPc: 9999.9, SIG_SySp: 9999.9, SIG_RtTq: 9999.9, SIG_PORt: 9999.9,

  // Thevenin generator (VSContrl=0, GenModel=2)
  TEC_Freq: 9999.9, TEC_NPol: 9998, TEC_SRes: 9999.9, TEC_RRes: 9999.9,
  TEC_VLL: 9999.9, TEC_SLR: 9999.9, TEC_RLR: 9999.9, TEC_MR: 9999.9,

  // HSS brake
  HSSBrMode: 0, THSSBrDp: 9999.9, HSSBrDT: 0.6, HSSBrTqF: 28116.2,

  // Nacelle yaw
  YCMode: 0, TYCOn: 9999.9, YawNeut: 0,
  YawSpr: "9.02832E+09", YawDamp: "1.916E+07",
  TYawManS: 9999.9, YawManRat: 0.3, NacYawF: 0,

  // Aero flow control
  AfCmode: 0, AfC_Mean: 0, AfC_Amp: 0, AfC_Phase: 0,

  // Structural controllers
  NumBStC: 0, BStCfiles: "unused",
  NumNStC: 0, NStCfiles: "unused",
  NumTStC: 0, TStCfiles: "unused",
  NumSStC: 0, SStCfiles: "unused",

  // Cable control
  CCmode: 0,

  // Bladed DLL
  DLL_FileName: "unused", DLL_InFile: "unused", DLL_ProcName: "DISCON",
  DLL_DT: "default", DLL_Ramp: false, BPCutoff: 9999.9,
  NacYaw_North: 0, Ptch_Cntrl: 0, Ptch_SetPnt: 0, Ptch_Min: 0, Ptch_Max: 0,
  PtchRate_Min: 0, PtchRate_Max: 0, Gain_OM: 0, GenSpd_MinOM: 0, GenSpd_MaxOM: 0,
  GenSpd_Dem: 0, GenTrq_Dem: 0, GenPwr_Dem: 0,
  DLL_NumTrq: 0,

  // Output
  SumPrint: false, OutFile: 1, TabDelim: true,
  OutFmt: "ES10.3E2", TStart: 30,
  OutList: '"GenPwr"\n"GenTq"\n"BlPitchC1"\n"BlPitchC2"\n"BlPitchC3"',
};

// ── Parser ───────────────────────────────────────────────────────────────────
function parseServoDynFile(content) {
  const kv = {};
  const lines = content.split("\n");
  let inOutList = false;
  const outListLines = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (inOutList) {
      if (/^END\b/i.test(line)) { inOutList = false; break; }
      const m = line.match(/^"([^"]+)"/);
      if (m) outListLines.push(`"${m[1]}"`);
      continue;
    }

    if (!line || line.startsWith("!") || /^={4,}/.test(line) || /^-{4,}/.test(line)) continue;

    let rest = line;
    let value;

    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      if (end < 0) continue;
      value = rest.slice(1, end);
      rest  = rest.slice(end + 1).trim();
    } else {
      const sp = rest.search(/\s/);
      if (sp < 0) continue;
      value = rest.slice(0, sp);
      rest  = rest.slice(sp).trim();
    }

    const keyMatch = rest.match(/^(\S+)/);
    if (!keyMatch) continue;
    const rawKey = keyMatch[1];
    const kl = rawKey.toLowerCase();

    if (kl === "outlist") { inOutList = true; continue; }

    // Normalise case-variant keys (IEA 15 MW uses "AfC_phase" vs "AfC_Phase")
    const CANON = {
      "afc_phase": "AfC_Phase",
      "afc_mean":  "AfC_Mean",
      "afc_amp":   "AfC_Amp",
    };
    const key = CANON[kl] ?? rawKey;
    kv[key] = value;
  }

  if (outListLines.length) kv["__OutList__"] = outListLines.join("\n");
  return kv;
}

function sdParsedToState(kv) {
  const st = { ...DEFAULT };
  const b  = v => typeof v === "string" && v.toLowerCase() === "true";
  const n  = v => v !== undefined && !isNaN(Number(v)) ? Number(v) : undefined;

  const boolKeys = [
    "Echo","GenTiStr","GenTiStp","DLL_Ramp","SumPrint","TabDelim",
  ];
  for (const k of boolKeys) {
    if (kv[k] !== undefined) st[k] = b(kv[k]);
  }

  const numKeys = [
    "PCMode","TPCOn","PitManRat1","PitManRat2","PitManRat3",
    "BlPitchF1","BlPitchF2","BlPitchF3",
    "VSContrl","GenModel","GenEff","SpdGenOn","TimGenOn","TimGenOf",
    "VS_RtGnSp","VS_RtTq","VS_Rgn2K","VS_SlPc",
    "SIG_SlPc","SIG_SySp","SIG_RtTq","SIG_PORt",
    "TEC_Freq","TEC_NPol","TEC_SRes","TEC_RRes","TEC_VLL","TEC_SLR","TEC_RLR","TEC_MR",
    "HSSBrMode","HSSBrDT","HSSBrTqF",
    "YCMode","TYCOn","YawNeut","YawManRat","NacYawF",
    "AfCmode","AfC_Mean","AfC_Amp","AfC_Phase",
    "NumBStC","NumNStC","NumTStC","NumSStC","CCmode",
    "BPCutoff","NacYaw_North","Ptch_Cntrl","Ptch_SetPnt","Ptch_Min","Ptch_Max",
    "PtchRate_Min","PtchRate_Max","Gain_OM","GenSpd_MinOM","GenSpd_MaxOM",
    "GenSpd_Dem","GenTrq_Dem","GenPwr_Dem","DLL_NumTrq",
    "OutFile","TStart",
  ];
  for (const k of numKeys) {
    const v = n(kv[k]); if (v !== undefined) st[k] = v;
  }

  // High-precision floats stored as strings
  for (const k of ["YawSpr","YawDamp"]) {
    if (kv[k] !== undefined) st[k] = kv[k];
  }

  // Timing values (parenthesised or not)
  const floatOrBigKeys = [
    "TPCOn","TPitManS1","TPitManS2","TPitManS3",
    "THSSBrDp","TYCOn","TYawManS",
  ];
  for (const k of floatOrBigKeys) {
    const v = n(kv[k]); if (v !== undefined) st[k] = v;
  }

  // String fields
  for (const k of [
    "DT","DLL_FileName","DLL_InFile","DLL_ProcName","DLL_DT","OutFmt",
    "BStCfiles","NStCfiles","TStCfiles","SStCfiles",
  ]) {
    if (kv[k] !== undefined) st[k] = kv[k];
  }

  // Parenthesised keys
  const paren = {
    "TPitManS(1)":"TPitManS1","TPitManS(2)":"TPitManS2","TPitManS(3)":"TPitManS3",
    "PitManRat(1)":"PitManRat1","PitManRat(2)":"PitManRat2","PitManRat(3)":"PitManRat3",
    "BlPitchF(1)":"BlPitchF1","BlPitchF(2)":"BlPitchF2","BlPitchF(3)":"BlPitchF3",
  };
  for (const [fk, sk] of Object.entries(paren)) {
    if (kv[fk] !== undefined) {
      const v = n(kv[fk]);
      st[sk] = v !== undefined ? v : kv[fk];
    }
  }

  if (kv["__OutList__"]) st.OutList = kv["__OutList__"];

  // Preserve the full raw kv so the builder can write back any params not shown in the UI
  st.__rawKV__ = { ...kv };

  return st;
}

// ── File builder ─────────────────────────────────────────────────────────────
function buildServoDynContent(p, description = "Generated by FlowUrja Studio") {
  const b   = v => v ? "True " : "False";
  const q   = v => `"${v}"`;
  const r   = (v, w = 14) => String(v).padStart(w);
  const pad = (v, n = 14) => String(v).padEnd(n);

  const outLines = (p.OutList || "")
    .split("\n").map(l => l.trim()).filter(l => l)
    .map(l => l.startsWith('"') ? l : `"${l}"`);

  const lines = [
    `------- SERVODYN v1.05.* INPUT FILE --------------------------------------------`,
    description,
    `---------------------- SIMULATION CONTROL --------------------------------------`,
    `${pad(b(p.Echo))} Echo         - Echo input data to <RootName>.ech (flag)`,
    `${pad(q(p.DT))} DT           - Communication interval for controllers (s) (or "default")`,
    `---------------------- PITCH CONTROL -------------------------------------------`,
    `${r(p.PCMode)}   PCMode       - Pitch control mode {0: none, 3: user-routine, 4: Simulink/Labview, 5: Bladed DLL} (switch)`,
    `${r(p.TPCOn)}   TPCOn        - Time to enable active pitch control (s) [unused when PCMode=0]`,
    `${r(p.TPitManS1)}   TPitManS(1)  - Time to start override pitch maneuver for blade 1 (s)`,
    `${r(p.TPitManS2)}   TPitManS(2)  - Time to start override pitch maneuver for blade 2 (s)`,
    `${r(p.TPitManS3)}   TPitManS(3)  - Time to start override pitch maneuver for blade 3 (s)`,
    `${r(p.PitManRat1)}   PitManRat(1) - Pitch maneuver rate for blade 1 (deg/s)`,
    `${r(p.PitManRat2)}   PitManRat(2) - Pitch maneuver rate for blade 2 (deg/s)`,
    `${r(p.PitManRat3)}   PitManRat(3) - Pitch maneuver rate for blade 3 (deg/s)`,
    `${r(p.BlPitchF1)}   BlPitchF(1)  - Blade 1 final pitch for pitch maneuvers (degrees)`,
    `${r(p.BlPitchF2)}   BlPitchF(2)  - Blade 2 final pitch for pitch maneuvers (degrees)`,
    `${r(p.BlPitchF3)}   BlPitchF(3)  - Blade 3 final pitch for pitch maneuvers (degrees)`,
    `---------------------- GENERATOR AND TORQUE CONTROL ----------------------------`,
    `${r(p.VSContrl)}   VSContrl     - Variable-speed control mode {0: none, 1: simple VS, 3: user-routine, 4: Simulink, 5: Bladed DLL} (switch)`,
    `${r(p.GenModel)}   GenModel     - Generator model {1: simple, 2: Thevenin, 3: user-defined} [used only when VSContrl=0]`,
    `${r(p.GenEff)}   GenEff       - Generator efficiency (%) [ignored by Thevenin and user-defined]`,
    `${pad(b(p.GenTiStr))} GenTiStr     - Method to start the generator {T: timed, F: speed-based} (flag)`,
    `${pad(b(p.GenTiStp))} GenTiStp     - Method to stop the generator {T: timed, F: power=0} (flag)`,
    `${r(p.SpdGenOn)}   SpdGenOn     - Generator speed to turn on (HSS rpm) [used only when GenTiStr=False]`,
    `${r(p.TimGenOn)}   TimGenOn     - Time to turn on the generator (s) [used only when GenTiStr=True]`,
    `${r(p.TimGenOf)}   TimGenOf     - Time to turn off the generator (s) [used only when GenTiStp=True]`,
    `---------------------- SIMPLE VARIABLE-SPEED TORQUE CONTROL --------------------`,
    `${r(p.VS_RtGnSp)}   VS_RtGnSp    - Rated generator speed (HSS rpm) [used only when VSContrl=1]`,
    `${r(p.VS_RtTq)}   VS_RtTq      - Rated generator torque in Region 3 (N-m) [used only when VSContrl=1]`,
    `${r(p.VS_Rgn2K)}   VS_Rgn2K     - Generator torque constant in Region 2 (N-m/rpm^2) [used only when VSContrl=1]`,
    `${r(p.VS_SlPc)}   VS_SlPc      - Rated generator slip percentage in Region 2.5 (%) [used only when VSContrl=1]`,
    `---------------------- SIMPLE INDUCTION GENERATOR ------------------------------`,
    `${r(p.SIG_SlPc)}   SIG_SlPc     - Rated generator slip percentage (%) [used only when VSContrl=0 and GenModel=1]`,
    `${r(p.SIG_SySp)}   SIG_SySp     - Synchronous (zero-torque) generator speed (rpm) [used only when VSContrl=0 and GenModel=1]`,
    `${r(p.SIG_RtTq)}   SIG_RtTq     - Rated torque (N-m) [used only when VSContrl=0 and GenModel=1]`,
    `${r(p.SIG_PORt)}   SIG_PORt     - Pull-out ratio (Tpullout/Trated) (-) [used only when VSContrl=0 and GenModel=1]`,
    `---------------------- THEVENIN-EQUIVALENT INDUCTION GENERATOR -----------------`,
    `${r(p.TEC_Freq)}   TEC_Freq     - Line frequency [50 or 60] (Hz) [used only when VSContrl=0 and GenModel=2]`,
    `${r(p.TEC_NPol)}   TEC_NPol     - Number of poles [even integer > 0] (-) [used only when VSContrl=0 and GenModel=2]`,
    `${r(p.TEC_SRes)}   TEC_SRes     - Stator resistance (ohms) [used only when VSContrl=0 and GenModel=2]`,
    `${r(p.TEC_RRes)}   TEC_RRes     - Rotor resistance (ohms) [used only when VSContrl=0 and GenModel=2]`,
    `${r(p.TEC_VLL)}   TEC_VLL      - Line-to-line RMS voltage (volts) [used only when VSContrl=0 and GenModel=2]`,
    `${r(p.TEC_SLR)}   TEC_SLR      - Stator leakage reactance (ohms) [used only when VSContrl=0 and GenModel=2]`,
    `${r(p.TEC_RLR)}   TEC_RLR      - Rotor leakage reactance (ohms) [used only when VSContrl=0 and GenModel=2]`,
    `${r(p.TEC_MR)}   TEC_MR       - Magnetizing reactance (ohms) [used only when VSContrl=0 and GenModel=2]`,
    `---------------------- HIGH-SPEED SHAFT BRAKE ----------------------------------`,
    `${r(p.HSSBrMode)}   HSSBrMode    - HSS brake model {0: none, 1: simple, 3: user-routine, 4: Simulink, 5: Bladed DLL} (switch)`,
    `${r(p.THSSBrDp)}   THSSBrDp     - Time to initiate deployment of the HSS brake (s)`,
    `${r(p.HSSBrDT)}   HSSBrDT      - Time for HSS-brake to reach full deployment (sec) [used only when HSSBrMode=1]`,
    `${r(p.HSSBrTqF)}   HSSBrTqF     - Fully deployed HSS-brake torque (N-m)`,
    `---------------------- NACELLE-YAW CONTROL -------------------------------------`,
    `${r(p.YCMode)}   YCMode       - Yaw control mode {0: none, 3: user-routine, 4: Simulink, 5: Bladed DLL} (switch)`,
    `${r(p.TYCOn)}   TYCOn        - Time to enable active yaw control (s) [unused when YCMode=0]`,
    `${r(p.YawNeut)}   YawNeut      - Neutral yaw position (degrees)`,
    `${pad(p.YawSpr)} YawSpr       - Nacelle-yaw spring constant (N-m/rad)`,
    `${pad(p.YawDamp)} YawDamp      - Nacelle-yaw damping constant (N-m/(rad/s))`,
    `${r(p.TYawManS)}   TYawManS     - Time to start override yaw maneuver (s)`,
    `${r(p.YawManRat)}   YawManRat    - Yaw maneuver rate (deg/s)`,
    `${r(p.NacYawF)}   NacYawF      - Final yaw angle for override yaw maneuvers (degrees)`,
    `---------------------- AERODYNAMIC FLOW CONTROL --------------------------------`,
    `${r(p.AfCmode)}   AfCmode      - Airfoil control mode {0: none, 1: cosine wave, 4: Simulink, 5: Bladed DLL} (switch)`,
    `${r(p.AfC_Mean)}   AfC_Mean     - Mean level for cosine cycling or steady value (-) [AfCmode==1 only]`,
    `${r(p.AfC_Amp)}   AfC_Amp      - Amplitude for cosine cycling (-) [AfCmode==1 only]`,
    `${r(p.AfC_Phase)}   AfC_Phase    - Phase relative to blade azimuth (deg) [AfCmode==1 only]`,
    `---------------------- STRUCTURAL CONTROL --------------------------------------`,
    `${r(p.NumBStC)}   NumBStC      - Number of blade structural controllers (integer)`,
    `${pad(q(p.BStCfiles))} BStCfiles    - Name of blade structural controller files [unused when NumBStC==0]`,
    `${r(p.NumNStC)}   NumNStC      - Number of nacelle structural controllers (integer)`,
    `${pad(q(p.NStCfiles))} NStCfiles    - Name of nacelle structural controller files [unused when NumNStC==0]`,
    `${r(p.NumTStC)}   NumTStC      - Number of tower structural controllers (integer)`,
    `${pad(q(p.TStCfiles))} TStCfiles    - Name of tower structural controller files [unused when NumTStC==0]`,
    `${r(p.NumSStC)}   NumSStC      - Number of substructure structural controllers (integer)`,
    `${pad(q(p.SStCfiles))} SStCfiles    - Name of substructure structural controller files [unused when NumSStC==0]`,
    `---------------------- CABLE CONTROL -------------------------------------------`,
    `${r(p.CCmode)}   CCmode       - Cable control mode {0: none, 4: Simulink/Labview, 5: Bladed-style DLL} (switch)`,
    `---------------------- BLADED INTERFACE ----------------------------------------`,
    `${pad(q(p.DLL_FileName))} DLL_FileName - Name/location of the dynamic library (.dll/.so) [used only with Bladed Interface]`,
    `${pad(q(p.DLL_InFile))} DLL_InFile   - Name of input file sent to the DLL [used only with Bladed Interface]`,
    `${pad(q(p.DLL_ProcName))} DLL_ProcName - Name of procedure in DLL [case sensitive; used only with DLL Interface]`,
    `${pad(q(p.DLL_DT))} DLL_DT       - Communication interval for dynamic library (s) [used only with Bladed Interface]`,
    `${pad(b(p.DLL_Ramp))} DLL_Ramp     - Whether a linear ramp should be used between DLL_DT time steps (flag)`,
    `${r(p.BPCutoff)}   BPCutoff     - Cutoff frequency for low-pass filter on blade pitch from DLL (Hz)`,
    `${r(p.NacYaw_North)}   NacYaw_North - Reference yaw angle when upwind end points due North (deg)`,
    `${r(p.Ptch_Cntrl)}   Ptch_Cntrl   - Record 28: Individual pitch control {0: collective, 1: individual}`,
    `${r(p.Ptch_SetPnt)}   Ptch_SetPnt  - Record  5: Below-rated pitch angle set-point (deg)`,
    `${r(p.Ptch_Min)}   Ptch_Min     - Record  6: Minimum pitch angle (deg)`,
    `${r(p.Ptch_Max)}   Ptch_Max     - Record  7: Maximum pitch angle (deg)`,
    `${r(p.PtchRate_Min)}   PtchRate_Min - Record  8: Minimum pitch rate (deg/s)`,
    `${r(p.PtchRate_Max)}   PtchRate_Max - Record  9: Maximum pitch rate (deg/s)`,
    `${r(p.Gain_OM)}   Gain_OM      - Record 16: Optimal mode gain (Nm/(rad/s)^2)`,
    `${r(p.GenSpd_MinOM)}   GenSpd_MinOM - Record 17: Minimum generator speed (rpm)`,
    `${r(p.GenSpd_MaxOM)}   GenSpd_MaxOM - Record 18: Optimal mode maximum speed (rpm)`,
    `${r(p.GenSpd_Dem)}   GenSpd_Dem   - Record 19: Demanded generator speed above rated (rpm)`,
    `${r(p.GenTrq_Dem)}   GenTrq_Dem   - Record 22: Demanded generator torque above rated (Nm)`,
    `${r(p.GenPwr_Dem)}   GenPwr_Dem   - Record 13: Demanded power (W)`,
    `---------------------- BLADED INTERFACE TORQUE-SPEED LOOK-UP TABLE -------------`,
    `${r(p.DLL_NumTrq)}   DLL_NumTrq   - Record 26: No. of points in torque-speed look-up table {0 = none}`,
    ` GenSpd_TLU   GenTrq_TLU`,
    ` (rpm)          (Nm)`,
    `---------------------- OUTPUT --------------------------------------------------`,
    `${pad(b(p.SumPrint))} SumPrint     - Print summary data to <RootName>.sum (flag)`,
    `${r(p.OutFile)}   OutFile      - Switch to determine output placement: {1: module file only; 2: glue code file only; 3: both}`,
    `${pad(b(p.TabDelim))} TabDelim     - Use tab delimiters in text tabular output file? (flag)`,
    `${pad(q(p.OutFmt))} OutFmt       - Format used for text tabular output (quoted string)`,
    `${r(p.TStart)}   TStart       - Time to begin tabular output (s)`,
    `              OutList      - The next line(s) contains a list of output parameters.`,
    ...outLines,
    `END of input file (the word "END" must appear in the first 3 columns of this last OutList line)`,
    `---------------------------------------------------------------------------------------`,
  ];

  // ── Passthrough: write back any params from the original file not shown in the UI ──
  const WRITTEN_SD = new Set([
    "Echo","DT",
    "PCMode","TPCOn","TPitManS(1)","TPitManS(2)","TPitManS(3)",
    "PitManRat(1)","PitManRat(2)","PitManRat(3)",
    "BlPitchF(1)","BlPitchF(2)","BlPitchF(3)",
    "VSContrl","GenModel","GenEff","GenTiStr","GenTiStp","SpdGenOn","TimGenOn","TimGenOf",
    "VS_RtGnSp","VS_RtTq","VS_Rgn2K","VS_SlPc",
    "SIG_SlPc","SIG_SySp","SIG_RtTq","SIG_PORt",
    "TEC_Freq","TEC_NPol","TEC_SRes","TEC_RRes","TEC_VLL","TEC_SLR","TEC_RLR","TEC_MR",
    "HSSBrMode","THSSBrDp","HSSBrDT","HSSBrTqF",
    "YCMode","TYCOn","YawNeut","YawSpr","YawDamp","TYawManS","YawManRat","NacYawF",
    "AfCmode","AfC_Mean","AfC_Amp","AfC_Phase",
    "NumBStC","BStCfiles","NumNStC","NStCfiles","NumTStC","TStCfiles","NumSStC","SStCfiles",
    "CCmode",
    "DLL_FileName","DLL_InFile","DLL_ProcName","DLL_DT","DLL_Ramp",
    "BPCutoff","NacYaw_North","Ptch_Cntrl","Ptch_SetPnt","Ptch_Min","Ptch_Max",
    "PtchRate_Min","PtchRate_Max","Gain_OM","GenSpd_MinOM","GenSpd_MaxOM",
    "GenSpd_Dem","GenTrq_Dem","GenPwr_Dem","DLL_NumTrq",
    "SumPrint","OutFile","TabDelim","OutFmt","TStart","OutList",
    // non-paren variants
    "TPitManS1","TPitManS2","TPitManS3","PitManRat1","PitManRat2","PitManRat3",
    "BlPitchF1","BlPitchF2","BlPitchF3",
    // CANON aliases (normalised by parser)
    "afc_phase","afc_mean","afc_amp","AfC_phase",
  ]);
  const rawSD = p.__rawKV__ || {};
  const passSD = Object.entries(rawSD)
    .filter(([k]) => !WRITTEN_SD.has(k) && !k.startsWith("__"))
    .map(([k, v]) => `${String(v).padEnd(14)} ${k}`);
  if (passSD.length) {
    lines.push(
      "!--- Parameters not editable in this UI (preserved verbatim from original file) ---",
      ...passSD,
    );
  }
  return lines.join("\n");
}

// ── Sub-components ────────────────────────────────────────────────────────────
function SectionHead({ children }) {
  return <h3 className={s.sectionHead}>{children}</h3>;
}

function Field({ label, unit, children, hint, info }) {
  return (
    <div className={s.field}>
      <div className={s.fieldHeader}>
        <span className={s.fieldLabel}>{label}</span>
        {unit && <span className={s.unit}>{unit}</span>}
        {info && (
          <InfoPopover
            accentColor={ACCENT}
            content={typeof info === "string" ? { desc: info } : info}
          />
        )}
      </div>
      {children}
      {hint && <span className={s.hint}>{hint}</span>}
    </div>
  );
}

function Toggle({ label, value, onChange, note }) {
  return (
    <div className={s.toggleRow}>
      <button
        className={[s.toggle, value ? s.on : ""].join(" ")}
        onClick={() => onChange(!value)}
        type="button"
      >
        <span className={s.toggleThumb} />
      </button>
      <span className={s.toggleLabel}>{label}</span>
      {note && <span className={s.toggleNote}>{note}</span>}
    </div>
  );
}

function SelField({ label, value, onChange, options, hint }) {
  return (
    <Field label={label} hint={hint}>
      <select className={s.select} value={value} onChange={e => onChange(Number(e.target.value))}>
        {options.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
    </Field>
  );
}

function Collapsible({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={s.collapsible}>
      <button className={s.collapsibleHead} onClick={() => setOpen(v => !v)} type="button">
        {open ? <ChevronDown size={13} strokeWidth={2} /> : <ChevronRight size={13} strokeWidth={2} />}
        {title}
      </button>
      {open && <div className={s.collapsibleBody}>{children}</div>}
    </div>
  );
}

// Blade-triple helper (simplified — no sync lock for ServoDyn pitch override)
function BladeTriple3({ label, unit, keys, p, setP, hint }) {
  return (
    <Field label={label} unit={unit} hint={hint}>
      <div className={s.bladeRow}>
        {keys.map((k, i) => (
          <div key={k} className={s.bladeCell}>
            <span className={s.bladeIdx}>Blade {i + 1}</span>
            <input
              className={s.inp}
              value={p[k]}
              onChange={e => setP(prev => ({ ...prev, [k]: parseFloat(e.target.value) ?? p[k] }))}
            />
          </div>
        ))}
      </div>
    </Field>
  );
}

// ── Turbine schematic (drivetrain/control focus — Bladed DLL highlighted) ────
function TurbineSchematic() {
  const c = "#4F72C5";
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
      {/* Blades */}
      <line x1="50" y1="48" x2="50" y2="14" stroke={c} strokeWidth="3" strokeLinecap="round"/>
      <line x1="47" y1="55" x2="18" y2="73" stroke={c} strokeWidth="3" strokeLinecap="round"/>
      <line x1="53" y1="55" x2="82" y2="73" stroke={c} strokeWidth="3" strokeLinecap="round"/>
      {/* Drivetrain shaft line from hub to controller box */}
      <line x1="58" y1="52" x2="70" y2="52"
        stroke={c} strokeWidth="1.5" strokeLinecap="round" opacity="0.55"/>
      {/* Gearbox */}
      <rect x="70" y="47" width="9" height="10" rx="2"
        fill={c} fillOpacity="0.15" stroke={c} strokeWidth="0.8" strokeOpacity="0.55"/>
      {/* DLL controller box — x:79–91, y:45–57, center:(85,51) */}
      <rect x="79" y="45" width="12" height="13" rx="2"
        fill={c} fillOpacity="0.22" stroke={c} strokeWidth="0.8"/>
      {/* DLL label — perfectly centred inside box */}
      <text
        x="85" y="51.5"
        fontSize="3.8"
        textAnchor="middle"
        dominantBaseline="central"
        fill={c}
        fontFamily="-apple-system,sans-serif"
        fontWeight="700"
      >DLL</text>
      {/* Label */}
      <text x="4" y="100" fontSize="6"
        style={{ fill: c }} fontFamily="-apple-system,sans-serif" opacity="0.7">
        ServoDyn
      </text>
    </svg>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ServoDynPanel({ onLog, project, filePathFromProject, onDirtyChange, onRegisterSave, simRunning = false }) {
  const [tab,      setTab]      = useState("quick");
  const [p,        _setP]       = useState(DEFAULT);
  const [filePath, setFilePath] = useState("");
  const [isDirtyFlag, setIsDirtyFlag] = useState(false);
  const [rawOpen,     setRawOpen]     = useState(false);
  const [pickerOpen,  setPickerOpen]  = useState(false);
  const rawContent  = useRef("");
  const originalRef = useRef(null); // JSON snapshot of last loaded/saved state (ref = no race)

  // Dirty-marking wrapper: all user-driven changes go through here.
  // loadFileFromPath uses _setP directly so a fresh load never marks dirty.
  const setP = useCallback((updater) => {
    _setP(updater);
    setIsDirtyFlag(true);
  }, []);

  // True only when: file open  AND  user touched something  AND  state differs from snapshot.
  // isDirty: file open  AND  user touched something  AND  snapshot exists + state differs.
  const isDirty = !!filePath && isDirtyFlag &&
    originalRef.current !== null && JSON.stringify(p) !== originalRef.current;

  // Detect UI fields that have no counterpart in the loaded file (showing defaults)
  const missingFields = useMemo(() => {
    if (!filePath || !p.__rawKV__) return [];
    const rawKeys = new Set(Object.keys(p.__rawKV__));
    for (const k of [...rawKeys]) {
      const m = k.match(/^([A-Za-z_]+)\((\d+)\)$/);
      if (m) rawKeys.add(`${m[1]}${m[2]}`);
    }
    return Object.keys(DEFAULT).filter(k => {
      if (k.startsWith("__")) return false;
      if (typeof DEFAULT[k] === "string" && DEFAULT[k].includes("\n")) return false;
      return !rawKeys.has(k);
    });
  }, [filePath, p.__rawKV__]);

  // Revert detection: clear the dirty flag when state matches the saved snapshot exactly.
  useEffect(() => {
    if (!isDirtyFlag || originalRef.current === null) return;
    if (JSON.stringify(p) === originalRef.current) {
      setIsDirtyFlag(false);
    }
  }, [p, isDirtyFlag]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = useCallback((key, val) => {
    setP(prev => ({ ...prev, [key]: val }));
  }, []);

  const setMany = useCallback((obj) => {
    setP(prev => ({ ...prev, ...obj }));
  }, []);

  // ── Core file loader (used by handleOpen and auto-load effect) ───────────────
  // Snapshot written to ref first (synchronous) so there's never a batching race.
  const loadFileFromPath = useCallback(async (path) => {
    try {
      const content = await invoke("read_text_file", { path });
      rawContent.current = content;
      const kv = parseServoDynFile(content);
      const parsed = sdParsedToState(kv);
      originalRef.current = JSON.stringify(parsed); // synchronous snapshot
      _setP(parsed);
      setIsDirtyFlag(false);
      setFilePath(path);
      onLog?.("info", `Opened ${path.split("/").pop()}`);
    } catch (e) {
      onLog?.("error", String(e));
    }
  }, [onLog]);

  // ── Open .dat (user-initiated via Browse button) ───────────────────────────
  const handleOpen = async () => {
    try {
      const f = await openDialog({
        multiple: false,
        filters: [{ name: "ServoDyn", extensions: ["dat","inp","txt"] }],
      });
      if (!f) return;
      await loadFileFromPath(f);
    } catch (e) {
      onLog?.("error", String(e));
    }
  };

  const handleSave = useCallback(async () => {
    if (simRunning) { onLog?.("warn", "⚠ OpenFAST is running — save blocked to protect the active simulation."); return; }
    if (!filePath) return;
    try {
      const content = buildServoDynContent(p);
      await invoke("write_text_file", { path: filePath, content });
      originalRef.current = JSON.stringify(p); // advance snapshot to what was written
      setIsDirtyFlag(false);
      onLog?.("info", `Saved ${filePath.split("/").pop()}`);
    } catch (e) {
      onLog?.("error", String(e));
    }
  }, [filePath, p, onLog]);

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  // ── Project integration effects ────────────────────────────────────────────
  // Auto-load when App.jsx detects this panel's file from an imported .fst.
  // loadFileFromPath intentionally omitted from deps — only re-trigger on path change.
  useEffect(() => {
    if (!filePathFromProject) return;
    loadFileFromPath(filePathFromProject);
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

  const pcModeName  = ["None","–","–","User routine","Simulink","Bladed DLL"][p.PCMode] ?? "–";
  const vsCtrlName  = ["None","Simple VS","–","User routine","Simulink","Bladed DLL"][p.VSContrl] ?? "–";
  const genModelName = ["–","Simple","Thevenin","User-defined"][p.GenModel] ?? "–";

  // ── Tabs ────────────────────────────────────────────────────────────────────
  const renderQuick = () => (
    <div className={s.form}>
      <div className={s.callout}>
        Most-used control parameters — full settings on other tabs.
      </div>

      <SectionHead>Control Modes</SectionHead>
      <div className={s.grid2}>
        <Field label="Pitch control mode (PCMode)"
          info={{ param: "PCMode", desc: "Pitch control mode switch.", range: "0, 3, 4, 5", default: "0", note: "0=no active pitch control (use override maneuver settings) · 3=user Fortran routine · 4=Simulink/Labview · 5=Bladed-style DLL (ROSCO / DISCON)" }}>
          <select className={s.select} value={p.PCMode} onChange={e => set("PCMode", Number(e.target.value))}>
            {[{v:0,l:"0 – None"},{v:3,l:"3 – User routine"},{v:4,l:"4 – Simulink"},{v:5,l:"5 – Bladed DLL"}]
              .map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
        </Field>
        <Field label="Variable-speed control (VSContrl)"
          info={{ param: "VSContrl", desc: "Variable-speed torque control mode switch.", range: "0, 1, 3, 4, 5", default: "0", note: "0=no VS control (GenModel sets generator physics) · 1=simple Region-2/3 K·Ω² control · 3=user routine · 4=Simulink · 5=Bladed DLL (ROSCO)" }}>
          <select className={s.select} value={p.VSContrl} onChange={e => set("VSContrl", Number(e.target.value))}>
            {[{v:0,l:"0 – None"},{v:1,l:"1 – Simple VS"},{v:3,l:"3 – User routine"},{v:4,l:"4 – Simulink"},{v:5,l:"5 – Bladed DLL"}]
              .map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
        </Field>
      </div>

      <SectionHead>Generator</SectionHead>
      <div className={s.grid2}>
        <Field label="Generator efficiency (GenEff)" unit="%"
          info={{ param: "GenEff", desc: "Mechanical-to-electrical generator conversion efficiency.", range: "0–100 %", default: "94.4 (NREL 5 MW)", unit: "%", note: "Ignored when VSContrl = 3 or 5 (DLL/Simulink models compute their own efficiency internally)." }}>
          <input className={s.inp} value={p.GenEff}
            onChange={e => set("GenEff", parseFloat(e.target.value) || p.GenEff)} />
        </Field>
        <Field label="Time to start generator (TimGenOn)" unit="s"
          info={{ param: "TimGenOn", desc: "Time at which the generator is switched on. Used only when GenTiStr = True.", range: "≥ 0 s (9999.9 = disabled)", default: "9999.0", unit: "s", note: "For power-production DLCs, set to 0 so the generator is on from the start." }}>
          <input className={s.inp} value={p.TimGenOn}
            onChange={e => set("TimGenOn", parseFloat(e.target.value) || p.TimGenOn)} />
        </Field>
        <Field label="Time to stop generator (TimGenOf)" unit="s"
          info={{ param: "TimGenOf", desc: "Time at which the generator is switched off. Used only when GenTiStp = True.", range: "≥ 0 s (9999.9 = never)", default: "9999.9", unit: "s" }}>
          <input className={s.inp} value={p.TimGenOf}
            onChange={e => set("TimGenOf", parseFloat(e.target.value) || p.TimGenOf)} />
        </Field>
      </div>

      {(p.PCMode === 5 || p.VSContrl === 5) && (
        <>
          <SectionHead>Bladed DLL</SectionHead>
          <div className={s.grid1}>
            <Field label="DLL library path (DLL_FileName)"
              info="Path to the controller shared library — libdiscon.dylib (macOS), DISCON.dll (Windows), or libdiscon.so (Linux). Can be absolute or relative to the OpenFAST run directory. The bundled ROSCO libdiscon.dylib is pre-configured in the model folder; point here to use a custom build instead.">
              <div className={s.fileRow}>
                <input className={s.inp} value={p.DLL_FileName}
                  onChange={e => set("DLL_FileName", e.target.value)} />
                <button className={s.browseBtn} type="button"
                  onClick={async () => {
                    const f = await openDialog({ multiple: false,
                      filters: [{ name: "DLL/SO", extensions: ["dll","so","dylib","*"] }] });
                    if (f) set("DLL_FileName", f);
                  }}>
                  <FolderOpen size={12} strokeWidth={1.8} />
                </button>
              </div>
            </Field>
            <Field label="DLL input file (DLL_InFile)"
              hint="ROSCO controller configuration file (DISCON.IN or *.in)">
              <div className={s.fileRow}>
                <input className={s.inp} value={p.DLL_InFile}
                  onChange={e => set("DLL_InFile", e.target.value)} />
                <button className={s.browseBtn} type="button"
                  onClick={async () => {
                    const f = await openDialog({ multiple: false });
                    if (f) set("DLL_InFile", f);
                  }}>
                  <FolderOpen size={12} strokeWidth={1.8} />
                </button>
              </div>
            </Field>
          </div>
        </>
      )}

      <SectionHead>Output Timing</SectionHead>
      <div className={s.grid2}>
        <Field label="Output start time (TStart)" unit="s"
          info="Time to begin tabular output. Set large enough for transients to decay. Typically 30–200 s.">
          <input className={s.inp} value={p.TStart}
            onChange={e => set("TStart", parseFloat(e.target.value) || p.TStart)} />
        </Field>
      </div>
    </div>
  );

  const renderPitch = () => (
    <div className={s.form}>
      <SectionHead>Pitch Control</SectionHead>
      <div className={s.grid2}>
        <SelField label="Pitch control mode (PCMode)" value={p.PCMode} onChange={v => set("PCMode", v)}
          options={[
            {v:0,label:"0 – None"},
            {v:3,label:"3 – User routine"},
            {v:4,label:"4 – Simulink/Labview"},
            {v:5,label:"5 – Bladed-style DLL"},
          ]} />
        <Field label="Active pitch time (TPCOn)" unit="s" hint="Unused when PCMode=0">
          <input className={s.inp} value={p.TPCOn}
            onChange={e => set("TPCOn", parseFloat(e.target.value) || p.TPCOn)} />
        </Field>
      </div>

      <Collapsible title="Pitch override maneuver settings" defaultOpen={false}>
        <div className={s.grid1}>
          <BladeTriple3 label="Maneuver start time (TPitManS)" unit="s"
            keys={["TPitManS1","TPitManS2","TPitManS3"]} p={p} setP={setP}
            hint="Set to 9999.9 to disable" />
          <BladeTriple3 label="Maneuver rate (PitManRat)" unit="deg/s"
            keys={["PitManRat1","PitManRat2","PitManRat3"]} p={p} setP={setP} />
          <BladeTriple3 label="Final pitch angle (BlPitchF)" unit="deg"
            keys={["BlPitchF1","BlPitchF2","BlPitchF3"]} p={p} setP={setP} />
        </div>
      </Collapsible>

      <SectionHead>Generator & Torque Control</SectionHead>
      <div className={s.grid2}>
        <SelField label="Variable-speed control (VSContrl)" value={p.VSContrl} onChange={v => set("VSContrl", v)}
          options={[
            {v:0,label:"0 – None"},
            {v:1,label:"1 – Simple VS"},
            {v:3,label:"3 – User routine"},
            {v:4,label:"4 – Simulink/Labview"},
            {v:5,label:"5 – Bladed-style DLL"},
          ]} />
        <SelField label="Generator model (GenModel)" value={p.GenModel} onChange={v => set("GenModel", v)}
          options={[
            {v:1,label:"1 – Simple"},
            {v:2,label:"2 – Thevenin"},
            {v:3,label:"3 – User-defined"},
          ]}
          hint="Used only when VSContrl=0" />
        <Field label="Generator efficiency (GenEff)" unit="%"
          hint="Ignored by Thevenin and user-defined models">
          <input className={s.inp} value={p.GenEff}
            onChange={e => set("GenEff", parseFloat(e.target.value) || p.GenEff)} />
        </Field>
      </div>

      <div className={s.toggleGrid}>
        <Toggle label="Timed generator start (GenTiStr)" value={p.GenTiStr} onChange={v => set("GenTiStr", v)}
          note="False → speed-based using SpdGenOn" />
        <Toggle label="Timed generator stop (GenTiStp)"  value={p.GenTiStp} onChange={v => set("GenTiStp", v)}
          note="False → stops when power = 0" />
      </div>

      <div className={s.grid2}>
        <Field label="Speed to start gen. (SpdGenOn)" unit="rpm" hint="Used when GenTiStr=False">
          <input className={s.inp} value={p.SpdGenOn}
            onChange={e => set("SpdGenOn", parseFloat(e.target.value) || p.SpdGenOn)} />
        </Field>
        <Field label="Time to start gen. (TimGenOn)" unit="s" hint="Used when GenTiStr=True">
          <input className={s.inp} value={p.TimGenOn}
            onChange={e => set("TimGenOn", parseFloat(e.target.value) || p.TimGenOn)} />
        </Field>
        <Field label="Time to stop gen. (TimGenOf)" unit="s" hint="Used when GenTiStp=True">
          <input className={s.inp} value={p.TimGenOf}
            onChange={e => set("TimGenOf", parseFloat(e.target.value) || p.TimGenOf)} />
        </Field>
      </div>
    </div>
  );

  const renderModels = () => (
    <div className={s.form}>
      <div className={s.callout}>
        ⚡ Active: <strong style={{ marginLeft:4 }}>{vsCtrlName}</strong> torque control,&nbsp;
        <strong>{genModelName}</strong> generator model.
      </div>

      <Collapsible title="Simple Variable-Speed Torque Control (VSContrl=1)" defaultOpen={p.VSContrl === 1}>
        <div className={s.grid2}>
          {[
            ["VS_RtGnSp","Rated generator speed","rpm"],
            ["VS_RtTq","Rated generator torque","N·m"],
            ["VS_Rgn2K","Region 2 torque constant","N·m/rpm²"],
            ["VS_SlPc","Region 2.5 slip percentage","%"],
          ].map(([k, lbl, unit]) => (
            <Field key={k} label={lbl} unit={unit}>
              <input className={s.inp} value={p[k]}
                onChange={e => set(k, parseFloat(e.target.value) || p[k])} />
            </Field>
          ))}
        </div>
      </Collapsible>

      <Collapsible title="Simple Induction Generator (VSContrl=0, GenModel=1)"
        defaultOpen={p.VSContrl === 0 && p.GenModel === 1}>
        <div className={s.grid2}>
          {[
            ["SIG_SlPc","Rated slip percentage","%"],
            ["SIG_SySp","Synchronous speed","rpm"],
            ["SIG_RtTq","Rated torque","N·m"],
            ["SIG_PORt","Pull-out ratio (Tpullout/Trated)","–"],
          ].map(([k, lbl, unit]) => (
            <Field key={k} label={lbl} unit={unit}>
              <input className={s.inp} value={p[k]}
                onChange={e => set(k, parseFloat(e.target.value) || p[k])} />
            </Field>
          ))}
        </div>
      </Collapsible>

      <Collapsible title="Thevenin-Equivalent Induction Generator (VSContrl=0, GenModel=2)"
        defaultOpen={p.VSContrl === 0 && p.GenModel === 2}>
        <div className={s.grid2}>
          {[
            ["TEC_Freq","Line frequency","Hz"],
            ["TEC_NPol","Number of poles (even integer)","–"],
            ["TEC_SRes","Stator resistance","Ω"],
            ["TEC_RRes","Rotor resistance","Ω"],
            ["TEC_VLL","Line-to-line RMS voltage","V"],
            ["TEC_SLR","Stator leakage reactance","Ω"],
            ["TEC_RLR","Rotor leakage reactance","Ω"],
            ["TEC_MR","Magnetizing reactance","Ω"],
          ].map(([k, lbl, unit]) => (
            <Field key={k} label={lbl} unit={unit}>
              <input className={s.inp} value={p[k]}
                onChange={e => set(k, parseFloat(e.target.value) || p[k])} />
            </Field>
          ))}
        </div>
      </Collapsible>

      <SectionHead>HSS Brake</SectionHead>
      <div className={s.grid2}>
        <SelField label="Brake model (HSSBrMode)" value={p.HSSBrMode} onChange={v => set("HSSBrMode", v)}
          options={[
            {v:0,label:"0 – None"},
            {v:1,label:"1 – Simple"},
            {v:3,label:"3 – User routine"},
            {v:4,label:"4 – Simulink/Labview"},
            {v:5,label:"5 – Bladed-style DLL"},
          ]} />
        <Field label="Brake deployment time (THSSBrDp)" unit="s">
          <input className={s.inp} value={p.THSSBrDp}
            onChange={e => set("THSSBrDp", parseFloat(e.target.value) || p.THSSBrDp)} />
        </Field>
        <Field label="Deployment duration (HSSBrDT)" unit="s" hint="Used only when HSSBrMode=1">
          <input className={s.inp} value={p.HSSBrDT}
            onChange={e => set("HSSBrDT", parseFloat(e.target.value) || p.HSSBrDT)} />
        </Field>
        <Field label="Full brake torque (HSSBrTqF)" unit="N·m">
          <input className={s.inp} value={p.HSSBrTqF}
            onChange={e => set("HSSBrTqF", parseFloat(e.target.value) || p.HSSBrTqF)} />
        </Field>
      </div>
    </div>
  );

  const renderYaw = () => (
    <div className={s.form}>
      <SectionHead>Nacelle-Yaw Control</SectionHead>
      <div className={s.grid2}>
        <SelField label="Yaw control mode (YCMode)" value={p.YCMode} onChange={v => set("YCMode", v)}
          options={[
            {v:0,label:"0 – None"},
            {v:3,label:"3 – User routine"},
            {v:4,label:"4 – Simulink/Labview"},
            {v:5,label:"5 – Bladed-style DLL"},
          ]} />
        <Field label="Yaw enable time (TYCOn)" unit="s" hint="Unused when YCMode=0">
          <input className={s.inp} value={p.TYCOn}
            onChange={e => set("TYCOn", parseFloat(e.target.value) || p.TYCOn)} />
        </Field>
        <Field label="Neutral yaw (YawNeut)" unit="deg">
          <input className={s.inp} value={p.YawNeut}
            onChange={e => set("YawNeut", parseFloat(e.target.value) || 0)} />
        </Field>
        <Field label="Yaw spring (YawSpr)" unit="N·m/rad">
          <input className={s.inp} value={p.YawSpr}
            onChange={e => set("YawSpr", e.target.value)} />
        </Field>
        <Field label="Yaw damping (YawDamp)" unit="N·m/(rad/s)">
          <input className={s.inp} value={p.YawDamp}
            onChange={e => set("YawDamp", e.target.value)} />
        </Field>
      </div>

      <Collapsible title="Yaw override maneuver">
        <div className={s.grid2}>
          <Field label="Maneuver start time (TYawManS)" unit="s">
            <input className={s.inp} value={p.TYawManS}
              onChange={e => set("TYawManS", parseFloat(e.target.value) || p.TYawManS)} />
          </Field>
          <Field label="Yaw maneuver rate (YawManRat)" unit="deg/s">
            <input className={s.inp} value={p.YawManRat}
              onChange={e => set("YawManRat", parseFloat(e.target.value) || p.YawManRat)} />
          </Field>
          <Field label="Final yaw angle (NacYawF)" unit="deg">
            <input className={s.inp} value={p.NacYawF}
              onChange={e => set("NacYawF", parseFloat(e.target.value) || 0)} />
          </Field>
        </div>
      </Collapsible>

      <SectionHead>Aerodynamic Flow Control</SectionHead>
      <div className={s.grid2}>
        <SelField label="Airfoil control mode (AfCmode)" value={p.AfCmode} onChange={v => set("AfCmode", v)}
          options={[
            {v:0,label:"0 – None"},
            {v:1,label:"1 – Cosine wave"},
            {v:4,label:"4 – Simulink/Labview"},
            {v:5,label:"5 – Bladed-style DLL"},
          ]} />
        <Field label="Mean level (AfC_Mean)" hint="Used when AfCmode=1">
          <input className={s.inp} value={p.AfC_Mean}
            onChange={e => set("AfC_Mean", parseFloat(e.target.value) || 0)} />
        </Field>
        <Field label="Amplitude (AfC_Amp)" hint="Used when AfCmode=1">
          <input className={s.inp} value={p.AfC_Amp}
            onChange={e => set("AfC_Amp", parseFloat(e.target.value) || 0)} />
        </Field>
        <Field label="Phase (AfC_Phase)" unit="deg" hint="Relative to blade azimuth">
          <input className={s.inp} value={p.AfC_Phase}
            onChange={e => set("AfC_Phase", parseFloat(e.target.value) || 0)} />
        </Field>
      </div>

      <SectionHead>Structural Controllers</SectionHead>
      <div className={s.grid2}>
        {[
          ["NumBStC","BStCfiles","Blade","blade"],
          ["NumNStC","NStCfiles","Nacelle","nacelle"],
          ["NumTStC","TStCfiles","Tower","tower"],
          ["NumSStC","SStCfiles","Substructure","substructure"],
        ].map(([numK, fileK, label, desc]) => (
          <div key={numK} style={{ display:"flex", flexDirection:"column", gap:5 }}>
            <Field label={`${label} controllers (${numK})`}>
              <input className={s.inp} value={p[numK]}
                onChange={e => set(numK, parseInt(e.target.value) || 0)} />
            </Field>
            <Field label={`${label} controller file`} hint={`Unused when ${numK}=0`}>
              <div className={s.fileRow}>
                <input className={s.inp} value={p[fileK]}
                  onChange={e => set(fileK, e.target.value)} />
                <button className={s.browseBtn} type="button"
                  onClick={async () => {
                    const f = await openDialog({ multiple: false });
                    if (f) set(fileK, f);
                  }}>
                  <FolderOpen size={12} strokeWidth={1.8} />
                </button>
              </div>
            </Field>
          </div>
        ))}
      </div>

      <SectionHead>Cable Control</SectionHead>
      <div className={s.grid2}>
        <SelField label="Cable control mode (CCmode)" value={p.CCmode} onChange={v => set("CCmode", v)}
          options={[
            {v:0,label:"0 – None"},
            {v:4,label:"4 – Simulink/Labview"},
            {v:5,label:"5 – Bladed-style DLL"},
          ]} />
      </div>
    </div>
  );

  const renderInterface = () => (
    <div className={s.form}>
      <Collapsible title="Bladed-style DLL Interface" defaultOpen={p.PCMode === 5 || p.VSContrl === 5 || p.YCMode === 5}>
        <div className={s.grid1} style={{ marginBottom: 12 }}>
          {[
            ["DLL_FileName","DLL library path (.dll / .so)"],
            ["DLL_InFile","DLL input file"],
            ["DLL_ProcName","Procedure name (case sensitive)"],
          ].map(([k, lbl]) => (
            <Field key={k} label={lbl}>
              <div className={s.fileRow}>
                <input className={s.inp} value={p[k]} onChange={e => set(k, e.target.value)} />
                {k !== "DLL_ProcName" && (
                  <button className={s.browseBtn} type="button"
                    onClick={async () => {
                      const f = await openDialog({ multiple: false });
                      if (f) set(k, f);
                    }}>
                    <FolderOpen size={12} strokeWidth={1.8} />
                  </button>
                )}
              </div>
            </Field>
          ))}
        </div>
        <div className={s.grid2}>
          <Field label="DLL time step (DLL_DT)" unit="s">
            <input className={s.inp} value={p.DLL_DT} onChange={e => set("DLL_DT", e.target.value)} />
          </Field>
          <Field label="Blade pitch cut-off freq. (BPCutoff)" unit="Hz">
            <input className={s.inp} value={p.BPCutoff}
              onChange={e => set("BPCutoff", parseFloat(e.target.value) || p.BPCutoff)} />
          </Field>
          <Field label="North yaw reference (NacYaw_North)" unit="deg">
            <input className={s.inp} value={p.NacYaw_North}
              onChange={e => set("NacYaw_North", parseFloat(e.target.value) || 0)} />
          </Field>
        </div>
        <div className={s.toggleGrid}>
          <Toggle label="Linear ramp between DLL_DT steps (DLL_Ramp)" value={p.DLL_Ramp}
            onChange={v => set("DLL_Ramp", v)} note="Introduces time shift when true" />
        </div>
        <Collapsible title="Bladed DLL control records (Ptch_*, Gain_OM, GenSpd_*, etc.)">
          <div className={s.grid3}>
            {[
              ["Ptch_Cntrl","Pitch control mode (Rec.28)"],
              ["Ptch_SetPnt","Below-rated pitch setpoint (deg)"],
              ["Ptch_Min","Min pitch angle (deg)"],
              ["Ptch_Max","Max pitch angle (deg)"],
              ["PtchRate_Min","Min pitch rate (deg/s)"],
              ["PtchRate_Max","Max pitch rate (deg/s)"],
              ["Gain_OM","Optimal mode gain"],
              ["GenSpd_MinOM","Min gen. speed for opt. mode (rpm)"],
              ["GenSpd_MaxOM","Max gen. speed for opt. mode (rpm)"],
              ["GenSpd_Dem","Demanded gen. speed above rated (rpm)"],
              ["GenTrq_Dem","Demanded gen. torque above rated (Nm)"],
              ["GenPwr_Dem","Demanded power (W)"],
              ["DLL_NumTrq","T-S table size (0=use opt. mode)"],
            ].map(([k, lbl]) => (
              <Field key={k} label={lbl}>
                <input className={s.inp} value={p[k]}
                  onChange={e => set(k, parseFloat(e.target.value) ?? p[k])} />
              </Field>
            ))}
          </div>
        </Collapsible>
      </Collapsible>

      <SectionHead>Output Settings</SectionHead>
      <div className={s.grid2}>
        <Field label="Output file switch (OutFile)" hint="1=module, 2=glue, 3=both">
          <input className={s.inp} value={p.OutFile}
            onChange={e => set("OutFile", parseInt(e.target.value) || 1)} />
        </Field>
        <Field label="Output format (OutFmt)">
          <input className={s.inp} value={p.OutFmt} onChange={e => set("OutFmt", e.target.value)} />
        </Field>
        <Field label="Output start time (TStart)" unit="s">
          <input className={s.inp} value={p.TStart}
            onChange={e => set("TStart", parseFloat(e.target.value) || p.TStart)} />
        </Field>
      </div>
      <div className={s.toggleGrid}>
        <Toggle label="Summary file (SumPrint)"       value={p.SumPrint}  onChange={v => set("SumPrint", v)} />
        <Toggle label="Tab-delimited output (TabDelim)" value={p.TabDelim} onChange={v => set("TabDelim", v)} />
        <Toggle label="Echo input (Echo)"             value={p.Echo}      onChange={v => set("Echo", v)} />
      </div>

      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6, marginTop:12 }}>
        <span style={{ fontSize:12, fontWeight:600, color:"var(--tx-2)" }}>OutList — output channel names</span>
        <button
          type="button"
          style={{ flexShrink:0, padding:"4px 11px", borderRadius:7, border:"0.5px solid var(--bd-input)", background:"var(--bg-surface)", color:"var(--tx-2)", fontSize:11.5, fontFamily:"inherit", cursor:"pointer", whiteSpace:"nowrap" }}
          onClick={() => setPickerOpen(true)}
        >
          Variable picker…
        </button>
      </div>
      <p style={{ margin:"0 0 6px", fontSize:11.5, color:"var(--tx-4)" }}>One channel per line. Quotes are optional — added automatically on save.</p>
      <textarea className={s.outListArea}
        value={p.OutList}
        onChange={e => set("OutList", e.target.value)}
        spellCheck={false} />
      {pickerOpen && (
        <OutVarPicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          mode="add"
          currentVars={(p.OutList||"").split("\n").map(l=>l.trim().replace(/"/g,"")).filter(Boolean)}
          onApply={(names) => {
            const existing = new Set((p.OutList||"").split("\n").map(l=>l.trim().replace(/"/g,"")).filter(Boolean));
            const toAdd = names.filter(n => !existing.has(n));
            if (toAdd.length === 0) return;
            const newList = [...existing, ...toAdd].join("\n");
            set("OutList", newList);
          }}
        />
      )}
    </div>
  );

  return (
    <div className={s.panel}>
      {/* Header */}
      <div className={s.header}>
        <Cpu size={16} strokeWidth={1.8} style={{ color: ACCENT }} />
        <h1 className={s.title}>ServoDyn</h1>
        <span className={s.desc}>Controller &amp; drivetrain</span>
        <span className={s.badge}>sub-module</span>
        <div style={{ flex: 1 }} />
        <button className={`${s.headerBtn} ${s.headerBtnPrimary}`} onClick={handleOpen} type="button">
          <FolderOpen size={12} strokeWidth={2} /> Open .dat
        </button>
        <button className={`${s.headerBtn} ${s.headerBtnSecondary}`} type="button"
          onClick={async () => {
            if (!filePath) {
              onLog?.("warn", "Load or save the ServoDyn file first — then View will show the actual file on disk.");
              return;
            }
            try {
              rawContent.current = await invoke("read_text_file", { path: filePath });
              setRawOpen(true);
            } catch (err) { onLog?.("error", `Cannot read file: ${err}`); }
          }}>
          <Eye size={12} strokeWidth={2} /> View
        </button>
      </div>

      {/* File bar */}
      <div className={[s.fileBar, filePath ? s.fileBarLoaded : ""].join(" ")}>
        <span className={[s.filePath, filePath ? s.filePathSet : ""].join(" ")}>
          {filePath || "No file — editing defaults (NREL 5 MW)"}
        </span>
        <span className={s.dirtyDot} style={{ opacity: isDirty ? 1 : 0 }} />
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

      {/* Tab bar */}
      <div className={s.tabBar}>
        {TABS.map(t => (
          <button key={t.id}
            className={[s.tab, tab === t.id ? s.tabActive : ""].join(" ")}
            onClick={() => setTab(t.id)} type="button">
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
              {missingFields.slice(0, 10).join(" · ")}
              {missingFields.length > 10 ? ` · +${missingFields.length - 10} more` : ""}
            </span>
          </span>
        </div>
      )}

      {/* Content */}
      <div className={s.contentRow}>
        <div className={s.formArea}>
          {tab === "quick"     && renderQuick()}
          {tab === "pitch"     && renderPitch()}
          {tab === "models"    && renderModels()}
          {tab === "yaw"       && renderYaw()}
          {tab === "interface" && renderInterface()}
        </div>

        {/* Stats */}
        <div className={s.statsPanel}>
          <p className={s.statsLabel}>Quick stats</p>
          <div className={s.turbineWrap}>
            <TurbineSchematic />
          </div>
          <div className={s.statsGrid}>
            {[
              ["Pitch mode",  pcModeName],
              ["VS control",  vsCtrlName],
              ["Gen. model",  genModelName],
              ["Gen. eff.",   `${p.GenEff}%`],
              ["Brake mode",  ["None","Simple","–","User","Simulink","Bladed DLL"][p.HSSBrMode] ?? "–"],
              ["Brake Tq.",   `${(p.HSSBrTqF/1000).toFixed(0)} kN·m`],
              ["Yaw control", ["None","–","–","User","Simulink","Bladed DLL"][p.YCMode] ?? "–"],
              ["Yaw neutral", `${p.YawNeut}°`],
              ["PCMode",      p.PCMode],
              ["VSContrl",    p.VSContrl],
              ["GenModel",    p.GenModel],
            ].map(([k, v]) => (
              <div key={k} className={s.statCard}>
                <span className={s.statKey}>{k}</span>
                <span className={s.statVal}>{String(v)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {rawOpen && (
        <RawFileModal
          content={rawContent.current}
          filename={filePath ? filePath.split("/").pop() : "ServoDyn.dat"}
          fromDisk={!!filePath}
          hasDirtyWarning={isDirty}
          onClose={() => setRawOpen(false)}
        />
      )}
    </div>
  );
}
