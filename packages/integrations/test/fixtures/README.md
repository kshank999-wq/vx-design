# Distributor contract fixtures

These were collected on 17 Nov 2026 with no API keys. Each fixture is labelled with where it came from. Field
names and types match the vendors' machine-readable specs. **No fixture is a response from our own credentials.**

| File | Provenance |
|---|---|
| `nexar-supSearchMpn.json` | Built from the live Nexar GraphQL schema (introspection), with invented values. The query in `src/sourcing/nexar.ts` was checked against the live endpoint: it passed field validation and stopped only at the token check. |
| `nexar-invalid-token.json` | A real response from the live endpoint with no token (`AuthInvalidToken`). |
| `digikey-productdetails.json` | A real ProductDetails response captured by a third party (Yamakaja/partrack, site DE/EUR), trimmed. Its field names match DigiKey's v4 Swagger spec. |
| `digikey-401.json` | A real response from the live endpoint with an invalid client id (ProblemDetails shape). |
| `mouser-partnumber.json` | Based on a real third-party capture (Yamakaja/partrack, German/EUR), rewritten in USD/English. Its field names and types match Mouser's v1 Swagger spec. |
| `mouser-invalid-key.json` | A real response from the live endpoint with an invalid key: HTTP 200 with an `Errors` array. |

When keys are configured, `test/live.test.ts` calls the real APIs and checks the same mappings against live data.
