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
GET /v1/streams/app-events
GET /v1/streams/sessions/:sessionId/events
```
