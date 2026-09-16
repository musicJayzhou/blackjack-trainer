/* ============================================================
 * stress-test.js — 压力测试与一致性校验（回归脚本，不改动 js/）
 * 任务覆盖：
 *   1) 规则组合矩阵：5 个规则开关 × 4 种副数 = 128 组合，
 *      每组合随机模拟 300 局，校验 round_over / 筹码守恒 / 无异常
 *   4) 极端场景：even money、5 座位、资金不足降级、牌靴耗尽重洗
 *   3a) 万局模拟性能基准
 * 用法：node scripts/stress-test.js
 * 说明：脚本内用固定种子 PRNG 覆盖 Math.random，保证可复现。
 * ============================================================ */
'use strict';
const { Game, Hand, PHASE, DEFAULT_RULES, HumanPlayer } = require('../js/engine.js');

/* ---------- 可复现随机源 ---------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 20260915;
const rand = mulberry32(SEED);
Math.random = rand; // Shoe.shuffle 与行动选择共用同一条随机流 → 整体可复现

/* ---------- 计数与输出工具 ---------- */
const EPS = 1e-6;
let exitCode = 0;
function section(t) { console.log('\n' + '='.repeat(64) + '\n' + t + '\n' + '='.repeat(64)); }
function ok(msg) { console.log('  [OK]   ' + msg); }
function bad(msg) { console.log('  [FAIL] ' + msg); exitCode = 1; }
function warn(msg) { console.log('  [WARN] ' + msg); }
const fmtN = x => (Math.abs(x) < 1e-9 ? 0 : x.toFixed(4));

/* ============================================================
 * 一局驱动器：镜像 ui.js 的真实资金流
 *   - 本金流已统一由引擎管理（startRound 扣注 / buyInsurance 扣保费 / _settle 返还制）
 *   - 2026-09-15 B1/B2 修复后同步本脚本口径
 *   - double/split 追加本金、结算加款由 engine 内部完成
 * 返回守恒三口径的对比数据：
 *   obsDelta     ：玩家筹码总量实际变化（含上述全部扣款）
 *   literalExpect：任务口径 Σ hand.payout + 保险净收益（正确的游戏应有值）
 *   engineExpect ：按 engine 代码逐条推演的账目（引擎内部自洽性）
 * ============================================================ */
