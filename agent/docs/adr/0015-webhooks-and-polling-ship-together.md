# Webhooks and polling ship together

Pi Conductor v1 will include both a GitHub webhook receiver and a periodic reconciliation loop. Webhooks provide fast triggers, while polling fetches current GitHub truth and recovers missed, duplicate, delayed, or out-of-order deliveries.
