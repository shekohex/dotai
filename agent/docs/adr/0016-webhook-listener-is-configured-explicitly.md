# Webhook listener is configured explicitly

`pi conductor serve` will not choose implicit webhook host, port, path, or secret defaults. Webhook listener settings must come from conductor configuration, which avoids accidentally exposing an HTTP endpoint or accepting unsigned events because of local environment assumptions. The webhook secret is configured as an environment-variable reference or secret-file reference, not as a required raw value in config.
