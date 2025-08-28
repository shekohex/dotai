@echo off
setlocal enabledelayedexpansion

REM Colors for output (basic Windows support)
set "INFO_COLOR=echo [INFO]"
set "WARN_COLOR=echo [WARN]"
set "ERROR_COLOR=echo [ERROR]"

REM Script directory
set "SCRIPT_DIR=%~dp0"
set "MCP_JSON=%SCRIPT_DIR%mcp.json"

REM Target directories
set "CLAUDE_DIR=%USERPROFILE%\.claude"
set "OPENCODE_DIR=%USERPROFILE%\.config\opencode"

REM Target files
set "CLAUDE_CONFIG=%USERPROFILE%\.claude.json"
set "OPENCODE_CONFIG=%OPENCODE_DIR%\opencode.json"

goto :main

:check_dependencies
REM Check if jq is available
where jq >nul 2>&1
if !errorlevel! neq 0 (
    %ERROR_COLOR% jq is required but not installed
    echo Please install jq from: https://stedolan.github.io/jq/download/
    exit /b 1
)
goto :eof

:ensure_directories
if not exist "%CLAUDE_DIR%" mkdir "%CLAUDE_DIR%"
if not exist "%OPENCODE_DIR%" mkdir "%OPENCODE_DIR%"
goto :eof

:backup_config
set "config_file=%~1"
if exist "%config_file%" (
    for /f "tokens=1-3 delims=/ " %%a in ('date /t') do set "date_part=%%c%%a%%b"
    for /f "tokens=1-2 delims=: " %%a in ('time /t') do set "time_part=%%a%%b"
    set "backup_file=%config_file%.backup_%date_part%_%time_part%"
    copy "%config_file%" "!backup_file!" >nul
    %INFO_COLOR% Backed up %config_file% to !backup_file!
)
goto :eof

:sync_to_claude
set "claude_config=%~1"

%INFO_COLOR% Syncing MCP config to Claude format...

REM Check if Claude config exists
if not exist "%claude_config%" (
    %WARN_COLOR% Claude config not found, creating minimal config
    echo {}> "%claude_config%"
)

REM Use the cross-platform jq utility
set "temp_mcp=%TEMP%\mcp_servers_%RANDOM%.json"
call "%SCRIPT_DIR%jq-patch.bat" extract_field "%MCP_JSON%" "%temp_mcp%" ".mcpServers | with_entries(select(.value.enabled == true))"
if !errorlevel! neq 0 goto :eof

call "%SCRIPT_DIR%jq-patch.bat" set_field "%claude_config%" "%claude_config%.tmp" ".mcpServers" "%temp_mcp%"
if !errorlevel! equ 0 (
    move "%claude_config%.tmp" "%claude_config%" >nul
    %INFO_COLOR% Claude MCP config updated
)
del "%temp_mcp%" 2>nul
goto :eof

:sync_to_opencode
set "opencode_config=%~1"

%INFO_COLOR% Syncing MCP config to OpenCode format...

REM Check if OpenCode config exists
if not exist "%opencode_config%" (
    %WARN_COLOR% OpenCode config not found, creating minimal config
    (
        echo {
        echo   "$schema": "https://opencode.ai/config.json",
        echo   "theme": "system",
        echo   "autoshare": false,
        echo   "autoupdate": true
        echo }
    ) > "%opencode_config%"
)

REM Use the cross-platform jq utility
set "temp_mcp=%TEMP%\mcp_servers_%RANDOM%.json"
set "temp_transformed=%TEMP%\opencode_mcp_%RANDOM%.json"

REM Extract mcpServers and transform to OpenCode format
call "%SCRIPT_DIR%jq-patch.bat" extract_field "%MCP_JSON%" "%temp_mcp%" ".mcpServers | with_entries(select(.value.enabled == true))"
if !errorlevel! neq 0 goto :eof

call "%SCRIPT_DIR%jq-patch.bat" transform_opencode "%temp_mcp%" "%temp_transformed%"
if !errorlevel! neq 0 (
    del "%temp_mcp%" 2>nul
    goto :eof
)

call "%SCRIPT_DIR%jq-patch.bat" set_field "%opencode_config%" "%opencode_config%.tmp" ".mcp" "%temp_transformed%"
if !errorlevel! equ 0 (
    move "%opencode_config%.tmp" "%opencode_config%" >nul
    %INFO_COLOR% OpenCode MCP config updated
)

del "%temp_mcp%" 2>nul
del "%temp_transformed%" 2>nul
goto :eof

:sync_configs
if not exist "%MCP_JSON%" (
    %ERROR_COLOR% mcp.json not found at %MCP_JSON%
    exit /b 1
)

REM Validate mcp.json
jq empty "%MCP_JSON%" >nul 2>&1
if !errorlevel! neq 0 (
    %ERROR_COLOR% Invalid JSON in %MCP_JSON%
    exit /b 1
)

call :ensure_directories

REM Sync to Claude
if exist "%CLAUDE_CONFIG%" (
    call :backup_config "%CLAUDE_CONFIG%"
)
call :sync_to_claude "%CLAUDE_CONFIG%"

REM Sync to OpenCode
if exist "%OPENCODE_CONFIG%" (
    call :backup_config "%OPENCODE_CONFIG%"
)
call :sync_to_opencode "%OPENCODE_CONFIG%"

%INFO_COLOR% MCP configuration sync completed!
goto :eof

:usage
echo Usage: %~nx0 [OPTIONS]
echo Options:
echo   -h, --help     Show this help message
echo   --dry-run      Show what would be changed without applying
echo.
echo Synchronizes MCP server configurations from mcp.json to:
echo   - %CLAUDE_CONFIG%
echo   - %OPENCODE_CONFIG%
goto :eof

:main
REM Parse command line arguments
set "DRY_RUN=false"

:parse_args
if "%~1"=="" goto :start_sync
if "%~1"=="-h" goto :show_help
if "%~1"=="--help" goto :show_help
if "%~1"=="--dry-run" (
    set "DRY_RUN=true"
    shift
    goto :parse_args
)

%ERROR_COLOR% Unknown option: %~1
call :usage
exit /b 1

:show_help
call :usage
exit /b 0

:start_sync
%INFO_COLOR% Starting MCP configuration sync...

call :check_dependencies
if !errorlevel! neq 0 exit /b 1

if "%DRY_RUN%"=="true" (
    %INFO_COLOR% Dry run mode - no changes will be made
    REM TODO: Implement dry run logic
    exit /b 0
)

call :sync_configs

endlocal
