'use strict';
/*
 * 局域网四人「换三张」麻将（四川血战到底）
 * 固定一桌 / 进房先建ID / 每人50豆 / 服务端权威
 */
const http = require('http');
const path = require('path');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');
const T = require('./game/tiles');
const R = require('./game/rule');
const { SUITS, SUIT_NAME, suitOf, makeDeck, sortTiles } = T;

const PORT = process.env.PORT || 3000;
const BASE = 1;                 // 底注 = 1 豆
const START_BEANS = 50;          // 每人初始豆子
const TIME = { exchange: 30000, lack: 20000, turn: 25000, ask: 10000, rob: 10000 };
const HUA_PENALTY = 6;           // 花猪赔付倍数（按最大番清一色 x6）

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/favicon.ico', (req, res) => res.status(204).end());
const server = http.createServer(app);
const io = new Server(server);

function freshTable() {
  return {
    phase: 'idle',          // idle | exchange | lack | playing | settle | void
    players: [null, null, null, null],
    dealer: 0, firstWinner: null, winOrder: 0, round: 0,
    wall: [], current: null, drew: false,
    dice: null, dir: null,
    lastDiscard: null, pending: null, rob: null,
    timers: {}, botTimers: {}, logs: [], result: null, voidText: '',
  };
}
const game = freshTable();
const socketSeat = new Map();
const lobbyGuests = new Map();                 // 已登录未入座：socketId -> 名字

// ---------------- 工具 ----------------
function newPlayer(seat, name, socketId, isBot = false) {
  return {
    seat, name, socketId, online: true, beans: START_BEANS, ready: false,
    hand: [], melds: [], discards: [], lack: null, pick: null,
    won: null, delta: 0, isBot,
  };
}
function setTimer(key, ms, fn) {
  clearTimer(key);
  game.timers[key] = setTimeout(fn, ms);
}
function clearTimer(key) {
  if (game.timers[key]) { clearTimeout(game.timers[key]); game.timers[key] = null; }
}
function clearAllTimers() { Object.keys(game.timers).forEach(clearTimer); }
function addLog(msg) {
  game.logs.push({ msg, t: Date.now() });
  if (game.logs.length > 60) game.logs.shift();
}
function pay(from, to, amount, reason) {
  if (from == null || to == null || from === to || !amount) return;
  const a = game.players[from], b = game.players[to];
  if (!a || !b) return;
  a.beans -= amount; b.beans += amount; a.delta -= amount; b.delta += amount;
}
function clearedLack(p) { return !!p.lack && !p.hand.some(t => suitOf(t) === p.lack); }
function nextLiveSeat(from) {
  for (let i = 1; i <= 4; i++) {
    const s = (from + i) % 4; const p = game.players[s];
    if (p && !p.won) return s;
  }
  return null;
}
function liveOthers(seat) {
  const out = [];
  for (let i = 0; i < 4; i++) { const p = game.players[i]; if (p && !p.won && i !== seat) out.push(i); }
  return out;
}
function minSuit(p) {
  const cnt = { m: 0, p: 0, s: 0 };
  for (const t of p.hand) cnt[suitOf(t)]++;
  let best = 'm';
  for (const s of SUITS) if (cnt[s] < cnt[best]) best = s;
  return best;
}
// 换三张自动选牌：必须选出 3 张同色，故取「张数>=3 的花色中最少」的那门
function exchangeSuit(hand) {
  const cnt = { m: 0, p: 0, s: 0 };
  for (const t of hand) cnt[suitOf(t)]++;
  let best = null;
  for (const s of SUITS) if (cnt[s] >= 3 && (best === null || cnt[s] < cnt[best])) best = s;
  return best || 'm';
}

