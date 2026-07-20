# pi-switchboard

A [pi](https://github.com/badlogic/pi-mono) extension that routes the pi coding agent through Switchboard. One file, no fork. All three Switchboard kinds are supported:

| Switchboard kind | pi API | Examples |
|---|---|---|
| `anthropic` | `anthropic-messages` | Claude Sonnet 5, Opus 4.8, Fable 5 |
| `openai_generic` | `openai-completions` | DeepSeek, Kimi, GLM, Grok, GPT-5.x |
| `openai_pro` | `openai-responses` | GPT-5.3 Codex, GPT-5.x Pro |

The extension discovers the catalog from `/v1/models` at startup, registers every model under a `switchboard` provider with pi's matching wire client, and installs a fetch interceptor scoped to a sentinel URL path. pi's own SDK clients serialize requests and parse streams natively; the interceptor only wraps each request in the Switchboard router envelope (`user_id`, `time`, `idempotency_key`, `kind.<tag>`) and sends it to `/v1/switchboard/inference`. Responses stream back as untranslated provider events, so tool calls, streaming, thinking, and prompt caching all work exactly as they do against the providers directly, while every request books to your Switchboard ledger.

## Install

1. Install pi: `npm install -g @earendil-works/pi-coding-agent`
2. Install this package:

```bash
pi install https://github.com/Valni-Labs/pi-switchboard
```

3. Sign in and run:

```bash
pi
> /login        # pick Switchboard, approve in the browser
> /model        # every catalog model, with prices
```

`/login` runs a device sign-in: pi shows a short code, your browser opens the Switchboard portal, you approve the device, and pi is signed in. No keys to copy and nothing to configure; the device holds only short-lived credentials that renew themselves, and you can revoke it any time from the portal under Devices. The model list is public, so `/model` and `pi --list-models` work even before signing in; signing in is needed only to run inference.

To pin a release instead of tracking `main`: `pi install https://github.com/Valni-Labs/pi-switchboard@v0.3.0`. Update later with `pi update --extensions`, remove with `pi remove`.

### Key-based use (CI and servers)

For non-interactive environments, skip `/login` and export a key instead:

```bash
export SWITCHBOARD_API_KEY=swb_...          # minted from the portal
export SWITCHBOARD_END_USER_ID=your-user    # an end user registered on your account
```

Your `swb_` key is a server-side credential. Your own shell or CI runner is the intended home for it; never embed the key or this extension in an app you distribute to others.

Optional overrides: `SWITCHBOARD_BASE_URL` (inference, defaults to https://switchboard.valni.app) and `SWITCHBOARD_AUTH_BASE_URL` (sign-in, defaults to https://api.valni.app).

For a quick trial from a clone without installing: `pi -e ./extensions/switchboard.ts --provider switchboard --model <id> -p "Say hi"`.

Tested against pi v0.80.x. The extension reads pi's bundled model registry for context windows and provider quirks, so a future pi release can move things; pin a tagged release if you want to update on your own schedule.

## Model metadata

- Per-token costs come from the Switchboard price sheet (`prices` in `/v1/models`), so pi's in-session cost display tracks what the ledger will bill. Cache-write pricing is not in the price sheet and displays as zero; billed truth is always `GET /v1/switchboard/usage`.
- Context windows, display names, thinking-level maps, and provider quirks are copied from pi's built-in model registry when the Switchboard model id matches a known model (all Claude and GPT ids do). Unknown ids get a conservative default: context window unknown to pi, `max_tokens` field, `system` role instead of `developer` (some OpenAI-compatible providers reject `developer`).

## Errors

Switchboard errors are translated for the person at the keyboard, not the API developer, and wrapped in each provider's native error shape so pi displays them as plain messages. Account conditions come with their fix: a wrong key says to log in to Switchboard and get a key, an empty balance says to top up, spend and rate limits point at the portal, a disallowed model says to switch models. Provider outages say to retry or switch models, and anything internal to Switchboard says so and asks for the request id. Every message ends with the code and request id for support, e.g. `Out of Switchboard credit. Top up at https://platform.valni.ai and retry. [SWB-1007, request rqe_...]`.

## Not yet covered

- Context-overflow error normalization for pi's auto-compaction (unknown ids have no context window, so pi cannot preemptively compact for them)
- Per-model quirk knowledge for non-registry ids beyond the conservative defaults; this belongs in Linecard capability profiles long-term
