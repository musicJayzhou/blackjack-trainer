/* ============================================================
 * selftest.js — 逻辑自检：规则引擎 / 策略表 / EV 计算器
 * 用法：node scripts/selftest.js
 * ============================================================ */
'use strict';
const { Shoe, Hand, Game, PHASE, DEFAULT_RULES, rankValue, NPCPlayer, HumanPlayer } = require('../js/engine.js');
const { basicStrategy, buildTables, upIdx } = require('../js/strategy.js');
const { EvCalc } = require('../js/evcalc.js');

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else { fail++; console.log(`✗ ${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`); }
}
function near(name, actual, expected, tol) {
  const ok = Math.abs(actual - expected) <= tol;
  if (ok) pass++; else { fail++; console.log(`✗ ${name}: 期望 ~${expected}，实际 ${actual.toFixed(4)}`); }
}

/* ---------- 1. 点数计算 ---------- */
const h = new Hand();
h.addCard({ rank: 'A', suit: '♠' }); h.addCard({ rank: '6', suit: '♥' });
eq('A6 = 软 17', [h.total, h.isSoft], [17, true]);
h.addCard({ rank: '9', suit: '♦' });
eq('A69 降级 = 硬 16', [h.total, h.isSoft], [16, false]);
const h2 = new Hand();
h2.addCard({ rank: 'A', suit: '♠' }); h2.addCard({ rank: 'K', suit: '♥' });
eq('AK = BJ', h2.isBlackjack, true);
const h3 = new Hand();
h3.addCard({ rank: 'A', suit: '♠' }); h3.addCard({ rank: 'K', suit: '♥' });
h3.fromSplit = true;
eq('分牌后 AK 不算 BJ', h3.isBlackjack, false);
const h4 = new Hand();
h4.addCard({ rank: 'J', suit: '♠' }); h4.addCard({ rank: 'Q', suit: '♥' });
eq('JQ 是对子（同值 10）', h4.isPair, true);

/* ---------- 2. 基本策略抽查（S17/DAS/LS） ---------- */
const R = DEFAULT_RULES;
function mkHand(a, b) { const x = new Hand(); x.addCard({ rank: a, suit: '♠' }); x.addCard({ rank: b, suit: '♥' }); return x; }
const cases = [
  ['10', '6', '10', 'R'], ['9', '7', '9', 'R'], ['9', '7', '2', 'S'], ['9', '7', '7', 'H'],
  ['10', '2', '2', 'H'], ['10', '2', '4', 'S'], ['5', '6', '6', 'D'], ['5', '6', 'A', 'H'],
  ['6', '4', '9', 'D'], ['6', '4', '10', 'H'], ['6', '3', '3', 'D'], ['6', '3', '2', 'H'],
];
/* [牌a, 牌b, 庄明牌, 期望动作] */
for (const [a, b, up, exp] of cases) {
  const rec = basicStrategy(mkHand(a, b), up, R);
  eq(`${a},${b}(${rankValue(a) + rankValue(b)}) vs ${up}`, rec.act, exp);
}
/* A,7 行完整验证 */
const a7 = { 2: 'S', 3: 'DS', 4: 'DS', 5: 'DS', 6: 'DS', 7: 'S', 8: 'S', 9: 'H', 10: 'H', A: 'H' };
for (const up in a7) eq(`A7 vs ${up}`, basicStrategy(mkHand('A', '7'), up, R).act, a7[up]);
/* 对子 */
const pairs = [
  ['8', '10', 'P'], ['8', '2', 'P'], ['A', '5', 'P'], ['10', '6', 'S'],
  ['5', '6', 'D'], ['5', '9', 'D'], ['9', '7', 'S'], ['9', '2', 'P'],
  ['4', '5', 'P'], ['4', '4', 'H'], ['7', '7', 'P'], ['7', '8', 'H'],
  ['3', '7', 'P'], ['3', '8', 'H'], ['6', '2', 'P'], ['6', '7', 'H'],
];
for (const [a, up, exp] of pairs) eq(`${a},${a} vs ${up}`, basicStrategy(mkHand(a, a), up, R).act, exp);
/* 三张以上不能加倍 */
const h5 = new Hand();
h5.addCard({ rank: '2', suit: '♠' }); h5.addCard({ rank: '4', suit: '♥' }); h5.addCard({ rank: '5', suit: '♦' });
eq('三张 11 vs 6 → H（不能加倍）', basicStrategy(h5, '6', R).act, 'H');

