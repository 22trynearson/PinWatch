# PinWatch

Monitors Pink a la Mode for:
- queue / waiting-room activation
- newly added products in the New Arrivals collection

## Environment variables

- `SITE_URL` (optional)
- `COLLECTION_URL` (optional)
- `PRODUCTS_JSON` (optional)
- `POLL_MS` (optional, minimum 10000)
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM`
- `ALERT_TO`

The service can run before Twilio is configured; alerts are logged until Twilio variables are added.
