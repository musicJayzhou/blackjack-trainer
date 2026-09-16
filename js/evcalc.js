/* ============================================================
 * evcalc.js — 期望值（EV）计算器：每个决策环节的量化分析
 *
 * 原理：基于牌靴剩余牌构成，递归计算庄家最终点数分布，
 *   再对玩家各可选动作（要牌/停牌/加倍/投降/分牌）计算期望
 *   回报（相对单位本金的净收益率），并给出排序与推荐。
 * - 庄家分布递归含 A 降级与 S17/H17 规则
 * - 玩家 hit 递归含软/硬牌转换与后续最优决策（记忆化）
 * - peek 规则：明牌 A/10 时已排除庄家 BJ（条件分布）
 * 教学定位：展示"为什么这是最优动作"的数据依据。
 * ============================================================ */
'use strict';

/* 牌面点值（与 engine.js 保持一致；各自声明以兼容 Node 模块作用域） */
function rankValue(rank) {
  if (rank === 'A') return 11;
  if (['10', 'J', 'Q', 'K'].includes(rank)) return 10;
  return Number(rank);
}

/* 牌面值集合与剩余牌计数工具 */
const VALUES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];   // 11 代表 A

class EvCalc {
  /* counts: {2..10, A: 张数}；rules 需含 dealerHitSoft17, blackjackPays */
  constructor(counts, rules = {}) {
    this.counts = counts;
    this.rules = { dealerHitSoft17: false, blackjackPays: 1.5, peek: true, ...rules };
    this.total = Object.values(counts).reduce((a, b) => a + b, 0);
    this._dealerCache = {};      // up → {17,18,19,20,21,bust}
    this._hitCache = {};         // "s|h, total" → EV
  }

  p(v) { return (v === 11 ? this.counts.A : this.counts[v]) / this.total; }

  /* ---------- 庄家最终分布（含 hole 排除 BJ） ---------- */
  dealerDist(up) {
    const upKey = up === 'A' ? 'A' : String(up);
    if (this._dealerCache[upKey]) return this._dealerCache[upKey];
    const upVal = upKey === 'A' ? 11 : Number(upKey);
    const memo = {};
    /* state: [total, isSoft] → 分布 {17..21, bust} */
    const walk = (total, soft) => {
      const key = total + (soft ? 's' : 'h');
      if (memo[key]) return memo[key];
      let stop = total >= 17;
      if (stop && total === 17 && soft && this.rules.dealerHitSoft17) stop = false;  // H17
      if (stop) {
        const d = { 17: 0, 18: 0, 19: 0, 20: 0, 21: 0, bust: 0 };
        if (total > 21) d.bust = 1; else d[total] = 1;
        memo[key] = d; return d;
      }
      const acc = { 17: 0, 18: 0, 19: 0, 20: 0, 21: 0, bust: 0 };
      for (const v of VALUES) {
        const pv = this.p(v);
        if (pv === 0) continue;
        let nt = total + v, ns = soft;
        if (v === 11) {
          nt = total + 1;
          if (total + 11 <= 21) { nt = total + 11; ns = true; }
        } else if (nt > 21 && soft) { nt -= 10; ns = false; }  // 软 A 降级
        const sub = walk(nt, ns);
        for (const k in acc) acc[k] += pv * sub[k];
      }
      memo[key] = acc; return acc;
    };
    /* hole 排除：up=A 排除 10 值；up=10 排除 A（peek 已查） */
    const dist = { 17: 0, 18: 0, 19: 0, 20: 0, 21: 0, bust: 0 };
    for (const v of VALUES) {
      const pv = this.p(v);
      if (pv === 0) continue;
      if (upVal === 11 && v === 10) continue;
      if (upVal === 10 && v === 11) continue;
      const condP = pv / (1 - (upVal === 11 ? this.p(10) : upVal === 10 ? this.p(11) : 0));
      let nt = upVal + v, ns = (upVal === 11 || v === 11);
      if (nt > 21) nt -= 10;   // A,A=12 软
      const sub = walk(nt, ns);
      for (const k in dist) dist[k] += condP * sub[k];
    }
    this._dealerCache[upKey] = dist;
    return dist;
  }

  /* ---------- 玩家停牌 EV ---------- */
  standEV(total, up) {
    const d = this.dealerDist(up);
    if (total > 21) return -1;
    let ev = d.bust * 1;
    for (const t of [17, 18, 19, 20, 21]) ev += d[t] * (total > t ? 1 : total < t ? -1 : 0);
    return ev;
  }

