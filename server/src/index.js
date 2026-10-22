/*
 * 손가락 배구 matchmaking + relay server (Cloudflare Workers + Durable Objects).
 *
 *   GET /match  (WebSocket)  join the queue; when a second player arrives both
 *                             receive {type:'matched', room, role}
 *   GET /room/:id?role=host|guest  (WebSocket)  relay between the two players
 *   GET /friend/:code  (WebSocket)  private room shared by link; the first to
 *                             arrive becomes host, the second guest
 *
 * The host's browser runs the physics; the server only forwards messages, so
 * it stays tiny and cheap.
 */

const json = (obj) => JSON.stringify(obj);

function upgradeRequired() {
  return new Response('Expected a WebSocket upgrade', { status: 426 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
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
  constructor(state) {
    this.state = state;
    this.waiting = null; // the one socket waiting for an opponent
  }

  async fetch(request) {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    const waiting = this.waiting;
    if (waiting && waiting.readyState === 1) {
      this.waiting = null;
      const room = crypto.randomUUID().replace(/-/g, '');
      waiting.send(json({ type: 'matched', room, role: 'host' }));
      server.send(json({ type: 'matched', room, role: 'guest' }));
      // Both clients now reconnect to the room; close the lobby sockets.
      setTimeout(() => {
        try { waiting.close(1000, 'matched'); } catch {}
        try { server.close(1000, 'matched'); } catch {}
      }, 500);
    } else {
      this.waiting = server;
      server.send(json({ type: 'waiting' }));
      const clear = () => { if (this.waiting === server) this.waiting = null; };
      server.addEventListener('close', clear);
      server.addEventListener('error', clear);
    }
    return new Response(null, { status: 101, webSocket: client });
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
