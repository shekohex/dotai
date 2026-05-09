#!/usr/bin/env pwsh

$ErrorActionPreference = 'Stop'

$PackageScope = '@shekohex'
$PackageName = '@shekohex/agent'
$RegistryUrl = 'https://npm.pkg.github.com'
$RawPackageEndpoint = 'https://npm.pkg.github.com/@shekohex%2fagent'
$GitHubApiUrl = 'https://api.github.com/'

$packageManager = 'npm'
$packageVersion = ''
$tokenSource = ''
$tokenValue = ''
$defaultPackageVersion = ''
$verboseMode = $false

function Fail {
  param([string]$Message)

  Write-Error $Message
  exit 1
}

function Note {
  param([string]$Message)

  [Console]::Error.WriteLine($Message)
}

function Show-Usage {
  [Console]::Error.WriteLine(@'
Usage: install-github-package.ps1 [-Npm|-Pnpm|-Bun|-Yarn] [-Version VERSION] [-VerboseMode]

Environment overrides:
- PI_PACKAGE_MANAGER: npm | pnpm | bun | yarn
- PI_PACKAGE_VERSION: package version
- PI_VERBOSE: 1 | true

Auth lookup order:
1. NODE_AUTH_TOKEN
2. NPM_TOKEN
3. GH_TOKEN
4. GITHUB_TOKEN
5. gh auth token

Examples:
  $env:PI_PACKAGE_MANAGER='npm'; irm https://raw.githubusercontent.com/shekohex/dotai/main/agent/scripts/install-github-package.ps1 | iex
  $env:PI_PACKAGE_MANAGER='bun'; $env:PI_PACKAGE_VERSION='0.72.1-dev.abcdef0'; irm https://raw.githubusercontent.com/shekohex/dotai/main/agent/scripts/install-github-package.ps1 | iex
  ./install-github-package.ps1 -Bun -VerboseMode
'@)
  exit 1
}

function Parse-Args {
  param([string[]]$Arguments)

  if (-not [string]::IsNullOrWhiteSpace($env:PI_PACKAGE_MANAGER)) {
    $script:packageManager = $env:PI_PACKAGE_MANAGER.Trim().ToLowerInvariant()
  }

  if (-not [string]::IsNullOrWhiteSpace($env:PI_PACKAGE_VERSION)) {
    $script:packageVersion = $env:PI_PACKAGE_VERSION.Trim()
  }

  if (-not [string]::IsNullOrWhiteSpace($env:PI_VERBOSE)) {
    $script:verboseMode = @('1', 'true') -contains $env:PI_VERBOSE.Trim().ToLowerInvariant()
  }

  $index = 0
  while ($index -lt $Arguments.Length) {
    $argument = $Arguments[$index]
    switch ($argument) {
      '--npm' { $script:packageManager = 'npm' }
      '-Npm' { $script:packageManager = 'npm' }
      '--pnpm' { $script:packageManager = 'pnpm' }
      '-Pnpm' { $script:packageManager = 'pnpm' }
      '--bun' { $script:packageManager = 'bun' }
      '-Bun' { $script:packageManager = 'bun' }
      '--yarn' { $script:packageManager = 'yarn' }
      '-Yarn' { $script:packageManager = 'yarn' }
      '--version' {
        if ($index + 1 -ge $Arguments.Length) {
          Fail '--version requires value'
        }
        $script:packageVersion = $Arguments[$index + 1]
        $index += 1
      }
      '-Version' {
        if ($index + 1 -ge $Arguments.Length) {
          Fail '-Version requires value'
        }
        $script:packageVersion = $Arguments[$index + 1]
        $index += 1
      }
      '--verbose' { $script:verboseMode = $true }
      '-VerboseMode' { $script:verboseMode = $true }
      '--help' { Show-Usage }
      '-h' { Show-Usage }
      '-Help' { Show-Usage }
      default { Fail "unknown argument: $argument" }
    }
    $index += 1
  }

  if ($script:packageManager -notin @('npm', 'pnpm', 'bun', 'yarn')) {
    Fail "unsupported package manager: $script:packageManager"
  }
}

function Require-Command {
  param([string]$CommandName)

  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    Fail "missing required command: $CommandName"
  }
}

function Get-CommandPath {
  param([string]$CommandName)

  $command = Get-Command $CommandName -ErrorAction SilentlyContinue
  if (-not $command) {
    Fail "missing required command: $CommandName"
  }

  return $command.Source
}

function Resolve-AuthToken {
  $candidates = @(
    @{ Name = 'NODE_AUTH_TOKEN'; Value = $env:NODE_AUTH_TOKEN },
    @{ Name = 'NPM_TOKEN'; Value = $env:NPM_TOKEN },
    @{ Name = 'GH_TOKEN'; Value = $env:GH_TOKEN },
    @{ Name = 'GITHUB_TOKEN'; Value = $env:GITHUB_TOKEN }
  )

  foreach ($candidate in $candidates) {
    if (-not [string]::IsNullOrWhiteSpace($candidate.Value)) {
      $script:tokenSource = $candidate.Name
      $script:tokenValue = $candidate.Value
      return
    }
  }

  if (Get-Command gh -ErrorAction SilentlyContinue) {
    $token = & gh auth token 2>$null
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($token)) {
      $script:tokenSource = 'gh auth token'
      $script:tokenValue = $token.Trim()
      return
    }
  }

  Fail 'no GitHub token found. Set NODE_AUTH_TOKEN, NPM_TOKEN, GH_TOKEN, or GITHUB_TOKEN, or run `gh auth login` then `gh auth refresh -s read:packages`.'
}

