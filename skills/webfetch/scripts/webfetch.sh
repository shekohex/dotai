#!/bin/bash

set -e

usage() {
    cat << 'EOF'
Usage: webfetch <url> [options]

Fetch any web page and convert it to clean Markdown using markdown.new.

Options:
    -m, --method <auto|ai|browser>  Conversion method (default: auto)
    -i, --images                    Retain images in output
    -o, --output <file>             Write to file instead of stdout
    -j, --json                      Output full JSON response
    -t, --tokens                    Show token count
    -r, --rate-limit                Show rate limit remaining
    -h, --help                      Show this help

Methods:
    auto    Try fastest method first, fallback automatically (default)
    ai      Use Workers AI (good for static HTML)
    browser Use headless browser (for JS-heavy pages)

Examples:
    webfetch https://example.com
    webfetch https://example.com -m browser -i
    webfetch https://example.com -o output.md -t
EOF
    exit 0
}

url=""
method="auto"
retain_images="false"
output=""
json_output=false
show_tokens=false
show_rate_limit=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -m|--method)
            method="$2"
            shift 2
            ;;
        -i|--images)
            retain_images="true"
            shift
            ;;
        -o|--output)
            output="$2"
            shift 2
            ;;
        -j|--json)
            json_output=true
            shift
            ;;
        -t|--tokens)
            show_tokens=true
            shift
            ;;
        -r|--rate-limit)
            show_rate_limit=true
            shift
            ;;
        -h|--help)
            usage
            ;;
        -*)
            echo "Unknown option: $1" >&2
            echo "Use -h for help" >&2
            exit 1
            ;;
        *)
            if [[ -z "$url" ]]; then
                url="$1"
            else
                echo "Unexpected argument: $1" >&2
                exit 1
            fi
            shift
            ;;
    esac
done

if [[ -z "$url" ]]; then
    echo "Error: URL required" >&2
    usage
fi

headers_file=$(mktemp)
trap "rm -f $headers_file" EXIT

response=$(curl -s -D "$headers_file" \
    -H "Content-Type: application/json" \
    -d "{\"url\": \"$url\", \"method\": \"$method\", \"retain_images\": $retain_images}" \
    "https://markdown.new/")

if [[ "$json_output" == true ]]; then
    if [[ -n "$output" ]]; then
        echo "$response" > "$output"
    else
        echo "$response"
    fi
else
    content=$(echo "$response" | jq -r '.content // .')
    if [[ -n "$output" ]]; then
        echo "$content" > "$output"
    else
        echo "$content"
    fi
fi

if [[ "$show_tokens" == true ]]; then
    tokens=$(echo "$response" | jq -r '.tokens // empty')
    [[ -n "$tokens" && "$tokens" != "null" ]] && echo "Tokens: $tokens" >&2
fi

if [[ "$show_rate_limit" == true ]]; then
    remaining=$(grep -i "x-rate-limit-remaining" "$headers_file" | awk '{print $2}' | tr -d '\r')
    [[ -n "$remaining" ]] && echo "Rate limit remaining: $remaining" >&2
fi
