/* ============================================================
 * engine.js — 21 点游戏规则引擎（纯逻辑，无 UI 依赖）
 * 默认规则：6 副、庄家 S17、BJ 赔 3:2、任意两张可加倍、
 *          DAS（分牌后可加倍）、最多分至 4 手、分 A 后只发一张、
 *          RSA 关闭、迟投降、保险 2:1
 * ============================================================ */
'use strict';

/* ---------- 花色与牌面 ---------- */
const SUITS = ['♠', '♥', '♦', '♣'];           // 黑桃 红心 方块 梅花
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/* 牌面点值：A 记 11，计算时按需降为 1 */
function rankValue(rank) {
  if (rank === 'A') return 11;
  if (['10', 'J', 'Q', 'K'].includes(rank)) return 10;
  return Number(rank);
}

/* ---------- 牌靴（多副洗切） ---------- */
class Shoe {
  constructor(numDecks = 6, penetration = 0.75) {
    this.numDecks = numDecks;
    this.penetration = penetration;            // 抽出比例超过该值即切牌重洗
    this.cards = [];
    this.discarded = 0;                        // 已离开牌靴的牌数
    this.shuffle();
  }
  shuffle() {
    this.cards = [];
    for (let d = 0; d < this.numDecks; d++)
      for (const s of SUITS) for (const r of RANKS)
        this.cards.push({ rank: r, suit: s });
    // Fisher–Yates 洗牌
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
    this.discarded = 0;
  }
  get needShuffle() {
    return this.discarded >= this.cards.length * this.penetration;
  }
  deal() {
    if (this.cards.length - this.discarded === 0) this.shuffle();
    return this.cards[this.discarded++];
  }
  get remaining() { return this.cards.length - this.discarded; }
}

/* ---------- 一手牌 ---------- */
class Hand {
  /* ctx = { seat, rules }：用于 availableActions 感知资金与规则（可选，测试兼容） */
  constructor(bet = 0, fromSplit = false, splitAces = false, ctx = null) {
    this.cards = [];
    this.bet = bet;
    this.fromSplit = fromSplit;    // 是否分牌产生的手（影响是否算 natural BJ）
    this.splitAces = splitAces;    // 是否为分 A 产生的手（分 A 只发一张）
    this.ctx = ctx;
    this.doubled = false;
    this.surrendered = false;
    this.stood = false;
    this.result = null;            // 结算时写入：win/lose/push/bj/bust/surrender
    this.payout = 0;               // 结算后净盈亏（正=赢，负=输，0=平）
  }
  addCard(card) { this.cards.push(card); }

  /* 点数计算：A 尽量按 11 取，超 21 则降 1 */
  get total() {
    let t = 0, aces = 0;
    for (const c of this.cards) {
      t += rankValue(c.rank);
      if (c.rank === 'A') aces++;
    }
    while (t > 21 && aces > 0) { t -= 10; aces--; }
    return t;
  }
  /* 是否软牌：存在一张可按 11 计而不爆的 A。
     算法：最小值计法（A 全按 1）得到 minT，minT+10 ≤ 21 即软 */
  get isSoft() {
    let minT = 0, aces = 0;
    for (const c of this.cards) {
      if (c.rank === 'A') { minT += 1; aces++; }
      else minT += rankValue(c.rank);
    }
    return aces > 0 && minT + 10 <= 21;
  }
  get isBust() { return this.total > 21; }
  /* 天然 blackjack：首两张 21，且不是分牌手 */
  get isBlackjack() {
    return this.cards.length === 2 && this.total === 21 && !this.fromSplit;
  }
  /* 首两张为同点数（10/J/Q/K 视为同值可分） */
  get isPair() {
    if (this.cards.length !== 2) return false;
    return rankValue(this.cards[0].rank) === rankValue(this.cards[1].rank);
  }
  /* 当前允许的操作集合（有 ctx 时感知资金与规则，避免"按钮可点但引擎拒绝"） */
  get availableActions() {
    if (this.cards.length === 0 || this.isBust || this.isBlackjack || this.stood ||
        this.doubled || this.surrendered) {
      return [];
    }
    const r = this.ctx ? this.ctx.rules : null;
    const afford = extra => !this.ctx || this.ctx.seat.player.chips >= extra;
    /* 分 A 后是否允许继续要牌 */
    if (this.splitAces && this.cards.length >= 2 && (r ? !r.hitSplitAces : true)) return [];
    const acts = ['hit', 'stand'];
    const firstTwo = this.cards.length === 2;
    if (firstTwo && afford(this.bet)) acts.push('double');
    if (firstTwo && this.isPair && afford(this.bet)) acts.push('split');
    if (firstTwo && !this.fromSplit && (r ? r.lateSurrender !== false : true)) acts.push('surrender');
    return acts;
  }
}