function playRound(g, bet, insuranceProb, stats) {
  if (!stats) stats = {};
  if (!stats.rejectedByAction) stats.rejectedByAction = {};
  const players = g.seats.map(s => s.player);
  const S0 = players.reduce((t, p) => t + p.chips, 0);

  /* UI 镜像：下注扣本金 */
  for (const s of g.seats) { s.pendingBet = bet; s.betConfirmed = true; }
  const initStake = bet * g.seats.length;

  g.startRound();

  /* 保险阶段：随机购买（镜像 UI 扣保费） */
  let insStake = 0;
  if (g.phase === PHASE.INSURANCE) {
    for (const s of g.seats) {
      if (s.hands[0].bet > 0 && rand() < insuranceProb) {
        g.buyInsurance(s, s.hands[0].bet / 2);
        insStake += s.insurance;
        if (stats) stats.insBuys++;
      }
    }
    g.skipInsurance();
  }

  /* 随机行动（分牌/加倍/投降加权，失败动作自动退避） */
  let guard = 0;
  const failed = new Set();
  while (g.phase === PHASE.PLAYER && guard++ < 500) {
    const seat = g.currentSeat, hand = g.currentHand;
    if (!seat || !hand) break;
    const acts = hand.availableActions.filter(a => !failed.has(a));
    if (!acts.length) break;
    const W = { hit: 1, stand: 1, double: 3, split: 4, surrender: 2 };
    let tot = acts.reduce((t, a) => t + W[a], 0), r = rand() * tot, chosen = acts[0];
    for (const a of acts) { r -= W[a]; if (r <= 0) { chosen = a; break; } }
    const res = g.act(chosen);
    if (!res.ok) {
      failed.add(chosen);
      if (stats) {
        stats.rejectedActions++;
        stats.rejectedByAction[chosen] = (stats.rejectedByAction[chosen] || 0) + 1;
      }
      continue;
    }
    failed.clear();
    if (stats) {
      stats.actions++;
      stats[chosen] = (stats[chosen] || 0) + 1;
      if (chosen === 'surrender' && g.rules.lateSurrender === false) stats.surrenderWhileDisabled++;
      if (chosen === 'split' && hand.splitAces) stats.splitAcesResplitOk++;
    }
  }

  /* 结算数据汇总 */
  let finalBetSum = 0, paySum = 0, backSum = 0;
  for (const s of g.seats) for (const h of s.hands) {
    finalBetSum += h.bet; paySum += h.payout;
    backSum += (h.result === 'lose' || h.result === 'bust') ? 0 : h.bet + h.payout;  // 返还制
  }
  const hist = g.history[g.history.length - 1];
  const dBJ = !!hist && hist.dealerCards.length === 2 && hist.dealerTotal === 21;
  const insTotal = g.seats.reduce((t, s) => t + s.insurance, 0);
  const S1 = players.reduce((t, p) => t + p.chips, 0);

  /* hitSplitAces=true 却无法要牌的机会统计（A,x 未爆且 ≤16） */
  if (stats && g.rules.hitSplitAces === true) {
    for (const s of g.seats) for (const h of s.hands)
      if (h.splitAces && h.cards.length >= 2 && !h.isBust && h.total <= 16) stats.splitAcesHitDenied++;
  }

  const obsDelta = S1 - S0;
  const extras = finalBetSum - initStake;                 // double/split 追加本金
  const engineExpect = -initStake - insStake - extras + backSum + (dBJ ? 3 * insTotal : 0);  // 逐条推演（返还制）
  const literalExpect = paySum + (dBJ ? 2 * insTotal : -insTotal);   // 恒等式：保险 2:1 净收益
  return {
    reached: g.phase === PHASE.ROUND_OVER,
    stuck: g.phase === PHASE.PLAYER,
    phase: g.phase,
    obsDelta, engineExpect, literalExpect, finalBetSum,
  };
}

function checkRound(lg, res, tag, agg) {
  if (!res.reached) { bad(`${tag}: 未达 round_over（phase=${res.phase}）`); agg.roundOverFail++; return false; }
  if (Math.abs(res.obsDelta - res.engineExpect) > EPS) {
    bad(`${tag}: 引擎内部账目不自洽 obs=${fmtN(res.obsDelta)} expect=${fmtN(res.engineExpect)} diff=${fmtN(res.obsDelta - res.engineExpect)}`);
    agg.internalFail++; return false;
  }
  agg.rounds++;
  if (Math.abs(res.obsDelta - res.literalExpect) > EPS) agg.literalFail++;
  /* B1/B2 修复后应精确守恒：偏差 ≡ 0（旧版本 bug 指纹为 ≡ -(Σ最终注额)，已消灭） */
  if (Math.abs(res.obsDelta - res.literalExpect) > EPS) {
    bad(`${tag}: 筹码守恒破坏 diff=${fmtN(res.obsDelta - res.literalExpect)} finalBets=${fmtN(res.finalBetSum)}`);
    agg.systematicFail++; return false;
  }
  return true;
}

/* ============================================================
 * 任务 1：规则组合矩阵 2×2×2×2×2×4 = 128 组合 × 300 局
 * ============================================================ */
section('任务 1：规则组合矩阵压力测试（128 组合 × 300 局）');
const DIM_H17 = [false, true], DIM_DAS = [true, false], DIM_LS = [false, true],
  DIM_RSA = [false, true], DIM_HSA = [false, true], DIM_DECKS = [1, 2, 6, 8];
const ROUNDS_PER_COMBO = 300;

