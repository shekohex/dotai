```
PI_REMOTE_ALLOWED_KEYS='{"dev":"-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"}' npm run remote
```

```
GET /openapi.json
POST /v1/auth/challenge
POST /v1/auth/verify
GET /v1/app/snapshot
POST /v1/sessions
GET /v1/sessions/:sessionId/snapshot
POST /v1/sessions/:sessionId/prompt
POST /v1/sessions/:sessionId/steer
POST /v1/sessions/:sessionId/follow-up
POST /v1/sessions/:sessionId/interrupt
POST /v1/sessions/:sessionId/ui-response
POST /v1/sessions/:sessionId/clear-queue
POST /v1/sessions/:sessionId/model
POST /v1/sessions/:sessionId/rename
POST /v1/sessions/:sessionId/session-name
GET /v1/kv/:scope/:namespace/:key
PUT /v1/kv/:scope/:namespace/:key
DELETE /v1/kv/:scope/:namespace/:key
GET /v1/streams/app-events
GET /v1/streams/sessions/:sessionId/events
```
