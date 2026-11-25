; 설치 훅 — 표시 이름(productName)이 바뀌어 온 이력:
;   ~0.1.16 "문어AI - Claude 관리" (제조사 키 Software\kr) → 0.2.0~ "문어AI - AI관리" (Software\muneo) → (출시 안 됨) "고양이사무실" → "Meowffice".
; NSIS 는 제거 항목·설치 폴더·시작 메뉴를 productName 기준으로 다루므로, 그대로 두면 새 프로그램으로 설치되어
; 예전 설치본(제거 목록 항목·폴더·바로가기)이 남는다. 설치 직전에 예전 설치본을 조용히 제거하고,
; 업데이트 모드(/UPDATE)에선 템플릿이 시작 메뉴·바탕화면 바로가기를 만들지 않으므로 새 이름으로 직접 만든다
; (바탕화면은 예전 바로가기가 있던 경우에만 — 사용자가 지운 바로가기를 되살리지 않도록).
; 설정·로그(%APPDATA%\muneo\muneo-claude-usage-tray)는 제거 대상이 아니라 그대로 유지된다(identifier 그대로).
; 이 파일은 UTF-8(BOM) — 한글 레지스트리 키 이름 때문.

!define MUNEO_UNINSTROOT "Software\Microsoft\Windows\CurrentVersion\Uninstall"

Var MuneoMigrated
Var MuneoHadDesktop

; 예전 이름 하나로 깔린 설치본을 찾아 제거. NAME: 예전 productName, MANUKEY: 그때의 제조사 키.
!macro MUNEO_REMOVE_OLD NAME MANUKEY
  ReadRegStr $R8 HKCU "${MUNEO_UNINSTROOT}\${NAME}" "UninstallString"
  ; 설치 폴더는 제조사 키 기본값에서(InstallLocation 은 따옴표가 붙어 있어 _?= 에 못 씀).
  ReadRegStr $R9 HKCU "${MANUKEY}\${NAME}" ""
  ${If} $R8 != ""
  ${AndIf} $R9 != ""
  ${AndIf} $R9 != $INSTDIR
    DetailPrint "이전 설치본 제거: $R9"
    ; 예전 제거 프로그램이 바탕화면 바로가기도 지우므로 미리 기억.
    ${If} ${FileExists} "$DESKTOP\${NAME}.lnk"
      StrCpy $MuneoHadDesktop 1
    ${EndIf}
    ; /UPDATE 없이 /P 로 실행 → 예전 제거 항목·바로가기까지 삭제(앱 데이터 삭제 체크박스는 passive 에서 꺼짐).
    ; _?= 로 제자리 실행해 끝날 때까지 기다림(템플릿의 재설치 처리와 같은 방식).
    ExecWait '$R8 /P _?=$R9'
    Delete "$R9\uninstall.exe"
    RMDir "$R9"
    DeleteRegKey HKCU "${MANUKEY}\${NAME}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"
    StrCpy $MuneoMigrated 1
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  StrCpy $MuneoMigrated 0
  StrCpy $MuneoHadDesktop 0
  !insertmacro MUNEO_REMOVE_OLD "고양이사무실" "Software\muneo"
  !insertmacro MUNEO_REMOVE_OLD "문어AI - AI관리" "Software\muneo"
  !insertmacro MUNEO_REMOVE_OLD "문어AI - Claude 관리" "Software\kr"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $MuneoMigrated = 1
    ; 업데이트 모드에선 템플릿이 바로가기를 건너뛰므로 새 이름 바로가기를 직접 생성.
    ${IfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}
    ${If} $MuneoHadDesktop = 1
    ${AndIfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
      CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
    ; 자동시작 값이 예전 폴더를 가리키므로 새 경로로(앱이 켜지면 autostart.rs 가 다시 쓰지만 재부팅 전 대비).
    ReadRegStr $R8 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${MAINBINARYNAME}"
    ${If} $R8 != ""
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${MAINBINARYNAME}" '"$INSTDIR\${MAINBINARYNAME}.exe"'
    ${EndIf}
  ${EndIf}
!macroend
