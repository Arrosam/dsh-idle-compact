# dsh-idle-compact

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that compacts a long session automatically once you stop replying. It runs before the model provider's KV cache expires, to save tokens.

## Why

Providers cache the prompt prefix of a conversation for a few minutes. While the cache is warm, re-reading a long history is cheap. Once it expires, your next message re-bills the whole history at the full, uncached input price.

If you walk away from a long session, this plugin compacts it while the cache is still warm. The summarization request is cheap, and when you come back your next turn starts from a much shorter prompt.

## How it works

1. When a session finishes a turn and waits for you, a timer starts.
2. Any new activity in that session cancels the timer, whether it's you replying or the agent starting work.
3. When the timer fires, the plugin measures the session's context with DSH's token meter.
4. If the context is longer than the threshold, the plugin compacts the session the same way `/compact` does: older history is replaced by a summary.

Subagent sessions are skipped, because they never wait for a user reply. If the agent is busy when the timer fires, the compaction is skipped and logged.

## Settings

Open **Plugins → Idle Compact** in the DSH Web UI:

| Setting | Default | Meaning |
|---|---|---|
| Context length threshold (tokens) | `256000` | Compact only when the session context is longer than this. |
| Idle time (seconds) | `300` (5 min) | How long you must go without replying before compacting. |

Both fields take whole numbers of at least 1. Changes apply without a restart. A changed idle time takes effect the next time a session starts waiting.

You can also set them in your profile's `cordis.patch.yml`:

```yaml
- id: idle-compact
  config:
    contextThresholdTokens: 200000
    idleSeconds: 240
```

## Install

Requires DSH 0.2.0 or later with the Web UI. Its Plugins page hosts the settings form.

```sh
dsh plugin add github:Arrosam/dsh-idle-compact
```

Or, in the Web UI, open **Plugins → Add plugin** and enter `github:Arrosam/dsh-idle-compact` or a local checkout path.

## Token cost

Each compaction makes one summarization call to your model. It's cheap because the cache is warm, but it is spent even if you never return to that session. If most of your idle sessions are ones you abandon, raise the threshold.

## Files

| File | Role |
|---|---|
| `index.js` | Host half: idle timers, the context check, and the compaction call. |
| `client.js` | Browser half: the settings form on the Plugins page. |
| `cordis.patch.yml` | Bundle patch that inserts the `idle-compact` row. |
| `locale/*.json`, `icon.svg` | Display metadata for the plugin manager. |
