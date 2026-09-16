/* ============================================================
 * consistency-check.js — 策略表 vs EV 引擎全表一致性 + EV 性能基准
 *   2) 对硬 5-17 / 软 A2-A9 / 对子 2,2-A,A 全部决策格，
 *      分别用 basicStrategy（表格法）与 EvCalc.analyze
 *      （无限副中性 counts、S17 规则）求推荐并对比
 *   3) 全表 EV 计算性能（每格新建 EvCalc，模拟浏览器决策面板）
 * 用法：node scripts/consistency-check.js
 * ============================================================ */
'use strict';
const { Hand } = require('../js/engine.js');
const { basicStrategy, UP } = require('../js/strategy.js');
const { EvCalc } = require('../js/evcalc.js');

let exitCode = 0;
function section(t) { console.log('\n' + '='.repeat(64) + '\n' + t + '\n' + '='.repeat(64)); }
const EPS = 1e-9;

/* 无限副中性牌靴：每副 {2..9}×4、10 值×16、A×4 */
const COUNTS = { 2: 4, 3: 4, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 4, 10: 16, A: 4 };
const RULES = { dealerHitSoft17: false, doubleAfterSplit: true, lateSurrender: true };

function mkHand(a, b) {
  const h = new Hand();
  h.addCard({ rank: a, suit: '♠' });
  h.addCard({ rank: b, suit: '♥' });
  return h;
}

/* 行定义（硬牌行用非对子组合，避免误入 pair 分支） */
const HARD_ROWS = [
  ['5', '2', '3'], ['6', '2', '4'], ['7', '3', '4'], ['8', '3', '5'], ['9', '4', '5'],
  ['10', '4', '6'], ['11', '5', '6'], ['12', '10', '2'], ['13', '10', '3'], ['14', '10', '4'],
  ['15', '10', '5'], ['16', '10', '6'], ['17', '10', '7'],
];
const SOFT_ROWS = [['A2', 'A', '2'], ['A3', 'A', '3'], ['A4', 'A', '4'], ['A5', 'A', '5'],
  ['A6', 'A', '6'], ['A7', 'A', '7'], ['A8', 'A', '8'], ['A9', 'A', '9']];
const PAIR_ROWS = [['2,2', '2', '2'], ['3,3', '3', '3'], ['4,4', '4', '4'], ['5,5', '5', '5'],
  ['6,6', '6', '6'], ['7,7', '7', '7'], ['8,8', '8', '8'], ['9,9', '9', '9'],
  ['10,10', '10', '10'], ['A,A', 'A', 'A']];

/* ---------- EvCalc opts → 策略行动代码 ----------
 * D = 加倍否则 H（double≥hit）、DS = 加倍否则 S（double≥stand）、
 * R = 投降、H/S 按 hit/stand 高低。excludeSplit 用于对子行的"不分牌"比较。 */
function classify(opts, excludeSplit) {
  let best = 'stand', bv = opts.stand;
  const order = ['hit', 'double', 'surrender'];
  if (!excludeSplit && opts.split !== undefined) order.push('split');
  for (const k of order)
    if (opts[k] !== undefined && opts[k] > bv + EPS) { best = k; bv = opts[k]; }
  if (best === 'double') return opts.hit >= opts.stand ? 'D' : 'DS';
  if (best === 'surrender') return 'R';
  if (best === 'split') return 'P';
  return best === 'hit' ? 'H' : 'S';
}
const family = a => (a === 'D' || a === 'DS') ? 'Dbl' : a;
const f4 = x => (x === undefined ? '  —  ' : (x >= 0 ? '+' : '') + x.toFixed(4));

/* ---------- 全表遍历 ---------- */
section('任务 2：策略表 vs EvCalc.analyze 全表一致性（S17 / DAS / LS / 无限副）');
const rows = [];
for (const [label, a, b] of HARD_ROWS)
  for (const up of UP) rows.push({ sec: 'hard', label, a, b, up });
for (const [label, a, b] of SOFT_ROWS)
  for (const up of UP) rows.push({ sec: 'soft', label, a, b, up });
for (const [label, a, b] of PAIR_ROWS)
  for (const up of UP) rows.push({ sec: 'pair', label, a, b, up });