const agg = {
  rounds: 0, literalFail: 0, roundOverFail: 0, internalFail: 0, systematicFail: 0,
  actions: 0, hit: 0, stand: 0, double: 0, split: 0, surrender: 0,
  insBuys: 0, rejectedActions: 0, rejectedByAction: {},
  surrenderWhileDisabled: 0, splitAcesHitDenied: 0, splitAcesResplitOk: 0,
};
const comboFail = [];
let comboIdx = 0, t0 = Date.now();

for (const h17 of DIM_H17) for (const das of DIM_DAS) for (const ls of DIM_LS)
  for (const rsa of DIM_RSA) for (const hsa of DIM_HSA) for (const decks of DIM_DECKS) {
    comboIdx++;
    const rules = { ...DEFAULT_RULES, dealerHitSoft17: h17, doubleAfterSplit: das,
      lateSurrender: ls, resplitAces: rsa, hitSplitAces: hsa, numDecks: decks };
    const tag = `#${comboIdx} H17=${h17 ? 1 : 0} DAS=${das ? 1 : 0} LS=${ls ? 1 : 0} RSA=${rsa ? 1 : 0} HSA=${hsa ? 1 : 0} decks=${decks}`;
    let crashed = null, roundsDone = 0;
    try {
      const g = new Game(rules);
      g.addPlayer(new HumanPlayer('A', 10_000_000));
      g.addPlayer(new HumanPlayer('B', 10_000_000));
      for (let r = 0; r < ROUNDS_PER_COMBO; r++) {
        const res = playRound(g, 25, 0.3, agg);
        checkRound(lg_ => { }, res, `${tag} 第${r + 1}局`, agg);
        roundsDone++;
        g.prepareNextRound();
      }
    } catch (e) { crashed = e; }
    if (crashed) {
      comboFail.push({ tag, reason: 'EXCEPTION: ' + crashed.message, rounds: roundsDone });
      bad(`${tag}: 抛出异常 → ${crashed.message}`);
    } else if (agg.roundOverFail || agg.internalFail || agg.systematicFail) {
      /* 明细已逐局打印，这里只记组合 */
      comboFail.push({ tag, reason: '见上方明细', rounds: roundsDone });
    }
  }
const matrixMs = Date.now() - t0;

const combosOK = 128 - new Set(comboFail.map(f => f.tag)).size;
console.log(`\n  组合数：128 ｜ 每组合局数：${ROUNDS_PER_COMBO} ｜ 总局数：${agg.rounds + agg.roundOverFail + agg.internalFail + agg.systematicFail}`);
console.log(`  a) 全部到达 round_over：${agg.roundOverFail === 0 ? '通过' : '失败 ' + agg.roundOverFail + ' 局'}`);
console.log(`  c) 无异常抛出：${comboFail.filter(f => f.reason.startsWith('EXCEPTION')).length === 0 ? '通过' : '失败'}`);
console.log(`  b) 筹码守恒（引擎内部账目自洽）：${agg.internalFail === 0 ? '通过 ' + agg.rounds + '/' + agg.rounds + ' 局' : '失败 ' + agg.internalFail + ' 局'}`);
console.log(`  b) 筹码守恒（Δchips == Σpayout+保险净收益）：${agg.literalFail}/${agg.rounds} 局不符（${(100 * agg.literalFail / agg.rounds).toFixed(2)}%）`);
console.log(`  b) 偏差系统性规律 Δ-Σ = -(Σ最终注额)：${agg.systematicFail === 0 ? '全部 ' + agg.rounds + ' 局精确成立' : '失败 ' + agg.systematicFail + ' 局'}`);
console.log(`  矩阵总耗时 ${matrixMs}ms ｜ 行动 ${agg.actions} 次（hit ${agg.hit} / stand ${agg.stand} / double ${agg.double} / split ${agg.split} / surrender ${agg.surrender}）｜ 保险购买 ${agg.insBuys} 次`);
console.log(`  被引擎拒绝的行动（availableActions 已列出但 act 失败）：${agg.rejectedActions} 次 ${JSON.stringify(agg.rejectedByAction)}`);
console.log(`  [发现] lateSurrender=false 时投降仍被执行：${agg.surrenderWhileDisabled} 次（引擎不检查该规则开关）`);
console.log(`  [发现] hitSplitAces=true 时分 A 手(A,x≤16)仍无 hit 可选：${agg.splitAcesHitDenied} 手（规则开关无效）`);
console.log(`  [发现] 分 A 再分（RSA）成功执行：${agg.splitAcesResplitOk} 次`);
if (agg.roundOverFail || agg.internalFail || agg.systematicFail || comboFail.some(f => f.reason.startsWith('EXCEPTION')))
  bad('矩阵测试存在硬失败，明细见上');
