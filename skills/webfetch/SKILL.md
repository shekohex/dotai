---
name: webfetch
description: Fetch web pages and convert them to clean Markdown using markdown.new. Use when user wants to fetch a URL as markdown, convert HTML to markdown, or extract clean text from websites.
---

# webfetch

Fetch any web page and convert it to clean, AI-ready Markdown.

## Quick start

```bash
webfetch https://example.com
webfetch https://example.com -o output.md
```

## Usage

```
webfetch <url> [options]

Options:
    -m, --method <auto|ai|browser>  Conversion method (default: auto)
    -i, --images                    Retain images in output
    -o, --output <file>             Write to file instead of stdout
    -t, --tokens                    Show token count header
    -r, --rate-limit                Show rate limit remaining
    -h, --help                      Show help
```

## Methods

- **auto** (default) - Try fastest method first, fallback automatically
- **ai** - Use Workers AI (good for static HTML)
- **browser** - Use headless browser (for JS-heavy pages, adds ~1-2s latency)

## Examples

```bash
# Basic fetch
webfetch https://news.ycombinator.com

# JS-heavy site with browser rendering
webfetch https://spa-react-app.com -m browser

# Save to file with metadata
webfetch https://example.com -o article.md -t -r

# Include images
webfetch https://example.com -i
```

## Rate limits

500 requests per day per IP. Check `x-rate-limit-remaining` header with `-r` flag.

## Script location

`<skill-dir>/scripts/webfetch.sh`
