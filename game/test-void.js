'use strict';
// 专门验证「四家换出同花色 -> 本局作废重开」：机器人尽量都换万子，直到触发 void。
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const suit = t => t[0];
const sorted = h => { const o = { m: 0, p: 1, s: 2 }; return h.slice().sort((a, b) => o[suit(a)] - o[suit(b)] || (+a.slice(1) - +b.slice(1))); };
function exchangeSuit(hand) { const c = { m: 0, p: 0, s: 0 }; hand.forEach(t => c[suit(t)]++); let b = null; ['m','p','s'].forEach(s => { if (c[s] >= 3 && (b === null || c[s] < c[b])) b = s; }); return b || 'm'; }
function minSuit(hand) { const c = { m: 0, p: 0, s: 0 }; hand.forEach(t => c[suit(t)]++); let b = 'm'; ['m','p','s'].forEach(s => { if (c[s] < c[b]) b = s; }); return b; }
let hit = false;
function bot(i) {
  const sock = io(URL, { transports: ['websocket'] });
  sock.on('connect', () => setTimeout(() => sock.emit('join', { name: 'V' + i }), 80 + i * 50));
  sock.on('state', S => {
    if (!S.self) return;
    if (S.phase === 'void') {
      if (!hit) { hit = true; console.log('PASS 触发换撞作废：' + S.voidText); setTimeout(() => process.exit(0), 400); }
      return;
    }
    const a = S.self.actionable;
    if (S.phase === 'idle') { const me = S.players[S.selfSeat]; if (!me.ready) sock.emit('ready'); }
    if (!a) return;
    if (a.mode === 'exchange') {
      if (S.self.pick) return;
      const m = S.self.hand.filter(t => suit(t) === 'm');
      let tiles;
      if (m.length >= 3) tiles = sorted(m).slice(0, 3);
      else { const s = exchangeSuit(S.self.hand); tiles = sorted(S.self.hand.filter(t => suit(t) === s)).slice(0, 3); }
      sock.emit('exchange', { tiles });
    } else if (a.mode === 'lack') sock.emit('lack', { suit: minSuit(S.self.hand) });
    else if (a.mode === 'turn') {
      if (a.canSelfWin) return sock.emit('selfWin');
      let pool = S.self.hand; if (a.mustSuit) pool = pool.filter(t => suit(t) === a.mustSuit);
      const t = pool[0] || S.self.hand[0]; sock.emit('discard', { tile: t });
    } else if (a.mode === 'ask') {
      if (a.canHu) sock.emit('act', { type: 'hu' }); else sock.emit('act', { type: 'pass' });
    }
  });
}
for (let i = 0; i < 4; i++) bot(i);
setTimeout(() => { console.log(hit ? 'PASS' : 'FAIL：60秒内未触发换撞'); process.exit(hit ? 0 : 1); }, 60000);
