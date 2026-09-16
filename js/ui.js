/* ============================================================
 * ui.js — 界面与交互：渲染赌桌、双模式流程、教练面板、复盘弹窗
 * 依赖：engine.js / strategy.js / evcalc.js / coach.js / data.js
 * ============================================================ */
'use strict';

/* ---------- 全局状态 ---------- */
const App = {
  game: null,
  rules: { ...DEFAULT_RULES },
  mode: null,                    // 'solo' | 'local'
  players: [],
  coachOn: true,                 // 提示开关
  strictMode: true,              // 决策后立即纠错
  currentReview: null,
  ui: {},                        // DOM 引用
  _seen: {},                     // 各手/庄家已显示的牌数（新牌入场动画用）
  _logSeen: 0,                   // 引擎日志已镜像到牌桌日志的位置
  _dealerRunning: false,         // 庄家分步动画进行中
};

/* ---------- 工具 ---------- */
const $ = id => document.getElementById(id);
const fmt = n => (n >= 0 ? '+' : '') + n.toFixed(1);
const chipFmt = n => '¥' + Math.round(n);

/* 从牌靴剩余牌构建 EvCalc 的 counts。
   注意：庄家暗牌对玩家是未知牌，需加回未知池再计算 */
function evNow() {
  const counts = { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0, A: 0 };
  const add = r => {
    if (r === 'A') counts.A++;
    else if (['10', 'J', 'Q', 'K'].includes(r)) counts[10]++;
    else counts[Number(r)]++;
  };
  for (let i = App.game.shoe.discarded; i < App.game.shoe.cards.length; i++)
    add(App.game.shoe.cards[i].rank);
  if (App.game.dealer.hole) add(App.game.dealer.hole.rank);   // 暗牌未知，加回
  return new EvCalc(counts, App.rules);
}

/* ---------- 卡牌渲染 ---------- */
function cardHTML(card, faceDown = false, isNew = false) {
  const n = isNew ? ' new' : '';
  if (faceDown) return `<div class="card back${n}"><div class="card-inner">?</div></div>`;
  const red = card.suit === '♥' || card.suit === '♦';
  return `<div class="card ${red ? 'red' : ''}${n}"><div class="corner">${card.rank}<br>${card.suit}</div><div class="pip">${card.suit}</div></div>`;
}

/* ---------- 初始化模式 ---------- */
function startMode(mode) {
  App.mode = mode;
  App.players = [];
  if (mode === 'solo') {
    App.players = [new HumanPlayer('你', 1000),
      new NPCPlayer('陈教授', 1000), new NPCPlayer('小美', 1000)];
  } else {
    const n = Math.max(2, Math.min(5, Number($('local-count').value) || 2));
    for (let i = 1; i <= n; i++) App.players.push(new HumanPlayer(`玩家${i}`, 1000));
  }
  App.game = new Game(App.rules);
  App.game.uiStepDealer = true;   // 庄家分步行动（翻暗牌→逐张补牌→结算），Node 自检走同步路径
  for (const p of App.players) App.game.addPlayer(p);
  Coach.reset();
  $('setup-screen').classList.add('hidden');
  $('game-screen').classList.remove('hidden');
  renderAll();
  logMsg(mode === 'solo'
    ? '单人模式：你与两位 NPC 牌友同桌。NPC 按基本策略行动，可观察学习。'
    : '本机多人模式：同一台设备轮流操作各玩家。');
}

function backToSetup() {
  App.game = null; App.mode = null; App.currentReview = null;
  $('game-screen').classList.add('hidden');
  $('setup-screen').classList.remove('hidden');
}

/* ---------- 下注阶段 ---------- */
function renderBetting() {
  const g = App.game;
  $('action-bar').innerHTML = '';
  const seats = g.seats.map((s, i) => seatBetHTML(s, i)).join('');
  $('seats-area').innerHTML = seats;
  $('dealer-area').innerHTML = `<div class="dealer-label">庄家</div><div class="cards"></div>`;
  bindBetControls();
  updateHintPanel();
}

function seatBetHTML(seat, idx) {
  const active = isHumanTurnSeat(seat);
  return `<div class="seat ${active ? 'active' : ''}" id="seat-${idx}">
    <div class="seat-name">${seat.player.name}${seat.player.isNPC ? ' <span class="npc-tag">NPC</span>' : ''}
      <span class="seat-chips">${chipFmt(seat.player.chips)}</span></div>
    <div class="cards"></div>
    <div class="bet-ui">${active ? betControlsHTML(seat, idx) : (seat.pendingBet ? `已下注 ${chipFmt(seat.pendingBet)}` : '等待下注…')}</div>
  </div>`;
}
function betControlsHTML(seat, idx) {
  const amt = Math.min(seat.pendingBet || 25, seat.player.chips);
  const btn = v => `<button data-act="bet-set" data-i="${idx}" data-v="${v}"
    ${seat.player.chips < v ? 'disabled' : ''}>${v}</button>`;
  return `<div class="bet-row">
    ${btn(10)}${btn(25)}${btn(50)}${btn(100)}
    <span class="bet-amt">${chipFmt(amt)}</span>
    <button class="primary" data-act="bet-confirm" data-i="${idx}">确认下注</button>
  </div>`;
}
function isHumanTurnSeat(seat) {
  /* 下注阶段：仅真人座位显示下注控件（NPC 由 checkAllBets 自动下注） */
  if (App.game.phase !== 'betting') return false;
  return !seat.betConfirmed && !seat.player.isNPC;
}

