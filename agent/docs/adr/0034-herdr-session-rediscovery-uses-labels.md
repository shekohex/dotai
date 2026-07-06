# Herdr session rediscovery uses labels

Pi Conductor will rediscover live Herdr run locations by workspace and tab labels, not by stored pane IDs or filesystem marker scans. Workspace labels use `owner/repo`, and issue tabs use `#<issue> <slug>`. Conductor still stores pane IDs as current live handles, but labels are the recovery key after restart.
