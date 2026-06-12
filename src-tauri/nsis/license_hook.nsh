; FlowWake Studio — NSIS installer hook
; Injects a license agreement page before the installation begins.
; ${__FILEDIR__} resolves to the directory of this file at compile time,
; so license.txt is found correctly both locally and in CI.
!insertmacro MUI_PAGE_LICENSE "${__FILEDIR__}\license.txt"
