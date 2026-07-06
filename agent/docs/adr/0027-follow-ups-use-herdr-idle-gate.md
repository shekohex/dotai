# Follow-ups do not use a conductor idle gate

Queued follow-ups will not wait for a separate conductor Herdr idle gate when a live Pi pane exists. Conductor sends follow-ups through Pi's own delivery mode (`followUp`/Alt+Enter), letting Pi decide when to deliver queued input after the current turn.
