# dsh-idle-compact

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that prepares a compaction of a long session while you are away, before the model provider's KV cache expires, and lets you apply it with one click when you come back.

## Why

Providers cache the prompt prefix of a conversation for a few minutes. While the cache is warm, re-reading a long history is cheap. Once it expires, your next message re-bills the whole history at the full, uncached input price.

If you walk away from a long session, this plugin produces the compaction summary while the cache is still warm, so that summarization request is cheap. Nothing changes in your session until you decide to apply it.

## How it works

1. When a session finishes a turn and waits for you, a timer starts.
2. Any new activity in that session cancels the timer, whether it's you replying or the agent starting work.
3. When the timer fires, the plugin prepares a compaction only if all of these hold:
   - the agent is still idle and its last turn finished normally (not an error or a stop);
   - no background job or subagent is running for the session;
   - the session's context, measured with DSH's token meter, has reached the threshold.
4. Preparing runs exactly the summarization request DSH's `/compact` would make, and keeps the result. Your session is not changed.
5. An **Apply compaction** button appears in the session header. Hover it to see how many history items it covers.
6. Clicking it runs DSH's own `/compact` command, exactly as if you had typed it, and answers its summarization request with the prepared result, so no new model call is made. The conversation shows the usual `/compact` card with its "Compacted N history items" reply.

The prepared summary is only valid for the conversation it summarized. If you send another message (or the history changes in any other way), it is discarded and the button disappears; the next idle period that qualifies prepares a fresh one. If the conversation somehow differs at the moment you click, `/compact` makes its own model call instead of using a stale summary.

Subagent sessions are skipped, because they never wait for a user reply. If the agent is busy when the timer fires, nothing is prepared and this is logged.

## Settings

Open **Plugins → Idle Compact** in the DSH Web UI:

| Setting | Default | Meaning |
|---|---|---|
| Context length threshold (tokens) | `256000` | Prepare a compaction only when the session context has reached this length. |
| Idle time (seconds) | `300` (5 min) | How long you must go without replying before a compaction is prepared. |

Both fields take whole numbers of at least 1. Changes apply without a restart. A changed idle time takes effect the next time a session starts waiting.

You can also set them in your profile's `cordis.patch.yml`:

```yaml
- id: idle-compact
  config:
    contextThresholdTokens: 200000
    idleSeconds: 240
```

## Install

Requires DSH 0.2.0 or later with the Web UI. Its Plugins page hosts the settings form, and the session header hosts the Apply button.

```sh
dsh plugin add github:Arrosam/dsh-idle-compact
```

Or, in the Web UI, open **Plugins → Add plugin** and enter `github:Arrosam/dsh-idle-compact` or a local checkout path.

## Token cost

Each prepared compaction makes one summarization call to your model. It's cheap because the cache is warm, but it is spent even if you never click Apply or never return to that session. If most of your idle sessions are ones you abandon, raise the threshold.

Prepared summaries are kept in memory only. Restarting DSH discards them.

## Files

| File | Role |
|---|---|
| `index.js` | Host half: idle timers, the preparation, and the state/apply endpoint under `/dsh-idle-compact/api`. |
| `client.js` | Browser half: the settings form on the Plugins page and the Apply button in the session header. |
| `cordis.patch.yml` | Bundle patch that inserts the `idle-compact` row. |
| `locale/*.json`, `icon.svg` | Display metadata for the plugin manager. |

## License

MIT
