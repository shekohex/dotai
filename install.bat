@echo off
setlocal enabledelayedexpansion

set "REPO_DIR=%~dp0"
set "CLAUDE_CONFIG=%USERPROFILE%\.claude"
set "OPENCODE_CONFIG=%USERPROFILE%\.config\opencode"

echo [INFO] AI Configuration Installer
echo [INFO] Repository: %REPO_DIR%

:check_and_sync_file
set "source=%~1"
set "target=%~2"
set "name=%~3"

if not exist "%source%" (
    echo [ERROR] Source file not found: %source%
    exit /b 1
)

REM Create target directory if it doesn't exist
for %%I in ("%target%") do if not exist "%%~dpI" mkdir "%%~dpI"

if exist "%target%" (
    REM Compare files
    fc /B "%source%" "%target%" >nul 2>&1
    if !errorlevel! neq 0 (
        echo [WARN] Files differ for %name%:
        echo.
        if exist "%SystemRoot%\System32\git.exe" (
            git diff --no-index --color=never "%target%" "%source%" 2>nul || (
                echo Files are different but diff unavailable
            )
        ) else (
            echo Files are different - git diff unavailable
        )
        echo.
        set /p "confirm=Replace %name% with new version? (y/N): "
        if /i "!confirm!"=="y" (
            REM Backup existing file
            set "backup=%target%.backup.%date:~-4%%date:~4,2%%date:~7,2%_%time:~0,2%%time:~3,2%%time:~6,2%"
            set "backup=!backup: =0!"
            if exist "%target%" copy "%target%" "!backup!" >nul
            echo [INFO] Backed up existing file: !backup!
            
            copy "%source%" "%target%" >nul
            echo [INFO] Updated %name%
        ) else (
            echo [INFO] Skipped %name%
        )
    ) else (
        echo [INFO] %name% is already up to date
    )
) else (
    copy "%source%" "%target%" >nul
    echo [INFO] Created %name%
)
goto :eof

:sync_directory
set "source_dir=%~1"
set "target_dir=%~2"
set "name=%~3"

if not exist "%source_dir%" (
    echo [ERROR] Source directory not found: %source_dir%
    exit /b 1
)

echo [INFO] Syncing %name% directory...

REM Create target directory if it doesn't exist
if not exist "%target_dir%" mkdir "%target_dir%"

REM Copy directory contents (excluding .git)
xcopy "%source_dir%\*" "%target_dir%\" /E /I /Y /Q 2>nul

echo [INFO] Synced %name% directory
goto :eof

:main
REM Sync AI.md to CLAUDE.md
call :check_and_sync_file "%REPO_DIR%AI.md" "%CLAUDE_CONFIG%\CLAUDE.md" "Claude instructions"
echo [INFO] Claude configuration synchronized

REM Sync AI.md to AGENTS.md
call :check_and_sync_file "%REPO_DIR%AI.md" "%OPENCODE_CONFIG%\AGENTS.md" "OpenCode instructions"
echo [INFO] OpenCode configuration synchronized

REM Sync .claude directory
if exist "%REPO_DIR%.claude" (
    call :sync_directory "%REPO_DIR%.claude" "%CLAUDE_CONFIG%" "Claude"
)

REM Sync .opencode directory  
if exist "%REPO_DIR%.opencode" (
    call :sync_directory "%REPO_DIR%.opencode" "%OPENCODE_CONFIG%" "OpenCode"
)

echo [INFO] Installation complete!
echo [INFO] Claude config: %CLAUDE_CONFIG%
echo [INFO] OpenCode config: %OPENCODE_CONFIG%

endlocal