/* ---------- 规则配置 ---------- */
const DEFAULT_RULES = {
  numDecks: 6,
  dealerHitSoft17: false,   // false = S17（庄家软 17 停牌）
  blackjackPays: 1.5,       // 3:2 → 1.5 倍
  doubleAnyTwo: true,       // 任意两张均可加倍
  doubleAfterSplit: true,   // DAS
  resplitLimit: 3,          // 最多分 3 次 → 共 4 手
  resplitAces: false,       // RSA
  hitSplitAces: false,      // 分 A 后只能补一张（false = 不允许继续要牌）
  lateSurrender: true,
  insurance: true,
  peek: true,               // 美式：庄家有 A/10 明牌时查暗牌
};

/* ---------- 一局游戏（一张桌子、多个座位、一个庄家） ---------- */
const PHASE = {
  BETTING: 'betting',         // 下注阶段
  DEALING: 'dealing',         // 发牌动画阶段
  INSURANCE: 'insurance',     // 保险阶段（庄家明牌 A 或 10）
  PLAYER: 'player',           // 玩家依次行动
  DEALER: 'dealer',           // 庄家行动
  SETTLE: 'settle',           // 结算
  ROUND_OVER: 'round_over',   // 本局结束（查看复盘 / 开下一局）
};

class Game {
  constructor(rules = DEFAULT_RULES) {
    this.rules = { ...DEFAULT_RULES, ...rules };
    this.shoe = new Shoe(this.rules.numDecks);
    this.seats = [];          // 座位：[{player, hands, activeHandIdx, done}]
    this.dealer = { cards: [], hole: null };
    this.phase = PHASE.BETTING;
    this.roundNumber = 0;
    this.history = [];        // 每局复盘记录
    this.log = [];            // 本局事件日志（复盘用）
    this.uiStepDealer = false;   // true 时 phase 到 DEALER 即停，由 UI 分步驱动（Node 自检保持同步）
  }

  addPlayer(player) {
    this.seats.push({ player, hands: [], activeHandIdx: 0, done: false, insurance: 0 });
  }

  /* ---------- 开局：所有已下注座位发牌 ---------- */
  startRound() {
    this.roundNumber++;
    this.log = [];
    this.dealer = { cards: [], hole: null };
    for (const s of this.seats) {
      const bet = s.pendingBet || 0;
      s.hands = [new Hand(bet, false, false, { seat: s, rules: this.rules })];
      if (bet > 0) s.player.chips -= bet;      // 引擎统一管理本金流：开局扣注
      s.pendingBet = 0;
      s.activeHandIdx = 0;
      s.done = false;
      s.insurance = 0;
    }
    // 发牌顺序：玩家第一张 → 庄家明牌 → 玩家第二张 → 庄家暗牌
    const active = this.seats.filter(s => s.hands[0].bet > 0);
    if (active.length === 0) return false;
    for (let i = 0; i < 2; i++) {
      for (const s of active) s.hands[0].addCard(this.shoe.deal());
      if (i === 0) this.dealer.cards.push(this.shoe.deal());
    }
    this.dealer.hole = this.shoe.deal();   // 暗牌暂不加入 cards，翻开时加入
    this.log.push({ type: 'deal', text: `第 ${this.roundNumber} 局开始，发牌完毕` });

    /* 明牌 A → 先进入保险阶段（庄家问完保险才查暗牌）；
       明牌 10 且 peek → 立即查牌；否则直接玩家阶段 */
    const up = this.dealer.cards[0].rank;
    this._peekDone = false;
    if (up === 'A') {
      this.phase = PHASE.INSURANCE;
    } else if (this.rules.peek && rankValue(up) === 10) {
      this._peekAndMaybeSettle();
      if (this.phase === PHASE.ROUND_OVER) return true;
      this.phase = PHASE.PLAYER;
      this._maybeAllBJ();
    } else {
      this.phase = PHASE.PLAYER;
      this._maybeAllBJ();
    }
    return true;
  }

