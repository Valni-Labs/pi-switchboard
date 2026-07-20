# pi-switchboard

A [pi](https://github.com/badlogic/pi-mono) extension that routes the pi coding agent through Switchboard. One file, no fork: pi keeps its own Anthropic wire client for request serialization and SSE parsing; the extension wraps each request in the Switchboard router envelope (`user_id`, `time`, `idempotency_key`, `kind.anthropic`) and sends it to `/v1/switchboard/inference` with your `swb_` key. Responses stream back as untranslated Anthropic events, so every pi feature that works against Anthropic directly (tool calls, streaming, thinking) works through Switchboard.

## Install

1. Install pi: `npm install -g @earendil-works/pi-coding-agent`
2. Copy `switchboard.ts` into `~/.pi/agent/extensions/`
3. Export your credentials:

```bash
export SWITCHBOARD_API_KEY=swb_...          # minted from the portal
export SWITCHBOARD_END_USER_ID=your-user    # an end user registered on your account
export SWITCHBOARD_BASE_URL=...             # optional, defaults to https://switchboard.valni.app
```

4. Run pi:

```bash
pi --provider switchboard --model <model-id> "your prompt"
```

`pi --list-models` shows the available Switchboard models. The model list is discovered live from `/v1/models` at startup, so it always reflects what your key can actually reach.

For a quick trial without installing the extension globally:

```bash
pi -e ./switchboard.ts --provider switchboard --model <model-id> -p "Say hi"
```

## Behavior

- Only models served over the `anthropic-messages` wire format are registered (that is what pi's Anthropic client emits). OpenAI-compatible and Responses models are not exposed yet.
- Every request books against the `SWITCHBOARD_END_USER_ID` you exported; usage and spend land in your Switchboard ledger as usual. Check billed truth with `GET /v1/switchboard/usage` — the cost figures pi prints in its UI are local estimates and currently show zero.
- Errors surface with their Switchboard code, fault dimension, and request id, e.g. `Switchboard SWB-3001: Unknown model (HTTP 404 fault client request rqe_...)`.

## Not yet covered

- `openai_generic` / `openai_pro` kind models (needs the same client-injection treatment for pi's OpenAI clients)
- Feeding Linecard prices into pi's per-model cost display
- Extended thinking uses budget-based parameters; adaptive-thinking Claude models are untested through this path
- Context-overflow error normalization for pi's auto-compaction
