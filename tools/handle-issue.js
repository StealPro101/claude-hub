#!/usr/bin/env node
/*
 * Claude Hub v3 - join / leave handler.
 *
 * Runs inside the hub-members workflow. It reads the webhook event from the file at
 * $GITHUB_EVENT_PATH, so no issue text is ever interpolated into a shell command.
 *
 * The person's identity comes ONLY from issue.user.login / issue.user.id - the issue
 * body is never parsed for a username. Approvals count only when the repository owner
 * (hub.config.json "owner") is the one who added the "approved" label.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isValidLogin } = require('./build-index.js');

const LABEL_JOIN = 'hub-join';
const LABEL_LEAVE = 'hub-leave';
const LABEL_PENDING = 'join-request';
const LABEL_APPROVED = 'approved';
const TITLE_JOIN = '[Join]';
const TITLE_LEAVE = '[Leave]';

const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

function labelNames(issue) {
  const raw = issue && Array.isArray(issue.labels) ? issue.labels : [];
  return raw
    .map((l) => (typeof l === 'string' ? l : l && typeof l.name === 'string' ? l.name : ''))
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

function sameLogin(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function memberList(membersFile) {
  const m = membersFile && typeof membersFile === 'object' ? membersFile : {};
  return Array.isArray(m.members) ? m.members.filter((x) => x && isValidLogin(x.login)) : [];
}

function howToAddAGame(config) {
  const topic = config.topic || 'claude-hub-game';
  return [
    'Next step - put your game on your own account:',
    '',
    '1. Make a **public** repo on your GitHub (not a fork) with your game as `index.html` in the root.',
    '2. Settings -> Pages -> Build from branch, your default branch, `/ (root)`.',
    '3. On the repo home page press the gear next to "About" and add the topic `' + topic + '`.',
    '',
    'The Hub picks it up within 15 minutes. Optional `hub.json` in the repo root:',
    '`{ "title": "...", "description": "...", "category": "...", "emoji": "..." }`',
    '',
    'No keys, tokens or passwords in a game, ever.'
  ].join('\n');
}

/*
 * Pure: works out what should happen. No file or network access.
 * Returns { kind, login, id, members, comment, close, addLabel, changed }
 */
function decide(opts) {
  const event = opts.event || {};
  const config = opts.config || {};
  const membersFile = opts.membersFile || { members: [] };
  const blocked = opts.blocked || {};
  const now = opts.now || new Date().toISOString().slice(0, 10);

  const nothing = (why) => ({ kind: 'ignored', why: why, changed: false, close: false });

  const issue = event.issue;
  if (!issue || typeof issue !== 'object') return nothing('no issue in event');
  if (issue.pull_request) return nothing('pull request, not an issue');

  const user = issue.user;
  const login = user && typeof user.login === 'string' ? user.login : '';
  if (!login) return nothing('no author');
  if (user.type === 'Bot' || /\[bot\]$/i.test(login)) return nothing('author is a bot');
  if (!isValidLogin(login)) return nothing('author login fails the format check');
  const id = Number(user.id);
  if (!Number.isFinite(id) || id <= 0) return nothing('no numeric author id');

  const labels = labelNames(issue);
  const title = typeof issue.title === 'string' ? issue.title : '';
  const isJoin = labels.includes(LABEL_JOIN) && title.trim().startsWith(TITLE_JOIN);
  const isLeave = labels.includes(LABEL_LEAVE) && title.trim().startsWith(TITLE_LEAVE);
  if (!isJoin && !isLeave) return nothing('not one of the Hub forms');
  if (isJoin && isLeave) return nothing('both Hub labels, refusing to guess');

  const list = memberList(membersFile);
  const already = list.find((m) => sameLogin(m.login, login)) || null;
  const blockedLogins = (Array.isArray(blocked.logins) ? blocked.logins : [])
    .filter((x) => typeof x === 'string').map((x) => x.trim().toLowerCase());
  const isBlocked = blockedLogins.includes(login.toLowerCase());

  const action = typeof event.action === 'string' ? event.action : '';
  const openMode = String(config.joinMode || 'approve').toLowerCase() === 'open';

  const addMember = () => {
    const next = list.slice();
    next.push({ login: login, id: id, joined: now });
    return {
      kind: 'added', login: login, id: id, changed: true, close: true,
      members: { members: next },
      comment: '**@' + login + ' is in.** You are on the Claude Hub members list.\n\n' +
        howToAddAGame(config)
    };
  };

  if (isJoin) {
    if (action === 'opened') {
      if (isBlocked) {
        return {
          kind: 'refused', login: login, changed: false, close: true,
          comment: 'This account cannot join the Hub. Talk to the Hub owner if you think that is a mistake.'
        };
      }
      if (already) {
        return {
          kind: 'already-member', login: login, changed: false, close: true,
          comment: '**@' + login + ' is already a member.**\n\n' + howToAddAGame(config)
        };
      }
      if (openMode) return addMember();
      return {
        kind: 'pending', login: login, changed: false, close: false,
        addLabel: LABEL_PENDING,
        comment: 'Thanks @' + login + '! The Hub owner has to approve new members. ' +
          'You will get a comment here the moment that happens - nothing else to do.'
      };
    }

    if (action === 'labeled') {
      const label = event.label && typeof event.label.name === 'string' ? event.label.name : '';
      if (label.toLowerCase() !== LABEL_APPROVED) return nothing('label "' + label + '" is not an approval');
      const sender = event.sender && typeof event.sender.login === 'string' ? event.sender.login : '';
      if (!sameLogin(sender, config.owner)) {
        return nothing('"' + LABEL_APPROVED + '" was added by ' + (sender || 'someone') +
          ', not the Hub owner');
      }
      if (isBlocked) {
        return {
          kind: 'refused', login: login, changed: false, close: true,
          comment: 'This account is on the block list, so the approval was not applied.'
        };
      }
      if (already) {
        return {
          kind: 'already-member', login: login, changed: false, close: true,
          comment: '**@' + login + ' is already a member.**\n\n' + howToAddAGame(config)
        };
      }
      return addMember();
    }

    return nothing('join issue, action "' + action + '" needs no work');
  }

  /* leave: only ever removes the author's own entry */
  if (action !== 'opened') return nothing('leave issue, action "' + action + '" needs no work');
  if (!already) {
    return {
      kind: 'not-a-member', login: login, changed: false, close: true,
      comment: '@' + login + ' was not on the members list, so there was nothing to remove.'
    };
  }
  const next = list.filter((m) => !sameLogin(m.login, login));
  return {
    kind: 'removed', login: login, changed: true, close: true,
    members: { members: next },
    comment: '@' + login + ' has been removed from the Hub members list. ' +
      'Your repos are untouched - they just stop showing up in the arcade. ' +
      'Open a Join issue any time to come back.'
  };
}

