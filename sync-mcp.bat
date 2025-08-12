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

REM Extract mcpServers from mcp.json and merge into Claude config
for /f "delims=" %%i in ('jq ".mcpServers" "%MCP_JSON%"') do set "mcp_servers=%%i"

REM Update Claude config with MCP servers
jq --argjson mcpServers "!mcp_servers!" ".mcpServers = $mcpServers" "%claude_config%" > "%claude_config%.tmp"
move "%claude_config%.tmp" "%claude_config%" >nul

%INFO_COLOR% Claude MCP config updated
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

REM Extract and transform mcpServers from mcp.json
for /f "delims=" %%i in ('jq ".mcpServers" "%MCP_JSON%"') do set "mcp_servers=%%i"

REM Create temporary transformation script
set "temp_transform=%TEMP%\transform_mcp.jq"
(
    echo to_entries ^| map(
    echo   .value as $server ^| .key as $name ^|
    echo   {
    echo     key: $name,
    echo     value: (
    echo       if $server.type == "http" then
    echo         {
    echo           type: "remote",
    echo           url: $server.url,
    echo           enabled: true
    echo         }
    echo       else
    echo         {
    echo           type: "local",
    echo           command: ([$server.command] + ($server.args // [])),
    echo           enabled: true
    echo         } + (
    echo           if $server.env then
    echo             {environment: $server.env}
    echo           else
    echo             {}
    echo           end
    echo         )
    echo       end
    echo     )
    echo   }
    echo ) ^| from_entries
) > "%temp_transform%"

REM Transform to OpenCode format using the temp script
for /f "delims=" %%i in ('jq -f "%temp_transform%" "%MCP_JSON%"') do set "opencode_mcp=%%i"
del "%temp_transform%" 2>nul

REM Update OpenCode config with transformed MCP servers
jq --argjson mcp "!opencode_mcp!" ".mcp = $mcp" "%opencode_config%" > "%opencode_config%.tmp"
move "%opencode_config%.tmp" "%opencode_config%" >nul

%INFO_COLOR% OpenCode MCP config updated
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
