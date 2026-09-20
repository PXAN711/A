'use strict';
// 牌的编码：花色 m=万 p=筒 s=条，数字 1-9。例 m1=一万 p9=九筒 s5=五条
const SUITS = ['m', 'p', 's'];
const SUIT_NAME = { m: '万', p: '筒', s: '条' };

function suitOf(tile) { return tile[0]; }
function rankOf(tile) { return parseInt(tile.slice(1), 10); }
function tileName(tile) { return rankOf(tile) + SUIT_NAME[suitOf(tile)]; }

// 生成并洗好一副 108 张牌（万筒条 1-9 各 4 张，无字无花）
function makeDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (let n = 1; n <= 9; n++) {
      for (let k = 0; k < 4; k++) deck.push(s + n);
    }
  }
  return shuffle(deck);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 排序：万 -> 筒 -> 条，各自数字升序
function sortTiles(arr) {
  const order = { m: 0, p: 1, s: 2 };
  return arr.slice().sort((a, b) => {
    if (order[a[0]] !== order[b[0]]) return order[a[0]] - order[b[0]];
    return rankOf(a) - rankOf(b);
  });
}

// 计数：counts.m[1..9] 表示某花色各点数张数
function emptyCounts() {
  return { m: new Array(10).fill(0), p: new Array(10).fill(0), s: new Array(10).fill(0) };
}
function toCounts(tiles) {
  const c = emptyCounts();
  for (const t of tiles) c[suitOf(t)][rankOf(t)]++;
  return c;
}

module.exports = {
  SUITS, SUIT_NAME, suitOf, rankOf, tileName,
  makeDeck, shuffle, sortTiles, emptyCounts, toCounts,
};
