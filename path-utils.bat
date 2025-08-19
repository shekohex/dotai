@echo off
setlocal enabledelayedexpansion

REM Cross-platform path resolution utility for Windows
REM Usage: path-utils.bat <operation> [args...]

set "operation=%~1"

if "%operation%"=="" goto :usage

goto :%operation% 2>nul
if !errorlevel! neq 0 (
    echo [ERROR] Unknown operation: %operation%
    goto :usage
)

:get_home_dir
REM Returns the user's home directory
echo %USERPROFILE%
goto :eof

:get_config_dir
REM Returns the user's config directory
if not "%APPDATA%"=="" (
    echo %APPDATA%
) else (
    echo %USERPROFILE%\AppData\Roaming
)
goto :eof

:get_local_config_dir
REM Returns the user's local config directory
if not "%LOCALAPPDATA%"=="" (
    echo %LOCALAPPDATA%
) else (
    echo %USERPROFILE%\AppData\Local
)
goto :eof

:expand_path
REM Expands a path with ~ or environment variables
set "input_path=%~2"
if "%input_path%"=="" goto :usage

REM Replace ~ with home directory at the beginning of path
if "!input_path:~0,1!"=="~" (
    if "!input_path:~1,1!"=="\" (
        set "expanded_path=%USERPROFILE%!input_path:~1!"
    ) else if "!input_path:~1,1!"=="/" (
        set "expanded_path=%USERPROFILE%!input_path:~1!"
    ) else if "!input_path!"=="~" (
        set "expanded_path=%USERPROFILE%"
    ) else (
        REM ~ followed by something else, leave as is
        set "expanded_path=!input_path!"
    )
) else (
    set "expanded_path=!input_path!"
)

REM Expand environment variables
call set "expanded_path=!expanded_path!"
echo !expanded_path!
goto :eof

:normalize_path
REM Normalizes path separators for Windows
set "input_path=%~2"
if "%input_path%"=="" goto :usage

REM Replace forward slashes with backslashes
set "normalized_path=!input_path:/=\!"
echo !normalized_path!
goto :eof

:join_paths
REM Joins two or more paths with proper separator
set "result_path="
shift

:join_loop
if "%~1"=="" goto :join_done
if "!result_path!"=="" (
    set "result_path=%~1"
) else (
    REM Remove trailing separator from result_path
    if "!result_path:~-1!"=="\" set "result_path=!result_path:~0,-1!"
    REM Remove leading separator from current path
    set "current_path=%~1"
    if "!current_path:~0,1!"=="\" set "current_path=!current_path:~1!"
    if "!current_path:~0,1!"=="/" set "current_path=!current_path:~1!"
    set "result_path=!result_path!\!current_path!"
)
shift
goto :join_loop

:join_done
echo !result_path!
goto :eof

:usage
echo Usage: %~nx0 ^<operation^> [args...]
echo.
echo Operations:
echo   get_home_dir           - Get user's home directory
echo   get_config_dir         - Get user's config directory
echo   get_local_config_dir   - Get user's local config directory
echo   expand_path ^<path^>     - Expand ~ and environment variables
echo   normalize_path ^<path^>  - Normalize path separators
echo   join_paths ^<path1^> ^<path2^> [...] - Join paths with proper separators
echo.
echo Examples:
echo   %~nx0 expand_path "~\.claude"
echo   %~nx0 join_paths "%USERPROFILE%" ".config" "opencode"
exit /b 1