function bindBetControls() {
  $('seats-area').querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      const i = Number(b.dataset.i);
      const seat = App.game.seats[i];
      if (b.dataset.act === 'bet-set') {
        seat.pendingBet = Number(b.dataset.v);
        renderBetting();
      } else if (b.dataset.act === 'bet-confirm') {
        const amt = seat.pendingBet || 25;
        seat.betConfirmed = true;
        seat.pendingBet = amt;
        renderBetting();
        checkAllBets();
      }
    };
  });
}
function checkAllBets() {
  const g = App.game;
  /* NPC 自动下注 */
  for (const s of g.seats) {
    if (s.player.isNPC && !s.betConfirmed) {
      s.pendingBet = 25; s.betConfirmed = true;
    }
  }
  if (g.seats.every(s => s.betConfirmed)) {
    for (const s of g.seats) s.betConfirmed = false;
    g.startRound();
    Coach.resetRound();
    logMsg(`第 ${g.roundNumber} 局开始。庄家明牌：${g.dealerUp.rank}${g.dealerUp.suit}`);
    renderAll();
  }
}

/* ---------- 主渲染 ---------- */
function renderAll() {
  const g = App.game;
  if (!g) return;
  $('round-info').textContent = `第 ${g.roundNumber} 局 · 牌靴剩余 ${g.shoe.remaining} 张（${g.shoe.numDecks} 副）`;
  if (g.phase === 'betting') { renderBetting(); return; }

  /* 庄家（新牌增量播放入场动画：仅比上次渲染多出来的牌加 .new） */
  const showHole = g.phase === 'dealer' || g.phase === 'settle' || g.phase === 'round_over' || !g.dealer.hole;
  const dTotal = g.dealer.cards.length + (g.dealer.hole ? 1 : 0);
  const dSeen = Math.min(App._seen.dealer || 0, dTotal);
  let dh = `<div class="dealer-label">庄家 ${g.dealer.cards.length || (g.dealer.hole ? 1 : 0) ? '' : ''}</div><div class="cards">`;
  dh += cardHTML(g.dealer.cards[0] || { rank: '?', suit: '?' }, false, 0 >= dSeen);
  if (g.dealer.hole && !showHole) dh += cardHTML(null, true, 1 >= dSeen);
  for (let i = 1; i < g.dealer.cards.length; i++) dh += cardHTML(g.dealer.cards[i], false, i >= dSeen);
  dh += `</div>`;
  App._seen.dealer = dTotal;
  if (g.dealer.cards.length >= (g.dealer.hole ? 1 : 2))
    dh += `<div class="total">${g.dealer.hole ? '?' : dealerTotalText()}</div>`;
  $('dealer-area').innerHTML = dh;

  /* 座位 */
  $('seats-area').innerHTML = g.seats.map((s, i) => seatHTML(s, i)).join('');
  /* 座位区无可点按钮（交互全部在行动栏），无需绑定 */
  renderActionBar();
  updateHintPanel();
  flushLog();
  /* 进入庄家阶段：启动分步序列（翻暗牌 → 逐张补牌 → 结算） */
  if (g.phase === 'dealer' && !App._dealerRunning) startDealerSequence();
}
function dealerTotalText() {
  let t = 0, aces = 0;
  for (const c of App.game.dealer.cards) { t += rankValue(c.rank); if (c.rank === 'A') aces++; }
  while (t > 21 && aces > 0) { t -= 10; aces--; }
  return t + (aces > 0 && t + 10 <= 21 ? '（软）' : '') + (t > 21 ? ' 爆' : '');
}

function seatHTML(seat, idx) {
  const isTurn = App.game.currentSeat === seat;
  const hands = seat.hands.map((h, hi) => {
    const key = `s${idx}-h${hi}`;
    const seen = Math.min(App._seen[key] || 0, h.cards.length);   // 牌数减少（分牌）时以当前为准
    const cards = h.cards.map((c, ci) => cardHTML(c, false, ci >= seen)).join('');
    App._seen[key] = h.cards.length;
    const total = h.cards.length ? `<div class="total ${h.isBust ? 'busted' : ''}">${h.total}${h.isSoft ? '软' : ''}${h.isBlackjack ? ' ★BJ' : ''}${h.isBust ? ' 爆牌' : ''}</div>` : '';
    const res = h.result ? `<span class="result-badge ${h.result}">${resultName(h.result)} ${h.payout !== 0 ? fmt(h.payout) : ''}</span>` : '';
    return `<div class="hand ${App.game.currentSeat === seat && App.game.seats.indexOf(seat) === idx && App.game.currentHand === h ? 'playing' : ''}${h.stood ? ' stood' : ''}">
      <div class="cards">${cards}</div>${total}
      <div class="hand-bet">${chipFmt(h.bet)}${h.doubled ? ' ×2' : ''}${h.surrendered ? ' 已投降' : ''} ${res}</div>
    </div>`;
  }).join('');
  return `<div class="seat ${isTurn ? 'active' : ''}" id="seat-${idx}">
    <div class="seat-name">${seat.player.name}${seat.player.isNPC ? ' <span class="npc-tag">NPC</span>' : ''}
      <span class="seat-chips">${chipFmt(seat.player.chips)}</span></div>
    <div class="hands">${hands}</div>
    ${seat.insurance ? `<div class="insurance-note">保险 ${chipFmt(seat.insurance)}</div>` : ''}
  </div>`;
}
function resultName(r) {
  return { win: '赢', lose: '输', push: '平', bj: 'Blackjack!', bust: '爆牌', surrender: '投降' }[r] || r;
}

