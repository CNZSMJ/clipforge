# Fal input contract snapshots

`fal-input-contracts.json` contains dereferenced input schemas retrieved from Fal's public OpenAPI endpoint on **2026-09-17**:

`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<URL-encoded-endpoint-id>`

Each top-level key is the exact endpoint ID. The fixture includes 20 video inputs, 13 image inputs and the OpenRouter router input. `fal-contracts.test.ts` validates the known video/image request builders against these snapshots, including required fields, enums, scalar types, array limits and relevant size constraints. It does **not** make paid inference calls, prove account entitlement, validate every optional field of arbitrary custom models, or certify visual quality.

When a curated endpoint changes, retrieve its current public OpenAPI document, resolve local `$ref` values from `components/schemas`, update the corresponding request contract and fixture together, and review a live sample with an authorized test account. Do not delete a failing contract assertion merely to accept a payload that the remote service rejects.
