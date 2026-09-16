<!-- Auto-maintained by Claude Code; manual edits welcome -->
# 项目结构：blackjack-trainer

纯前端 21 点训练器（无构建、无依赖），浏览器直接打开 index.html 运行；js/ 各模块同时支持 Node require 以便命令行自检。

## 目录与关键文件

- `index.html` — 单页应用入口，按序加载 js/ 各模块与 css
- `css/`
  - `style.css` — 全部界面样式（赌桌/卡牌/教练面板/弹窗）
    移动端适配：≤760px 底部固定行动栏（safe-area 适配）+ 触控目标 ≥44px + hover 限定 `(hover:hover)` + dvh 弹窗 + `body:has()` 滚动锁 + 横滚表格容器；另有 ≤400px 超窄屏与横屏专项断点
- `js/`
  - `engine.js` — 规则引擎：Shoe（多副牌靴）、Hand（点数/可用操作）、Game（发牌→保险→行动→庄家→结算的完整流程与筹码变动）；导出 DEFAULT_RULES 等，Node 可 require
  - `strategy.js` — 基本策略表（S17 基准 + H17/NDAS/无投降修正）与查询 basicStrategy、教学解说 explainDecision、保险建议
  - `evcalc.js` — 期望值计算器 EvCalc：庄家最终点数分布、hit/stand/double/split/surrender 各动作 EV、保险与 even money EV；UI 每次决策动态新建
  - `coach.js` — 教练模块 Coach：逐决策评估打分、本局复盘、累计统计（导出 Coach）
  - `data.js` — 静态教学数据：庄家概率表、规则变体影响、常见错误、术语、礼仪、变体游戏、下注系统批判
  - `ui.js` — DOM 渲染与交互：单人/本机多人双模式、下注/行动/保险(even money)流程、教练面板、复盘与统计弹窗、规则设置
- `scripts/`
  - `selftest.js` — 原有逻辑自检（点数/策略抽查/EV 对权威数据/整局模拟）
  - `stress-test.js` — 压力回归：128 规则组合 × 300 局守恒校验、极端场景（even money/5 座位/资金不足/牌靴耗尽）、万局性能基准（固定种子可复现）
  - `consistency-check.js` — 策略表 vs EvCalc 全表（310 格）一致性校验 + EV 计算性能基准
  - `ui-smoke-test.js` — UI 流程冒烟：无头 DOM 桩加载全部 js 模块，驱动 下注→发牌→行动→结算→下一局 全流程 + 账目核对，捕捉渲染路径 ReferenceError（bindSeatButtons 卡死回归由此发现）
- `docs/`
  - `21点规则调研笔记.md` — 规则与策略数据来源调研笔记
- `backup/` — 修改 js/css/html 前的成体系备份（`原名-YYYYMMDD-HHmm.bak`）

## 快速命令

```
node scripts/selftest.js            # 逻辑自检
node scripts/stress-test.js         # 压力/守恒/极端场景回归
node scripts/consistency-check.js   # 策略表与 EV 引擎一致性 + 性能
node scripts/ui-smoke-test.js       # UI 全流程冒烟（无头 DOM 桩）
```
