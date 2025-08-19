@echo off
setlocal enabledelayedexpansion

:: Fix Windows statusline by switching to Python version
echo Fixing Windows statusline compatibility...

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

:: Update statusline command to use Python version
echo Updating statusline to use cross-platform Python version...

:: Create temporary jq filter file to avoid escaping issues
echo .statusLine.command = "python3 \"%%USERPROFILE%%\\.claude\\statusline-enhanced.py\"" > .claude\jq_filter.tmp

jq -f .claude\jq_filter.tmp "%SETTINGS_FILE%" > "%TEMP_FILE%"
del .claude\jq_filter.tmp

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

echo Successfully updated statusline to use Python version
echo The statusline will now work on both Windows and Unix systems