# pi-switchboard

[![Version](https://img.shields.io/github/v/tag/Valni-Labs/pi-switchboard?label=version&sort=semver&color=0284c7)](https://github.com/Valni-Labs/pi-switchboard/tags)
[![pi](https://img.shields.io/badge/pi-v0.80.x-334155)](https://github.com/badlogic/pi-mono)
[![Switchboard](https://img.shields.io/badge/Switchboard-valni.app-0ea5e9)](https://valni.app/switchboard/)

Every model, in your coding agent, on one prepaid balance. pi-switchboard connects [pi](https://github.com/badlogic/pi-mono) to [Switchboard](https://valni.app/switchboard/): sign in once and `/model` fills with every Switchboard model that pi-switchboard supports. Claude and OpenAI/OpenAI-compatible models, priced per token, with no subscription and no provider accounts.

Explore Switchboard at [valni.app/switchboard](https://valni.app/switchboard/). Manage your balance, usage, spend controls, and devices at [valni.app/platform](https://valni.app/platform).

## How does Switchboard help?

**Full native power, or we don't serve it.** You never get less from a model through Switchboard than you would going direct. Every model runs in its own native format, so streaming, tool calling, thinking, and prompt caching work at the model's full capability. Switching models is picking a different one from the list.

**No keys to manage.** `/login` signs your device in from the browser. Credentials are short-lived and renew themselves, and you can revoke a device any time from the portal. Nothing to copy, nothing to paste, nothing to leak.

**Every token metered.** Input, output, cache writes, cache reads, and reasoning, itemized at provider-exact rates with cached-prompt discounts included. You know what a session cost the moment it finishes.

**Spend stays where you set it.** Daily and monthly caps, rate limits, and model policy, enforced before a request runs. A runaway session stops at your ceiling, not at your card statement.

**A catalog you can trust.** Capabilities, configuration, and per-token prices for every model, human-verified in [Linecard](https://valni.app/linecard) before they go live. Compare the new frontier model against your current one before sending it a single request.

**One bill.** One prepaid balance covers every provider and settles to a single itemized statement. No subscription; a flat platform fee applies only when you top up. [Pricing](https://valni.app/pricing) has the details.

Working with a team, or building an app on Switchboard? Same account, more people: start from the [team quickstart](https://valni.app/quickstart/pi-team) or the [Switchboard docs](https://valni.app/switchboard/).

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

`/login` runs a device sign-in: pi shows a short code and opens your browser on the Switchboard portal; you approve the device (signing in first if your browser session lapsed brings you right back to the approval), and pi picks it up within seconds. No keys to copy and nothing to configure; the device holds only short-lived credentials that renew themselves, and you can revoke it any time from the portal under Devices. Signed out, Switchboard shows no models at all; the moment you sign in, the catalog loads live from your account, so `/model` reflects your real-time configuration.

To pin a release instead of tracking `main`: `pi install https://github.com/Valni-Labs/pi-switchboard@v0.3.4`. Update later with `pi update --extensions`, remove with `pi remove`.

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

Switchboard errors are translated for the person at the keyboard, not the API developer, and wrapped in each provider's native error shape so pi displays them as plain messages. Account conditions come with their fix: a wrong key says to log in to Switchboard and get a key, an empty balance says to top up, spend and rate limits point at the portal, a disallowed model says to switch models. Provider outages say to retry or switch models, and anything internal to Switchboard says so and asks for the request id. Every message ends with the code and request id for support, e.g. `Out of Switchboard credit. Top up at https://valni.app/platform and retry. [SWB-1007, request rqe_...]`.

## Not yet covered

- Context-overflow error normalization for pi's auto-compaction (unknown ids have no context window, so pi cannot preemptively compact for them)
- Per-model quirk knowledge for non-registry ids beyond the conservative defaults; this belongs in Linecard capability profiles long-term
