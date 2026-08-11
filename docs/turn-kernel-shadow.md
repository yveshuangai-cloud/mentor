# Turn Kernel shadow spine

This phase observes the current production paths without changing their answers, memory rules, charging, or delivery.

## Invariants

1. Shadow events are buffered in memory and flushed with one non-awaited database insert after delivery; a write failure never changes the user-visible reply.
2. Raw conversation text remains in `conversations`; `turn_events` stores hashes, sizes, provenance, timing, and measurements.
3. Text, LINE audio, documents/images, WebSocket calls, and LiveKit calls share one event contract and one `turn_id` per turn.

Set `TURN_SHADOW_ENABLED=false` to disable every shadow write immediately.

## Event sequence

- `turn.received`
- `stt.completed` when applicable
- `brain.started`
- `context.compiled`
- `context.ready`
- `llm.request_started` (one or more)
- `llm.first_token` for streaming calls
- `model.completed`
- `tts.first_audio` when applicable
- `turn.delivered` or `turn.failed`

`context.compiled` records each block's hash, character count, estimated tokens, and load time. Provider-reported input/output tokens are recorded on `model.completed`.

The `contextUseEvidence` field is deliberately labeled as a post-hoc proxy. It uses citation hits and surface overlap and must not be interpreted as attention attribution or proof of causal model use.

## Anonymized replay

Run from `packages/backend` while connected to the intended database:

```powershell
$env:REPLAY_ANONYMIZATION_SECRET='<dedicated 32+ character secret>'
npm.cmd run replay:export -- --limit=2000 --per-channel=100 --output=tmp/replays/mantou.jsonl
```

The exporter creates:

- `mantou.jsonl`: balanced anonymized replay rows.
- `mantou.cross-channel.jsonl`: only pseudonymous actors present in at least two channels.
- `mantou.jsonl.manifest.json`: counts and SHA-256 audit information.

Exact timestamps, database identifiers, arbitrary metadata, query strings, email addresses, LINE IDs, phone numbers, IP addresses, and common API-key forms are excluded or redacted. Free-text names still require human privacy review before sharing the export.

## Observation report

After shadow events have accumulated:

```powershell
npm.cmd run turns:report -- --days=7
```

The report contains per-channel turn counts, provider token percentiles, context estimates, stage latency percentiles, per-block load time, and observed-use proxy rates. It does not print conversation content.
