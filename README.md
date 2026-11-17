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
3. **It shows up by itself** within 15 minutes, or press Add on the MY GAMES page —
   as a **draft**. Your repo is public, because that is how the Hub finds it, but on the
   Hub only you (and the owner) can see the game until you publish it. Optional
   `hub.json` in your repo root pre-fills the title, description and category.
4. **You set it up and publish**: name, description, category, and a cover picture from
   your photos. The picture is cropped to 16:10 in your browser and re-drawn before it
   is sent, so no location or camera data goes with it.
5. **The owner has an admin panel**: the round, the invite link, unpublish / hide /
   remove / feature a game, edit the house games, remove or ban a member, refresh now,
   and a short activity log.

The two house games (Rare Pull, Neon Snake) live in `games/` in this repo and are still
served from `https://stealpro101.github.io/claude-hub/games/<slug>/`, exactly where they
always were, so nobody loses their saved progress. The Hub frames them from there like
anyone else's game.

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
public/     the site the Worker serves
games/      the two house games, still served by GitHub Pages at their old addresses
index.html  the "moved" page for the old Pages address
worker/     the Cloudflare Worker: routing, GitHub sign-in, storage, the 15 min refresh
tools/      local only: dev server with a fake GitHub, tests
```

```
node tools/dev-server.js --reset    http://127.0.0.1:8797, works offline
node tools/test.js                  302 checks, no network
node tools/seed-fixture.js 9        fill the local store with a made-up Hub to look at
```

Going live, and which bits only the owner can click: [DEPLOY.md](DEPLOY.md).