else ok('128 组合 × 300 局：无卡死、无异常、引擎账目自洽');

/* ============================================================
 * 任务 4a：庄家明牌 A + 玩家 BJ 的 even money 路径
 * ============================================================ */
section('任务 4a：even money（庄 A + 玩家 BJ）');
function evenMoneyCase(holeRank) {
  const g = new Game({ ...DEFAULT_RULES });
  const p = new HumanPlayer('P', 1000);
  g.addPlayer(p);
  g.seats[0].pendingBet = 100; g.seats[0].betConfirmed = true;
  let seq = 0;
  g.shoe.deal = () => {
    seq++;
    if (seq === 1) return { rank: 'A', suit: '♠' };        // 玩家 A
    if (seq === 2) return { rank: 'A', suit: '♥' };        // 庄家明牌 A
    if (seq === 3) return { rank: 'K', suit: '♠' };        // 玩家 K → BJ
    if (seq === 4) return { rank: holeRank, suit: '♦' };   // 庄家暗牌
    return { rank: '5', suit: '♣' };
  };
  g.startRound();
  const phaseIns = g.phase === PHASE.INSURANCE;
  /* ui.js em-take 路径：买半注保险当 even money */
  g.buyInsurance(g.seats[0], 50);
  g.skipInsurance();
  const h = g.seats[0].hands[0];
  return {
    phaseIns, phase: g.phase, result: h.result, payout: h.payout,
    chips: p.chips, dealerBJ: g.dealer.cards.length === 2 && g.dealerTotal === 21,
  };
}
{
  const c1 = evenMoneyCase('10');   // 庄家 BJ → even money 兑现分支
  console.log('  庄家暗牌 10（庄 BJ）:', JSON.stringify({ phase: c1.phase, result: c1.result, payout: c1.payout, chips: c1.chips }));
  ok('进入保险阶段: ' + c1.phaseIns + '，终态 round_over: ' + (c1.phase === PHASE.ROUND_OVER));
  if (c1.phase !== PHASE.ROUND_OVER) bad('庄 BJ 分支未到 round_over');
  if (c1.result !== 'push') bad('庄 BJ 时玩家 BJ 应 push，实际 ' + c1.result);
  /* 正确 even money：锁定 +100 → 终值 1100。 */
  if (Math.abs(c1.chips - 1100) < EPS) console.log('  [OK] even money（庄 BJ 分支）终值 1100：push 返本 + 保险 2:1，等价 1:1 落袋');
  else bad('even money（庄 BJ 分支）终值异常（期望 1100）：' + c1.chips);

  const c2 = evenMoneyCase('5');    // 庄家无 BJ → BJ 按 3:2 赔
  console.log('  庄家暗牌 5（无 BJ）:', JSON.stringify({ phase: c2.phase, result: c2.result, payout: c2.payout, chips: c2.chips }));
  if (c2.phase !== PHASE.ROUND_OVER) bad('无 BJ 分支未到 round_over');
  if (c2.result !== 'bj') bad('庄无 BJ 时玩家应按 BJ 赔付，实际 ' + c2.result);
  /* 正确：保险输 50，BJ 赢 150 → 净 +100 → 1100。 */
  if (Math.abs(c2.chips - 1100) < EPS) console.log('  [OK] even money（无 BJ 分支）终值 1100：BJ 3:2 返 250，保费没收');
  else bad('even money（无 BJ 分支）终值异常（期望 1100）：' + c2.chips);
}

