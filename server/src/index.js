/*
 * 손가락 배구 matchmaking + relay server (Cloudflare Workers + Durable Objects).
 *
 *   GET /match  (WebSocket)  join the queue; when a second player arrives both
 *                             receive {type:'matched', room, role}
 *   GET /room/:id?role=host|guest  (WebSocket)  relay between the two players
 *   GET /friend/:code  (WebSocket)  private room shared by link; the first to
 *                             arrive becomes host, the second guest
 *   /rank/*  (HTTP)  leaderboard: register, top, me, report (see Board)
 *
 * The host's browser runs the physics; the server only forwards messages, so
 * it stays tiny and cheap.
 */

const json = (obj) => JSON.stringify(obj);

function upgradeRequired() {
  return new Response('Expected a WebSocket upgrade', { status: 426 });
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};
function withCors(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname.startsWith('/rank/')) {
      if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));
      return withCors(await env.BOARD.get(env.BOARD.idFromName('global')).fetch(request));
    }
    if (request.headers.get('Upgrade') !== 'websocket') return upgradeRequired();

    if (url.pathname === '/match') {
      // A single lobby instance holds the queue.
      const id = env.LOBBY.idFromName('global');
      return env.LOBBY.get(id).fetch(request);
    }
    const m = url.pathname.match(/^\/room\/([a-f0-9]{16,64})$/);
    if (m) {
      const id = env.ROOM.idFromName(m[1]);
      return env.ROOM.get(id).fetch(request);
    }
    const f = url.pathname.match(/^\/friend\/([A-Z0-9]{4,8})$/);
    if (f) {
      const id = env.ROOM.idFromName(`friend-${f[1]}`);
      return env.ROOM.get(id).fetch(request);
    }
    return new Response('Not found', { status: 404 });
  },
};

export class Lobby {
  constructor(state, env) {
    this.env = env;
    this.waiting = null; // the one entry waiting for an opponent
  }

  async board(path, body) {
    const stub = this.env.BOARD.get(this.env.BOARD.idFromName('global'));
    const res = await stub.fetch(`https://board${path}`, { method: 'POST', body: JSON.stringify(body) });
    return res.ok ? res.json() : null;
  }

  async fetch(request) {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    // A signed-in client sends {type:'hello', pid, secret} first and plays for
    // rating; one that doesn't (or fails the check) is queued for a casual game.
    const entry = { ws: server, pid: null, info: null, queued: false };
    const queue = () => {
      if (entry.queued || server.readyState !== 1) return;
      entry.queued = true;
      this.enqueue(entry);
    };
    const timer = setTimeout(queue, 1500);
    server.addEventListener('message', async (e) => {
      if (entry.queued) return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type !== 'hello') return;
      clearTimeout(timer);
      const info = await this.board('/internal/auth', { pid: m.pid, secret: m.secret });
      if (info) { entry.pid = m.pid; entry.info = info; }
      queue();
    });
    const clear = () => { clearTimeout(timer); if (this.waiting === entry) this.waiting = null; };
    server.addEventListener('close', clear);
    server.addEventListener('error', clear);
    return new Response(null, { status: 101, webSocket: client });
  }

  async enqueue(entry) {
    const w = this.waiting;
    const same = w && entry.pid && w.pid === entry.pid;
    if (w && w.ws.readyState === 1 && !same) {
      this.waiting = null;
      const room = crypto.randomUUID().replace(/-/g, '');
      const ranked = !!(w.pid && entry.pid);
      if (ranked) await this.board('/internal/match', { room, a: w.pid, b: entry.pid });
      const view = (e) => ({ name: e.info.name, rating: e.info.rating, games: e.info.games });
      w.ws.send(json({ type: 'matched', room, role: 'host', ranked, opp: ranked ? view(entry) : null }));
      entry.ws.send(json({ type: 'matched', room, role: 'guest', ranked, opp: ranked ? view(w) : null }));
      // Both clients now reconnect to the room; close the lobby sockets.
      setTimeout(() => {
        try { w.ws.close(1000, 'matched'); } catch {}
        try { entry.ws.close(1000, 'matched'); } catch {}
      }, 500);
    } else {
      // The same player opening a second tab replaces the first.
      if (same) { try { w.ws.close(1000, 'replaced'); } catch {} }
      this.waiting = entry;
      entry.ws.send(json({ type: 'waiting' }));
    }
  }
}

