/* ============================================================
 * ui-smoke-test.js — UI 流程冒烟测试（无头 DOM 桩）
 * 目的：在 Node 中加载全部 js 模块 + 极简 DOM 桩，驱动
 * "下注 → 发牌 → 行动 → 结算 → 下一局" 完整流程，
 * 捕捉 renderAll 等渲染路径上的 ReferenceError/TypeError。
 * 用法：node scripts/ui-smoke-test.js
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ---------- 极简 DOM 桩（Proxy 万能元素） ---------- */
function makeEl(id) {
  const el = {
    _id: id,
    innerHTML: '',
    textContent: '',
    value: '2',
    dataset: {},
    style: { setProperty() {} },
    classList: {
      _set: new Set(id && id.includes('modal') ? ['modal', 'hidden'] : []),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    children: [],
    get lastChild() { return el.children[el.children.length - 1]; },
    offsetHeight: 80,
    /* 按 innerHTML 内容近似匹配：选择器属性/标签出现在 HTML 里就返回对应数量的桩元素 */
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const html = el.innerHTML || '';
      if (!html) return [];
      let count = 0;
      if (sel === 'button') count = (html.match(/<button/g) || []).length;
      else {
        const attr = sel.replace(/[\[\].]/g, '');
        count = attr && html.includes(attr) ? html.split(attr).length - 1 : 0;
      }
      return Array.from({ length: count }, () => makeEl(null));
    },
    insertAdjacentHTML(pos, html) {
      const c = { html, remove() { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); } };
      if (pos === 'afterbegin') el.children.unshift(c); else el.children.push(c);
    },
    appendChild() {},
    remove() {},
    focus() {},
    addEventListener() {},
    closest() { return el; },
    set onclick(fn) { el._onclick = fn; },
    get onclick() { return el._onclick; },
  };
  return el;
}
const els = {};
const documentStub = {
  getElementById(id) { return els[id] || (els[id] = makeEl(id)); },
  createElement() { return makeEl(null); },
  querySelectorAll() { return []; },
  addEventListener() {},
  body: makeEl('body'),
  documentElement: makeEl('html'),
};

/* ---------- 加载全部模块到同一作用域（模拟浏览器多 script 标签） ---------- */
const files = ['engine.js', 'strategy.js', 'evcalc.js', 'coach.js', 'data.js', 'ui.js'];
let src = '';
for (const f of files) {
  src += `\n/* ---- ${f} ---- */\n` +
    fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8')
      .replace(/^'use strict';/m, '');          // 避免重复声明指令干扰
}
const sandbox = {
  document: documentStub,
  window: {},
  requestAnimationFrame: fn => fn(),
  setTimeout: (fn) => { pendingTimers.push(fn); return pendingTimers.length; },
  clearTimeout() {},
  console,
  module: undefined,
};
const pendingTimers = [];
function flushTimers(maxRounds = 50) {
  /* NPC 行动靠 setTimeout 驱动，逐个取出执行直到清空 */
  let n = 0;
  while (pendingTimers.length && n++ < maxRounds) pendingTimers.shift()();
}
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'bundle.js' });

/* ---------- 断言工具 ---------- */
let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