/* ---------- 行动按钮 ---------- */
function renderActionBar() {
  const g = App.game;
  const bar = $('action-bar');
  if (g.phase === 'player') {
    const seat = g.currentSeat;
    const hand = g.currentHand;
    if (!seat || !hand) { bar.innerHTML = ''; return; }
    if (seat.player.isNPC) {
      bar.innerHTML = `<div class="npc-thinking">${seat.player.name}（NPC）思考中…</div>`;
      setTimeout(() => npcAct(seat), 900);
      return;
    }
    const acts = hand.availableActions;
    const labels = { hit: '要牌 Hit', stand: '停牌 Stand', double: '加倍 Double', split: '分牌 Split', surrender: '投降 Surrender' };
    bar.innerHTML = `<div class="turn-banner">轮到 ${seat.player.name}：${hand.cards.map(c => c.rank + c.suit).join(' ')}（${hand.total}${hand.isSoft ? ' 软' : ''}）</div>
      <div class="btn-row">${acts.map(a => `<button class="act-btn ${a}" data-act="${a}">${labels[a]}</button>`).join('')}</div>`;
    bar.querySelectorAll('button').forEach(b => b.onclick = () => playerAct(b.dataset.act));
  } else if (g.phase === 'insurance') {
    bar.innerHTML = renderInsuranceUI();
    bindInsuranceUI();
  } else if (g.phase === 'round_over') {
    bar.innerHTML = `<button class="primary" data-next>查看复盘</button>
      <button data-next2>直接开下一局</button>`;
    bar.querySelector('[data-next]').onclick = openReview;
    bar.querySelector('[data-next2]').onclick = nextRound;
  } else if (g.phase === 'dealer') {
    bar.innerHTML = `<div class="turn-banner">🎲 庄家行动中…</div>`;
  } else if (g.phase === 'settle') {
    bar.innerHTML = `<div class="turn-banner">结算中…</div>`;
  } else bar.innerHTML = '';
  /* 移动端：实测行动栏高度，供纠错浮层贴靠定位 */
  requestAnimationFrame(() => {
    document.documentElement.style.setProperty('--actionbar-h',
      Math.max(72, bar.offsetHeight) + 'px');
  });
}

/* ---------- 保险 / even money UI ---------- */
function renderInsuranceUI() {
  const g = App.game;
  const humans = g.seats.filter(s => !s.player.isNPC && s.hands[0]?.bet > 0);
  const seat = humans.find(s => !s.insuranceDecided) || humans[0];
  if (!seat) { g.skipInsurance(); renderAll(); return ''; }
  const hasBJ = seat.hands[0].isBlackjack;
  const ev = evNow();
  const ins = ev.insuranceEV();
  const em = hasBJ ? ev.evenMoneyEV() : null;
  return `<div class="turn-banner">保险决定 — ${seat.player.name}${hasBJ ? '（你拿到 Blackjack！）' : ''}</div>
    <div class="btn-row">
      ${hasBJ
        ? `<button class="act-btn double" data-ins="em-take">接受 Even Money（锁定 1:1）</button>
           <button class="act-btn stand" data-ins="em-refuse">拒绝（按 3:2 结算）</button>`
        : `<button class="act-btn double" data-ins="buy">买保险（${chipFmt(seat.hands[0].bet / 2)}）</button>
           <button class="act-btn stand" data-ins="skip">不买保险</button>`}
    </div>
    <div class="ev-mini">庄家明牌 A，暗牌为 10 值牌概率 ${(ins.p10 * 100).toFixed(1)}%（保本线 33.3%）；保险 EV = ${fmt(ins.ev * 100)}%${em ? `；Even Money：接受 ${fmt(em.take * 100)}% vs 拒绝 ${fmt(em.refuse * 100)}%` : ''}</div>`;
}
function bindInsuranceUI() {
  $('action-bar').querySelectorAll('[data-ins]').forEach(b => b.onclick = () => {
    const g = App.game;
    const humans = g.seats.filter(s => !s.player.isNPC && s.hands[0]?.bet > 0);
    const seat = humans.find(s => !s.insuranceDecided);
    if (!seat) return;
    const v = b.dataset.ins;
    let bought = false;
    if (v === 'buy') { g.buyInsurance(seat, seat.hands[0].bet / 2); bought = true; }
    if (v === 'em-take') { g.buyInsurance(seat, seat.hands[0].bet / 2); bought = true; seat.evenMoney = true; }
    /* 教学评估 */
    const rightChoice = !bought;
    if (App.coachOn) {
      const em = seat.hands[0].isBlackjack;
      Coach.roundRecords.push({
        round: g.roundNumber, seat: seat.player.name,
        cardsBefore: seat.hands[0].cards.map(c => c.rank).join(','),
        total: 21, soft: true, up: 'A',
        action: bought ? (em ? 'even money' : 'insurance') : (em ? '拒绝 even money' : '拒绝保险'),
        recAct: 'no', verdict: rightChoice ? 'correct' : 'wrong',
        why: INSURANCE_ADVICE.why,
      });
    }
    seat.insuranceDecided = true;
    /* NPC 决定（永远不买） */
    for (const s of g.seats) if (s.player.isNPC) s.insuranceDecided = true;
    const anyLeft = g.seats.some(s => !s.player.isNPC && s.hands[0]?.bet > 0 && !s.insuranceDecided);
    if (!anyLeft) {
      for (const s of g.seats) s.insuranceDecided = false;
      g.skipInsurance();
      renderAll();
    } else renderAll();
  });
}

