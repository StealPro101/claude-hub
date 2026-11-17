/*
 * The owner's panel. /admin is served to anyone, but every call in here re-checks the
 * session id against ADMIN_GITHUB_IDS on the server. The page never decides anything.
 */

import { json, errorJson, nowIso, randomCode } from './util.js';
import { clean, isId, allowedCategory, coverKey, MAX_TITLE, MAX_DESC } from './validate.js';
import {
  getSettings, saveSettings, addLog, listMembers, listGames, gamesOfMember, removeGame,
  isAdminId, refresh, houseGamesWithEdits, publicGame, setGameStatus, statusOf,
  DRAFT, PUBLISHED
} from './hub.js';
import { gameKey as keyOfGame } from './validate.js';

export function isAdmin(env, session) {
  return Boolean(session && isAdminId(env, session.id));
}

async function findGame(store, id) {
  if (typeof id !== 'string' || id.length > 150) return null;
  const all = await listGames(store);
  return all.find((g) => g.id.toLowerCase() === id.toLowerCase()) || null;
}

export async function adminState(env, store) {
  const settings = await getSettings(store, env);
  const members = await listMembers(store);
  const games = await listGames(store);
  const bans = (await store.list('ban:')).map((r) => r.value);
  const tombs = (await store.list('tomb:')).map((r) => ({ key: r.key, by: r.value && r.value.by }));
  return {
    ok: true,
    settings: {
      round: settings.round,
      inviteRequired: settings.inviteRequired,
      inviteCode: settings.inviteCode,
      lastRefresh: settings.lastRefresh
    },
    members: members,
    games: games.map((g) => Object.assign(publicGame(g), {
      hidden: Boolean(g.hidden), source: g.source, ownerId: g.ownerId, repo: g.repo,
      status: statusOf(g), locked: Boolean(g.locked)
    })),
    house: (await houseGamesWithEdits(env, store)).map(publicGame),
    bans: bans,
    tombs: tombs,
    log: settings.log
  };
}

export async function handleAdmin(path, body, env, store, session, ctx) {
  const who = session.login;

  if (path === '/api/admin/member/remove' || path === '/api/admin/member/ban') {
    const id = Number(body.id);
    if (!isId(id)) return errorJson(400, 'which member?');
    const member = await store.get('member:' + id);
    const games = await gamesOfMember(store, id);
    for (const g of games) await store.delete(keyOfGame(id, g.repo));
    await store.delete('member:' + id);
    if (path === '/api/admin/member/ban') {
      await store.put('ban:' + id, {
        id: id, login: member ? member.login : String(id), at: nowIso(), by: who
      });
    }
    await addLog(store, {
      what: path.endsWith('ban') ? 'banned' : 'member removed',
      who: who,
      detail: (member ? member.login : id) + ' (' + games.length + ' games)'
    });
    return json({ ok: true });
  }

  if (path === '/api/admin/member/unban') {
    const id = Number(body.id);
    if (!isId(id)) return errorJson(400, 'which member?');
    await store.delete('ban:' + id);
    await addLog(store, { what: 'unbanned', who: who, detail: String(id) });
    return json({ ok: true });
  }

  if (path === '/api/admin/game/hide' || path === '/api/admin/game/feature') {
    const g = await findGame(store, body.id);
    if (!g) return errorJson(404, 'no such game');
    const flag = path.endsWith('hide') ? 'hidden' : 'featured';
    const next = Object.assign({}, g);
    next[flag] = body.on !== false;
    await store.put(keyOfGame(g.ownerId, g.repo), next);
    await addLog(store, {
      what: flag + (next[flag] ? ' on' : ' off'), who: who, detail: g.id
    });
    return json({ ok: true });
  }

  if (path === '/api/admin/game/unpublish') {
    const g = await findGame(store, body.id);
    if (!g) return errorJson(404, 'no such game');
    const res = await setGameStatus(store, g, DRAFT, who);
    return res.ok ? json({ ok: true }) : errorJson(400, res.error);
  }

  /* take a picture off a member's game, or off a house game */
  if (path === '/api/admin/game/cover-remove') {
    const id = String(body.id || '');
    if (id.indexOf('house/') === 0) {
      const slug = id.slice('house/'.length);
      const before = (await store.get('house:' + slug)) || {};
      await store.delete(coverKey('house', slug));
      await store.put('house:' + slug, Object.assign({}, before, { cover: null }));
      await addLog(store, { what: 'picture removed', who: who, detail: id });
      return json({ ok: true });
    }
    const g = await findGame(store, id);
    if (!g) return errorJson(404, 'no such game');
    await store.delete(coverKey(String(g.ownerId), g.repo));
    await store.put(keyOfGame(g.ownerId, g.repo), Object.assign({}, g, { cover: null }));
    await addLog(store, { what: 'picture removed', who: who, detail: g.id });
    return json({ ok: true });
  }

  /* the house games have no member to look after them, so the owner does */
  if (path === '/api/admin/house/meta') {
    const slug = String(body.slug || '');
    const house = (await houseGamesWithEdits(env, store)).find((g) => g.id === 'house/' + slug);
    if (!house) return errorJson(404, 'no such house game');
    const before = (await store.get('house:' + slug)) || {};
    const title = clean(body.title, MAX_TITLE);
    if (!title) return errorJson(400, 'a name is needed');
    await store.put('house:' + slug, Object.assign({}, before, {
      title: title,
      description: clean(body.description, MAX_DESC),
      category: allowedCategory(body.category) || house.category
    }));
    await addLog(store, { what: 'house game set', who: who, detail: 'house/' + slug });
    return json({ ok: true });
  }

  if (path === '/api/admin/game/remove') {
    const g = await findGame(store, body.id);
    if (!g) return errorJson(404, 'no such game');
    const res = await removeGame(store, g.ownerId, g.repo, 'admin');
    if (!res.ok) return errorJson(404, res.error);
    return json({ ok: true });
  }

  if (path === '/api/admin/round') {
    const settings = await getSettings(store, env);
    const n = Number(body.round);
    settings.round = {
      round: Number.isInteger(n) && n > 0 && n < 10000 ? n : settings.round.round,
      category: allowedCategory(body.category, body.category) || clean(body.category, 40).toLowerCase() || settings.round.category,
      note: clean(body.note, MAX_DESC)
    };
    await saveSettings(store, settings);
    await addLog(store, {
      what: 'round set', who: who, detail: 'round ' + settings.round.round + ' / ' + settings.round.category
    });
    return json({ ok: true, round: settings.round });
  }

  if (path === '/api/admin/invite') {
    const settings = await getSettings(store, env);
    if (typeof body.required === 'boolean') settings.inviteRequired = body.required;
    if (body.newCode === true) settings.inviteCode = randomCode(8);
    await saveSettings(store, settings);
    await addLog(store, {
      what: 'invite', who: who,
      detail: (settings.inviteRequired ? 'on' : 'off') + (body.newCode === true ? ', new code' : '')
    });
    return json({ ok: true, inviteRequired: settings.inviteRequired, inviteCode: settings.inviteCode });
  }

  if (path === '/api/admin/refresh') {
    const summary = await refresh(env, store, { batch: Number(body.batch) || 4 });
    await addLog(store, {
      what: 'refresh', who: who,
      detail: 'checked ' + summary.checked + ', +' + summary.added + ' -' + summary.removed
    });
    return json({ ok: true, summary: summary });
  }

  return errorJson(404, 'no such admin action');
}
