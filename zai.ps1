function zai {
  param()

  if ($args.Count -eq 0) {
    Write-Host "Usage: zai <command> [arguments...]" -ForegroundColor Yellow
    return
  }

  # Set environment variables
  $env:ANTHROPIC_AUTH_TOKEN = 'your_api_key'
  $env:ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic'
  $env:ANTHROPIC_MODEL = 'glm-4.6'
  $env:ANTHROPIC_DEFAULT_OPUS_MODEL = 'glm-4.6'
  $env:ANTHROPIC_DEFAULT_SONNET_MODEL = 'glm-4.6'
  $env:ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-4.5-air'
  $env:ANTHROPIC_SMALL_FAST_MODEL = 'glm-4.5-air'
  $env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = 1
  $env:API_TIMEOUT_MS = 3000000
  Remove-Item Env:\CLAUDE_CODE_MAX_OUTPUT_TOKENS -ErrorAction SilentlyContinue

  try {
    # Build the command and arguments
    $command = $args[0]
    if ($args.Length -gt 1) {
      $commandArgs = $args[1..($args.Length - 1)]
      # Execute with splatting for proper flag handling
      & $command @commandArgs
    }
    else {
      # Execute command without arguments
      & $command
    }
  }
  finally {
    # Clean up
    Remove-Item Env:\ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\ANTHROPIC_MODEL -ErrorAction SilentlyContinue
    Remove-Item Env:\ANTHROPIC_DEFAULT_OPUS_MODEL -ErrorAction SilentlyContinue
    Remove-Item Env:\ANTHROPIC_DEFAULT_SONNET_MODEL -ErrorAction SilentlyContinue
    Remove-Item Env:\ANTHROPIC_DEFAULT_HAIKU_MODEL -ErrorAction SilentlyContinue
    Remove-Item Env:\ANTHROPIC_SMALL_FAST_MODEL -ErrorAction SilentlyContinue
    Remove-Item Env:\CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC -ErrorAction SilentlyContinue
    Remove-Item Env:\API_TIMEOUT_MS -ErrorAction SilentlyContinue
  }
}
