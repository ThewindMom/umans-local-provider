# UMANS Factory Provider

Local UMANS provider for **Factory Droid**, **Oh My Pi**, and OpenAI-compatible clients.

It runs UMANS through two local services:

```text
Factory / OMP / clients
  -> umans-dash    http://127.0.0.1:8084
  -> umans-limiter http://127.0.0.1:8319
  -> https://api.code.umans.ai
```

## What this gives you

- **Factory Droid custom model** for `umans-glm-5.2`.
- **GLM image attachments via handoff**: image inputs are analyzed by `umans-kimi-k2.7`, then forwarded to GLM as trusted visual observations.
- **Prompt-injection-aware image framing**: text visible inside images is treated as visual evidence, not instructions.
- **Strict local concurrency limiter**: all upstream requests pass through a semaphore, not just selected routes.
- **Automatic image cap**: prunes excessive image attachments before forwarding.
- **Dashboard** at `http://127.0.0.1:8084` for health, models, cache, usage, and key management.
- **No checked-in secrets**: `.config/config.json`, logs, sessions, images, and env files are ignored.

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USER/umans-factory-provider.git
cd umans-factory-provider
./scripts/install-local.sh
```

### 2. Configure UMANS API key

Edit:

```bash
~/.local/share/umans-factory-provider/.config/config.json
```

Set:

```json
{
  "API_KEY": "sk-your-umans-api-key-here"
}
```

Or keep the file secret-free and export:

```bash
export UMANS_API_KEY=sk-your-umans-api-key-here
```

### 3. Start services

```bash
systemctl --user restart umans-limiter.service umans-dash.service
systemctl --user status umans-limiter.service umans-dash.service
```

Health checks:

```bash
curl http://127.0.0.1:8319/healthz
curl http://127.0.0.1:8084/healthz
curl http://127.0.0.1:8084/v1/models/info
```

## Factory Droid setup

Add the object from [`integrations/factory-custom-model.example.json`](integrations/factory-custom-model.example.json) to the `customModels` array in:

```bash
~/.factory/settings.json
```

Important fields:

```json
{
  "id": "custom:GLM-5.2-(Umans)",
  "provider": "anthropic",
  "baseUrl": "http://127.0.0.1:8084",
  "model": "claude-sonnet-4-5-20250929",
  "noImageSupport": false,
  "extraHeaders": {
    "x-umans-target-model": "umans-glm-5.2"
  }
}
```

Why this looks odd:

- Factory currently gates image upload support by known provider/model capabilities.
- The Claude model ID makes Factory use its image-capable Anthropic client path.
- `x-umans-target-model: umans-glm-5.2` tells the local proxy to route the request to real UMANS GLM.
- This avoids global aliasing or hijacking real Claude requests.

After changing `~/.factory/settings.json`, start a **new** Droid session. Existing panes can cache old model capabilities.

## Oh My Pi setup

Merge [`integrations/omp-models.example.yml`](integrations/omp-models.example.yml) into your OMP agent config:

```yaml
providers:
  umans:
    baseUrl: http://127.0.0.1:8084/v1
    modelOverrides:
      umans-glm-5.2:
        input:
          - text
          - image

images:
  describeForTextModels: true
```

Then test:

```bash
omp -p --no-session --model umans/umans-glm-5.2:xhigh @/path/to/image.png \
  "What can you see here? Answer from the image."
```

## Vision handoff behavior

For models whose catalog says `supports_vision: "via-handoff"`:

1. The proxy extracts image parts from OpenAI and Anthropic-style payloads.
2. Each image is sent to `VISION_HANDOFF_MODEL` (default `umans-kimi-k2.7`).
3. The image part is replaced with a block labeled `Trusted vision handoff observation`.
4. A system note is merged into the target payload so GLM treats the block as the visual contents of the original attachment.
5. Any instructions quoted from inside the image are explicitly framed as visible text, not instructions to follow.

This fixes the common failure mode where a text-only final model sees a placeholder like `[User pasted image]` and replies that it cannot inspect images.

## Strict rate limiting

`src/umans-limiter.ts` is intentionally simple: every request to the upstream API is gated by one semaphore.

Default:

```text
UMANS_LIMITER_MAX_CONCURRENCY=4
UMANS_LIMITER_UPSTREAM=https://api.code.umans.ai
```

Metrics:

```bash
curl http://127.0.0.1:8319/metrics
```

Expected policy:

```json
{
  "maxConcurrent": 4,
  "limitedPolicy": "all upstream requests"
}
```

## Validation

Local mocked validation, no UMANS key required:

```bash
bun run validate
```

This runs:

- `node --check proxy.js`
- `bun test`
- `scripts/secret-scan.ts`

Live smoke test against your running local services:

```bash
bun run smoke:live /path/to/image.png
```

Expected live result:

- HTTP `200`
- final model `umans-glm-5.2`
- dash logs include `vision-handoff: 1 image(s) → umans-kimi-k2.7`
- response describes the image instead of saying the image is unavailable

## Security notes

- Never commit `.config/config.json`.
- Never commit `~/.factory/settings.json`, OMP configs with real keys, auth files, logs, sessions, or pasted images.
- If a real key was ever copied into a public branch or issue, rotate it immediately.
- The dashboard key API returns masked keys only; key replacement is write-only.

## Configuration reference

See [`config/config.example.json`](config/config.example.json).

Most important fields:

| Field | Default | Purpose |
| --- | --- | --- |
| `LISTEN_ADDR` | `127.0.0.1:8084` | Dashboard/proxy bind address |
| `UPSTREAM_BASE_URL` | `http://127.0.0.1:8319/v1` | Route dash through strict limiter |
| `API_KEY` | placeholder | UMANS API key |
| `MAX_IMAGES` | `9` | Maximum images forwarded per request |
| `VISION_HANDOFF_ENABLED` | `true` | Enable GLM image handoff |
| `VISION_HANDOFF_MODEL` | `umans-kimi-k2.7` | Vision model used for image descriptions |
| `OVERRIDE_CONCURRENCY` | `0` | Optional dashboard queue override; strict limiter remains authoritative |

## License

MIT
