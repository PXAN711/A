'use strict';
// 端到端冒烟：4 个机器人自动打 N 局，校验状态机不卡死、豆子守恒。
// 用法：先启动 node server.js，再 node game/sim.js
const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3000';
const SUITS = ['m', 'p', 's'];
const suit = t => t[0];
const sorted = h => {
  const o = { m: 0, p: 1, s: 2 };
  return h.slice().sort((a, b) => o[suit(a)] - o[suit(b)] || (+a.slice(1) - +b.slice(1)));
};
function exchangeSuit(hand) {
  const c = { m: 0, p: 0, s: 0 }; hand.forEach(t => c[suit(t)]++);
  let best = null;
  SUITS.forEach(s => { if (c[s] >= 3 && (best === null || c[s] < c[best])) best = s; });
  return best || 'm';
}
function minSuit(hand) {
  const c = { m: 0, p: 0, s: 0 }; hand.forEach(t => c[suit(t)]++);
  let b = 'm'; SUITS.forEach(s => { if (c[s] < c[b]) b = s; }); return b;
}

const TARGET = parseInt(process.env.TARGET || '8', 10);
// 简易牌效：评估去掉某张后剩余手牌的搭子价值
function score(h) {
  const c = { m: Array(10).fill(0), p: Array(10).fill(0), s: Array(10).fill(0) };
  h.forEach(t => c[suit(t)][+t.slice(1)]++);
  let sc = 0;
  for (const s of SUITS) {
    const a = c[s];
    for (let n = 1; n <= 9; n++) {
      if (a[n] >= 3) sc += 3; else if (a[n] === 2) sc += 2;
      if (n <= 7 && a[n] && a[n + 1] && a[n + 2]) sc += 3;
      else if (n <= 8 && a[n] && a[n + 1]) sc += 1;
    }
  }
  return sc;
}
function bestDiscard(hand) {
  let best = null, bs = -1e9;
  for (const t of [...new Set(hand)]) {
    const h = hand.slice(); h.splice(h.indexOf(t), 1);
    const v = score(h) + Math.random() * 0.4;
    if (v > bs) { bs = v; best = t; }
  }
  return best;
}
let settled = 0; const sums = []; const reasons = {};
const seenLogs = new Set();
const t0 = Date.now();

function bot(i) {
  const sock = io(URL, { transports: ['websocket'] });
  let prev = null;
  sock.on('connect', () => setTimeout(() => sock.emit('join', { name: 'B' + i }), 80 + i * 60));
  sock.on('state', S => {
    if (!S.self) return;
    S.logs.forEach(l => seenLogs.add(l.msg));
    if (S.phase === 'settle' && prev !== 'settle') {
      const sum = S.result.rows.filter(Boolean).reduce((a, r) => a + r.beans, 0);
      sums.push(sum); reasons[S.result.reason] = (reasons[S.result.reason] || 0) + 1;
      settled++;
      console.log(`第${settled}局结束 reason=${S.result.reason} 豆子合计=${sum} | ${S.result.notes.join('；')}`);
      setTimeout(() => sock.emit('ready'), 300);
    }
    prev = S.phase;
    setTimeout(() => act(sock, S), 10);
  });
  sock.on('error_msg', () => {});
}
function act(sock, S) {
  const self = S.self, a = self.actionable;
  if (S.phase === 'idle') { const me = S.players[S.selfSeat]; if (!me.ready) sock.emit('ready'); return; }
  if (!a) return;
  if (a.mode === 'exchange') {
    if (self.pick) return;
    const s = exchangeSuit(self.hand);
    const tiles = sorted(self.hand.filter(t => suit(t) === s)).slice(0, 3);
    if (tiles.length === 3) sock.emit('exchange', { tiles });
    return;
  }
  if (a.mode === 'lack') { if (!self.lack) sock.emit('lack', { suit: minSuit(self.hand) }); return; }
  if (a.mode === 'turn') {
    if (a.canSelfWin) return sock.emit('selfWin');
    if (a.anKongs && a.anKongs.length) return sock.emit('selfKong', { type: 'an', tile: a.anKongs[0] });
    if (a.buKongs && a.buKongs.length) return sock.emit('selfKong', { type: 'bu', tile: a.buKongs[0] });
    if (a.mustSuit) {
      const pool = self.hand.filter(t => suit(t) === a.mustSuit);
      const t = (pool.length ? pool : self.hand)[0];
      if (t) sock.emit('discard', { tile: t });
      return;
    }
    const t = bestDiscard(self.hand);
    if (t) sock.emit('discard', { tile: t });
    return;
  }
  if (a.mode === 'ask') {
    if (a.canHu) return sock.emit('act', { type: 'hu' });
    if (a.canGang) return sock.emit('act', { type: 'gang' });
    if (a.canPeng && Math.random() < 0.8) return sock.emit('act', { type: 'peng' });
    return sock.emit('act', { type: 'pass' });
  }
  if (a.mode === 'rob') return sock.emit('act', { type: 'hu' });
}
for (let i = 0; i < 4; i++) bot(i);

const iv = setInterval(() => {
  if (settled >= TARGET) {
    clearInterval(iv);
    const ok = sums.every(x => x === 200);
    console.log(`\n完成 ${settled} 局，结束路径=${JSON.stringify(reasons)}`);
    console.log(`豆子守恒(每局合计=200): ${ok ? 'PASS' : 'FAIL ' + sums.join(',')}`);
    const all = [...seenLogs];
    const kw = ['碰', '暗杠', '明杠', '补杠', '抢杠胡', '自摸', '付', '花猪', '查叫', '作废'];
    for (const k of kw) {
      const hit = all.filter(m => m.includes(k));
      console.log(`  事件[${k}] 出现 ${hit.length} 次${hit.length ? '，例：' + hit[0] : ''}`);
    }
    console.log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.exit(ok ? 0 : 1);
  }
}, 100);
setTimeout(() => { console.log('超时，仅完成 ' + settled + ' 局'); process.exit(2); }, 90000);
