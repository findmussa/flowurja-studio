#!/usr/bin/env python3
"""
FlowWake Studio I/O sidecar — stdin/stdout JSON protocol.
Generates TurbSim .inp and user profile files in the exact OpenFAST v4.2.0 format.
"""
import sys
import json
import os
import math
import signal

# Ignore SIGPIPE so that a closed stdout/stdin pipe does not kill the process;
# instead it raises BrokenPipeError which the main loop catches and handles.
if hasattr(signal, "SIGPIPE"):
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)


def compute_ti_profile(z_grid, hub_ht, ti_hub, gti):
    """
    Compute TI(z) profile for rotor turbulence intensity asymmetry.
    gTI = TI(z_bottom) / TI(z_top)
    Linear gradient from top to bottom of rotor disk.
    """
    grid_half = (max(z_grid) - min(z_grid)) / 2.0
    z_top = hub_ht + grid_half
    z_bot = hub_ht - grid_half
    profile = []
    for z in z_grid:
        if z_top != z_bot:
            alpha = (z_top - z) / (z_top - z_bot)  # 0 at top, 1 at bottom
        else:
            alpha = 0.0
        ti_z = ti_hub * (1.0 + (gti - 1.0) * alpha)
        profile.append((z, ti_z))
    return profile


def compute_u_profile(z_grid, u_ref, ref_ht, pl_exp):
    """Power law wind speed profile U(z) = URef * (z/RefHt)^PLExp"""
    try:
        exp = float(pl_exp)
    except (ValueError, TypeError):
        exp = 0.2  # IEC default
    profile = []
    for z in z_grid:
        u_z = u_ref * ((z / ref_ht) ** exp) if ref_ht > 0 else u_ref
        profile.append((z, u_z))
    return profile


