# Glance

Tiny temporary image host for screenshots. Images stay in memory, get short links, and expire by TTL.

## Run Locally

```sh
npm install
npm start
```

Open `http://127.0.0.1:3000`.

## Configuration

Environment variables:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `HOST` | `127.0.0.1` | Listen host. Docker sets `0.0.0.0`. |
| `PORT` | `3000` | Listen port. |
| `PUBLIC_URL` | request origin | Public base URL shown in UI and returned by API. Example: `https://glance.example.com`. |
| `GLANCE_TTL_MS` | `1800000` | Image TTL in milliseconds. |
| `GLANCE_MAX_UPLOAD_BYTES` | `10485760` | Max image upload size. |
| `GLANCE_SWEEP_INTERVAL_MS` | `30000` | Expired-image sweep interval. |
| `GLANCE_MAX_IMAGES` | `256` | In-memory LRU capacity. |
| `GLANCE_STORAGE_DIR` | `/dev/shm/glance` | Image byte storage directory. Use tmpfs/shm for RAM-backed files. |

## Docker

Build:

```sh
docker build -t glance .
```

Docker Compose:

```sh
docker compose -f compose.yml up --build
```

Optional `.env`:

```sh
GLANCE_PORT=3000
PUBLIC_URL=http://127.0.0.1:3000
GLANCE_TTL_MS=1800000
GLANCE_MAX_UPLOAD_BYTES=10485760
GLANCE_SWEEP_INTERVAL_MS=30000
GLANCE_MAX_IMAGES=256
GLANCE_SHM_SIZE=64m
```

Run:

```sh
docker run --rm \
  -p 3000:3000 \
  -e PUBLIC_URL=http://127.0.0.1:3000 \
  --mount type=tmpfs,destination=/dev/shm/glance,tmpfs-size=64m \
  glance
```

Docker supports env vars with `-e`, normal volumes with `-v`, and tmpfs mounts with `--mount type=tmpfs`.

Glance stores image bytes in `GLANCE_STORAGE_DIR`. Default is `/dev/shm/glance`, which is RAM-backed in Linux containers. Metadata stays in process memory.

If you want Docker's default shared-memory mount instead of an explicit tmpfs mount, increase it with `--shm-size`:

```sh
docker run --rm \
  -p 3000:3000 \
  --shm-size=128m \
  -e PUBLIC_URL=http://127.0.0.1:3000 \
  glance
```

If you want disk-backed storage instead, mount a volume and point `GLANCE_STORAGE_DIR` at it:

```sh
docker run --rm \
  -p 3000:3000 \
  -e GLANCE_STORAGE_DIR=/app/data \
  -v glance-data:/app/data \
  glance
```

## Upload With Curl

Health check:

```sh
curl -i http://127.0.0.1:3000/health
```

Runtime status:

```sh
curl -sS http://127.0.0.1:3000/status
```

Upload raw image bytes. `Content-Type` must be one of `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/avif`.

```sh
curl -sS \
  -H 'Content-Type: image/png' \
  -H 'X-File-Name: screenshot.png' \
  --data-binary @screenshot.png \
  http://127.0.0.1:3000/upload
```

Response:

```json
{
  "id": "abc123",
  "url": "http://127.0.0.1:3000/i/abc123.png",
  "jsonUrl": "http://127.0.0.1:3000/i/abc123.json",
  "size": 12345,
  "mimeType": "image/png",
  "extension": "png",
  "ttlSeconds": 1800
}
```

Download image:

```sh
curl -L 'http://127.0.0.1:3000/i/abc123.png' -o screenshot.png
```

Get JSON metadata:

```sh
curl -sS 'http://127.0.0.1:3000/i/abc123.json'
```

Download once and delete after response:

```sh
curl -L 'http://127.0.0.1:3000/i/abc123.png?action=delete' -o screenshot.png
```

Delete via header while downloading:

```sh
curl -L \
  -H 'X-Glance-Action: delete' \
  'http://127.0.0.1:3000/i/abc123.png' \
  -o screenshot.png
```

## Development

Install deps:

```sh
npm install
```

Run server:

```sh
npm start
```

Run typecheck:

```sh
npm run check
```

Use a local temp storage dir when developing on macOS or when `/dev/shm` is unavailable:

```sh
GLANCE_STORAGE_DIR=/tmp/glance npm start
```

Quick API smoke test:

```sh
printf '\x89PNG\r\n\x1a\n' > /tmp/glance-smoke.png
curl -sS \
  -H 'Content-Type: image/png' \
  --data-binary @/tmp/glance-smoke.png \
  http://127.0.0.1:3000/upload
```

Build Docker image:

```sh
docker build -t glance:dev .
```

Project layout:

| Path | Purpose |
| --- | --- |
| `server.js` | Node HTTP server, upload API, TTL/LRU, shm storage. |
| `public/index.html` | Single-file HTML/CSS/JS UI. |
| `public/favicon.svg` | SVG favicon. |
| `Dockerfile` | Multi-stage image build. |