/* ---------- 玩家行动 ---------- */
function playerAct(action) {
  const g = App.game;
  const seat = g.currentSeat, hand = g.currentHand;
  const up = g.dealerUp.rank;
  /* 先行动、后记录：避免"动作被引擎拒绝却已写入决策记录"的幽灵条目 */
  const snapshot = {
    cards: hand.cards.map(c => c.rank),
    total: hand.total, soft: hand.isSoft, pair: hand.isPair,
  };
  const r = g.act(action);
  if (!r.ok) { logMsg(r.reason); return; }
  let evalRes = null;
  if (App.coachOn && !seat.player.isNPC) {
    /* 用行动前的手牌快照重建评估上下文（行动已改变手牌） */
    const ghost = {
      cards: snapshot.cards.map(rk => ({ rank: rk })),
      get total() { return snapshot.total; },
      get isSoft() { return snapshot.soft; },
      get isPair() { return snapshot.pair; },
      get isBlackjack() { return false; },
    };
    evalRes = Coach.evaluate(g, ghost, up, action, App.rules);
    evalRes.entry.seat = seat.player.name;
    try { evalRes.entry.ev = evNow().analyze(ghost, up); } catch (e) { /* 静默降级 */ }
  }
  renderAll();
  /* 纠错提示 */
  if (evalRes && evalRes.verdict !== 'correct' && App.strictMode) {
    showVerdict(evalRes, action);
  } else if (evalRes && evalRes.verdict === 'correct' && App.coachOn) {
    toast('✓ 正确：' + ACT_NAMES[evalRes.rec.act]);
  }
  npcFlow();
}

function showVerdict(evalRes, action) {
  const v = evalRes.verdict === 'wrong' ? '✗ 非最优' : '△ 次优';
  const recName = ACT_NAMES[evalRes.rec.act] || evalRes.rec.act;
  const evs = evalRes.entry.ev;
  let evLine = '';
  if (evs) {
    evLine = '📈 各动作长期期望（正 = 长期赚，负 = 长期亏）：' + Object.entries(evs.opts).map(([k, v]) =>
      `${({ hit: '要牌', stand: '停牌', double: '加倍', split: '分牌', surrender: '投降' })[k]} ${fmt(v * 100)}%`).join('　|　');
  }
  $('verdict-box').classList.remove('hidden');
  $('verdict-text').innerHTML = `<b>${v}</b> — 你选了「${ACT_NAMES[evalRes.entry.actionCode] || action}」，最优是「${recName}」。
    ${evLine ? `<div class="ev-compare">${evLine}</div>` : ''}
    <div class="why">${evalRes.entry.why}</div>`;
}

/* ---------- NPC 行动 ---------- */
/* 策略表代码 → 引擎动作名映射（表用 'H/S/D/DS/P/R'，引擎用全名） */
const ACT_MAP = { H: 'hit', S: 'stand', D: 'double', DS: 'double', P: 'split', R: 'surrender' };

function npcAct(seat) {
  const g = App.game;
  if (!g || g.phase !== 'player' || g.currentSeat !== seat) return;
  const hand = g.currentHand;
  const up = g.dealerUp.rank;
  const rec = basicStrategy(hand, up, App.rules);
  const res = g.act(ACT_MAP[rec.act] || rec.act);
  if (!res.ok) {   /* 推荐动作不可执行（如筹码不足加倍）→ 按回退规则降级 */
    const fallback = { D: 'hit', DS: 'stand', R: 'hit' }[rec.act] || 'stand';
    g.act(fallback);
  }
  renderAll();
  npcFlow();
}
function npcFlow() {
  const g = App.game;
  if (g.phase === 'player' && g.currentSeat?.player.isNPC) {
    setTimeout(() => npcAct(g.currentSeat), 700);
  }
}

/* ---------- 庄家分步行动：还原真实桌面节奏 ----------
   引擎在 uiStepDealer 模式下停在 dealer 阶段，由这里用 setTimeout 链驱动：
   翻暗牌 → 每张补牌间隔约 0.75s → 结算。不用 async/await 是为了与
   ui-smoke-test 的同步 timer 桩兼容。 */
function startDealerSequence() {
  const g = App.game;
  if (!g || g.phase !== 'dealer' || App._dealerRunning) return;
  App._dealerRunning = true;
  setTimeout(() => {
    if (App.game !== g) { App._dealerRunning = false; return; }   // 中途退出对局
    g._dealerBegin();
    App._seen.dealer = Math.max(0, (App._seen.dealer || 0) - 1);  // 翻开的暗牌播放入场动画
    renderAll();
    dealerHitLoop(g);
  }, 650);
}
function dealerHitLoop(g) {
  setTimeout(() => {
    if (App.game !== g) { App._dealerRunning = false; return; }
    if (g._dealerNext()) { renderAll(); dealerHitLoop(g); }
    else setTimeout(() => {
      if (App.game !== g) { App._dealerRunning = false; return; }
      g._dealerFinish();
      App._dealerRunning = false;
      renderAll();
    }, 550);
  }, 750);
}

