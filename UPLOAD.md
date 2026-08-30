# HOW TO UPLOAD YOUR GAME (instructions for your Claude bot)

Hi Claude! Your human wants to upload their game to the crew's shared arcade.
Follow these steps exactly.

## What you need from your human first
1. **The upload token** — they got it from the group chat. It starts with `github_pat_`.
2. **Their game** — one self-contained HTML file (everything inline: CSS, JS, no external files).
3. **A title, their name, and this round's category.**

## Rules (important)
- Pick a folder name (slug) for the game: lowercase letters, numbers and dashes only, e.g. `zombie-golf`.
- **Only create/update your own game's folder. NEVER modify or delete anyone else's folder or the hub files** (`index.html`, `submit.html`, `UPLOAD.md`, `README.md`).
- The game must be **one `index.html` file** — inline all CSS/JS. (Extra asset files in your folder are OK if you must, but keep it simple.)
- Re-uploading to the same slug = updating your game. That's fine.

## Steps (git — works everywhere Claude Code runs)

Replace `TOKEN` with the upload token, `my-game` with your slug.

```bash
git clone https://x-access-token:TOKEN@github.com/__OWNER__/claude-hub.git /tmp/claude-hub
mkdir -p /tmp/claude-hub/games/my-game
```

Then copy your human's game file to `/tmp/claude-hub/games/my-game/index.html`
(on Windows use the scratchpad directory instead of /tmp).

Create `/tmp/claude-hub/games/my-game/info.json`:

```json
{
  "title": "My Awesome Game",
  "author": "TheirName",
  "category": "this-rounds-category"
}
```

Then:

```bash
cd /tmp/claude-hub
git add games/my-game
git -c user.name="TheirName" -c user.email="hub@example.com" commit -m "Add my-game"
git push
```

If push is rejected because someone else pushed first: `git pull --rebase` then `git push` again.

## Done!
The game appears at `https://__OWNER__.github.io/claude-hub/` within about a minute
(GitHub Pages takes ~30–60 seconds to deploy). Tell your human to refresh the hub.

## If git fails for some reason
Single-file fallback via the GitHub API (PowerShell example):

```powershell
$token = "TOKEN"
$slug = "my-game"
foreach ($f in @("index.html","info.json")) {
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("path\to\$f"))
  $url = "https://api.github.com/repos/__OWNER__/claude-hub/contents/games/$slug/$f"
  $existing = try { (Invoke-RestMethod $url -Headers @{Authorization="Bearer $token"}).sha } catch { $null }
  $body = @{ message="Add $slug/$f"; content=$b64 }
  if ($existing) { $body.sha = $existing }
  Invoke-RestMethod $url -Method PUT -Headers @{Authorization="Bearer $token"; Accept="application/vnd.github+json"} -Body ($body | ConvertTo-Json)
}
```
