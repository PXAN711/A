'use strict';
// 四川麻将「换三张」规则引擎（服务端权威）
// 番型口径（用户定制）：平胡 x1 / 对对胡 x4 / 清一色 x6 / 七对 x6；无金钩钓、无根、无杠上花加番。
// 多个番型倍数相乘（如 清一色+对对胡=清对=6*4=24，清一色+七对=36）。
const { SUITS, suitOf, rankOf, toCounts } = require('./tiles');

// ---------- 单花色分解 ----------
// 某花色计数能否全部拆成面子（顺子/刻子），返回 {ok, n(面子数)}
function decomposeAny(arr) {
  const a = arr.slice(1); // 用 0-8 对应 1-9
  return rec(a);
  function rec(x) {
    let i = x.findIndex(v => v > 0);
    if (i === -1) return { ok: true, n: 0 };
    // 刻子
    if (x[i] >= 3) {
      const y = x.slice(); y[i] -= 3;
      const r = rec(y);
      if (r.ok) return { ok: true, n: r.n + 1 };
    }
    // 顺子
    if (i <= 6 && x[i + 1] > 0 && x[i + 2] > 0) {
      const y = x.slice(); y[i]--; y[i + 1]--; y[i + 2]--;
      const r = rec(y);
      if (r.ok) return { ok: true, n: r.n + 1 };
    }
    return { ok: false, n: 0 };
  }
}

// 只允许刻子（用于对对胡判定）
function decomposeTriplets(arr) {
  const x = arr.slice(1);
  function rec(a) {
    const i = a.findIndex(v => v > 0);
    if (i === -1) return { ok: true, n: 0 };
    if (a[i] < 3) return { ok: false, n: 0 };
    const y = a.slice(); y[i] -= 3;
    const r = rec(y);
    return r.ok ? { ok: true, n: r.n + 1 } : { ok: false, n: 0 };
  }
  return rec(x);
}

// ---------- 七对 ----------
function isSevenPairs(hand) {
  if (hand.length !== 14) return false;
  const c = toCounts(hand);
  let pairs = 0;
  for (const s of SUITS) for (let n = 1; n <= 9; n++) {
    const v = c[s][n];
    if (v !== 0 && v !== 2 && v !== 4) return false;
    pairs += v / 2;
  }
  return pairs === 7;
}

// 常规 4面子+1将（结合副露）。melds 为已确定的面子（碰/杠）。
function checkNormal(hand, melds) {
  const needMelds = 4 - melds.length;
  if (hand.length !== needMelds * 3 + 2) return false;
  const c = toCounts(hand);
  // 枚举将牌
  for (const s of SUITS) {
    for (let n = 1; n <= 9; n++) {
      if (c[s][n] < 2) continue;
      c[s][n] -= 2;
      let total = 0, ok = true;
      for (const su of SUITS) {
        const r = decomposeAny(c[su]);
        if (!r.ok) { ok = false; break; }
        total += r.n;
      }
      c[s][n] += 2;
      if (ok && total === needMelds) return true;
    }
  }
  return false;
}

// 是否纯对对胡（手牌部分只能用刻子，副露在四川麻将里本就全是刻/杠）
function checkAllTriplets(hand, melds) {
  const needMelds = 4 - melds.length;
  if (hand.length !== needMelds * 3 + 2) return false;
  // 副露必须都是刻/杠（四川不能吃，恒成立，保险起见检查）
  for (const m of melds) if (!m.type.includes('gang') && m.type !== 'peng') return false;
  const c = toCounts(hand);
  for (const s of SUITS) {
    for (let n = 1; n <= 9; n++) {
      if (c[s][n] < 2) continue;
      c[s][n] -= 2;
      let total = 0, ok = true;
      for (const su of SUITS) {
        const r = decomposeTriplets(c[su]);
        if (!r.ok) { ok = false; break; }
        total += r.n;
      }
      c[s][n] += 2;
      if (ok && total === needMelds) return true;
    }
  }
  return false;
}

// 清一色：手牌 + 副露 全部同一花色
function checkOneColor(hand, melds) {
  let suit = null;
  for (const t of hand) {
    if (!suit) suit = suitOf(t);
    else if (suitOf(t) !== suit) return false;
  }
  for (const m of melds) {
    for (const t of m.tiles) {
      if (!suit) suit = suitOf(t);
      else if (suitOf(t) !== suit) return false;
    }
  }
  return !!suit;
}

// 能否胡牌
function canWin(hand, melds = []) {
  const h = hand.slice();
  if (melds.length === 0 && isSevenPairs(h)) return { win: true, seven: true };
  if (checkNormal(h, melds)) return { win: true, seven: false };
  return { win: false, seven: false };
}

// 听牌：返回所有可胡的待牌
function findWaits(hand, melds = []) {
  const waits = [];
  for (const s of SUITS) for (let n = 1; n <= 9; n++) {
    const t = s + n;
    if (canWin(hand.concat(t), melds).win) waits.push(t);
  }
  return waits;
}
function isTing(hand, melds = []) { return findWaits(hand, melds).length > 0; }

// 番型与倍数
function calcFan(hand, melds = []) {
  const names = [];
  let mult = 1;
  const seven = melds.length === 0 && isSevenPairs(hand);
  const oneColor = checkOneColor(hand, melds);
  const allTrip = !seven && checkAllTriplets(hand, melds);
  if (seven) { names.push('七对'); mult *= 6; }
  if (oneColor) { names.push('清一色'); mult *= 6; }
  if (allTrip) { names.push('对对胡'); mult *= 4; }
  if (names.length === 0) names.push('平胡');
  return { mult, names };
}

// 查叫用：听牌状态下，最大可胡番型倍数
function maxWaitFan(hand, melds = []) {
  const waits = findWaits(hand, melds);
  let best = { mult: 0, names: [], tile: null };
  for (const t of waits) {
    const f = calcFan(hand.concat(t), melds);
    if (f.mult > best.mult) best = { mult: f.mult, names: f.names, tile: t };
  }
  return best;
}

// 换三张方向（用户定制）：掷两骰点数和 sum
// 能被4整除(4/8/12)->下家；单数(3/5/7/9/11)->对家；其余双数(2/6/10)->上家
function exchangeDirectionByDice(sum) {
  if (sum % 4 === 0) return { dir: 'next', label: '给下家' };
  if (sum % 2 === 1) return { dir: 'across', label: '给对家' };
  return { dir: 'prev', label: '给上家' };
}
function rollTwoDice() {
  const a = 1 + Math.floor(Math.random() * 6);
  const b = 1 + Math.floor(Math.random() * 6);
  return { a, b, sum: a + b };
}
// 某座位的牌应交给谁
function receiverOf(seat, dir) {
  if (dir === 'next') return (seat + 1) % 4;
  if (dir === 'prev') return (seat + 3) % 4;
  return (seat + 2) % 4; // across
}

module.exports = {
  isSevenPairs, checkNormal, checkAllTriplets, checkOneColor,
  canWin, findWaits, isTing, calcFan, maxWaitFan,
  exchangeDirectionByDice, rollTwoDice, receiverOf,
};
