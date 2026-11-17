# ClaudeDeck relay

Your own relay for [ClaudeDeck](https://marketplace.elgato.com/), the Stream Deck plugin for Claude Code. Cloud sessions
(claude.ai/code) run on a remote machine and can't reach your Stream Deck directly; their hooks send status to this relay,
and the plugin listens to it. Because you deploy it in your own Cloudflare account, your sessions' data never passes
through anyone else's server. Cloudflare's free plan is enough (Workers + SQLite-backed Durable Objects).

Local sessions (Claude desktop app, terminal, IDE) don't need the relay.

## 1. Deploy the relay (one click)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/leitmanr/claudedeck-relay)

1. Click the button and sign in to Cloudflare (or create a free account).
2. Keep the name `claudedeck-relay` and click **Deploy**.
3. Copy the address it shows, e.g. `https://claudedeck-relay.<your-subdomain>.workers.dev`.

Prefer the command line? Clone this repository, then:

```bash
npm install
npx wrangler login
npx wrangler deploy
```

## 2. Set up ClaudeDeck

Everything is in the settings of any **Claude Status** key in the Stream Deck app.

1. **Local sessions:** under *Setup: Claude Code hooks* click **Install hooks**. This adds ClaudeDeck's hooks to
   `~/.claude/settings.json` (a backup of the old file is kept next to it). Start new Claude Code sessions afterwards.
2. **Relay:** paste your relay address into **Relay URL** and tick **Show cloud sessions**. Keep the **Token**: it was
   generated for you and is the only key to your relay channel.
3. **Each repository you use in the cloud:** type its local folder into **Repo folder** and click
   **Add cloud hook to this repo**. This writes `.claude/hooks/claudedeck.mjs` (with your relay address) and adds hooks
   to the repo's `.claude/settings.json`. Commit and push both files.
4. **Your cloud environment** on claude.ai/code (environment settings):
   - Network access: add your relay's domain, e.g. `claudedeck-relay.<your-subdomain>.workers.dev`, to the allowed domains.
   - Environment variables: `CLAUDEDECK_TOKEN=<the token from the Claude Status settings>`.
   - **Environment with several repositories:** Claude Code starts in their parent folder (`/workspace`) and doesn't
     read a repo's `.claude/settings.json`. Add this line to the environment's **setup script** (use the folder
     name of a repo that has the cloud hook):
     ```bash
     node /workspace/<repo>/.claude/hooks/claudedeck.mjs install
     ```
5. Start a new cloud session. It appears on your deck with a small cloud mark.

## What is sent

Only what the deck needs: hook event name, session id, project folder name, tool name, a short summary of a permission
request (e.g. the command), a question's options and a session name (the app's title, or the first ~40 characters of the
first prompt; set `CLAUDEDECK_TITLE=off` to send none). Never file contents or full tool input. The relay keeps only the
latest event per session, for at most 6 hours; permission requests for at most 2 minutes.

The token is never stored in the relay: a channel is the SHA-256 of the token. Anyone with the token can read and
answer your sessions, so treat it like a password. To revoke it, clear the Token field and restart the Stream Deck app
(a new token is generated), then update `CLAUDEDECK_TOKEN` in your cloud environment.

## Troubleshooting

- **Cloud sessions don't show up:** check that the relay domain is allowed in the cloud environment, `CLAUDEDECK_TOKEN`
  matches the token in the plugin, the repo's `.claude` files are pushed, and the session was started after that.
  If the environment has more than one repository, add the setup script line from step 4.
- **Open `https://<your relay>/` in a browser:** it should answer with a short status message.
- **Turn on *Detailed logs*** in the Claude Status settings and look in the plugin's `logs` folder.

## Development

```bash
npm install
npx wrangler dev   # local relay on http://localhost:8787
npm run check      # type check
```