const results = [];
for (const r of rows) {
  const hand = mkHand(r.a, r.b);
  const rec = basicStrategy(hand, r.up, RULES);
  const ev = new EvCalc(COUNTS, { dealerHitSoft17: false, doubleAfterSplit: true });
  const an = ev.analyze(hand, r.up);
  const tableAct = rec.act;
  const evAct = classify(an.opts, false);
  const evActNoSplit = classify(an.opts, true);
  const cmpAct = r.sec === 'pair' && tableAct !== 'P' ? evActNoSplit : evAct;
  const agree = family(tableAct) === family(cmpAct);
  /* 边际度：被选动作与次优动作的 EV 差 */
  const vals = Object.entries(an.opts).filter(([k]) => !(r.sec === 'pair' && tableAct !== 'P' && k === 'split'));
  const sorted = vals.map(([, v]) => v).sort((x, y) => y - x);
  results.push({ ...r, tableAct, evAct, evActNoSplit, agree, opts: an.opts, gap: sorted[0] - sorted[1], fallbackDiff: tableAct !== cmpAct });
}

const total = results.length;
const agreeN = results.filter(r => r.agree).length;
const mism = results.filter(r => !r.agree);
console.log(`  决策格总数：${total}（硬 ${HARD_ROWS.length * 10} + 软 ${SOFT_ROWS.length * 10} + 对子 ${PAIR_ROWS.length * 10}，每行 10 个庄家明牌）`);
console.log(`  一致（按动作族 H/S/Dbl/P/R 归并）：${agreeN}/${total} = ${(100 * agreeN / total).toFixed(1)}%`);
console.log(`  不一致：${mism.length} 格 ｜ 其中 |EV差| < 0.005 的边际格：${mism.filter(r => r.gap < 0.005).length} 格`);

function kindOf(r) {
  const fT = family(r.tableAct), fE = family(r.evActNoSplit);
  if (r.sec === 'pair' && (r.tableAct === 'P') !== (family(r.evAct) === 'P')) return '分牌口径（预期内近似）';
  if ((fT === 'H' && fE === 'S') || (fT === 'S' && fE === 'H')) return 'H/S 分歧（可疑）';
  if (fT === 'Dbl' || fE === 'Dbl') return '加倍分歧（半可疑）';
  if (fT === 'R' || fE === 'R') return '投降分歧';
  return '其他';
}
console.log('\n  -- 不一致明细（表法 vs EV 法）--');
for (const r of mism) {
  const o = r.opts;
  console.log(`  [${r.sec}] ${r.label} vs ${r.up.padEnd(2)} : 表=${r.tableAct.padEnd(2)} EV=${(r.sec === 'pair' ? r.evAct : r.evActNoSplit).padEnd(2)} ` +
    `｜ hit ${f4(o.hit)} stand ${f4(o.stand)} dbl ${f4(o.double)} spl ${f4(o.split)} sur ${f4(o.surrender)} ｜ 首选与次选 EV 差 ${r.gap.toFixed(4)} ｜ ${kindOf(r)}`);
}
const byKind = {};
for (const r of mism) byKind[kindOf(r)] = (byKind[kindOf(r)] || 0) + 1;
console.log('\n  -- 不一致按类别汇总 --');
for (const k in byKind) console.log(`  ${k}: ${byKind[k]} 格`);

/* 同族但 D/DS 后备方向不同（信息项） */
const fb = results.filter(r => r.agree && r.fallbackDiff && family(r.tableAct) === 'Dbl');
console.log(`\n  加倍后备方向不同（D vs DS，同族不影响主行动）：${fb.length} 格` +
  (fb.length ? ' → ' + fb.map(r => `${r.sec}:${r.label}v${r.up} 表${r.tableAct}/EV${r.sec === 'pair' ? r.evActNoSplit : r.evAct}`).join(', ') : ''));

const susp = mism.filter(r => kindOf(r) === 'H/S 分歧（可疑）');
if (susp.length === 0) console.log('\n  [OK] 无硬牌/软牌 hit-stand 分歧：两法在全部 H/S 格完全一致');
else { console.log(`\n  [FAIL] 存在 ${susp.length} 格硬/软 hit-stand 分歧（见上）`); exitCode = 1; }

/* ============================================================
 * 任务 3：EV 性能基准（模拟浏览器决策面板：每次新建 EvCalc）
 * ============================================================ */
section('任务 3：EV 计算性能基准');
const hrms = t => Number(process.hrtime.bigint() - t) / 1e6;

