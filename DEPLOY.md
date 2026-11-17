# Putting Claude Hub v3 live

The Hub is one Cloudflare Worker: it serves the pages in `public/`, handles sign-in with
GitHub, keeps everything in one KV namespace, and refreshes the games every 15 minutes.
Free plan, no domain, no server to look after.

Final address: **https://hub.sp101.workers.dev** (Worker name `hub` + the account
subdomain `sp101`). Nothing in the code knows that address - the Worker always uses the
address the request came in on - so a local run or a rename keeps working.

---

## What only you can do

Everything below is in your Cloudflare and GitHub accounts, so it is all yours to click.
No bot ever creates an account, a key or a secret for you.

### 1. Cloudflare account
1. Sign in at dash.cloudflare.com (a free account is enough).
2. Workers & Pages -> your subdomain. It must be **sp101** for the address above.
   If it is something else, either change the subdomain or change `"name"` in
   `wrangler.jsonc` and use the address Cloudflare gives you.

### 2. The KV namespace
1. Storage & Databases -> KV -> **Create namespace**, call it `hub`.
2. Copy its **Namespace ID**.
3. In `wrangler.jsonc`, replace `TO_FILL_IN_KV_NAMESPACE_ID` with that id, and commit.

### 3. The GitHub OAuth App (this is what "sign in with GitHub" uses)
1. github.com -> Settings -> Developer settings -> **OAuth Apps** -> New OAuth App.
2. Application name: `Claude Hub`
   Homepage URL: `https://hub.sp101.workers.dev`
   Authorization callback URL: `https://hub.sp101.workers.dev/auth/callback`
3. Note the **Client ID**, then **Generate a new client secret** and copy it once.
   Do not paste either of them into a file in this repo, into a chat, or to a bot.

The app asks for **no scopes**, so it can only see what is already public about a
person. The Hub reads `GET /user` once at sign-in and never stores the token.

### 4. Deploy the Worker
Either way works; pick one.

**A - connect the repo (recommended, no install):**
1. Workers & Pages -> Create -> Workers -> **Import a repository** -> this repo, branch
   `v3-github-accounts` (or `main` once it is merged).
2. Build command: **leave empty**. Deploy command: `npx wrangler deploy`.
   Root directory: the repo root.
3. Cloudflare reads `wrangler.jsonc` for the rest.

**B - from a computer:** `npx wrangler deploy` in this folder (that downloads wrangler,
so do it yourself when you want it).

### 5. The four secrets (you paste these, nobody else)
Worker -> Settings -> **Variables and Secrets** -> add as **Secret** (not plain text):

| Name | What to put in |
|---|---|
| `GITHUB_CLIENT_ID` | the Client ID from step 3 |
| `GITHUB_CLIENT_SECRET` | the client secret from step 3 |
| `SESSION_SECRET` | a long random string you make up (40+ characters). Changing it later signs everyone out, nothing else |
| `ADMIN_GITHUB_IDS` | your numeric GitHub id. Yours is **256234754**. Commas between several |

`HUB_TOPIC` is already set as a plain variable in `wrangler.jsonc`.

Your numeric id again any time: `https://api.github.com/users/StealPro101` -> `"id"`.

### 6. Check it
1. Open `https://hub.sp101.workers.dev` - the arcade with Rare Pull and Neon Snake.
2. Press SIGN IN. You are an admin, so no invite code is needed.
3. ADMIN appears in the nav -> open it -> copy the join link and send that to a friend.
4. The cron runs every 15 minutes by itself; **REFRESH NOW** does it at once.

### 7. The old GitHub Pages site
`https://stealpro101.github.io/claude-hub/` was v2. The files moved into `public/`, so
once this branch is merged that address stops working. Either leave Pages switched off
(Settings -> Pages -> Source: None) or leave it as it is on `main` until you are ready.
Nothing on the new Hub needs Pages on this repo any more - only your friends' game repos
need Pages on **their** accounts.

---

## How it hangs together

```
public/            everything the Worker serves (pages, styles, scripts, house games)
worker/            the backend: index.js (routes) auth.js github.js hub.js admin.js
                   store.js validate.js util.js
tools/             local only: dev-server.js, test.js, fake-github.js, file-store.js
wrangler.jsonc     name, KV binding, assets binding, the 15 minute cron
```

- **Storage** is one KV namespace, through a four-call interface (`get/put/delete/list`):
  `member:<id>`, `game:<ownerId>/<repo>`, `tomb:<ownerId>/<repo>`, `ban:<id>`, `settings`.
- **A game is always played from its owner's own address**, computed as
  `https://<login>.github.io/<repo>/`. The Hub never takes a URL from anybody.
- **The refresh** (cron + the admin button) walks the members a few at a time, adds any
  eligible repo carrying the topic, updates titles and stars, and drops games whose repo
  went away. It stops well before Cloudflare's 50-subrequest limit and only writes to KV
  when something actually changed.
- **Free-plan budget:** 100k requests/day, 1k KV writes/day, 50 subrequests per
  invocation. The refresh uses about 8-12 GitHub calls a run with a handful of friends.

## Running it here, offline

```
node tools/dev-server.js --reset     http://127.0.0.1:8797, fake GitHub built in
node tools/test.js                   the whole test suite
```

The dev server never touches the internet or a real account: GitHub is faked in process,
and the store is a JSON file in `.tmp-test/` (git-ignored).