  /* 查庄家 BJ：有则开牌结算本局 */
  _peekAndMaybeSettle() {
    this._peekDone = true;
    if (this._dealerHasBJ()) {
      this._revealHole();
      this.log.push({ type: 'dealer-bj', text: '庄家翻开暗牌——天然 21 点！' });
      this.phase = PHASE.SETTLE;
      this._settle(true);
      this.phase = PHASE.ROUND_OVER;
      return true;
    }
    return false;
  }

  _dealerHasBJ() {
    const hole = this.dealer.hole;
    const t = rankValue(this.dealer.cards[0].rank) + rankValue(hole.rank);
    return t === 21;
  }
  _revealHole() {
    if (this.dealer.hole) {
      this.dealer.cards.push(this.dealer.hole);
      this.dealer.hole = null;
    }
  }
  get dealerUp() { return this.dealer.cards[0]; }
  get dealerTotal() {
    let t = 0, aces = 0;
    for (const c of this.dealer.cards) {
      t += rankValue(c.rank);
      if (c.rank === 'A') aces++;
    }
    while (t > 21 && aces > 0) { t -= 10; aces--; }
    return t;
  }

  /* 当前应该行动的座位与手（自动跳过无可用操作的手：BJ、爆牌、分 A 两张等） */
  get currentSeat() {
    if (this.phase !== PHASE.PLAYER) return null;
    for (const s of this.seats) {
      if (s.done || !s.hands.length || s.hands[0].bet === 0) continue;
      while (s.activeHandIdx < s.hands.length &&
             s.hands[s.activeHandIdx].availableActions.length === 0) {
        s.activeHandIdx++;
      }
      if (s.activeHandIdx < s.hands.length) return s;
      s.done = true;
    }
    return null;
  }
  get currentHand() {
    const s = this.currentSeat;
    return s ? s.hands[s.activeHandIdx] : null;
  }

  /* 保险阶段结束：A 明牌时庄家此时才查暗牌，再进入玩家阶段 */
  skipInsurance() {
    if (this.phase !== PHASE.INSURANCE) return;
    if (this.rules.peek) {
      if (this._peekAndMaybeSettle()) return;   // 庄家 BJ → 已结算
    }
    this.phase = PHASE.PLAYER;
    this._maybeAllBJ();
  }
  buyInsurance(seat, amount) {
    /* 上限：原注一半 且 不超过当前资金（引擎统一扣款） */
    seat.insurance = Math.max(0, Math.min(amount, seat.hands[0].bet / 2, seat.player.chips));
    seat.player.chips -= seat.insurance;
    this.log.push({ type: 'insurance', seat: seat.player.name, amount: seat.insurance,
      text: `${seat.player.name} 购买保险 ¥${seat.insurance}` });
  }

  /* 若所有玩家手均无行动可用（如全是 BJ）→ 直接结算 */
  _maybeAllBJ() {
    if (this.phase !== PHASE.PLAYER) return;
    const pending = this.seats.filter(s => !s.done && s.hands[0].bet > 0 &&
      s.activeHandIdx < s.hands.length);
    const needAct = pending.some(s => {
      const h = s.hands[s.activeHandIdx];
      return h.availableActions.length > 0 && !h.isBlackjack;
    });
    if (!needAct) {
      for (const s of pending) s.done = true;
      this.phase = PHASE.DEALER;
      if (this.uiStepDealer) return;   // UI 分步驱动庄家节奏
      this._dealerPlay();
    }
  }

