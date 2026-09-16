/* ============================================================
 * coach.js — 教练引擎：实时提示、行动评估、逐局复盘、统计
 * ============================================================ */
'use strict';

/* ---------- 行动记录（复盘的基本单元） ---------- */
/* { round, seat, handIdx, cardsBefore, total, soft, up, action, correct, recAct, why } */

/* 引擎动作名 → 策略表动作代码（按钮/引擎用全名，策略表用单字母代码；判定与显示共用） */
const ACT_CODE = { hit: 'H', stand: 'S', double: 'D', split: 'P', surrender: 'R' };

const Coach = {
  records: [],        // 全部决策记录
  roundRecords: [],   // 当前局的决策记录
  chipsCurve: [],     // 每局结束后的资金曲线 [{round, chips}]

  /* ---------- 实时提示：当前局面应该怎么打 ---------- */
  hint(game, rules) {
    const hand = game.currentHand;
    if (!hand) return null;
    const up = game.dealerUp.rank;
    const rec = basicStrategy(hand, up, rules);
    return {
      act: rec.act,
      name: ACT_NAMES[rec.act],
      why: explainDecision(hand, up, rec),
      context: this.contextLesson(hand, up),
    };
  },

  /* ---------- 与当前环节相关的规则小课（新手向：先说结论，再讲为什么） ---------- */
  contextLesson(hand, up) {
    const upName = (['10', 'J', 'Q', 'K'].includes(up) ? '10' : up);
    const lessons = [];
    const bust = DEALER_BUST[upName];
    lessons.push(['2','3','4','5','6'].includes(upName)
      ? `庄家明牌是 ${upName}（小牌）：庄家最后爆掉的概率约 ${bust}，相当高。你不用急着凑大牌——拿够 12 点就可以停牌，等庄家自己爆。`
      : `庄家明牌是 ${upName}（大牌）：庄家大概率能凑到 17 点以上（爆掉的概率只有 ${bust}）。干等没用，你 16 点以下基本都得继续要牌搏一把。`);
    if (hand.isSoft) lessons.push('你这手是"软牌"（带一张算 11 的 A）：A 既能按 11 也能按 1 算，所以再要一张牌也不会爆——这是软牌自带的保险，放心要。');
    else if (hand.total >= 12 && hand.total <= 16) lessons.push(`你这手 ${hand.total} 点落在"最难受的区间"（12-16）：再要一张牌，爆掉的概率约 ${PLAYER_BUST[Math.min(hand.total,20)]}。要不要搏，就看庄家明牌是小牌还是大牌——参考上面第一条。`);
    if (hand.cards.length === 2 && hand.isPair) lessons.push('你拿到了对子：先决定"要不要拆成两手打"（参考下方推荐动作），不拆就当普通硬牌处理。');
    return lessons.join('\n');
  },

  /* ---------- 行动评估（打完一手立即反馈） ---------- */
  evaluate(game, hand, up, action, rules) {
    const rec = basicStrategy(hand, up, rules);
    /* 引擎/按钮传全名（'hit' 等），策略表返回代码（'H' 等）：先归一化再比较 */
    const a = ACT_CODE[action] || action;
    let verdict;
    /* 与策略回退口径一致的宽容分级：
       D→H / DS→S：放弃加倍的利润（少赚），记 minor；
       R→H / R→S：放弃投降的止损（期望损失略增），记 minor；
       DS 格选择加倍（主行动同族）记 correct；
       其余偏离记 wrong */
    if (a === rec.act || (rec.act === 'DS' && a === 'D')) verdict = 'correct';
    else if (rec.act === 'DS' && a === 'S') verdict = 'minor';
    else if (rec.act === 'D' && a === 'H') verdict = 'minor';
    else if (rec.act === 'R' && (a === 'H' || a === 'S')) verdict = 'minor';
    else verdict = 'wrong';
    const entry = {
      round: game.roundNumber,
      seat: null,   // 由调用方补充
      cardsBefore: hand.cards.map(c => c.rank).join(','),
      total: hand.total, soft: hand.isSoft, up,
      action, actionCode: a, recAct: rec.act, verdict,
      why: explainDecision(hand, up, rec),
    };
    this.roundRecords.push(entry);
    return { verdict, rec, entry };
  },

  /* ---------- 保险评估 ---------- */
  evaluateInsurance(bought) {
    const right = !bought;   // 基本策略：不买
    return {
      verdict: right ? 'correct' : 'wrong',
      why: INSURANCE_ADVICE.why,
    };
  },

  /* ---------- 本局复盘 ---------- */
  buildRoundReview(game) {
    const h = game.history[game.history.length - 1];
    if (!h) return null;
    const wrongs = this.roundRecords.filter(r => r.verdict === 'wrong');
    const minors = this.roundRecords.filter(r => r.verdict === 'minor');
    const total = this.roundRecords.length;
    const correct = total - wrongs.length - minors.length;
    return {
      round: h.round,
      dealerUp: h.dealerUp, dealerCards: h.dealerCards, dealerTotal: h.dealerTotal,
      seats: h.seats, log: h.log,
      decisions: [...this.roundRecords],
      stats: { total, correct, minors: minors.length, wrongs: wrongs.length,
        score: total ? Math.round(correct / total * 100) : 100 },
    };
  },

  /* 累积统计 */
  overall() {
    const total = this.records.length;
    const wrongs = this.records.filter(r => r.verdict === 'wrong').length;
    const minors = this.records.filter(r => r.verdict === 'minor').length;
    const rv10 = rk => (rk === 'A' ? 11 : ['10', 'J', 'Q', 'K'].includes(rk) ? 10 : Number(rk));
    const byType = {};
    for (const r of this.records) {
      const parts = r.cardsBefore.split(',');
      const isPair = parts.length === 2 && rv10(parts[0]) === rv10(parts[1]);  // 混合十值对子（10,J 等）也算对子
      const key = isPair ? 'pair' : (r.soft ? 'soft' : 'hard');
      byType[key] = byType[key] || { n: 0, wrong: 0 };
      byType[key].n++;
      if (r.verdict === 'wrong') byType[key].wrong++;
    }
    /* 高频错误排行 */
    const wrongList = this.records.filter(r => r.verdict === 'wrong');
    const freq = {};
    for (const w of wrongList) {
      const label = `${w.cardsBefore} vs 庄${w.up}：你${ACT_NAMES[ACT_CODE[w.action] || w.action]?.split(' ')[0] || w.action}，应${ACT_NAMES[w.recAct]?.split(' ')[0] || w.recAct}`;
      freq[label] = (freq[label] || 0) + 1;
    }
    return { total, wrongs, minors, accuracy: total ? Math.round((total - wrongs - minors / 2) / total * 100) : null, byType, freq };
  },

  resetRound() { this.roundRecords = []; },
  commitRound(baselineChips, roundNumber) {
    this.records.push(...this.roundRecords);
    this.roundRecords = [];
    this.chipsCurve.push({ round: roundNumber || this.records[this.records.length - 1]?.round || 0, chips: baselineChips });
  },
  reset() { this.records = []; this.roundRecords = []; this.chipsCurve = []; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = { Coach, ACT_CODE };
