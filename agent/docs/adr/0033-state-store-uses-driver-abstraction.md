# State store uses a driver abstraction

Pi Conductor will define its state store behind a small driver abstraction instead of binding orchestration code directly to a specific SQLite API. The first drivers are a durable `node:sqlite` implementation and an in-memory implementation for tests; orchestration code talks only to the store interface.
