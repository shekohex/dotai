@echo off
setlocal enabledelayedexpansion

:: Disable statusline on Windows by removing the statusLine section
echo Disabling statusline on Windows...

set "SETTINGS_FILE=.claude\settings.json"
set "TEMP_FILE=.claude\settings.json.tmp"

:: Check if settings file exists
if not exist "%SETTINGS_FILE%" (
    echo Error: Settings file not found: %SETTINGS_FILE%
    exit /b 1
)

:: Check if jq is available
where jq >nul 2>&1
if errorlevel 1 (
    echo Error: jq is required but not found in PATH
    echo Please install jq from https://jqlang.github.io/jq/
    exit /b 1
)

:: Remove statusLine section
echo Removing statusLine section from settings...
jq "del(.statusLine)" "%SETTINGS_FILE%" > "%TEMP_FILE%"

if errorlevel 1 (
    echo Error: Failed to update settings file
    if exist "%TEMP_FILE%" del "%TEMP_FILE%"
    exit /b 1
)

:: Replace original file with updated version
move "%TEMP_FILE%" "%SETTINGS_FILE%"
if errorlevel 1 (
    echo Error: Failed to replace settings file
    exit /b 1
)

echo Successfully disabled statusline
echo Claude Code will now run without a custom statusline on Windows