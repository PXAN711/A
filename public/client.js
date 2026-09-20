'use strict';
/* 换三张 前端：纯渲染 + 发指令，判定以服务端 state 为准 */
const socket = io();
const SUIT_CN = { m: '万', p: '筒', s: '条' };
const ROW = { p: 0, s: 1, m: 2 };           // 素材行：筒0 条1 万2
let S = null, L = null, RL = [];
let myName = '';
let screen = 'login';   // login | hall | room | table
const sel = new Set();
let askDeny = {};
let viewOrder = [];                          // 手牌显示顺序（真实索引），新摸牌置最右
const $ = id => document.getElementById(id);
const suit = t => t[0];
const rank = t => t.slice(1);
const ttext = t => rank(t) + SUIT_CN[suit(t)];

/* ================= 前后状态差异检测（驱动动画） ================= */
const mem = { beans: {}, hand: null, counts: {}, won: {}, lastKey: null, current: null, askKey: null, prevPhase: null, myPick: null, diceKey: null };
let EV = {};
function diff(st) {
  const e = { drawIdx: -1, discard: false, fromPos: -1, newWinners: [], beanDelta: {}, countUp: {} };
  if (!st.self) { mem.hand = null; return e; }
  // 自己摸牌：手牌 +1，定位新牌索引（服务端始终按花色排序）
  const h = st.self.hand;
  if (mem.hand && h.length === mem.hand.length + 1) {
    let i = 0; while (i < mem.hand.length && mem.hand[i] === h[i]) i++;
    e.drawIdx = i;
  }
  // 豆子变化
  st.players.forEach((p, seat) => {
    if (!p) return;
    if (mem.beans[seat] != null && mem.beans[seat] !== p.beans) e.beanDelta[seat] = p.beans - mem.beans[seat];
  });
  // 新胡牌者
  st.players.forEach((p, seat) => {
    if (p && p.won && !mem.won[seat]) e.newWinners.push(seat);
  });
  // 新打出的牌
  const lk = st.lastDiscard ? st.lastDiscard.seat + '-' + st.lastDiscard.tile : null;
  if (lk && lk !== mem.lastKey) {
    e.discard = true;
    e.fromPos = (st.lastDiscard.seat - st.selfSeat + 4) % 4;
  }
  // 他人摸牌（牌背 +1）
  st.players.forEach((p, seat) => {
    if (!p) return;
    if (mem.counts[seat] != null && p.handCount === mem.counts[seat] + 1) e.countUp[seat] = true;
  });
  // 回写缓存
  mem.hand = h.slice();
  st.players.forEach((p, seat) => {
    if (!p) return;
    mem.beans[seat] = p.beans; mem.counts[seat] = p.handCount; mem.won[seat] = p.won ? p.won.order : null;
  });
  mem.lastKey = lk; mem.current = st.current;
  return e;
}

// ---------- 牌（素材雪碧图） ----------
function tileEl(t, o = {}) {
  const d = document.createElement('div');
  if (o.back) { d.className = 'tb sm'; }
  else {
    const r = ROW[suit(t)], c = rank(t) - 1;
    d.className = `tj y${r} c${c}` + (o.small ? ' sm' : o.big ? ' big' : '');
  }
  if (o.onclick) d.onclick = o.onclick;
  if (o.ondblclick) d.ondblclick = o.ondblclick;
  return d;
}
function tjHTML(t) { const r = ROW[suit(t)], c = rank(t) - 1; return `<div class="tj sm y${r} c${c}"></div>`; }
function bigTJHTML(t) { const r = ROW[suit(t)], c = rank(t) - 1; return `<div class="tj big y${r} c${c}"></div>`; }
function tbHTML(n) { return Array.from({ length: n }, () => '<div class="tb sm"></div>').join(''); }

// ---------- 界面切换 ----------
function showScreen(sc) {
  screen = sc;
  $('login').classList.toggle('hidden', sc !== 'login');
  $('hall').classList.toggle('hidden', sc !== 'hall');
  $('lobby').classList.toggle('hidden', sc !== 'room');
  $('table').classList.toggle('hidden', sc !== 'table');
}