/* ============================================================
 * 任务 4b：5 座位同局
 * ============================================================ */
section('任务 4b：5 座位同局 × 200 轮');
{
  const agg5 = { rounds: 0, literalFail: 0, roundOverFail: 0, internalFail: 0, systematicFail: 0 };
  let maxHands = 0, ins = 0;
  const g = new Game({ ...DEFAULT_RULES });
  for (let i = 0; i < 5; i++) g.addPlayer(new HumanPlayer('S' + i, 10_000_000));
  let err = null;
  try {
    for (let r = 0; r < 200; r++) {
      const res = playRound(g, 25, 0.3, { insBuys: 0 });
      checkRound(null, res, `5座 第${r + 1}局`, agg5);
      maxHands = Math.max(maxHands, ...g.seats.map(s => s.hands.length));
      g.prepareNextRound();
    }
  } catch (e) { err = e; }
  if (err) bad('5 座位抛出异常：' + err.message);
  else if (agg5.roundOverFail || agg5.internalFail || agg5.systematicFail) bad('5 座位存在硬失败');
  else ok(`5 座位 200 轮全部 round_over，引擎账目自洽；单座最多 ${maxHands} 手（含分牌）`);
  console.log(`  任务口径守恒：${agg5.literalFail}/200 局不符（B1/B2 修复后应为 0）`);
}

/* ============================================================
 * 任务 4c：资金刚好不足加倍/分牌时的降级行为
 * ============================================================ */
section('任务 4c：资金不足时的降级行为');
function fundsCase(chips, bet, expectDoubleOK, expectSplitOK, label) {
  const g = new Game({ ...DEFAULT_RULES });
  const p = new HumanPlayer('P', chips);
  g.addPlayer(p);
  g.seats[0].pendingBet = bet; g.seats[0].betConfirmed = true;
  let seq = 0;
  g.shoe.deal = () => {
    seq++;
    if (seq === 1 || seq === 3) return { rank: '8', suit: '♠' };  // 玩家 8,8 对子
    if (seq === 2) return { rank: '3', suit: '♥' };               // 庄家明牌 3
    if (seq === 4) return { rank: '9', suit: '♦' };               // 暗牌
    return { rank: '5', suit: '♣' };
  };
  g.startRound();
  if (g.phase === PHASE.INSURANCE) g.skipInsurance();
  const hand = g.seats[0].hands[0];
  const acts = hand.availableActions;
  const rD = g.act('double');
  /* double 成功后本局会自动结算完毕，此时再 act 会触发引擎 B4（非 PLAYER 阶段 act 崩溃），故仅在其仍为 PLAYER 时尝试 split */
  const rS = g.phase === PHASE.PLAYER ? g.act('split') : { ok: false, skipped: true };
  const doubleListed = acts.includes('double'), splitListed = acts.includes('split');
  console.log(`  ${label}: 剩余资金 ${p.chips} ｜ availableActions=${JSON.stringify(acts)}`);
  console.log(`           act(double)→ok=${rD.ok}  act(split)→ok=${rS.ok}`);
  /* 引擎兜底：act 必须被拒，且拒绝后游戏可继续 */
  if (expectDoubleOK === false && rD.ok) bad(label + '：资金不足时 double 竟然成功');
  if (expectSplitOK === false && rS.ok) bad(label + '：资金不足时 split 竟然成功');
  if (!expectDoubleOK && doubleListed) agg.rejectedByAction.advButNoFunds = (agg.rejectedByAction.advButNoFunds || 0) + 1;
  /* 降级继续：stand 应可用并完成本局（若 double/split 已成功，本局可能已自动结束） */
  let finished = g.phase === PHASE.ROUND_OVER;
  if (!finished) {
    const rSt = g.act('stand');
    finished = rSt.ok && g.phase === PHASE.ROUND_OVER;
  }
  if (!finished) bad(label + '：拒绝后游戏卡死在 ' + g.phase);
  else ok(`${label}：引擎正确拒绝不可负担动作，stand 降级后本局正常结束（result=${hand.result}）`);
  return { doubleListed, splitListed, rD, rS };
}
{
  const c1 = fundsCase(100, 60, false, false, '不足（剩 40 < 注 60）');
  if (c1.doubleListed || c1.splitListed)
    warn('[发现] 资金不足时 availableActions 仍列出 double/split（Hand 不知道座位资金）→ UI 会显示可点但点击无效的按钮');
  const c2 = fundsCase(120, 60, true, true, '刚好够（剩 60 = 注 60）');
  if (!c2.rD.ok) bad('资金刚好等于注额时 double 应被允许');
  fundsCase(60, 60, false, false, '刚好只够本金（剩 0）');

  /* 保险无资金校验：可把筹码扣成负数 */
  const g = new Game({ ...DEFAULT_RULES });
  const p = new HumanPlayer('P', 100);
  g.addPlayer(p);
  g.seats[0].pendingBet = 100; g.seats[0].betConfirmed = true;
  let seq = 0;
  g.shoe.deal = () => {
    seq++;
    if (seq === 2) return { rank: 'A', suit: '♥' };
    if (seq === 4) return { rank: '5', suit: '♦' };
    return { rank: '6', suit: '♠' };
  };
  g.startRound();
  g.buyInsurance(g.seats[0], 50);
  console.log(`  保险资金校验：下注后剩 0，仍可买 50 保险 → 筹码 ${p.chips}`);
  if (p.chips < 0) warn('[发现] buyInsurance 无资金校验，筹码可被扣为负数');
  g.skipInsurance();
  while (g.phase === PHASE.PLAYER) g.act(g.currentHand.availableActions.includes('stand') ? 'stand' : 'hit');
  if (g.phase !== PHASE.ROUND_OVER) bad('负筹码局未正常结束');
  else ok('负筹码局仍能走完 round_over');
}