export class Room {
  constructor(state) {
    this.state = state;
    this.peers = { host: null, guest: null };
  }

  async fetch(request) {
    const open = (ws) => ws && ws.readyState === 1;
    let role = new URL(request.url).searchParams.get('role');
    const autoRole = role === null;
    // Friend rooms hand out roles in arrival order.
    if (autoRole) role = !open(this.peers.host) ? 'host' : !open(this.peers.guest) ? 'guest' : null;

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    if (role === null) {
      server.send(json({ type: 'full' }));
      server.close(1000, 'full');
      return new Response(null, { status: 101, webSocket: client });
    }
    if (role !== 'host' && role !== 'guest') return new Response('Bad role', { status: 400 });
    if (autoRole) server.send(json({ type: 'role', role }));
    const other = role === 'host' ? 'guest' : 'host';
    this.peers[role] = server;

    server.addEventListener('message', (e) => {
      const peer = this.peers[other];
      if (peer && peer.readyState === 1) peer.send(e.data);
    });
    const leave = () => {
      if (this.peers[role] !== server) return;
      this.peers[role] = null;
      const peer = this.peers[other];
      if (peer && peer.readyState === 1) peer.send(json({ type: 'left' }));
    };
    server.addEventListener('close', leave);
    server.addEventListener('error', leave);

    // Tell both sides once the pair is complete.
    if (this.peers.host && this.peers.guest) {
      for (const ws of [this.peers.host, this.peers.guest]) {
        if (ws.readyState === 1) ws.send(json({ type: 'ready' }));
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }
}

// ---- Leaderboard -----------------------------------------------------------
//
// Players are anonymous: the browser makes a random id (public) and secret
// (kept private, only its SHA-256 is stored). Only matches the lobby paired
// as ranked can change ratings. Both players report who won; if they agree
// the result counts, if they contradict each other it is voided, and if only
// one reports (the other left) it counts after a short wait. A cheater can
// therefore only void a game, never steal one.

const START_RATING = 1000;
const K = 32;
const MIN_GAME_MS = 20_000;   // shorter than any real 5-point game: no change
const SOLO_REPORT_MS = 90_000; // wait this long for the other side's report
const STALE_MS = 3_600_000;
const PID_RE = /^[a-f0-9]{32}$/;
const SECRET_RE = /^[a-f0-9]{32,64}$/;

const reply = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function cleanName(raw) {
  const n = String(raw ?? '').replace(/[\u0000-\u001f\u007f<>&"']/g, '').replace(/\s+/g, ' ').trim().slice(0, 12);
  return n.length ? n : null;
}
const publicView = (p) => ({ name: p.name, rating: p.rating, wins: p.wins, losses: p.losses, games: p.games });

export class Board {
  constructor(state, env) {
    this.storage = state.storage;
    this.topCache = null;
    // Only `wrangler dev --var ...` sets these (to test without long waits).
    this.minGame = env.MIN_GAME_MS !== undefined ? Number(env.MIN_GAME_MS) : MIN_GAME_MS;
    this.soloWait = env.SOLO_REPORT_MS !== undefined ? Number(env.SOLO_REPORT_MS) : SOLO_REPORT_MS;
  }

  async player(pid) {
    return PID_RE.test(pid || '') ? this.storage.get(`p:${pid}`) : undefined;
  }
  async authed(pid, secret) {
    const p = await this.player(pid);
    if (!p || !SECRET_RE.test(secret || '')) return null;
    return (await sha256(secret)) === p.hash ? p : null;
  }
  async ranking() {
    const now = Date.now();
    if (this.topCache && now - this.topCache.at < 5000) return this.topCache.list;
    const all = await this.storage.list({ prefix: 'p:' });
    const list = [...all.entries()]
      .map(([k, p]) => ({ pid: k.slice(2), ...publicView(p) }))
      .filter((p) => p.games > 0)
      .sort((a, b) => b.rating - a.rating || b.wins - a.wins);
    this.topCache = { at: now, list };
    return list;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const body = request.method === 'POST' ? await request.json().catch(() => null) : null;

    if (path === '/rank/top') {
      const list = await this.ranking();
      return reply({ total: list.length, top: list.slice(0, 30) });
    }
    if (path === '/rank/me') {
      const pid = url.searchParams.get('pid');
      const p = await this.player(pid);
      if (!p) return reply({ error: 'unknown' }, 404);
      const list = await this.ranking();
      const idx = list.findIndex((x) => x.pid === pid);
      return reply({ ...publicView(p), rank: idx < 0 ? null : idx + 1, total: list.length });
    }
    if (request.method !== 'POST' || !body) return reply({ error: 'bad request' }, 400);

    if (path === '/rank/register') {
      const name = cleanName(body.name);
      if (!name || !PID_RE.test(body.pid || '') || !SECRET_RE.test(body.secret || '')) return reply({ error: 'bad input' }, 400);
      const existing = await this.player(body.pid);
      if (existing) {
        if ((await sha256(body.secret)) !== existing.hash) return reply({ error: 'forbidden' }, 403);
        existing.name = name;
        await this.storage.put(`p:${body.pid}`, existing);
        this.topCache = null;
        return reply(publicView(existing));
      }
      const p = { name, hash: await sha256(body.secret), rating: START_RATING, wins: 0, losses: 0, games: 0 };
      await this.storage.put(`p:${body.pid}`, p);
      return reply(publicView(p));
    }
    if (path === '/internal/auth') {
      const p = await this.authed(body.pid, body.secret);
      return p ? reply(publicView(p)) : reply({ error: 'forbidden' }, 403);
    }
    if (path === '/internal/match') {
      if (!PID_RE.test(body.a || '') || !PID_RE.test(body.b || '') || body.a === body.b) return reply({ error: 'bad' }, 400);
      await this.storage.put(`m:${body.room}`, { a: body.a, b: body.b, at: Date.now(), rep: {} });
      await this.ensureAlarm();
      return reply({ ok: true });
    }
    if (path === '/rank/report') {
      const p = await this.authed(body.pid, body.secret);
      if (!p) return reply({ error: 'forbidden' }, 403);
      if (body.result !== 'win' && body.result !== 'loss') return reply({ error: 'bad result' }, 400);
      const key = `m:${body.room}`;
      const m = await this.storage.get(key);
      if (!m || (m.a !== body.pid && m.b !== body.pid)) return reply({ error: 'unknown match' }, 404);
      if (!m.rep[body.pid]) m.rep[body.pid] = { result: body.result, at: Date.now() };
      if (m.rep[m.a] && m.rep[m.b]) await this.settle(key, m);
      else { await this.storage.put(key, m); await this.ensureAlarm(); }
      return reply({ ok: true });
    }
    return reply({ error: 'not found' }, 404);
  }

  async ensureAlarm() {
    if (!(await this.storage.getAlarm())) await this.storage.setAlarm(Date.now() + Math.min(30_000, this.soloWait));
  }
  // Settle one-sided reports once the wait is over; drop matches nobody reported.
  async alarm() {
    const now = Date.now();
    const all = await this.storage.list({ prefix: 'm:' });
    let pending = false;
    for (const [key, m] of all) {
      const reps = [m.rep[m.a], m.rep[m.b]].filter(Boolean);
      if (reps.length && now - Math.min(...reps.map((r) => r.at)) >= this.soloWait) await this.settle(key, m);
      else if (!reps.length && now - m.at > STALE_MS) await this.storage.delete(key);
      else pending = true;
    }
    if (pending) await this.storage.setAlarm(now + Math.min(30_000, this.soloWait));
  }

  async settle(key, m) {
    await this.storage.delete(key);
    const ra = m.rep[m.a]?.result, rb = m.rep[m.b]?.result;
    let winner = null;
    if (ra && rb) winner = ra === 'win' && rb === 'loss' ? m.a : ra === 'loss' && rb === 'win' ? m.b : null; // contradiction: void
    else if (ra) winner = ra === 'win' ? m.a : m.b;
    else if (rb) winner = rb === 'win' ? m.b : m.a;
    const reportedAt = Math.min(...[m.rep[m.a], m.rep[m.b]].filter(Boolean).map((r) => r.at));
    if (!winner || reportedAt - m.at < this.minGame) return;
    const loser = winner === m.a ? m.b : m.a;
    const w = await this.storage.get(`p:${winner}`), l = await this.storage.get(`p:${loser}`);
    if (!w || !l) return;
    const expected = 1 / (1 + 10 ** ((l.rating - w.rating) / 400));
    const delta = Math.round(K * (1 - expected));
    w.rating += delta; w.wins++; w.games++;
    l.rating = Math.max(100, l.rating - delta); l.losses++; l.games++;
    await this.storage.put(`p:${winner}`, w);
    await this.storage.put(`p:${loser}`, l);
    this.topCache = null;
  }
}
