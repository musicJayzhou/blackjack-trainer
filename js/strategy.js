/* ============================================================
 * strategy.js — 基本策略表与决策引擎（教学核心）
 * 基准：4-8 副、庄家 S17、DAS、可迟投降、BJ 赔 3:2
 * 来源交叉核验：Wizard of Odds / Blackjack Apprenticeship S17 PDF /
 *   blackjackinfo 策略引擎（H17 表）——三源逐格一致
 * ============================================================ */
'use strict';

/* 牌面点值（与 engine.js 保持一致；各自声明以兼容 Node 模块作用域） */
function rankValue(rank) {
  if (rank === 'A') return 11;
  if (['10', 'J', 'Q', 'K'].includes(rank)) return 10;
  return Number(rank);
}

/* 行动代码：H=要牌 S=停牌 D=加倍(否则H) DS=加倍(否则S) P=分牌 R=投降(否则H) */
const ACT_NAMES = {
  H: '要牌 Hit', S: '停牌 Stand', D: '加倍 Double',
  DS: '加倍 Double（不可则停牌）', P: '分牌 Split', R: '投降 Surrender',
};

/* 庄家明牌列索引 0..9 对应 2,3,4,5,6,7,8,9,10,A */
const UP = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'A'];
function upIdx(u) {
  if (u === 'A') return 9;
  if (['10', 'J', 'Q', 'K'].includes(u)) return 8;
  return UP.indexOf(u);
}

/* 每张表：行键 → 10 格数组（每格一个动作代码） */
/* ---------- 硬牌表（键 5..17，S17 / DAS） ---------- */
const HARD_S17 = {
  5:  ['H','H','H','H','H','H','H','H','H','H'],
  6:  ['H','H','H','H','H','H','H','H','H','H'],
  7:  ['H','H','H','H','H','H','H','H','H','H'],
  8:  ['H','H','H','H','H','H','H','H','H','H'],
  9:  ['H','D','D','D','D','H','H','H','H','H'],
  10: ['D','D','D','D','D','D','D','D','H','H'],
  11: ['D','D','D','D','D','D','D','D','D','H'],
  12: ['H','H','S','S','S','H','H','H','H','H'],
  13: ['S','S','S','S','S','H','H','H','H','H'],
  14: ['S','S','S','S','S','H','H','H','H','H'],
  15: ['S','S','S','S','S','H','H','H','R','H'],
  16: ['S','S','S','S','S','H','H','R','R','R'],
  17: ['S','S','S','S','S','S','S','S','S','S'],
};
/* ---------- 软牌表（键 = 非 A 牌面 2..9） ---------- */
const SOFT_S17 = {
  2: ['H','H','H','D','D','H','H','H','H','H'],
  3: ['H','H','H','D','D','H','H','H','H','H'],
  4: ['H','H','D','D','D','H','H','H','H','H'],
  5: ['H','H','D','D','D','H','H','H','H','H'],
  6: ['H','D','D','D','D','H','H','H','H','H'],
  7: ['S','DS','DS','DS','DS','S','S','H','H','H'],
  8: ['S','S','S','S','S','S','S','S','S','S'],
  9: ['S','S','S','S','S','S','S','S','S','S'],
};
/* ---------- 对子表（键 = 牌面点值 2..10，11 = A） ---------- */
const PAIR_S17 = {
  2:  ['P','P','P','P','P','P','H','H','H','H'],
  3:  ['P','P','P','P','P','P','H','H','H','H'],
  4:  ['H','H','H','P','P','H','H','H','H','H'],
  5:  ['D','D','D','D','D','D','D','D','H','H'],
  6:  ['P','P','P','P','P','H','H','H','H','H'],
  7:  ['P','P','P','P','P','P','H','H','H','H'],
  8:  ['P','P','P','P','P','P','P','P','P','P'],
  9:  ['P','P','P','P','P','S','P','P','S','S'],
  10: ['S','S','S','S','S','S','S','S','S','S'],
  11: ['P','P','P','P','P','P','P','P','P','P'],
};