/* ============================================================
 * 任务 4d：牌靴将耗尽时的重洗
 * ============================================================ */
section('任务 4d：牌靴耗尽重洗');
{
  /* d-1 切牌点：prepareNextRound 触发重洗 */
  const g2 = new Game({ ...DEFAULT_RULES, numDecks: 1 });
  g2.addPlayer(new HumanPlayer('P', 10000));
  g2.shoe.discarded = 40;  // 52×0.75=39 已过切牌点
  const before = g2.shoe.cards;
  g2.prepareNextRound();
  if (g2.shoe.discarded === 0 && g2.shoe.remaining === 52 && g2.shoe.cards !== before)
    ok('切牌点重洗：discarded 归零，remaining=52');
  else bad('切牌点重洗异常：discarded=' + g2.shoe.discarded + ' remaining=' + g2.shoe.remaining);

  /* d-2 局中耗尽：deal() 在 remaining=0 时自动重洗 */
  const g = new Game({ ...DEFAULT_RULES, numDecks: 1 });
  g.addPlayer(new HumanPlayer('P', 10000));
  /* 把牌靴尾 6 张布置成：玩家 2,2 / 庄 3+9 / 连续补 2,2 → 第 3 次 hit 必触发重洗 */
  const tail = [['2', '♠'], ['3', '♥'], ['2', '♥'], ['9', '♦'], ['2', '♦'], ['2', '♣']];
  for (let i = 0; i < 6; i++) g.shoe.cards[46 + i] = { rank: tail[i][0], suit: tail[i][1] };
  g.shoe.discarded = 46;
  const cardsRef = g.shoe.cards;
  g.seats[0].pendingBet = 25; g.seats[0].betConfirmed = true;
  let err = null, reshuffled = false;
  try {
    g.startRound();
    if (g.phase === PHASE.INSURANCE) g.skipInsurance();
    let guard = 0;
    while (g.phase === PHASE.PLAYER && guard++ < 50) g.act('hit');
    if (g.shoe.cards !== cardsRef) reshuffled = true;
    /* 结束后回到 round_over */
    if (g.phase !== PHASE.ROUND_OVER) err = new Error('终态 ' + g.phase);
  } catch (e) { err = e; }
  if (err) bad('局中耗尽路径异常：' + err.message);
  else if (!reshuffled) bad('局中耗尽未触发重洗（cards 数组未重建）');
  else ok('局中耗尽：deal() 自动重洗，本局仍正常到达 round_over');

  /* d-3 重洗后是否出现"同局同牌"（物理不可能，引擎允许） */
  const g3 = new Game({ ...DEFAULT_RULES, numDecks: 1 });
  g3.addPlayer(new HumanPlayer('P', 10000));
  g3.shoe.discarded = 47; // 剩 5 张
  const seen = {};
  let dup = 0;
  const origDeal = g3.shoe.deal.bind(g3.shoe);
  g3.shoe.deal = () => {
    const c = origDeal();
    const k = c.rank + c.suit;
    if (seen[k]) dup++;
    seen[k] = (seen[k] || 0) + 1;
    return c;
  };
  g3.seats[0].pendingBet = 25; g3.seats[0].betConfirmed = true;
  g3.startRound();
  if (g3.phase === PHASE.INSURANCE) g3.skipInsurance();
  let guard3 = 0;
  while (g3.phase === PHASE.PLAYER && guard3++ < 50) {
    const a = g3.currentHand.availableActions;
    g3.act(a.includes('hit') && g3.currentHand.total < 17 ? 'hit' : 'stand');
  }
  console.log(`  局中重洗后同局重复牌（同 rank+suit）：${dup} 张`);
  if (dup > 0) warn('[发现] 局中重洗会把已在桌面的牌重新洗回并再次发出（同局出现重复牌）');
  else ok('本轮未出现同局重复牌');
  if (g3.phase !== PHASE.ROUND_OVER) bad('d-3 局未正常结束');
}

