import { icon } from './icons';
import { rulePickerHtml, scenePickerHtml } from './scenePicker';
import { timePickerHtml } from './timePicker';
import { PHRASES } from '../shop/phrases';

/**
 * 页面骨架。
 *
 * 布局思路：3D 场景铺满整个视口，所有界面元素都是浮在场景之上的「玻璃薄片」，
 * 不再用外层卡片把棋盘框起来——棋盘能占多少屏幕就占多少。
 *
 * 三种信息按重要性分层：
 * - 顶栏（58px）：品牌 / 对局双方 / 连接与账户
 * - 叙事行：当前状态的一句话（禅意文案）+ 回合徽标
 * - 底部：状态数据一行 + 操作坞（居中的胶囊）
 */
export function renderShell(): string {
  return `
    <div class="scene-layer">
      <div id="scene-container"></div>
      <div class="scene-vignette"></div>
    </div>

    <div class="opening-overlay" id="opening-overlay" hidden aria-live="polite">
      <div class="opening-card" id="opening-card">
        <p class="opening-eyebrow" id="opening-eyebrow">开局 · 决定先后手</p>
        <h2 class="opening-title" id="opening-title">你希望谁先手？</h2>
        <p class="opening-sub" id="opening-sub"></p>
        <div class="opening-choices" id="opening-choices">
          <button class="opening-choice" id="opening-self" type="button" data-pref="self">我执先手</button>
          <button class="opening-choice" id="opening-opponent" type="button" data-pref="opponent">对方先手</button>
        </div>
        <div class="opening-status" id="opening-status" hidden></div>
      </div>
      <div class="opening-coin" id="opening-coin" hidden>
        <div class="coin-canvas-wrap" id="coin-canvas-wrap"></div>
        <p class="opening-result" id="opening-result"></p>
      </div>
    </div>

    <header class="hud-top">
      <button class="brand" id="brand-home" aria-label="返回弈境首页">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i></span>
        <span class="brand-text"><strong>弈境</strong><small>YIJING</small></span>
      </button>
      <p class="hud-tagline" id="context-text">一方棋盘，一刻安宁</p>

      <div class="match" aria-label="对局双方">
        <div class="match-player" id="black-player-row">
          <span class="stone-avatar black"></span>
          <span class="match-name" id="black-player-name">黑方</span>
          <span class="you-tag" id="black-you-tag" hidden>你</span>
        </div>
        <span class="match-vs">对 弈</span>
        <div class="match-player" id="white-player-row">
          <span class="stone-avatar white"></span>
          <span class="match-name" id="white-player-name">白方</span>
          <span class="you-tag" id="white-you-tag" hidden>你</span>
        </div>
      </div>

      <div class="hud-actions">
        <span class="connection-status" id="connection-status" hidden><i></i><span>连接中</span></span>
        <button class="icon-button radio-button" id="radio-button" title="网络电台" aria-label="网络电台" aria-expanded="false" hidden>
          <span class="radio-bars" aria-hidden="true"><i></i><i></i><i></i></span>
        </button>
        <button class="icon-button" id="camera-button" title="复位视角" aria-label="复位视角">${icon('camera')}</button>
        <button class="icon-button" id="sound-button" title="静音" aria-label="静音">${icon('sound')}</button>
        <button class="icon-button" id="profile-button" title="个人名片" aria-label="个人名片" aria-haspopup="dialog">${icon('user')}</button>
        <button class="icon-button" id="shop-button" title="商城" aria-label="商城">${icon('shop')}</button>
        <button class="icon-button" id="settings-button" title="设置" aria-label="设置" aria-haspopup="dialog">${icon('gear')}</button>
        <button class="account-button" id="account-button">${icon('user')}<span id="account-name">登录 / 注册</span></button>
      </div>
    </header>

    <div class="radio-card" id="radio-card" hidden>
      <p class="radio-eyebrow">网络电台</p>
      <p class="radio-track" id="radio-track">正在准备…</p>
      <p class="radio-artist" id="radio-artist" hidden></p>
      <div class="radio-row">
        <button class="radio-mute" id="radio-mute" title="静音" aria-label="静音">${icon('sound')}</button>
        <input class="radio-volume" id="radio-volume" type="range" min="0" max="100" step="1" value="60" aria-label="音量">
        <span class="radio-percent" id="radio-percent">60</span>
      </div>
    </div>

    <div class="narration">
      <p class="eyebrow" id="mode-eyebrow">十五路 · 无禁手</p>
      <div class="narration-line">
        <h1 id="stage-title">落子有声，心静无界。</h1>
        <div class="turn-badge" id="turn-badge" hidden><span class="mini-stone black"></span><span id="turn-label">黑方回合</span><span class="turn-clock" id="turn-clock" hidden aria-live="off">00:30</span></div>
      </div>
    </div>

    <div class="presence-alert" id="presence-alert" hidden>
      <span class="presence-alert-dot"></span>
      <span class="presence-alert-text" id="presence-alert-text">对手已断线</span>
      <strong class="presence-alert-timer" id="presence-alert-timer">02:00</strong>
    </div>

    <div class="ai-thinking" id="ai-thinking" hidden><span></span><span></span><span></span>对方正在思考</div>
    <div class="board-tip" id="board-tip">右键拖动旋转 · 滚轮缩放</div>

    <section class="welcome" id="welcome-screen">
      <div class="welcome-copy">
        <p class="eyebrow">A QUIET GAME OF GOMOKU</p>
        <h2>方寸之间，<br><em>自有天地。</em></h2>
        <p class="welcome-description">在木纹与光影间，专注于每一次落子。<br>无需注册，游客也能即刻开始。</p>
        <div class="welcome-note"><span></span> 原创三维棋境 · 15 × 15 · 黑棋先行</div>
      </div>
      <div class="mode-picker">
        <div class="mode-picker-heading"><span>选择一种对弈方式</span><small>BEGIN A GAME</small></div>
        <button class="mode-card" data-mode="local">
          <span class="mode-icon">${icon('local')}</span><span class="mode-card-copy"><strong>本地对弈</strong><small>同屏轮流落子，与身边人过招</small></span>${icon('arrow', 'mode-arrow')}
        </button>
        <button class="mode-card featured" data-mode="ai">
          <span class="popular-tag">静心推荐</span><span class="mode-icon">${icon('cpu')}</span><span class="mode-card-copy"><strong>与 AI 对弈</strong><small>选择执子颜色，随时开始一局</small></span>${icon('arrow', 'mode-arrow')}
        </button>
        <button class="mode-card" data-mode="online">
          <span class="mode-icon">${icon('users')}</span><span class="mode-card-copy"><strong>好友联机</strong><small>创建房间，或输入房间号加入</small></span>${icon('arrow', 'mode-arrow')}
        </button>
        <p class="mode-footnote">连续五子或更多即获胜，本局无禁手</p>
        <!-- 复盘入口刻意做成一条不抢眼的文字链，而不是第四张模式卡：
             它不是「开始一局」，混在模式卡里会让人以为点了就开盘。 -->
        <button class="replay-entry" id="open-replays">
          <span class="replay-entry-icon">${icon('replay')}</span>
          <span>复盘 · 近期对局</span>
        </button>
      </div>
    </section>

    <section class="float-card" id="waiting-card" hidden>
      <span class="waiting-symbol"><i></i><i></i></span><p class="eyebrow">ROOM IS READY</p>
      <h2>静候一位棋友</h2><p class="float-subtitle">分享房间号，与好友在此相逢</p>
      <button class="room-code-large" id="copy-room-code" title="复制房间号"><span id="waiting-room-code">——</span>${icon('copy')}</button>
      <span class="waiting-dots"><i></i><i></i><i></i></span>
      <button class="text-button" id="waiting-leave">取消等待</button>
    </section>

    <section class="float-card" id="challenge-sent" hidden>
      <span class="waiting-symbol"><i></i><i></i></span><p class="eyebrow">CHALLENGE SENT</p>
      <h2 id="challenge-sent-title">等待回应</h2>
      <p class="float-subtitle">已向「<strong id="challenge-sent-name">棋友</strong>」发出约战<br><span id="challenge-sent-timer">30</span> 秒内没有回应会自动撤回</p>
      <button class="text-button" id="challenge-cancel">撤回约战</button>
    </section>

    <section class="float-card" id="result-card" hidden>
      <span class="result-emblem" id="result-emblem">五</span><p class="eyebrow">GAME COMPLETE</p>
      <h2 id="result-title">本局已落幕</h2><p class="float-subtitle" id="result-description">谢谢你的专注与投入</p>
      <div class="result-stats"><span>总手数<strong id="result-moves">0</strong></span><i></i><span>获胜方式<strong id="result-reason">五子连珠</strong></span></div>
      <button class="primary-button full-width" id="result-restart">再来一局 ${icon('restart')}</button>
      <button class="secondary-button full-width" id="result-replay" hidden>复盘本局 ${icon('replay')}</button>
      <button class="text-button" id="result-home">返回模式选择</button>
    </section>

    <footer class="hud-bottom">
      <div class="status-row">
        <span class="status-dot"></span>
        <span id="stage-status">请选择对弈方式</span>
        <i class="status-divider"></i>
        <span class="status-metric">已落子 <strong id="move-count">0 <small>手</small></strong></span>
        <i class="status-divider"></i>
        <span class="status-metric">回合 <strong id="current-color">—</strong></span>
        <button class="room-chip" id="room-info" hidden><span>房间</span><strong id="panel-room-code">——</strong>${icon('copy')}</button>
        <span class="watch-chip" id="watch-chip" hidden><i></i>观战 <strong id="watch-count">0</strong> 人<span id="watch-names"></span></span>
        <!-- 本地 Rapfi 引擎的实时思考信息（人机局 AI 思考时逐层刷新） -->
        <span class="engine-panel" id="engine-panel" hidden></span>
        <span class="ai-side-picker" id="ai-side-picker" hidden>
          <label class="ai-side-check"><input type="checkbox" id="ai-side-black"><span>计算机执黑</span></label>
          <label class="ai-side-check"><input type="checkbox" id="ai-side-white"><span>计算机执白</span></label>
        </span>
        <span class="game-state-badge" id="game-state-badge">未开始</span>
      </div>
      <div class="dock">
        <div class="phrase-zone" id="phrase-zone" hidden>
          <button class="dock-phrase" id="phrase-toggle" type="button" aria-expanded="false" aria-controls="phrase-panel" title="快捷短语">
            ${icon('chat')}<span>短语</span>
          </button>
          <div class="phrase-panel" id="phrase-panel" role="menu" aria-label="快捷短语" hidden>
            ${PHRASES.map((phrase) => `<button class="phrase-chip" data-phrase="${phrase.id}" type="button" role="menuitem">${phrase.text}</button>`).join('')}
          </div>
        </div>
        <button id="restart-button" disabled>${icon('restart')}<span>重开</span></button>
        <button id="undo-button" disabled>${icon('undo')}<span>悔棋</span></button>
        <!-- 人机 / 本地对弈：随时让本地引擎分析当前局面、给出下一手推荐（手动触发、零服务端参与）。 -->
        <button id="ai-evaluate-button" hidden>${icon('cpu')}<span>AI分析</span></button>
        <!-- 请求 AI 分析：只在好友联机对局中出现，需对方同意后才真正调用引擎。 -->
        <button id="ai-analysis-button" hidden>${icon('cpu')}<span>AI分析</span></button>
        <button id="resign-button" disabled>${icon('flag')}<span>认输</span></button>
        <button id="exit-button" disabled>${icon('exit')}<span>退出</span></button>
      </div>
    </footer>

    <dialog class="modal auth-modal" id="auth-dialog">
      <button class="modal-close" data-close="auth-dialog" aria-label="关闭">${icon('close')}</button>
      <div class="modal-brand"><span class="brand-mark"><i></i><i></i></span></div>
      <p class="eyebrow">WELCOME TO YIJING</p><h2>回到你的棋境</h2><p class="modal-subtitle">登录后，与远方的好友安心对弈。</p>
      <div class="segmented auth-tabs"><button class="active" data-auth-tab="login">登录</button><button data-auth-tab="register">注册</button></div>
      <form id="auth-form">
        <label class="field-label" for="auth-username">用户名</label><input class="text-input" id="auth-username" name="username" autocomplete="username" maxlength="32" placeholder="请输入用户名" required>
        <label class="field-label" for="auth-password">密码</label><input class="text-input" id="auth-password" name="password" type="password" autocomplete="current-password" minlength="8" maxlength="128" placeholder="至少 8 位密码" required>
        <p class="form-error" id="auth-error" role="alert"></p><button class="primary-button full-width" type="submit" id="auth-submit">登录并继续 ${icon('arrow')}</button>
      </form>
      <div class="or-divider"><span></span>或<span></span></div><button class="secondary-button full-width" id="guest-button">以游客身份进入</button>
      <p class="privacy-note">仅使用安全 Cookie 保存会话，无需提供个人信息。</p>
    </dialog>

    <dialog class="modal game-modal" id="game-dialog">
      <button class="modal-close" data-close="game-dialog" aria-label="关闭">${icon('close')}</button>
      <section id="local-options" hidden><span class="modal-feature-icon">${icon('local')}</span><p class="eyebrow">LOCAL GAME</p><h2>本地对弈</h2><p class="modal-subtitle">同屏轮流落子，选一个房间坐下就开始。</p>
        <p class="form-label-row">棋境</p>${scenePickerHtml('local-scene')}
        <p class="form-label-row">规则</p>${rulePickerHtml('local')}
        <p class="form-error" id="local-error"></p><button class="primary-button full-width" id="start-local">开始对局 ${icon('arrow')}</button>
      </section>
      <section id="ai-options" hidden><span class="modal-feature-icon">${icon('cpu')}</span><p class="eyebrow">PLAY WITH AI</p><h2>与 AI 对弈</h2><p class="modal-subtitle">选择你的执子颜色。AI 通过实时联机服务与你对局。</p>
        <div class="color-options"><label><input type="radio" name="ai-color" value="black" checked><span><i class="stone-avatar black"></i><strong>执黑先行</strong><small>掌握开局主动</small></span></label><label><input type="radio" name="ai-color" value="white"><span><i class="stone-avatar white"></i><strong>执白后行</strong><small>从容应对棋局</small></span></label></div>
        <p class="form-label-row">棋境</p>${scenePickerHtml('ai-scene')}
        <p class="form-label-row">规则</p>${rulePickerHtml('ai')}
        <p class="form-error" id="ai-error"></p><button class="primary-button full-width" id="start-ai">开始对局 ${icon('arrow')}</button>
      </section>
      <section id="online-options" hidden><span class="modal-feature-icon">${icon('users')}</span><p class="eyebrow">PLAY TOGETHER</p><h2>与好友相逢</h2><p class="modal-subtitle">点一位在线棋友发起约战，或交换房间号。</p>
        <!-- 读秒刻意放在页签**之上**：约战与建房是同一场对局的两种发起方式，
             对局条件只该选一次。放进「房间号」页签里，点大厅邀请的人就永远
             选不到读秒了。 -->
        <p class="form-label-row">本局读秒</p>${timePickerHtml('online')}
        <div class="segmented lobby-tabs"><button class="active" data-lobby-tab="hall">在线大厅</button><button data-lobby-tab="room">房间号</button></div>
        <div id="lobby-hall">
          <div class="lobby-headline"><span class="lobby-count" id="lobby-count"><i></i><span id="lobby-count-text">正在读取大厅…</span></span><span class="lobby-headline-actions"><button class="text-button" id="lobby-profile">我的名片</button><button class="text-button" id="lobby-refresh">刷新</button></span></div>
          <ul class="lobby-list" id="lobby-list" aria-live="polite"></ul>
          <div class="lobby-empty" id="lobby-empty" hidden><p id="lobby-empty-text">此刻大厅只有你一人。</p><button class="secondary-button" id="lobby-enter" hidden>以当前身份进入大厅</button></div>
        </div>
        <div id="lobby-room" hidden>
          <p class="form-label-row">棋境</p>${scenePickerHtml('room-scene')}
          <p class="form-label-row">规则</p>${rulePickerHtml('room')}
          <button class="primary-button full-width" id="create-room">${icon('plus')} 创建新房间</button><div class="or-divider"><span></span>使用房间号加入<span></span></div>
          <form id="join-form"><label class="field-label" for="room-code-input">房间号</label><div class="join-row"><input class="text-input code-input" id="room-code-input" maxlength="12" autocomplete="off" placeholder="例如 A7K2Q9" required><button class="secondary-button" type="submit">加入</button></div></form>
        </div>
        <p class="form-error" id="online-error"></p><p class="privacy-note" id="online-auth-note">联机需要登录或游客会话。</p>
      </section>
    </dialog>

    <dialog class="modal challenge-modal" id="challenge-dialog">
      <span class="modal-feature-icon">${icon('users')}</span>
      <p class="eyebrow">CHALLENGE</p><h2>一位棋友邀你落子</h2>
      <p class="modal-subtitle"><strong id="challenge-from-name">棋友</strong> 想与你对弈一局，黑白随缘。</p>
      <!-- 对方的读秒条件必须提前写清楚：接受即沿用，事后再告诉人「这局限时 30 秒」就晚了。 -->
      <p class="challenge-condition" id="challenge-condition" hidden>读秒 <strong id="challenge-condition-value">不限时</strong></p>
      <div class="challenge-meter"><i id="challenge-meter-bar"></i></div>
      <p class="challenge-countdown" id="challenge-countdown">30 秒内回应</p>
      <div class="confirm-actions"><button class="secondary-button" id="challenge-decline">婉拒</button><button class="primary-button" id="challenge-accept">接受约战</button></div>
    </dialog>

    <dialog class="modal confirm-modal" id="confirm-dialog"><span class="modal-feature-icon small">${icon('flag')}</span><h2 id="confirm-title">确认操作</h2><p class="modal-subtitle" id="confirm-message"></p><div class="confirm-actions"><button class="secondary-button" id="confirm-cancel">再想想</button><button class="primary-button" id="confirm-accept">确认</button></div></dialog>
    <dialog class="modal" id="profile-card">
      <button class="modal-close" data-close="profile-card" aria-label="关闭">${icon('close')}</button>
      <p class="eyebrow">PROFILE</p>
      <h2 id="profile-card-name">个人名片</h2>
      <p class="modal-subtitle" id="profile-card-sub"></p>
      <div id="profile-card-body"></div>
    </dialog>

    <dialog class="modal shop-modal" id="shop-dialog">
      <button class="modal-close" data-close="shop-dialog" aria-label="关闭">${icon('close')}</button>
      <div id="shop-content"></div>
    </dialog>
    <dialog class="modal settings-modal" id="settings-dialog">
      <button class="modal-close" data-close="settings-dialog" aria-label="关闭">${icon('close')}</button>
      <span class="modal-feature-icon small">${icon('gear')}</span>
      <p class="eyebrow">SETTINGS</p><h2>设置</h2>
      <p class="modal-subtitle">只影响你自己看到的样子，不影响对手。</p>
      <div class="setting-group">
        <p class="setting-label">棋子上的手数编号</p>
        <div class="segmented setting-options" id="move-number-options" role="radiogroup" aria-label="手数编号">
          <button type="button" data-move-numbers="off">不显示</button>
          <button type="button" data-move-numbers="last">最新一步</button>
          <button type="button" data-move-numbers="lastTwo">最新两步</button>
          <button type="button" data-move-numbers="all">全部步数</button>
        </div>
        <p class="setting-hint" id="move-number-hint"></p>
      </div>
      <div class="setting-group">
        <p class="setting-label">对方棋子皮肤</p>
        <div class="segmented" id="opponent-skin-options" role="radiogroup" aria-label="对方棋子皮肤">
          <button type="button" data-opponent-skin="on" class="active">显示</button>
          <button type="button" data-opponent-skin="off">隐藏</button>
        </div>
        <p class="setting-hint">仅在联机对局生效：关闭后，双方棋子均显示你自己已启用的皮肤。</p>
      </div>
      <div class="setting-group">
        <p class="setting-label">棋盘坐标</p>
        <div class="segmented" id="board-coords-options" role="radiogroup" aria-label="棋盘坐标">
          <button type="button" data-board-coords="on">显示</button>
          <button type="button" data-board-coords="off" class="active">隐藏</button>
        </div>
        <p class="setting-hint">方便讲棋与复盘时对照落点，只影响你看到的画面。</p>
      </div>
    </dialog>

    <dialog class="modal undo-modal" id="undo-dialog"><span class="modal-feature-icon small">${icon('undo')}</span><p class="eyebrow">UNDO REQUEST</p><h2>对手请求悔棋</h2><p class="modal-subtitle" id="undo-request-message">对方希望撤销上一轮落子，是否同意？</p><div class="confirm-actions"><button class="secondary-button" id="undo-decline">婉拒</button><button class="primary-button" id="undo-accept">同意悔棋</button></div></dialog>
    <dialog class="modal undo-modal" id="restart-dialog"><span class="modal-feature-icon small">${icon('restart')}</span><p class="eyebrow">RESTART REQUEST</p><h2>对手请求重开</h2><p class="modal-subtitle" id="restart-request-message">对方想要重开本局，是否同意？同意后棋盘与落子历史将被清空。</p><div class="confirm-actions"><button class="secondary-button" id="restart-decline">婉拒</button><button class="primary-button" id="restart-accept">同意重开</button></div></dialog>
    <dialog class="modal undo-modal" id="ai-analysis-dialog"><span class="modal-feature-icon small">${icon('cpu')}</span><p class="eyebrow">AI ANALYSIS</p><h2>请求 AI 分析</h2><p class="modal-subtitle"><strong id="ai-analysis-from">对手</strong> 希望请 AI 分析当前局面并给出建议一手，是否同意？</p><div class="confirm-actions"><button class="secondary-button" id="ai-analysis-decline">婉拒</button><button class="primary-button" id="ai-analysis-accept">同意分析</button></div></dialog>
    <dialog class="modal replay-modal" id="replay-dialog">
      <button class="modal-close" data-close="replay-dialog" aria-label="关闭">${icon('close')}</button>
      <span class="modal-feature-icon small">${icon('replay')}</span>
      <p class="eyebrow">REVIEW</p><h2>复盘</h2>
      <p class="modal-subtitle">挑一局已经下完的棋，一手一手看回来。</p>
      <div class="segmented replay-tabs" id="replay-tabs" role="tablist" aria-label="对局类型">
        <button type="button" role="tab" data-replay-tab="all" class="active">全部</button>
        <button type="button" role="tab" data-replay-tab="online">与好友</button>
        <button type="button" role="tab" data-replay-tab="ai">与 AI</button>
      </div>
      <ul class="replay-list" id="replay-list" aria-live="polite"></ul>
      <p class="replay-empty" id="replay-empty" hidden>还没有可以复盘的棋局。<br>下完一局（对 AI 或好友）之后再来。</p>
      <p class="form-error" id="replay-error" role="alert"></p>
    </dialog>

    <div class="replay-bar" id="replay-bar" hidden>
      <div class="replay-bar-head">
        <!-- 返回做成实心按钮放在最左：复盘时对局界面的其它出口都被收起了，
             只剩这一条路，弱化成文字链会让人找不到怎么回到首页。 -->
        <button class="replay-back" id="replay-exit">
          ${icon('back')}<span>返回</span>
        </button>
        <div class="replay-bar-info">
          <span class="replay-bar-title" id="replay-bar-title">复盘</span>
          <span class="replay-bar-time" id="replay-bar-time"></span>
        </div>
        <span class="replay-bar-result" id="replay-bar-result"></span>
      </div>
      <div class="replay-controls">
        <button class="replay-step" id="replay-first" title="回到开局" aria-label="回到开局">${icon('first')}</button>
        <button class="replay-step" id="replay-prev" title="上一手" aria-label="上一手">${icon('prev')}</button>
        <button class="replay-step primary" id="replay-toggle" title="播放" aria-label="播放">${icon('play')}</button>
        <button class="replay-step" id="replay-next" title="下一手" aria-label="下一手">${icon('next')}</button>
        <button class="replay-step" id="replay-last" title="跳到终局" aria-label="跳到终局">${icon('last')}</button>
        <input class="replay-slider" id="replay-slider" type="range" min="0" max="0" value="0" step="1" aria-label="手数进度">
        <span class="replay-progress" id="replay-progress">0 / 0</span>
        <!-- AI 评估是纯手动开关：点了才用本地引擎分析当前局面（纯手动、零服务端参与）。 -->
        <button class="replay-step replay-ai" id="replay-ai" title="让本地引擎推荐这一手的落点" aria-label="AI 评估">
          ${icon('cpu')}<span>AI评估</span>
        </button>
        <span class="replay-ai-result" id="replay-ai-result" aria-live="polite"></span>
        <button type="button" class="replay-step replay-keep" id="replay-keep" title="把这局棋谱永久保存，不参与 30 天自动清理">永久储存</button>
      </div>
      <p class="replay-hint">拖动进度条可回看任意一手 · 按 Esc 也能退出</p>
    </div>

    <!-- 短语气泡必须挂在场景层之外：场景层是 z-index:0 的独立层叠上下文，
         放在里面会被顶栏 / 叙事行等 HUD 压住（手机上尤其明显）。 -->
    <div class="phrase-layer" id="phrase-layer" aria-live="polite"></div>

    <div class="toast-region" id="toast-region" aria-live="polite" aria-atomic="true"></div>
  `;
}