/* ---------- 提示面板（右栏教练） ---------- */
function updateHintPanel() {
  const g = App.game;
  const panel = $('coach-panel');
  if (!App.coachOn) { panel.innerHTML = '<div class="coach-off">教练提示已关闭（设置中开启）</div>'; return; }
  if (!g || g.phase === 'betting') {
    panel.innerHTML = `<h3>📊 下注阶段指导</h3>
      <p>长期平均每下 100 元，会输给庄家约 0.4 元（当前规则）——21 点是庄家略占优的游戏，练的就是把损失压到最小。原则：<b>一手投入不超过总资金的 1%-5%</b>，用小注把每个决策数清楚。</p>
      <p>每一手的输赢和上一手<b>无关</b>：连输 5 手不代表下一手更可能赢，也别加倍追损（越追翻本所需越多，迟早破产）。</p>`;
    return;
  }
  if (g.phase === 'insurance') {
    const ev = evNow();
    const ins = ev.insuranceEV();
    const em = ev.evenMoneyEV();
    panel.innerHTML = `<h3>🛡️ 保险环节</h3>
      <p>庄家明牌 A。暗牌为 10 值牌概率 <b>${(ins.p10 * 100).toFixed(1)}%</b>（当前牌靴），保本线 33.3%。</p>
      <p>买保险 EV = <b>${fmt(ins.ev * 100)}%</b> → 基本策略：<b>不买</b>。</p>
      <p>若你有 Blackjack：拒绝 even money EV ${fmt(em.refuse * 100)}% > 接受 ${fmt(em.take * 100)}%。</p>
      <div class="why">${INSURANCE_ADVICE.why}</div>`;
    return;
  }
  if (g.phase === 'player') {
    const seat = g.currentSeat, hand = g.currentHand;
    if (!seat || !hand) return;
    if (seat.player.isNPC) {
      panel.innerHTML = `<h3>👀 观察学习</h3><p>${seat.player.name}（NPC）按基本策略行动，留意它的选择与右下日志中的解说。</p>`;
      return;
    }
    const up = g.dealerUp.rank;
    const rec = basicStrategy(hand, up, App.rules);
    const why = explainDecision(hand, up, rec);
    /* EV 量化分析 */
    let evBlock = '';
    try {
      const evc = evNow();
      const an = evc.analyze(hand, up);
      const nameMap = { hit: '要牌', stand: '停牌', double: '加倍', split: '分牌', surrender: '投降' };
      const avail = hand.availableActions;   // 只展示可执行动作；推荐不可执行时标注
      const rows = Object.entries(an.opts).filter(([k]) => avail.includes(k)).sort((a, b) => b[1] - a[1]);
      /* 高亮与"最优"文案以策略表为准（与判定口径一致）；动态 EV 首选随牌靴组成波动，
         在边际格（EV 差 <0.5%）可能与策略表不同，属正常现象，注明即可 */
      const recEv = ACT_MAP[rec.act] || rec.act;
      const fallback = { double: 'hit', surrender: 'hit' }[recEv] || 'stand';
      const shown = rows.some(([k]) => k === recEv) ? recEv : (rows.some(([k]) => k === fallback) ? fallback : null);
      const recAvail = avail.includes(recEv);
      const evTop = rows[0] && rows[0][0];
      const diffNote = (evTop && evTop !== shown && Math.abs((an.opts[evTop] || 0) - (an.opts[shown] ?? -1)) < 0.005)
        ? ` 当前牌靴动态 EV 首选「${nameMap[evTop]}」，与策略表差异属边际，教学判定以策略表为准。`
        : '';
      evBlock = `<div class="ev-bars">${rows.map(([k, v]) => `
        <div class="ev-row ${k === shown ? 'best' : ''}">
          <span class="ev-name">${nameMap[k]}</span>
          <div class="ev-track"><div class="ev-fill ${v >= 0 ? 'pos' : 'neg'}" style="width:${Math.min(50, Math.abs(v) * 45)}%"></div></div>
          <span class="ev-val">${fmt(v * 100)}%</span>
        </div>`).join('')}</div>
        <div class="ev-note">EV 是"平均每 1 元注金长期赚/亏多少"（绿条=赚、红条=亏，按牌靴剩余 ${App.game.shoe.remaining} 张动态估算）。策略表最优：<b>${nameMap[shown] || recEv}（${fmt((an.opts[shown] ?? an.bestEV) * 100)}%）</b>${recAvail ? '' : '（当前不可执行，按回退规则处理）'}${diffNote}</div>`;
    } catch (e) { /* EV 计算失败时静默降级 */ }
    panel.innerHTML = `<h3>🎯 当前建议</h3>
      <div class="hint-big">最优动作：<b>${ACT_NAMES[rec.act]}</b></div>
      ${evBlock}
      <div class="why">${why}</div>
      <h3>📖 本环节相关规则</h3>
      <div class="lesson">${Coach.contextLesson(hand, up).replace(/\n/g, '<br>')}</div>`;
    return;
  }
  if (g.phase === 'round_over') {
    panel.innerHTML = `<h3>🏁 本局结束</h3><p>点击"查看复盘"看逐决策分析，或直接开下一局。</p>`;
  }
}

/* ---------- 复盘 ---------- */
function openReview() {
  const g = App.game;
  const rv = Coach.buildRoundReview(g);
  if (!rv) return;
  App.currentReview = rv;
  const decisionRows = rv.decisions.map((d, i) => `
    <tr class="${d.verdict}">
      <td>${i + 1}</td><td>${d.seat || '-'}</td><td>${d.cardsBefore}</td>
      <td>${d.soft ? '软' : '硬'}${d.total}</td><td>庄 ${d.up}</td>
      <td>${ACT_NAMES[d.actionCode] || d.action}</td><td>${ACT_NAMES[d.recAct] || d.recAct}</td>
      <td>${d.verdict === 'correct' ? '✓' : d.verdict === 'minor' ? '△' : '✗'}</td>
    </tr>`).join('');
  const seatSum = rv.seats.map(s => {
    const hands = s.hands.map(h =>
      `${h.cards.join(' ')}（${h.total}${h.soft ? '软' : ''}${h.doubled ? ' 加倍' : ''}${h.surrendered ? ' 投降' : ''}）→ ${resultName(h.result)} ${h.payout !== 0 ? fmt(h.payout) : ''}`).join('<br>');
    return `<div class="rv-seat"><b>${s.name}</b><br>${hands}</div>`;
  }).join('');
  $('review-body').innerHTML = `
    <div class="rv-grid">
      <div><h4>庄家</h4><p>${rv.dealerCards.join(' ')} = ${rv.dealerTotal}${rv.dealerTotal > 21 ? ' 爆牌' : ''}（明牌 ${rv.dealerUp}）</p></div>
      <div class="rv-seats">${seatSum}</div>
    </div>
    <h4>决策复盘（${rv.stats.total ? `正确 ${rv.stats.correct}/${rv.stats.total}（${rv.stats.score} 分）` : '本局无决策点'}）</h4>
    <table class="rv-table"><thead><tr><th>#</th><th>玩家</th><th>手牌</th><th>点数</th><th>庄家</th><th>你的选择</th><th>最优</th><th>判定</th></tr></thead>
    <tbody>${decisionRows || '<tr><td colspan="8">—</td></tr>'}</tbody></table>
    ${rv.decisions.filter(d => d.verdict !== 'correct').map(d => `
      <div class="rv-explain"><b>${d.cardsBefore} vs 庄${d.up}</b>（你 ${ACT_NAMES[d.actionCode] || d.action}，应 ${ACT_NAMES[d.recAct] || d.recAct}）：<br>${d.why}</div>`).join('')}
    <h4>本局时间线</h4>
    <div class="rv-log">${rv.log.map(l => `<div>· ${l.text}</div>`).join('')}</div>`;
  showModal('review-modal');
}

