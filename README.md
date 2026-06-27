# UMANS Local Provider

Local UMANS provider for **Factory Droid**, **Oh My Pi**, **OpenCode**, and OpenAI-compatible clients.

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
- **Strict local rate limiter**: upstream HTTP requests pass through a semaphore, and new UMANS session fingerprints are leased locally before forwarding.
- **Automatic image cap**: prunes excessive image attachments before forwarding.
- **Dashboard** at `http://127.0.0.1:8084` for health, models, cache, usage, and key management.
- **No checked-in secrets**: `.config/config.json`, logs, sessions, images, and env files are ignored.

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/ThewindMom/umans-local-provider.git
cd umans-local-provider
./scripts/install-local.sh
```

The installer pins the `bun` executable currently on `PATH` into a local wrapper, so the user services work even when Bun is not installed at `~/.bun/bin`.

Renamed from `umans-factory-provider`: the installer uses `~/.local/share/umans-local-provider` and migrates an existing config from the old install directory if present.

### 2. Configure UMANS API key

Edit:

```bash
~/.local/share/umans-local-provider/.config/config.json
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

## Dashboard UMANS usage login

The dashboard usage cards use `app.umans.ai` account-session data, not the API key used for model calls. If your UMANS account uses Google/OAuth and has no password, open the dashboard at `http://127.0.0.1:8084`, click **Manage** in the API Key panel, then use **UMANS Login → Google/OAuth session cookie** and paste either:

- the `__Secure-authjs.session-token` cookie value from an already logged-in `app.umans.ai` browser session, or
- a Cookie header containing `__Secure-authjs.session-token=...`.

The token is stored only in the local `.config/config.json` as `APP_SESSION`.

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

Model/provider overrides belong in `~/.omp/agent/models.yml`. Merge [`integrations/omp-models.example.yml`](integrations/omp-models.example.yml):

```yaml
providers:
  umans:
    baseUrl: http://127.0.0.1:8084/v1
    modelOverrides:
      umans-glm-5.2:
        input:
          - text
          - image
```

Image handoff settings belong in `~/.omp/agent/config.yml`. Merge [`integrations/omp-config.example.yml`](integrations/omp-config.example.yml):

```yaml
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

`src/umans-limiter.ts` gates every upstream HTTP request with one semaphore capped at `3`, one below UMANS' advertised `4` concurrency ceiling. The dashboard forwards to the limiter and adds a local rate-limit circuit breaker that short-circuits new requests when UMANS returns `429` / `403 account_suspended`, so retry storms are absorbed locally instead of hammering upstream.

Defaults:

```text
UMANS_LIMITER_MAX_CONCURRENCY=3
UMANS_DASH_RATE_LIMIT_COOLDOWN=5m
UMANS_LIMITER_UPSTREAM=https://api.code.umans.ai
```

The limit intentionally stays below UMANS' advertised `4` concurrency ceiling to leave headroom for handoff/model-info/internal calls and account-side session accounting.

Metrics:

```bash
curl http://127.0.0.1:8319/metrics
curl http://127.0.0.1:8084/api/umans/concurrency
```

Expected policy:

```json
{
  "maxConcurrent": 3,
  "limitedPolicy": "all upstream requests",
  "gateway": {
    "sessions": { "limit": 3 },
    "circuit": { "open": false }
  }
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
| `OVERRIDE_CONCURRENCY` | `0` | Optional dashboard in-flight cap override (clamped to the upstream concurrency limit); the strict limiter stays authoritative |
| `RATE_LIMIT_COOLDOWN` | `5m` | Local circuit-breaker pause after upstream rate-limit responses without a reactivation timestamp |

## License

MIT
