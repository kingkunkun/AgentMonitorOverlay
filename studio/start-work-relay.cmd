@echo off
setlocal
set "RELAY=%~dp0release\workstudio-integrated\WorkStudio\WorkStudio.exe"
if not exist "%RELAY%" (
  echo Work relay is not built. See docs/work-relay.md.
  pause
  exit /b 1
)
start "" "%RELAY%" --amo-app=relay