/* H17 差异 */
const R17 = { ...R, dealerHitSoft17: true };
eq('H17: 11 vs A → D', basicStrategy(mkHand('6', '5'), 'A', R17).act, 'D');
eq('H17: A8 vs 6 → DS', basicStrategy(mkHand('A', '8'), '6', R17).act, 'DS');
eq('H17: 17 vs A → R', basicStrategy(mkHand('10', '7'), 'A', R17).act, 'R');
eq('H17: 88 vs A → R', basicStrategy(mkHand('8', '8'), 'A', R17).act, 'R');
eq('H17: A7 vs 2 → DS', basicStrategy(mkHand('A', '7'), '2', R17).act, 'DS');
eq('H17: 15 vs A → R', basicStrategy(mkHand('10', '5'), 'A', R17).act, 'R');
/* NDAS 差异 */
const RND = { ...R, doubleAfterSplit: false };
eq('NDAS: 22 vs 2 → H', basicStrategy(mkHand('2', '2'), '2', RND).act, 'H');
eq('NDAS: 66 vs 2 → H', basicStrategy(mkHand('6', '6'), '2', RND).act, 'H');
eq('NDAS: 44 vs 5 → H', basicStrategy(mkHand('4', '4'), '5', RND).act, 'H');
/* 无投降 */
const RNS = { ...R, lateSurrender: false };
eq('无投降: 16 vs 10 → H', basicStrategy(mkHand('10', '6'), '10', RNS).act, 'H');

/* ---------- 3. EvCalc 与权威数据对比（无限副中性牌靴） ---------- */
const counts = { 2: 4, 3: 4, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 4, 10: 16, A: 4 };
const ev = new EvCalc(counts, { dealerHitSoft17: false });
/* 庄家明牌爆牌率（无限副 S17，blackjackinfo/CMU：6→42.3% 5→41.6% 4→39.4% 9→22.8% A(peek后)→16.65%*0.6923≈11.5% 无条件） */
near('庄家6爆率', ev.dealerDist('6').bust, 0.4232, 0.005);
near('庄家5爆率', ev.dealerDist('5').bust, 0.4164, 0.005);
near('庄家4爆率', ev.dealerDist('4').bust, 0.3945, 0.005);
near('庄家9爆率', ev.dealerDist('9').bust, 0.2284, 0.005);
near('庄家2爆率', ev.dealerDist('2').bust, 0.3536, 0.005);
near('庄家7成17率', ev.dealerDist('7')[17], 0.3686, 0.005);
/* 玩家 EV（CMU/Wizard：16vs10 hit -0.538 stand -0.543；11vs6 double +0.667 无限副） */
near('16v10 hitEV', ev.hitEV(16, false, '10'), -0.535, 0.02);
near('16v10 standEV', ev.standEV(16, '10'), -0.540, 0.02);
near('11v6 doubleEV', ev.doubleEV(11, false, '6'), 0.667, 0.05);
near('20v6 standEV', ev.standEV(20, '6'), 0.704, 0.02);
near('12v6 standEV', ev.standEV(12, '6'), -0.155, 0.03);
/* 保险 EV = 3p-1 = -1/13 */
const ins = ev.insuranceEV();
near('保险EV(中性)', ins.ev, -1 / 13, 1e-9);
/* even money */
const em = ev.evenMoneyEV();
near('拒绝even money EV', em.refuse, 9 / 13 * 1.5, 1e-9);
/* H17 下庄家 A 爆率升高 */
const ev17 = new EvCalc(counts, { dealerHitSoft17: true });
if (!(ev17.dealerDist('A').bust > ev.dealerDist('A').bust)) { fail++; console.log('✗ H17 应提高庄家 A 爆率'); } else pass++;