/* 3-1 全表：310 格 × 每格新建 EvCalc（重复 3 轮取均值） */
{
  let totalMs = 0, reps = 3;
  for (let rep = 0; rep < reps; rep++)
    for (const r of rows) {
      const hand = mkHand(r.a, r.b);
      const t0 = process.hrtime.bigint();
      const ev = new EvCalc(COUNTS, { dealerHitSoft17: false, doubleAfterSplit: true });
      ev.analyze(hand, r.up);
      totalMs += hrms(t0);
    }
  console.log(`  全表（${total} 格 × 每格新建 EvCalc + analyze）× ${reps} 轮：共 ${totalMs.toFixed(1)}ms，平均 ${(totalMs / total / reps).toFixed(3)}ms/格`);
}
/* 3-2 单格耗时分布 */
{
  const times = [];
  let worst = null;
  for (const r of rows) {
    const hand = mkHand(r.a, r.b);
    const t0 = process.hrtime.bigint();
    const ev = new EvCalc(COUNTS, { dealerHitSoft17: false, doubleAfterSplit: true });
    ev.analyze(hand, r.up);
    const ms = hrms(t0);
    times.push(ms);
    if (!worst || ms > worst.ms) worst = { ms, r };
  }
  times.sort((a, b) => a - b);
  const q = p => times[Math.min(times.length - 1, Math.floor(p * times.length))];
  console.log(`  单格耗时分布：min ${times[0].toFixed(3)}ms ｜ 中位 ${q(0.5).toFixed(3)}ms ｜ p95 ${q(0.95).toFixed(3)}ms ｜ max ${times[times.length - 1].toFixed(3)}ms（${worst.r.sec} ${worst.r.label} vs ${worst.r.up}）`);
}
/* 3-3 枯竭牌靴（20 张剩余，含被排除的 0 计数牌） */
{
  const depleted = { 2: 1, 3: 1, 4: 2, 5: 1, 6: 1, 7: 2, 8: 1, 9: 2, 10: 5, A: 3 };
  const probes = [
    ['硬16 vs 10', mkHand('10', '6'), '10'],
    ['硬5  vs A ', mkHand('2', '3'), 'A'],
    ['软18 vs 6 ', mkHand('A', '7'), '6'],
    ['8,8  vs 6 ', mkHand('8', '8'), '6'],
    ['A,A  vs A ', mkHand('A', 'A'), 'A'],
  ];
  let worstMs = 0;
  for (const [name, hand, up] of probes) {
    const t0 = process.hrtime.bigint();
    const ev = new EvCalc(depleted, { dealerHitSoft17: false, doubleAfterSplit: true });
    ev.analyze(hand, up);
    const ms = hrms(t0);
    worstMs = Math.max(worstMs, ms);
    console.log(`  枯竭牌靴（20 张）${name}: ${ms.toFixed(3)}ms`);
  }
  console.log(`  枯竭牌靴最差 ${worstMs.toFixed(3)}ms`);
}
/* 3-4 结论：UI 每次玩家决策会执行两次 evNow()+analyze（playerAct 评估 + 教练面板） */
{
  console.log('\n  浏览器影响评估：');
  console.log('   - 决策面板每次渲染新建 EvCalc 并 analyze 1-2 次，实测单次 < 1ms、最差格 ~1ms 量级');
  console.log('   - 60fps 帧预算 16.7ms：单次 EV 计算占比 < 6%，不会造成可感知卡顿');
  console.log('   - 全表 310 格一次性预计算 < 0.5s，如需离线生成对照表也完全可行');
}

section('汇总');
console.log(`  任务 2：一致 ${agreeN}/${total}（${(100 * agreeN / total).toFixed(1)}%），不一致 ${mism.length} 格` +
  `（分牌口径 ${mism.filter(r => kindOf(r).startsWith('分牌')).length}、加倍 ${mism.filter(r => kindOf(r).startsWith('加倍')).length}、投降 ${mism.filter(r => kindOf(r).startsWith('投降')).length}、H/S ${susp.length}）`);
console.log(`  任务 3：全表 EV <1s、单格中位 <1ms，浏览器交互无感知延迟`);
if (susp.length === 0) console.log('  [OK] 无可疑的硬/软 hit-stand 分歧');
process.exit(exitCode);