  /* ---------- 玩家操作 ---------- */
  act(action, opt = {}) {
    if (this.phase !== PHASE.PLAYER) return { ok: false, reason: '当前不在玩家行动阶段' };
    const seat = opt.seat || this.currentSeat;
    const hand = opt.hand || seat.hands[seat.activeHandIdx];
    if (!hand.availableActions.includes(action)) return { ok: false, reason: '该操作当前不可用' };

    switch (action) {
      case 'hit': {
        const c = this.shoe.deal();
        hand.addCard(c);
        this.log.push({ type: 'hit', seat: seat.player.name, card: c,
          text: `${seat.player.name} 要牌 ${c.rank}${c.suit}（${hand.total}${hand.isSoft ? ' 软' : ''}）` });
        if (hand.isBust) {
          this.log.push({ type: 'bust', seat: seat.player.name, text: `爆牌！${hand.total} 点` });
          this._advanceHand(seat);
        } else if (hand.total === 21) {
          this._advanceHand(seat);   // 21 点自动停
        }
        break;
      }
      case 'stand': {
        hand.stood = true;
        this.log.push({ type: 'stand', seat: seat.player.name,
          text: `${seat.player.name} 停牌（${hand.total}${hand.isSoft ? ' 软' : ''}）` });
        this._advanceHand(seat);
        break;
      }
      case 'double': {
        const ok = this._canDouble(seat, hand);
        if (!ok) return { ok: false, reason: '当前规则不允许加倍' };
        seat.player.chips -= hand.bet;      // 追加等额本金
        hand.bet *= 2;
        hand.doubled = true;
        const c = this.shoe.deal();
        hand.addCard(c);
        this.log.push({ type: 'double', seat: seat.player.name, card: c,
          text: `${seat.player.name} 加倍至 ¥${hand.bet}，只补一张 ${c.rank}${c.suit}（${hand.total} 点）` });
        if (hand.isBust) this.log.push({ type: 'bust', seat: seat.player.name, text: `爆牌！${hand.total} 点` });
        this._advanceHand(seat);
        break;
      }
      case 'split': {
        const ok = this._canSplit(seat, hand);
        if (!ok) return { ok: false, reason: '当前规则不允许分牌' };
        seat.player.chips -= hand.bet;      // 新一手等额本金
        const isAces = hand.cards[0].rank === 'A';
        const newHand = new Hand(hand.bet, true, isAces, { seat, rules: this.rules });
        newHand.addCard(hand.cards.pop());
        hand.fromSplit = true;
        if (isAces) hand.splitAces = true;
        seat.hands.splice(seat.activeHandIdx + 1, 0, newHand);
        // 各补一张
        hand.addCard(this.shoe.deal());
        newHand.addCard(this.shoe.deal());
        this.log.push({ type: 'split', seat: seat.player.name,
          text: `${seat.player.name} 分牌，现在有 ${seat.hands.length} 手` });
        // 分 A 且规则禁止继续要牌 → 该手两张即视为打完
        if (hand.splitAces && !this.rules.hitSplitAces && hand.cards.length >= 2) {
          hand.stood = true;
          this._advanceHand(seat);
        }
        break;
      }
      case 'surrender': {
        hand.surrendered = true;
        this.log.push({ type: 'surrender', seat: seat.player.name,
          text: `${seat.player.name} 投降，收回一半赌注` });
        this._advanceHand(seat);
        break;
      }
    }
    this._afterAct();
    return { ok: true };
  }

