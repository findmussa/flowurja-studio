; FlowWake Studio — NSIS installer hook
; Injects a license agreement page before the installation begins.
;
; MUI_PAGE_LICENSE defines MUI_ICON and MUI_UNICON with NSIS defaults.
; Tauri later !defines both from our installerIcon / uninstallerIcon settings
; and NSIS aborts with "already defined!". Undef both after the macro so
; Tauri's defines succeed.
!insertmacro MUI_PAGE_LICENSE "${__FILEDIR__}\license.txt"
!ifdef MUI_ICON
  !undef MUI_ICON
!endif
!ifdef MUI_UNICON
  !undef MUI_UNICON
!endif
