# PR association is branch first

Pi Conductor will associate pull requests to runs by looking for a PR whose head branch matches the conductor branch first, then confirm linked issue metadata when available. This matches the conductor-owned branch model and does not depend on Pi remembering to post a marker comment.