def write_user_profiles(path: str, p: dict) -> None:
    """
    Write TurbSim profile file for TurbModel=USRVKM and/or WindProfileType=USR.

    Exact format required by GetUSRProfiles (TS_FileIO.f90):
      Lines 1-3:  ReadCom — 3 header lines (any text, unconditionally discarded)
      Line  4:    NumUSRz — integer, number of height points
      Lines 5-7:  StdScale1, StdScale2, StdScale3 — floats > 0 (u, v, w scaling)
      Lines 8-11: ReadCom — 4 column-header lines (unconditionally discarded)
      Lines 12+:  z(m)  U(m/s)  WindDir(deg)  Sigma_u(m/s)  L_u(m)

    Sigma_u(z) encodes the gTI gradient:
      - gTI = sigma_u(bottom) / sigma_u(top)  — applied directly to sigma_u, NOT to TI
      - Linear gradient: sigma_u(z) = sigma_top × (1 + (gTI-1) × alpha)
        where alpha = 1.0 at rotor bottom, 0.0 at rotor top
      - sigma_top back-computed so hub-midpoint sigma matches IEC 61400-1 NTM target
      - gTI=1.0 gives a uniform-sigma profile (safe for non-USRVKM runs too)

    Always written regardless of gTI so stale-file issues cannot occur when
    TurbSim v4.2.0 resolves ProfileFile unconditionally during input parsing.
    """
    num_z  = int(p.get("NumGrid_Z",   31))
    hub_ht = float(p.get("HubHt",      90.0))
    grid_h = float(p.get("GridHeight", 150.0))
    u_ref  = float(p.get("URef",       12.0))
    ref_ht = float(p.get("RefHt",      hub_ht))
    gti    = float(p.get("gTI",        1.0))

    pl_exp = p.get("PLExp", 0.2)
    try:
        alpha_pl = float(pl_exp)
    except (ValueError, TypeError):
        alpha_pl = 0.2

    # IEC turbulence class → Iref
    IEC_IREF = {0: 0.16, 1: 0.14, 2: 0.12}
    _turbc_idx    = int(p.get("IECturbc", 0))
    _turbc_custom = str(p.get("IECturbc_custom", "")).strip()
    if _turbc_custom:
        try:
            raw = float(_turbc_custom)
            iref = raw / 100.0 if raw > 1.0 else raw
        except ValueError:
            iref = 0.16
    else:
        iref = IEC_IREF.get(_turbc_idx, 0.16)

    # IEC 61400-1 NTM: sigma_1 at hub height
    sigma_hub = iref * (0.75 * u_ref + 5.6)

    # Height grid
    z_bot  = hub_ht - grid_h / 2.0
    z_top  = hub_ht + grid_h / 2.0
    z_grid = [z_bot + i * (grid_h / max(num_z - 1, 1)) for i in range(num_z)]

    # gTI = sigma_u(bottom) / sigma_u(top).  Apply the gradient to sigma_u directly
    # (NOT to TI) so the ratio holds regardless of wind-speed shear.
    # Back-compute sigma_top so hub-midpoint sigma matches the IEC NTM target:
    #   sigma(hub) = sigma_top × (1 + (gTI-1) × 0.5)
    if gti != 1.0:
        sigma_top = sigma_hub / (1.0 + (gti - 1.0) * 0.5)
    else:
        sigma_top = sigma_hub

    out_dir = os.path.dirname(path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    lines = []

    # 3 ReadCom header lines (GetUSRProfiles loops ReadCom 3 times before NumUSRz)
    lines.append("---------TurbSim Profile File (FlowWake Studio)-----------")
    lines.append(f"gTI={gti:.3f}  Iref={iref:.3f}  URef={u_ref} m/s  HubHt={hub_ht} m")
    lines.append("---- User-Defined Profiles (USR wind profile / USRVKM spectral model) ----")

    # NumUSRz
    lines.append(f"{num_z}")

    # StdScale1, StdScale2, StdScale3 (u, v, w — must all be > 0; 1.0 = no extra scaling)
    lines.append("1.0")
    lines.append("1.0")
    lines.append("1.0")

    # 4 ReadCom column-header lines (GetUSRProfiles loops ReadCom 4 times before data)
    lines.append("------------------------------------------------------------------------------------")
    lines.append("Height    Wind Speed    Wind Angle    Std Dev (sigma_u)    Length Scale (L_u)")
    lines.append("  (m)        (m/s)         (deg)            (m/s)                 (m)")
    lines.append("------------------------------------------------------------------------------------")

    # Data rows: z  U(z)  WindDir=0  sigma_u(z)  L_u(z)
    for z in z_grid:
        z_safe = max(z, 0.001)

        # Power-law mean wind speed
        u_z = u_ref * ((z_safe / ref_ht) ** alpha_pl) if ref_ht > 0 else u_ref

        # Linear sigma_u gradient: alpha_ti=0 at rotor top, 1 at rotor bottom
        # sigma_u(z) = sigma_top × (1 + (gTI-1) × alpha_ti)
        # → sigma_u(bottom) / sigma_u(top) = gTI  ✓
        if z_top != z_bot:
            alpha_ti = (z_top - z) / (z_top - z_bot)
        else:
            alpha_ti = 0.0
        alpha_ti  = max(0.0, min(1.0, alpha_ti))
        sigma_u_z = sigma_top * (1.0 + (gti - 1.0) * alpha_ti)

        # IEC 61400-1 Ed.3 longitudinal length scale
        lambda1 = 0.7 * z_safe if z_safe < 60.0 else 42.0
        l_u_z   = 8.1 * lambda1

        lines.append(f"  {z:12.4f}  {u_z:10.5f}  {0.0:10.4f}  {sigma_u_z:12.5f}  {l_u_z:12.4f}")

    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")

def build_turbsim_inp_lines(p: dict) -> list:
    """
    Build TurbSim .inp lines as a list of strings.
    All parameters are driven by the GUI; nothing is hardcoded.
    """
    # ── Helpers ──────────────────────────────────────────────────────────────
    def fmt_bool(v): return "True" if v else "False"
    def fmt_val(v):
        if isinstance(v, bool): return fmt_bool(v)
        if isinstance(v, str):  return f'"{v}"' if v.lower() not in ("true","false") else v
        return str(v)

    # ── Pull all parameters ───────────────────────────────────────────────────
    # Runtime options
    echo        = fmt_bool(p.get("Echo",    False))
    rand_seed1  = int(p.get("RandSeed1",   123456))
    rand_seed2  = p.get("RandSeed2",       "RanLux")
    wr_bhhtp    = fmt_bool(p.get("WrBHHTP", False))
    wr_fhhtp    = fmt_bool(p.get("WrFHHTP", False))
    wr_adhh     = fmt_bool(p.get("WrADHH",  False))
    wr_adff     = fmt_bool(p.get("WrADFF",  True))
    wr_blff     = fmt_bool(p.get("WrBLFF",  False))
    wr_adtwr    = fmt_bool(p.get("WrADTWR", False))
    wr_hawcff   = fmt_bool(p.get("WrHAWCFF",False))
    wr_fmtff    = fmt_bool(p.get("WrFMTFF", False))
    wr_act      = fmt_bool(p.get("WrACT",   False))
    scale_iec   = int(p.get("ScaleIEC",    0))

    # Grid / model specs
    num_z       = int(p.get("NumGrid_Z",   31))
    num_y       = int(p.get("NumGrid_Y",   31))
    time_step   = float(p.get("TimeStep",  0.05))
    anal_time   = float(p.get("AnalysisTime", 630.0))
    use_time    = float(p.get("UsableTime",   600.0))
    hub_ht      = float(p.get("HubHt",     90.0))
    grid_h      = float(p.get("GridHeight",150.0))
    grid_w      = float(p.get("GridWidth", 150.0))
    v_flow      = float(p.get("VFlowAng",  0.0))
    h_flow      = float(p.get("HFlowAng",  0.0))

    # Met boundary
    TURB_MODELS  = ["IECKAI","IECVKM","GP_LLJ","NWTCUP","SMOOTH",
                    "WF_UPW","WF_07D","WF_14D","TIDAL","API","NONE"]
    IEC_STDS     = ["1","2","3","1-Ed2","1-Ed3"]
    TURB_CLASSES = ["A","B","C"]
    IEC_WIND_TYPES = ["NTM","1ETM","2ETM","3ETM","1EWM1","1EWM50"]
    WIND_PROFILES  = ["PL","LOG","JET","H2L","API","IEC","USR"]

    gti         = float(p.get("gTI", 1.0))
    use_gti     = gti != 1.0  # Auto-switch to IECVKM + USR profile when gTI != 1.0

    # When gTI is active, force USRVKM spectral model (reads U(z) + sigma_u(z) from profile)
    turb_model  = "USRVKM" if use_gti else TURB_MODELS[int(p.get("TurbModel", 0))]

    iec_std     = IEC_STDS[int(p.get("IECstandard", 0))]
    _turbc_idx  = int(p.get("IECturbc", 0))
    iec_turbc   = p.get("IECturbc_custom", "") or (TURB_CLASSES[_turbc_idx] if _turbc_idx < len(TURB_CLASSES) else "A")
    iec_wt      = IEC_WIND_TYPES[int(p.get("IEC_WindType", 0))]
    etmc        = p.get("ETMc", "default")
    # When USRVKM is active, also set WindProfileType=USR so TurbSim reads U(z) from ProfileFile
    wind_prof   = "USR" if use_gti else WIND_PROFILES[int(p.get("WindProfileType", 0))]
    ref_ht      = float(p.get("RefHt",  hub_ht))
    u_ref       = float(p.get("URef",   12.0))
    z_jet_max   = p.get("ZJetMax", "default")
    pl_exp      = p.get("PLExp",   "default")
    z0          = p.get("Z0",      "default")

    # Non-IEC met
    latitude    = p.get("Latitude", "default")
    rich_no     = p.get("RICH_NO",  0.05)
    ustar       = p.get("UStar",    "default")
    zi          = p.get("ZI",       "default")
    pc_uw       = p.get("PC_UW",    "default")
    pc_uv       = p.get("PC_UV",    "default")
    pc_vw       = p.get("PC_VW",    "default")

    # Coherent turbulence
    ct_path     = p.get("CTEventPath",  ".\\EventData")
    ct_file     = p.get("CTEventFile",  "les")
    randomize   = fmt_bool(p.get("Randomize",  True))
    dist_scl    = float(p.get("DistScl",  1.0))
    ct_ly       = float(p.get("CTLy",     0.5))
    ct_lz       = float(p.get("CTLz",     0.5))
    ct_start    = float(p.get("CTStartTime", 10.0))

    # ── Format seed 2 ─────────────────────────────────────────────────────────
    try:    rs2 = str(int(rand_seed2))
    except: rs2 = f'"{rand_seed2}"'

    # ── Format optional numeric/default values ────────────────────────────────
    def fmtd(v, is_str=True):
        if isinstance(v, str) and v.lower() == "default": return '"default"'
        if isinstance(v, str): return f'"{v}"' if is_str else v
        return str(v)

    pl_exp_str  = fmtd(pl_exp, False) if pl_exp != "default" else '"default"'
    z0_str      = fmtd(z0,     False) if z0     != "default" else '"default"'
    zjet_str    = fmtd(z_jet_max, False) if z_jet_max != "default" else '"default"'
    etmc_str    = fmtd(etmc,   False) if etmc   != "default" else '"default"'
    lat_str     = fmtd(latitude, False) if latitude != "default" else '"default"'
    ustar_str   = fmtd(ustar,  False) if ustar  != "default" else '"default"'
    zi_str      = fmtd(zi,     False) if zi      != "default" else '"default"'
    pc_uw_str   = fmtd(pc_uw,  False) if pc_uw  != "default" else '"default"'
    pc_uv_str   = fmtd(pc_uv,  False) if pc_uv  != "default" else '"default"'
    pc_vw_str   = fmtd(pc_vw,  False) if pc_vw  != "default" else '"default"'

    # ── Build .inp lines ──────────────────────────────────────────────────────
    lines = []
    def ln(s=""): lines.append(s)

    ln("---------TurbSim v2 (OpenFAST) Input File------------------")
    ln(f"FlowWake Studio — {turb_model} | {iec_turbc} | {u_ref} m/s | {hub_ht} m hub | gTI={gti}")
    ln("---------Runtime Options-----------------------------------")
    ln(f'{echo:<13} Echo            - Echo input data to <RootName>.ech (flag)')
    ln(f'{rand_seed1:<13} RandSeed1       - First random seed  (-2147483648 to 2147483647)')
    ln(f'{rs2:<13} RandSeed2       - Second random seed (-2147483648 to 2147483647) for intrinsic pRNG, or an alternative pRNG: "RanLux" or "RNSNLW"')
    ln(f'{wr_bhhtp:<13} WrBHHTP         - Output hub-height turbulence parameters in binary form?  (Generates RootName.bin)')
    ln(f'{wr_fhhtp:<13} WrFHHTP         - Output hub-height turbulence parameters in formatted form?  (Generates RootName.dat)')
    ln(f'{wr_adhh:<13} WrADHH          - Output hub-height time-series data in AeroDyn form?  (Generates RootName.hh)')
    ln(f'{wr_adff:<13} WrADFF          - Output full-field time-series data in TurbSim/AeroDyn form? (Generates RootName.bts)')
    ln(f'{wr_blff:<13} WrBLFF          - Output full-field time-series data in BLADED/AeroDyn form?  (Generates RootName.wnd)')
    ln(f'{wr_adtwr:<13} WrADTWR         - Output tower time-series data? (Generates RootName.twr)')
    ln(f'{wr_hawcff:<13} WrHAWCFF        - Output full-field time-series data in HAWC form?  (Generates RootName-u.bin, RootName-v.bin, RootName-w.bin, RootName.hawc)')
    ln(f'{wr_fmtff:<13} WrFMTFF         - Output full-field time-series data in formatted (readable) form?  (Generates RootName.u, RootName.v, RootName.w)')
    ln(f'{wr_act:<13} WrACT           - Output coherent turbulence time steps in AeroDyn form? (Generates RootName.cts)')
    ln(f'         {scale_iec:>2}   ScaleIEC        - Scale IEC turbulence models to exact target standard deviation? [0=no additional scaling; 1=use hub scale uniformly; 2=use individual scales]')
    ln()
    ln("--------Turbine/Model Specifications-----------------------")
    ln(f'         {num_z:>2}   NumGrid_Z       - Vertical grid-point matrix dimension')
    ln(f'         {num_y:>2}   NumGrid_Y       - Horizontal grid-point matrix dimension')
    ln(f'       {time_step}   TimeStep        - Time step [seconds]')
    ln(f'        {int(anal_time)}   AnalysisTime    - Length of analysis time series [seconds] (program will add time if necessary: AnalysisTime = MAX(AnalysisTime, UsableTime+GridWidth/MeanHHWS) )')
    ln(f'        {int(use_time)}   UsableTime      - Usable length of output time series [seconds] (program will add GridWidth/MeanHHWS seconds unless UsableTime is "ALL")')
    ln(f'        {int(hub_ht)}   HubHt           - Hub height [m] (should be > 0.5*GridHeight)')
    ln(f'        {int(grid_h)}   GridHeight      - Grid height [m]')
    ln(f'        {int(grid_w)}   GridWidth       - Grid width [m] (should be >= 2*(RotorRadius+ShaftLength))')
    ln(f'          {int(v_flow)}   VFlowAng        - Vertical mean flow (uptilt) angle [degrees]')
    ln(f'          {int(h_flow)}   HFlowAng        - Horizontal mean flow (skew) angle [degrees]')
    ln()
    ln("--------Meteorological Boundary Conditions-------------------")
    ln(f'"{turb_model}"      TurbModel       - Turbulence model ("IECKAI","IECVKM","GP_LLJ","NWTCUP","SMOOTH","WF_UPW","WF_07D","WF_14D","TIDAL","API","USRINP","USRVKM","TIMESR", or "NONE")')
    ln(f'"TurbSim_User.spectra", "TurbSim_User.timeSeriesInput"    UserFile  - Name of the file that contains inputs for user-defined spectra or time series inputs (used only for "USRINP" and "TIMESR" models)')
    ln(f'          {iec_std}   IECstandard     - Number of IEC 61400-x standard (x=1,2, or 3 with optional 61400-1 edition number (i.e. "1-Ed2") )')
    ln(f'"{iec_turbc}"           IECturbc        - IEC turbulence characteristic ("A", "B", "C" or the turbulence intensity in percent) ("KHTEST" option with NWTCUP model, not used for other models)')
    ln(f'"{iec_wt}"         IEC_WindType    - IEC turbulence type ("NTM"=normal, "xETM"=extreme turbulence, "xEWM1"=extreme 1-year wind, "xEWM50"=extreme 50-year wind, where x=wind turbine class 1, 2, or 3)')
    ln(f'{etmc_str}     ETMc            - IEC Extreme Turbulence Model "c" parameter [m/s]')
    ln(f'"{wind_prof}"          WindProfileType - Velocity profile type ("LOG";"PL"=power law;"JET";"H2L"=Log law for TIDAL model;"API";"USR";"TS";"IEC"=PL on rotor disk, LOG elsewhere; or "default")')
    # ProfileFile: use per-case filename when gTI is active (each case has unique U(z) profile)
    profile_file = p.get("_profile_file", "TurbSim_User.profiles")
    ln(f'"{profile_file}"      ProfileFile     - Name of the file that contains input profiles for WindProfileType="USR" and/or TurbModel="USRVKM" [-]')
    ln(f'        {int(ref_ht)}   RefHt           - Height of the reference velocity (URef) [m]')
    ln(f'         {u_ref}   URef            - Mean (total) velocity at the reference height [m/s] (or "default" for JET velocity profile) [must be 1-hr mean for API model; otherwise is the mean over AnalysisTime seconds]')
    ln(f'{zjet_str}     ZJetMax         - Jet height [m] (used only for JET velocity profile, valid 70-490 m)')
    ln(f'{pl_exp_str}     PLExp           - Power law exponent [-] (or "default")')
    ln(f'{z0_str}              Z0              - Surface roughness length [m] (or "default")')
    ln()
    ln("--------Non-IEC Meteorological Boundary Conditions------------")
    ln(f'{lat_str}     Latitude        - Site latitude [degrees] (or "default")')
    ln(f'       {rich_no}   RICH_NO         - Gradient Richardson number [-]')
    ln(f'{ustar_str}     UStar           - Friction or shear velocity [m/s] (or "default")')
    ln(f'{zi_str}     ZI              - Mixing layer depth [m] (or "default")')
    ln(f'{pc_uw_str}     PC_UW           - Hub mean u\'w\' Reynolds stress [m^2/s^2] (or "default" or "none")')
    ln(f'{pc_uv_str}     PC_UV           - Hub mean u\'v\' Reynolds stress [m^2/s^2] (or "default" or "none")')
    ln(f'{pc_vw_str}     PC_VW           - Hub mean v\'w\' Reynolds stress [m^2/s^2] (or "default" or "none")')
    ln()
    ln("--------Spatial Coherence Parameters----------------------------")
    ln('"default"     SCMod1           - u-component coherence model ("GENERAL","IEC","API","NONE", or "default")')
    ln('"default"     SCMod2           - v-component coherence model ("GENERAL","IEC","NONE", or "default")')
    ln('"default"     SCMod3           - w-component coherence model ("GENERAL","IEC","NONE", or "default")')
    ln('"default"     InCDec1          - u-component coherence parameters for general or IEC models [-, m^-1] (e.g. "10.0  0.3e-3" in quotes) (or "default")')
    ln('"default"     InCDec2          - v-component coherence parameters for general or IEC models [-, m^-1] (e.g. "10.0  0.3e-3" in quotes) (or "default")')
    ln('"default"     InCDec3          - w-component coherence parameters for general or IEC models [-, m^-1] (e.g. "10.0  0.3e-3" in quotes) (or "default")')
    ln('"default"     CohExp           - Coherence exponent for general model [-] (or "default")')
    ln()
    ln("--------Coherent Turbulence Scaling Parameters------------------- [used only when WrACT=TRUE]")
    ln(f'"{ct_path}"    CTEventPath     - Name of the path where event data files are located')
    ln(f'"{ct_file}"         CTEventFile     - Type of event files ("LES", "DNS", or "RANDOM")')
    ln(f'{randomize}          Randomize       - Randomize the disturbance scale and locations? (true/false)')
    ln(f'          {dist_scl}   DistScl         - Disturbance scale [-] (ratio of event dataset height to rotor disk). (Ignored when Randomize = true.)')
    ln(f'        {ct_ly}   CTLy            - Fractional location of tower centerline from right [-] (looking downwind) to left side of the dataset. (Ignored when Randomize = true.)')
    ln(f'        {ct_lz}   CTLz            - Fractional location of hub height from the bottom of the dataset. [-] (Ignored when Randomize = true.)')
    ln(f'         {int(ct_start)}   CTStartTime     - Minimum start time for coherent structures in RootName.cts [seconds]')
    ln()
    ln("====================================================")
    ln("! NOTE: Do not add or remove any lines in this file!")
    ln("====================================================")

    return lines





def write_turbsim_inp(p: dict, path: str) -> None:
    """Write TurbSim .inp file and always write the companion profile file.

    The profile file is written unconditionally (even for gTI=1.0) because
    TurbSim v4.2.0 resolves ProfileFile during input parsing regardless of
    TurbModel/WindProfileType, so a stale or missing file causes ABORT.
    """
    out_dir = os.path.dirname(path) or "."
    p_with_dir = {**p, "_out_dir": out_dir}

    # Always write the profile file so no stale-file errors can occur.
    profile_fname = p.get("_profile_file", "TurbSim_User.profiles")
    profile_path  = os.path.join(out_dir, profile_fname)
    write_user_profiles(profile_path, p)

    lines = build_turbsim_inp_lines(p_with_dir)
    os.makedirs(os.path.dirname(path) if os.path.dirname(path) else ".", exist_ok=True)
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def preview_turbsim_inp(p: dict) -> str:
    """
    Generate TurbSim .inp content as a string without writing to disk.
    Used by the GUI 'View .inp' feature.
    """
    import io, os, tempfile
    # Write to a temp file and read back
    with tempfile.NamedTemporaryFile(mode="w", suffix=".inp", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        write_turbsim_inp(p, tmp_path)
        with open(tmp_path, "r") as f:
            content = f.read()
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
    return content

# ── Sweep naming constants ────────────────────────────────────────────────────

TURB_MODELS_STR  = ["IECKAI", "IECVKM"]
WIND_CLASSES_STR = ["A", "B", "C"]
WIND_TYPES_STR   = ["NTM", "1ETM", "EWM1", "EWM50"]

# DLC id → (IEC_WindType index, wind type string)
DLC_WIND_TYPE_MAP = {
    "DLC1.1": (0, "NTM"),
    "DLC1.3": (1, "1ETM"),
    "DLC1.4": (2, "EWM1"),
    "DLC1.5": (3, "EWM50"),
}


def _case_name(mode, turb_model_idx, wind_class_idx, wind_type_str,
               v_hub, hub_ht, num_z, num_y, seed,
               shear_exp=None, ti_val=None, gti=1.0):
    """
    Build a comprehensive, self-describing TurbSim case name.

    Examples:
      DLC1.1_IECKAI_A_NTM_V04ms_90m_15x15_s01
      Custom_IECVKM_B_1ETM_V12ms_90m_15x15_PLX020_s03
      Custom_IECKAI_TI018_NTM_V12ms_90m_15x15_s01        (custom Iref)
      Custom_IECKAI_A_NTM_V12ms_90m_15x15_gTI115_s01     (gTI sweep)
      Custom_IECKAI_A_NTM_V12ms_90m_15x15_PLX020_gTI130_s02
    """
    tm  = TURB_MODELS_STR[turb_model_idx]  if 0 <= turb_model_idx < len(TURB_MODELS_STR)  else "IECKAI"
    if ti_val is not None:
        wc_tag = f"TI{int(round(ti_val * 100)):03d}"
    else:
        wc_tag = WIND_CLASSES_STR[wind_class_idx] if 0 <= wind_class_idx < len(WIND_CLASSES_STR) else "A"
    v_str  = f"V{int(round(v_hub)):02d}ms"
    ht_str = f"{int(round(hub_ht))}m"
    gr_str = f"{num_z}x{num_y}"
    s_str  = f"s{seed:02d}"
    parts  = [mode, tm, wc_tag, wind_type_str, v_str, ht_str, gr_str]
    if shear_exp is not None:
        parts.append(f"PLX{int(round(shear_exp * 100)):03d}")
    if gti is not None and abs(gti - 1.0) > 1e-6:
        parts.append(f"gTI{int(round(gti * 100)):03d}")
    parts.append(s_str)
    return "_".join(parts)


def generate_dlc_batch(cmd: dict) -> dict:
    """
    Generate TurbSim .inp files for IEC 61400-1 DLC batch runs.

    Folder layout (new):
      wind/sweeps/{batch_id}/inp/{casename}.inp   ← TurbSim input files
      wind/sweeps/{batch_id}/{casename}.bts        ← TurbSim output (written by TurbSim)
      wind/sweeps/{batch_id}/sweep.json            ← manifest read by Simulation Batch

    Expected cmd keys:
      working_dir, wind_dir, batch_id, batch_label
      turbine  – {vin, vout, hubHeight, rotorDiam, windClass, turbModel, iecStandard}
      grid     – {numY, numZ, gridWidth, gridHeight, duration, useTime, timeStep}
      dlcs     – [{id: "DLC1.1"}, ...]
      seeds_per_speed, wind_speed_step
    """
    import datetime, json as _json

    working_dir     = cmd.get("working_dir", ".")
    wind_dir        = cmd.get("wind_dir") or os.path.join(working_dir, "wind")
    batch_id        = cmd.get("batch_id") or datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    batch_label     = cmd.get("batch_label", "")
    turbine         = cmd.get("turbine", {})
    grid            = cmd.get("grid", {})
    dlcs            = cmd.get("dlcs", [])
    seeds_per_speed = int(cmd.get("seeds_per_speed", 6))
    wind_step       = float(cmd.get("wind_speed_step", 2.0))

    vin        = float(turbine.get("vin",        4.0))
    vout       = float(turbine.get("vout",       25.0))
    hub_ht     = float(turbine.get("hubHeight",  90.0))
    wind_class = int(turbine.get("windClass",    0))
    turb_model = int(turbine.get("turbModel",    0))
    iec_std    = int(turbine.get("iecStandard",  0))

    num_y     = int(grid.get("numY",       15))
    num_z     = int(grid.get("numZ",       15))
    g_width   = float(grid.get("gridWidth",  200.0))
    g_height  = float(grid.get("gridHeight", 200.0))
    duration  = float(grid.get("duration",   630.0))
    use_time  = float(grid.get("useTime",    600.0))
    time_step = float(grid.get("timeStep",   0.05))

    speeds = []
    v = vin
    while v <= vout + 1e-6:
        speeds.append(round(v, 4))
        v += wind_step

    # New folder structure: wind/sweeps/{batch_id}/
    sweep_root = os.path.join(wind_dir, "sweeps", batch_id)
    inp_dir    = os.path.join(sweep_root, "inp")
    os.makedirs(inp_dir, exist_ok=True)

    cases = []

    for dlc in dlcs:
        dlc_id = dlc.get("id", "DLC1.1")
        wind_type_idx, wind_type_str = DLC_WIND_TYPE_MAP.get(dlc_id, (0, "NTM"))

        for v_hub in speeds:
            for seed_i in range(1, seeds_per_speed + 1):
                rand_seed = seed_i * 10007 + int(v_hub * 100)

                cname    = _case_name(dlc_id, turb_model, wind_class, wind_type_str,
                                      v_hub, hub_ht, num_z, num_y, seed_i)
                inp_path = os.path.join(inp_dir, f"{cname}.inp")
                # TurbSim writes the .bts next to the .inp file
                bts_path = os.path.join(inp_dir, f"{cname}.bts")

                p = {
                    "NumGrid_Z":     num_z,
                    "NumGrid_Y":     num_y,
                    "TimeStep":      time_step,
                    "AnalysisTime":  duration,
                    "UsableTime":    use_time,
                    "HubHt":         hub_ht,
                    "GridHeight":    g_height,
                    "GridWidth":     g_width,
                    "TurbModel":     turb_model,
                    "IECstandard":   iec_std,
                    "IECturbc":      wind_class,
                    "IEC_WindType":  wind_type_idx,
                    "WindProfileType": 0,
                    "RefHt":         hub_ht,
                    "URef":          v_hub,
                    "PLExp":         "default",
                    "RandSeed1":     rand_seed,
                    "RandSeed2":     "RanLux",
                    "WrADFF":        True,
                    "WrBHHTP":       False,
                    "WrFHHTP":       False,
                    "WrADHH":        False,
                    "WrBLFF":        False,
                    "WrADTWR":       False,
                    "WrHAWCFF":      False,
                    "WrFMTFF":       False,
                    "WrACT":         False,
                    "ScaleIEC":      0,
                    "gTI":           1.0,
                    "RICH_NO":       0.0,
                }

                write_turbsim_inp(p, inp_path)

                cases.append({
                    "id":        cname,
                    "label":     f"{dlc_id}  V={v_hub:.0f} m/s  s{seed_i:02d}",
                    "inp_path":  inp_path,
                    "bts_path":  bts_path,
                    "dlc":       dlc_id,
                    "v":         v_hub,
                    "seed":      seed_i,
                    "wind_type": wind_type_str,
                    "t_max":     use_time,
                })

    wc_str  = WIND_CLASSES_STR[wind_class] if wind_class < len(WIND_CLASSES_STR) else "A"
    dlc_ids = [d.get("id", "DLC1.1") for d in dlcs]

    manifest = {
        "batch_id":       batch_id,
        "mode":           "dlc",
        "label":          batch_label or f"{'+'.join(dlc_ids)} IEC Class {wc_str} — {len(speeds)} speeds × {seeds_per_speed} seeds",
        "created":        datetime.datetime.now().isoformat(),
        "turbine":        turbine,
        "grid":           grid,
        "dlcs":           dlc_ids,
        "seeds_per_speed": seeds_per_speed,
        "wind_step":      wind_step,
        "speeds":         sorted(set(c["v"] for c in cases)),
        "case_count":     len(cases),
        "sweep_root":     sweep_root,
        "cases":          cases,
    }
    manifest_path = os.path.join(sweep_root, "sweep.json")
    with open(manifest_path, "w") as _f:
        _json.dump(manifest, _f, indent=2)

    return {"ok": True, "cases": cases, "sweep_root": sweep_root, "manifest_path": manifest_path}


def generate_custom_sweep(cmd: dict) -> dict:
    """
    Generate TurbSim .inp files for a custom parameter sweep.

    Expected cmd keys:
      working_dir, wind_dir, batch_id, batch_label
      turbine     – {hubHeight, rotorDiam, windClass, turbModel, iecStandard}
      grid        – {numY, numZ, gridWidth, gridHeight, duration, useTime, timeStep}
      sweep_mode  – "factorial" | "paired"
      sweep_params – {
        wind_speeds:    [floats],
        seeds:          int,
        iec_wind_types: [ints 0-3],
        wind_classes:   [ints 0-2],     # ignored when ti_values is non-empty
        ti_values:      [floats],        # Iref values e.g. [0.04, 0.14, 0.22]; overrides wind_classes
        shear_exps:     [floats or null],
        gti_values:     [floats],        # gTI sweep axis e.g. [1.0, 1.15, 1.30]; replaces ti_asymmetry
        ti_asymmetry:   float (gTI),     # legacy single-value fallback when gti_values absent
      }

    gti_values is a first-class sweep axis: combined with wind_speeds, iec_wind_types,
    ti_axis, and shear_exps in factorial or paired mode. Each gTI value gets its own
    per-case .profiles file and a gTI tag in the case name (omitted when gTI=1.0).
    """
    import datetime, json as _json, itertools

    working_dir  = cmd.get("working_dir", ".")
    wind_dir     = cmd.get("wind_dir") or os.path.join(working_dir, "wind")
    batch_id     = cmd.get("batch_id") or datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    batch_label  = cmd.get("batch_label", "")
    turbine      = cmd.get("turbine", {})
    grid         = cmd.get("grid", {})
    sweep_mode   = cmd.get("sweep_mode", "factorial")
    sweep_params = cmd.get("sweep_params", {})

    hub_ht     = float(turbine.get("hubHeight",  90.0))
    turb_model = int(turbine.get("turbModel",    0))
    iec_std    = int(turbine.get("iecStandard",  0))

    num_y     = int(grid.get("numY",       15))
    num_z     = int(grid.get("numZ",       15))
    g_width   = float(grid.get("gridWidth",  200.0))
    g_height  = float(grid.get("gridHeight", 200.0))
    duration  = float(grid.get("duration",   630.0))
    use_time  = float(grid.get("useTime",    600.0))
    time_step = float(grid.get("timeStep",   0.05))

    wind_speeds    = [float(v) for v in sweep_params.get("wind_speeds", [12.0])]
    n_seeds        = int(sweep_params.get("seeds", 6))
    wind_type_idxs = [int(i) for i in sweep_params.get("iec_wind_types", [0])]
    wind_class_idxs= [int(i) for i in sweep_params.get("wind_classes",
                                                         [int(turbine.get("windClass", 0))])]
    # ti_values: list of Iref floats (e.g. 0.18 = 18% TI). Overrides wind_classes when non-empty.
    raw_ti         = sweep_params.get("ti_values", [])
    ti_values      = [float(x) for x in raw_ti if x is not None]
    use_ti_sweep   = len(ti_values) > 0

    raw_shears     = sweep_params.get("shear_exps", [None])
    shear_exps     = [float(x) if x is not None else None for x in raw_shears]

    # gTI sweep axis — gti_values replaces the old scalar ti_asymmetry.
    # Fallback: wrap legacy ti_asymmetry in a list so old callers still work.
    raw_gtis   = sweep_params.get("gti_values", [])
    gti_values = [float(x) for x in raw_gtis if x is not None and float(x) >= 1.0]
    if not gti_values:
        gti_values = [float(sweep_params.get("ti_asymmetry", 1.0))]

    sweep_root = os.path.join(wind_dir, "sweeps", batch_id)
    inp_dir    = os.path.join(sweep_root, "inp")
    os.makedirs(inp_dir, exist_ok=True)

    # The turbulence axis: either TI values or wind class indices
    ti_axis = ti_values if use_ti_sweep else wind_class_idxs

    if sweep_mode == "paired":
        max_len = max(len(wind_speeds), len(wind_type_idxs), len(ti_axis), len(shear_exps), len(gti_values))
        def _pad(lst, val): return lst + [val] * (max_len - len(lst))
        combos = list(zip(
            _pad(wind_speeds,    wind_speeds[-1]),
            _pad(wind_type_idxs, wind_type_idxs[-1]),
            _pad(ti_axis,        ti_axis[-1]),
            _pad(shear_exps,     shear_exps[-1]),
            _pad(gti_values,     gti_values[-1]),
        ))
    else:
        combos = list(itertools.product(wind_speeds, wind_type_idxs, ti_axis, shear_exps, gti_values))

    cases = []

    for v_hub, wt_idx, ti_ax_val, shear_exp, gti in combos:
        wt_str = WIND_TYPES_STR[wt_idx] if 0 <= wt_idx < len(WIND_TYPES_STR) else "NTM"
        pl_exp = shear_exp if shear_exp is not None else "default"

        if use_ti_sweep:
            ti_val  = float(ti_ax_val)
            wc_idx  = 0
            wc_label = f"TI{int(round(ti_val * 100)):03d}pct"
            iec_turbc_custom = f"{ti_val:.4f}"
        else:
            ti_val  = None
            wc_idx  = int(ti_ax_val)
            wc_label = WIND_CLASSES_STR[wc_idx] if 0 <= wc_idx < len(WIND_CLASSES_STR) else "A"
            iec_turbc_custom = ""

        for seed_i in range(1, n_seeds + 1):
            rand_seed = (seed_i * 10007 + int(v_hub * 100)
                         + wt_idx * 7919 + wc_idx * 3571)

            cname    = _case_name("Custom", turb_model, wc_idx, wt_str,
                                  v_hub, hub_ht, num_z, num_y, seed_i, shear_exp, ti_val, gti)
            inp_path = os.path.join(inp_dir, f"{cname}.inp")
            bts_path = os.path.join(inp_dir, f"{cname}.bts")

            # Always per-case profile filename — avoids parallel-write races and
            # ensures each (URef, gTI) combination gets its own correct profile.
            profile_fname = f"{cname}.profiles"

            p = {
                "NumGrid_Z":       num_z,
                "NumGrid_Y":       num_y,
                "TimeStep":        time_step,
                "AnalysisTime":    duration,
                "UsableTime":      use_time,
                "HubHt":           hub_ht,
                "GridHeight":      g_height,
                "GridWidth":       g_width,
                "TurbModel":       turb_model,
                "IECstandard":     iec_std,
                "IECturbc":        wc_idx,
                "IECturbc_custom": iec_turbc_custom,
                "IEC_WindType":    wt_idx,
                "WindProfileType": 0,
                "RefHt":           hub_ht,
                "URef":            float(v_hub),
                "PLExp":           pl_exp,
                "RandSeed1":       rand_seed,
                "RandSeed2":       "RanLux",
                "WrADFF":          True,
                "WrBHHTP":         False,
                "WrFHHTP":         False,
                "WrADHH":          False,
                "WrBLFF":          False,
                "WrADTWR":         False,
                "WrHAWCFF":        False,
                "WrFMTFF":         False,
                "WrACT":           False,
                "ScaleIEC":        0,
                "gTI":             gti,
                "RICH_NO":         0.0,
                "_profile_file":   profile_fname,
            }

            write_turbsim_inp(p, inp_path)

            lbl_parts = [f"V={float(v_hub):.0f} m/s", wt_str]
            if use_ti_sweep:
                lbl_parts.append(f"TI={int(round(ti_val * 100))}%")
            else:
                lbl_parts.append(f"Class {wc_label}")
            if shear_exp is not None:
                lbl_parts.append(f"α={shear_exp:.2f}")
            if abs(gti - 1.0) > 1e-6:
                lbl_parts.append(f"gTI={gti:.2f}")
            lbl_parts.append(f"s{seed_i:02d}")

            cases.append({
                "id":         cname,
                "label":      "  ".join(lbl_parts),
                "inp_path":   inp_path,
                "bts_path":   bts_path,
                "dlc":        None,
                "v":          float(v_hub),
                "seed":       seed_i,
                "wind_type":  wt_str,
                "wind_class": wc_label,
                "shear_exp":  shear_exp,
                "ti_val":     float(ti_ax_val) if use_ti_sweep else None,
                "t_max":      use_time,
            })

    n_combos = len(combos)
    # Augment sweep_params with resolved gti_values for manifest traceability
    sweep_params_out = {**sweep_params, "gti_values": gti_values}
    manifest = {
        "batch_id":    batch_id,
        "mode":        "custom",
        "label":       batch_label or f"Custom sweep — {n_combos} param set{'s' if n_combos!=1 else ''} × {n_seeds} seeds",
        "created":     datetime.datetime.now().isoformat(),
        "turbine":     turbine,
        "grid":        grid,
        "sweep_mode":  sweep_mode,
        "sweep_params": sweep_params_out,
        "speeds":      sorted(set(c["v"] for c in cases)),
        "case_count":  len(cases),
        "sweep_root":  sweep_root,
        "cases":       cases,
    }
    manifest_path = os.path.join(sweep_root, "sweep.json")
    with open(manifest_path, "w") as _f:
        _json.dump(manifest, _f, indent=2)

    return {"ok": True, "cases": cases, "sweep_root": sweep_root, "manifest_path": manifest_path}


def scan_sweeps(working_dir: str) -> list:
    """
    Scan wind/sweeps/ for sweep.json manifests and return metadata cards.
    Results are sorted newest-first by creation timestamp.
    """
    import json as _json

    sweeps_dir = os.path.join(working_dir, "wind", "sweeps")
    if not os.path.isdir(sweeps_dir):
        return []

    results = []
    for entry in sorted(os.listdir(sweeps_dir)):
        sweep_dir = os.path.join(sweeps_dir, entry)
        if not os.path.isdir(sweep_dir):
            continue
        manifest_path = os.path.join(sweep_dir, "sweep.json")
        if not os.path.isfile(manifest_path):
            continue
        try:
            with open(manifest_path) as _f:
                m = _json.load(_f)
            # .bts files live in the inp/ subdirectory (same dir as .inp)
            inp_sub = os.path.join(sweep_dir, "inp")
            bts_search_dir = inp_sub if os.path.isdir(inp_sub) else sweep_dir
            bts_count = sum(1 for fn in os.listdir(bts_search_dir)
                            if fn.lower().endswith(".bts"))
            results.append({
                "batch_id":      m.get("batch_id", entry),
                "mode":          m.get("mode", "unknown"),
                "label":         m.get("label", entry),
                "created":       m.get("created", ""),
                "case_count":    m.get("case_count", 0),
                "bts_count":     bts_count,
                "speeds":        m.get("speeds", []),
                "sweep_root":    sweep_dir,
                "manifest_path": manifest_path,
                "cases":         m.get("cases", []),
            })
        except Exception:
            continue

    results.sort(key=lambda x: x.get("created", ""), reverse=True)
    return results


# ── InflowWind ────────────────────────────────────────────────────────────────

def write_inflowwind_dat(p: dict, path: str) -> None:
    """
    Generate an InflowWind input file compatible with OpenFAST v4.2.0.

    Supported WindTypes:
      1 = Steady wind (HWindSpeed + power law)
      3 = Binary TurbSim Full-Field (.bts)
    All other types have placeholder lines so the file parses cleanly.
    """
    def f(v, w=12): return str(v).ljust(w)

    wind_type    = int(p.get("WindType",       3))
    prop_dir     = float(p.get("PropagationDir", 0.0))
    vflow_ang    = float(p.get("VFlowAng",       0.0))
    n_wind_vel   = int(p.get("NWindVel",         1))
    vxi          = float(p.get("WindVxiList",    0.0))
    vyi          = float(p.get("WindVyiList",    0.0))
    vzi          = float(p.get("WindVziList",    90.0))

    # Type 1 – Steady
    h_wind      = float(p.get("HWindSpeed", 12.0))
    ref_ht      = float(p.get("RefHt",      90.0))
    pl_exp      = float(p.get("PLexp",       0.2))

    # Type 2 – Uniform
    fn_uni      = p.get("Filename_Uni", "none")
    ref_ht_uni  = float(p.get("RefHt_Uni",  90.0))
    ref_len     = float(p.get("RefLength",   63.0))

    # Type 3 – TurbSim BTS
    fn_bts      = p.get("FileName_BTS", "turbsim.bts")

    sum_print   = "True" if p.get("SumPrint", False) else "False"

    type_label = {1: "Steady", 2: "Uniform", 3: "TurbSim BTS"}.get(wind_type, "Custom")

    lines = [
        "------- InflowWind v3.01.* INPUT FILE ----------------------------------------",
        f"FlowWake Studio — InflowWind | WindType={wind_type} ({type_label})",
        "-------     Flow Field Type         ------------------------------------------",
        f"{f(wind_type)}WindType        - switch for wind file type (1=steady; 2=uniform; 3=binary TurbSim FF; 4=binary Bladed-style FF; 5=HAWC format; 6=User-defined; 7=native Bladed FF)",
        f"{f(prop_dir)}PropagationDir  - direction of wind propagation, meteorological convention (degrees)",
        f"{f(vflow_ang)}VFlowAng        - upflow angle (degrees)",
        f"{f(n_wind_vel)}NWindVel        - number of points for wind velocity output (0 to 9)",
        f"{f(vxi)}WindVxiList     - X locations for wind velocity output (m)",
        f"{f(vyi)}WindVyiList     - Y locations for wind velocity output (m)",
        f"{f(vzi)}WindVziList     - Z locations for wind velocity output (m)",
        "================== Parameters for Steady Wind Conditions [used only for WindType = 1] ======================",
        f"{f(h_wind)}HWindSpeed      - horizontal wind speed at reference height (m/s)",
        f"{f(ref_ht)}RefHt           - reference height for horizontal wind speed (m)",
        f"{f(pl_exp)}PLexp           - power law wind shear exponent (-)",
        "================== Parameters for Uniform Wind Conditions [used only for WindType = 2] =====================",
        f'"{fn_uni}"'.ljust(12) + ' Filename_Uni    - filename for uniform wind data file (.wnd/.txt)',
        f"{f(ref_ht_uni)}RefHt_Uni       - reference height for uniform wind (m)",
        f"{f(ref_len)}RefLength       - reference length for power calculations (m)",
        "================== Parameters for Binary TurbSim Full-Field [used only for WindType = 3] ===================",
        f'"{fn_bts}"'.ljust(12) + ' FileName_BTS    - name of the full field wind file to use (.bts)',
        "================== Parameters for Binary Bladed-style Full-Field [used only for WindType = 4] ==============",
        '"none"       FilenameRoot    - rootname of binary files (without .wnd extension)',
        "False        TowerFile       - have tower file (.twr) (flag)",
        "================== Parameters for HAWC-format binary files [used only for WindType = 5] ===================",
        '"none"       FileName_u      - name of the file containing the u-component fluctuating wind',
        '"none"       FileName_v      - name of the file containing the v-component',
        '"none"       FileName_w      - name of the file containing the w-component',
        "64           nx              - number of grids in the x direction",
        "32           ny              - number of grids in the y direction",
        "32           nz              - number of grids in the z direction",
        "32.0         dx              - distance (m) between points in the x direction",
        "16.0         dy              - distance (m) between points in the y direction",
        "16.0         dz              - distance (m) between points in the z direction",
        "90.0         RefHt_Hawc      - reference height for HAWC wind (m)",
        "0.2          PLExp_Hawc      - power law exponent (-)",
        '"none"       ProfileFile_Hawc - name of the HAWC shear profile file (optional)',
        "================== InflowWind Outputs [optional] ====================================================",
        f"{f(sum_print)}SumPrint        - print summary data to <RootName>.IfW.sum (flag)",
        "              OutList         - the next line(s) contains a list of output parameters",
        'END of input file (the word "END" must appear in the first 3 columns of this last OutList line)',
    ]

    os.makedirs(os.path.dirname(path) if os.path.dirname(path) else ".", exist_ok=True)
    with open(path, "w") as f_out:
        f_out.write("\n".join(lines) + "\n")


def list_bts_files(working_dir: str) -> list:
    """Recursively find all .bts files under working_dir."""
    results = []
    for root, dirs, files in os.walk(working_dir):
        # Skip hidden dirs
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for fname in files:
            if fname.lower().endswith(".bts"):
                full = os.path.join(root, fname)
                rel  = os.path.relpath(full, working_dir)
                results.append({"path": full, "rel": rel, "name": fname})
    results.sort(key=lambda x: x["rel"])
    return results


def handle(cmd: dict) -> dict:
    action = cmd.get("cmd")
    if action == "ping":
        return {"ok": True, "msg": "fws_io ready"}
    if action == "write_turbsim_inp":
        try:
            write_turbsim_inp(cmd["params"], cmd["path"])
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    if action == "preview_turbsim_inp":
        try:
            content = preview_turbsim_inp(cmd["params"])
            return {"ok": True, "content": content}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    if action == "generate_dlc_batch":
        try:
            return generate_dlc_batch(cmd)
        except Exception as e:
            return {"ok": False, "error": str(e)}
    if action == "generate_custom_sweep":
        try:
            return generate_custom_sweep(cmd)
        except Exception as e:
            return {"ok": False, "error": str(e)}
    if action == "scan_sweeps":
        try:
            sweeps = scan_sweeps(cmd.get("working_dir", "."))
            return {"ok": True, "sweeps": sweeps}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    if action == "write_inflowwind_dat":
        try:
            write_inflowwind_dat(cmd["params"], cmd["path"])
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    if action == "preview_inflowwind_dat":
        try:
            import tempfile
            with tempfile.NamedTemporaryFile(mode="w", suffix=".dat", delete=False) as tmp:
                tmp_path = tmp.name
            write_inflowwind_dat(cmd["params"], tmp_path)
            with open(tmp_path) as f:
                content = f.read()
            try: os.unlink(tmp_path)
            except: pass
            return {"ok": True, "content": content}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    if action == "list_bts_files":
        try:
            files = list_bts_files(cmd.get("working_dir", "."))
            return {"ok": True, "files": files}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    return {"ok": False, "error": f"unknown command: {action}"}


def main():
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw: continue
        try:
            result = handle(json.loads(raw))
        except json.JSONDecodeError as e:
            result = {"ok": False, "error": f"JSON parse error: {e}"}
        except Exception as e:
            result = {"ok": False, "error": str(e)}
        try:
            print(json.dumps(result), flush=True)
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"serialize error: {e}"}), flush=True)


if __name__ == "__main__":
    main()
