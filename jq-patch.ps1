# jq-patch.ps1
param(
    [string]$Operation,
    [string]$InputFile,
    [string]$OutputFile,
    [string]$Arg1,
    [string]$Arg2
)

$ErrorActionPreference = "Stop"

# Check if jq is available
if (-not (Get-Command "jq" -ErrorAction SilentlyContinue)) {
    Write-Error "[ERROR] jq is required but not installed"
    Write-Host "Please install jq from: https://stedolan.github.io/jq/download/"
    exit 1
}

# Validate input file exists
if (-not (Test-Path -LiteralPath $InputFile)) {
    Write-Error "[ERROR] Input file not found: $InputFile"
    exit 1
}

# Validate JSON
jq empty "$InputFile" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Error "[ERROR] Invalid JSON in $InputFile"
    exit 1
}

# Create temporary directory logic
$TempDir = [System.IO.Path]::GetTempPath()
$TransformScript = Join-Path $TempDir ("transform_" + [System.Guid]::NewGuid().ToString() + ".jq")

try {
    switch ($Operation) {
        "merge_object" {
            # Usage: ./jq-patch.ps1 merge_object input.json output.json object_key source.json
            $ObjectKey = $Arg1
            $SourceFile = $Arg2

            if (-not $ObjectKey -or -not $SourceFile) { throw "Missing arguments for merge_object" }
            if (-not (Test-Path -LiteralPath $SourceFile)) { throw "Source file not found: $SourceFile" }

            # Read source object and merge
            # Uses slurpfile to safely handle the merge
            jq --slurpfile source "$SourceFile" ".[\`"$ObjectKey\`"] = `$source[0][\`"$ObjectKey\`"]" "$InputFile" | Out-File -FilePath $OutputFile -Encoding utf8
            Write-Host "[INFO] Successfully merged $ObjectKey from $SourceFile"
        }

        "extract_field" {
            # Usage: ./jq-patch.ps1 extract_field input.json output.json field_path
            $FieldPath = $Arg1
            if (-not $FieldPath) { throw "Missing argument for extract_field" }

            jq "$FieldPath" "$InputFile" | Out-File -FilePath $OutputFile -Encoding utf8
            Write-Host "[INFO] Successfully extracted $FieldPath"
        }

        "transform_opencode" {
            # Usage: ./jq-patch.ps1 transform_opencode input.json output.json
            
            # We use a Here-String for the complex JQ filter
            # Note: escaped backticks for PowerShell variables inside the string
            $JqFilter = @"
to_entries | map(
    .value as `$server | .key as `$name |
    {
        key: `$name,
        value: (
            if `$server.type == "http" then
                {
                    type: "remote",
                    url: `$server.url,
                    enabled: true
                }
            else
                {
                    type: "local",
                    command: (([`$server.command] + (`$server.args // []))),
                    enabled: true
                } + (
                    if `$server.env then
                        {environment: `$server.env}
                    else
                        {}
                    end
                )
            end
        )
    }
) | from_entries
"@
            Set-Content -Path $TransformScript -Value $JqFilter -Encoding UTF8
            jq -f "$TransformScript" "$InputFile" | Out-File -FilePath $OutputFile -Encoding utf8
            
            # Clean up temp file
            if (Test-Path $TransformScript) { Remove-Item $TransformScript }
            
            Write-Host "[INFO] Successfully transformed to OpenCode format"
        }

        "set_field" {
            # Usage: ./jq-patch.ps1 set_field input.json output.json field_path value_file
            $FieldPath = $Arg1
            $ValueFile = $Arg2
            
            if (-not $FieldPath -or -not $ValueFile) { throw "Missing arguments for set_field" }
            if (-not (Test-Path -LiteralPath $ValueFile)) { throw "Value file not found: $ValueFile" }

            jq --slurpfile value "$ValueFile" "$FieldPath = `$value[0]" "$InputFile" | Out-File -FilePath $OutputFile -Encoding utf8
            Write-Host "[INFO] Successfully set $FieldPath"
        }

        Default {
            Write-Error "[ERROR] Unknown operation: $Operation"
            Write-Host "Usage: ./jq-patch.ps1 <operation> <input_file> <output_file> [args...]"
            exit 1
        }
    }
}
catch {
    Write-Error "[ERROR] Operation failed: $_"
    exit 1
}