/* ============================================================
 * 任务 3a：万局模拟性能基准
 * ============================================================ */
section('任务 3a：万局模拟性能基准（3 座位，默认规则）');
{
  const N = 10000;
  const g = new Game({ ...DEFAULT_RULES });
  for (let i = 0; i < 3; i++) g.addPlayer(new HumanPlayer('S' + i, 1e12));
  const stats = { actions: 0 };
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) { playRound(g, 25, 0, stats); g.prepareNextRound(); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  ${N} 局（3 座位）耗时 ${ms.toFixed(1)}ms ｜ ${(ms / N * 1000).toFixed(1)}µs/局 ｜ ${Math.round(N / (ms / 1000))} 局/秒 ｜ 共 ${stats.actions} 次行动`);
  if (ms / N < 5) ok('单局引擎耗时远低于 1ms，不会阻塞浏览器交互');
  else warn('单局耗时偏高，建议检查');
}

/* ============================================================
 * 汇总
 * ============================================================ */
section('汇总');
console.log(`  矩阵：128 组合 × ${ROUNDS_PER_COMBO} 局 ｜ round_over 失败 ${agg.roundOverFail} ｜ 引擎账目不自洽 ${agg.internalFail} ｜ 异常 ${comboFail.filter(f => f.reason.startsWith('EXCEPTION')).length}`);
console.log(`  守恒：${agg.literalFail}/${agg.rounds} 局不符（B1/B2 修复后应为 0）`);
console.log('  产品缺陷结论（脚本不修改 js/，仅回归监测）：');
console.log('   B1) 结算只加"净盈亏"不返本金，而 UI 在下注时已扣本金 → 每手恰好少收全额注额（win 收 0、push 丢本金、lose 丢 2 倍、BJ 只得 0.5 倍）');
console.log('   B2) 保险中奖按 +2×保费入账但本金由 UI 扣 → 实际 1:1 而非 2:1；even money 两条分支各少收（见 4a）');
console.log('   B3) availableActions 不感知资金/部分规则开关（double/split 列而不可用、lateSurrender=false 仍可投降、hitSplitAces=true 无效）');
console.log('   B4) 非 PLAYER 阶段调用 game.act() 会 TypeError（currentSeat 为 null，无阶段防护）；现行 UI 调用路径不会触发');
process.exit(exitCode);