function nextRound() {
  const g = App.game;
  Coach.commitRound(App.players[0].chips, g.roundNumber);
  const willShuffle = g.shoe.needShuffle;   // 先判断再重洗（prepareNextRound 内部重洗后恒 false）
  g.prepareNextRound();
  if (willShuffle) logMsg('到达切牌点，牌靴重新洗切');
  /* 破产检查 */
  for (const s of g.seats) {
    if (s.player.chips < 10) {
      s.player.chips += 500;
      logMsg(`${s.player.name} 资金不足，教学补给 +¥500`);
    }
  }
  $('verdict-box').classList.add('hidden');
  renderAll();
}

/* ---------- 统计 ---------- */
function openStats() {
  const o = Coach.overall();
  const curve = Coach.chipsCurve.map(p => `${p.round}:${p.chips}`).join(' → ');
  const freqRows = Object.entries(o.freq || {}).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([k, n]) => `<tr><td>${k}</td><td>${n} 次</td></tr>`).join('');
  $('stats-body').innerHTML = `
    <div class="st-grid">
      <div class="st-tile"><div class="st-num">${o.total ? o.accuracy : '—'}%</div><div>决策正确率</div></div>
      <div class="st-tile"><div class="st-num">${o.total}</div><div>累计决策数</div></div>
      <div class="st-tile wrong"><div class="st-num">${o.wrongs}</div><div>错误决策</div></div>
      <div class="st-tile minor"><div class="st-num">${o.minors}</div><div>次优决策</div></div>
    </div>
    <h4>按手牌类型</h4>
    <table class="rv-table"><thead><tr><th>类型</th><th>次数</th><th>错误</th></tr></thead><tbody>
      ${Object.entries(o.byType).map(([k, v]) => `<tr><td>${({ hard: '硬牌', soft: '软牌', pair: '对子' })[k]}</td><td>${v.n}</td><td>${v.wrong}</td></tr>`).join('')}
    </tbody></table>
    <h4>高频错误 TOP</h4>
    <table class="rv-table"><tbody>${freqRows || '<tr><td>暂无错误，继续保持！</td></tr>'}</tbody></table>
    <h4>资金轨迹（首位玩家）</h4><p class="curve">${curve || '—'}</p>`;
  showModal('stats-modal');
}