/* ---------- 按规则生成当前策略表 ---------- */
function buildTables(rules = {}) {
  const R = { dealerHitSoft17: false, doubleAfterSplit: true, lateSurrender: true, ...rules };
  const clone = t => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, [...v]]));
  const hard = clone(HARD_S17), soft = clone(SOFT_S17), pair = clone(PAIR_S17);

  if (R.dealerHitSoft17) {                 /* H17 相对 S17 共 6 格差异 */
    soft[7][0] = 'DS';                     /* A,7 vs 2 */
    soft[8][4] = 'DS';                     /* A,8 vs 6 */
    hard[11][9] = 'D';                     /* 11 vs A */
    hard[15][9] = 'R';                     /* 15 vs A */
    hard[17][9] = 'R';                     /* 17 vs A */
    pair[8][9] = 'R';                      /* 8,8 vs A（投降，否则分牌） */
  }
  if (!R.doubleAfterSplit) {               /* NDAS 修正 */
    pair[2][0] = 'H'; pair[2][1] = 'H';
    pair[3][0] = 'H'; pair[3][1] = 'H';
    pair[4] = ['H','H','H','H','H','H','H','H','H','H'];   /* 4,4 一律不分 */
    pair[6][0] = 'H';
  }
  if (!R.lateSurrender) {                  /* 不可投降：R 格降级 */
    for (const row of [hard[15], hard[16]])
      for (let i = 0; i < 10; i++) if (row[i] === 'R') row[i] = 'H';
    if (R.dealerHitSoft17) {
      hard[15][9] = 'H'; hard[17][9] = 'S'; pair[8][9] = 'P';
    }
  }
  return { hard, soft, pair };
}

/* ---------- 决策查询 ----------
 * hand: Hand 实例；upRank: 庄家明牌 rank；rules: 规则子集
 * 返回 { act, table, rowLabel, col }，act 为推荐动作代码
 */
function basicStrategy(hand, upRank, rules = {}) {
  const R = { dealerHitSoft17: false, doubleAfterSplit: true, lateSurrender: true, ...rules };
  const ui = upIdx(upRank);
  const n = hand.cards.length;
  const t = buildTables(R);

  /* 1) 对子（仅首两张同值） */
  if (n === 2 && hand.isPair) {
    const val = rankValue(hand.cards[0].rank);
    const act = t.pair[val === 11 ? 11 : val][ui];
    return { act, table: 'pair', rowLabel: hand.cards[0].rank + ',' + hand.cards[1].rank };
  }
  /* 2) 软牌：两张时按"非 A 牌面"查行；多张时按 total-11 归行。
     统一 clamp 到 2..9：A,10（软 20）映射到第 9 行（同为永远停牌） */
  if (hand.isSoft) {
    let other;
    if (n === 2) other = rankValue(hand.cards.find(c => c.rank !== 'A').rank);
    else other = hand.total - 11;
    other = Math.min(Math.max(other, 2), 9);
    let act = t.soft[other][ui];
    if (n > 2 && act === 'D') act = 'H';       /* 三张以上不能加倍 */
    if (n > 2 && act === 'DS') act = 'S';
    return { act, table: 'soft', rowLabel: 'A,' + other };
  }
  /* 3) 硬牌 */
  const row = Math.min(Math.max(hand.total, 5), 17);
  let act = t.hard[row][ui];
  if (n > 2 && act === 'D') act = 'H';
  if (n > 2 && act === 'DS') act = 'S';
  if (act === 'R' && !R.lateSurrender) act = 'H';
  return { act, table: 'hard', rowLabel: String(row) };
}

/* ---------- 教学解释（按手牌类型与推荐动作生成中文理由） ---------- */
const DEALER_BUST = { 2: '35.4%', 3: '37.4%', 4: '39.6%', 5: '41.8%', 6: '42.3%',
  7: '26.2%', 8: '24.4%', 9: '22.9%', 10: '23.0%', A: '16.7%' };
const PLAYER_BUST = { 12: '31%', 13: '39%', 14: '46%', 15: '54%', 16: '62%', 17: '69%', 18: '77%', 19: '85%', 20: '92%' };

