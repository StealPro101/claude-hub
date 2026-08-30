const host = location.hostname;
const IS_PAGES = host.endsWith(".github.io");
const OWNER = IS_PAGES ? host.split(".")[0] : "stealpro101";
const REPO  = IS_PAGES ? location.pathname.split("/").filter(Boolean)[0] || "claude-hub" : "claude-hub";

function lsGet(k){ try{ return localStorage.getItem(k) }catch(e){ return null } }
function lsSet(k,v){ try{ localStorage.setItem(k,v) }catch(e){} }
function slugify(s){ return (s||"").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,40); }
function pretty(s){ return s.replace(/[-_]+/g," ").replace(/\b\w/g,c=>c.toUpperCase()); }
function b64(str){ return btoa(String.fromCharCode(...new TextEncoder().encode(str))); }
function esc(s){ const d=document.createElement("div"); d.textContent=s==null?"":String(s); return d.innerHTML; }

const ICONS = ["🎮","👾","🕹️","🚀","🐍","🧩","⚔️","🏎️","🛸","🎯","🐉","💥"];
function gameIcon(slug){ let h=0; for(const c of slug) h=(h*31+c.charCodeAt(0))>>>0; return ICONS[h%ICONS.length]; }

function renderNav(active){
  const el = document.getElementById("nav");
  if(!el) return;
  const items = [["arcade","./","🕹️ ARCADE"],["players","players.html","👥 PLAYERS"],["build","build.html","🔨 BUILD"]];
  el.className = "nav";
  el.innerHTML = items.map(([k,href,label]) =>
    `<a href="${href}" class="${k===active?"on":""}">${label}</a>`).join("");
}

async function apiList(path, cacheKey){
  try{
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`);
    if(!r.ok) throw new Error("api "+r.status);
    const items = await r.json();
    lsSet(cacheKey, JSON.stringify(items.map(x=>({name:x.name,type:x.type}))));
    return items;
  }catch(e){
    const c = lsGet(cacheKey);
    if(c) return JSON.parse(c);
    throw e;
  }
}

async function fetchJSON(path){
  try{
    const r = await fetch(path, {cache:"no-store"});
    if(r.ok) return await r.json();
  }catch(e){}
  return null;
}

async function loadRound(){
  return (await fetchJSON("round.json")) || {round:1, category:"freestyle", note:"anything goes"};
}

async function loadGames(){
  const dirs = (await apiList("games","hubCacheGames")).filter(x=>x.type==="dir");
  return Promise.all(dirs.map(async d=>{
    const info = (await fetchJSON(`games/${d.name}/info.json`)) || {};
    const author = info.author || "???";
    return {
      slug: d.name,
      title: info.title || pretty(d.name),
      author,
      authorSlug: info.authorSlug || slugify(author),
      category: (info.category || "uncategorized").toLowerCase()
    };
  }));
}

async function loadPlayers(){
  let files = [];
  try{ files = (await apiList("players","hubCachePlayers")).filter(x=>x.type==="file" && x.name.endsWith(".json")); }
  catch(e){ return []; }
  const players = await Promise.all(files.map(async f=>{
    const p = (await fetchJSON(`players/${f.name}`)) || {};
    return { slug: f.name.replace(/\.json$/,""), name: p.name || pretty(f.name.replace(/\.json$/,"")),
             emoji: p.emoji || "🎮", bio: p.bio || "", lock: p.lock || "" };
  }));
  return players;
}

function whoAmI(){ return lsGet("hubMe") || ""; }
function setWhoAmI(slug){ lsSet("hubMe", slug); }

async function sha256(s){
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
}

async function ghGetJSON(token, path){
  const headers = { "Accept": "application/vnd.github+json" };
  if(token) headers["Authorization"] = "Bearer " + token;
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {headers, cache:"no-store"});
  if(!r.ok) return null;
  const j = await r.json();
  try{
    const bytes = Uint8Array.from(atob(j.content.replace(/\n/g,"")), c=>c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }catch(e){ return null; }
}

async function ghDelete(token, path, msgText){
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
  const headers = { "Authorization": "Bearer " + token, "Accept": "application/vnd.github+json" };
  const ex = await fetch(url, {headers, cache:"no-store"});
  if(!ex.ok) return;
  const sha = (await ex.json()).sha;
  const r = await fetch(url, { method:"DELETE", headers, body: JSON.stringify({message: msgText, sha}) });
  if(!r.ok) throw new Error((await r.json()).message || ("HTTP " + r.status));
}

async function ghPut(token, path, content, msgText){
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
  const headers = { "Authorization": "Bearer " + token, "Accept": "application/vnd.github+json" };
  let sha = null;
  const ex = await fetch(url, {headers});
  if(ex.ok) sha = (await ex.json()).sha;
  const body = { message: msgText, content: b64(content) };
  if(sha) body.sha = sha;
  const r = await fetch(url, { method:"PUT", headers, body: JSON.stringify(body) });
  if(!r.ok) throw new Error((await r.json()).message || ("HTTP " + r.status));
}
