# Putting Claude Hub v3 live

The Hub is one Cloudflare Worker: it serves the pages in `public/`, handles sign-in with
GitHub, keeps everything in one KV namespace, and refreshes the games every 15 minutes.
Free plan, no domain, no server to look after.

Address: **https://hub.sp101.workers.dev** (Worker name `hub` + the account subdomain
`sp101`). The code never hardcodes that host - it always uses the address the request
came in on - so local runs and a rename keep working.

**You paste exactly one secret: the GitHub client secret.** Everything else is a public
value that lives in `wrangler.jsonc`, and the Worker invents its own session signing key.

---

## 1. Fill in `wrangler.jsonc` (two values, neither is secret)

Your bot can do this bit; it is just editing a file in the repo.

| Placeholder | What goes there |
|---|---|
| `TO_FILL_IN_KV_NAMESPACE_ID` | the id of the KV namespace from step 2 |
| `TO_FILL_IN_GITHUB_CLIENT_ID` | the Client ID of the OAuth App from step 3 |

Already filled in: `ADMIN_GITHUB_IDS` = `256234754` (you), `HUB_OWNER_LOGIN`,
`HUB_REPO`, `HUB_TOPIC`. A client id is public - it shows up in every sign-in URL - so
it belongs in the file. The client **secret** never does.

## 2. Make the KV namespace  *(only you)*

1. dash.cloudflare.com -> **Storage & Databases -> KV -> Create namespace**, name `hub`.
2. Copy the **Namespace ID** into `wrangler.jsonc` (step 1).

While you are there: Workers & Pages -> make sure your account subdomain is **sp101**,
or the address will be different (then change `"name"` too if you like).

## 3. Make the GitHub OAuth App  *(only you)*

github.com -> Settings -> Developer settings -> **OAuth Apps** -> New OAuth App:

- Application name: `Claude Hub`
- Homepage URL: `https://hub.sp101.workers.dev`
- Authorization callback URL: `https://hub.sp101.workers.dev/auth/callback`

Copy the **Client ID** into `wrangler.jsonc` (step 1), then press **Generate a new
client secret** and keep that one for step 5. Do not paste the secret into the repo, a
chat, or a bot.

The app asks for **no scopes**, so it can only see what is already public about a
person, and can never write anything to their account.

## 4. Connect the repo to Cloudflare  *(only you)*

1. Workers & Pages -> **Create application -> Workers -> Connect to Git -> GitHub**.
2. Pick `StealPro101/claude-hub`, branch `main`.
3. Worker name must be **`hub`**. Build command: **leave empty**.
   Deploy command: `npx wrangler deploy`. Root directory: the repo root.
4. **Save and Deploy.** Cloudflare reads `wrangler.jsonc` for the KV binding, the assets
   folder and the 15-minute cron.

(Prefer the command line? `npx wrangler deploy` in this folder does the same thing, but
that downloads wrangler, so do it yourself when you want it.)

## 5. Paste the one secret  *(only you)*

Worker -> Settings -> **Variables and Secrets** -> Add -> type **Secret**:

| Name | Value |
|---|---|
| `GITHUB_CLIENT_SECRET` | the client secret from step 3 |

That is the whole list. There is no `SESSION_SECRET` to invent: if none is set, the
Worker makes 32 random bytes on its first request, keeps them in KV under
`secret:session`, and reuses them for ever. That key is never returned by any route,
never logged, and the storage layer refuses to list `secret:*` keys at all. (If you ever
do set `SESSION_SECRET` yourself, it wins - and changing it signs everyone out, nothing
more.)

## 6. Merge this branch into `main`

Merging is what does both of these at once:

- Cloudflare builds and deploys the Worker (step 4 watches `main`), and
- the old Pages address **https://stealpro101.github.io/claude-hub/** turns into a
  "Claude Hub moved" page that points at the new site.

The two house games stay exactly where they have always been -
`.../claude-hub/games/rare-pull/` and `.../games/neon-snake/` - same addresses, same
origin, so everybody's saved progress survives. The Hub now frames them from there like
any other member's game. **Leave GitHub Pages switched on for this repo**; that is what
serves them.

## 7. Check it

1. Open https://hub.sp101.workers.dev - the arcade, with Rare Pull.
2. Press SIGN IN. Your id is in `ADMIN_GITHUB_IDS`, so you need no invite code.
3. ADMIN appears in the nav -> open it -> copy the join link and send that to a friend.
4. The cron runs every 15 minutes on its own; **REFRESH NOW** does it at once.

---

## How it hangs together

```
public/            everything the Worker serves (pages, styles, scripts)
games/             the two house games, served by GitHub Pages at the old addresses
index.html         the "moved" page for the old Pages address
worker/            the backend: index.js (routes) auth.js github.js hub.js admin.js
                   store.js validate.js util.js
tools/             local only: dev-server.js, test.js, fake-github.js, file-store.js
wrangler.jsonc     name, vars, KV binding, assets binding, the 15 minute cron
```

- **Nothing is on show until its maker says so.** Every game arrives as a draft - added
  by hand or picked up from the topic - and only its owner and you can see it. The
  publish form sets the name, description, category and a cover picture; the browser
  crops it to 960x600 and re-encodes it (which also strips the photo's location data),
  and the Worker checks the bytes really are a WebP, JPEG or PNG before storing them
  under `cover:<ownerId>/<repo>`. Covers are served from `/img/cover/...`, cached hard
  once published and never cached while a game is still a draft.
- **Storage** is one KV namespace behind a small interface (`get/put/delete/list`, plus
  `putBytes/getBytes` for cover pictures):
  `member:<id>`, `game:<ownerId>/<repo>`, `tomb:<ownerId>/<repo>`, `ban:<id>`,
  `house:<slug>`, `rate:cover:<id>`, `settings`, the cover bytes under
  `cover:<owner>/<repo>`, and the Worker's own `secret:session`. `list()` never returns
  a `secret:*` or `cover:*` key, whatever prefix it is asked for.
- **A game is always played from its owner's own address**, computed as
  `https://<login>.github.io/<repo>/`. The Hub never takes a URL from anybody.
- **Members are refreshed by numeric id** (`GET /user/<id>`), so renaming a GitHub
  account just carries the games across to the new login. An account that 404s three
  refreshes in a row has its games hidden, never deleted - you decide in the panel.
- **Free-plan budget:** 100k requests/day, 1k KV writes/day, 50 subrequests per
  invocation. A refresh with a handful of friends costs about 8-12 GitHub calls and
  writes only when something actually changed.

## Running it here, offline

```
node tools/dev-server.js --reset     http://127.0.0.1:8797, fake GitHub built in
node tools/test.js                   the whole test suite
```

The dev server never touches the internet or a real account: GitHub is faked in process
and the store is a JSON file in `.tmp-test/` (git-ignored).