/* ---------- effects ---------- */

function makeEffects(opts) {
  const o = opts || {};
  const root = o.root;
  const repo = o.repo;
  const token = o.token;
  const api = 'https://api.github.com/repos/' + repo + '/issues/';

  async function post(url, body, method) {
    const r = await fetch(url, {
      method: method || 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'claude-hub-members',
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error('GitHub ' + r.status + ' ' + (await r.text()).slice(0, 300));
  }

  function git(args) {
    execFileSync('git', args, { cwd: root, stdio: 'inherit' });
  }

  return {
    async comment(number, text) {
      await post(api + number + '/comments', { body: text });
    },
    async addLabel(number, label) {
      await post(api + number + '/labels', { labels: [label] });
    },
    async closeIssue(number) {
      await post(api + number, { state: 'closed' }, 'PATCH');
    },
    async commitMembers(membersObj, message) {
      fs.writeFileSync(path.join(root, 'members.json'),
        JSON.stringify(membersObj, null, 2) + '\n');
      git(['config', 'user.name', BOT_NAME]);
      git(['config', 'user.email', BOT_EMAIL]);
      git(['add', '--', 'members.json']);
      const changed = execFileSync('git', ['status', '--porcelain', '--', 'members.json'],
        { cwd: root, encoding: 'utf8' }).trim();
      if (!changed) return false;
      git(['commit', '-m', message]);
      git(['push', 'origin', 'HEAD:main']);
      return true;
    }
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

async function run(opts) {
  const o = opts || {};
  const root = path.resolve(o.root || path.join(__dirname, '..'));
  const eventPath = o.eventPath || process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('no GITHUB_EVENT_PATH');
  const event = readJson(eventPath, null);
  if (!event) throw new Error('could not read the event file');

  const config = readJson(path.join(root, 'hub.config.json'), {});
  const membersFile = readJson(path.join(root, 'members.json'), { members: [] });
  const blocked = readJson(path.join(root, 'blocked.json'), { logins: [], repos: [] });

  const d = decide({
    event: event, config: config, membersFile: membersFile, blocked: blocked, now: o.now
  });

  const number = event.issue && Number(event.issue.number);
  const log = o.log || ((m) => console.log(m));
  log('decision: ' + d.kind + (d.why ? ' (' + d.why + ')' : '') + (d.login ? ' [' + d.login + ']' : ''));

  if (d.kind === 'ignored' || !Number.isFinite(number)) return d;

  const effects = o.effects || makeEffects({
    root: root,
    repo: o.repo || process.env.GITHUB_REPOSITORY,
    token: o.token || process.env.GITHUB_TOKEN
  });

  if (d.changed && d.members) {
    await effects.commitMembers(d.members,
      (d.kind === 'removed' ? 'Hub: remove member ' : 'Hub: add member ') + d.login +
      ' (issue #' + number + ')');
  }
  if (d.comment) await effects.comment(number, d.comment);
  if (d.addLabel) await effects.addLabel(number, d.addLabel);
  if (d.close) await effects.closeIssue(number);
  return d;
}

module.exports = { decide, run, makeEffects, labelNames, LABEL_JOIN, LABEL_LEAVE, LABEL_PENDING, LABEL_APPROVED };

if (require.main === module) {
  run({}).catch((e) => {
    console.error('handle-issue failed: ' + e.message);
    process.exit(1);
  });
}
