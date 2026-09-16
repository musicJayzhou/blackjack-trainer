/* ============================================================
 * coach.js — 教练引擎：实时提示、行动评估、逐局复盘、统计
 * ============================================================ */
'use strict';

/* ---------- 行动记录（复盘的基本单元） ---------- */
/* { round, seat, handIdx, cardsBefore, total, soft, up, action, correct, recAct, why } */

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

  /* ---------- 与当前环节相关的规则小课 ---------- */
  contextLesson(hand, up) {
    const upName = (['10', 'J', 'Q', 'K'].includes(up) ? '10' : up);
    const lessons = [];
    const bust = DEALER_BUST[upName];
    lessons.push(`庄家明牌 ${upName}：爆牌概率 ${bust}，最终成 17-21 的分布见概率表。` +
      (['2','3','4','5','6'].includes(upName) ? '属于"弱牌"——你的停牌阈值可以放宽（12+ 即可站）。'
       : '属于"强牌"——你需要更积极的补牌，16 以下基本都要搏。'));
    if (hand.isSoft) lessons.push('你现在是软牌：A 可以按 1 或 11 计，要牌不会爆，这是软牌的天然保险。');
    else if (hand.total >= 12 && hand.total <= 16) lessons.push(`你现在是僵手（12-16）：要牌爆率 ${PLAYER_BUST[Math.min(hand.total,20)]}，站牌还是搏一把取决于庄家明牌强弱。`);
    if (hand.cards.length === 2 && hand.isPair) lessons.push('你拿到了对子：先查对子表（是否分牌），不分则按硬牌处理。');
    return lessons.join('\n');
  },

  /* ---------- 行动评估（打完一手立即反馈） ---------- */
  evaluate(game, hand, up, action, rules) {
    const rec = basicStrategy(hand, up, rules);
    let verdict;
    /* 与策略回退口径一致的宽容分级：
       D→H / DS→S：放弃加倍的利润（少赚），记 minor；
       R→H / R→S：放弃投降的止损（期望损失略增），记 minor；
       其余偏离记 wrong */
    if (action === rec.act) verdict = 'correct';
    else if (rec.act === 'DS' && action === 'S') verdict = 'minor';
    else if (rec.act === 'D' && action === 'H') verdict = 'minor';
    else if (rec.act === 'R' && (action === 'H' || action === 'S')) verdict = 'minor';
    else verdict = 'wrong';
    const entry = {
      round: game.roundNumber,
      seat: null,   // 由调用方补充
      cardsBefore: hand.cards.map(c => c.rank).join(','),
      total: hand.total, soft: hand.isSoft, up,
      action, recAct: rec.act, verdict,
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
      const label = `${w.cardsBefore} vs 庄${w.up}：你${ACT_NAMES[w.action]?.split(' ')[0] || w.action}，应${ACT_NAMES[w.recAct]?.split(' ')[0] || w.recAct}`;
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

if (typeof module !== 'undefined' && module.exports) module.exports = { Coach };
