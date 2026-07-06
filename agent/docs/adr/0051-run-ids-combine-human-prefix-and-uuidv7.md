# Run ids combine human prefix and UUIDv7

Pi Conductor run ids will use `owner__repo__issue__uuidv7`, for example `shekohex__dotai__123__018f...`. The owner/repo/issue prefix keeps CLI output and log paths understandable, while UUIDv7 provides stable uniqueness and time ordering.
