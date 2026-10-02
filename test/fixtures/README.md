# Test fixtures

`test-cert.pem` / `test-key.pem` are a self-signed certificate and its private key, generated only for the mock
pfSense server used by the unit and integration tests (`CN=pfSense-test`). They protect nothing and are not part of
the npm package. `data.ts` holds API responses modelled on a real pfSense CE 2.8.1 with REST API package v2.10.2,
with all identifiers replaced.
