'use strict';
// 规则引擎冒烟测试：node game/test-rule.js
const { canWin, findWaits, calcFan, exchangeDirectionByDice, receiverOf } = require('./rule');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log('  OK  ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}
function fanOf(tiles) { return calcFan(tiles, []); }

console.log('--- 胡牌判定 ---');
check('平胡(混色顺子+将)', canWin(['m1','m2','m3','m4','m5','m6','m7','m8','m9','p1','p2','p3','p5','p5']).win);
check('七对', canWin(['m1','m1','m2','m2','m3','m3','p1','p1','p2','p2','p3','p3','s5','s5']).win);
check('对对胡', canWin(['m1','m1','m1','m3','m3','m3','p2','p2','p2','p4','p4','p4','s7','s7']).win);
check('清一色', canWin(['m1','m1','m1','m2','m3','m4','m5','m6','m7','m8','m9','m2','m3','m4']).win);
check('杂牌不胡', !canWin(['m1','m2','m3','m5','m6','m7','p1','p2','p3','p5','p6','p7','s1','s2']).win);
check('13张不算胡', !canWin(['m1','m2','m3','m4','m5','m6','m7','m8','m9','p1','p2','p3','p5']).win);

console.log('--- 带副露（碰）后胡牌 ---');
const meld = [{ type: 'peng', tiles: ['s5','s5','s5'] }];
check('碰一次后11张可胡', canWin(['m1','m2','m3','m4','m5','m6','m7','m8','m9','p5','p5'], meld).win);
check('碰一次后11张杂牌不胡', !canWin(['m1','m2','m3','m4','m5','m6','m7','m8','m9','p5','p6'], meld).win);

console.log('--- 听牌 ---');
const waits = findWaits(['m1','m2','m3','m4','m5','m6','m7','m8','m9','p1','p2','p3','p5'], []);
check('单吊将听 p5', waits.length === 1 && waits[0] === 'p5');

console.log('--- 番型倍数 ---');
const f1 = fanOf(['m1','m2','m3','m4','m5','m6','m7','m8','m9','p1','p2','p3','p5','p5']);
check('平胡 x1', f1.mult === 1 && f1.names[0] === '平胡');
const f2 = fanOf(['m1','m1','m1','m3','m3','m3','p2','p2','p2','p4','p4','p4','s7','s7']);
check('对对胡 x4', f2.mult === 4 && f2.names.includes('对对胡'));
const f3 = fanOf(['m1','m1','m1','m2','m3','m4','m5','m6','m7','m8','m9','m2','m3','m4']);
check('清一色 x6', f3.mult === 6 && f3.names.includes('清一色'));
const f4 = fanOf(['m1','m1','m2','m2','m3','m3','m4','m4','m5','m5','m6','m6','m7','m7']);
check('七对x6 + 清一色x6 = 36', f4.mult === 36);
const f5 = fanOf(['m1','m1','m1','m3','m3','m3','m5','m5','m5','m7','m7','m7','m9','m9']);
check('清对(清一色x6*对对胡x4)=24', f5.mult === 24);

console.log('--- 换三张方向 ---');
check('点数4->下家', exchangeDirectionByDice(4).dir === 'next');
check('点数8->下家', exchangeDirectionByDice(8).dir === 'next');
check('点数12->下家', exchangeDirectionByDice(12).dir === 'next');
check('点数5->对家', exchangeDirectionByDice(5).dir === 'across');
check('点数9->对家', exchangeDirectionByDice(9).dir === 'across');
check('点数2->上家', exchangeDirectionByDice(2).dir === 'prev');
check('点数6->上家', exchangeDirectionByDice(6).dir === 'prev');
check('点数10->上家', exchangeDirectionByDice(10).dir === 'prev');
check('0号给下家->1号', receiverOf(0,'next')===1);
check('1号给上家->0号', receiverOf(1,'prev')===0);
check('0号给对家->2号', receiverOf(0,'across')===2);
// 2-12 全覆盖
let cover = true;
for (let s=2;s<=12;s++){ if(!['next','across','prev'].includes(exchangeDirectionByDice(s).dir)) cover=false; }
check('点数2-12方向全覆盖', cover);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
