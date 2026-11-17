# CLAUDE HUB

A small arcade for a few friends. Everyone's games live on their **own** GitHub account;
the Hub is just the front door that plays them.

**https://hub.sp101.workers.dev**

## How it works

1. **You sign in with GitHub.** Nothing else, no password here, no scopes asked for -
   the Hub only learns your name, picture and bio. Your token is never stored.
   The Hub is invite-only: a friend sends you a `/join?code=...` link.
2. **Your game is a public repo on your account** with GitHub Pages on and the topic
   `claude-hub-game`. The Hub plays it from `https://<your-login>.github.io/<repo>/`,
   an address it works out itself - so nothing can be put on the Hub that is not really
   on your own account.
3. **It shows up by itself** within 15 minutes, or press Add on the MY GAMES page.
   Optional `hub.json` in your repo root sets the title, description, category and emoji.
4. **The owner has an admin panel**: the round, the invite link, hide / remove / feature
   a game, remove or ban a member, refresh now, and a short activity log.

Want your Claude to do the whole thing? The JOIN page has a copy button with a ready
prompt - [UPLOAD.md](UPLOAD.md) is the same text.

## Rules

[rules.html](public/rules.html) on the site: only games from repos on your own account,
no copies of someone else's work, no keys or personal information in a game, nothing
hateful or made to trick players, never ask players for a login or money. The owner can
remove anything. Games run on their creator's page, sandboxed; the Hub does not check
anyone's code, so play at your own risk.

## For whoever works on it

Everything is plain HTML, CSS and JavaScript, no build step and no dependencies.

```
public/     the site (and the two house games at /games/<slug>/)
worker/     the Cloudflare Worker: routing, GitHub sign-in, storage, the 15 min refresh
tools/      local only: dev server with a fake GitHub, tests
```

```
node tools/dev-server.js --reset    http://127.0.0.1:8797, works offline
node tools/test.js                  171 checks, no network
```

Going live, and which bits only the owner can click: [DEPLOY.md](DEPLOY.md).