  _canDouble(seat, hand) {
    if (hand.cards.length !== 2 || hand.doubled) return false;
    if (hand.fromSplit && !this.rules.doubleAfterSplit) return false;
    if (!this.rules.doubleAnyTwo) {
      const t = hand.total;
      if (![9, 10, 11].includes(t)) return false;
    }
    if (seat.player.chips < hand.bet) return false;
    return true;
  }
  _canSplit(seat, hand) {
    if (!hand.isPair || hand.cards.length !== 2) return false;
    const splitCount = seat.hands.length - 1;
    if (splitCount >= this.rules.resplitLimit) return false;
    if (hand.splitAces && !this.rules.resplitAces) return false;
    if (seat.player.chips < hand.bet) return false;
    return true;
  }

  _advanceHand(seat) {
    // 分 A 只发一张：两张即视为打完
    seat.activeHandIdx++;
    if (seat.activeHandIdx >= seat.hands.length) seat.done = true;
  }

  _afterAct() {
    if (this.phase !== PHASE.PLAYER) return;
    if (!this.currentSeat) {
      this.phase = PHASE.DEALER;
      if (this.uiStepDealer) return;   // UI 分步驱动庄家节奏
      this._dealerPlay();
    }
  }

  /* ---------- 庄家行动 ----------
     同步路径：_dealerPlay 一次打完（Node 自检/测试）；
     UI 分步：uiStepDealer 模式下由界面依次调用 _dealerBegin →
     _dealerNext（每补一张）→ _dealerFinish，还原真实桌面的节奏 */
  _dealerPlay() {
    this._dealerBegin();
    while (this._dealerNext()) {}
    this._dealerFinish();
  }
  _dealerBegin() {           // 翻暗牌
    this._revealHole();
    this.log.push({ type: 'reveal', text: `庄家翻开暗牌，共 ${this.dealerTotal} 点` });
  }
  _dealerNext() {            // 补一张牌；返回 false 表示庄家行动结束
    // 是否还有玩家手存活（未爆未投降）
    const alive = this.seats.some(s => s.hands.some(h =>
      h.bet > 0 && !h.isBust && !h.surrendered));
    if (!alive || !this._dealerMustHit()) return false;
    const c = this.shoe.deal();
    this.dealer.cards.push(c);
    this.log.push({ type: 'dealer-hit', card: c,
      text: `庄家补牌 ${c.rank}${c.suit}（${this.dealerTotal} 点）` });
    if (this.dealerTotal > 21) {
      this.log.push({ type: 'dealer-bust', text: `庄家爆牌！${this.dealerTotal} 点` });
    }
    return true;
  }
  _dealerFinish() {          // 结算并收尾
    this.phase = PHASE.SETTLE;
    this._settle(false);
    this.phase = PHASE.ROUND_OVER;
  }

  _dealerMustHit() {
    const t = this.dealerTotal;
    if (t < 17) return true;
    if (t === 17 && this.rules.dealerHitSoft17) {
      // H17：软 17 也要补（此处简化：只要 17 且规则要求即补，软硬由 A 降点决定）
      // 更精确：检查是否软 17
      return this._dealerIsSoft();
    }
    return false;
  }
  _dealerIsSoft() {
    /* 与 Hand.isSoft 相同的最小值计法：存在 A 可按 11 计（minT+10 ≤ 21）即为软
       （原实现 t+10≤21 在 t 为 A=11 原始和时恒假，导致 H17 设置完全无效） */
    let minT = 0, aces = 0;
    for (const c of this.dealer.cards) {
      if (c.rank === 'A') { minT += 1; aces++; }
      else minT += rankValue(c.rank);
    }
    return aces > 0 && minT + 10 <= 21;
  }