/* ---------- 场景 1：单人模式完整流程 ---------- */
console.log('场景 1：单人模式 下注→行动→结算→下一局');
try {
  vm.runInContext(`startMode('solo')`, sandbox);
  const g = () => vm.runInContext('App.game', sandbox);

  check('开局为下注阶段', g().phase === 'betting');

  /* 模拟人类确认下注（直接调引擎侧函数，等价于点击"确认下注"） */
  vm.runInContext(`
    App.game.seats[0].pendingBet = 10;
    App.game.seats[0].betConfirmed = true;
    checkAllBets();
  `, sandbox);
  check('全员下注后发牌完成', g().seats.every(s => s.hands.length === 1 && s.hands[0].cards.length === 2));
  check('庄家一明一暗', g().dealer.cards.length === 1 && !!g().dealer.hole);

  /* 关键回归点：renderAll 在非 betting 阶段不得抛错（bindSeatButtons 回归） */
  const phase = g().phase;
  check('进入保险或玩家阶段', ['insurance', 'player', 'round_over'].includes(phase), `实际=${phase}`);
  const barHTML = documentStub.getElementById('action-bar').innerHTML;
  check('行动栏已渲染内容', barHTML.length > 0, '（行动栏为空 = 下注后无法操作）');

  /* 驱动整局：人类无脑按基本策略行动，NPC 由定时器驱动 */
  let steps = 0;
  while (g().phase !== 'round_over' && steps++ < 200) {
    const cur = vm.runInContext(
      `App.game.phase === 'player' && App.game.currentSeat && !App.game.currentSeat.player.isNPC
        ? (() => { const h = App.game.currentHand, up = App.game.dealerUp.rank;
             return basicStrategy(h, up, App.rules).act; })()
        : null`, sandbox);
    if (cur) {
      const actMap = { D: 'double', DS: 'double', P: 'split', R: 'surrender' };
      let a = actMap[cur] || cur;
      /* 引擎拒绝则回退 hit/stand */
      const avail = vm.runInContext(`App.game.currentHand.availableActions`, sandbox);
      if (!avail.includes(a)) a = avail.includes('hit') ? 'hit' : 'stand';
      vm.runInContext(`playerAct('${a}')`, sandbox);
    } else if (g().phase === 'insurance') {
      vm.runInContext(`
        for (const s of App.game.seats) s.insuranceDecided = true;
        App.game.skipInsurance(); renderAll();
      `, sandbox);
    }
    flushTimers();
  }
  check('本局正常打到结算', g().phase === 'round_over', `实际=${g().phase}（${steps} 步）`);
  check('结算写入结果', g().seats.every(s => s.hands.every(h => h.result)), '');

  /* 账目核对：总筹码 = 初始 3000 + 各手净盈亏 + 保险净损益（庄家本金不入账） */
  const acct = vm.runInContext(`(() => {
    let expected = 3000;
    for (const r of App.game.history) {
      const dBJ = r.dealerCards.length === 2 && r.dealerTotal === 21;
      for (const s of r.seats) {
        for (const h of s.hands) expected += h.payout;
        if (s.insurance > 0) expected += dBJ ? 2 * s.insurance : -s.insurance;
      }
    }
    return { expected, actual: App.players.reduce((t, p) => t + p.chips, 0) };
  })()`, sandbox);
  check('账目一致（初始3000+净盈亏=当前总筹码）',
    Math.abs(acct.expected - acct.actual) < 1e-9,
    `期望=${acct.expected} 实际=${acct.actual}`);

  vm.runInContext(`nextRound()`, sandbox);
  check('可进入下一局下注', g().phase === 'betting');

  /* ---------- 场景 2：连续多局回归（含保险路径） ---------- */
  console.log('场景 2：连续 30 局混合流程（含明牌 A 保险路径）');
  let insuranceSeen = 0, replenishTotal = 0;
  for (let round = 0; round < 30; round++) {
    vm.runInContext(`
      App.game.seats[0].pendingBet = 25;
      App.game.seats[0].betConfirmed = true;
      checkAllBets();
    `, sandbox);
    let guard = 0;
    while (g().phase !== 'round_over' && guard++ < 200) {
      if (g().phase === 'insurance') {
        insuranceSeen++;
        vm.runInContext(`
          for (const s of App.game.seats) s.insuranceDecided = true;
          App.game.skipInsurance(); renderAll();
        `, sandbox);
        continue;
      }
      const cur = vm.runInContext(
        `App.game.phase === 'player' && App.game.currentSeat && !App.game.currentSeat.player.isNPC
          ? basicStrategy(App.game.currentHand, App.game.dealerUp.rank, App.rules).act : null`, sandbox);
      if (cur) {
        const actMap = { D: 'double', DS: 'double', P: 'split', R: 'surrender' };
        let a = actMap[cur] || cur;
        const avail = vm.runInContext(`App.game.currentHand.availableActions`, sandbox);
        if (!avail.includes(a)) a = avail.includes('hit') ? 'hit' : 'stand';
        vm.runInContext(`playerAct('${a}')`, sandbox);
      }
      flushTimers();
    }
    if (g().phase !== 'round_over') { failures++; console.error(`  ✗ 第 ${round + 1} 局卡在 ${g().phase}`); break; }
    const chipsBefore = vm.runInContext(`App.players.reduce((t, p) => t + p.chips, 0)`, sandbox);
    vm.runInContext(`nextRound()`, sandbox);
    const chipsAfter = vm.runInContext(`App.players.reduce((t, p) => t + p.chips, 0)`, sandbox);
    replenishTotal += chipsAfter - chipsBefore;   // nextRound 内唯一的资金变动是破产补给
  }
  check('30 局全部完整打完', g().phase === 'betting');
  console.log(`  （其中触发保险 ${insuranceSeen} 次，破产补给 +${replenishTotal}）`);
  const acct2 = vm.runInContext(`(() => {
    let expected = 3000;
    for (const r of App.game.history) {
      const dBJ = r.dealerCards.length === 2 && r.dealerTotal === 21;
      for (const s of r.seats) {
        for (const h of s.hands) expected += h.payout;
        if (s.insurance > 0) expected += dBJ ? 2 * s.insurance : -s.insurance;
      }
    }
    return { expected, actual: App.players.reduce((t, p) => t + p.chips, 0) };
  })()`, sandbox);
  check('30 局累计账目一致（含补给）',
    Math.abs(acct2.expected + replenishTotal - acct2.actual) < 1e-9,
    `期望=${acct2.expected}+${replenishTotal} 实际=${acct2.actual}`);
  check('多局后无人筹码为负', vm.runInContext(`App.players.every(p => p.chips >= 0)`, sandbox));
} catch (e) {
  failures++;
  console.error(`\n✗ 流程抛出异常：${e.message}`);
  console.error(e.stack.split('\n').slice(0, 6).join('\n'));
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