// ---------- 登录（只输 ID，无注册无密码）→ 房间大厅 ----------
function doJoin() {
  const name = $('nameInput').value.trim();
  if (!name) return toast('请先输入 ID');
  myName = name;
  socket.emit('login', { name });
}
$('joinBtn').onclick = doJoin;
$('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
socket.on('error_msg', msg => toast(msg));

// ---------- 大厅：房间列表 ----------
socket.on('rooms', list => {
  RL = list || [];
  if (screen === 'login' || screen === 'hall') {
    showScreen('hall');
    // 断线重开：自动回到刚才的房间（同名离线会自动回座）
    const last = localStorage.getItem('hsz_room');
    if (last && RL.some(r => r.id === last) && screen === 'hall') {
      localStorage.removeItem('hsz_room');
      socket.emit('joinRoom', { roomId: last });
      return;
    }
  }
  renderHall();
});
$('createRoomBtn').onclick = () => socket.emit('createRoom');
$('hallBack').onclick = () => socket.emit('leaveRoom');
function renderHall() {
  $('hallName').textContent = myName ? '当前 ID：' + myName : '';
  const box = $('roomList');
  if (!RL.length) {
    box.innerHTML = '<div class="room-empty">暂无房间，点右上角「创建房间」开一桌</div>';
    return;
  }
  box.innerHTML = RL.map(r => `
    <div class="room-card ${r.waiting ? '' : 'busy'}">
      <div class="rc-no">${r.id}</div>
      <div class="rc-info">
        <div class="rc-state">${PHASE_CN[r.phase] || r.phase} · 第 ${r.round || 1} 局</div>
        <div class="rc-seats">${'●'.repeat(r.n)}${'○'.repeat(4 - r.n)} ${r.n}/4 人${r.bots ? '（含人机 ' + r.bots + '）' : ''}</div>
      </div>
      <button class="btn ${r.waiting ? 'primary' : 'ghost'} rc-join" data-id="${r.id}">${r.waiting ? '加入' : '观战/回座'}</button>
    </div>`).join('');
  box.querySelectorAll('.rc-join').forEach(b => b.onclick = () => socket.emit('joinRoom', { roomId: b.dataset.id }));
}

// ---------- 房间内：展示牌桌与四个座位，自选入座 ----------
const SEAT_LABEL = ['南座（下）', '西座（右）', '北座（上）', '东座（左）'];
const PHASE_CN = { idle: '等待入座', settle: '上一局结算中', exchange: '换三张中', lack: '定缺中', playing: '对局进行中', void: '本局作废' };
socket.on('room', st => {
  L = st;
  localStorage.setItem('hsz_room', st.roomId);
  showScreen('room');
  renderLobby();
});
function esc(s) { return ('' + s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function renderLobby() {
  if (!L) return;
  const waiting = L.phase === 'idle' || L.phase === 'settle';
  const n = L.players.filter(p => p).length;
  $('roomNo').textContent = L.roomId;
  $('lobbyStatus').textContent = `${PHASE_CN[L.phase] || L.phase} · 已入座 ${n}/4`;
  $('lobbyFill').style.display = (waiting && n < 4) ? '' : 'none';
  for (let seat = 0; seat < 4; seat++) {
    const box = $('lbSeat' + seat);
    const p = L.players[seat];
    if (!p) {
      box.innerHTML = `<div class="lb-card empty ${waiting ? '' : 'locked'}">
          <div class="lb-ava">＋</div>
          <div class="lb-name">空位 · ${SEAT_LABEL[seat]}</div>
          <div class="lb-btn-row">${waiting ? '<button class="btn primary lb-sit">入座</button>' : '<span class="lb-lock">对局中</span>'}</div>
        </div>`;
      const b = box.querySelector('.lb-sit');
      if (b) b.onclick = () => socket.emit('join', { name: myName, seat });
    } else {
      const state = p.isBot ? '<span class="tag bot">人机</span>'
        : !p.online ? '<span class="tag off">离线</span>'
        : (L.phase === 'idle' || L.phase === 'settle') ? (p.ready ? '<span class="tag ready">已准备</span>' : '<span class="tag wait">未准备</span>')
        : (p.lack ? `<span class="tag lack">缺${SUIT_CN[p.lack]}</span>` : '');
      box.innerHTML = `<div class="lb-card ${p.isBot ? 'isbot' : ''}">
          <div class="lb-ava">${esc(p.name.slice(0, 1))}</div>
          <div class="lb-name">${esc(p.name)}</div>
          <div class="lb-meta">${p.beans}豆 ${state}</div>
          <div class="lb-btn-row">${p.isBot && waiting ? '<button class="btn ghost lb-kick">移除</button>' : ''}</div>
        </div>`;
      const k = box.querySelector('.lb-kick');
      if (k) k.onclick = () => socket.emit('removeBot', { seat });
    }
  }
  $('lobbyLog').innerHTML = (L.logs || []).slice(-5).map(x => `<div>${esc(typeof x === 'string' ? x : x.msg)}</div>`).join('');
}
$('lobbyFill').onclick = () => {
  if (!L) return;
  L.players.forEach((p, seat) => { if (!p) socket.emit('addBot', { seat }); });
};

// ---------- 聊天（来新消息自动展开显示） ----------
const chatBox = document.querySelector('.chat-box');
function sendChat() {
  const inp = $('chatInput'); const v = inp.value.trim();
  if (!v) return;
  socket.emit('chat', { msg: v }); inp.value = '';
}
document.querySelector('.chat-head').onclick = () => chatBox.classList.toggle('collapsed');
$('chatSend').onclick = sendChat;
$('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
socket.on('chat', d => {
  const box = $('chatMsgs'); const m = document.createElement('div'); m.className = 'm msg-new';
  const b = document.createElement('b'); b.textContent = d.name + '：';
  const sp = document.createElement('span'); sp.textContent = d.msg;   // textContent 防注入
  m.appendChild(b); m.appendChild(sp); box.appendChild(m); box.scrollTop = box.scrollHeight;
  // 有新消息直接展开，并短暂高亮边框提示
  chatBox.classList.remove('collapsed');
  chatBox.classList.add('flash');
  clearTimeout(chatBox._ft); chatBox._ft = setTimeout(() => chatBox.classList.remove('flash'), 1200);
});

// ---------- 主渲染 ----------
socket.on('state', st => {
  S = st;
  if (st.self) { localStorage.setItem('hsz_room', st.roomId); showScreen('table'); }
  EV = diff(st);
  render();
});
function render() {
  if (!S || !S.self) return;
  if (S.self.pick && S.self.pick.length === 3) mem.myPick = S.self.pick.slice();
  for (const i of [...sel]) if (i >= S.self.hand.length) sel.delete(i);
  renderSeats(); renderCenter(); renderMy(); renderActions(); renderOverlay(); renderAsk();
}
function pos(seat) { return (seat - S.selfSeat + 4) % 4; } // 0我 1右(西/下家) 2顶(北) 3左(东/上家)
const POS_EL = { 1: 'seat-right', 2: 'seat-top', 3: 'seat-left' };
// 屏幕方位 -> 追光指针角度（北0 / 东(右)90 / 南(下)180 / 西(左)270）
const POS_ROT = { 2: 0, 1: 90, 0: 180, 3: 270 };
const POS_POP = { 2: 'pop-top', 1: 'pop-right', 0: 'pop-bottom', 3: 'pop-left' };

function beanFlyHTML(seat) {
  const d = EV.beanDelta[seat];
  if (!d) return '';
  return `<span class="bean-fly ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d}</span>`;
}
function statusTags(p) {
  const tags = [];
  if (p.isBot) tags.push('<span class="tag bot">人机</span>');
  if (p.seat === S.dealer) tags.push('<span class="tag turn">庄</span>');
  if (p.lack) tags.push(`<span class="tag lack">缺${SUIT_CN[p.lack]}</span>`);
  if (!p.online) tags.push('<span class="tag off">托管</span>');
  if (p.ready && (S.phase === 'idle' || S.phase === 'settle')) tags.push('<span class="tag ready">已准备</span>');
  if (p.won) tags.push(`<span class="tag won">第${p.won.order}胡 ${p.won.names.join('')}</span>`);
  if (S.current === p.seat && S.phase === 'playing' && !p.won) tags.push('<span class="tag turn">出牌中</span>');
  return tags.join(' ');
}
function meldGroupsHTML(melds) {
  if (!melds || !melds.length) return '';
  return melds.map(m => {
    const cls = m.type === 'angang' ? '暗杠' : m.type === 'peng' ? '碰' : '杠';
    let inner;
    if (m.type === 'angang') inner = [0, 1, 2, 3].map(i => (i === 0 || i === 3) ? '<div class="tb sm"></div>' : tjHTML(m.tiles[0])).join('');
    else inner = m.tiles.map(t => tjHTML(t)).join('');
    return `<div class="meld-group" title="${cls}">${inner}</div>`;
  }).join('');
}

function renderSeats() {
  const sideClass = { 1: 'side-east', 2: 'side-north', 3: 'side-west' };
  for (let seat = 0; seat < 4; seat++) {
    const pp = pos(seat);
    if (pp === 0) continue;
    const el = $(POS_EL[pp]); const p = S.players[seat];
    el.innerHTML = '';
    const seatEl = document.createElement('div');
    const active = S.current === seat && S.phase === 'playing' && !p.won;
    const justWon = EV.newWinners.includes(seat);
    seatEl.className = 'seat ' + sideClass[pp] + (active ? ' active' : '') + (justWon ? ' just-won' : '');
    if (!p) {
      const canAdd = S.phase === 'idle' || S.phase === 'settle';
      seatEl.innerHTML = canAdd
        ? `<div class="seat-empty"><span>虚位以待</span><button class="add-bot" onclick="socket.emit('addBot',{seat:${seat}})">＋人机</button></div>`
        : '<div class="seat-empty">虚位以待</div>';
      el.appendChild(seatEl); continue;
    }
    const jump = EV.beanDelta[seat] ? ' bean-jump' : '';
    const huPop = justWon ? `<div class="hu-pop">${p.won && p.won.selfDraw ? '自摸' : '胡'}</div>` : '';
    const rmBot = (p.isBot && (S.phase === 'idle' || S.phase === 'settle'))
      ? `<button class="rm-bot" title="移除人机" onclick="socket.emit('removeBot',{seat:${seat}})">×</button>` : '';
    seatEl.innerHTML = `
      <div class="seat-meldcol">${meldGroupsHTML(p.melds)}</div>
      <div class="seat-body">
        ${huPop}
        <div class="seat-info">
          <span class="av ${p.seat === S.dealer ? 'dealer' : ''}">${p.name.slice(0, 1)}</span>
          <span class="nm">${p.name}</span>${rmBot}<span class="pw"><span class="pb${jump}">${p.beans}豆</span>${beanFlyHTML(seat)}</span>${statusTags(p)}
        </div>
        <div class="seat-hand ${EV.countUp[seat] ? 'drew' : ''}">${tbHTML(p.handCount)}</div>
      </div>
      <div class="seat-disc">${p.discards.map(t => tjHTML(t)).join('')}</div>`;
    el.appendChild(seatEl);
  }
}

// ---------- 骰子动画：新局掷骰时翻滚定格 ----------
function renderDice() {
  const box = $('dice');
  if (!S.dice) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const key = S.round + '-' + S.dice.sum;
  if (mem.diceKey === key) return;
  mem.diceKey = key;
  const d1 = $('die1'), d2 = $('die2'), sum = $('diceSum');
  d1.classList.add('rolling'); d2.classList.add('rolling');
  sum.textContent = '';
  let n = 0;
  clearInterval(box._iv);
  box._iv = setInterval(() => {
    n++;
    if (n >= 9) {
      clearInterval(box._iv);
      d1.textContent = S.dice.a; d2.textContent = S.dice.b;
      d1.classList.remove('rolling'); d2.classList.remove('rolling');
      sum.textContent = `=${S.dice.sum} ${S.dir.label}`;
    } else {
      d1.textContent = 1 + Math.floor(Math.random() * 6);
      d2.textContent = 1 + Math.floor(Math.random() * 6);
    }
  }, 65);
}
// ---------- 换三张飞牌动画：3张牌沿换牌方向飞出 ----------
function playExchangeFly() {
  const tiles = mem.myPick || [];
  const layer = $('flyLayer');
  if (!layer || !tiles.length) return;
  layer.innerHTML = '';
  // 三张扇形散开，按换牌方向飞出（next下家=屏右，prev上家=屏左，across对家=屏顶）
  const place = {
    next: (i) => ({ sx: -28, sy: 24 + i * 10, dx: 168, dy: -30 + (i - 1) * 26 }),
    prev: (i) => ({ sx: 28, sy: 24 + i * 10, dx: -168, dy: -30 + (i - 1) * 26 }),
    across: (i) => ({ sx: (i - 1) * 26, sy: 36, dx: (i - 1) * 36, dy: -152 }),
  }[S.dir.dir] || (() => ({ sx: 0, sy: 36, dx: 0, dy: -152 }));
  tiles.forEach((t, i) => {
    const el = tileEl(t, { small: true });
    const v = place(i);
    el.className += ' fly-tile';
    el.style.setProperty('--sx', v.sx + 'px');
    el.style.setProperty('--sy', v.sy + 'px');
    el.style.setProperty('--dx', v.dx + 'px');
    el.style.setProperty('--dy', v.dy + 'px');
    el.style.animationDelay = (i * 0.07) + 's';
    layer.appendChild(el);
  });
  setTimeout(() => { layer.innerHTML = ''; }, 1300);
}
function renderCenter() {
  renderDice();
  // 换三张完成：自己选出的3张牌按换牌方向飞出
  if (mem.prevPhase === 'exchange' && S.phase === 'lack') playExchangeFly();
  mem.prevPhase = S.phase;
  $('wall').textContent = (S.phase === 'playing' || S.phase === 'settle') ? `牌墙剩 ${S.wallCount} 张` : '';
  let tip = '';
  if (S.phase === 'idle') { const n = S.players.filter(p => p).length; tip = `等待入座准备（${n}/4）`; }
  else if (S.phase === 'exchange') tip = '换三张：选 3 张同花色换出';
  else if (S.phase === 'lack') tip = '定缺：选一门本局打光';
  else if (S.phase === 'void') tip = S.voidText;
  else if (S.phase === 'settle') tip = '本局结束';
  else if (S.phase === 'playing') { const c = S.players[S.current]; tip = c ? `轮到 ${c.name}` : ''; }
  $('phaseTip').textContent = tip;
  // 中央扇形追光指针：指向当前出牌者
  const ptr = $('turnPointer');
  if (ptr) {
    if (S.phase === 'playing' && S.current != null && !S.players[S.current].won) {
      ptr.style.setProperty('--rot', POS_ROT[pos(S.current)] + 'deg');
      ptr.classList.add('show');
    } else ptr.classList.remove('show');
  }
  // 刚打出的牌（弹出动画，方向跟随出牌者）
  const lt = $('lastTile'); lt.innerHTML = '';
  if (S.lastDiscard) {
    const who = document.createElement('span'); who.className = 'who';
    who.textContent = S.players[S.lastDiscard.seat].name;
    const popCls = EV.discard ? (' ' + (POS_POP[EV.fromPos] || '')) : '';
    const t = tileEl(S.lastDiscard.tile, { small: true });
    t.className += popCls;
    lt.appendChild(who); lt.appendChild(t);
  }
}

function renderMy() {
  const me = S.players[S.selfSeat];
  const myHand = S.self.hand;   // 完整手牌只在 self 中下发
  const act = S.self.actionable;
  const myActive = S.current === me.seat && S.phase === 'playing' && !me.won;
  const jump = EV.beanDelta[me.seat] ? ' bean-jump' : '';
  $('myBar').className = 'my-bar' + (myActive ? ' active' : '');
  $('myBar').innerHTML = `<div class="seat-info">
      <span class="av ${me.seat === S.dealer ? 'dealer' : ''}">${me.name.slice(0, 1)}</span>
      <span class="nm">${me.name}</span><span class="pw"><span class="pb${jump}">${me.beans}豆</span>${beanFlyHTML(me.seat)}</span>${statusTags(me)}
    </div>`;
  $('myMelds').innerHTML = meldGroupsHTML(me.melds);
  $('myDiscards').innerHTML = me.discards.map(t => tjHTML(t)).join('');
  const hand = $('hand'); hand.innerHTML = '';
  const kongSet = new Set([...(act.anKongs || []), ...(act.buKongs || [])]);
  const adviceMap = {};
  (act.advice || []).forEach(a => { adviceMap[a.tile] = a.waits; });
  // 显示顺序：正常排序；新摸的牌抽到最右侧单独隔开
  viewOrder = myHand.map((_, i) => i);
  if (EV.drawIdx >= 0 && EV.drawIdx < viewOrder.length) {
    viewOrder = viewOrder.filter(i => i !== EV.drawIdx).concat(EV.drawIdx);
  }
  viewOrder.forEach((real, di) => {
    const t = myHand[real];
    const el = tileEl(t);
    bindHandTile(el, real, di, t, act, adviceMap[t] || null);
    if (sel.has(real)) el.classList.add(act.mode === 'exchange' ? 'pick' : 'sel');
    if (real === EV.drawIdx) el.classList.add('draw-in', 'new-draw');
    if (act.mode === 'turn' && kongSet.has(t)) el.classList.add('kong-hint');
    if (act.mode === 'turn' && adviceMap[t]) el.classList.add('ting-arrow');
    hand.appendChild(el);
  });
}

// ---------- 手牌交互：点击选中 / 双击出牌 / 向上拖拽出牌 / 悬停听牌明细 ----------
let lastTap = { t: 0, idx: -1 };       // 双击判定（模块级，DOM 重建不影响）
function bindHandTile(el, real, di, tile, act, waits) {
  let sx = 0, sy = 0, moved = false, dragging = false;
  el.addEventListener('pointerdown', e => {
    sx = e.clientX; sy = e.clientY; moved = false; dragging = false;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    el.classList.add('pressing');
    e.preventDefault();
  });
  el.addEventListener('pointermove', e => {
    if (!(e.buttons & 1)) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && Math.hypot(dx, dy) > 4) moved = true;
    if (act.mode === 'turn' && moved && dy < -8) {
      if (!dragging) { dragging = true; el.classList.add('dragging'); hideTingTip(); }
      el.style.transform = `translate3d(${dx * 0.25}px, ${dy}px, 0) scale(1.08)`;
    }
  });
  const end = e => {
    el.classList.remove('pressing', 'dragging');
    el.style.transform = '';
    if (dragging && act.mode === 'turn') return dragDiscard(real, tile, act);
    if (!moved) {
      // 自己回合：同一张牌 320ms 内点两次 = 双击打出
      if (act.mode === 'turn') {
        const now = performance.now();
        if (lastTap.idx === real && now - lastTap.t < 320) {
          lastTap = { t: 0, idx: -1 };
          return dragDiscard(real, tile, act);
        }
        lastTap = { t: now, idx: real };
      }
      clickHand(di);
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', () => { el.classList.remove('pressing', 'dragging'); el.style.transform = ''; });
  if (waits && waits.length) {
    el.addEventListener('mouseenter', () => showTingTip(el, tile, waits));
    el.addEventListener('mouseleave', hideTingTip);
  }
}
// 上拖出牌（缺门限制前端先拦一道，服务端最终校验）
function dragDiscard(real, tile, act) {
  if (act.mustSuit && suit(tile) !== act.mustSuit)
    return toast(`先把「${SUIT_CN[act.mustSuit]}」打缺`);
  sel.clear();
  socket.emit('discard', { tile });
}
// 悬停浮层：打出后听什么、各剩几张（只统计可见牌，他人暗手牌不计）
function showTingTip(el, tile, waits) {
  const tip = $('tingTip'); if (!tip) return;
  tip.innerHTML = `<div class="tt-list">${waits.map(w => {
      const r = ROW[suit(w.t)], c = rank(w.t) - 1;
      return `<span class="tt-item"><div class="tj tt-tile y${r} c${c}"></div><b>${w.left}</b></span>`;
    }).join('')}</div>`;
  tip.classList.remove('hidden');
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  const r = el.getBoundingClientRect();
  let x = r.left + r.width / 2 - tw / 2;
  x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
  let y = r.top - th - 12;
  if (y < 8) y = r.bottom + 12;
  tip.style.transform = `translate(${x}px,${y}px)`;
}
function hideTingTip() { const tip = $('tingTip'); if (tip) tip.classList.add('hidden'); }
function clickHand(di) {
  const i = viewOrder[di];
  if (i == null) return;
  const act = S.self.actionable;
  if (act.mode === 'exchange') {
    if (sel.has(i)) sel.delete(i);
    else {
      if (sel.size >= 3) return toast('最多选 3 张');
      if (sel.size > 0) { const ft = S.self.hand[[...sel][0]]; if (suit(ft) !== suit(S.self.hand[i])) return toast('3 张必须同一花色'); }
      sel.add(i);
    }
  } else if (act.mode === 'turn') { sel.clear(); sel.add(i); }
  render();
}

// ---------- 底部操作（出牌/换牌/定缺/准备）：槽位固定，不随文字长短位移 ----------
function btn(label, cls, fn) { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = label; b.onclick = fn; return b; }
function info(t) { const s = document.createElement('span'); s.className = 'act-info'; s.textContent = t; return s; }
function renderActions() {
  const a = $('actions'); a.innerHTML = '';
  const act = S.self.actionable, phase = S.phase;
  if (phase === 'idle' || phase === 'settle') {
    const empties = S.players.map((p, i) => p ? -1 : i).filter(i => i >= 0);
    if (phase === 'idle') {
      a.appendChild(info('四人点准备自动开局'));
      if (empties.length) a.appendChild(btn('补满人機', 'green', () => empties.forEach(s => socket.emit('addBot', { seat: s }))));
      a.appendChild(btn(S.players[S.selfSeat].ready ? '取消准备' : '准备', 'primary', () => socket.emit('ready')));
      a.appendChild(btn('换座位', 'ghost', () => socket.emit('leaveSeat')));
    } else {
      a.appendChild(info('结算已弹出'));
      if (empties.length) a.appendChild(btn('补满人機', 'green', () => empties.forEach(s => socket.emit('addBot', { seat: s }))));
      a.appendChild(btn('换座位', 'ghost', () => socket.emit('leaveSeat')));
    }
    a.style.display = ''; return;
  }
  if (phase === 'void') { a.appendChild(info('本局作废，重新发牌…')); a.style.display = ''; return; }
  if (act.mode === 'exchange') {
    a.appendChild(info(`已选 ${sel.size}/3（须同花色）`));
    const b = btn('确认换出', 'primary', () => {
      const tiles = [...sel].sort((x, y) => x - y).map(i => S.self.hand[i]);
      mem.myPick = tiles.slice();
      socket.emit('exchange', { tiles }); sel.clear();
    });
    b.disabled = sel.size !== 3; a.appendChild(b); a.style.display = ''; return;
  }
  if (act.mode === 'lack') {
    a.appendChild(info('定缺'));
    ['m', 'p', 's'].forEach(s => a.appendChild(btn('定缺' + SUIT_CN[s], s === 'm' ? 'danger' : s === 'p' ? 'blue' : 'green', () => socket.emit('lack', { suit: s }))));
    a.style.display = ''; return;
  }
  if (act.mode === 'ask' || act.mode === 'rob') { a.style.display = 'none'; return; } // 由弹窗处理
  a.style.display = '';
  if (act.mode === 'wait') { a.appendChild(info('等待其他玩家…')); return; }
  if (act.mode === 'turn') {
    const kongTips = [];
    if (act.anKongs && act.anKongs.length) kongTips.push('暗杠');
    if (act.buKongs && act.buKongs.length) kongTips.push('补杠');
    let tipText;
    if (!act.cleared) tipText = `先把「${SUIT_CN[act.mustSuit]}」打缺（可向上拖拽出牌）`;
    else if (act.canSelfWin) tipText = `可胡 ${ttext(act.winTile)}，牌墙还剩约 ${act.winLeft} 张`;
    else if (kongTips.length) tipText = `可${kongTips.join('/')}（也可不点直接出牌）`;
    else tipText = '点选/上拖出牌';
    a.appendChild(info(tipText));
    if (act.canSelfWin) a.appendChild(btn(`自摸胡 ${ttext(act.winTile)}·剩${act.winLeft}`, 'danger', () => socket.emit('selfWin')));
    (act.anKongs || []).forEach(t => a.appendChild(btn('暗杠' + ttext(t), 'blue hint', () => socket.emit('selfKong', { type: 'an', tile: t }))));
    (act.buKongs || []).forEach(t => a.appendChild(btn('补杠' + ttext(t), 'blue hint', () => socket.emit('selfKong', { type: 'bu', tile: t }))));
    const db = btn('出牌', 'primary', doDiscard); db.disabled = sel.size !== 1; a.appendChild(db);
  }
}
function doDiscard() {
  if (sel.size !== 1) return toast('请点选一张要出的牌');
  const tile = S.self.hand[[...sel][0]]; sel.clear(); socket.emit('discard', { tile });
}

// ---------- 碰/杠/胡 弹窗（插队结算，可抢胡） ----------
function closeAsk() { const m = $('askModal'); m.classList.add('hidden'); m.innerHTML = ''; askDeny = {}; mem.askKey = null; }
function renderAsk() {
  const modal = $('askModal'); const act = S.self.actionable;
  if (!act || (act.mode !== 'ask' && act.mode !== 'rob')) { closeAsk(); return; }
  const key = act.mode + ':' + (act.tile || '');
  if (modal.dataset.key !== key) { askDeny = {}; modal.dataset.key = key; }
  mem.askKey = key;

  if (act.mode === 'rob') {
    modal.innerHTML = `<div class="ask-title">对方补杠，可抢杠胡</div>
      <div class="ask-tile">${bigTJHTML(act.tile)}</div>
      <div class="ask-groups"><div class="ask-group"><div class="pair">
        <button class="btn danger" id="robHu">抢杠胡</button>
        <button class="btn ghost" id="robPass">过</button></div></div></div>`;
    modal.classList.remove('hidden');
    $('robHu').onclick = () => { socket.emit('act', { type: 'hu' }); closeAsk(); };
    $('robPass').onclick = () => { socket.emit('act', { type: 'pass' }); closeAsk(); };
    return;
  }
  const items = [];
  if (act.canHu && !askDeny.hu) items.push({ k: 'hu', txt: '胡', cls: 'danger', no: '不胡' });
  if (act.canGang && !askDeny.gang) items.push({ k: 'gang', txt: '杠', cls: 'blue', no: '不杠' });
  if (act.canPeng && !askDeny.peng) items.push({ k: 'peng', txt: '碰', cls: 'green', no: '不碰' });
  modal.innerHTML = `<div class="ask-title">${S.players[act.from].name} 打出</div>
    <div class="ask-tile">${bigTJHTML(act.tile)}</div>
    <div class="ask-groups">${items.map(it => `<div class="ask-group">
      <div class="pair"><button class="btn ${it.cls}" data-do="${it.k}">${it.txt}</button>
      <button class="btn ghost" data-no="${it.k}">${it.no}</button></div></div>`).join('')}</div>`;
  modal.classList.remove('hidden');
  modal.querySelectorAll('[data-do]').forEach(b => b.onclick = () => { socket.emit('act', { type: b.dataset.do }); closeAsk(); });
  modal.querySelectorAll('[data-no]').forEach(b => b.onclick = () => {
    askDeny[b.dataset.no] = true;
    const remain = ['hu', 'gang', 'peng'].filter(k => {
      const can = k === 'hu' ? act.canHu : k === 'gang' ? act.canGang : act.canPeng;
      return can && !askDeny[k];
    });
    if (!remain.length) { socket.emit('act', { type: 'pass' }); closeAsk(); }
    else renderAsk();
  });
}

// ---------- 结算 ----------
let lastResult = null;
function renderOverlay() {
  const ov = $('overlay');
  if (S.phase !== 'settle' || !S.result) { ov.classList.add('hidden'); ov.innerHTML = ''; lastResult = null; return; }
  // 同一局结算结果只渲染一次，避免重复广播重启动画
  if (lastResult === S.result && !ov.classList.contains('hidden')) return;
  lastResult = S.result;
  const r = S.result, me = S.players[S.selfSeat];
  let html = '<div class="panel"><h2>本局结算</h2>';
  html += `<div style="text-align:center;color:#bfe3d2;margin-bottom:8px">${(r.notes || []).join('；')}</div>`;
  html += '<div class="result-row head"><span>玩家</span><span>豆子</span><span>本局</span><span>牌型 / 摊牌</span></div>';
  for (const row of r.rows) {
    if (!row) continue;
    const cls = row.delta > 0 ? 'delta-pos' : row.delta < 0 ? 'delta-neg' : '';
    const dt = row.delta > 0 ? '+' + row.delta : '' + row.delta;
    let right;
    if (row.won) {
      const fh = row.won.finalHand || row.hand;
      right = `<span class="tag won">第${row.won.order}胡 ${row.won.names.join('+')} x${row.won.mult} ${row.won.selfDraw ? '自摸' : '点炮'}</span>
        <div class="result-tiles" style="margin-top:4px">${fh.map(t => tjHTML(t)).join('')}</div>`;
    } else {
      const tag = row.hua ? '<span class="tag lack">花猪</span>' : row.ting ? '<span class="tag ready">听牌</span>' : '<span class="tag off">未听</span>';
      right = `${tag}<div class="result-tiles" style="margin-top:4px">${row.hand.map(t => tjHTML(t)).join('')}</div>`;
    }
    html += `<div class="result-row"><span><b>${row.name}</b> 缺${SUIT_CN[row.lack] || '-'}</span><span>${row.beans}</span><span class="${cls}">${dt}</span><div>${right}</div></div>`;
  }
  html += '<div class="actions"><button class="btn primary" id="readyNext">' + (me.ready ? '已准备，等待其他人' : '准备下一局') + '</button></div></div>';
  ov.innerHTML = html; ov.classList.remove('hidden');
  $('readyNext').onclick = () => socket.emit('ready');
}

// ---------- toast ----------
let toastTimer = null;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
}
