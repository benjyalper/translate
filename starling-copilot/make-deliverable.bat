@echo off
rem  make-deliverable.bat -- turn the extension's export into the submit-ready LQA file.
rem  USE: drag BOTH .xlsx files onto this icon at once (order does not matter):
rem         * the original LQA report you received
rem         * the extension's exported .xlsx ("Export form")
rem  It writes "<original> with-agrees.xlsx" next to the original, with formatting intact.
chcp 65001 >nul
setlocal
set "PYTHONIOENCODING=utf-8"
set "SCRIPT=%~dp0apply-agrees.py"

if "%~2"=="" (
  echo.
  echo   Drag BOTH files onto this icon at the same time:
  echo      1^) the original LQA report you received
  echo      2^) the extension's exported .xlsx
  echo   ^(order does not matter^)
  echo.
  pause
  exit /b 1
)

where python >nul 2>nul && (set "PY=python") || (set "PY=py")
echo Building your submit-ready file...
echo.
"%PY%" "%SCRIPT%" %1 %2
echo.
pause
