#!/usr/bin/env python3
"""
Enhanced Claude Code Status Line Script
Provides model-specific colors, token counting, and project display
Cross-platform Python version compatible with both Windows and Unix
"""

import json
import os
import sys
import subprocess
import re
from pathlib import Path

# Color codes
RESET = '\033[0m'
CYAN = '\033[96m'      # Opus
ORANGE = '\033[38;5;208m'  # Sonnet
GREEN = '\033[92m'     # Haiku
WHITE = '\033[97m'     # Unknown
YELLOW = '\033[93m'    # Project name
GRAY = '\033[90m'      # Cached tokens
BLUE = '\033[94m'      # Git branch
BOLD = '\033[1m'

def format_number(num):
    """Format numbers with thousand separators"""
    try:
        if isinstance(num, str) and num.isdigit():
            num = int(num)
        if isinstance(num, int):
            return f"{num:,}"
        return str(num)
    except:
        return str(num)

def get_model_color(model):
    """Get model-specific color based on model name"""
    model_lower = model.lower()
    if 'opus' in model_lower:
        return CYAN
    elif 'sonnet' in model_lower:
        return ORANGE
    elif 'haiku' in model_lower:
        return GREEN
    else:
        return WHITE

def get_project_name(project_dir):
    """Get project name from path"""
    if project_dir and project_dir != "/":
        return Path(project_dir).name
    return "unknown"

def get_git_branch(project_dir):
    """Get git branch for the project"""
    if not project_dir or not os.path.isdir(project_dir):
        return ""
    
    try:
        # Change to project directory and get branch
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            check=True
        )
        return result.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""

def calculate_tokens(transcript_path):
    """Calculate total tokens from transcript"""
    total_tokens = 0
    cached_tokens = 0
    
    if not transcript_path or not os.path.isfile(transcript_path):
        return total_tokens, cached_tokens
    
    try:
        with open(transcript_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Find input tokens
        input_matches = re.findall(r'"input_tokens":\s*(\d+)', content)
        input_tokens = sum(int(match) for match in input_matches)
        
        # Find output tokens
        output_matches = re.findall(r'"output_tokens":\s*(\d+)', content)
        output_tokens = sum(int(match) for match in output_matches)
        
        # Find cached tokens
        cached_creation_matches = re.findall(r'"cache_creation_input_tokens":\s*(\d+)', content)
        cached_read_matches = re.findall(r'"cache_read_input_tokens":\s*(\d+)', content)
        
        cached_tokens = (sum(int(match) for match in cached_creation_matches) + 
                        sum(int(match) for match in cached_read_matches))
        
        total_tokens = input_tokens + output_tokens
        
    except Exception:
        pass  # Return defaults on any error
    
    return total_tokens, cached_tokens

def main():
    """Main execution"""
    try:
        # Read and parse JSON input
        input_data = sys.stdin.read()
        if not input_data.strip():
            print("Error: No input data", file=sys.stderr)
            sys.exit(1)
        
        # Parse JSON
        try:
            data = json.loads(input_data)
        except json.JSONDecodeError:
            print("Error: Invalid JSON input", file=sys.stderr)
            sys.exit(1)
        
        # Extract data with fallbacks
        model_display_name = (
            data.get('model', {}).get('display_name') or 
            data.get('model', {}).get('id') or 
            "Unknown"
        )
        
        project_dir = (
            data.get('workspace', {}).get('project_dir') or
            data.get('workspace', {}).get('current_dir') or
            data.get('cwd') or
            ""
        )
        
        transcript_path = data.get('transcript_path', "")
        
        # Get model-specific color
        model_color = get_model_color(model_display_name)
        
        # Get project name
        project_name = get_project_name(project_dir)
        
        # Get git branch
        git_branch = get_git_branch(project_dir)
        
        # Calculate tokens
        total_tokens, cached_tokens = calculate_tokens(transcript_path)
        
        # Format numbers
        formatted_total = format_number(total_tokens)
        formatted_cached = format_number(cached_tokens)
        
        # Build status line
        status_line = ""
        
        # Model name with color
        status_line += f"{BOLD}{model_color}{model_display_name}{RESET}"
        
        # Separator
        status_line += " | "
        
        # Project name in yellow
        status_line += f"{BOLD}{YELLOW}{project_name}{RESET}"
        
        # Git branch (if available)
        if git_branch:
            status_line += f" | {BLUE}⎇ {git_branch}{RESET}"
        
        # Tokens section
        if total_tokens > 0:
            status_line += f" | 📝 {formatted_total} tk"
            
            # Show cached tokens if available
            if cached_tokens > 0:
                status_line += f" {GRAY}[{formatted_cached}]{RESET}"
        
        # Output the status line
        print(status_line)
        
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()