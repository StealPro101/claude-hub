# Paste this to your own Claude

This is the same text the **COPY THE PROMPT** button gives you on
https://hub.sp101.workers.dev/join.html - put it in your own Claude, in your own folder,
signed in to your own GitHub.

---

I want to put a game on Claude Hub (https://hub.sp101.workers.dev). Do all of this on MY
OWN GitHub account, using my own git / gh sign-in - never your own and never anyone
else's:

1. Make a NEW PUBLIC repo on my account (not a fork), short lowercase name.
2. Put my game in it as index.html in the repo ROOT (other files are fine, but index.html
   has to be at the root so the page loads on its own).
3. Optional hub.json in the root, all fields optional:
   `{ "title": "max 60 chars", "description": "max 200 chars", "category": "arcade", "emoji": "one emoji" }`
   Categories: arcade, puzzle, action, shooter, platformer, racing, strategy, trivia,
   idle, horror, sandbox, sports, card, rhythm, freestyle.
4. Turn on GitHub Pages: Settings > Pages > Deploy from a branch > my default branch >
   `/ (root)`. Wait for the first build to finish.
5. Add the repo topic `claude-hub-game` (the gear next to "About" on the repo page).
6. Tell me the play address: `https://<my-login>.github.io/<repo>/`

Hard rules while you do it:
- NEVER put a key, token, password, API secret or personal information in the game, the
  repo, the commits or hub.json. Nothing in there that is not meant to be public.
- Only my own work. No copy of someone else's game, art, music or code without a licence
  that allows it, and keep the licence notice if there is one.
- Nothing hateful or sexual, nothing made to trick, scare or harm whoever plays it, and
  never ask a player for a login, an account or money.
- The game has to work on its own page with no server: plain HTML, CSS and JS.

---

## Then

The Hub notices the topic by itself within 15 minutes, and you can also open **MY GAMES**
and press Add next to the repo.

Either way it arrives as a **draft**. Your repo is public on GitHub — that is how the Hub
finds it — but on the Hub the game stays private until you publish it. On My games press
**Set up & publish**: a name, a description, a category and a cover picture from your
photos. The picture is cropped to 16:10 in your browser and re-drawn before it is sent,
so where the photo was taken never leaves your phone. Then press Publish.

**Not on the Hub yet?** You need the `/join?code=...` link from whoever runs it. Open the
link, press Sign in with GitHub, done - no password and no token goes anywhere near the
Hub, and it cannot write anything to your account.

**Taking a game down:** MY GAMES -> remove. It stays off the Hub until you add it again.
Your repo is never touched.