/* ---------- 学习中心 ---------- */
function openLearn() {
  const tabs = [
    ['rules', '规则速览', rulesHTML()], ['chart', '策略表', chartHTML()],
    ['prob', '概率数据', probHTML()], ['mistakes', '常见错误', mistakesHTML()],
    ['gloss', '术语表', glossHTML()], ['etiq', '礼仪与手势', etiqHTML()],
    ['hist', '历史', histHTML()], ['vars', '变体游戏', varsHTML()], ['bet', '下注系统批判', betHTML()],
  ];
  $('learn-tabs').innerHTML = tabs.map(([k, n], i) =>
    `<button class="learn-tab ${i === 0 ? 'on' : ''}" data-t="${k}">${n}</button>`).join('');
  $('learn-body').innerHTML = tabs[0][2];
  $('learn-tabs').querySelectorAll('.learn-tab').forEach(b => b.onclick = () => {
    $('learn-tabs').querySelectorAll('.learn-tab').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    $('learn-body').innerHTML = tabs.find(t => t[0] === b.dataset.t)[2];
  });
  showModal('learn-modal');
}
function tbl(rows, head, label = '数据表') {
  return `<div class="table-scroll" role="region" aria-label="${label}" tabindex="0">
    <table class="rv-table"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function rulesHTML() {
  return `<h4>目标</h4><p>21 点的目标<b>不是"尽量接近 21"</b>，而是<b>赢庄家</b>：一不爆牌（≤21），二要么点数比庄家大，要么等庄家爆牌。</p>
  <h4>牌值</h4><p>2-10 按面值；J/Q/K = 10；A = 1 或 11（自动取对你有利者）。含"可按 11 计的 A"的牌为<b>软牌</b>，反之为<b>硬牌</b>。</p>
  <h4>流程</h4><ol>
  <li><b>下注</b> → 每人两轮明牌，庄家一明一暗（暗牌 hole card）。</li>
  <li><b>查牌（peek）</b>：庄家明牌 A 或 10 时先查暗牌，若为 Blackjack 立即开牌结算（保险先结算）。</li>
  <li><b>玩家行动</b>（从庄家左手起依次）：要牌 / 停牌 / 加倍（本金翻倍只补一张）/ 分牌（对子拆两手）/ 投降（弃牌收回一半）。</li>
  <li><b>庄家行动</b>：翻暗牌，≤16 必须补牌，≥17 停（本局规则 S17：软 17 也停；H17 变体则软 17 继续要）。</li>
  <li><b>结算</b>：普通赢 1:1；Blackjack（首两张 A+10 值）赔 3:2；平局退本。爆牌立即输。</li></ol>
  <h4>分牌细则</h4><ul>
  <li>同点数对子可分（10/J/Q/K 互通）；最多分至 4 手。</li>
  <li><b>分 A 后每手只补一张</b>，不能再要；补到 10 只算 21 点、不算 Blackjack（不赔 3:2）。</li>
  <li>分牌后可加倍（DAS，本局开启）。</li></ul>
  <h4>投降与保险</h4><ul>
  <li>迟投降：庄家确认无 BJ 后，弃牌收回一半本金，仅首两张可用。</li>
  <li>保险：庄家明牌 A 时可押 ≤ 本金一半的侧注，庄 BJ 赔 2:1。EV 为负，基本策略一律不买。</li></ul>
  <h4>牌靴</h4><p>本局 6 副 312 张，用到 75% 切牌重洗（penetration）。实体桌通常 1-8 副，副数越少对玩家越有利（单副 +0.48% vs 8 副）。</p>`;
}
function chartHTML() {
  const t = buildTables(App.rules);
  const mk = (tblData, rowLabel, cols) => tbl(Object.entries(tblData).map(([k, row]) =>
    [`<b>${rowLabel(k)}</b>`, ...row.map(c => `<span class="cell-${c}">${c}</span>`)]),
    ['你的牌 \\ 庄家', ...UP]);
  return `<p>当前规则组合下的完整基本策略（S17/DAS/可投降）。H=要牌 S=停牌 D=加倍(否则H) DS=加倍(否则S) P=分牌 R=投降(否则H)。策略表可把庄家优势压到约 0.4%-0.5%。</p>
  <h4>硬牌</h4>${mk(t.hard, k => k, UP)}
  <h4>软牌</h4>${mk(t.soft, k => 'A,' + k, UP)}
  <h4>对子</h4>${mk(t.pair, k => k === '11' ? 'A,A' : k + ',' + k, UP)}
  <p class="tip">记忆锚点：硬牌 12-16 对 2-6 站、对 7+ 要；11 见 A 外全加倍；A,A 与 8,8 必分；5,5 当 10 打；10,10 绝不分。</p>`;
}
function probHTML() {
  const dRows = Object.entries(DEALER_OUTCOMES_6D_S17).map(([up, arr]) =>
    [`<b>${up === 'A' ? 'A' : up}</b>`, ...arr.slice(0, 6).map(x => x.toFixed(1) + '%'),
     (arr[6] > 0 ? arr[6].toFixed(1) + '%' : '—')]);
  return `<h4>庄家明牌 → 最终结果概率（6 副 S17，已排除 BJ）</h4>
  ${tbl(dRows, ['明牌', '爆牌', '17', '18', '19', '20', '21', 'BJ%'])}
  <p class="tip">明牌 2-6 是"弱牌"（爆率 35%-42%），这就是为什么你对它们敢站 13+；明牌 7-A 是"强牌"。A 明牌爆率仅 16.7%（peek 排除 BJ 后的条件概率；无条件值为 11.5%——两个口径都对）。</p>
  <h4>玩家要牌一张的爆牌概率（硬牌）</h4>
  ${tbl(PLAYER_BUST_TABLE.map(r => [`<b>${r[0]}</b>`, r[1]]), ['当前点数', '爆牌概率'])}
  <h4>Blackjack 与输赢分布</h4>
  <p>拿到天然 BJ 概率：6 副 ≈ 4.75%（约每 21 手一次）。基本策略下每手：赢 ≈ 42.4%、输 ≈ 49.1%、平 ≈ 8.5%。输的次数比赢多，但靠 3:2 赔付与有利时加倍/分牌，总期望损失仅约 0.4%-0.5%。</p>
  <h4>规则变化对期望回报的影响（Wizard of Odds）</h4>
  ${tbl(RULE_VARIATION_TABLE.map(r => [r[0], r[1]]), ['规则', '影响（+利玩家/-利庄家）'])}
  ${tbl(HOUSE_EDGE_TABLE.map(r => [r[0], r[1]]), ['规则组合', '庄家优势'])}`;
}
function mistakesHTML() {
  return `<p>新手高频错误（按损失排序参考）。教练模式会在你犯错时立即指出。</p>` +
    COMMON_MISTAKES.map(m => `<div class="ms-card"><b>${m.t}</b><p>${m.d}</p><span class="ms-loss">典型代价：${m.loss}</span></div>`).join('');
}
function glossHTML() {
  return tbl(GLOSSARY.map(g => [`<b>${g[0]}</b>`, g[1]]), ['术语', '含义']);
}
function etiqHTML() {
  return `<p>实体桌面用手势而非口语（便于监控录像存证）。明牌局（美式）<b>不要用手碰牌</b>。</p>` +
    tbl(ETIQUETTE.map(e => [`<b>${e[0]}</b>`, e[1]]), ['动作', '手势/说明']);
}
function histHTML() {
  return HISTORY.map(h => `<div class="ms-card"><b>${h[0]}</b><p>${h[1]}</p></div>`).join('');
}
function varsHTML() {
  return `<p>遇到变体先看赔付与平局规则再决定是否上桌；边注普遍庄家优势 2%-8%，建议一律回避。</p>` +
    VARIANTS.map(v => `<div class="ms-card"><b>${v[0]}</b><p>${v[1]}</p></div>`).join('');
}
function betHTML() {
  return BETTING_SYSTEMS.map(b => `<div class="ms-card"><b>${b[0]}</b><p>${b[1]}</p></div>`).join('') +
    `<p class="tip">每手输赢相互独立；连输 N 手概率 ≈ 0.52^N（10 连输约 0.14%，每千手必遇）。任何下注序列都无法把负期望变正。</p>`;
}

/* ---------- 规则设置 ---------- */
function openSettings() {
  const r = App.rules;
  $('settings-body').innerHTML = `
    ${settingRow('dealerHitSoft17', '庄家软 17 继续要牌（H17）', r.dealerHitSoft17)}
    ${settingRow('doubleAfterSplit', '分牌后可加倍（DAS）', r.doubleAfterSplit)}
    ${settingRow('lateSurrender', '允许迟投降', r.lateSurrender)}
    ${settingRow('resplitAces', '可再分 A（RSA）', r.resplitAces)}
    ${settingRow('hitSplitAces', '分 A 后可继续要牌', r.hitSplitAces)}
    <div class="set-row"><label>Blackjack 赔付</label>
      <select id="set-bjpays">
        <option value="1.5" ${r.blackjackPays === 1.5 ? 'selected' : ''}>3:2（标准）</option>
        <option value="1.2" ${r.blackjackPays === 1.2 ? 'selected' : ''}>6:5（避开！）</option>
        <option value="1" ${r.blackjackPays === 1 ? 'selected' : ''}>1:1（视频机）</option>
      </select></div>
    <div class="set-row"><label>牌副数</label>
      <select id="set-decks">
        ${[1, 2, 4, 6, 8].map(n => `<option value="${n}" ${r.numDecks === n ? 'selected' : ''}>${n} 副</option>`).join('')}
      </select></div>
    <p class="tip">改动会体现在策略表、提示与教学中（如 H17 会改变 6 个决策格）。庄家优势提示：6:5 赔付会恶化 +1.39%。</p>`;
  $('settings-body').querySelectorAll('[data-rule]').forEach(cb => {
    cb.onchange = () => {
      App.rules[cb.dataset.rule] = cb.checked;
      /* 同步到进行中的对局：策略表/EV/引擎行为保持一致（庄家行为自下一手起生效） */
      if (App.game) Object.assign(App.game.rules, App.rules);
    };
  });
  $('set-bjpays').onchange = e => {
    App.rules.blackjackPays = Number(e.target.value);
    if (App.game) Object.assign(App.game.rules, App.rules);
  };
  $('set-decks').onchange = e => {
    App.rules.numDecks = Number(e.target.value);
    if (App.game) Object.assign(App.game.rules, App.rules);
    /* 副数变化：换新牌靴（下局起以新副数发牌） */
    if (App.game && App.game.phase === 'betting') App.game.shoe = new Shoe(App.rules.numDecks);
  };
  showModal('settings-modal');
}
function settingRow(key, label, val) {
  return `<div class="set-row"><label>${label}</label>
    <input type="checkbox" data-rule="${key}" ${val ? 'checked' : ''}></div>`;
}

/* ---------- 弹窗焦点管理 ---------- */
function showModal(id) {
  const m = $(id);
  m.classList.remove('hidden');
  m.querySelector('.close')?.focus({ preventScroll: true });
}

/* ---------- 日志与杂项 ---------- */
function logMsg(text) {
  const box = $('log-box');
  box.insertAdjacentHTML('afterbegin', `<div>${text}</div>`);
  while (box.children.length > 60) box.lastChild.remove();
}
/* 引擎每步事件（发牌/要牌/分牌/庄家补牌/爆牌/结算…）实时镜像到牌桌日志 */
function flushLog() {
  const g = App.game;
  if (!g) return;
  if (App._logSeen > g.log.length) App._logSeen = 0;   // 新局日志已清空
  for (; App._logSeen < g.log.length; App._logSeen++) logMsg(g.log[App._logSeen].text);
}
function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

/* ---------- 事件绑定 ---------- */
document.addEventListener('DOMContentLoaded', () => {
  $('btn-solo').onclick = () => startMode('solo');
  $('btn-local').onclick = () => startMode('local');
  $('btn-back').onclick = backToSetup;
  $('btn-settings').onclick = openSettings;
  $('btn-learn').onclick = openLearn;
  $('btn-stats').onclick = openStats;
  $('verdict-close').onclick = () => $('verdict-box').classList.add('hidden');
  $('coach-toggle').onclick = () => {
    App.coachOn = !App.coachOn;
    $('coach-toggle').textContent = App.coachOn ? '教练：开' : '教练：关';
    updateHintPanel();
  };
  $('strict-toggle').onclick = () => {
    App.strictMode = !App.strictMode;
    $('strict-toggle').textContent = App.strictMode ? '纠错：开' : '纠错：关';
  };
  document.querySelectorAll('.modal .close, .modal .btn-close').forEach(b => {
    b.onclick = () => b.closest('.modal').classList.add('hidden');
  });
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); });
  });
  /* 弹窗键盘可达性：ESC 关闭最上层弹窗 */
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const open = [...document.querySelectorAll('.modal:not(.hidden)')].pop();
    if (open) open.classList.add('hidden');
  });
  $('review-next').onclick = () => { $('review-modal').classList.add('hidden'); nextRound(); };
  $('review-close').onclick = () => { $('review-modal').classList.add('hidden'); };
});
