# Windows Compatibility Guide

This guide addresses jq command compatibility issues and path resolution problems on Windows.

## Issues Addressed

### 1. jq Command Syntax Issues
- Complex jq expressions with escaping problems in Windows batch files
- Command line length limitations when passing JSON data
- Proper handling of special characters and quotes

### 2. Home Directory Path Resolution
- Windows uses `%USERPROFILE%` instead of Unix `$HOME`
- The `~` symbol doesn't expand automatically in Windows batch files
- Path separators differ between Windows (`\`) and Unix (`/`)

## Solutions Implemented

### 1. Cross-Platform jq Utility (`jq-patch.bat` / `jq-patch.sh`)

A wrapper utility that provides consistent jq operations across platforms:

```batch
REM Windows usage
jq-patch.bat extract_field mcp.json servers.json ".mcpServers"
jq-patch.bat transform_opencode servers.json opencode_servers.json
jq-patch.bat set_field config.json new_config.json ".mcpServers" servers.json
```

```bash
# Unix/Linux/macOS usage
./jq-patch.sh extract_field mcp.json servers.json ".mcpServers"
./jq-patch.sh transform_opencode servers.json opencode_servers.json
./jq-patch.sh set_field config.json new_config.json ".mcpServers" servers.json
```

**Key Features:**
- Uses temporary files instead of command-line arguments to avoid escaping issues
- Proper error handling and validation
- Windows-specific character escaping in jq filter files
- Consistent interface across platforms

### 2. Cross-Platform Path Utilities (`path-utils.bat` / `path-utils.sh`)

Utilities for handling path resolution and expansion:

```batch
REM Windows examples
path-utils.bat get_home_dir
path-utils.bat expand_path "~\.config\opencode"
path-utils.bat join_paths "%USERPROFILE%" ".config" "opencode"
```

```bash
# Unix examples
./path-utils.sh get_home_dir
./path-utils.sh expand_path "~/.config/opencode"
./path-utils.sh join_paths "$HOME" ".config" "opencode"
```

**Operations Available:**
- `get_home_dir` - Returns user's home directory
- `get_config_dir` - Returns user's config directory (Windows: `%APPDATA%`, Unix: `~/.config`)
- `expand_path` - Expands `~` and environment variables
- `normalize_path` - Normalizes path separators for the platform
- `join_paths` - Safely joins multiple path components

### 3. Updated sync-mcp.bat

The Windows batch script now uses the new utilities:

**Before (problematic):**
```batch
for /f "delims=" %%i in ('jq ".mcpServers" "%MCP_JSON%"') do set "mcp_servers=%%i"
jq --argjson mcp "!mcp_servers!" ".mcp = $mcp" "%opencode_config%" > "%opencode_config%.tmp"
```

**After (Windows-compatible):**
```batch
set "temp_mcp=%TEMP%\mcp_servers_%RANDOM%.json"
set "temp_opencode=%TEMP%\opencode_mcp_%RANDOM%.json"
call "%SCRIPT_DIR%jq-patch.bat" extract_field "%MCP_JSON%" "%temp_mcp%" ".mcpServers"
call "%SCRIPT_DIR%jq-patch.bat" transform_opencode "%temp_mcp%" "%temp_opencode%"
call "%SCRIPT_DIR%jq-patch.bat" set_field "%opencode_config%" "%opencode_config%.tmp" ".mcp" "%temp_opencode%"
```

## Usage Examples

### Basic JSON Operations

```batch
REM Extract a field from JSON
jq-patch.bat extract_field config.json extracted.json ".database.host"

REM Set a field in JSON
echo "new_value"> value.json
jq-patch.bat set_field config.json updated_config.json ".database.host" value.json

REM Transform MCP servers to OpenCode format
jq-patch.bat transform_opencode mcp_servers.json opencode_format.json
```

### Path Operations

```batch
REM Get standardized paths
for /f %%i in ('path-utils.bat get_home_dir') do set "HOME_DIR=%%i"
for /f %%i in ('path-utils.bat get_config_dir') do set "CONFIG_DIR=%%i"

REM Expand tilde paths
for /f %%i in ('path-utils.bat expand_path "~\.config\opencode\opencode.jsonc"') do set "OPENCODE_CONFIG=%%i"

REM Join paths safely
for /f %%i in ('path-utils.bat join_paths "%USERPROFILE%" ".config" "opencode" "config.json"') do set "OPENCODE_CONFIG=%%i"
```

## Testing the Fixes

### Test jq Operations
```batch
REM Test basic extraction
jq-patch.bat extract_field mcp.json servers.json ".mcpServers"

REM Test transformation
jq-patch.bat transform_opencode servers.json opencode_servers.json

REM Verify the results
type opencode_servers.json
```

### Test Path Operations
```batch
REM Test path expansion
path-utils.bat expand_path "~\.config\opencode"
path-utils.bat expand_path "~/.config/opencode"

REM Test path joining  
path-utils.bat join_paths "%USERPROFILE%" ".config" "opencode" "opencode.jsonc"
```

### Test Full MCP Sync
```batch
REM Run the Windows MCP sync
sync-mcp.bat

REM Check the generated configs
type "%USERPROFILE%\.config\opencode\opencode.jsonc"
```

## Error Handling

The utilities include comprehensive error handling:

1. **Dependency Checks**: Verifies jq is installed and accessible
2. **File Validation**: Ensures input files exist and contain valid JSON
3. **Path Validation**: Checks that paths are valid and accessible
4. **Cleanup**: Removes temporary files even if operations fail

## Platform-Specific Notes

### Windows
- Uses `%TEMP%` for temporary files
- Handles Windows path separators (`\`)
- Uses `%USERPROFILE%` instead of `$HOME`
- Escapes special characters properly in batch files

### Unix/Linux/macOS
- Uses `/tmp` for temporary files (via `mktemp`)
- Handles Unix path separators (`/`)
- Supports XDG Base Directory specification
- Uses standard shell variable expansion

## Troubleshooting

### Common Issues

1. **jq not found**
   ```
   [ERROR] jq is required but not installed
   Please install jq from: https://stedolan.github.io/jq/download/
   ```
   **Solution**: Install jq and ensure it's in your PATH

2. **Invalid JSON**
   ```
   [ERROR] Invalid JSON in mcp.json
   ```
   **Solution**: Validate your JSON file using `jq empty filename.json`

3. **File not found**
   ```
   [ERROR] Source file not found: config.json
   ```
   **Solution**: Ensure the file path is correct and the file exists

### Debug Mode

Enable verbose output by setting environment variables:

```batch
REM Windows
set "DEBUG=1"
sync-mcp.bat
```

```bash
# Unix
DEBUG=1 ./sync-mcp.sh
```

This will show detailed information about each operation performed.