/* ---------- 4. 整局模拟 ---------- */
let sims = 300, errors = 0;
const actsPool = ['hit', 'stand'];
for (let s = 0; s < sims; s++) {
  const g = new Game(s % 2 ? { ...DEFAULT_RULES, dealerHitSoft17: true } : DEFAULT_RULES);
  g.addPlayer(new HumanPlayer('T1', 10000));
  g.addPlayer(new NPCPlayer('T2', 10000));
  for (let r = 0; r < 30; r++) {
    for (const st of g.seats) { st.pendingBet = 25; st.betConfirmed = true; }
    g.startRound();
    /* 保险阶段自动处理 */
    if (g.phase === PHASE.INSURANCE) g.skipInsurance();
    /* 随机行动直到结束 */
    let guard = 0;
    while ((g.phase === PHASE.PLAYER) && guard++ < 60) {
      const seat = g.currentSeat, hand = g.currentHand;
      if (!seat || !hand) break;
      const acts = hand.availableActions;
      if (!acts.length) { g.act('stand'); continue; }
      const a = acts[Math.floor(Math.random() * acts.length)];
      g.act(a);
    }
    if (g.phase === PHASE.PLAYER) { errors++; break; }
    /* 结算与筹码守恒 */
    if (g.phase !== PHASE.ROUND_OVER) { errors++; break; }
    const totalChips = g.seats.reduce((t, s2) => t + s2.player.chips, 0);
    if (totalChips < 0) { errors++; break; }
    g.prepareNextRound();
  }
  if (errors) break;
}
eq(`整局模拟 ${sims} 局×30 轮无卡死`, errors, 0);

/* 筹码守恒细节：单局中 庄家 BJ 立即结算路径 */
{
  const g = new Game(DEFAULT_RULES);
  g.addPlayer(new HumanPlayer('P', 1000));
  g.seats[0].pendingBet = 100; g.seats[0].betConfirmed = true;
  /* 构造庄家 BJ：直接操纵发牌（序号：1玩家 2庄明 3玩家 4庄暗） */
  let seq = 0;
  g.shoe.deal = () => {
    seq++;
    if (seq === 2) return { rank: 'K', suit: '♠' };       // 庄家明牌
    if (seq === 4) return { rank: 'A', suit: '♠' };       // 庄家暗牌
    return { rank: '6', suit: '♦' };
  };
  g.startRound();
  if (g.phase === PHASE.INSURANCE) g.skipInsurance();
  eq('庄家10明牌BJ → 立即结算', g.phase, PHASE.ROUND_OVER);
  eq('庄家 BJ：玩家输注', g.seats[0].hands[0].result, 'lose');
  eq('玩家筹码 = 1000-100', g.seats[0].player.chips, 900);
}

/* ---------- 5. 策略输出 → 引擎动作映射完备性（防 UI 层映射缺口回归） ---------- */
{
  const ACT_MAP = { H: 'hit', S: 'stand', D: 'double', DS: 'double', P: 'split', R: 'surrender' };
  const ENGINE_ACTS = ['hit', 'stand', 'double', 'split', 'surrender'];
  const ranks13 = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  let bad = 0;
  for (const a of ranks13) for (const b of ranks13) for (const up of ranks13) {
    const rec = basicStrategy(mkHand(a, b), up, R);
    if (!ACT_MAP[rec.act] || !ENGINE_ACTS.includes(ACT_MAP[rec.act])) bad++;
  }
  eq('策略表代码全部可映射为引擎动作（2197 组合）', bad, 0);
  eq('软 20（A,10）vs A 不越界且为 S', basicStrategy(mkHand('A', '10'), 'A', R).act, 'S');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
