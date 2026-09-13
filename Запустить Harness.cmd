@echo off
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1" %*
if "%ERRORLEVEL%"=="130" exit /b 130
if errorlevel 1 pause