  /* ---------- 结算 ---------- */
  _settle(dealerBJPeek) {
    const dBJ = dealerBJPeek || this.dealer.cards.length === 2 && this.dealerTotal === 21;
    const dTot = this.dealerTotal;
    const dBJfinal = dBJ; // 庄家两张 21 即天然 BJ
    const summary = [];
    for (const s of this.seats) {
      for (const h of s.hands) {
        if (h.bet === 0) continue;
        let res, payout;
        if (h.surrendered) {
          res = 'surrender'; payout = -h.bet / 2;
        } else if (h.isBlackjack) {
          if (dBJfinal) { res = 'push'; payout = 0; }
          else { res = 'bj'; payout = h.bet * this.rules.blackjackPays; }
        } else if (h.isBust) {
          res = 'bust'; payout = -h.bet;
        } else if (dBJfinal) {
          res = 'lose'; payout = -h.bet;
        } else if (dTot > 21) {
          res = 'win'; payout = h.bet;
        } else if (h.total > dTot) {
          res = 'win'; payout = h.bet;
        } else if (h.total < dTot) {
          res = 'lose'; payout = -h.bet;
        } else {
          res = 'push'; payout = 0;
        }
        h.result = res;
        h.payout = payout;
        /* 返还制：输/爆两手不返还；其余返还本金 + 净盈亏
           （下注/加倍/分牌的扣款均由引擎完成，这里一次性结清） */
        const back = (res === 'lose' || res === 'bust') ? 0 : h.bet + payout;
        s.player.chips += back;
        summary.push({ seat: s.player.name, total: h.total, res, payout, bet: h.bet });
      }
      // 保险结算：庄家 BJ → 2:1 赔付（返还 3×保费 = 本金 + 2 倍赔付）；否则没收
      if (s.insurance > 0) {
        if (dBJfinal) {
          s.player.chips += s.insurance * 3;
          this.log.push({ type: 'insurance-win', seat: s.player.name,
            text: `${s.player.name} 保险命中，获赔 ¥${s.insurance * 2}` });
        } else {
          this.log.push({ type: 'insurance-lose', seat: s.player.name,
            text: `${s.player.name} 保险未中，损失 ¥${s.insurance}` });
        }
      }
    }
    this.log.push({ type: 'settle', summary,
      text: `本局结算完毕：${summary.map(x => `${x.seat} ${x.res}`).join('，')}` });
    // 记入历史（复盘）
    this.history.push({
      round: this.roundNumber,
      dealerUp: this.dealer.cards[0] ? this.dealer.cards[0].rank : null,
      dealerCards: this.dealer.cards.map(c => c.rank + c.suit),
      dealerTotal: dTot,
      seats: this.seats.map(s => ({
        name: s.player.name,
        insurance: s.insurance,
        hands: s.hands.filter(h => h.bet > 0).map(h => ({
          cards: h.cards.map(c => c.rank + c.suit),
          total: h.total, soft: h.isSoft, bet: h.bet,
          doubled: h.doubled, surrendered: h.surrendered,
          result: h.result, payout: h.payout,
        })),
      })),
      log: [...this.log],
      shoeLeft: this.shoe.remaining,
    });
  }

  /* 开下一局前：牌靴不足则重洗 */
  prepareNextRound() {
    if (this.shoe.needShuffle) {
      this.shoe.shuffle();
      this.log.push({ type: 'shuffle', text: '切牌点已到，重新洗牌' });
    }
    this.phase = PHASE.BETTING;
    for (const s of this.seats) {
      s.hands = []; s.done = false;
      s.insuranceDecided = false; s.evenMoney = false;   // 跨局状态复位
    }
    this.dealer = { cards: [], hole: null };
  }
}

/* ---------- 简单可配置的 NPC（庄家之外的可选对手/牌友） ---------- */
class NPCPlayer {
  constructor(name, chips = 1000, style = 'basic') {
    this.name = name;
    this.chips = chips;
    this.isNPC = true;
    this.style = style;   // basic = 严格基本策略
  }
}
class HumanPlayer {
  constructor(name, chips = 1000) {
    this.name = name;
    this.chips = chips;
    this.isNPC = false;
  }
}

/* 导出（浏览器全局 & Node 自检用） */
if (typeof module !== 'undefined' && module.exports) module.exports = { SUITS, RANKS, rankValue, Shoe, Hand, Game, PHASE, DEFAULT_RULES, NPCPlayer, HumanPlayer };