// ---------------- 内置人机（Bot） ----------------
const BOT_DELAY = { ready: 400, exchange: 600, lack: 600, turn: 650, ask: 500 };
function botSchedule(seat, ms) {
  if (game.botTimers[seat]) return;
  game.botTimers[seat] = setTimeout(() => {
    game.botTimers[seat] = null;
    try { botAct(seat); } catch (e) { console.log('bot error', seat, e); }
  }, ms);
}
function botClear(seat) {
  if (game.botTimers[seat]) { clearTimeout(game.botTimers[seat]); game.botTimers[seat] = null; }
}
// 每次状态广播后驱动所有需要行动的人机
function driveBots() {
  for (let s = 0; s < 4; s++) {
    const p = game.players[s];
    if (!p || !p.isBot) continue;
    if (game.phase === 'idle' || game.phase === 'settle') {
      if (!p.ready) botSchedule(s, BOT_DELAY.ready);
      continue;
    }
    if (p.won) continue;
    const a = actionable(p, true);
    if (a.mode === 'exchange' && !p.pick) botSchedule(s, BOT_DELAY.exchange);
    else if (a.mode === 'lack' && !p.lack) botSchedule(s, BOT_DELAY.lack);
    else if (a.mode === 'turn') botSchedule(s, BOT_DELAY.turn);
    else if (a.mode === 'ask' || a.mode === 'rob') botSchedule(s, BOT_DELAY.ask);
  }
}
// 人机出牌选择：优先打缺门；打缺后选「打出后听牌面最宽」的牌，并列优先边张孤张
function botPickDiscard(p) {
  const choices = p.hand.filter(t => clearedLack(p) || suitOf(t) === p.lack);
  if (!choices.length) return sortTiles(p.hand)[0];
  if (!clearedLack(p)) return sortTiles(choices)[0];
  let best = null, bestScore = -1;
  for (const t of sortTiles(choices)) {
    const rest = removeTiles(p.hand, [t]);
    let waits = 0;
    try { waits = R.findWaits(rest, p.melds).length; } catch (_) { waits = 0; }
    const r = +String(t).slice(1);
    const edge = (r === 1 || r === 9) ? 0.5 : 0;     // 边张优先弃
    const score = waits * 10 + edge - r * 0.01;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best || choices[0];
}
function botAct(seat) {
  const p = game.players[seat];
  if (!p || !p.isBot) return;
  // 准备
  if (game.phase === 'idle' || game.phase === 'settle') {
    if (!p.ready) {
      p.ready = !p.ready;
      const seated = game.players.filter(x => x);
      if (seated.length === 4 && seated.every(x => x.ready && x.online)) return startGame();
      return broadcast();
    }
    return;
  }
  if (p.won) return;
  const a = actionable(p, true);
  if (a.mode === 'exchange' && !p.pick) {
    const su = exchangeSuit(p.hand);
    p.pick = sortTiles(p.hand.filter(t => suitOf(t) === su)).slice(0, 3);
    if (game.players.every(x => x && x.pick)) return doExchange();
    return broadcast();
  }
  if (a.mode === 'lack' && !p.lack) {
    p.lack = minSuit(p);
    if (game.players.every(x => x && x.lack)) return beginPlay();
    return broadcast();
  }
  if (a.mode === 'ask') {
    if (a.canHu) return onAct(seat, 'hu');
    if (a.canGang) return onAct(seat, 'gang');
    if (a.canPeng) return onAct(seat, 'peng');
    return onAct(seat, 'pass');
  }
  if (a.mode === 'rob') return onRobAct(seat, 'hu');   // 能抢杠胡就胡
  if (a.mode !== 'turn') return;
  if (a.canSelfWin) return onSelfWin(seat);
  if (a.anKongs && a.anKongs.length) return onSelfKong(seat, 'an', a.anKongs[0]);
  if (a.buKongs && a.buKongs.length) return onSelfKong(seat, 'bu', a.buKongs[0]);
  return doDiscard(seat, botPickDiscard(p), true);
}

// ---------------- 开局流程 ----------------
function startGame() {
  game.round++;
  clearAllTimers();
  game.wall = makeDeck();
  game.current = null; game.drew = false; game.pending = null; game.rob = null;
  game.lastDiscard = null; game.result = null; game.winOrder = 0; game.voidText = '';
  if (game.firstWinner != null) { game.dealer = game.firstWinner; game.firstWinner = null; }
  for (const p of game.players) {
    if (!p) continue;
    p.hand = []; p.melds = []; p.discards = []; p.lack = null; p.pick = null;
    p.won = null; p.delta = 0; p.ready = false;
  }
  // 发牌：每人13张
  for (let i = 0; i < 13; i++)
    for (let s = 0; s < 4; s++)
      if (game.players[s]) game.players[s].hand.push(game.wall.shift());
  for (const p of game.players) if (p) p.hand = sortTiles(p.hand);
  // 掷骰定换牌方向
  game.dice = R.rollTwoDice();
  game.dir = R.exchangeDirectionByDice(game.dice.sum);
  game.phase = 'exchange';
  addLog(`第${game.round}局开始，骰子${game.dice.a}+${game.dice.b}=${game.dice.sum}，换牌方向：${game.dir.label}`);
  setTimer('exchange', TIME.exchange, autoExchangeAll);
  broadcast();
}

function autoExchangeAll() {
  for (const p of game.players) {
    if (p && !p.pick) {
      const s = exchangeSuit(p.hand);
      p.pick = sortTiles(p.hand.filter(t => suitOf(t) === s)).slice(0, 3);
    }
  }
  doExchange();
}

function doExchange() {
  const ps = game.players;
  if (ps.some(p => p && !p.pick)) return;
  clearTimer('exchange');
  // 四家换出同花色 -> 本局作废重开（换撞）
  const suit0 = suitOf(ps[0].pick[0]);
  const allSame = ps.every(p => p && p.pick.every(t => suitOf(t) === suit0));
  if (allSame) {
    game.phase = 'void';
    game.voidText = `四家换出同为「${SUIT_NAME[suit0]}」，本局不作数，重新开局`;
    addLog(game.voidText);
    broadcast();
    setTimer('restart', 2200, startGame);
    return;
  }
  // 按方向交换：先统一拿出，再统一送达（避免边删边收污染手牌）
  const sent = ps.map(p => p.pick.slice());
  const afterRemove = ps.map(p => removeTiles(p.hand, sent[p.seat]));
  for (let s = 0; s < 4; s++) ps[s].hand = afterRemove[s];
  for (let s = 0; s < 4; s++) {
    const target = R.receiverOf(s, game.dir.dir);
    ps[target].hand = sortTiles(ps[target].hand.concat(sent[s]));
  }
  for (const p of ps) { p.pick = null; }
  game.phase = 'lack';
  addLog('换牌完成，请各自定缺');
  setTimer('lack', TIME.lack, autoLackAll);
  broadcast();
}
// 按张精确移除（处理重复牌）
function removeTiles(hand, tiles) {
  const h = hand.slice();
  for (const t of tiles) { const i = h.indexOf(t); if (i >= 0) h.splice(i, 1); }
  return h;
}
function autoLackAll() {
  for (const p of game.players) if (p && !p.lack) p.lack = minSuit(p);
  beginPlay();
}
function beginPlay() {
  const ps = game.players;
  if (ps.some(p => p && !p.lack)) return;
  clearTimer('lack');
  game.phase = 'playing';
  // 庄家补第14张并先出
  const d = ps[game.dealer];
  d.hand.push(game.wall.shift()); d.hand = sortTiles(d.hand);
  game.current = game.dealer; game.drew = true;
  addLog(`${d.name} 坐庄，出牌`);
  setTimer('turn', TIME.turn, () => autoDiscard(game.current));
  broadcast();
}

// ---------------- 摸牌/出牌 ----------------
function advanceDraw(afterSeat) {
  game.pending = null; game.rob = null; game.lastDiscard = null;
  const s = nextLiveSeat(afterSeat);
  if (s == null) return endGame('threeWins');
  if (game.wall.length === 0) return endGame('wall');
  const p = game.players[s];
  const t = game.wall.shift();
  p.hand.push(t); p.hand = sortTiles(p.hand);
  game.current = s; game.drew = true;
  setTimer('turn', TIME.turn, () => autoDiscard(game.current));
  broadcast();
}
function autoDiscard(seat) {
  if (game.phase !== 'playing' || game.current !== seat) return;
  const p = game.players[seat]; if (!p || p.won) return;
  let t;
  if (p.lack && p.hand.some(x => suitOf(x) === p.lack)) t = sortTiles(p.hand.filter(x => suitOf(x) === p.lack))[0];
  else t = sortTiles(p.hand)[0];
  doDiscard(seat, t, true);
}
function doDiscard(seat, tile, silent) {
  if (game.phase !== 'playing' || game.current !== seat) return err(seat, '还没轮到你出牌');
  const p = game.players[seat];
  if (p.won) return err(seat, '你已胡牌');
  if (!p.hand.includes(tile)) return err(seat, '没有这张牌');
  if (!clearedLack(p) && suitOf(tile) !== p.lack) return err(seat, '必须先把缺门牌打干净');
  clearTimer('turn');
  p.hand = removeTiles(p.hand, [tile]);
  p.discards.push(tile);
  game.lastDiscard = { seat, tile }; game.drew = false;
  addLog(`${p.name} 打出 ${T.tileName(tile)}`);
  // 询问其他三家
  const ask = { from: seat, tile, hu: [], gang: [], peng: [], resp: {} };
  for (let q = 0; q < 4; q++) {
    const o = game.players[q];
    if (!o || o.won || q === seat || !clearedLack(o)) continue;
    const c = o.hand.filter(x => x === tile).length;
    if (R.canWin(o.hand.concat(tile), o.melds).win) ask.hu.push(q);
    if (c >= 3) ask.gang.push(q);
    else if (c >= 2) ask.peng.push(q);
  }
  const candidates = [...new Set([...ask.hu, ...ask.gang, ...ask.peng])];
  if (candidates.length === 0) return advanceDraw(seat);
  game.pending = ask;
  setTimer('ask', TIME.ask, resolvePending);
  broadcast();
}

function onAct(seat, type) {
  if (game.rob) return onRobAct(seat, type);
  const ask = game.pending;
  if (!ask) return;
  const valid = [...ask.hu, ...ask.gang, ...ask.peng];
  if (!valid.includes(seat)) return;
  if (type === 'hu' && !ask.hu.includes(seat)) return err(seat, '你不能胡这张');
  if (type === 'gang' && !ask.gang.includes(seat)) return err(seat, '你不能杠这张');
  if (type === 'peng' && !ask.peng.includes(seat)) return err(seat, '你不能碰这张');
  ask.resp[seat] = type;
  maybeResolvePending();
}
function maybeResolvePending() {
  const ask = game.pending; if (!ask) return;
  const huDecided = ask.hu.every(s => ask.resp[s]);           // 所有可胡者都已选择
  const declaredHu = ask.hu.filter(s => ask.resp[s] === 'hu');
  if (declaredHu.length && huDecided) return resolvePending();
  if (huDecided && declaredHu.length === 0) {
    if (ask.gang.some(s => ask.resp[s] === 'gang')) return resolvePending();
    if (ask.peng.some(s => ask.resp[s] === 'peng')) return resolvePending();
    const all = [...ask.hu, ...ask.gang, ...ask.peng];
    if (all.every(s => ask.resp[s])) return resolvePending();
  }
  broadcast();
}
function resolvePending() {
  clearTimer('ask');
  const ask = game.pending;
  if (!ask) return;
  const declaredHu = ask.hu.filter(s => ask.resp[s] === 'hu');
  const declaredGang = ask.gang.filter(s => ask.resp[s] === 'gang');
  const declaredPeng = ask.peng.filter(s => ask.resp[s] === 'peng');
  if (declaredHu.length) { doWin(declaredHu, ask.from, false, false); return; }
  if (declaredGang.length) { doMingGang(declaredGang[0]); return; }
  if (declaredPeng.length) { doPeng(declaredPeng[0]); return; }
  advanceDraw(ask.from);
}

function doPeng(seat) {
  const ask = game.pending; const tile = ask.tile, from = ask.from;
  const p = game.players[seat], f = game.players[from];
  f.discards.pop();
  p.hand = removeTiles(p.hand, [tile, tile]);
  p.melds.push({ type: 'peng', tiles: [tile, tile, tile] });
  game.pending = null; game.lastDiscard = null;
  game.current = seat; game.drew = false;
  addLog(`${p.name} 碰 ${T.tileName(tile)}`);
  setTimer('turn', TIME.turn, () => autoDiscard(game.current));
  broadcast();
}
function doMingGang(seat) {
  const ask = game.pending; const tile = ask.tile, from = ask.from;
  const p = game.players[seat], f = game.players[from];
  f.discards.pop();
  p.hand = removeTiles(p.hand, [tile, tile, tile]);
  p.melds.push({ type: 'minggang', tiles: [tile, tile, tile, tile] });
  game.pending = null; game.lastDiscard = null;
  pay(from, seat, 2 * BASE, '明杠');
  addLog(`${p.name} 明杠，${f.name} 付 2 豆`);
  kongDraw(seat);
}
// 自己回合：暗杠 / 补杠
function onSelfKong(seat, type, tile) {
  if (game.phase !== 'playing' || game.current !== seat || !game.drew) return err(seat, '现在不能杠');
  const p = game.players[seat]; if (p.won || !clearedLack(p)) return err(seat, '还没打缺，不能杠');
  if (type === 'an') {
    if (p.hand.filter(x => x === tile).length !== 4) return err(seat, '暗杠需要4张相同');
    p.hand = removeTiles(p.hand, [tile, tile, tile, tile]);
    p.melds.push({ type: 'angang', tiles: [tile, tile, tile, tile] });
    for (const q of liveOthers(seat)) pay(q, seat, 2 * BASE, '暗杠');
    addLog(`${p.name} 暗杠 ${T.tileName(tile)}，其余各付 2 豆`);
    return kongDraw(seat);
  }
  if (type === 'bu') {
    const meld = p.melds.find(m => m.type === 'peng' && m.tiles[0] === tile);
    if (!meld || !p.hand.includes(tile)) return err(seat, '没有可补的杠');
    // 抢杠胡检查
    const cands = [];
    for (let q = 0; q < 4; q++) {
      const o = game.players[q];
      if (!o || o.won || q === seat || !clearedLack(o)) continue;
      if (R.findWaits(o.hand, o.melds).includes(tile)) cands.push(q);
    }
    if (cands.length) {
      clearTimer('turn');
      game.rob = { from: seat, tile, cands, resp: {}, meld };
      setTimer('rob', TIME.rob, resolveRob);
      addLog(`${p.name} 补杠，等待抢杠胡判定`);
      return broadcast();
    }
    finishBuGang(seat, meld);
  }
}
function onRobAct(seat, type) {
  const rob = game.rob; if (!rob || !rob.cands.includes(seat)) return;
  rob.resp[seat] = type === 'hu' ? 'hu' : 'pass';
  if (type === 'hu') return resolveRob();
  if (rob.cands.every(s => rob.resp[s])) resolveRob();
  else broadcast();
}
function resolveRob() {
  clearTimer('rob');
  const rob = game.rob; if (!rob) return;
  const hu = rob.cands.filter(s => rob.resp[s] === 'hu');
  if (hu.length) {
    const from = rob.from;
    // 补杠失败：那张牌从补杠者手里移除，作为点炮牌
    const fp = game.players[from];
    fp.hand = removeTiles(fp.hand, [rob.tile]);
    fp.discards.push(rob.tile);
    game.rob = null; game.lastDiscard = { seat: from, tile: rob.tile };
    addLog(`${game.players[hu[0]].name} 抢杠胡！`);
    return doWin(hu, from, false, true);
  }
  const meld = rob.meld; game.rob = null;
  finishBuGang(rob.from, meld);
}
function finishBuGang(seat, meld) {
  const p = game.players[seat];
  p.hand = removeTiles(p.hand, [meld.tiles[0]]);
  meld.type = 'bugang'; meld.tiles = [meld.tiles[0], meld.tiles[0], meld.tiles[0], meld.tiles[0]];
  for (const q of liveOthers(seat)) pay(q, seat, 1 * BASE, '补杠');
  addLog(`${p.name} 补杠，其余各付 1 豆`);
  kongDraw(seat);
}
function kongDraw(seat) {
  game.current = seat; game.drew = true;
  if (game.wall.length === 0) return endGame('wall');
  const p = game.players[seat];
  const t = game.wall.pop(); // 杠从牌墙尾补
  p.hand.push(t); p.hand = sortTiles(p.hand);
  setTimer('turn', TIME.turn, () => autoDiscard(game.current));
  broadcast();
}
function onSelfWin(seat) {
  if (game.phase !== 'playing' || game.current !== seat || !game.drew) return err(seat, '现在不能胡');
  const p = game.players[seat];
  if (p.won || !clearedLack(p) || !R.canWin(p.hand, p.melds).win) return err(seat, '当前不能自摸');
  doWin([seat], seat, true, false);
}

// ---------------- 胡牌与血战 ----------------
function doWin(winSeats, from, selfDraw, robbed) {
  clearTimer('turn'); clearTimer('ask'); clearTimer('rob');
  game.pending = null;
  for (const seat of winSeats) {
    const p = game.players[seat];
    let finalHand = p.hand.slice(), winTile = null;
    if (!selfDraw) {
      winTile = robbed ? game.players[from].discards[game.players[from].discards.length - 1] : game.lastDiscard.tile;
      if (!robbed) game.players[from].discards.pop();
      finalHand = sortTiles(p.hand.concat(winTile));
    } else { finalHand = sortTiles(finalHand); winTile = finalHand[finalHand.length - 1]; }
    const fan = R.calcFan(finalHand, p.melds);
    p.won = { order: ++game.winOrder, mult: fan.mult, names: fan.names, tile: winTile, selfDraw, finalHand };
    if (selfDraw) {
      for (const q of liveOthers(seat)) { pay(q, seat, fan.mult * BASE, '自摸'); }
      addLog(`${p.name} 自摸 ${T.tileName(winTile)}【${fan.names.join('+')} x${fan.mult}】，其余各付 ${fan.mult} 豆`);
    } else {
      pay(from, seat, fan.mult * BASE, '点炮');
      addLog(`${p.name} ${robbed ? '抢杠胡' : '胡'} ${T.tileName(winTile)}【${fan.names.join('+')} x${fan.mult}】，${game.players[from].name} 付 ${fan.mult} 豆`);
    }
    if (game.firstWinner == null) game.firstWinner = seat;
  }
  game.lastDiscard = null; game.rob = null;
  const remain = game.players.filter(p => p && !p.won);
  if (remain.length <= 1) return endGame('threeWins');
  const after = selfDraw ? winSeats[0] : from;
  advanceDraw(after);
}

// ---------------- 流局/结束结算 ----------------
function endGame(reason) {
  clearAllTimers();
  game.phase = 'settle'; game.current = null; game.pending = null; game.rob = null;
  const remain = game.players.filter(p => p && !p.won);
  const notes = [];
  if (reason === 'wall' && remain.length >= 2) {
    const hua = remain.filter(p => p.hand.some(t => suitOf(t) === p.lack));
    const huaSet = new Set(hua.map(p => p.seat));
    if (hua.length) {
      for (const h of hua) for (let q = 0; q < 4; q++) {
        const o = game.players[q];
        if (o && !huaSet.has(q)) { pay(h.seat, q, HUA_PENALTY * BASE, '花猪'); }
      }
      notes.push(`花猪：${hua.map(p => p.name).join('、')}，各赔其余每人 ${HUA_PENALTY} 豆`);
    }
    const ting = [], noTing = [];
    for (const p of remain) {
      if (huaSet.has(p.seat)) continue;
      const waits = R.findWaits(p.hand, p.melds);
      if (waits.length) ting.push({ p, max: R.maxWaitFan(p.hand, p.melds) });
      else noTing.push(p);
    }
    for (const np of noTing) for (const t of ting) {
      pay(np.seat, t.p.seat, t.max.mult * BASE, '查叫');
    }
    if (noTing.length && ting.length)
      notes.push(`查叫：${noTing.map(p => p.name).join('、')} 赔 ${ting.map(t => `${t.p.name}(x${t.max.mult})`).join('、')}`);
    if (!notes.length) notes.push('牌墙摸完，无人需赔');
  } else if (reason === 'threeWins') {
    notes.push('三家已胡，本局结束');
  }
  for (const n of notes) addLog(n);
  game.result = {
    reason, notes,
    rows: game.players.map(p => p && ({
      seat: p.seat, name: p.name, beans: p.beans, delta: p.delta,
      won: p.won, hua: !!p.won ? false : p.hand.some(t => suitOf(t) === p.lack),
      ting: !!p.won ? false : R.isTing(p.hand, p.melds),
      hand: sortTiles(p.hand), melds: p.melds, lack: p.lack,
    })),
  };
  for (const p of game.players) if (p) p.ready = false;
  broadcast();
}

function err(seat, msg) {
  const p = game.players[seat];
  if (p && p.socketId) io.to(p.socketId).emit('error_msg', msg);
}

// ---------------- 视角同步 ----------------
function actionable(p, lite = false) {
  const seat = p.seat;
  if (game.phase === 'exchange') return { mode: 'exchange', picked: p.pick };
  if (game.phase === 'lack') return { mode: 'lack' };
  if (game.phase !== 'playing') return { mode: 'wait' };
  if (p.won) return { mode: 'wait' };
  if (game.rob && game.rob.cands.includes(seat))
    return { mode: 'rob', tile: game.rob.tile };
  if (game.pending) {
    const a = game.pending;
    return {
      mode: 'ask', tile: a.tile, from: a.from,
      canHu: a.hu.includes(seat), canGang: a.gang.includes(seat), canPeng: a.peng.includes(seat),
    };
  }
  if (game.current === seat) {
    const cleared = clearedLack(p);
    const an = [], bu = [];
    if (game.drew && cleared) {
      const seen = {};
      for (const t of p.hand) {
        seen[t] = (seen[t] || 0) + 1;
        if (seen[t] === 4) an.push(t);
      }
      for (const m of p.melds) if (m.type === 'peng' && p.hand.includes(m.tiles[0])) bu.push(m.tiles[0]);
    }
    const canSelfWin = game.drew && cleared && R.canWin(p.hand, p.melds).win;
    const base = {
      mode: 'turn', drew: game.drew, cleared,
      mustSuit: cleared ? null : p.lack,
      anKongs: an, buKongs: bu,
      canSelfWin, winTile: null, winLeft: 0, advice: [],
    };
    // lite：机器人决策路径，跳过昂贵的听牌建议计算（建议只给真人前端显示）
    if (lite) return base;
    // 听牌辅助：可见张数（自己手牌/副露、各家弃牌与明副露；他人暗杠与暗手牌不可见，不计）
    const vis = {};
    const bump = t => { vis[t] = (vis[t] || 0) + 1; };
    p.hand.forEach(bump);
    for (let q = 0; q < 4; q++) {
      const o = game.players[q]; if (!o) continue;
      o.discards.forEach(bump);
      for (const m of o.melds) {
        if (q !== seat && m.type === 'angang') continue;  // 他人暗杠看不见
        m.tiles.forEach(bump);
      }
    }
    const leftOf = t => Math.max(0, 4 - (vis[t] || 0));
    // 一次遍历：反推自摸胡牌 + 每张可打牌打出后的听面
    let winTile = null, winLeft = 0;
    const advice = [];
    const legal = cleared ? p.hand : p.hand.filter(t => suitOf(t) === p.lack);
    for (const t of Array.from(new Set(legal))) {
      const rest = removeTiles(p.hand, [t]);
      const ws = R.findWaits(rest, p.melds);
      if (canSelfWin && !winTile && ws.includes(t)) { winTile = t; winLeft = leftOf(t); }
      if (ws.length) advice.push({ tile: t, waits: ws.map(w => ({ t: w, left: leftOf(w) })) });
    }
    // 按听牌面宽度降序（前端金色箭头提示用）
    advice.sort((a, b) => b.waits.length - a.waits.length);
    base.winTile = winTile; base.winLeft = winLeft; base.advice = advice;
    return base;
  }
  return { mode: 'wait' };
}
function viewFor(seat) {
  const me = game.players[seat];
  return {
    phase: game.phase, round: game.round, selfSeat: seat,
    dealer: game.dealer, current: game.current, wallCount: game.wall.length,
    dice: game.dice, dir: game.dir, lastDiscard: game.lastDiscard,
    voidText: game.voidText,
    players: game.players.map(p => p ? {
      seat: p.seat, name: p.name, beans: p.beans, ready: p.ready, online: p.online, isBot: !!p.isBot,
      handCount: p.hand.length, lack: p.lack, melds: p.melds, discards: p.discards,
      won: p.won ? { order: p.won.order, names: p.won.names, mult: p.won.mult, selfDraw: p.won.selfDraw, tile: p.won.tile } : null,
    } : null),
    self: me ? {
      hand: me.hand, lack: me.lack, pick: me.pick, melds: me.melds,
      beans: me.beans, name: me.name, actionable: actionable(me),
    } : null,
    result: game.result,
    logs: game.logs.slice(-24),
  };
}
// 大厅（登录后选座）视图：只给公开摘要，不含手牌
function lobbyView() {
  return {
    phase: game.phase, round: game.round,
    players: game.players.map(p => p ? {
      seat: p.seat, name: p.name, beans: p.beans, ready: p.ready,
      online: p.online, isBot: !!p.isBot, lack: p.lack,
    } : null),
    logs: game.logs.slice(-8).map(x => x.msg),
  };
}
function broadcast() {
  for (let s = 0; s < 4; s++) {
    const p = game.players[s];
    if (p && p.socketId && p.online && !p.isBot) io.to(p.socketId).emit('state', viewFor(s));
  }
  for (const [gid] of lobbyGuests) io.to(gid).emit('lobby', lobbyView());
  driveBots();
}

// ---------------- Socket ----------------
io.on('connection', (socket) => {
  // 登录：只校验 ID，不注册不密码。同名玩家=断线重连回座；否则进入大厅选座
  socket.on('login', ({ name } = {}) => {
    name = (name || '').trim().slice(0, 12);
    if (!name) return socket.emit('error_msg', '请先输入你的 ID');
    const existSeat = game.players.findIndex(p => p && p.name === name);
    if (existSeat >= 0) {
      const p = game.players[existSeat];
      if (p.isBot) return socket.emit('error_msg', '该 ID 已被人机占用，换一个');
      if (p.online && p.socketId !== socket.id) return socket.emit('error_msg', '该 ID 已被占用，换一个');
      lobbyGuests.delete(socket.id);
      p.socketId = socket.id; p.online = true;
      socketSeat.set(socket.id, existSeat);
      addLog(`${name} 回到了牌桌`);
      return broadcast();
    }
    lobbyGuests.set(socket.id, name);
    socket.emit('lobby', lobbyView());
  });

  // 大厅选座入座（seat 可选，不带则自动补第一个空位）
  socket.on('join', ({ name, seat } = {}) => {
    name = (name || '').trim().slice(0, 12) || lobbyGuests.get(socket.id);
    if (!name) return socket.emit('error_msg', '请先输入你的 ID');
    const already = socketSeat.get(socket.id);
    if (already != null && game.players[already]) return socket.emit('state', viewFor(already));
    const sameName = game.players.findIndex(p => p && p.name === name);
    if (sameName >= 0) {
      const p = game.players[sameName];
      if (p.isBot || (p.online && p.socketId !== socket.id)) return socket.emit('error_msg', '该 ID 已被占用，换一个');
      lobbyGuests.delete(socket.id);
      p.socketId = socket.id; p.online = true;
      socketSeat.set(socket.id, sameName);
      addLog(`${name} 回到了牌桌`);
      return broadcast();
    }
    if (game.phase !== 'idle' && game.phase !== 'settle')
      return socket.emit('error_msg', '本局进行中，等下一局再入座');
    let target;
    if (Number.isInteger(seat)) {
      target = seat;
      if (target < 0 || target > 3) return socket.emit('error_msg', '座位号无效');
      if (game.players[target]) return socket.emit('error_msg', '该座位已有人');
    } else {
      target = game.players.findIndex(p => !p);
      if (target < 0) target = game.players.findIndex(p => p && !p.online);
      if (target < 0) return socket.emit('error_msg', '牌桌已满（4人）');
    }
    if (game.players[target]) addLog(`${game.players[target].name} 离线离场，${name} 入座`);
    game.players[target] = newPlayer(target, name, socket.id);
    socketSeat.set(socket.id, target);
    lobbyGuests.delete(socket.id);
    addLog(`${name} 入座（${START_BEANS}豆）`);
    broadcast();
  });

  // 等待/结算阶段离开座位回大厅
  socket.on('leaveSeat', () => {
    const seat = socketSeat.get(socket.id);
    if (seat == null) return socket.emit('lobby', lobbyView());
    const p = game.players[seat]; if (!p) return;
    if (game.phase !== 'idle' && game.phase !== 'settle')
      return socket.emit('error_msg', '对局进行中不能离座');
    const name = p.name;
    botClear(seat);
    game.players[seat] = null;
    socketSeat.delete(socket.id);
    lobbyGuests.set(socket.id, name);
    addLog(`${name} 回到大厅选座`);
    broadcast();
    socket.emit('lobby', lobbyView());
  });

  socket.on('ready', () => {
    const seat = socketSeat.get(socket.id); const p = game.players[seat];
    if (!p) return;
    if (game.phase !== 'idle' && game.phase !== 'settle') return err(seat, '本局还没结束');
    p.ready = !p.ready;
    const seated = game.players.filter(x => x);
    if (seated.length === 4 && seated.every(x => x.ready && x.online)) startGame();
    else broadcast();
  });

  socket.on('addBot', ({ seat } = {}) => {
    if (game.phase !== 'idle' && game.phase !== 'settle')
      return socket.emit('error_msg', '对局进行中，下一局才能添加人机');
    let target = (Number.isInteger(seat)) ? seat : game.players.findIndex(p => !p);
    if (target < 0 || target > 3) return socket.emit('error_msg', '没有空座位了');
    if (game.players[target]) return socket.emit('error_msg', '该座位已有人');
    const used = new Set(game.players.filter(p => p).map(p => p.name));
    let n = game.players.filter(p => p && p.isBot).length + 1, name;
    do { name = '人机' + n; n++; } while (used.has(name));
    const bp = newPlayer(target, name, '__bot__S' + target, true);
    game.players[target] = bp;
    addLog(`${name} 入座（电脑）`);
    broadcast();
  });

  socket.on('removeBot', ({ seat } = {}) => {
    if (game.phase !== 'idle' && game.phase !== 'settle')
      return socket.emit('error_msg', '对局进行中不能移除人机');
    const p = game.players[seat];
    if (!p || !p.isBot) return;
    botClear(seat);
    addLog(`${p.name} 被移除`);
    game.players[seat] = null;
    broadcast();
  });

  socket.on('exchange', ({ tiles } = {}) => {
    const seat = socketSeat.get(socket.id); const p = game.players[seat];
    if (!p || game.phase !== 'exchange' || p.pick) return;
    if (!Array.isArray(tiles) || tiles.length !== 3) return err(seat, '必须选3张');
    if (tiles.some(t => !p.hand.includes(t))) return err(seat, '选牌不在手牌中');
    if (new Set(tiles.map(suitOf)).size !== 1) return err(seat, '3张必须同一花色');
    p.pick = tiles.slice();
    if (game.players.every(x => x && x.pick)) doExchange();
    else broadcast();
  });

  socket.on('lack', ({ suit } = {}) => {
    const seat = socketSeat.get(socket.id); const p = game.players[seat];
    if (!p || game.phase !== 'lack' || p.lack) return;
    if (!SUITS.includes(suit)) return err(seat, '缺门无效');
    p.lack = suit;
    if (game.players.every(x => x && x.lack)) beginPlay();
    else broadcast();
  });

  socket.on('discard', ({ tile } = {}) => doDiscard(socketSeat.get(socket.id), tile));
  socket.on('selfWin', () => onSelfWin(socketSeat.get(socket.id)));
  socket.on('selfKong', ({ type, tile } = {}) => onSelfKong(socketSeat.get(socket.id), type, tile));
  socket.on('act', ({ type } = {}) => onAct(socketSeat.get(socket.id), type));
  socket.on('chat', ({ msg } = {}) => {
    const seat = socketSeat.get(socket.id); const p = game.players[seat];
    if (!p) return;
    msg = ('' + (msg || '')).trim().slice(0, 60);
    if (!msg) return;
    io.emit('chat', { name: p.name, msg, t: Date.now() });
  });

  socket.on('disconnect', () => {
    lobbyGuests.delete(socket.id);
    const seat = socketSeat.get(socket.id);
    socketSeat.delete(socket.id);
    if (seat == null) return;
    const p = game.players[seat]; if (!p) return;
    if (game.phase === 'idle') { game.players[seat] = null; addLog(`${p.name} 离开`); }
    else { p.online = false; p.socketId = null; addLog(`${p.name} 断线，系统托管`); }
    broadcast();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const k of Object.keys(ifaces))
    for (const it of ifaces[k])
      if (it.family === 'IPv4' && !it.internal) ips.push(it.address);
  console.log('========================================');
  console.log(' 换三张麻将服务器已启动');
  console.log(' 本机打开:   http://localhost:' + PORT);
  ips.forEach(ip => console.log(' 同机房朋友打开: http://' + ip + ':' + PORT));
  console.log('========================================');
});