function Invoke-WebRequestWithAuth {
  param(
    [string]$Method,
    [string]$Uri,
    [string]$Accept
  )

  $headers = @{
    Authorization = "Bearer $script:tokenValue"
    Accept = $Accept
  }

  $parameters = @{
    Method = $Method
    Uri = $Uri
    Headers = $headers
  }

  if ($script:verboseMode) {
    $parameters['Verbose'] = $true
  }

  Invoke-WebRequest @parameters
}

function Get-TokenScopes {
  Require-Command 'pwsh'

  try {
    $response = Invoke-WebRequestWithAuth -Method 'Head' -Uri $GitHubApiUrl -Accept 'application/vnd.github+json'
    return $response.Headers['X-OAuth-Scopes']
  }
  catch {
    return ''
  }
}

function Fetch-RegistryMetadata {
  $response = Invoke-WebRequestWithAuth -Method 'Get' -Uri $RawPackageEndpoint -Accept 'application/vnd.npm.install-v1+json'
  return $response.Content
}

function Registry-PreviewTagMatchesDefaultVersion {
  param([string]$Metadata)

  return $Metadata -match ('"preview"\s*:\s*"' + [regex]::Escape($script:defaultPackageVersion) + '"')
}

function Verify-PackageAccess {
  try {
    $null = Invoke-WebRequestWithAuth -Method 'Get' -Uri $RawPackageEndpoint -Accept 'application/vnd.npm.install-v1+json'
    return
  }
  catch {
    $statusCode = ''
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      $statusCode = [int]$_.Exception.Response.StatusCode
    }

    $scopes = Get-TokenScopes
    if (-not [string]::IsNullOrWhiteSpace($scopes)) {
      $scopeList = $scopes.Split(',') | ForEach-Object { $_.Trim() }
      if (-not ($scopeList -contains 'read:packages')) {
        Fail "token from $script:tokenSource missing read:packages scope. Run: gh auth refresh -s read:packages"
      }
    }

    Fail "GitHub Packages auth failed with $script:tokenSource (HTTP $statusCode). Ensure token can read public packages from $RegistryUrl and includes read:packages."
  }
}

function Get-PackageSpec {
  if (-not [string]::IsNullOrWhiteSpace($script:packageVersion)) {
    return "${PackageName}@$script:packageVersion"
  }

  if (-not [string]::IsNullOrWhiteSpace($script:defaultPackageVersion)) {
    if ($script:packageManager -eq 'bun') {
      $metadata = Fetch-RegistryMetadata
      if (Registry-PreviewTagMatchesDefaultVersion -Metadata $metadata) {
        return "${PackageName}@preview"
      }
    }

    return "${PackageName}@$script:defaultPackageVersion"
  }

  return $PackageName
}

function New-TempDirectory {
  $directoryPath = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
  $null = New-Item -ItemType Directory -Path $directoryPath
  return $directoryPath
}

function Write-Npmrc {
  param([string]$DirectoryPath)

  $content = @(
    "${PackageScope}:registry=$RegistryUrl"
    "//npm.pkg.github.com/:_authToken=$script:tokenValue"
  )

  Set-Content -Path (Join-Path $DirectoryPath '.npmrc') -Value $content
}

function Install-WithNpm {
  $npmCommand = Get-CommandPath 'npm'
  $tempDirectory = New-TempDirectory
  try {
    $packageReference = Get-PackageSpec
    Write-Npmrc -DirectoryPath $tempDirectory
    $npmArguments = @('install', '--global', $packageReference, '--userconfig', (Join-Path $tempDirectory '.npmrc'))
    & $npmCommand @npmArguments
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
  }
  finally {
    Remove-Item -Path $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Install-WithPnpm {
  $pnpmCommand = Get-CommandPath 'pnpm'
  $tempDirectory = New-TempDirectory
  try {
    $packageReference = Get-PackageSpec
    Write-Npmrc -DirectoryPath $tempDirectory
    $env:NPM_CONFIG_USERCONFIG = Join-Path $tempDirectory '.npmrc'
    $pnpmArguments = @('add', '--global', $packageReference)
    & $pnpmCommand @pnpmArguments
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
  }
  finally {
    Remove-Item Env:NPM_CONFIG_USERCONFIG -ErrorAction SilentlyContinue
    Remove-Item -Path $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Install-WithBun {
  $bunCommand = Get-CommandPath 'bun'
  $tempDirectory = New-TempDirectory
  try {
    $packageReference = Get-PackageSpec
    Write-Npmrc -DirectoryPath $tempDirectory
    $env:XDG_CONFIG_HOME = $tempDirectory
    $bunArguments = @('add', '--global', $packageReference)
    & $bunCommand @bunArguments
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
  }
  finally {
    Remove-Item Env:XDG_CONFIG_HOME -ErrorAction SilentlyContinue
    Remove-Item -Path $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Install-WithYarn {
  $yarnCommand = Get-CommandPath 'yarn'
  $tempDirectory = New-TempDirectory
  try {
    $packageReference = Get-PackageSpec
    Write-Npmrc -DirectoryPath $tempDirectory
    $yarnArguments = @('global', 'add', $packageReference, '--userconfig', (Join-Path $tempDirectory '.npmrc'))
    & $yarnCommand @yarnArguments
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
  }
  finally {
    Remove-Item -Path $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Main {
  Parse-Args -Arguments $args
  Resolve-AuthToken
  Verify-PackageAccess
  Note "Using token from $script:tokenSource"

  switch ($script:packageManager) {
    'npm' { Install-WithNpm }
    'pnpm' { Install-WithPnpm }
    'bun' { Install-WithBun }
    'yarn' { Install-WithYarn }
  }
}

Main