  /* ---------- 玩家要牌 EV（递归，含后续最优 hit/stand） ---------- */
  hitEV(total, soft, up) {
    const key = (soft ? 's' : 'h') + total + '|' + up;
    if (this._hitCache[key] !== undefined) return this._hitCache[key];
    let ev = 0;
    for (const v of VALUES) {
      const pv = this.p(v);
      if (pv === 0) continue;
      let nt = total + v, ns = soft;
      if (v === 11) {
        nt = total + 11;
        if (nt > 21) { nt = total + 1; ns = soft; }  // 新 A 按 1 计；原软性保持（原 A 仍可按 11）
        else ns = true;
      } else if (nt > 21 && ns) {
        nt -= 10; ns = false;   // 软牌溢出：A 降为 1，该手转硬
      }
      if (nt > 21) { ev += pv * -1; continue; }
      /* 抽牌后选最优：继续 hit 或 stand（教学近似：递归中不再含 double） */
      const sEV = this.standEV(nt, up);
      const hEV = nt >= 21 ? sEV : this.hitEV(nt, ns, up);
      ev += pv * Math.max(sEV, hEV);
    }
    this._hitCache[key] = ev;
    return ev;
  }

  /* ---------- 玩家加倍 EV（只补一张，金额×2） ---------- */
  doubleEV(total, soft, up) {
    let ev = 0;
    for (const v of VALUES) {
      const pv = this.p(v);
      if (pv === 0) continue;
      let nt = total + v;
      if (v === 11) {
        nt = total + 11;
        if (nt > 21) nt = total + 1;
      } else if (nt > 21 && soft) nt -= 10;
      ev += pv * 2 * (nt > 21 ? -1 : this.standEV(nt, up));
    }
    return ev;
  }

  /* ---------- 分牌近似 EV：两手各以单张 start 起步 ---------- */
  splitEV(cardVal, up, das) {
    /* 起手一张 cardVal（A=11），补第二张后的最优 EV（忽略再分与加倍后的细节误差） */
    const evOne = () => {
      let ev = 0;
      for (const v of VALUES) {
        const pv = this.p(v);
        if (pv === 0) continue;
        let nt = cardVal + v, ns = cardVal === 11 || v === 11;
        if (nt > 21 && ns) nt -= 10;
        /* 分 A 后只能拿一张：EV = standEV；其他可 hit/double */
        let best;
        if (cardVal === 11) best = this.standEV(nt, up);
        else {
          const s = this.standEV(nt, up);
          const h = nt >= 21 ? s : this.hitEV(nt, ns, up);
          const d = das ? this.doubleEV(nt, ns, up) : -Infinity;
          best = Math.max(s, h, d);
        }
        ev += pv * best;
      }
      return ev;
    };
    return 2 * evOne();
  }

  /* ---------- 综合：对一手牌给出全部动作 EV 与推荐 ---------- */
  analyze(hand, up) {
    const upKey = (['10', 'J', 'Q', 'K'].includes(up) ? '10' : up);
    const total = hand.total, soft = hand.isSoft;
    const opts = {
      stand: this.standEV(total, upKey),
      hit: total >= 21 ? this.standEV(total, upKey) : this.hitEV(total, soft, upKey),
    };
    const firstTwo = hand.cards.length === 2;
    if (firstTwo) {
      opts.double = this.doubleEV(total, soft, upKey);
      opts.surrender = -0.5;
      if (hand.isPair) {
        const val = rankValue(hand.cards[0].rank);
        opts.split = this.splitEV(val, upKey, this.rules.doubleAfterSplit !== false);
      }
    }
    /* 排序找最优（把 double 视为整体动作比较） */
    let best = 'stand', bestEV = opts.stand;
    for (const k of ['hit', 'double', 'split', 'surrender']) {
      if (opts[k] !== undefined && opts[k] > bestEV + 1e-9) { best = k; bestEV = opts[k]; }
    }
    return { opts, best, bestEV: opts[best] };
  }

  /* ---------- 保险 EV（明牌 A 时） ---------- */
  insuranceEV() {
    /* 押 1：庄 BJ 概率 p → 赢 2；否则 -1。p = P(hole=10值|明A) */
    const p = this.p(10);
    return { p10: p, ev: p * 2 - (1 - p), breakEven: 1 / 3 };
  }

  /* ---------- Even Money EV（自己 BJ 面对庄 A） ---------- */
  evenMoneyEV() {
    const p = this.p(10);   /* 庄 BJ 概率 */
    return { take: 1.0, refuse: (1 - p) * this.rules.blackjackPays, pBJ: p };
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { EvCalc };
