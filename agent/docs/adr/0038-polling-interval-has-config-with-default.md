# Polling interval has config with default

`pi conductor serve` will read the polling interval from global conductor configuration and fall back to 60 seconds when omitted. This keeps the daemon usable with minimal config while allowing operators to tune reconciliation cadence.
