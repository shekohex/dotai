# Android Glance Integration Handoff

## Purpose

Glance lets Android upload image attachments to the active Coder workspace, receive workspace-local file paths, append those paths to the chat prompt, and send normal text to the terminal. The agent then uses its existing `read` tool to inspect the saved files.

## Endpoint

Default port:

```text
39273
```

Upload endpoint:

```text
POST <glance-base-url>/upload
```

Config endpoint:

```text
GET <glance-base-url>/config
```

Health endpoint:

```text
GET <glance-base-url>/health
```

Delete uploaded image:

```text
DELETE <imageUrl returned by /upload>
```

## Base URL

In Coder, build the app URL for port `39273` using the same convention as other Coder port apps:

```text
https://39273--<agent-name>--<workspace-name>--<owner-name>.<coder-wildcard-host>/
```

If Android already has Coder agent app metadata for port `39273`, prefer that app URL. Otherwise derive it from workspace owner, workspace name, agent name, and Coder wildcard/base URL.

Local fallback for manual testing:

```text
http://127.0.0.1:39273/
```

## Auth

No Glance-specific token exists.

For Coder app URLs, send existing Coder session token header:

```text
Coder-Session-Token: <coder session token>
```

Do not log this token.

## Upload Request

Request:

```http
POST /upload HTTP/1.1
Content-Type: image/png
X-File-Name: screenshot.png
Coder-Session-Token: <token>

<raw image bytes>
```

Supported MIME types:

```json
["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]
```

Limits:

- Max upload size defaults to `10485760` bytes.
- Empty bodies return `400`.
- Unsupported MIME returns `415`.
- Oversize upload returns `413`.

## Upload Response

Success response:

```json
{
  "ok": true,
  "id": "2d03a82e-7c50-4d20-b0fa-083f3a8833d2",
  "imageUrl": "https://39273--agent--workspace--owner.coder.example/i/2d03a82e-7c50-4d20-b0fa-083f3a8833d2.png",
  "path": "/home/coder/.pi/agent/runtime/glance/storage/2d03a82e-7c50-4d20-b0fa-083f3a8833d2.png",
  "size": 12345,
  "mimeType": "image/png",
  "extension": "png",
  "originalName": "screenshot.png",
  "createdAt": "2026-05-19T00:00:00.000Z",
  "expiresAt": "2026-05-19T00:30:00.000Z"
}
```

Use `path` for prompt injection.

Use `imageUrl` only if Android needs to delete the uploaded image later.

Error response:

```json
{
  "ok": false,
  "error": "unsupported image type"
}
```

## Config Response

```json
{
  "ok": true,
  "maxUploadBytes": 10485760,
  "storageDir": "/home/coder/.pi/agent/runtime/glance/storage",
  "supportedMimeTypes": ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]
}
```

Android can call this once before upload to validate file size and MIME type client-side.

## Health Response

```json
{
  "ok": true,
  "name": "pi-glance",
  "schemaVersion": 1,
  "pid": 12345,
  "port": 39273,
  "startedAt": 1710000000000
}
```

Treat any non-`200`, non-JSON, wrong `name`, or wrong `schemaVersion` as unavailable Glance.

## Prompt Flow

When user submits chat with image attachments:

1. Resolve each Android URI via `ContentResolver`.
2. Determine MIME type and display filename when available.
3. Validate MIME type is supported.
4. Validate size is below `maxUploadBytes` if size is known.
5. Upload raw bytes to `POST /upload` with `Content-Type`, optional `X-File-Name`, and `Coder-Session-Token`.
6. Collect `path` from each successful response.
7. Append paths to prompt text.
8. Send final text through existing `terminalView.sendText(...)`.
9. Clear attachments only after upload and send both succeed.

Prompt suffix:

```text

Attached images saved in workspace:
- /home/coder/.pi/agent/runtime/glance/storage/abc123.png
- /home/coder/.pi/agent/runtime/glance/storage/def456.jpg

Read these image files if relevant.
```

## Delete Flow

If Android needs to clean up a specific uploaded image, call:

```http
DELETE <imageUrl>
Coder-Session-Token: <token>
```

Responses:

```json
{ "ok": true }
```

or:

```json
{ "ok": false }
```

There is no public bulk clean endpoint. Bulk cleanup is local to the agent command `/glance clean`.

## Error Handling

Recommended user-facing behavior:

- Health/config unreachable: show “Image upload service unavailable”. Keep attachments selected.
- `400`: show “Selected image is empty or unreadable”.
- `413`: show “Image too large”.
- `415`: show “Unsupported image type”.
- Network/Coder auth failure: show “Could not upload image to workspace”.
- Partial multi-image failure: do not send prompt unless user confirms sending only successful uploads.

## Agent Lifecycle Notes

- Glance daemon starts automatically while at least one `pi` process heartbeat is alive in Coder.
- Daemon exits after all heartbeats expire.
- Uploads are stored under the agent runtime directory, normally `~/.pi/agent/runtime/glance/storage`.
- Files expire by daemon TTL cleanup, default `30m`.
- Android does not need to know about `pi` sessions, tmux panes, or daemon clients.