function explainDecision(hand, upRank, rec) {
  const upName = (['10', 'J', 'Q', 'K'].includes(upRank) ? '10' : upRank);
  const act = rec.act;
  let s = '';

  if (rec.table === 'pair') {
    const val = rankValue(hand.cards[0].rank);
    const P = {
      11: 'A,A 必分：软 12 非常弱，而每张 A 单独起步等于 11 点且不会爆——两个好起点远胜一个坏起点。',
      10: '10,10 绝不分：20 是几乎锁定胜局的手，拆成两个 10 起手会大幅拉低期望。',
      9: '9,9：对 2-6（庄家弱牌）和 8-9 分牌扩大优势；对 7 停牌（你的 18 已赢庄家最常见的 17）；对 10/A 停牌保平安。',
      8: '8,8 必分：16 是全游戏最差的硬牌。以庄家 10 为例：要牌/停牌期望损失都超过 53%，分牌只损约 47.5%——分 8 是止损而非求胜。',
      7: '7,7：对 2-7 分牌（14 太弱，庄家爆率 ' + DEALER_BUST[2] + '-' + DEALER_BUST[7] + '）；对 8+ 只能要牌搏翻盘。',
      6: '6,6：对 2-6 分牌（DAS 规则下拆出两个 6 起手面对弱庄家更有利）；对 7+ 直接要牌。',
      5: '5,5 绝不分：合计 10 是强加倍手（对 2-9 加倍），拆成两个 5 是自毁优势。',
      4: '4,4：仅对庄家 5/6 分牌（DAS）；其余按硬 8 处理直接要牌。',
      3: '3,3：对 2-7 分牌（DAS，6 太小）；对 8+ 直接要牌。',
      2: '2,2：对 2-7 分牌（DAS，4 太小）；对 8+ 直接要牌。',
    };
    s = P[val] || '';
  } else if (rec.table === 'soft') {
    const other = Number(rec.rowLabel.split(',')[1]);
    const tot = 11 + other;
    if (tot <= 17) s = `软 ${tot}：A 提供弹性，要牌不可能爆，还能升级成强牌；对庄家弱牌（4-6，爆率 ${DEALER_BUST[4]}-${DEALER_BUST[6]}）加倍更有利。`;
    else if (tot === 18) s = '软 18（A,7）是最微妙的一手：对 3-6 加倍收割、对 2/7/8 停牌、对 9/10/A 要牌——18 面对强牌只是弱牌，A 的柔性让它可以继续发展。';
    else s = `软 ${tot} 已足够强，停牌即可（软 19/20 几乎不需要动）。`;
  } else {
    const tot = Number(rec.rowLabel);
    if (tot <= 8) s = `硬 ${tot} 太小，任何庄家明牌下都要继续要牌（不可能爆）。`;
    else if (tot === 9) s = `硬 9：仅对庄家 3-6（弱牌，爆率 ${DEALER_BUST[3]}-${DEALER_BUST[6]}）加倍；其余要牌先发展。`;
    else if (tot === 10) s = '硬 10 起手很强：约 30.8% 抽到 10 值牌直接 20。对 2-9 加倍；对 10/A 庄家太强，只补牌不加注。';
    else if (tot === 11) s = '硬 11 是全游戏最佳加倍手：要牌不可能爆，约 30.8% 直接到 21，其余大多 ≥17。' + (upRank === 'A' ? '唯独庄家 A 在 S17 规则下强到不宜加注，改为要牌。' : '');
    else if (tot === 12) s = `12 是临界手：庄家 4/5/6 爆率高（${DEALER_BUST[4]}/${DEALER_BUST[5]}/${DEALER_BUST[6]}），停牌等它自爆；对 2/3 庄家爆率不够（${DEALER_BUST[2]}/${DEALER_BUST[3]}），只好要牌（自身爆率仅 ${PLAYER_BUST[12]}）。`;
    else if (tot >= 13 && tot <= 16) s = `硬 ${tot}：对 2-6 停牌（庄家弱牌爆率 ${DEALER_BUST[2]}-${DEALER_BUST[6]}，等它自爆）；对 7+ 庄家大概率成 17+，站牌基本必输，只能要牌搏一把（爆率约 ${PLAYER_BUST[tot]}）。`;
    else if (tot === 17) s = '硬 17+ 任何情况下停牌（17 要牌爆率约 69%）。';
    else s = `硬 ${tot} 停牌。`;
    if (act === 'R') s = `投降更好：这手胜率不足三成，投降锁定 -50% 损失，优于继续打的期望。` + s;
  }
  return s;
}

/* 保险决策：基本策略永远不买 */
const INSURANCE_ADVICE = {
  act: 'no',
  why: '基本策略下永远不买保险。保险是"赌庄家暗牌为 10 值牌"的 2:1 侧注：10 值牌占牌面 4/13≈30.8%，保本需要 >1/3（33.3%），期望约 -7.7%——比主局 ~0.5% 差一个数量级。唯一例外是算牌者确认剩余牌中 10 值牌比例超过 1/3。自己拿到 Blackjack 时也应拒绝 even money（期望 103.9% > 锁定的 100%）。',
};

/* 导出 */
if (typeof module !== 'undefined' && module.exports)
  module.exports = { ACT_NAMES, UP, upIdx, buildTables, basicStrategy, explainDecision, INSURANCE_ADVICE, DEALER_BUST, PLAYER_BUST, HARD_S17, SOFT_S17, PAIR_S17 };
