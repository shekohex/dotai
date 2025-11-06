@echo off
setlocal enabledelayedexpansion

REM Cross-platform JSON patching utility for Windows
REM Usage: jq-patch.bat <operation> <input_file> <output_file> [additional_args...]

set "operation=%~1"
set "input_file=%~2"
set "output_file=%~3"

if "%operation%"=="" goto :usage
if "%input_file%"=="" goto :usage
if "%output_file%"=="" goto :usage

REM Check if jq is available
where jq >nul 2>&1
if !errorlevel! neq 0 (
    echo [ERROR] jq is required but not installed
    echo Please install jq from: https://stedolan.github.io/jq/download/
    exit /b 1
)

REM Validate input file exists and is valid JSON
if not exist "%input_file%" (
    echo [ERROR] Input file not found: %input_file%
    exit /b 1
)

jq empty "%input_file%" >nul 2>&1
if !errorlevel! neq 0 (
    echo [ERROR] Invalid JSON in %input_file%
    exit /b 1
)

REM Create temporary directory for intermediate files
set "temp_dir=%TEMP%\jq-patch-%RANDOM%"
mkdir "%temp_dir%" 2>nul

goto :%operation% 2>nul
if !errorlevel! neq 0 (
    echo [ERROR] Unknown operation: %operation%
    goto :cleanup
)

:merge_object
REM Usage: jq-patch.bat merge_object input.json output.json object_key source.json
set "object_key=%~4"
set "source_file=%~5"

if "%object_key%"=="" goto :usage
if "%source_file%"=="" goto :usage
if not exist "%source_file%" (
    echo [ERROR] Source file not found: %source_file%
    exit /b 1
)

REM Read source object and merge
jq ".[^\"%object_key%^\"] = (input | .[^\"%object_key%^\"])" "%input_file%" "%source_file%" > "%output_file%.tmp"
if !errorlevel! equ 0 (
    move "%output_file%.tmp" "%output_file%" >nul
    echo [INFO] Successfully merged %object_key% from %source_file%
) else (
    echo [ERROR] Failed to merge objects
    del "%output_file%.tmp" 2>nul
    exit /b 1
)
goto :cleanup

:extract_field
REM Usage: jq-patch.bat extract_field input.json output.json field_path
set "field_path=%~4"

if "%field_path%"=="" goto :usage

jq "%field_path%" "%input_file%" > "%output_file%.tmp"
if !errorlevel! equ 0 (
    move "%output_file%.tmp" "%output_file%" >nul
    echo [INFO] Successfully extracted field
) else (
    echo [ERROR] Failed to extract field
    del "%output_file%.tmp" 2>nul
    exit /b 1
)
goto :cleanup

:transform_opencode
REM Usage: jq-patch.bat transform_opencode input.json output.json
set "transform_script=%temp_dir%\transform.jq"

(
    echo to_entries ^| map^(
    echo   .value as $server ^| .key as $name ^|
    echo   ^{
    echo     key: $name,
    echo     value: ^(
    echo       if $server.type == "http" then
    echo         ^{
    echo           type: "remote",
    echo           url: $server.url,
    echo           enabled: true
    echo         ^}
    echo       else
    echo         ^{
    echo           type: "local",
    echo           command: ^([$server.command] + ^($server.args // []^)^),
    echo           enabled: true
    echo         ^} + ^(
    echo           if $server.env then
    echo             ^{environment: $server.env^}
    echo           else
    echo             ^{^}
    echo           end
    echo         ^)
    echo       end
    echo     ^)
    echo   ^}
    echo ^) ^| from_entries
) > "%transform_script%"

jq -f "%transform_script%" "%input_file%" > "%output_file%.tmp"
if !errorlevel! equ 0 (
    move "%output_file%.tmp" "%output_file%" >nul
    echo [INFO] Successfully transformed to OpenCode format
) else (
    echo [ERROR] Failed to transform
    del "%output_file%.tmp" 2>nul
    exit /b 1
)
goto :cleanup

:set_field
REM Usage: jq-patch.bat set_field input.json output.json field_path value_file
set "field_path=%~4"
set "value_file=%~5"

if "%field_path%"=="" goto :usage
if "%value_file%"=="" goto :usage
if not exist "%value_file%" (
    echo [ERROR] Value file not found: %value_file%
    exit /b 1
)

jq --slurpfile value "%value_file%" "%field_path% = $value[0]" "%input_file%" > "%output_file%.tmp"
if !errorlevel! equ 0 (
    move "%output_file%.tmp" "%output_file%" >nul
    echo [INFO] Successfully set field
) else (
    echo [ERROR] Failed to set field
    del "%output_file%.tmp" 2>nul
    exit /b 1
)
goto :cleanup

:cleanup
rmdir /s /q "%temp_dir%" 2>nul
goto :eof

:usage
echo Usage: %~nx0 ^<operation^> ^<input_file^> ^<output_file^> [additional_args...]
echo.
echo Operations:
echo   merge_object    input.json output.json object_key source.json
echo   extract_field   input.json output.json field_path
echo   transform_opencode input.json output.json
echo   set_field       input.json output.json field_path value_file
echo.
echo Examples:
echo   %~nx0 extract_field mcp.json servers.json ".mcpServers"
echo   %~nx0 merge_object config.json new_config.json "mcpServers" servers.json
echo   %~nx0 transform_opencode servers.json opencode_servers.json
exit /b 1