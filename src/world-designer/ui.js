'use strict';
/* ui.js —— 唯一操作 DOM 的模块。依赖全局：VFS, Tokens, ContextBudget, Compress, SSE, ZIP, Skills, SkillLoader,
   Versioning, MD, DB, Agent, AGENT_CONFIG, SEED_FILES, BUILTIN_SKILLS, COMPRESS_CONFIG,
   LONG_INPUT_TEMPLATE, DEFAULT_SETTINGS, DesignerResources, buildSystemPrompt, renderTemplate, validateCustomContextK */
(() => {
  // ---------- 全局状态 ----------
  const S = {
    settings: { ...DEFAULT_SETTINGS },
    projects: [], groups: [], sessions: [],
    userSkills: [],
    externalSkills: [],        // 从同级 skills/ 目录加载的内置 Skill
    disabledSkills: new Set(), // 普通技能的禁用状态；常驻特殊技能不受影响
    skillLoad: null,           // 外部加载报告 { available, warnings, errors }
    snapshots: [],
    projectId: null, sessionId: null,
    tree: null,                 // 当前项目 VFS 树
    validation: null,           // 最新格式校验报告；只读检查已写入 VFS 的内容
    validationPending: false,
    validationDirty: false,     // 工作区发生改动后，下一次经过状态按钮时再检查一次
    repairSending: false,
    continuing: false,
    storageBusy: false,
    activeTmpPaths: new Set(),  // 正在运行的轮次需要的临时文件，容量清理时暂时保留
    readState: new Map(),       // 写保护：path → 读取时 mtime（每项目重置）
    running: false,             // 本页正在跑 Agent 轮次
    run: null,                 // 本轮中止控制器与收尾完成信号
    runningSession: null,       // 正在运行轮次的 sessionId（send() 赋值）
    lockedBy: null,             // 他处（其他标签页）持锁的 sessionId
    view: 'chat',               // chat | editor（editor 在桌面占中栏、手机占「文件」标签页）
    editorPath: null, editorDirty: false, editorPreview: false,
    selectedPath: null,         // 文件管理器当前选中项
    clipboard: null,            // 文件管理器剪贴板 { path, cut }
    expanded: new Set(),        // 展开的目录路径（默认折叠）
    fmRoot: '/workspace',       // 文件管理器当前视角根目录（支持“进入”下钻）
    promptDraft: '',            // 历史回溯前的输入草稿
    histIdx: -1,                // 提示词历史回溯位置（-1 = 未回溯）
    skillMenuIdx: 0,            // Skill 自动补全高亮项
    lastLongPressAt: 0,         // 上次长按弹菜单的时刻，用于吞掉浏览器补发的 contextmenu
    pending: {},                // 待审阅变更：path → { path, before, after, turn }
    turnCounter: 0,             // 轮次序号，用于 scope=last 时区分「最后一次改动」
    reviewPath: null,           // 编辑器当前处于审阅模式的文件
    editorStale: null,          // 编辑器内容被 AI 覆盖但用户有未保存修改时的提示信息
    abort: null,                // 本轮 AbortController（中止按钮用）
    streamBuf: '',              // 流式分片累积缓冲
    reasonBuf: '',              // 流式思考内容缓冲（reasoning_content）
    streamSession: null,        // 流式内容归属的会话 id（防止画到别的会话）
    stickToBottom: true,        // 用户离开底部即暂停跟随，回到底部后恢复
    reviewDecided: new Map(),   // 审阅中每个 hunk 的决定
    reviewApplyTimer: null,     // 保留字段以兼容旧引用（决定已改为即时生效）
    reviewOrigin: null,         // 进入审阅时的文件内容，供「撤销全部决定」还原
    activeTool: null,           // 正在执行的工具调用（用于「处理中」占位卡片）
    openTools: new Set(),       // 用户展开过的工具卡片 id —— 重绘时保持展开
    streamingTools: null,       // 模型正在流式生成参数的工具调用快照
    pendingAsk: null,           // 待作答的 ask_user 提问（最小化后内嵌在对话里）
    goal: null,                 // 当前会话的目标 { content, changedPending }
    goalExpanded: false,        // 目标条文本展开态（长目标单行放不下时点开看全文）
    chatFrom: null,             // 对话窗口起点（只渲染 messages[chatFrom..]）
    chatFromSession: null,      // 窗口起点所属会话，切会话时重置
    chatLoadingEarlier: false,  // 正在向上加载，防高频 scroll 重入

  };
  const bc = ('BroadcastChannel' in self) ? new BroadcastChannel('agent-workbench-lock') : null;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const TAB_ID = uid();
  // 跨窗口执行租约：真值存 localStorage，bc 只做即时通知。localStorage 不可用时 available=false（任务 15 降级横幅）。
  const lease = Lease.create({
    storage: (typeof localStorage !== 'undefined') ? localStorage : null,
    channel: bc,
    tabId: TAB_ID,
    now: () => Date.now(),
  });
  let leaseHeartbeat = null;
  let leasePoll = null;
  function reconcileLease() {
    const l = lease.readLease(S.projectId);
    const held = l && l.tab !== TAB_ID && (Date.now() - l.ts) <= lease.EXPIRY;
    const next = held ? l.session : null;
    if (next !== S.lockedBy) { S.lockedBy = next; renderSidebar(); renderLockNotice(); }
  }
  function startLeasePoll() {
    if (!leasePoll) leasePoll = setInterval(reconcileLease, 2000);
  }
  // 轮次内续约 + split-brain 自停：检查每次都执行，写 ts 由 lease 模块节流到至少 2s。
  function renewOrAbort(projectId) {
    if (!S.running) { lease.renewLeaseThrottled(projectId); return; }
    if (lease.lostWhileRunning(projectId)) {
      if (S.abort && !S.abort.aborted) {
        toast('检测到其他窗口接管，本轮已停');
        abortRun();
      }
      return;
    }
    lease.renewLeaseThrottled(projectId);
  }
  const $ = sel => document.querySelector(sel);
  const el = (tag, attrs = {}, ...children) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'text') e.textContent = v;
      // null/false/undefined 表示「不要这个属性」。布尔属性（disabled 等）只要属性存在
      // 就生效，setAttribute(k, null) 会写成字符串 "null" 反而把按钮禁用了。
      else if (v === null || v === undefined || v === false) continue;
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
    e.append(...children.filter(Boolean));
    return e;
  };
  const displayPath = p => p.replace(/^\/workspace\/?/, '') || '/';

  // ---------- 返回键 / 手势返回：复用各层的取消或收起入口 ----------

  // 按「最上层优先」排列的关闭动作。每项返回 true 表示「我消费了这次返回」。
  // 顺序即优先级：模态 > 菜单 > 提问弹窗 > 编辑器 > 目录层级。
  function backHandlers() {
    return [
      () => { const pop = $('#helpPop'); if (!pop) return false; pop.dismissFromBack(); return true; },
      () => { if (!$('.ctx-menu')) return false; closeCtxMenu(); return true; },
      // 二次确认 / 输入框 / 属性框等所有 overlay：等同于点「取消」
      () => {
        const ovs = document.querySelectorAll('.overlay');
        if (!ovs.length) return false;
        const top = ovs[ovs.length - 1];
        if (top.dismissFromBack) { top.dismissFromBack(); return true; }
        // 优先走弹窗自己的取消路径，保证 Promise 能 resolve、监听能解绑
        const cancel = [...top.querySelectorAll('.foot button, button')]
          .find(b => /取消|关闭/.test(b.textContent || ''));
        if (cancel && !cancel.disabled) cancel.click();
        return true;
      },
      () => { if (!S.skillPopOpen) return false; hideSkillPop(); return true; },
      () => { if (!$('#worldValidationTooltip')) return false; hideValidationTooltip(); return true; },
      // 编辑器 → 文件列表（与「返回」按钮同一入口，含未保存提示）
      () => { if (S.view !== 'editor') return false; closeEditor(); return true; },
      // 文件管理器里已进入子目录 → 回上一级
      () => {
        if (S.view !== 'chat') return false;
        if (VFS.normalize(S.fmRoot).length <= 1) return false;
        fmGoUp();
        return true;
      },
      // 窄屏：侧栏/文件标签页 → 回到对话页，而不是直接退出应用
      () => {
        if (!isMobile() || !S.tab || S.tab === 'chat') return false;
        setTab('chat');
        return true;
      },
    ];
  }
  // 关掉最上面一层；没有任何一层可关时返回 false（让系统处理，即退出应用）
  function handleBack() {
    if (TransferDialog.handleBack()) return true;
    if (S.handoffBusy) return true;
    for (const h of backHandlers()) {
      try { if (h()) return true; } catch (_) { /* 单个处理器出错不该卡住返回键 */ }
    }
    if (S.running) { toast('请先中止 AI 当前工作，再离开页面'); return true; }
    flushDraft();
    return false;
  }
  function initBackButton() {
    BackNavigation.install(handleBack);
  }

  function confirmDialog(title, bodyText, danger, okText = '确认') {
    return new Promise(resolve => {
      const ov = el('div', { class: 'overlay' });
      const done = v => { ov.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
      ov.dismissFromBack = () => done(false);
      const onKey = e => {
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
        else if (e.key === 'Enter') { e.preventDefault(); done(true); }
      };
      document.addEventListener('keydown', onKey, true);
      const okBtn = el('button', { class: danger ? 'danger' : 'primary', text: okText, onclick: () => done(true) });
      ov.append(el('div', { class: 'modal' },
        el('h3', { text: title }),
        el('div', { text: bodyText, style: 'white-space:pre-wrap' }),
        el('div', { class: 'foot' },
          el('button', { text: '取消', onclick: () => done(false) }),
          okBtn)));
      document.body.append(ov);
      okBtn.focus();
    });
  }

  // 自定义输入框（替代 window.prompt，保证 UI 统一且不受浏览器限制）
  // opts: { title, label, value, placeholder, okText, validate(v) → 错误文本|null }
  function promptDialog(opts) {
    return new Promise(resolve => {
      const o = opts || {};
      const ov = el('div', { class: 'overlay' });
      const err = el('div', { class: 'field-error' });
      const input = el('input', { value: o.value || '', placeholder: o.placeholder || '' });
      const done = v => { ov.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
      ov.dismissFromBack = () => done(null);
      const submit = () => {
        const v = input.value.trim();
        if (!v) { err.textContent = '不能为空'; input.focus(); return; }
        if (o.validate) {
          const msg = o.validate(v);
          if (msg) { err.textContent = msg; input.focus(); return; }
        }
        done(v);
      };
      const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
      document.addEventListener('keydown', onKey, true);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });
      input.addEventListener('input', () => { err.textContent = ''; });
      ov.append(el('div', { class: 'modal' },
        el('h3', { text: o.title || '输入' }),
        o.label ? el('div', { class: 'field-label', text: o.label }) : null,
        input, err,
        el('div', { class: 'foot' },
          el('button', { text: '取消', onclick: () => done(null) }),
          el('button', { class: 'primary', text: o.okText || '确定', onclick: submit }))));
      document.body.append(ov);
      input.focus(); input.select();
    });
  }
  // 名称校验：禁止斜杠与首尾空白
  const nameValidator = v => /[/\\]/.test(v) ? '名称不能包含斜杠' : null;

  function toast(msg) {
    const t = el('div', { class: 'toast', text: msg });
    document.body.append(t); setTimeout(() => t.remove(), 2500);
  }

  // 长按呼出菜单（手机端）：500ms 触发，移动超过 10px 取消。
  // 两个坑：
  //   ① 子元素与容器都绑了长按（如文件行 vs 文件树空白区），不拦冒泡会双双触发；
  //   ② 移动端浏览器在长按时还会自行派发原生 contextmenu，与元素上供桌面右键用的
  //      oncontextmenu 撞车，导致菜单被关掉又重开——即闪一下。
  //      拦截在文档级捕获处统一做（见 isEchoContextMenu），此处只记录时刻。
  function attachLongPress(node, buildItems) {
    let timer = null, sx = 0, sy = 0, fired = false;
    const clear = () => { if (timer) clearTimeout(timer); timer = null; };
    node.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) return;
      e.stopPropagation();          // 阻止祖先节点的长按计时器一同启动
      fired = false;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
      timer = setTimeout(() => {
        fired = true;
        S.lastLongPressAt = Date.now();
        if (navigator.vibrate) navigator.vibrate(12);
        showCtxMenu(sx, sy, buildItems());
      }, 500);
    }, { passive: true });
    node.addEventListener('touchmove', e => {
      if (!timer) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) clear();
    }, { passive: true });
    node.addEventListener('touchend', e => {
      clear();
      if (fired) { e.preventDefault(); e.stopPropagation(); }   // 长按已处理，抑制随后的 click
    });
    node.addEventListener('touchcancel', clear, { passive: true });
  }

  // SF Symbols 风格线性图标（stroke 继承 currentColor）
  const ICONS = {
    x: '<path d="m6 6 12 12M18 6 6 18"/>',
    github: '<path d="M9 19c-4.3 1.3-4.3-2.2-6-2.7M15 22v-3.9a3.4 3.4 0 0 0-.9-2.7c3.2-.4 6.6-1.6 6.6-7.3a5.7 5.7 0 0 0-1.5-4A5.3 5.3 0 0 0 19.1.2S17.9-.2 15 1.7a14 14 0 0 0-7.5 0C4.6-.2 3.4.2 3.4.2a5.3 5.3 0 0 0-.1 3.9 5.7 5.7 0 0 0-1.5 4c0 5.7 3.4 6.9 6.6 7.3A3.4 3.4 0 0 0 7.5 18V22" transform="translate(2 1) scale(.88)"/>',
    chat: '<path d="M12 3C7 3 3 6.6 3 11c0 2.2 1 4.1 2.7 5.5L5 21l4.2-2.2c.9.2 1.8.4 2.8.4 5 0 9-3.6 9-8s-4-8-9-8z"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
    folderOpen: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3V7z"/><path d="M3 10h18l-2 8a2 2 0 0 1-2 1.6H5A2 2 0 0 1 3 18V10z"/>',
    doc: '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.85a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01A1.7 1.7 0 0 0 10.05 3V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z"/>',
    compress: '<path d="M8 3v4a1 1 0 0 1-1 1H3M16 3v4a1 1 0 0 0 1 1h4M8 21v-4a1 1 0 0 0-1-1H3M16 21v-4a1 1 0 0 1 1-1h4"/>',
    folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M12 10v6M9 13h6"/>',
    gamepad: '<path d="M7 7h10c2 0 3 2 3.5 4l1 5c.5 3-2 4-4 1l-1-1h-9l-1 1c-2 3-4.5 2-4-1l1-5C4 9 5 7 7 7z"/><path d="M7 10v4M5 12h4"/><circle cx="16" cy="11" r=".8"/><circle cx="18" cy="13" r=".8"/>',
    filePlus: '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/>',
    open: '<path d="M14 4h6v6M20 4l-9 9M9 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/>',
    delmsg: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11l4 4M14 11l-4 4"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    cut: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1L20 20M8.1 15.9L20 4M12 12l2.5 2.5"/>',
    paste: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    pencil: '<path d="M17 3l4 4L8 20H4v-4L17 3z"/>',
    trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
    send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    download: '<path d="M12 3v12M6 11l6 6 6-6M5 21h14"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    more: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
    expand: '<path d="M8 3v4a1 1 0 0 1-1 1H3M16 3v4a1 1 0 0 0 1 1h4M8 21v-4a1 1 0 0 0-1-1H3M16 21v-4a1 1 0 0 1 1-1h4"/>',
    collapseAll: '<path d="M4 9h16M4 15h16M9 4l3 3 3-3M9 20l3-3 3 3"/>',
    expandAll: '<path d="M4 9h16M4 15h16M12 2v5M12 17v5M9 5l3-3 3 3M9 19l3 3 3-3"/>',
    enter: '<path d="M4 12h14M13 6l6 6-6 6"/>',
    upLevel: '<path d="M12 19V6M6 12l6-6 6 6"/>',
    upload: '<path d="M12 15V3M6 9l6-6 6 6M5 21h14"/>',
    archive: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M11 3v3h2v3h-2v3h2v3h-2v3h2"/>',
    check: '<path d="M4 12l5 5L20 6"/>',
    diff: '<path d="M6 3v12M6 21v-2M3 6h6M18 21V9M18 3v2M15 18h6"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="7" r="2"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.4-2.8 2.4M12 17h.01"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    tag: '<path d="M20.6 13.4L12 4.8A2 2 0 0 0 10.6 4H5a1 1 0 0 0-1 1v5.6a2 2 0 0 0 .6 1.4l8.6 8.6a2 2 0 0 0 2.8 0l4.6-4.6a2 2 0 0 0 0-2.6z"/><circle cx="8" cy="8" r="1.2"/>',
    think: '<path d="M12 4a6 6 0 0 1 6 6c0 2-1 3.2-2 4.2-.7.8-1 1.3-1 2.3h-6c0-1-.3-1.5-1-2.3-1-1-2-2.2-2-4.2a6 6 0 0 1 6-6z"/><path d="M9.5 19.5h5M10.5 22h3"/>',
  };
  function icon(name, cls) {
    const s = el('span', { class: 'icon' + (cls ? ' ' + cls : '') });
    s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
    return s;
  }

  // ---------- 数据访问 ----------
  // 固定的深渊凝视者标记；不读取历史头像或助手名称设置。
  function avatarEl() {
    const box = el('div', { class: 'avatar abyss-eye', role: 'img', 'aria-label': '世界设计者：深渊凝视者' });
    box.innerHTML = '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><circle cx="24" cy="24" r="21" stroke="currentColor" stroke-opacity=".35"/><path d="M5 24c5-8 12-12 19-12s14 4 19 12c-5 8-12 12-19 12S10 32 5 24Z" stroke="currentColor" stroke-width="1.5"/><path d="M9 24c5-4 10-6 15-6s10 2 15 6" stroke="currentColor" stroke-opacity=".5"/><circle cx="24" cy="24" r="8.5" stroke="currentColor" stroke-width="1.5"/><circle cx="24" cy="24" r="5" fill="currentColor" fill-opacity=".18"/><path d="M24 17c-3 4-3 10 0 14 3-4 3-10 0-14Z" fill="currentColor"/><circle cx="26" cy="21" r="1.2" fill="#eee7d7"/><path d="M24 3v5m0 32v5M9 9l4 4m22 22 4 4M9 39l4-4m22-22 4-4" stroke="currentColor" stroke-linecap="round"/></svg>';
    return box;
  }

  const cur = {
    project: () => S.projects.find(p => p.id === S.projectId),
    session: () => S.sessions.find(s => s.id === S.sessionId),
    projSessions: () => S.sessions.filter(s => s.projectId === S.projectId),
    projGroups: () => S.groups.filter(g => g.projectId === S.projectId).sort((a, b) => a.order - b.order),
    // 外部 skills/ 目录加载成功时用它，否则回退到代码内的 BUILTIN_SKILLS
    // installedSkills = 已安装的全部（含被禁用的），供设置面板列表用
    installedSkills: () => DesignerResources.installed(S.externalSkills),
    // allSkills = 实际生效的（已过滤禁用项）。系统提示、工具、补全等一律走这里
    allSkills: () => DesignerResources.active(S.externalSkills, S.disabledSkills),
  };
  const isSkillDisabled = name => !DesignerResources.isRequired(name) && S.disabledSkills.has(name);
  async function saveDisabledSkills() {
    for (const name of S.disabledSkills) if (DesignerResources.isRequired(name)) S.disabledSkills.delete(name);
    await DB.put('config', { id: 'disabledSkills', value: [...S.disabledSkills] });
  }
  // 常驻技能始终启用；其他技能的禁用状态跨会话持久化。
  async function toggleSkillEnabled(name) {
    if (DesignerResources.isRequired(name)) return;
    if (S.disabledSkills.has(name)) S.disabledSkills.delete(name);
    else S.disabledSkills.add(name);
    await saveDisabledSkills();
    // 禁用的 Skill 其附件也应从虚拟文件系统卸载，避免模型仍能 read_file 读到
    if (S.tree) {
      const root = VFS.resolve(S.tree, ['skills']);
      if (root) root.children = {};
      mountSkillFiles(S.tree);
      await saveTree();
      renderFileTree();
    }
  }

  /* ---------- 会话持久化：元数据与消息拆表 ----------
     sess.messages 在内存里仍是同步数组（send 循环、渲染、撤回都依赖同步访问），
     只有落库方式变了：元数据写 sessions 表，消息写 messages 表。
     追加类改动（最常见：每来一条新消息）只写新增的那几条；
     结构性改动（删除/撤回/压缩重排）才整段重写。
     启动时可能只载入尾部（见 loadSessions），此时 sess.__baseSeq 记录内存数组
     首条对应的库内序号：数组下标 i 的落库序号恒为 __baseSeq + i。 */
  async function saveSession(sess) {
    renewOrAbort(S.projectId);
    // 内部管理字段（__ 前缀）只在内存里有意义，不落库
    const { messages, __savedCount, __dirtyAll, __baseSeq, __partial, ...meta } = sess;
    const base = sess.__baseSeq || 0;
    meta.msgCount = base + messages.length;  // 供会话列表等场景不载入消息就知道规模
    await DB.put('sessions', meta);
    const saved = sess.__savedCount || 0;
    if (messages.length > saved && !sess.__dirtyAll) {
      // 纯追加：只写 saved.. 之后的部分
      await DB.appendMessages(sess.id, messages.slice(saved), base + saved);
    } else if (sess.__dirtyAll || messages.length < saved) {
      // 有中段修改或删减：重写内存覆盖的整段；未载入的前缀在库里原样保留
      await DB.putMessages(sess.id, messages, base);
    }
    sess.__savedCount = messages.length;
    sess.__dirtyAll = false;
  }
  // 中段被改动（splice / 重排 / 标记 displayOnly）时调用，下次保存走整段重写
  function markSessionDirty(sess) { if (sess) sess.__dirtyAll = true; }

  // 载入全部会话。消息不全量读：压缩机制保证最后一个未折叠的摘要块之上全是
  // displayOnly 的折叠原文，组装请求根本用不到。所以从最新往回读，碰到摘要块
  // 或累计超过上下文上限就停——更早的滚动回看时再补读（loadEarlierMessages）。
  // 兼容 v1 数据：老记录的 messages 直接内嵌在 sessions 里，首次载入时迁移到新表。
  async function loadSessions() {
    const metas = await DB.all('sessions');
    const capTokens = (S.settings.maxContextK || DEFAULT_SETTINGS.maxContextK) * 1000;
    const out = [];
    for (const meta of metas) {
      const sess = { ...meta };
      if (Array.isArray(meta.messages) && meta.messages.length) {
        // v1 老数据：搬到 messages 表，然后从会话记录里摘掉
        await DB.putMessages(sess.id, meta.messages);
        sess.messages = meta.messages;
        sess.__baseSeq = 0;
      } else {
        // 压缩块之上全是 displayOnly 的折叠原文（compressNow 的重排保证了这一点），
        // 组装请求时本就会被过滤掉，不载入不影响上下文完整性——这是安全边界。
        // 因 token 超限而停则只是“先读一批”，上方可能还有活的上下文，标记出来，
        // 真要发请求前（send 的超限预检）再补全，免得预检基于半截历史算出错误结论。
        let acc = 0, stop = null;
        const r = await DB.getMessagesTailWhile(sess.id, (m, n) => {
          if (m.role === 'compressed' && !m.displayOnly) { stop = 'compressed'; return false; }
          acc += Tokens.estimateMessage(m);
          if (ContextBudget.occupied(S.settings, acc) > capTokens && n >= CHAT_PAGE) { stop = 'cap'; return false; }
          return true;                                  // 超上限也至少留够一屏
        });
        sess.messages = r.messages;
        sess.__baseSeq = r.fromSeq;
        sess.__partial = r.hasMore ? stop : null;
      }
      sess.__savedCount = sess.messages.length;
      sess.__dirtyAll = false;
      out.push(sess);
    }
    // 迁移过的会话立刻重存一次，去掉内嵌的 messages 字段
    for (const s of out) if (Array.isArray(metas.find(m => m.id === s.id).messages)) await saveSession(s);
    return out;
  }

  // 把还留在库里的更早消息全部补进内存。
  // 需要完整数组的场景（压缩重排、复制会话、上下文预检）先调它，再动 sess.messages。
  // 前插会让所有内存下标右移，故与之并发的读取必须重新取下标——
  // 调用点都在「运行前」或「运行中锁住」的位置，不存在半路插入的情况。
  async function ensureFullHistory(sess) {
    const base = sess.__baseSeq || 0;
    sess.__partial = null;
    if (base <= 0) return;
    const older = await DB.getMessagesRange(sess.id, 0, base);
    prependHistory(sess, older, base - older.length);
  }
  // 把补读到的更早消息接到内存数组前面，并同步所有以数组下标为准的状态
  function prependHistory(sess, older, newBase) {
    if (!older.length) return;
    sess.messages.unshift(...older);
    sess.__baseSeq = newBase;
    sess.__savedCount = (sess.__savedCount || 0) + older.length;
    // 渲染窗口起点是数组下标，前面插了内容要同步右移，否则视口会跳
    if (S.chatFromSession === sess.id && S.chatFrom != null) S.chatFrom += older.length;
  }
  async function saveTree() {
    renewOrAbort(S.projectId);
    if (!S.validationPending) validateWorkspace(false);
    S.validationDirty = true;
    S.validationSave = DB.putWorkspace(S.projectId, S.tree, DesignerProjects.summary(S.validation, !S.validationPending));
    await S.validationSave;
  }

  function seedTree() {
    const t = VFS.createTree();
    VFS.mkdirp(t, ['workspace']); VFS.mkdirp(t, ['skills']);
    for (const [rel, content] of Object.entries(SEED_FILES))
      VFS.writeFile(t, '/workspace/' + rel, content);
    mountSkillFiles(t);
    return t;
  }
  function mountSkillFiles(t) {
    // Skills are page resources, not persisted workspace content. Remove stale mounts.
    VFS.mkdirp(t, ['skills']).children = {};
    for (const sk of cur.allSkills())
      for (const [path, content] of Object.entries(sk.files || {})) {
        const parts = VFS.normalize(path);
        const dir = VFS.mkdirp(t, parts.slice(0, -1));
        dir.children[parts[parts.length - 1]] =
          { type: 'file', name: parts[parts.length - 1], content, mtime: 0 };
      }
  }

  // ---------- 项目 ----------
  async function createProject(name) {
    const p = { id: uid(), name, createdAt: Date.now(), historyLocked: false };
    S.projects.push(p); await DB.put('projects', p);
    const sess = { id: uid(), projectId: p.id, groupId: null, name: '新会话', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    S.sessions.push(sess); await saveSession(sess);
    return p;
  }
  async function switchProject(id) {
    if (S.storageBusy && id !== S.projectId) { toast('正在清理项目数据，请稍后切换'); return; }
    if (S.running) { toast('轮次进行中，不能切换项目'); return; }
    S.projectId = id;
    await DB.put('config', { id: 'lastProject', value: id });
    const rec = await DB.get('vfs', id);
    S.readState = new Map();
    if (rec) { S.tree = rec.tree; mountSkillFiles(S.tree); }
    else { S.tree = seedTree(); await saveTree(); }
    if (!lease.isHeldByOther(id)) {
      const readme = VFS.resolve(S.tree, ['workspace', 'README.md']);
      if (readme?.type === 'file' && readme.content?.replace(/\r\n/g, '\n') === '# 欢迎\n\n这是你的工作区。左侧管理会话，右侧查看文件。\n') {
        VFS.writeFile(S.tree, '/workspace/README.md', SEED_FILES['README.md']);
        await saveTree();
      }
      await migrateLegacyImages();
      if (TempFiles.sweep(S.tree, tmpOptions()).changed) await saveTree();
    }
    const sess = cur.projSessions()[0];
    S.sessionId = sess ? sess.id : null;
    S.view = 'chat';
    S.fmRoot = '/workspace'; S.selectedPath = null; S.expanded = new Set();
    S.histIdx = -1; S.promptDraft = '';
    S.reviewPath = null; S.editorStale = null;
    const pendRec = await DB.get('config', 'pending:' + id);
    S.pending = (pendRec && pendRec.value && typeof pendRec.value === 'object') ? pendRec.value : {};
    await recoverInterruptedStream(id);
    S.snapshots = (await DB.all('snapshots')).filter(s => s.projectId === id);
    reconcileLease();
    renderAll();
    validateWorkspace();
  }
  async function deleteProject(id) {
    const p = S.projects.find(x => x.id === id);
    if (!p || S.handoffBusy) return;
    const ok = await confirmDialog('删除项目', `将永久删除项目「${p.name}」及其全部会话、文件与撤回历史。此操作不可恢复。`, true);
    if (!ok) return;
    if (lease.isHeldByOther(id)) return toast('项目正在其他窗口执行，请先在该窗口中止任务');
    if (S.running && S.projectId === id) await stopRun();
    await flushDraft();
    S.projects = S.projects.filter(x => x.id !== id);
    const doomedSessions = S.sessions.filter(x => x.projectId === id).map(x => x.id);
    S.sessions = S.sessions.filter(x => x.projectId !== id);
    S.groups = S.groups.filter(x => x.projectId !== id);
    await DB.del('projects', id);
    await DB.delWhere('sessions', s => s.projectId === id);
    for (const sid of doomedSessions) await DB.delMessages(sid);
    await DB.delWhere('groups', g => g.projectId === id);
    await DB.del('vfs', id);
    await DB.del('config', DesignerProjects.key(id));
    await DB.del('config', 'stream:' + id);
    await DB.del('config', 'pending:' + id);
    await DB.delWhere('snapshots', s => s.projectId === id);
    if (!S.projects.length) await createProject('默认项目');
    if (S.projectId === id) await switchProject(S.projects[0].id);
    else renderAll();
  }

  // ---------- 工作区锁 ----------
  // 本标签页的唯一标识：BroadcastChannel 会把消息发给同源所有页面（含自己），
  // 必须靠它过滤自己的广播，否则切换会话后会把自己的锁误判成「他人持锁」。
  function setLock(on) {
    S.running = on;
    // 真值在 localStorage 租约：acquireForRun 已在 send/compressNow 入口写入。
    if (on) {
      renewOrAbort(S.projectId);
      if (!leaseHeartbeat) leaseHeartbeat = setInterval(() => renewOrAbort(S.projectId), lease.HEARTBEAT);
    } else {
      if (leaseHeartbeat) { clearInterval(leaseHeartbeat); leaseHeartbeat = null; }
      lease.releaseLease(S.projectId);
      reconcileLease();
    }
    renderSidebar(); renderLockNotice();
  }
  if (bc) bc.onmessage = ev => {
    const m = ev.data;
    if (m.tabId === TAB_ID) return;          // 忽略自己发出的广播
    if (m.projectId !== S.projectId) return; // 仅当前项目
    if (lease.applyPeerMessage(m)) {          // 别家消息 -> 重读真值刷新 UI
      const l = lease.readLease(S.projectId);
      const heldByOther = l && l.tab !== TAB_ID && (Date.now() - l.ts) <= lease.EXPIRY;
      S.lockedBy = heldByOther ? l.session : null;
      renderSidebar(); renderLockNotice();
    }
  };
  function renderLockNotice() {
    updateValidationRepairButton();
    const n = $('#lockNotice');
    if (!n) return;
    // 他处（其他 Session 本页运行，或其他标签页广播）持锁
    const otherRunning = (S.running && S.runningSession && S.runningSession !== S.sessionId)
                      || !!S.lockedBy;
    // 本 Session 正在运行时也禁用输入（避免重入）
    const selfRunning = S.running && S.runningSession === S.sessionId;
    n.style.display = otherRunning ? 'block' : 'none';
    if (otherRunning) {
      const r = lease.blockedReason(S.projectId, S.sessionId);
      const kind = r ? r.kind : 'project';
      n.textContent = kind === 'session'
        ? '⚠ 其他窗口正在运行此会话，当前会话暂不可发送'
        : '⚠ 项目正被其他窗口执行（VFS 写保护），当前会话暂不可发送';
    }
    // 本会话运行中：输入框仍可打字（方便提前写下一条），发送键变中止键
    // contenteditable 没有 disabled，用 contentEditable 属性代替
    const ci = $('#chatInput');
    if (ci) {
      ci.contentEditable = otherRunning ? 'false' : 'true';
      ci.classList.toggle('disabled', !!otherRunning);
      ci.setAttribute('data-placeholder',
        (S.running && S.runningSession && S.runningSession !== S.sessionId)
          ? '只读：当前轮次进行中' : '');
    }
    const btn = $('#sendBtn');
    if (btn) {
      btn.disabled = !!otherRunning;
      btn.classList.toggle('stopping', selfRunning);
      btn.title = selfRunning ? '中止' : '发送';
      btn.innerHTML = '';
      btn.append(icon(selfRunning ? 'stop' : 'send'));
    }
  }
  function sendOrAbort() {
    const running = S.running && S.runningSession === S.sessionId;
    if (running && S.abort) abortRun(); else send();
  }
  // 中止当前轮次：请求层与工具循环都会在最近的检查点停下
  function abortRun() {
    if (!S.abort) return;
    S.abort.abort();
    if (S.pendingAsk?.sessionId === S.runningSession) S.pendingAsk.done('本轮已中止。');
    toast('正在中止…');
  }
  async function clearProjectData(p) {
    if (S.storageBusy || S.handoffBusy || (S.running && S.projectId === p.id) || lease.isHeldByOther(p.id))
      return toast('请先等待任务完成或中止 AI，再清理项目数据');
    if (!await confirmDialog('清理项目数据',
      `将永久清除项目「${p.name}」的文件、对话、输入草稿、目标、分组、临时文件、待审阅变更和全部撤回点。未保存的编辑也会丢弃。\n\n保留项目名称、内置技能及模型设置，并恢复默认 README 和一个空会话。此操作不可恢复。`, true)) return;
    if (S.storageBusy || S.handoffBusy || (S.running && S.projectId === p.id) || lease.isHeldByOther(p.id))
      return toast('项目正在执行任务，请稍后清理');
    const acquired = lease.acquireForRun(p.id, 'storage-cleanup');
    if (!acquired.ok) return toast('项目正在其他窗口执行，请先在该窗口中止任务');
    S.storageBusy = true;
    try {
      await flushDraft();
      const isCurrent = p.id === S.projectId;
      if (isCurrent) { if (draftTimer) clearTimeout(draftTimer); draftTimer = null; draftOwner = null; }
      const tree = seedTree(), report = WorldValidation.check(tree);
      report.checkedAt = Date.now();
      const session = { id: uid(), projectId: p.id, groupId: null, name: '新会话', createdAt: Date.now(), updatedAt: Date.now(), msgCount: 0 };
      const project = { ...p, historyLocked: true };
      await DB.resetProjectData(project, session, tree, DesignerProjects.summary(report, true));
      Object.assign(p, project);
      S.sessions = S.sessions.filter(s => s.projectId !== p.id);
      S.sessions.push({ ...session, messages: [] });
      S.groups = S.groups.filter(g => g.projectId !== p.id);
      if (isCurrent) {
        clearInput($('#chatInput'));
        S.view = 'chat'; S.editorPath = null; S.editorDirty = false; S.clipboard = null;
        S.validationPending = false; S.activeTmpPaths.clear();
        await switchProject(p.id);
      } else renderSidebar();
      toast('已清理项目数据');
    } catch (error) { toast('清理失败：' + error.message); }
    finally {
      S.storageBusy = false;
      if (S.projectId === p.id && !draftOwner) draftOwner = S.sessionId;
      lease.releaseLease(p.id); reconcileLease();
    }
  }
  async function stopRun() {
    const run = S.run;
    if (!run) return;
    abortRun();
    await run.done;
  }

  // ---------- 布局 ----------
  async function switchToGame(event) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (S.handoffBusy) return toast('正在准备世界，请等待交接完成');
    if (S.running) return toast('请先中止当前任务，再切换页面');
    if (S.editorDirty && !await confirmDialog('放弃未保存改动', '文件有未保存改动，仍前往异闻手记？', true)) return;
    try {
      await flushDraft();
      await S.validationSave;
      location.assign('index.html');
    } catch (error) { toast('保存草稿失败：' + error.message); }
  }
  function worldLogo() {
    const mark = el('span', { class: 'world-logo', role: 'img', 'aria-label': '书本环抱地球' });
    mark.innerHTML = '<svg viewBox="0 0 32 34" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><circle cx="16" cy="10" r="7.5"/><ellipse cx="16" cy="10" rx="3" ry="7.5"/><path d="M8.5 10h15M10 5.5c4 2 8 2 12 0M10 14.5c4-2 8-2 12 0M3 14c5-1 9 1 13 5 4-4 8-6 13-5v13c-5-1-9 .5-13 4-4-3.5-8-5-13-4V14Z M16 19v12M6 18c3 0 5 1 7 3M6 22c3 0 5 1 7 3M26 18c-3 0-5 1-7 3M26 22c-3 0-5 1-7 3"/></svg>';
    return mark;
  }
  function validationButton() {
    const button = el('button', { id: 'worldValidationBtn', class: 'world-validation', type: 'button',
      'aria-label': '世界格式校验', 'aria-describedby': 'worldValidationTooltip',
      onclick: () => { hideValidationTooltip(); showValidationDetails(); },
      onmouseenter: showValidationTooltip, onmouseleave: delayHideValidationTooltip,
      onfocus: showValidationTooltip, onblur: hideValidationTooltip });
    return button;
  }
  let validationTooltipTimer;
  function hideValidationTooltip() {
    clearTimeout(validationTooltipTimer); $('#worldValidationTooltip')?.remove();
  }
  function delayHideValidationTooltip() { validationTooltipTimer = setTimeout(hideValidationTooltip, 150); }
  function validationSummary(report) {
    return report.valid ? '格式校验通过' : `存在 ${report.issues.length} 项格式错误`;
  }
  function validateWorkspace(persist = true) {
    if (!S.tree) return;
    S.validation = WorldValidation.check(S.tree);
    S.validationDirty = false;
    S.validation.checkedAt = Date.now();
    if (persist && !lease.isHeldByOther(S.projectId)) {
      S.validationSave = DB.putWorkspace(S.projectId, S.tree, DesignerProjects.summary(S.validation, !S.validationPending));
      S.validationSave.catch(error => toast('校验状态保存失败：' + error.message));
    }
    const button = $('#worldValidationBtn');
    if (button) {
      button.dataset.state = S.validation.valid ? 'valid' : 'invalid';
      button.setAttribute('aria-label', validationSummary(S.validation) + '，点击查看详情');
      button.innerHTML = S.validation.valid
        ? '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 10 3 3 7-7"/></svg>'
        : '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 3 7 13H3L10 3Z"/><path d="M10 7v4m0 2.5v.1"/></svg>';
    }
    if ($('#worldValidationTooltip')) showValidationTooltip();
    updateValidationRepairButton();
    return S.validation;
  }
  function showValidationTooltip() {
    hideValidationTooltip();
    if (S.validationDirty) validateWorkspace();
    if (!S.validation) return;
    const button = $('#worldValidationBtn'), rect = button.getBoundingClientRect();
    const tip = el('div', { id: 'worldValidationTooltip', class: 'validation-tooltip', role: 'tooltip',
      onmouseenter: () => clearTimeout(validationTooltipTimer), onmouseleave: delayHideValidationTooltip },
      el('strong', { text: validationSummary(S.validation) }),
      el('p', { text: '检查已保存内容；点击状态灯可定位问题。' }));
    const list = el('ul');
    for (const issue of S.validation.issues) list.append(el('li', { text: issue.root + ' · ' + issue.message }));
    tip.append(list); document.body.append(tip);
    tip.style.left = Math.max(8, Math.min(rect.left, innerWidth - tip.offsetWidth - 8)) + 'px';
    tip.style.top = Math.min(rect.bottom + 8, innerHeight - 100) + 'px';
  }
  function validationIssueList(report, activate) {
    const list = el('ol', { class: 'validation-issues' });
    for (const issue of report.issues) list.append(el('li', {},
      el('button', { type: 'button', class: 'validation-issue', 'data-path': issue.path, onclick: () => activate(issue) },
        el('span', { text: issue.message }), el('small', { text: issue.path }))));
    return list;
  }
  function locateValidationIssue(issue) {
    try {
      const target = WorldValidation.locate(S.tree, issue.path);
      S.fmRoot = target.directory; S.selectedPath = target.file ? target.path : null;
      // Keep the user's unsaved text intact, including when the editor occupies the files pane.
      if (target.file && !S.editorDirty) openEditor(target.path);
      else if (S.editorDirty) toast('已定位目录；当前文件有未保存修改，请先保存后打开目标文件。');
      else { S.view = 'chat'; S.editorPath = null; renderAll(); }
      renderFileTree();
      if (S.editorDirty) { S.validationReveal = true; renderAll(); }
      if (isMobile()) setTab('files');
      fmSelect(target.file ? target.path : null);
    } catch (error) { toast(error.message); }
  }
  function showValidationDetails() {
    const report = validateWorkspace();
    if (!report) return;
    const previous = document.activeElement;
    const overlay = el('div', { class: 'overlay', id: 'worldValidationDialog' });
    const close = () => { overlay.remove(); if (previous?.isConnected) previous.focus(); };
    overlay.dismissFromBack = close;
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    const box = el('div', { class: 'modal validation-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '世界格式校验', tabindex: '-1' },
      el('div', { class: 'validation-modal-header' }, el('h3', { text: '世界格式校验' }),
        el('button', { type: 'button', class: 'iconbtn', 'aria-label': '关闭格式校验', title: '关闭', onclick: close }, icon('x'))),
      el('p', { text: validationSummary(report) }),
      el('p', { class: 'validation-note', text: '检查已保存内容。点击问题定位文件或最近存在的上级目录；有未保存编辑时保留原文。' }),
      validationIssueList(report, issue => { close(); hideValidationTooltip(); locateValidationIssue(issue); }),
      el('div', { class: 'foot' }, el('button', { text: '关闭', onclick: close }),
        el('button', { id: 'sendValidationRepair', class: 'primary', text: '发送以修复', onclick: async () => {
          if (S.running || S.repairSending || S.handoffBusy || lease.isHeldByOther(S.projectId)) return;
          const latest = validateWorkspace();
          if (latest.valid) return toast('格式校验已通过，无需修复');
          S.repairSending = true; updateValidationRepairButton();
          close(); hideValidationTooltip();
          if (isMobile()) setTab('chat');
          try { await send({ text: WorldValidation.repairMessage(latest), errorCount: latest.issues.length }); }
          catch (error) { toast('发送修复请求失败：' + error.message); }
          finally { S.repairSending = false; updateValidationRepairButton(); }
        } })));
    overlay.append(box); document.body.append(overlay); box.focus();
    updateValidationRepairButton();
    overlay.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Tab') {
        const buttons = [...box.querySelectorAll('button')].filter(button => !button.disabled && !button.hidden);
        if (e.shiftKey && (document.activeElement === buttons[0] || document.activeElement === box)) { e.preventDefault(); buttons.at(-1).focus(); }
        else if (!e.shiftKey && document.activeElement === buttons.at(-1)) { e.preventDefault(); buttons[0].focus(); }
      }
    });
  }
  function updateValidationRepairButton() {
    const button = $('#sendValidationRepair');
    if (!button) return;
    button.hidden = !!S.validation?.valid;
    button.disabled = !!(S.running || S.repairSending || S.lockedBy || S.handoffBusy || !cur.session() || S.validation?.valid);
    button.title = S.running || S.repairSending || S.lockedBy ? '请等待 AI 完成当前工作' : S.validation?.valid ? '格式校验已通过' : '发送错误报告，让 AI 自动修复';
  }
  function showWelcome() {
    const overlay = el('div', { class: 'overlay welcome-overlay', id: 'welcomeOverlay' });
    const content = el('div', { class: 'welcome-copy' });
    content.innerHTML = MD.render(SEED_FILES['README.md']);
    const acknowledge = el('button', { class: 'primary', text: '知道了', onclick: async () => {
      acknowledge.disabled = true;
      try { await DB.put('config', { id: 'welcomeAcknowledged', value: true }); }
      catch (error) { toast('暂时无法记录欢迎提示状态：' + error.message); }
      overlay.remove(); $('#chatInput')?.focus();
    } });
    overlay.dismissFromBack = () => acknowledge.click();
    overlay.append(el('div', { class: 'modal welcome-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '欢迎来到世界设计者' },
      el('div', { class: 'welcome-emblem', 'aria-hidden': 'true' }, worldLogo()), content,
      el('div', { class: 'foot' }, acknowledge)));
    overlay.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Tab') { e.preventDefault(); acknowledge.focus(); }
      if (e.key === 'Escape') e.preventDefault();
    });
    document.body.append(overlay); acknowledge.focus();
  }
  function setTab(tab) {
    S.tab = tab;
    const app = document.getElementById('app');
    app.setAttribute('data-tab', tab);
    for (const b of document.querySelectorAll('#tabbar button'))
      b.classList.toggle('active', b.dataset.tab === tab);
  }
  function tabButton(tab, iconName, label) {
    const b = el('button', { 'data-tab': tab, onclick: () => setTab(tab) }, icon(iconName), el('span', { text: label }));
    return b;
  }
  function renderLayout() {
    $('#app') ? null : document.body.append(el('div', { id: 'app' }));
    const app = document.getElementById('app');
    app.innerHTML = '';
    app.setAttribute('data-tab', 'chat');
    app.append(
      el('div', { id: 'sidebar' },
        el('div', { id: 'projectBar' },
          el('button', { id: 'projectBtn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: e => {
            e.stopPropagation();
            if (e.currentTarget.getAttribute('aria-expanded') === 'true') { closeCtxMenu(); return; }
            const r = e.currentTarget.getBoundingClientRect();
            showCtxMenu(r.left, r.bottom + 6, projectMenuItems(), r.width);
            e.currentTarget.setAttribute('aria-expanded', 'true');
          } },
            icon('folder', 'pf'),
            el('span', { class: 'pname', id: 'projectBtnName' }),
            el('span', { class: 'pchev', text: '▾' }))),
        el('div', { id: 'sessionList' }),
        el('div', { id: 'sidebarFooter' },
          el('button', { onclick: async () => { await newSession(); setTab('chat'); } }, icon('plus'), el('span', { text: ' 会话' })),
          el('button', { onclick: newGroup }, icon('plus'), el('span', { text: ' 分组' })))),
      el('div', { id: 'splitL', class: 'splitter', title: '拖动调整宽度（双击复位）' }),
      el('div', { id: 'main' },
        el('div', { id: 'mainHeader' },
          el('a', { class: 'page-switch', href: 'index.html', title: '切换到异闻手记', onclick: switchToGame, text: '← 异闻手记' }),
          el('div', { class: 'title workspace-heading' },
            worldLogo(), el('strong', { text: '世界设计者' }), el('span', { id: 'sessionTitle' })),
          el('span', { id: 'ctxBadge', title: '上下文占用 / 上限' }),
          el('div', { class: 'header-actions' },
            el('button', { class: 'iconbtn', id: 'compressBtn', title: '压缩上下文', onclick: ctxMenu }, icon('compress')),
            el('button', { class: 'iconbtn', title: '设置', onclick: openSettings }, icon('gear')))),
        el('div', { id: 'lockNotice' }),
        el('div', { id: 'chatScroll' }),
        el('div', { id: 'inputBar' },
          el('div', { id: 'skillPop' }),
          el('div', { id: 'goalBar', style: 'display:none' }),
          el('div', { id: 'inputRow' },
            el('div', { id: 'chatInput', contenteditable: 'true', role: 'textbox',
              'aria-multiline': 'true', 'data-placeholder': '输入消息',
              onkeydown: chatInputKeydown,
              oninput: onChatInput,
              onpaste: onChatPaste,
              onblur: () => setTimeout(() => { if (!S.skillPopHover) hideSkillPop(); }, 120) }),
            el('button', { class: 'primary', id: 'sendBtn', title: '发送', onclick: sendOrAbort }, icon('send'))))),
      el('div', { id: 'splitR', class: 'splitter', title: '拖动调整宽度（双击复位）' }),
      el('div', { id: 'filePanel', tabindex: '0', onkeydown: fmKeydown },
        el('div', { id: 'filePanelHeader' },
          el('button', { class: 'iconbtn', id: 'fmUpBtn', title: '上一级', onclick: fmGoUp }, icon('upLevel')),
          validationButton(),
          el('span', { id: 'fmPath', title: '当前目录' }),
          el('button', { class: 'iconbtn', id: 'playWorldBtn', title: '前往异闻手记试玩', 'aria-label': '前往异闻手记试玩', onclick: playWorld }, icon('gamepad')),
          el('button', { class: 'iconbtn', id: 'uploadMenuBtn', title: '上传', 'aria-haspopup': 'menu',
            'aria-expanded': 'false', onclick: showUploadMenu }, icon('upload')),
          el('button', { class: 'iconbtn', title: '下载当前目录 (zip)', onclick: () => downloadPath(S.fmRoot, { projectArchive: true }) }, icon('download'))),
        el('div', { id: 'fileTree' }),
        el('div', { id: 'reviewBar' }),
        el('div', { id: 'editorPane' },
          el('div', { id: 'editorHeader' },
            el('button', { id: 'backBtn', onclick: closeEditor }, icon('back'), el('span', { id: 'backBtnLabel', text: '返回' })),
            el('span', { class: 'path', id: 'editorPath' }),
            el('button', { id: 'previewToggle', text: '预览', onclick: toggleEditorPreview }),
            el('button', { class: 'primary', id: 'saveFileBtn', text: '保存', onclick: saveEditor })),
          el('div', { id: 'editorNotice' }),
          el('textarea', { id: 'editorText', spellcheck: 'false',
            oninput: () => { S.editorDirty = true; renderEditorStatus(); },
            onkeyup: renderEditorStatus, onclick: renderEditorStatus,
            onkeydown: editorKeydown }),
          el('div', { id: 'editorPreview' }),
          el('div', { id: 'reviewPane' }),
          el('div', { id: 'editorStatus' }))),
      el('div', { id: 'tabbar' },
        tabButton('sessions', 'list', '会话'),
        tabButton('chat', 'chat', '对话'),
        tabButton('files', 'folder', '文件')));
    setTab('chat');
    document.body.prepend(el('div', { id: 'banner', text: '⚠ 浏览器存储不可用，数据不会被保存' }));
  }

  function projectMenuItems() {
    const items = S.projects.map(p => ({
      icon: p.id === S.projectId ? 'check' : 'folder',
      label: p.name,
      action: () => {
        if (S.running) { toast('轮次进行中，不能切换项目'); return; }
        if (p.id !== S.projectId) switchProject(p.id);
      },
    }));
    items.push('-',
      { icon: 'plus', label: '新建项目…', action: newProjectFlow },
      { icon: 'pencil', label: '重命名当前项目', action: renameProjectFlow },
      { icon: 'trash', label: '删除当前项目', danger: true, action: () => deleteProject(S.projectId) });
    return items;
  }
  function renderProjectSelect() {
    const name = $('#projectBtnName');
    const p = cur.project();
    if (name) name.textContent = p ? p.name : '';
  }
  async function newProjectFlow() {
    const name = await promptDialog({ title: '新建项目', label: '项目名称', value: '新项目', okText: '创建' });
    renderProjectSelect();
    if (!name) return;
    const p = await createProject(name);
    await switchProject(p.id);
  }
  async function renameProjectFlow() {
    const p = cur.project();
    const name = await promptDialog({ title: '重命名项目', label: '项目名称', value: p.name });
    if (!name) return;
    p.name = name; await DB.put('projects', p); renderProjectSelect();
  }

  // ---------- 侧边栏（Group + Session）----------
  async function newSession() {
    const sess = { id: uid(), projectId: S.projectId, groupId: null, name: '新会话 ' + (cur.projSessions().length + 1), messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    S.sessions.push(sess); await saveSession(sess);
    S.sessionId = sess.id; S.view = 'chat'; renderAll();
  }
  async function newGroup() {
    const name = await promptDialog({ title: '新建分组', label: '分组名称', value: '新分组', okText: '创建' });
    if (!name) return;
    const g = { id: uid(), projectId: S.projectId, name, order: cur.projGroups().length, collapsed: false };
    S.groups.push(g); await DB.put('groups', g); renderSidebar();
  }
  async function renameSession(s) {
    const name = await promptDialog({ title: '重命名会话', label: '会话名称', value: s.name });
    if (!name) return;
    s.name = name; await saveSession(s); renderAll();
  }
  async function deleteSession(s) {
    if (!await confirmDialog('删除会话', `删除会话「${s.name}」？文件不受影响，但其对话记录将清除。`, true)) return;
    if (lease.isHeldByOther(s.projectId)) return toast('项目正在其他窗口执行，请先在该窗口中止任务');
    if (S.running && S.runningSession === s.id) await stopRun();
    await flushDraft();
    S.sessions = S.sessions.filter(x => x.id !== s.id);
    await DB.del('sessions', s.id);
    await DB.delMessages(s.id);           // 消息在独立表里，要一并清掉
    if (S.sessionId === s.id) S.sessionId = (cur.projSessions()[0] || {}).id || null;
    if (!S.sessionId) await newSession(); else renderAll();
  }
  async function duplicateSession(s) {
    await ensureFullHistory(s);   // 只载入了尾部时先补全，否则副本会丢掉更早的历史
    const copy = { ...structuredClone(s), id: uid(), name: s.name + ' - 副本', createdAt: Date.now(), updatedAt: Date.now() };
    copy.__savedCount = 0; copy.__dirtyAll = true; copy.__baseSeq = 0;   // 新 id，消息要整段写一份
    S.sessions.push(copy); await saveSession(copy);
    S.sessionId = copy.id; renderAll();
  }
  function sessionMenuItems(s) {
    const items = [
      { icon: 'open', label: '打开', action: () => { S.sessionId = s.id; S.view = 'chat'; renderAll(); setTab('chat'); } },
      { icon: 'pencil', label: '重命名', action: () => renameSession(s) },
      { icon: 'copy', label: '创建副本', action: () => duplicateSession(s) },
    ];
    const groups = cur.projGroups();
    if (groups.length || s.groupId) {
      items.push('-');
      for (const g of groups)
        if (g.id !== s.groupId)
          items.push({ icon: 'folder', label: '移动到「' + g.name + '」', action: async () => { s.groupId = g.id; await saveSession(s); renderSidebar(); } });
      if (s.groupId)
        items.push({ icon: 'back', label: '移出分组', action: async () => { s.groupId = null; await saveSession(s); renderSidebar(); } });
    }
    items.push('-', { icon: 'trash', label: '删除', danger: true, action: () => deleteSession(s) });
    return items;
  }
  function sessionRow(s) {
    const lockState = lease.sessionLockState(S.projectId, s.id, S.running, S.runningSession);
    const locked = lockState === 'locked-session' || lockState === 'locked-project';
    const row = el('div', { class: 'session-item' + (s.id === S.sessionId ? ' active' : '') + (locked ? ' locked' : ''), draggable: 'true',
      title: lockState === 'locked-session' ? '其他窗口运行中'
        : (lockState === 'locked-project' ? '项目被其他窗口执行' : ''),
      onclick: () => { S.sessionId = s.id; S.view = 'chat'; renderAll(); setTab('chat'); } },
      icon(lockState === 'running' ? 'chat' : (locked ? 'lock' : 'chat'), 'sicon'),
      el('span', { class: 'title', text: s.name, title: s.name }),
      el('button', { class: 'mini', title: '更多', onclick: e => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        showCtxMenu(r.left, r.bottom + 4, sessionMenuItems(s));
      } }, icon('more')));
    row.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); showCtxMenu(e.clientX, e.clientY, sessionMenuItems(s)); };
    attachLongPress(row, () => sessionMenuItems(s));
    row.addEventListener('dragstart', e => e.dataTransfer.setData('text/session', s.id));
    return row;
  }
  async function renameGroup(g) {
    const name = await promptDialog({ title: '重命名分组', label: '分组名称', value: g.name });
    if (!name) return;
    g.name = name; await DB.put('groups', g); renderSidebar();
  }
  async function deleteGroup(g) {
    if (!await confirmDialog('删除分组', `删除分组「${g.name}」？组内会话将移回未分组。`, true)) return;
    for (const s of cur.projSessions().filter(x => x.groupId === g.id)) { s.groupId = null; await saveSession(s); }
    S.groups = S.groups.filter(x => x.id !== g.id);
    await DB.del('groups', g.id); renderSidebar();
  }
  function groupMenuItems(g) {
    return [
      { icon: g.collapsed ? 'expandAll' : 'collapseAll', label: g.collapsed ? '展开' : '折叠',
        action: async () => { g.collapsed = !g.collapsed; await DB.put('groups', g); renderSidebar(); } },
      { icon: 'plus', label: '在此分组新建会话', action: async () => {
        const sess = { id: uid(), projectId: S.projectId, groupId: g.id, name: '新会话 ' + (cur.projSessions().length + 1), messages: [], createdAt: Date.now(), updatedAt: Date.now(), promptHistory: [] };
        S.sessions.push(sess); await saveSession(sess);
        S.sessionId = sess.id; S.view = 'chat'; renderAll(); setTab('chat');
      } },
      { icon: 'pencil', label: '重命名', action: () => renameGroup(g) },
      '-',
      { icon: 'trash', label: '删除分组', danger: true, action: () => deleteGroup(g) },
    ];
  }
  function renderSidebar() {
    const list = $('#sessionList');
    if (!list) return;
    list.innerHTML = '';
    const ungrouped = cur.projSessions().filter(s => !s.groupId);
    for (const s of ungrouped) list.append(sessionRow(s));
    for (const g of cur.projGroups()) {
      const header = el('div', { class: 'group-header' + (g.collapsed ? ' collapsed' : ''),
        onclick: async () => { g.collapsed = !g.collapsed; await DB.put('groups', g); renderSidebar(); } },
        el('span', { class: 'chev', text: '▾' }),
        el('span', { class: 'grow', text: g.name }),
        el('button', { class: 'mini', style: 'visibility:visible', title: '更多', onclick: e => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          showCtxMenu(r.left, r.bottom + 4, groupMenuItems(g));
        } }, icon('more')));
      header.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); showCtxMenu(e.clientX, e.clientY, groupMenuItems(g)); };
      attachLongPress(header, () => groupMenuItems(g));
      header.addEventListener('dragover', e => e.preventDefault());
      header.addEventListener('drop', async e => {
        const sid = e.dataTransfer.getData('text/session');
        const s = S.sessions.find(x => x.id === sid);
        if (s) { s.groupId = g.id; await saveSession(s); renderSidebar(); }
      });
      list.append(header);
      if (!g.collapsed) for (const s of cur.projSessions().filter(x => x.groupId === g.id)) list.append(sessionRow(s));
    }
    // 空白处右键：新建会话/分组
    list.oncontextmenu = e => {
      if (e.target !== list) return;
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, [
        { icon: 'plus', label: '新建会话', action: async () => { await newSession(); setTab('chat'); } },
        { icon: 'folderPlus', label: '新建分组', action: newGroup },
      ]);
    };
    // 拖到列表空白处 = 移出分组
    list.addEventListener('dragover', e => e.preventDefault());
    list.addEventListener('drop', async e => {
      if (e.target !== list) return;
      const sid = e.dataTransfer.getData('text/session');
      const s = S.sessions.find(x => x.id === sid);
      if (s && s.groupId) { s.groupId = null; await saveSession(s); renderSidebar(); }
    });
  }

  function renderAll() {
    const sess0 = cur.session();
    // 目标与输入草稿都随会话走：切到别的会话要换成那边的
    // （运行中不动目标，否则会打断正在跑的循环；草稿照常切换）
    const switched = !S.goalOwner || S.goalOwner !== (sess0 && sess0.id);
    if (!S.running && switched) {
      S.goalOwner = sess0 && sess0.id;
      loadGoal(sess0);
    }
    if (switched) swapDraft(sess0);
    renderProjectSelect(); renderSidebar(); renderChat(); renderFileTree(); renderCtxBadge(); renderLockNotice();
    renderGoalBar();
    const t = $('#sessionTitle'); const sess = cur.session();
    if (t) t.textContent = sess ? sess.name : '';
    const inEditor = S.view === 'editor';
    const pos = editorPosition();
    $('#editorPane').style.display = inEditor ? 'flex' : 'none';
    // 编辑器占用哪一栏，该栏原内容就让位；其余栏始终照常显示
    const covered = pos !== 'float' && inEditor;
    $('#chatScroll').style.display = (covered && pos === 'center') ? 'none' : 'block';
    $('#inputBar').style.display = (covered && pos === 'center') ? 'none' : 'flex';
    const revealFiles = S.validationReveal && S.editorDirty && covered && pos === 'right';
    const validationButtonEl = $('#worldValidationBtn');
    validationButtonEl.style.display = covered && pos === 'right' ? 'none' : '';
    if (covered && pos === 'right') hideValidationTooltip();
    $('#filePanel').classList.toggle('validation-reveal', !!revealFiles);
    $('#fileTree').style.display = (covered && pos === 'right' && !revealFiles) ? 'none' : 'block';
    $('#filePanelHeader').style.display = (covered && pos === 'right' && !revealFiles) ? 'none' : 'flex';
    $('#sessionList').style.display = (covered && pos === 'left') ? 'none' : 'block';
    $('#projectBar').style.display = (covered && pos === 'left') ? 'none' : 'flex';
    $('#sidebarFooter').style.display = (covered && pos === 'left') ? 'none' : 'flex';
  }

  // ---------- 启动 ----------
  // ---------- 启动遮罩 ----------
  // 遮罩由 HTML 直接给出，脚本执行期间就可见；这里只负责推进与收尾。
  function bootStep(text, pct) {
    const s = $('#bootStep'), b = $('#bootBar');
    if (s && text) s.textContent = text;
    if (b && pct != null) b.style.width = pct + '%';
  }
  function bootDone(err) {
    const boot = $('#boot');
    if (!boot) return;
    if (err) {
      // 启动失败就把遮罩留在原地当错误页，避免用户面对一个半死的界面
      bootStep('启动失败：' + err, 100);
      const s = $('#bootStep');
      if (s) s.classList.add('err');
      return;
    }
    bootStep('就绪', 100);
    boot.classList.add('hide');
    setTimeout(() => boot.remove(), 320);
  }

  async function init() {
    try {
      bootStep('初始化界面…', 8);
      renderLayout();
      setupPanelDrop();
      setupSplitters();
      setupFloatingEditor();
      bootStep('打开本地数据库…', 20);
      await DB.open();
      await sweepStoredTmp();
      if (DB.isMemoryMode()) {
        $('#banner').textContent = '⚠ 浏览器存储不可用，数据不会被保存（多标签保护已关闭）';
        $('#banner').style.display = 'block';
      } else if (!lease.available) {
        $('#banner').textContent = '⚠ 多标签保护已降级（localStorage 不可用），请避免同时多开同项目';
        $('#banner').style.display = 'block';
      }
      const settingsRec = await DB.get('config', 'settings');
      if (settingsRec) S.settings = { ...DEFAULT_SETTINGS, ...settingsRec.value };
      const hadAppearanceSettings = Object.hasOwn(S.settings, 'agentName') || Object.hasOwn(S.settings, 'agentAvatar');
      delete S.settings.agentName;
      delete S.settings.agentAvatar;
      if (hadAppearanceSettings) await DB.put('config', { id: 'settings', value: S.settings });
      if (S.settings.model === 'deepseek-v4-flash') S.settings.model = DEFAULT_SETTINGS.model;
      applyPanes();                          // 恢复上次的三栏宽度
      applyEditorPosition({ silent: true }); // 此刻项目未加载，只挂 DOM 不渲染
      bootStep('读取会话与项目…', 40);
      S.projects = await DB.all('projects');
      S.sessions = await loadSessions();
      S.groups = await DB.all('groups');
      // Legacy imported skills remain stored, but this page exposes only its four resources.
      const disabledRec = await DB.get('config', 'disabledSkills');
      if (disabledRec && Array.isArray(disabledRec.value)) S.disabledSkills = new Set(disabledRec.value);
      if ([...S.disabledSkills].some(name => DesignerResources.isRequired(name))) await saveDisabledSkills();
      bootStep('加载 Skill…', 62);
      await loadExternalSkills();   // 必须在 switchProject 之前：挂载 Skill 附件要用到
      bootStep('准备工作区…', 85);
      if (!S.projects.length) await createProject('默认项目');
      const last = await DB.get('config', 'lastProject');
      const requested = new URLSearchParams(location.hash.slice(1)).get('project');
      const target = S.projects.some(p => p.id === requested) ? requested
        : (last && S.projects.some(p => p.id === last.value)) ? last.value : S.projects[0].id;
      await switchProject(target);
      if (requested) history.replaceState(history.state, '', location.pathname + location.search);
      reconcileLease();
      startLeasePoll();
      setInterval(() => {
        if (!S.running) ageTmpFiles(new Set(), false).catch(e => toast('临时文件清理失败：' + e.message));
      }, 60000);
      window.addEventListener('beforeunload', () => {
        if (S.running) lease.releaseLease(S.projectId);
      });
      initBackButton();             // 布防系统返回键（套壳 WebView 里的唯一后退入口）
      if (!(await DB.get('config', 'welcomeAcknowledged'))?.value) showWelcome();
      bootDone();
    } catch (e) {
      bootDone(e && e.message ? e.message : String(e));
      throw e;                      // 仍抛出，便于控制台看到完整堆栈
    }
  }
  // 只加载本页资源目录或本页内嵌快照，禁止读站点根目录的技能清单。
  async function loadExternalSkills() {
    try {
      const rep = await DesignerResources.load({ href: location.href,
        fetchFn: typeof fetch === 'function' ? fetch : null, snapshot: BUNDLED_SKILLS,
        standalone: WORLD_DESIGNER_STANDALONE });
      S.externalSkills = rep.skills;
      S.skillLoad = rep;
      if (rep.errors.length) toast('Skill 加载有 ' + rep.errors.length + ' 项失败，详见设置→Skill');
    } catch (e) {
      S.skillLoad = { available: false, warnings: [], errors: ['加载异常: ' + e.message], origin: 'bundled' };
    }
  }

  // 重新拉取外部 Skill 并重新挂载到当前项目（设置面板中的「重新加载」）
  async function reloadExternalSkills() {
    await loadExternalSkills();
    if (S.tree) {
      const skills = VFS.resolve(S.tree, ['skills']);
      if (skills) skills.children = {};      // 清掉旧挂载，避免删除后残留
      mountSkillFiles(S.tree);
      await saveTree();
      renderFileTree();
    }
  }

  window.addEventListener('DOMContentLoaded', init);
  // 兜底：init 若因未捕获的异常卡住，20 秒后也要让用户能看到界面而非空白遮罩
  setTimeout(() => {
    const boot = $('#boot');
    if (boot && !boot.classList.contains('hide')) {
      bootStep('启动较慢，已进入界面（部分数据可能未就绪）', 100);
      boot.classList.add('hide');
      setTimeout(() => boot.remove(), 320);
    }
  }, 20000);

  // 用户气泡：超长内容默认折叠，只显示前 N 字
  function userBubble(m) {
    // 超长输入的气泡显示用户原文，而非注入给 AI 的折叠模板
    const full = m.displayContent !== undefined ? m.displayContent : Tokens.contentText(m.content);
    if (m.validationReport) {
      const key = 'validation-report:' + m.msgId;
      const capsule = el('details', { class: 'validation-report', open: S.openTools.has(key) },
        el('summary', {}, el('span', { class: 'validation-report-label', text: '错误报告' }),
          el('small', { text: m.validationReport.count + ' 项 · 自动修复' })),
        el('pre', { text: full }));
      capsule.addEventListener('toggle', () => {
        if (capsule.isConnected) { if (capsule.open) S.openTools.add(key); else S.openTools.delete(key); }
      });
      return capsule;
    }
    const foldable = full.length > AGENT_CONFIG.bubbleFoldChars;
    const bubble = el('div', { class: 'bubble' });
    const images = (m.attachments || []).map(ref => {
      const node = Images.resolve(S.tree, ref.path);
      return node?.image ? el('img', { class: 'message-image', src: node.image.dataUrl, alt: '用户发送的图片', title: ref.path })
        : el('div', { class: 'expired-image', text: (node ? '图片暂时无法预览 · ' : '图片已过期或已删除 · ') + (ref.name || ref.path.split('/').pop()) });
    });
    if (!m.attachments) for (const src of Tokens.contentImages(m.content))
      images.push(el('img', { class: 'message-image', src, alt: '用户发送的图片' }));
    if (!foldable) { bubble.append(document.createTextNode(full), ...images); return bubble; }
    const preview = full.slice(0, AGENT_CONFIG.bubblePreviewChars);
    const body = el('span', { text: preview + '…' });
    const btn = el('button', { class: 'fold-btn', text: `展开全部（${full.length} 字）` });
    let open = false;
    btn.onclick = e => {
      e.stopPropagation();
      open = !open;
      body.textContent = open ? full : preview + '…';
      btn.textContent = open ? '收起' : `展开全部（${full.length} 字）`;
    };
    bubble.append(body, el('br'), btn, ...images);
    return bubble;
  }

  // ---------- 对话渲染 ----------
  // 流式期间只在用户贴着底部时自动跟随；上翻查看历史时不打断
  // ---------- 对话渲染：窗口化 + 向上翻页 ----------
  // 长会话（含被压缩折叠的历史）一次性全渲染会卡顿。数据都在 IndexedDB/内存里，
  // DOM 才是贵的——所以只渲染最近一窗消息，滚到顶部再往前扩一批。
  const CHAT_PAGE = 60;            // 每批渲染的消息条数
  const CHAT_TOP_THRESHOLD = 80;   // 距顶部多少 px 触发加载上一批
  const CHAT_STICK_PX = 2;         // 仅容忍滚动像素取整误差
  function chatWindowStart(sess) {
    // 每个会话记住自己的窗口起点：切走再切回、以及翻页后重绘都不该丢失位置
    if (S.chatFrom == null || S.chatFromSession !== sess.id) {
      S.chatFromSession = sess.id;
      S.chatFrom = Math.max(0, sess.messages.length - CHAT_PAGE);
      S.stickToBottom = true;   // 刚进入会话总是从底部（最新处）看起
    }
    // 删除/撤回后消息变少，起点可能越界；新消息追加时起点不动（只是显示得更多）
    S.chatFrom = Math.max(0, Math.min(S.chatFrom, sess.messages.length));
    return S.chatFrom;
  }
  async function loadEarlierMessages() {
    const sess = cur.session();
    const box = $('#chatScroll');
    if (!sess || !box) return;
    const base = sess.__baseSeq || 0;
    if (S.chatFrom <= 0 && base <= 0) return;
    // 记录扩窗前的滚动锚点：加载完成后把视口固定在原位置，不跳动
    const prevHeight = box.scrollHeight;
    const prevTop = box.scrollTop;
    if (S.chatFrom <= 0 && base > 0) {
      // 内存里的都画完了，从库里补读更早的一批（多为被折叠的原文）
      const from = Math.max(0, base - CHAT_PAGE);
      const older = await DB.getMessagesRange(sess.id, from, base);
      // 等待期间可能已被 ensureFullHistory 补过（压缩、复制会话都会触发），
      // 此时 __baseSeq 已经变了，再插一次就会重复
      if ((sess.__baseSeq || 0) !== base) return;
      prependHistory(sess, older, from);   // 内部会把窗口起点一并右移
    }
    S.chatFrom = Math.max(0, S.chatFrom - CHAT_PAGE);
    renderChat({ keepScroll: true });
    // 新内容插在上方，高度差就是需要补偿的滚动量
    box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
  }
  function watchChatScroll() {
    const box = $('#chatScroll');
    if (!box || box.dataset.scrollWatched) return;
    box.dataset.scrollWatched = '1';
    let dragging = false, touchY = null;
    const atBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight <= CHAT_STICK_PX;
    box.addEventListener('wheel', event => { if (event.deltaY < 0) S.stickToBottom = false; }, { passive: true });
    box.addEventListener('pointerdown', event => {
      if (event.target.closest('button,input,textarea,select')) return;
      dragging = true; S.stickToBottom = false;
    });
    const endDrag = () => { if (dragging) { dragging = false; S.stickToBottom = atBottom(); } };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    box.addEventListener('touchstart', event => { touchY = event.touches[0]?.clientY; }, { passive: true });
    box.addEventListener('touchmove', event => {
      const next = event.touches[0]?.clientY;
      if (touchY != null && next > touchY) S.stickToBottom = false;
      touchY = next;
    }, { passive: true });
    box.addEventListener('keydown', event => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) && !event.target.closest('input,textarea')) S.stickToBottom = false;
    });
    box.addEventListener('scroll', () => {
      // 视口底边到内容底边的距离。这是唯一量像素的地方——用户滚动时本来就在布局，
      // 量完把结论存进 stickToBottom，后续渲染直接读，不再回流。
      S.stickToBottom = !dragging && atBottom();
      // 滚到顶部附近：自动加载更早的一批（内存或库里有更早的才加载）
      const sess = cur.session();
      const more = S.chatFrom > 0 || (sess && (sess.__baseSeq || 0) > 0);
      if (box.scrollTop < CHAT_TOP_THRESHOLD && more && !S.chatLoadingEarlier) {
        S.chatLoadingEarlier = true;
        // 补读可能走异步的库查询，等它落定再解锁，避免高频 scroll 连续触发
        loadEarlierMessages().finally(() => {
          setTimeout(() => { S.chatLoadingEarlier = false; }, 120);
        });
      }
    }, { passive: true });
  }
  // 渲染只读取跟随状态；用户上翻或开始拖动时立即暂停，不等下一帧 scroll 事件。
  function stickingToBottom() { return S.stickToBottom !== false; }
  function pauseChatFollowIfMoved() {
    const box = $('#chatScroll');
    if (stickingToBottom() && box?.clientHeight && box.scrollHeight - box.scrollTop - box.clientHeight > CHAT_STICK_PX)
      S.stickToBottom = false;
  }
  function renderChat(opts) {
    const box = $('#chatScroll');
    if (!box) return;
    watchChatScroll();
    const sess = cur.session();
    if (!sess) { box.innerHTML = ''; return; }
    const proj = cur.project();
    const entering = S.chatFromSession !== sess.id;
    const from = chatWindowStart(sess);   // 先算窗口：切会话时它会把跟随态重置为贴底
    if (!entering && !opts?.follow) pauseChatFollowIfMoved();
    // 用户停在上方看历史时，重绘不能让画面跳：记下锚点，画完还原。
    // 只在「不跟随」时做——贴底的场景本来就要去底部，锚点无意义。
    const keep = (opts && opts.keepScroll) || !stickingToBottom();
    const prevTop = keep ? box.scrollTop : 0;
    box.innerHTML = '';
    // 顶部指示条：还有更早的消息没渲染（含仍留在库里未载入的部分，滚上来会自动加载）
    const earlier = from + (sess.__baseSeq || 0);
    if (earlier > 0) {
      box.append(el('div', { class: 'chat-earlier', text: '↑ 还有 ' + earlier + ' 条更早的消息，向上滚动加载' }));
    }
    sess.messages.forEach((m, idx) => {
      if (idx < from) return;                      // 窗口之外：数据还在，只是不渲染
      const before = box.childElementCount;
      renderOneMessage(m, idx, box, sess, proj);
      // 被折叠的历史统一弱化：内容仍可读，但一眼能看出它不在上下文里
      if (m.displayOnly)
        for (let i = before; i < box.childElementCount; i++) box.children[i].classList.add('folded');
    });
    if (sess.contextInterrupted && !(S.running && S.runningSession === sess.id)) {
      box.append(el('div', { class: 'error-card' },
        el('div', { text: sess.contextInterrupted.message }),
        el('button', { text: '压缩上下文', disabled: S.continuing || sess.contextInterrupted.compressed, onclick: ctxMenu }),
        el('button', { class: 'primary', text: '继续', disabled: S.continuing, onclick: () => continueInterrupted(sess) })));
    } else if (S.lastError && S.lastError.sessionId === sess.id) {
      box.append(el('div', { class: 'error-card' },
        el('div', { text: S.lastError.message }),
        el('button', { text: S.lastError.actionLabel || '重试', onclick: S.lastError.retry })));
    }
    // 收起的提问停在对话末尾等待作答（Agent 仍挂起）
    if (S.pendingAsk && S.pendingAsk.minimized && S.pendingAsk.sessionId === sess.id)
      box.append(askInlineCard(S.pendingAsk));
    restoreStreamBubble();     // 切回正在输出的会话时补画流式内容
    renderActiveTool();        // 工具执行中的占位卡片（内部会兜底调 renderBusyIndicator）
    // 贴底才自动滚到底；用户在上方看历史时原样还原锚点——
    // 新消息只会追加在视口下方，上方内容的偏移不变，还原 scrollTop 就是原画面。
    // （窗口起点 chatFrom 在同一会话内只会向上扩、不会收缩，见 chatWindowStart，
    //   所以用户正在看的区域不会被卸载，锚点不会失效。）
    if (!keep) box.scrollTop = box.scrollHeight;
    else if (!(opts && opts.keepScroll)) box.scrollTop = prevTop;
    // 向上翻页（keepScroll）的滚动补偿由调用方 loadEarlierMessages 处理
  }
  // 渲染单条消息（含其后可能跟随的快照回滚条）
  function renderOneMessage(m, idx, box, sess, proj) {
      if (m.role === 'user') {
        // 目标推进消息：用户没打过这段字，显示为特殊气泡而非注入原文
        if (m.goalPush) {
          box.append(el('div', { class: 'goal-push' },
            icon('target', 'gp-icon'), el('span', { text: '继续推进目标' })));
          return;
        }
        // 设立/修改目标：显示目标本身，不显示包裹它的注入模板
        if (m.goalSet) {
          box.append(el('div', { class: 'msg user' },
            el('div', { class: 'body' },
              el('div', { class: 'bubble goal-set-bubble' },
                el('span', { class: 'gs-head' }, icon('target', 'gs-icon'),
                  el('span', { text: m.goalSet === 'change' ? '修改了目标' : '设立了目标' })),
                el('span', { class: 'gs-text', text: m.goalText || '' })),
              el('div', { class: 'actions' },
                el('button', { text: '删除', title: '仅删除本轮问答，不影响后续对话与文件', onclick: () => deleteTurn(idx) }),
                el('button', { text: '撤回', title: '回退聊天记录到本轮之前', onclick: () => retractChat(idx) })))));
          return;
        }
        box.append(el('div', { class: 'msg user' },
          el('div', { class: 'body' },
            userBubble(m),
            el('div', { class: 'actions' },
              el('button', { text: '删除', title: '仅删除本轮问答，不影响后续对话与文件', onclick: () => deleteTurn(idx) }),
              el('button', { text: '撤回', title: '回退聊天记录到本轮之前（删除本轮及其后全部消息），提示词会放回输入框', onclick: () => retractChat(idx) })))));
      } else if (m.role === 'assistant') {
        const body = el('div', { class: 'body' });
        // 思考过程排在正文之前：模型就是先想后说的，顺序反过来读着别扭。
        // 设为「总是隐藏」时 thinkCard 返回 null，这里跳过（append(null) 会插入字符串 "null"）
        const think = msgReasoning(m);
        if (think) {
          const tc = thinkCard(think, { key: sess.id + ':' + (idx + (sess.__baseSeq || 0)) });
          if (tc) body.append(tc);
        }
        if (m.content) {
          const bubble = el('div', { class: 'bubble' });
          bubble.innerHTML = MD.render(m.content);
          body.append(bubble);
        }
        for (const tc of m.tool_calls || []) {
          const tmsg = findToolMsg(sess.messages, idx, tc.id);
          const result = tmsg ? tmsg.content : null;
          const isErr = result && /^错误/.test(result);
          // 文件变更类工具渲染成带增删统计的 diff 卡片，其余保持原始输出
          if (!isErr && tmsg && tmsg.change) { body.append(changeCard(tmsg.change, tc.id)); continue; }
          // 激活 Skill：只显示已激活的标记，不把整篇指令正文摊给用户看
          if (!isErr && tc.function.name === 'run_skill') { body.append(skillCard(tc)); continue; }
          // 提问：展示问答本身，而非工具协议原文
          if (!isErr && tc.function.name === 'ask_user') { body.append(askCard(tc, result)); continue; }
          // 目标操作：显示设立/修改/结束，而非工具 JSON
          if (tc.function.name === 'goal') { body.append(goalCard(tc, result, isErr)); continue; }
          // 读取 Skill 目录下的文件：与激活 Skill 同样处理，不把参考资料摊给用户
          if (!isErr && isSkillRead(tc)) { body.append(skillReadCard(tc)); continue; }
          // 展开状态记在 S.openTools 里：renderChat 会整块重建 DOM，
          // 不记就会「AI 一说话，我展开的卡片全合上了」。
          const d = el('details', { class: 'tool-card' + (isErr ? ' error' : '') });
          if (S.openTools.has(tc.id)) d.open = true;
          d.addEventListener('toggle', () => {
            if (d.open) S.openTools.add(tc.id); else S.openTools.delete(tc.id);
          });
          d.append(
            el('summary', { text: tc.function.name + ' ' + toolBrief(tc) }),
            el('pre', { text: (result || '(无结果)').slice(0, 2000) }));
          body.append(d);
        }
        if (body.children.length)
          box.append(el('div', { class: 'msg' }, avatarEl(), body));
      } else if (m.role === 'compressed') {
        // 压缩内容是发给模型续接用的，对用户是故意隐藏的——不展示具体压缩了什么，
        // 只标一个数量。旧标记一旦被更新的压缩取代就是 displayOnly，不再单独占一条分隔线，
        // 保证任意时刻最多只显示一条「已压缩」标记。
        if (m.displayOnly) return;
        box.append(el('div', { class: 'compress-mark', title: '更早的历史已被总结进摘要注入上下文，不再单独发送',
          text: '⎐ 上方 ' + m.count + ' 条已折叠，不再发送' }));
      } else if (m.role === 'system-error') {
        // 系统错误：本地可见、不入上下文、可关闭
        box.append(el('div', { class: 'sys-error' },
          el('div', { class: 'se-main' },
            el('span', { class: 'se-badge', text: '系统' }),
            el('span', { class: 'se-text', text: m.content }),
            el('button', { class: 'se-close', title: '关闭这条提示', text: '✕', onclick: () => dismissSystemError(idx) })),
          m.hint ? el('div', { class: 'se-hint', text: m.hint }) : null));
      }
      // 轮次末尾的快照回滚条：该 user 消息索引有快照时显示。
      // 下标要还原成库内绝对序号——只载入尾部时内存下标是偏移过的
      if (m.role === 'user' && !proj.historyLocked) {
        const snap = S.snapshots && Versioning.findSnapshotForTurn(
          S.snapshots, sess.id, idx + (sess.__baseSeq || 0), m.msgId);
        if (snap) { const b = el('button', { title: '把工作目录的文件回滚到本轮开始之前的状态' }, icon('undo'), el('span', { text: ' 工作目录回滚到此轮之前' }));
          b.onclick = () => rollbackTo(snap.id);
          box.append(el('div', { class: 'snapshot-bar' }, b)); }
      }
  }
  // 「还轮不到你说话」的指示器。判据就是本会话正在跑——
  // 请求往返、工具执行、目标推进之间的空档都该显示，用户才知道是在等而不是卡住了。
  // 中止或刷新后 S.running 为假，指示器自然消失。
  function renderBusyIndicator(box) {
    const old = box.querySelector('#busyRow');
    if (old) old.remove();
    if (!(S.running && S.runningSession === S.sessionId)) return;
    // 正在流式吐字或吐思考时，气泡/思考卡本身就是进度反馈，不必再挂一个圈。
    // 思考设为隐藏时它不算反馈——那时屏幕上什么都没有，加载圈才是唯一的提示
    const thinkVisible = S.reasonBuf && S.settings.reasoningDisplay !== 'hidden';
    if ($('#streamMsg') && (S.streamBuf || thinkVisible)) return;
    // 等用户回答提问时，主动权在用户手里，不算「等 AI」
    if (S.pendingAsk) return;
    // 工具执行中已有专门的占位卡片，那张卡自带加载圈
    if (S.activeTool) return;
    box.append(el('div', { class: 'busy-row', id: 'busyRow' },
      el('span', { class: 'spinner' }),
      el('span', { class: 'busy-text', text: '处理中…' })));
  }

  // 工具执行中的占位卡片：只报告在做什么，不显示结果（还没有）。
  // 措辞与完成后的卡片对应，这样卡片"变身"时视觉上是连续的。
  const TOOL_BUSY_LABEL = {
    read_file: '正在读取', view_image: '正在查看图片', write_file: '正在写入', apply_patch: '正在修改',
    list_dir: '正在查看目录', search: '正在搜索', delete: '正在删除',
    move: '正在移动', copy: '正在复制', run_skill: '正在加载 Skill',
    goal: '正在更新目标', ask_user: '等待你的回答',
  };
  // 参数还在流式生成时是残缺 JSON，正则捞出已经完整的那部分字段即可。
  // 捞不到就只显示工具名——总好过一片空白。
  function partialArgBrief(argsStr) {
    const s = String(argsStr || '');
    const m = s.match(/"(?:path|from|pattern|name)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) return '';
    try { return displayPath(JSON.parse('"' + m[1] + '"')); } catch (_) { return displayPath(m[1]); }
  }
  // 已经流进来多少参数——长内容写文件时给个进度感
  function argProgress(argsStr) {
    const n = String(argsStr || '').length;
    return n > 200 ? fmtNum(n) + ' 字符' : '';
  }
  function activeToolCard(tc, streaming) {
    const name = tc.function.name;
    // Skill 相关的调用沿用各自的卡片语言，不暴露工具协议细节
    if (name === 'run_skill' || (!streaming && isSkillRead(tc))) {
      const card = el('div', { class: 'skill-card reading busy' },
        el('span', { class: 'spinner' }),
        el('span', { class: 'sc-label', text: name === 'run_skill' ? '正在加载 Skill' : '正在阅读 Skill 资料' }),
        el('span', { class: 'sc-name' }));
      updateToolCard(card, tc, streaming);
      return card;
    }
    const card = el('div', { class: 'tool-busy' },
      el('span', { class: 'spinner' }),
      el('span', { class: 'tb-label', text: TOOL_BUSY_LABEL[name] || '处理中' }),
      el('span', { class: 'tb-target' }),
      el('span', { class: 'tb-prog' }));
    updateToolCard(card, tc, streaming);
    return card;
  }
  // 只改文字，不动节点。参数流式增长时每秒会刷新几十次，
  // 若整卡重建，spinner 的 CSS 动画每次都从 0 度重来，看上去就是在原地抖。
  function updateToolCard(card, tc, streaming) {
    const brief = streaming ? partialArgBrief(tc.function.arguments)
                            : toolBrief(tc).replace(/^·\s*/, '');
    const nameEl = card.querySelector('.sc-name');
    if (nameEl) { setTextIfChanged(nameEl, brief); return; }
    const target = card.querySelector('.tb-target');
    const prog = card.querySelector('.tb-prog');
    setTextIfChanged(target, brief);
    setTextIfChanged(prog, streaming ? argProgress(tc.function.arguments) : '');
    target.style.display = brief ? '' : 'none';
    prog.style.display = prog.textContent ? '' : 'none';
  }
  function setTextIfChanged(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }
  // 当前该显示哪张占位卡：返回 [{tc, streaming}]，没有则 null
  function activeToolList() {
    if (S.sessionId !== S.runningSession) return null;
    // 执行中优先于生成中：同一个工具走到后一阶段时替换掉前一张卡
    if (S.activeTool && S.activeTool.function.name !== 'ask_user')
      return [{ tc: S.activeTool, streaming: false }];
    if (!S.activeTool && S.streamingTools && S.streamingTools.length) {
      const list = S.streamingTools.filter(t => t.function && t.function.name)
        .map(t => ({ tc: t, streaming: true }));
      return list.length ? list : null;
    }
    return null;
  }
  // 卡片身份：工具名 + 阶段。身份不变就复用节点，只更新文字，
  // 这样 spinner 能连续转完整圈；身份变了才重建。
  const toolCardKey = list => list.map(x => x.tc.function.name + '/' + (x.streaming ? 's' : 'x')).join(',');
  // 占位卡片挂在对话末尾。两种来源：
  //   streamingTools —— 模型正在逐字生成参数（这段最久，几秒到十几秒）
  //   activeTool     —— 参数收齐、工具正在执行（本地 VFS 通常瞬时）
  function renderActiveTool() {
    const box = $('#chatScroll');
    if (!box) return;
    const list = activeToolList();
    let row = box.querySelector('#activeToolRow');
    if (!list) {
      if (row) row.remove();
      renderBusyIndicator(box);
      return;
    }
    const busy = box.querySelector('#busyRow');
    if (busy) busy.remove();
    const key = toolCardKey(list);
    // 同一批工具还在同一阶段：原地更新，节点和动画都不动
    if (row && row.dataset.key === key && row === box.lastElementChild) {
      const cards = row.querySelectorAll('.tool-busy, .skill-card.busy');
      if (cards.length === list.length) {
        list.forEach((x, i) => updateToolCard(cards[i], x.tc, x.streaming));
        if (stickingToBottom()) box.scrollTop = box.scrollHeight;
        return;
      }
    }
    if (row) row.remove();
    const body = el('div', { class: 'body' });
    for (const x of list) body.append(activeToolCard(x.tc, x.streaming));
    row = el('div', { class: 'msg', id: 'activeToolRow' }, avatarEl(), body);
    row.dataset.key = key;
    box.append(row);
    if (stickingToBottom()) box.scrollTop = box.scrollHeight;
  }
  // 目标操作卡片：设立 / 修改 / 结束，都是模型自己的决定，用户只需知道发生了什么
  const GOAL_END_LABEL = { finished: '目标已完成', break: '需要你介入' };
  function goalCard(tc, result, isErr) {
    let a = {};
    try { a = JSON.parse(tc.function.arguments || '{}'); } catch (_) { /* 参数损坏时留空 */ }
    if (isErr) {
      return el('div', { class: 'goal-card error' }, icon('target', 'gc-icon'),
        el('span', { class: 'gc-label', text: '目标操作未生效' }),
        el('span', { class: 'gc-text', text: String(result || '').replace(/^错误:\s*/, '') }));
    }
    const act = a.action;
    if (act === 'end') {
      const fin = a.reason === 'finished';
      return el('div', { class: 'goal-card ' + (fin ? 'done' : 'break') },
        icon(fin ? 'check' : 'help', 'gc-icon'),
        el('span', { class: 'gc-label', text: GOAL_END_LABEL[a.reason] || '目标结束' }));
    }
    return el('div', { class: 'goal-card' }, icon('target', 'gc-icon'),
      el('span', { class: 'gc-label', text: act === 'change' ? '已修改目标' : '已设立目标' }),
      el('span', { class: 'gc-text', title: a.content || '', text: a.content || '' }));
  }

  // 激活 Skill 的卡片：只告知「已激活哪个 Skill」，正文是给模型看的，不摊给用户
  // 提问卡片：显示问了什么、用户答了什么，而不是工具调用的原始 JSON
  function askCard(tc, result) {
    let qs = [];
    try { qs = Agent.normalizeQuestions(JSON.parse(tc.function.arguments || '{}').questions); }
    catch (_) { /* 参数损坏则只显示回答 */ }
    const card = el('div', { class: 'ask-card' });
    card.append(el('div', { class: 'ask-card-head' }, icon('help', 'ac-icon'), el('span', { text: '向你提问' })));
    for (const q of qs) card.append(el('div', { class: 'ask-card-q', text: q.question }));
    if (result) {
      // 回执文本形如「问：…\n答：…」，只摘出答案部分展示
      const answers = String(result).split('\n').filter(l => l.startsWith('答：')).map(l => l.slice(2));
      if (answers.length) card.append(el('div', { class: 'ask-card-a', text: '你的回答：' + answers.join(' / ') }));
      else card.append(el('div', { class: 'ask-card-a muted', text: String(result).slice(0, 80) }));
    } else {
      card.append(el('div', { class: 'ask-card-a muted', text: '等待回答…' }));
    }
    return card;
  }

  // 判定：这次工具调用是否在读 /skills/ 下的内容（Skill 自带的参考资料）
  const SKILL_READ_TOOLS = new Set(['read_file', 'list_dir', 'search']);
  function isSkillRead(tc) {
    if (!SKILL_READ_TOOLS.has(tc.function.name)) return false;
    try {
      const a = JSON.parse(tc.function.arguments || '{}');
      const p = a.path || '';
      return typeof p === 'string' && /^\/?skills(\/|$)/.test(p.replace(/^\.?\//, '/'));
    } catch (_) { return false; }
  }
  // 读取 Skill 资料的卡片：只报告在读什么，内容不可展开
  function skillReadCard(tc) {
    let path = '';
    try { path = JSON.parse(tc.function.arguments || '{}').path || ''; } catch (_) { /* 参数损坏时留空 */ }
    // /skills/<name>/... → 取出 Skill 名与相对路径，便于阅读
    const m = String(path).replace(/^\.?\//, '/').match(/^\/skills\/([^/]+)(?:\/(.*))?$/);
    const skill = m ? m[1] : '';
    const rel = m && m[2] ? m[2] : '';
    return el('div', { class: 'skill-card reading', title: path },
      icon('doc', 'sc-icon'),
      el('span', { class: 'sc-label', text: '正在阅读 Skill 资料' }),
      el('span', { class: 'sc-name', text: skill ? (rel ? skill + ' · ' + rel : skill) : 'skills' }));
  }

  function skillCard(tc) {
    let name = '';
    try { name = JSON.parse(tc.function.arguments || '{}').name || ''; } catch (_) { /* 参数损坏时留空 */ }
    const sk = cur.allSkills().find(x => x.name === name);
    return el('div', { class: 'skill-card', title: sk ? sk.description : '' },
      icon('check', 'sc-icon'),
      el('span', { class: 'sc-label', text: '已激活 Skill' }),
      el('span', { class: 'sc-name', text: name || '(未知)' }));
  }

  /* ---------- 思考子气泡 ----------
     模型的思考过程（reasoning_content）折叠在正文气泡上方的小卡片里。
     设置四档：
       collapsed       思考时展开直播，正文一开始吐字或开始调工具就立即折起（默认）
       alwaysCollapsed 全程折叠，思考中也只有一行标题，点开才看
       expanded        始终展开
       hidden          完全不显示——返回 null，由调用方跳过，界面与没有思考功能时一样
     展开判定优先级：用户在本条上手动开/合过 → 听用户的；否则听设置；
     其中 collapsed 档在「思考直播中」（o.live 且正文尚未开始）额外强制展开。
     opts.key 用于跨重绘记忆手动开合（renderChat 每次整块重建 DOM）。 */
  // 取一条消息的思考文本。规范字段是 reasoning_content（随消息落库并回传 API）；
  // reasoning 是早期版本落库用过的名字，老会话里可能还有，只读不再写。
  function msgReasoning(m) {
    return m.reasoning_content || m.reasoning || '';
  }
  function thinkCard(text, opts) {
    const o = opts || {};
    const mode = S.settings.reasoningDisplay;
    if (mode === 'hidden') return null;
    const d = el('details', { class: 'think-card' });
    const key = o.key ? 'think:' + o.key : null;
    let want;
    if (key && S.openTools.has(key)) want = true;              // 用户手动展开过
    else if (key && S.openTools.has(key + ':closed')) want = false;  // 用户手动合上过
    else if (mode === 'expanded') want = true;
    else if (mode === 'alwaysCollapsed') want = false;         // 直播中也不展开
    else want = !!o.live;                                      // collapsed：只在思考直播时展开
    d.open = want;
    // 赋值 .open 本身也会派发 toggle。若不区分，程序设的状态会被当成用户的选择
    // 记进 openTools，日后改设置就对这张卡失效了——只认真正改变状态的那次事件。
    let applied = want;
    d.addEventListener('toggle', () => {
      if (d.open === applied) return;
      applied = d.open;
      d.dataset.userToggled = '1';   // 直播卡（无 key）也要认用户的手动开合
      if (!key) return;
      // 记两个方向：默认展开时用户合上也要被记住，只记 open 集合是不够的
      if (d.open) { S.openTools.add(key); S.openTools.delete(key + ':closed'); }
      else { S.openTools.delete(key); S.openTools.add(key + ':closed'); }
    });
    d.append(
      el('summary', {}, icon('think', 'tk-icon'), el('span', { text: o.live ? '思考中…' : '思考过程' })),
      el('div', { class: 'think-body', text: text }));
    return d;
  }
  // 思考阶段结束（正文开始吐字 / 开始生成工具参数）：把直播中的思考卡收起来。
  // 判据是「思考已经不再是当前发生的事」，不是「整条消息流完」——
  // 工具参数要吐很久，等它流完再折，思考会一直摊在那儿挡视线。
  function settleStreamThink() {
    const wrap = $('#streamMsg');
    if (!wrap) return;
    const card = wrap.querySelector('.think-card');
    if (!card) return;
    // summary 里第一个 span 是图标，文字在最后一个
    card.querySelector('summary span:last-child').textContent = '思考过程';
    if (S.settings.reasoningDisplay === 'expanded') return;   // 该档始终展开
    if (card.dataset.userToggled) return;                     // 用户在直播期间手动开过，尊重他的选择
    card.open = false;
  }

  function findToolMsg(messages, fromIdx, callId) {
    for (let i = fromIdx + 1; i < messages.length; i++)
      if (messages[i].role === 'tool' && messages[i].tool_call_id === callId) return messages[i];
    return null;
  }
  // ---------- 文件变更卡片（折叠态为按钮，展开显示 diff）----------
  const CHANGE_LABEL = { create: '创建', modify: '修改', delete: '删除', move: '移动', copy: '复制' };

  function changeCard(ch, cardId) {
    const d = el('details', { class: 'change-card ' + ch.kind });
    const stats = el('span', { class: 'ch-stats' });
    if (ch.added) stats.append(el('span', { class: 'plus', text: '+' + ch.added }));
    if (ch.removed) stats.append(el('span', { class: 'minus', text: '-' + ch.removed }));
    const nameText = ch.kind === 'move' || ch.kind === 'copy'
      ? displayPath(ch.from) + ' → ' + displayPath(ch.path)
      : displayPath(ch.path);
    const summary = el('summary', {},
      el('span', { class: 'ch-kind', text: CHANGE_LABEL[ch.kind] || ch.kind }),
      el('span', { class: 'ch-path', text: nameText }),
      stats);
    d.append(summary);
    // diff 体延迟计算：折叠状态不做无用功，大文件展开才付出代价
    let built = false;
    const build = () => { if (!built) { built = true; d.append(diffBody(ch)); } };
    d.addEventListener('toggle', () => {
      if (d.open) { build(); if (cardId) S.openTools.add(cardId); }
      else if (cardId) S.openTools.delete(cardId);
    });
    // 重绘后恢复展开态，否则 AI 一有新输出，用户正在看的 diff 就合上了
    if (cardId && S.openTools.has(cardId)) { d.open = true; build(); }
    return d;
  }

  function diffBody(ch) {
    if (ch.kind === 'move' || ch.kind === 'copy')
      return el('div', { class: 'diff-note', text: '文件内容未变化，仅路径变动。' });
    if (ch.isDir)
      return el('div', { class: 'diff-note', text: '删除的是目录，无文本差异可显示。' });
    const wrap = el('div', { class: 'diff' });
    const r = Diff.diffLines(ch.before, ch.after);
    if (!r.rows.length) return el('div', { class: 'diff-note', text: '无差异。' });
    for (const row of r.rows) wrap.append(diffRow(row));
    if (r.truncated)
      wrap.append(el('div', { class: 'diff-note', text: '差异过大，已只显示前 ' + Diff.LIMITS.maxHunkLines + ' 行。' }));
    return wrap;
  }

  // 单行：gap 折叠标记 / eq 上下文 / add / del / mod（mod 做行内词级高亮）
  function diffRow(row) {
    if (row.type === 'gap')
      return el('div', { class: 'dl gap' }, el('span', { class: 'ln' }), el('span', { class: 'dt', text: '⋯ 省略 ' + row.count + ' 行未变更' }));
    if (row.type === 'mod') {
      const ops = Diff.diffWords(row.oldText, row.newText);
      const oldLine = el('div', { class: 'dl del' }, el('span', { class: 'ln', text: String(row.oldNo) }), el('span', { class: 'sg', text: '-' }));
      const newLine = el('div', { class: 'dl add' }, el('span', { class: 'ln', text: String(row.newNo) }), el('span', { class: 'sg', text: '+' }));
      const oldT = el('span', { class: 'dt' }), newT = el('span', { class: 'dt' });
      for (const op of ops) {
        if (op.type === 'eq') { oldT.append(el('span', { text: op.text })); newT.append(el('span', { text: op.text })); }
        else if (op.type === 'del') oldT.append(el('span', { class: 'w-del', text: op.text }));
        else newT.append(el('span', { class: 'w-add', text: op.text }));
      }
      oldLine.append(oldT); newLine.append(newT);
      return el('div', { class: 'dl-pair' }, oldLine, newLine);
    }
    const cls = row.type === 'add' ? 'add' : row.type === 'del' ? 'del' : 'eq';
    const sign = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ';
    const no = row.type === 'add' ? row.newNo : row.oldNo;
    return el('div', { class: 'dl ' + cls },
      el('span', { class: 'ln', text: no == null ? '' : String(no) }),
      el('span', { class: 'sg', text: sign }),
      el('span', { class: 'dt', text: row.text }));
  }

  function toolBrief(tc) {
    try {
      const a = JSON.parse(tc.function.arguments || '{}');
      const p = a.path || a.from || a.pattern || a.name || '';
      // 参数类型可能不对（模型把 path 发成对象等），那是预检要报的错，
      // 标题里硬转字符串只会得到 [object Object]，不如不显示
      return typeof p === 'string' && p ? '· ' + displayPath(p) : '';
    } catch (_) { return ''; }
  }

  // ---------- 输入框：Skill / 功能补全 + 提示词历史 ----------
  // 输入框是 contenteditable：正文是文本节点，被选中的 Skill / 功能是不可编辑的气泡
  // （<span class="chip" data-kind data-name>），删除时整体消失。

  // 内置功能（与 Skill 同处一个补全面板，同名时都列出，由 kind 区分）
  const FEATURES = [
    { name: 'goal', description: '设立或修改长期目标，AI 会自动推进直到完成' },
  ];

  // 输入框当前内容 → 纯文本（气泡序列化成各自的标记）
  function inputText(input) {
    let out = '';
    for (const node of input.childNodes) out += serializeNode(node);
    return out;
  }
  function serializeNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.classList.contains('image-attachment')) return '';
    if (node.classList && node.classList.contains('chip')) {
      const kind = node.dataset.kind, name = node.dataset.name;
      // Skill 气泡序列化成 run_skill 标记，模型见名即知要加载它；正文不展开
      return kind === 'skill' ? '[run_skill:' + name + ']' : '/' + name + ' ';
    }
    if (node.tagName === 'BR') return '\n';
    if (node.tagName === 'DIV' || node.tagName === 'P') {
      let s = '';
      for (const c of node.childNodes) s += serializeNode(c);
      return '\n' + s;
    }
    let s = '';
    for (const c of node.childNodes) s += serializeNode(c);
    return s;
  }
  function setInputText(input, text) {
    input.textContent = '';
    if (text) input.append(document.createTextNode(text));
    placeCaretAtEnd(input);
    scheduleDraftSave();     // 历史回溯、撤回回填、重试回填都经过这里，一并存草稿
  }
  function clearInput(input) { input.textContent = ''; }
  function isInputEmpty(input) { return inputText(input).trim() === '' && !input.querySelector('.image-attachment'); }

  function inputImages(input) {
    return [...input.querySelectorAll('.image-attachment[data-path]')].map(n => JSON.parse(n.dataset.ref));
  }

  function imageAttachment(ref) {
    const card = el('span', { class: 'image-attachment', contenteditable: 'false' });
    if (ref) {
      card.dataset.path = ref.path; card.dataset.ref = JSON.stringify(ref);
      const node = Images.resolve(S.tree, ref.path);
      if (node && node.image) card.append(el('img', { src: node.image.dataUrl, alt: '待发送图片' }));
      else card.append(el('span', { text: node ? '图片无法预览，请转换格式后重新粘贴' : '图片已过期，请移除后重新粘贴' }));
    } else { card.dataset.pending = '1'; card.append(el('span', { text: '正在处理图片…' })); }
    card.append(el('button', { type: 'button', text: '×', title: '移除图片', 'aria-label': '移除图片',
      onclick: e => { e.preventDefault(); card.cancelled = true; card.remove(); scheduleDraftSave(); } }));
    return card;
  }

  // ---------- 输入草稿 ----------
  // 草稿要连气泡一起存，所以不能只存文本：序列化成 [{t:'text'|'chip', ...}] 片段数组。
  // 存在 session.draft 里，切会话、刷新、关标签页都能原样回来。
  function inputDraft(input) {
    const parts = [];
    const walk = node => {
      if (node.nodeType === Node.TEXT_NODE) { if (node.nodeValue) parts.push({ t: 'text', v: node.nodeValue }); return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.classList.contains('image-attachment')) {
        if (node.dataset.ref) parts.push({ t: 'image', v: JSON.parse(node.dataset.ref) });
        return;
      }
      if (node.classList && node.classList.contains('chip')) {
        parts.push({ t: 'chip', kind: node.dataset.kind, name: node.dataset.name });
        return;
      }
      if (node.tagName === 'BR') { parts.push({ t: 'text', v: '\n' }); return; }
      if (node.tagName === 'DIV' || node.tagName === 'P') parts.push({ t: 'text', v: '\n' });
      for (const c of node.childNodes) walk(c);
    };
    for (const n of input.childNodes) walk(n);
    return parts;
  }
  function restoreDraft(input, parts) {
    input.textContent = '';
    if (!Array.isArray(parts) || !parts.length) return;
    for (const p of parts) {
      if (p.t === 'chip' && p.kind && p.name) input.append(chipEl(p.kind, p.name));
      else if (p.t === 'image' && p.v) input.append(imageAttachment(p.v));
      else if (p.t === 'text' && p.v) input.append(document.createTextNode(p.v));
    }
  }
  // 节流落库：每次按键都写 IndexedDB 太重，300ms 静默后再存。
  // 切会话/发送前会强制 flush，所以不会丢最后几个字。
  let draftTimer = null, draftOwner = null;
  function scheduleDraftSave() {
    const sess = cur.session();
    if (!sess) return;
    draftOwner = sess.id;
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => { draftTimer = null; flushDraft(); }, 300);
  }
  function flushDraft() {
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
    const input = $('#chatInput');
    if (!input || !draftOwner) return;
    const sess = S.sessions.find(s => s.id === draftOwner);
    if (!sess) return;
    const parts = inputDraft(input);
    const next = parts.length ? parts : null;
    // 内容没变就不写库，避免频繁触发 IndexedDB 事务
    if (JSON.stringify(sess.draft || null) === JSON.stringify(next)) return;
    sess.draft = next;
    return saveSession(sess);
  }
  // 切换会话时调用：先把上一个会话的草稿落库，再载入新会话的
  function swapDraft(nextSess) {
    flushDraft();
    const input = $('#chatInput');
    if (!input) return;
    draftOwner = nextSess ? nextSess.id : null;
    restoreDraft(input, nextSess && nextSess.draft);
  }
  function placeCaretAtEnd(node) {
    const r = document.createRange(), sel = window.getSelection();
    r.selectNodeContents(node); r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);
  }
  // 输入框里已存在的气泡
  function inputChips(input) {
    return [...input.querySelectorAll('.chip')].map(c => ({ kind: c.dataset.kind, name: c.dataset.name }));
  }
  // 图片单独保存；其他富文本只取纯文本，避免带入外部 HTML。
  async function onChatPaste(e) {
    e.preventDefault();
    const clipboard = e.clipboardData || window.clipboardData;
    const input = e.currentTarget;
    if (input.contentEditable === 'false') return;
    const t = clipboard.getData('text/plain');
    if (t) document.execCommand('insertText', false, t);
    const files = [...(clipboard.items || [])].filter(i => i.kind === 'file' && i.type.startsWith('image/'))
      .map(i => i.getAsFile()).filter(Boolean);
    if (files.length && !S.settings.imageSending) { toast('请先在设置中将“视觉模型”设为“是”'); return; }
    const sess = cur.session(), projectId = S.projectId;
    const cards = files.map(() => { const card = imageAttachment(null); input.append(card); return card; });
    for (let i = 0; i < files.length; i++) {
      const file = files[i], card = cards[i];
      try {
        if (file.size > Images.MAX_INPUT_BYTES) throw new Error('图片超过本地处理上限 32 MiB');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const prepared = await Images.prepare(bytes);
        if (S.projectId !== projectId || !sess || card.cancelled || (!card.isConnected && cur.session() === sess)) continue;
        if (lease.isHeldByOther(projectId)) throw new Error('项目正在其他窗口执行，请稍后重新粘贴');
        const ext = Images.detectMime(bytes).split('/')[1].replace('jpeg', 'jpg');
        const ref = Images.store(S.tree, '/tmp/images/' + uid() + '.' + ext, bytes, prepared);
        ref.name = file.name || ref.name;
        const currentRefs = new Set([...S.activeTmpPaths, ...inputImages(input).map(r => r.path), ref.path]);
        const cleanup = TempFiles.sweep(S.tree, { ...tmpOptions(), protect: currentRefs });
        if (cleanup.bytes > AGENT_CONFIG.tmpMaxBytes) {
          VFS.deletePath(S.tree, ref.path);
          await saveTree();
          throw new Error('当前图片占用超过临时缓存上限，请减少待发送图片');
        }
        if (cleanup.removed.length) renderChat();
        await saveTree();
        if (S.projectId !== projectId) continue;
        if (card.isConnected && cur.session() === sess) { card.replaceWith(imageAttachment(ref)); scheduleDraftSave(); }
        else if (!card.cancelled) { sess.draft = [...(sess.draft || []), { t: 'image', v: ref }]; await saveSession(sess); }
      } catch (err) { toast('图片处理失败：' + err.message); }
      finally { if (card.isConnected) card.remove(); }
    }
    scheduleDraftSave();
  }

  // 仅当光标位于一个 /词 内时匹配。气泡把输入切成多段，所以不再限定「开头」，
  // 而是看光标所在文本节点里、紧贴光标之前的那个 /词。
  function skillQuery(input) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!r.collapsed || !input.contains(r.startContainer)) return null;
    if (r.startContainer.nodeType !== Node.TEXT_NODE) return null;
    const before = r.startContainer.nodeValue.slice(0, r.startOffset);
    const m = before.match(/(?:^|\s)\/([a-z0-9-]*)$/i);
    return m ? m[1] : null;
  }
  // 候选 = 功能 + Skill，各自带 kind；同名时两条都在，由用户挑
  function matchingItems(q) {
    const feats = FEATURES.map(f => ({ ...f, kind: 'feature' }));
    const skills = cur.allSkills().map(s => ({ name: s.name, description: s.description, kind: 'skill' }));
    const all = [...feats, ...skills];
    if (q === '') return all.slice(0, 8);
    const lower = q.toLowerCase();
    return all.filter(s => s.name.toLowerCase().startsWith(lower)).slice(0, 8);
  }
  function hideSkillPop() {
    const pop = $('#skillPop');
    if (pop) { pop.style.display = 'none'; pop.innerHTML = ''; }
    S.skillPopOpen = false;
  }
  const KIND_LABEL = { feature: '功能', skill: 'Skill' };
  function renderSkillPop() {
    const input = $('#chatInput');
    const pop = $('#skillPop');
    if (!input || !pop) return;
    const q = skillQuery(input);
    if (q === null) { hideSkillPop(); return; }
    const list = matchingItems(q);
    if (!list.length) { hideSkillPop(); return; }
    if (S.skillMenuIdx >= list.length) S.skillMenuIdx = 0;
    pop.innerHTML = '';
    list.forEach((it, i) => {
      const row = el('div', { class: 'skill-opt' + (i === S.skillMenuIdx ? ' active' : ''),
        onmousedown: e => { e.preventDefault(); applyCompletion(it); } },
        el('span', { class: 'sk-kind ' + it.kind, text: KIND_LABEL[it.kind] }),
        el('span', { class: 'sk-name', text: '/' + it.name }),
        el('span', { class: 'sk-desc', text: it.description || '' }));
      row.addEventListener('mouseenter', () => { S.skillMenuIdx = i; renderSkillPop(); });
      pop.append(row);
    });
    pop.style.display = 'block';
    S.skillPopOpen = true;
    S.skillPopList = list;
    // 鼠标在弹窗内时，输入框失焦不关闭
    pop.onmouseenter = () => { S.skillPopHover = true; };
    pop.onmouseleave = () => { S.skillPopHover = false; };
  }
  // 造一个气泡节点：contenteditable=false 让它对光标而言是一个整体，退格即整块删除
  function chipEl(kind, name) {
    return el('span', { class: 'chip chip-' + kind, contenteditable: 'false',
      'data-kind': kind, 'data-name': name,
      title: (KIND_LABEL[kind] || '') + ' ' + name },
      el('span', { class: 'chip-kind', text: KIND_LABEL[kind] || '' }),
      el('span', { class: 'chip-name', text: name }));
  }
  // 补全：把光标前的 /词 换成气泡
  function applyCompletion(item) {
    const input = $('#chatInput');
    const sel = window.getSelection();
    if (!input || !sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    const tn = r.startContainer;
    if (tn.nodeType !== Node.TEXT_NODE) { hideSkillPop(); return; }
    const before = tn.nodeValue.slice(0, r.startOffset);
    const m = before.match(/(?:^|\s)\/([a-z0-9-]*)$/i);
    if (!m) { hideSkillPop(); return; }
    // 同一个 Skill/功能不重复插入
    if (inputChips(input).some(c => c.kind === item.kind && c.name === item.name)) {
      // 仍要吃掉已输入的 /词，否则用户看到补全没反应
      const startAt = r.startOffset - m[1].length - 1;
      tn.nodeValue = tn.nodeValue.slice(0, startAt) + tn.nodeValue.slice(r.startOffset);
      hideSkillPop(); syncInputState(); scheduleDraftSave(); return;
    }
    const wordStart = r.startOffset - m[1].length - 1;   // -1 是那个 /
    const rest = tn.nodeValue.slice(r.startOffset);
    tn.nodeValue = tn.nodeValue.slice(0, wordStart);
    const chip = chipEl(item.kind, item.name);
    const tail = document.createTextNode(' ' + rest);
    tn.parentNode.insertBefore(tail, tn.nextSibling);
    tn.parentNode.insertBefore(chip, tail);
    // 光标落到气泡后面的空格之后
    const range = document.createRange();
    range.setStart(tail, 1); range.collapse(true);
    sel.removeAllRanges(); sel.addRange(range);
    input.focus();
    hideSkillPop();
    syncInputState();
    scheduleDraftSave();       // 插入气泡也要进草稿
  }
  // 输入框可见状态同步：占位符靠 :empty 伪类，这里只处理高度
  function syncInputState() {
    const input = $('#chatInput');
    if (!input) return;
    // 完全空时清掉浏览器可能留下的 <br>，否则 :empty 不生效、占位符不显示
    if (input.childNodes.length === 1 && input.firstChild.nodeName === 'BR') input.textContent = '';
  }
  function onChatInput() {
    S.skillMenuIdx = 0;
    S.histIdx = -1;            // 手动改动后退出历史回溯
    syncInputState();
    renderSkillPop();
    scheduleDraftSave();
  }
  function chatInputKeydown(e) {
    if (e.isComposing || e.keyCode === 229) return;
    const input = e.currentTarget;
    // Skill 补全弹窗的键盘操作
    if (S.skillPopOpen) {
      const list = S.skillPopList || [];
      if (e.key === 'ArrowDown') { e.preventDefault(); S.skillMenuIdx = (S.skillMenuIdx + 1) % list.length; renderSkillPop(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); S.skillMenuIdx = (S.skillMenuIdx - 1 + list.length) % list.length; renderSkillPop(); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const pick = list[S.skillMenuIdx];
        if (pick) applyCompletion(pick);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); hideSkillPop(); return; }
    }
    // 空输入按 ↑ → 回溯提示词历史（连续按可继续往前）
    if (e.key === 'ArrowUp' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const sess = cur.session();
      const hist = (sess && sess.promptHistory) || [];
      const cur_ = inputText(input);
      const blank = cur_.trim() === '';
      const inRecall = S.histIdx >= 0 && cur_ === hist[S.histIdx];
      if ((blank || inRecall) && hist.length) {
        e.preventDefault();
        if (S.histIdx === -1) S.promptDraft = cur_;
        const next = S.histIdx + 1;
        if (next >= hist.length) return;     // 到头了，不响应
        S.histIdx = next;
        setInputText(input, hist[next]);
        return;
      }
    }
    // 回溯中按 ↓ → 往后走回草稿
    if (e.key === 'ArrowDown' && S.histIdx >= 0) {
      const sess = cur.session();
      const hist = (sess && sess.promptHistory) || [];
      if (inputText(input) === hist[S.histIdx]) {
        e.preventDefault();
        S.histIdx--;
        setInputText(input, S.histIdx >= 0 ? hist[S.histIdx] : S.promptDraft);
        return;
      }
    }
    const action = SendShortcut.action(e, S.settings.reverseSendNewline === true);
    if (action === 'send') { e.preventDefault(); send(); }
    else if (action === 'newline') { e.preventDefault(); document.execCommand('insertLineBreak'); }
  }

  // ---------- 临时文件：文本与图片共用持久化过期策略 ----------
  function tmpOptions() {
    return { ttlTurns: AGENT_CONFIG.tmpTTLTurns, maxAgeMs: AGENT_CONFIG.tmpMaxAgeMs, maxBytes: AGENT_CONFIG.tmpMaxBytes };
  }
  async function stashLongInput(text) {
    const path = '/tmp/' + uid() + '.txt';
    VFS.writeFile(S.tree, path, text);
    TempFiles.touch(S.tree, path);
    const input = $('#chatInput');
    const protect = new Set([path, ...S.activeTmpPaths, ...(input ? inputImages(input).map(ref => ref.path) : [])]);
    const cleanup = TempFiles.sweep(S.tree, { ...tmpOptions(), protect });
    if (cleanup.bytes > AGENT_CONFIG.tmpMaxBytes) {
      VFS.deletePath(S.tree, path);
      await saveTree();
      throw new Error('输入和图片超过临时缓存上限，请减少内容后重试');
    }
    await saveTree();
    return path;
  }
  async function ageTmpFiles(readPaths, advance = true) {
    if (!S.tree || lease.isHeldByOther(S.projectId)) return;
    const result = TempFiles.sweep(S.tree, { ...tmpOptions(), advance, used: readPaths || new Set() });
    if (result.changed) await saveTree();
    if (result.removed.length) {
      renderChat(); renderFileTree();
      for (const card of document.querySelectorAll('.image-attachment[data-ref]')) {
        const ref = JSON.parse(card.dataset.ref);
        if (!Images.resolve(S.tree, ref.path)) card.replaceWith(imageAttachment(ref));
      }
    }
  }
  async function sweepStoredTmp() {
    for (const record of await DB.all('vfs')) {
      if (lease.isHeldByOther(record.id)) continue;
      if (TempFiles.sweep(record.tree, tmpOptions()).changed) await DB.put('vfs', record);
    }
  }
  async function viewImage(args) {
    if (!S.settings.imageSending) throw new Error('图片发送已关闭');
    const cleanup = TempFiles.sweep(S.tree, { ...tmpOptions(), protect: S.activeTmpPaths });
    if (cleanup.changed) await saveTree();
    const node = Images.resolve(S.tree, args.path);
    if (!node) throw new Error('图片已过期、已删除或不存在，请让用户重新提供: ' + args.path);
    const image = !args.crop && node.image ? node.image : await Images.prepare(VFS.fileBytes(node), { crop: args.crop });
    if (!S.settings.imageSending) throw new Error('图片发送已关闭');
    TempFiles.touch(S.tree, args.path);
    if (args.path.startsWith('/tmp/')) S.activeTmpPaths.add(args.path);
    return image;
  }

  async function migrateLegacyImages() {
    // Persist files before replacing embedded image data with references.
    for (const sess of cur.projSessions()) {
      if (sess.attachmentVersion === 1) continue;
      const messages = await DB.getMessages(sess.id);
      const migrate = async url => {
        const path = '/tmp/images/' + uid() + '.img';
        let bytes;
        try {
          bytes = Images.fromDataUrl(url);
          const prepared = await Images.prepare(bytes);
          return Images.store(S.tree, path, bytes, prepared);
        } catch (_) {
          if (bytes) {
            VFS.writeFile(S.tree, path, Images.base64(bytes), { encoding: 'base64' });
            TempFiles.touch(S.tree, path);
          }
          return { path, name: '旧图片无法预览，请重新粘贴' };
        }
      };
      for (const m of messages) {
        const urls = Tokens.contentImages(m.content);
        if (!urls.length) continue;
        m.attachments = [];
        for (const url of urls) {
          m.attachments.push(await migrate(url));
          TempFiles.sweep(S.tree, tmpOptions());
        }
        m.content = Tokens.contentText(m.content);
      }
      for (const part of sess.draft || [])
        if (part.t === 'image' && typeof part.v === 'string') part.v = await migrate(part.v);
      TempFiles.sweep(S.tree, tmpOptions());
      await saveTree();
      await DB.putMessages(sess.id, messages);
      sess.messages = messages.slice(sess.__baseSeq || 0);
      sess.__savedCount = sess.messages.length;
      sess.attachmentVersion = 1;
      await saveSession(sess);
    }
  }

  // ---------- 提示词历史（每会话最近 10 条） ----------
  const PROMPT_HISTORY_MAX = 10;
  async function pushPromptHistory(sess, text) {
    if (!sess.promptHistory) sess.promptHistory = [];
    // 与上一条相同则不重复记录
    if (sess.promptHistory[0] === text) return;
    sess.promptHistory.unshift(text);
    if (sess.promptHistory.length > PROMPT_HISTORY_MAX) sess.promptHistory.length = PROMPT_HISTORY_MAX;
    await saveSession(sess);
  }
  // 系统错误气泡：仅存在于本地会话记录，不进入 API 上下文，可单独关闭
  async function pushSystemError(sess, message, hint) {
    sess.messages.push({ role: 'system-error', content: message, hint: hint || '', at: Date.now() });
    await saveSession(sess);
    renderChat();
  }
  async function dismissSystemError(idx) {
    const sess = cur.session();
    // 仅当该位置确实是系统错误时才删除，避免索引漂移误删
    if (!sess || !sess.messages[idx] || sess.messages[idx].role !== 'system-error') return;
    sess.messages.splice(idx, 1);
    markSessionDirty(sess);
    await saveSession(sess);
    renderChat();
  }

  // ---------- 发送轮次 ----------
  async function continueInterrupted(sess) {
    if (S.continuing || S.running || cur.session() !== sess) return;
    S.continuing = true;
    renderChat();
    try { await send(null, true); }
    finally { S.continuing = false; renderChat(); }
  }
  async function send(repair = null, resume = false) {
    if (S.continuing && !resume) return;
    if (S.storageBusy) return toast('正在清理项目数据，请稍后发送');
    if (S.repairSending && !repair) return;
    if (S.handoffBusy) return toast('请先完成世界交接');
    const input = $('#chatInput');
    const sess = cur.session();
    if (!sess || (resume && !sess.contextInterrupted)) return;
    const resumeRecord = resume ? { ...sess.contextInterrupted } : null;
    if (resume) {
      await ensureFullHistory(sess);
      if (cur.session() !== sess || S.running) return;
    }
    const resumingUser = resume ? sess.messages.find(m => m.msgId === resumeRecord.userMsgId) : null;
    if (!S.running && S.tree && !lease.isHeldByOther(S.projectId)) {
      const cleanup = TempFiles.sweep(S.tree, tmpOptions());
      if (cleanup.changed) saveTree().catch(e => toast('临时文件保存失败：' + e.message));
    }
    let text = resume ? '' : repair ? repair.text : inputText(input).trim();
    const images = resume ? (resumingUser?.attachments || []) : repair ? [] : inputImages(input);
    if (!resume && !repair && input.querySelector('.image-attachment[data-pending="1"]')) { toast('图片读取中，请稍候再发送'); return; }
    if ((!resume && !text && !images.length) || S.running) return;
    if (!resume && images.length && !S.settings.imageSending) { toast('请将“视觉模型”设为“是”，或移除输入框中的图片'); return; }
    if (!resume && images.some(ref => !Images.resolve(S.tree, ref.path)?.image)) { toast('图片已过期或无法预览，请移除后重新粘贴'); return; }
    const chips = resume || repair ? [] : inputChips(input);
    const goalChip = chips.find(c => c.kind === 'feature' && c.name === 'goal');
    const skillChips = chips.filter(c => c.kind === 'skill');

    // goal 气泡 / 命令：设立或修改目标。与普通消息一样发一轮请求——
    // 目标本身就是一条指令，AI 该立刻开始推进，而不是等用户再说一句话。
    // 正文里的 Skill 引用标记保留原样带进目标——目标本身就该记住用哪套流程。
    // 气泡可以放在任意位置，所以要按位置剔除，不能只削开头。
    const goalCmd = goalChip
      ? text.replace(/(?:^|\s)\/goal(?=\s|$)/, ' ').trim()
      : (text.match(/^\/goal\s+([\s\S]+)$/) || [])[1];
    const isGoalSet = goalCmd !== undefined && goalCmd !== null;
    if (isGoalSet && !goalCmd.trim()) { toast('目标内容不能为空'); return; }

    if (!S.settings.apiKey) {
      // 立即在对话流中给出系统错误气泡（不进上下文、可关闭），并保留用户已输入内容
      await pushSystemError(sess, '尚未设置 API Key，无法发送。',
        '请打开右上角「设置」填写 API Key。此提示不会进入 AI 上下文，可点右上角 ✕ 关闭。');
      openSettings();
      return;
    }
    hideSkillPop();

    // 超长输入 → 暂存 /tmp/{uuid}.txt，注入改为「头尾预览 + 文件引用」的固定格式
    let stashPath = resume ? resumingUser?.stashPath || null : null;
    const rawText = text;
    if (text.length >= AGENT_CONFIG.longInputChars) {
      try { stashPath = await stashLongInput(text); }
      catch (err) { toast(err.message); return; }
      const head = AGENT_CONFIG.longInputHeadChars, tail = AGENT_CONFIG.longInputTailChars;
      text = renderTemplate(LONG_INPUT_TEMPLATE, {
        path: stashPath,
        total: rawText.length,
        headChars: head,
        tailChars: tail,
        midChars: Math.max(0, rawText.length - head - tail),
        head: rawText.slice(0, head),
        tail: rawText.slice(-tail),
      });
      toast('输入过长，已转存为临时文件');
    }

    // 上下文超限预检（四种模式）。
    // 启动时若因 token 超限只载入了尾部（上方还有未折叠的活上下文），
    // 预检和随后的压缩/裁剪都必须看到完整历史，先补全再算
    if (sess.__partial === 'cap') await ensureFullHistory(sess);
    const capTokens = S.settings.maxContextK * 1000;
    const initialTools = Agent.toolDefinitions(cur.allSkills(), { imageSending: S.settings.imageSending });
    const draftMessage = { role: 'user', content: text, msgId: 'pending-input', attachments: images };
    const draftCost = () => ContextBudget.occupied(S.settings, ContextBudget.cost(resume ? requestMessages(sess, resumeRecord.userMsgId)
      : requestMessages({ ...sess, messages: [...sess.messages, draftMessage] }, draftMessage.msgId), initialTools));
    if (draftCost() > capTokens) {
      if (S.settings.contextOverflow === 'compress') {
        const reserve = resume ? 0 : ContextBudget.cost(requestMessages({ ...sess, messages: [draftMessage] }, draftMessage.msgId))
          - ContextBudget.cost(requestMessages({ ...sess, messages: [] }));
        await compressNow(false, reserve);
      }
      if (draftCost() > capTokens && !['sliding', 'truncate'].includes(S.settings.contextOverflow)) {
        const message = ContextBudget.limitError(draftCost(), capTokens).message;
        toast(message);
        await pushSystemError(sess, message, ContextBudget.HINT);
        renderCtxBadge();
        return;
      }
    }

    if (!resume && !repair) {
      clearInput(input);
      flushDraft();                      // 内容已发出，草稿随之清空
      S.histIdx = -1; S.promptDraft = '';
      await pushPromptHistory(sess, rawText);
    } else await flushDraft();
    S.lastError = null;

    // 目标设立/修改：先落库，再把注入文本换成目标模板。
    // 界面上显示为「设立了目标」气泡，AI 收到的是带基准说明的完整指令。
    let goalSetKind = null;
    if (isGoalSet) {
      const had = !!(S.goal && S.goal.content);
      goalSetKind = had ? 'change' : 'set';
      if (!S.goal) S.goal = { content: '', changedPending: false };
      if (goalCmd.length > GOAL_MAX_CHARS) {
        toast('目标过长（' + goalCmd.length + ' 字），上限 ' + GOAL_MAX_CHARS + ' 字');
        setInputText(input, rawText);
        for (const src of images) input.append(imageAttachment(src));
        scheduleDraftSave(); return;
      }
      S.goal.content = goalCmd;
      S.goal.changedPending = false;   // 这一轮就把新目标交给模型，无需再提醒
      persistGoal(sess);
      text = renderTemplate(GOAL_SET_TEMPLATE, {
        goal: goalCmd,
        action: had ? ' action="change"' : '',
        actionText: had ? '修改' : '设立',
      });
    }

    // 跨窗口执行锁：紧贴轮次开始抢占项目租约。冲突则回填输入、不丢内容。
    // 此处所有提前 return（API Key/上下文超限）都在 clearInput 之前，不会到达此点，故无僵尸租约。
    const acquired = lease.acquireForRun(S.projectId, sess.id);
    if (!acquired.ok) {
      const r = lease.blockedReason(S.projectId, sess.id) || acquired.conflict;
      const kind = (r && r.kind) || 'project';
      const projName = (cur.project() && cur.project().name) || '当前项目';
      toast(kind === 'session'
        ? '⚠ 其他窗口正在运行此会话，请稍候或到该窗口操作。'
        : '⚠ 项目「' + projName + '」正被其他窗口执行（VFS 写保护），请稍候。');
      if (!resume && !repair) {
        setInputText(input, rawText);
        for (const src of images) input.append(imageAttachment(src));
        scheduleDraftSave();
      }
      return;
    }
    let preTree, sentUserId;                           // 本轮开始前的 workspace 状态
    const projectId = S.projectId, userIdx = resume && resumingUser ? sess.messages.indexOf(resumingUser) : sess.messages.length;
    const readPaths = new Set(images.map(ref => ref.path));
    if (stashPath) readPaths.add(stashPath);
    let roundAged = false;
    try {
      setLockRun(sess.id, true);
      preTree = VFS.clone(getWorkspaceNode());
      // msgId 是稳定标识：快照靠它定位轮次，删除其他轮次后仍能对上
      const userMsg = resume ? resumingUser || { msgId: resumeRecord.userMsgId } : { role: 'user', content: text, msgId: uid() };
      delete sess.contextInterrupted;
      sentUserId = userMsg.msgId;
      if (!resume) {
        if (repair) userMsg.validationReport = { count: repair.errorCount };
        if (images.length) userMsg.attachments = images;
        if (goalSetKind) { userMsg.goalSet = goalSetKind; userMsg.goalText = goalCmd; }
        // 注入给 AI 的是折叠模板；界面与「撤回回填」仍用原始全文
        if (stashPath) { userMsg.stashPath = stashPath; userMsg.fullLength = rawText.length; userMsg.displayContent = rawText; }
        sess.messages.push(userMsg);
      }

      // Skill 手动触发：伪造成一次 run_skill 工具调用写进历史。
      // 用 system 消息注入有两个毛病：语义不对（Skill 是本次流程，不是助手人设），
      // 且它插在历史之后又不是每轮都有，前缀缓存到这里就断。伪造工具调用则天然落在
      // 历史里，后续轮次也看得到，模型不会「下一轮就忘了流程」。
      // 气泡优先；没有气泡时兼容手打的 /skill名 前缀。
      const typedSkill = text.match(/^\/([a-z0-9-]+)/);
      const wanted = resume ? [] : skillChips.length ? skillChips.map(c => c.name)
        : (typedSkill ? [typedSkill[1]] : []);
      for (const nm of wanted) {
        const manualSkill = cur.allSkills().find(s => s.name === nm);
        if (!manualSkill) continue;
        const callId = 'call_manual_' + uid();
        sess.messages.push({
          role: 'assistant', content: '',
          tool_calls: [{ id: callId, type: 'function',
            function: { name: 'run_skill', arguments: JSON.stringify({ name: manualSkill.name }) } }],
        });
        const root = SKILLS_ROOT + '/' + manualSkill.name;
        const files = Object.keys(manualSkill.files || {});
        const header = ['# Skill: ' + manualSkill.name, '根目录: ' + root];
        if (files.length) header.push('附件: ' + files.join(', '));
        sess.messages.push({ role: 'tool', tool_call_id: callId,
          content: header.join('\n') + '\n\n' + manualSkill.instructions });
      }

      // 自己发的消息必须看到：无论刚才在看哪段历史，发送即回到底部跟随
      S.stickToBottom = true;
      renderChat({ follow: true });
      // 先把用户消息落库：从这里到第一条回复入库之间要走一次网络往返，
      // 期间刷新/关页面的话，恢复出来的残段会找不到对应的提问，成为一条孤儿回复。
      await saveSession(sess);
      S.activeTmpPaths = readPaths;
      // 目标循环：每轮结束后若仍有目标，追加一条推进消息继续跑，直到 AI 主动 end。
      // goalRound 只在有目标时递增，无目标时循环体只执行一次。
      for (let goalRound = 0; ; goalRound++) {
        if (S.abort.signal.aborted) throw Object.assign(new Error('已中止'), { name: 'AbortError' });
        roundAged = false;
        if (goalRound > 0) {
          // 上一轮没结束目标 → 注入推进提示（用户侧显示为「继续推进目标」气泡）
          const g = S.goal;
          if (!g || !g.content) break;
          if (goalRound >= GOAL_MAX_ROUNDS) {
            await pushSystemError(sess, '目标已连续推进 ' + GOAL_MAX_ROUNDS + ' 轮仍未结束，已自动停止。',
              '如需继续，请再次发送消息。当前目标仍然保留。');
            break;
          }
          const notice = g.changedPending ? GOAL_CHANGED_NOTICE + '\n' : '';
          g.changedPending = false;      // 提醒只发生一次
          sess.messages.push({ role: 'user', msgId: uid(), goalPush: true,
            content: renderTemplate(GOAL_TEMPLATE, { goal: g.content, notice }) });
          await saveSession(sess);
          renderChat();
        }
        const ctx = { tree: S.tree, skills: cur.allSkills(), config: AGENT_CONFIG, readState: S.readState,
          viewImage: S.settings.imageSending ? viewImage : undefined,
          parseDocument: args => Documents.parse(S.tree, args, { signal: S.abort.signal,
            checkActive: () => { if (S.projectId !== projectId || !S.running || lease.isHeldByOther(projectId)) throw Error('文档解析任务已失效'); } }),
          askUser: askUserDialog, goal: S.goal || (S.goal = { content: '', changedPending: false }) };
        S.streamSession = sess.id;      // 流式内容归属本会话，切走后不画到别处
        S.streamBuf = '';
        S.reasonBuf = '';
        const toolDefs = Agent.toolDefinitions(cur.allSkills(), { imageSending: S.settings.imageSending });
        const transport = Agent.createHttpTransport(S.settings, toolDefs, {
          prepareMessages: messages => S.settings.imageSending ? messages : messages.map(m => Array.isArray(m.content)
            ? { ...m, content: Tokens.contentText(m.content) + '\n[图片发送已关闭]' } : m),
          onDelta: t => renderStreamDelta(t),
          onReasoningDelta: t => renderReasoningDelta(t),
          // 模型正在逐字生成工具参数：把快照画成占位卡，这段等待才有反馈。
          // 节流到 100ms —— 字数每 100ms 跳一次已经足够有「在动」的实感。
          onToolDelta: calls => {
            // 开始生成工具参数 = 思考阶段结束。这里必须收起思考，不能等整条消息流完：
            // 工具参数往往要吐十几秒，那期间思考一直摊开会一直挡着视线。
            if (!S.streamingTools) settleStreamThink();
            S.streamingTools = calls;
            const now = Date.now();
            if (!S.toolPaintAt || now - S.toolPaintAt >= 100) {
              S.toolPaintAt = now;
              if (S.toolPaintTimer) { clearTimeout(S.toolPaintTimer); S.toolPaintTimer = null; }
              renderActiveTool();
            } else if (!S.toolPaintTimer) {
              S.toolPaintTimer = setTimeout(() => {
                S.toolPaintTimer = null; S.toolPaintAt = Date.now(); renderActiveTool();
              }, 100);
            }
          },
          signal: S.abort.signal,
        });
        const msgs = requestMessages(sess, goalRound === 0 ? userMsg.msgId : null);
        const turnNo = ++S.turnCounter;
        S.validationPending = true;
        await saveTree(); // Pending content cannot retain an importable green checkpoint.
        const out = await Agent.runTurn(ctx, msgs, transport, {
          signal: S.abort.signal,
          prepareRequest: async (_messages, requestOnly) => {
            const activeUser = [...sess.messages].reverse().find(m => m.role === 'user' && !m.displayOnly);
            const activeId = activeUser && activeUser.msgId;
            const assemble = () => {
              const messages = requestMessages(sess, activeId);
              for (const image of requestOnly) {
                const after = messages.findLastIndex(m => m.role === 'tool' && m.tool_call_id === image.afterToolCallId);
                const outgoing = S.settings.imageSending ? image : { role: 'user', content: Tokens.contentText(image.content) + '\n[图片发送已关闭]' };
                if (after < 0) messages.push(outgoing);
                else messages.splice(after + 1, 0, outgoing);
              }
              return messages;
            };
            if (S.settings.contextOverflow === 'compress' && ContextBudget.occupied(S.settings, ContextBudget.cost(assemble(), toolDefs)) > capTokens) {
              try {
                await performCompression(sess, { signal: S.abort.signal, preserveUserId: activeId,
                  reserveTokens: ContextBudget.cost(requestOnly), toolDefs });
              } catch (error) {
                if (error.name === 'AbortError') throw error;
                const stopped = ContextBudget.limitError(ContextBudget.occupied(S.settings, ContextBudget.cost(assemble(), toolDefs)), capTokens);
                stopped.message = '自动压缩失败：' + error.message + '\n' + stopped.message;
                throw stopped;
              }
            }
            renderCtxBadge();
            return ContextBudget.fitConfigured(assemble(), S.settings, toolDefs, S.settings.contextOverflow);
          },
          // 逐条落库并渲染：先把消息写进会话，再清流式气泡，中间没有空档
          onMessage: m => {
            S.streamingTools = null;   // 参数已收齐，交给执行阶段的卡片
            // 工具结果消息落库 = 这次调用已完成，占位卡该让位给结果卡片。
            // runTurn 里 onMessage 先于 onToolEnd 触发，若不在这里清掉，
            // 紧随其后的 renderChat 会把「完成卡片」和「正在加载」同时画出来。
            if (m.role === 'tool') S.activeTool = null;
            sess.messages.push(m);
            const saved = saveSession(sess);
            clearStreamBubble();
            if (S.sessionId === sess.id) { renderChat(); renderCtxBadge(); }
            return saved;
          },
          onGoalEvent: ev => { const saved = persistGoal(sess); renderChat(); return saved; },
          // 工具开始执行就先画一张占位卡片：用户能立刻看到「在做什么」，
          // 而不是盯着一个笼统的「处理中」等到结果出来才知道。
          onToolStart: tc => { S.activeTool = tc; renderActiveTool(); },
          onToolEnd: (tc, res) => {
            S.activeTool = null;
            // 记录本轮读过的 /tmp 文件，用于刷新其 TTL
            try {
              const a = JSON.parse(tc.function.arguments || '{}');
              if (['read_file', 'view_image', 'parse_document'].includes(tc.function.name) && !/^错误/.test(res.result) && a.path && String(a.path).startsWith('/tmp/')) readPaths.add(a.path);
            } catch (_) { /* 参数非法时忽略 */ }
            recordPendingChange(res, turnNo);
            renderFileTree();
            syncOpenEditor();          // 文件被 AI 改动时同步编辑器，否则用户看到的是旧内容
          },
        });
        S.validationPending = false;
        validateWorkspace(); // A completed runTurn has exhausted its tool calls, including goal rounds.
        // 消息已由 onMessage 逐条入库，此处不再重复 push
        if (out.hadWrite) {
          const snap = { id: uid(), projectId,
            turnRef: { sessionId: sess.id, msgIndex: userIdx + (sess.__baseSeq || 0), msgId: userMsg.msgId },
            tree: preTree, createdAt: Date.now() };
          S.snapshots.push(snap); await DB.put('snapshots', snap);
          await saveTree();
        }
        sess.updatedAt = Date.now();
        await saveSession(sess);
        await ageTmpFiles(readPaths);
        readPaths.clear();
        roundAged = true;
        if (!S.goal || !S.goal.content) break;   // 无目标 / 目标已结束 → 收工
      }
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /aborted|已中止/i.test(e.message || ''));
      if (aborted) {
        // 用户主动中止：保留已产生的部分内容（含思考），不当作错误
        const partial = (S.streamBuf || '').trim();
        const think = (S.reasonBuf || '').trim();
        const m = { role: 'assistant',
          content: partial ? partial + '\n\n_（已中止）_' : '_（已中止）_' };
        if (think) m.reasoning_content = think;
        sess.messages.push(m);
        await saveSession(sess);
      } else {
        // 挂到状态上由 renderChat 渲染，否则 finally 的 renderChat() 会清掉直接 append 的卡片
        if (ContextBudget.isLimitError(e) || resume) {
          sess.contextInterrupted = { userMsgId: [...sess.messages].reverse().find(m => m.role === 'user' && !m.displayOnly)?.msgId || sentUserId,
            message: e.message, at: Date.now() };
        }
        S.lastError = ContextBudget.isLimitError(e) || resume
          ? { sessionId: sess.id, message: e.message.includes(ContextBudget.HINT) ? e.message : e.message + '\n' + ContextBudget.HINT,
            actionLabel: '压缩上下文', retry: () => ctxMenu() }
          : { sessionId: sess.id, message: e.message, retry: () => {
          S.lastError = null;
          const retryFrom = sess.messages.findIndex(m => m.msgId === sentUserId && !m.displayOnly);
          if (retryFrom >= 0) { sess.messages.splice(retryFrom); markSessionDirty(sess); }
          if (repair) { renderChat(); send(repair); return; }
          setInputText(input, rawText);
          for (const src of images) input.append(imageAttachment(src));
          scheduleDraftSave(); renderChat(); saveSession(sess);
        } };
        await saveSession(sess);
      }
    } finally {
      // 收尾写入完成后才解锁，删除/切换项目不能与旧轮次的异步保存交叉。
      try {
        if (S.validationPending) {
          S.validationPending = false;
          if (lease.isHeldByOther(projectId)) validateWorkspace(false);
          else await saveTree(); // Persist completed tool writes even when the remaining turn was aborted.
        }
        await DB.del('config', 'stream:' + projectId);
        if (!roundAged) await ageTmpFiles(readPaths);
      } finally {
        S.activeTool = null;          // 中止时工具可能停在半路，占位卡不能留在那儿
        S.streamingTools = null;
        if (S.toolPaintTimer) { clearTimeout(S.toolPaintTimer); S.toolPaintTimer = null; }
        S.toolPaintAt = 0;
        setLockRun(sess.id, false);
        clearStreamBubble();
        S.streamSession = null;
        S.streamSaveAt = 0;
        S.activeTmpPaths = new Set();
        renderChat(); renderFileTree(); renderCtxBadge();
      }
    }
  }
  function setLockRun(sessionId, on) {
    if (on) {
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      S.run = { done, finish, controller: new AbortController() };
      S.abort = S.run.controller;
    }
    const run = S.run;
    S.runningSession = on ? sessionId : null;
    try {
      setLock(on);
      renderActiveTool();
    } finally {
      if (!on) { S.abort = null; S.run = null; run?.finish(); }
    }
  }
  // ---------- 目标（goal） ----------
  // 目标随会话走：切换会话时载入各自的目标，刷新后也能接着推进。
  function persistGoal(sess) {
    if (!sess) return;
    sess.goal = (S.goal && S.goal.content)
      ? { content: S.goal.content, changedPending: !!S.goal.changedPending } : null;
    const saved = saveSession(sess);
    renderGoalBar();
    return saved;
  }
  function loadGoal(sess) {
    const g = sess && sess.goal;
    S.goal = g && g.content ? { content: g.content, changedPending: !!g.changedPending }
      : { content: '', changedPending: false };
    S.goalExpanded = false;   // 换了会话就是另一个目标，展开态不该跟过来
    renderGoalBar();
  }
  // 用户侧设立/修改目标（/goal 命令与目标条的编辑入口共用）
  async function userSetGoal(text) {
    const content = String(text || '').trim();
    const sess = cur.session();
    if (!sess) return;
    if (!content) { toast('目标内容不能为空'); return; }
    if (content.length > GOAL_MAX_CHARS) {
      toast('目标过长（' + content.length + ' 字），上限 ' + GOAL_MAX_CHARS + ' 字'); return;
    }
    if (!S.goal) S.goal = { content: '', changedPending: false };
    const had = !!S.goal.content;
    S.goal.content = content;
    // 用户改了目标而模型还不知道 → 下次推进时带上「目标已修改」提醒
    S.goal.changedPending = had;
    persistGoal(sess);
    toast(had ? '目标已更新' : '目标已设立');
  }
  async function clearGoal() {
    const sess = cur.session();
    if (!S.goal || !S.goal.content) return;
    if (!await confirmDialog('清除目标', '清除当前目标后，AI 将不再自动推进。', true)) return;
    S.goal = { content: '', changedPending: false };
    persistGoal(sess);
  }
  // 目标条：有目标时显示在输入框上方，让用户随时知道 AI 在追什么
  function renderGoalBar() {
    const bar = $('#goalBar');
    if (!bar) return;
    bar.innerHTML = '';
    const g = S.goal;
    if (!g || !g.content) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    // 目标最长 4096 字，单行必然被省略号截断。title 提示不顶用——原生 tooltip
    // 同样会截断长文本，触屏上更是没有 hover。故让文本本身可点开：
    // 收起时单行省略，展开时整段折行显示（超高再滚动）。
    const expanded = !!S.goalExpanded;
    const text = el('span', {
      class: 'goal-text' + (expanded ? ' expanded' : ''),
      text: g.content,
      title: expanded ? '点击收起' : '点击查看完整目标',
      onclick: () => { S.goalExpanded = !S.goalExpanded; renderGoalBar(); },
    });
    bar.append(
      el('span', { class: 'goal-chip', text: '目标' }),
      text,
      el('button', { class: 'goal-btn', text: '修改', onclick: async () => {
        const v = await promptDialog({ title: '修改目标', label: '目标内容', value: g.content });
        if (v) userSetGoal(v);
      } }),
      el('button', { class: 'goal-btn danger', text: '清除', onclick: clearGoal }));
  }
  function getWorkspaceNode() { return VFS.resolve(S.tree, ['workspace']); }

  // 边流边渲染 markdown 的关键：把半截语法补完再交给解析器。
  // 直接渲染未闭合的 ``` 会让后面所有内容都掉进代码块里，画面会抽搐；
  // 补一个收尾标记就能稳定成型，下一帧内容变长了再重算即可。
  function closeOpenMarkdown(src) {
    let s = src;
    // 围栏代码块：奇数个围栏说明最后一个没闭合
    const fences = s.match(/^```/gm);
    if (fences && fences.length % 2 === 1) {
      if (!s.endsWith('\n')) s += '\n';
      s += '```';
    }
    // 行内代码：只在最后一行里判断，避免跨行误判
    const lastLine = s.slice(s.lastIndexOf('\n') + 1);
    const ticks = (lastLine.match(/`/g) || []).length;
    if (ticks % 2 === 1) s += '`';
    // 未闭合的强调：** 或 *（成对出现才算）
    const bold = (s.match(/\*\*/g) || []).length;
    if (bold % 2 === 1) s += '**';
    // 表格正在打第一行时，补一条分隔线才能渲染成表格而不是纯文本
    return s;
  }
  // 流式渲染节流：每个分片都重排 DOM 会掉帧，60ms 一次肉眼已经连续
  const STREAM_RENDER_MS = 60;
  function paintStreamBubble(bubble) {
    try {
      bubble.innerHTML = MD.render(closeOpenMarkdown(S.streamBuf));
    } catch (_) {
      bubble.textContent = S.streamBuf;   // 解析异常时退回纯文本，绝不让气泡空掉
    }
  }
  // 流式临时消息的骨架：思考卡片在上，正文气泡在下（与落库后的渲染顺序一致，
  // 流式气泡换成正式消息时视觉上不跳动）。正文气泡按需创建——只有思考、
  // 还没开始说正文时，不该先摆一个空气泡在那里。
  function ensureStreamWrap() {
    let wrap = $('#streamMsg');
    if (!wrap) {
      const box = $('#chatScroll');
      if (!box) return null;
      wrap = el('div', { class: 'msg', id: 'streamMsg' }, avatarEl(), el('div', { class: 'body' }));
      box.append(wrap);
      // 有内容可看了，末尾那个笼统的加载圈就该让位（调用方已先填好缓冲）
      renderBusyIndicator(box);
    }
    return wrap;
  }
  function streamBubbleEl(wrap) {
    let b = wrap.querySelector('.bubble');
    if (!b) { b = el('div', { class: 'bubble streaming' }); wrap.querySelector('.body').append(b); }
    return b;
  }
  // 思考流：内容是模型的草稿，不当 markdown 渲染（半截的 ** 、# 会闪烁跳动），
  // 直接按纯文本追加。collapsed 档在思考期间展开直播，thinkCard 内部判定。
  function paintStreamThink(wrap) {
    const body = wrap.querySelector('.body');
    let card = body.querySelector('.think-card');
    if (!card) {
      card = thinkCard(S.reasonBuf, { live: true });
      if (!card) return;
      body.prepend(card);
    } else {
      card.querySelector('.think-body').textContent = S.reasonBuf;
    }
    // 思考体有 max-height，直播时钉在底部让最新的字始终可见
    const tb = card.querySelector('.think-body');
    tb.scrollTop = tb.scrollHeight;
  }
  // 流式输出：把分片实时追加到一个临时气泡里。
  // 缓冲绑定到发起会话（streamSession），切到别的会话时只累积不渲染，
  // 否则会把内容画到当前打开的那个会话里去。
  function renderStreamDelta(text) {
    const first = !S.streamBuf;
    S.streamBuf += text;
    saveStreamRemnant();
    // 非发起会话：静默累积，等切回来时由 renderChat 补画
    if (S.sessionId !== S.streamSession) return;
    pauseChatFollowIfMoved();
    const box = $('#chatScroll');
    if (!box) return;
    const wrap = ensureStreamWrap();
    if (!wrap) return;
    // 正文开始吐字 = 思考阶段结束，直播中的思考卡立即收起
    if (first) settleStreamThink();
    const bubble = streamBubbleEl(wrap);
    const now = Date.now();
    if (!S.streamPaintAt || now - S.streamPaintAt >= STREAM_RENDER_MS) {
      S.streamPaintAt = now;
      if (S.streamPaintTimer) { clearTimeout(S.streamPaintTimer); S.streamPaintTimer = null; }
      paintStreamBubble(bubble);
    } else if (!S.streamPaintTimer) {
      // 节流窗口内的分片不丢：安排一次补画，保证最后一个字也能出现
      S.streamPaintTimer = setTimeout(() => {
        S.streamPaintTimer = null; S.streamPaintAt = Date.now();
        pauseChatFollowIfMoved();
        const w = $('#streamMsg');
        if (w) paintStreamBubble(streamBubbleEl(w));
        if (stickingToBottom()) { const bx = $('#chatScroll'); if (bx) bx.scrollTop = bx.scrollHeight; }
      }, STREAM_RENDER_MS);
    }
    // 用户主动上翻查看历史时不强制拉回底部
    if (stickingToBottom()) box.scrollTop = box.scrollHeight;
  }
  // 思考分片：与正文同一套节流策略，但画的是思考卡片
  function renderReasoningDelta(text) {
    S.reasonBuf += text;
    saveStreamRemnant();
    // 设为隐藏时只累积不画：内容照常保存，界面上当它不存在
    if (S.settings.reasoningDisplay === 'hidden') return;
    if (S.sessionId !== S.streamSession) return;
    pauseChatFollowIfMoved();
    const box = $('#chatScroll');
    if (!box) return;
    const wrap = ensureStreamWrap();
    if (!wrap) return;
    const now = Date.now();
    if (!S.reasonPaintAt || now - S.reasonPaintAt >= STREAM_RENDER_MS) {
      S.reasonPaintAt = now;
      if (S.reasonPaintTimer) { clearTimeout(S.reasonPaintTimer); S.reasonPaintTimer = null; }
      paintStreamThink(wrap);
    } else if (!S.reasonPaintTimer) {
      S.reasonPaintTimer = setTimeout(() => {
        S.reasonPaintTimer = null; S.reasonPaintAt = Date.now();
        pauseChatFollowIfMoved();
        const w = $('#streamMsg');
        if (w) paintStreamThink(w);
        if (stickingToBottom()) { const bx = $('#chatScroll'); if (bx) bx.scrollTop = bx.scrollHeight; }
      }, STREAM_RENDER_MS);
    }
    if (stickingToBottom()) box.scrollTop = box.scrollHeight;
  }
  // 节流落库：刷新/关页面后能恢复已产出的部分，不至于从零开始
  function saveStreamRemnant() {
    renewOrAbort(S.projectId);
    if (S.streamSaveAt && Date.now() - S.streamSaveAt <= 800) return;
    S.streamSaveAt = Date.now();
    DB.put('config', { id: 'stream:' + S.projectId,
      value: { sessionId: S.streamSession, text: S.streamBuf, reasoning: S.reasonBuf, at: Date.now() } });
  }
  function clearStreamBubble() {
    if (S.streamPaintTimer) { clearTimeout(S.streamPaintTimer); S.streamPaintTimer = null; }
    if (S.reasonPaintTimer) { clearTimeout(S.reasonPaintTimer); S.reasonPaintTimer = null; }
    S.streamPaintAt = 0; S.reasonPaintAt = 0;
    const w = $('#streamMsg');
    if (w) w.remove();
    S.streamBuf = '';
    S.reasonBuf = '';
    // 流式段落结束但轮次还没完（接下来多半是工具调用），把加载圈接上
    renderActiveTool();
  }
  // 刷新/崩溃打断流式输出时，把落库的残段补成一条「已中断」消息。
  // 否则那段内容彻底消失，用户会觉得「刷新就从零开始」。
  async function recoverInterruptedStream(projectId) {
    const key = 'stream:' + projectId;
    const rec = await DB.get('config', key);
    if (!rec || !rec.value || !(rec.value.text || rec.value.reasoning)) return;
    const { sessionId, text, reasoning } = rec.value;
    await DB.del('config', key);
    const sess = S.sessions.find(s => s.id === sessionId);
    if (!sess) return;
    const partial = String(text || '').trim();
    const think = String(reasoning || '').trim();
    if (!partial && !think) return;
    // 若最后一条已是同内容的 assistant（说明当时已正常落库），不重复添加
    const last = sess.messages[sess.messages.length - 1];
    if (partial && last && last.role === 'assistant' && (last.content || '').startsWith(partial.slice(0, 40))) return;
    const m = { role: 'assistant',
      content: partial ? partial + '\n\n_（输出被中断）_' : '_（输出在思考阶段被中断）_' };
    if (think) m.reasoning_content = think;
    sess.messages.push(m);
    await saveSession(sess);
  }

  // 切回正在流式输出的会话时，把已累积的内容补画出来（renderChat 末尾调用）
  function restoreStreamBubble() {
    if (!S.running || S.sessionId !== S.streamSession) return;
    const showThink = S.reasonBuf && S.settings.reasoningDisplay !== 'hidden';
    if (!(S.streamBuf || showThink)) return;
    const box = $('#chatScroll');
    if (!box || $('#streamMsg')) return;
    const wrap = ensureStreamWrap();
    if (!wrap) return;
    if (showThink) paintStreamThink(wrap);
    if (S.streamBuf) paintStreamBubble(streamBubbleEl(wrap));
    if (stickingToBottom()) box.scrollTop = box.scrollHeight;
  }
  // 组装发给 API 的消息：system + 历史（过滤本地标记消息，压缩标记换摘要）
  function requestMessages(sess, activeImageId = null) {
    // 不注入文件树：它每写一次文件就变，放进 system 会让整段前缀每轮失效、
    // 服务端提示缓存永不命中。模型需要时用 list_dir / search 现查。
    const sys = { role: 'system',
      content: buildSystemPrompt(cur.allSkills(), S.settings.systemPromptOverride) };
    const hist = sess.messages
      .filter(m => m.role !== 'system-error')      // 系统错误仅本地展示，永不进上下文
      .filter(m => !m.displayOnly)                 // 已被压缩折叠的原文：界面留着，不再发送
      .map(m => m.role === 'compressed' ? { role: 'assistant', content: '[早前对话摘要]\n' + m.summary } : m)
      .map(m => m.attachments ? { ...m, content: Images.messageContent(m, S.tree, { enabled: S.settings.imageSending, activeId: activeImageId }) } : m)
      .map(stripLocalFields)
      .map(m => !S.settings.imageSending && Array.isArray(m.content)
        ? { ...m, content: Tokens.contentText(m.content) + '\n[图片发送已关闭，历史图片未发送]' } : m);
    // 出口统一净化：无论历史因何变成半截（中止、删除单轮、撤回、拒绝变更后重组），
    // 都不让非法的工具调用/结果流到 API，否则会形成每次都失败的死锁。
    // 思考剪裁放在净化之后：净化可能把残缺的 tool_calls 整个剥掉，
    // 该轮在「实际发出的请求」里就没有工具调用了，思考也就不必回传。
    return Tokens.pruneReasoning(Tokens.sanitizeMessages([sys, ...hist]));
  }
  // 剥离仅本地使用的字段：change 内含文件全文，若发给 API 会浪费大量 token。
  // 注意 reasoning_content 不在此列——DeepSeek 思考模式明确要求：带 tools 的请求
  // 必须在后续所有请求中完整回传 reasoning_content，剥掉会 400。无工具调用轮次的
  // 思考由出口处的 pruneReasoning 按轮裁掉（那部分传了也只是被忽略，纯浪费）。
  // 'reasoning' 是本项目早期版本用过的字段名，非 API 规范字段，仍然剥掉。
  const LOCAL_MSG_FIELDS = ['attachments', 'change', 'displayContent', 'stashPath', 'fullLength', 'at', 'hint', 'count', 'summary', 'msgId', 'goalPush', 'goalSet', 'goalText', 'reasoning', 'validationReport'];
  function stripLocalFields(m) {
    if (!LOCAL_MSG_FIELDS.some(k => k in m)) return m;
    const out = {};
    for (const [k, v] of Object.entries(m)) if (!LOCAL_MSG_FIELDS.includes(k)) out[k] = v;
    return out;
  }

  // ---------- 删除 / 撤回 / 工作目录回滚 ----------
  // 本轮范围：userIdx 起到下一条 user 消息前（系统错误不算轮次边界，但会被一并带走）
  function turnEnd(sess, userIdx) {
    for (let i = userIdx + 1; i < sess.messages.length; i++)
      if (sess.messages[i].role === 'user') return i;
    return sess.messages.length;
  }
  // 删除：仅移除本轮问答（用户消息 + AI 回复），不动文件、不动其后对话
  async function deleteTurn(userIdx) {
    const sess = cur.session();
    if (!await confirmDialog('删除本轮问答', '删除这条提问与对应的 AI 回复？后续对话保留，文件不受影响。', true)) return;
    const end = turnEnd(sess, userIdx);
    if (sess.messages.slice(userIdx, end).some(m => m.msgId && m.msgId === sess.contextInterrupted?.userMsgId)) delete sess.contextInterrupted;
    sess.messages.splice(userIdx, end - userIdx);
    markSessionDirty(sess);
    await saveSession(sess);
    renderChat(); renderCtxBadge();
  }
  // 撤回：回退聊天记录到本轮之前（删除本轮及其后全部消息），不动文件；
  //      输入框为空时把该轮提示词放回输入框，便于修改后重发
  async function retractChat(userIdx) {
    const sess = cur.session();
    const target = sess.messages[userIdx];
    // 撤回可能一路退到压缩标记之前：必须看到完整历史才能判断"折叠的原文
    // 是否会因此失去唯一对应的摘要"，分区加载残留的半截数组会误判。
    // 补全历史会让数组整体前移，原始下标失效，故按对象引用重新定位。
    await ensureFullHistory(sess);
    userIdx = sess.messages.indexOf(target);
    const dropCount = sess.messages.slice(userIdx).filter(m => m.role === 'user').length;
    if (!await confirmDialog('撤回聊天记录',
      `将删除本轮及之后的全部对话（共 ${dropCount} 轮提问）。文件不受影响；如需恢复文件请另用「工作目录回滚」。`, true)) return;
    const msg = sess.messages[userIdx];
    // 优先取暂存的原始长文本，否则用界面文本 / 注入文本
    let restore = msg && (msg.displayContent !== undefined ? msg.displayContent : Tokens.contentText(msg.content));
    const restoreImages = msg ? (msg.attachments || []) : [];
    if (msg && msg.stashPath) {
      try { restore = VFS.readFile(S.tree, msg.stashPath, { cap: Infinity }).content; }
      catch (_) { /* 临时文件已被清理，退回用界面文本 */ }
    }
    sess.messages.splice(userIdx);
    if (sess.contextInterrupted && !sess.messages.some(m => m.msgId === sess.contextInterrupted.userMsgId)) delete sess.contextInterrupted;
    restoreOrphanedFold(sess);
    markSessionDirty(sess);
    await saveSession(sess);
    const input = $('#chatInput');
    if (input && isInputEmpty(input) && (restore || restoreImages.length)) {
      setInputText(input, restore);
      for (const src of restoreImages) input.append(imageAttachment(src));
      scheduleDraftSave();
      input.focus();
    }
    renderChat(); renderCtxBadge();
  }
  // 撤回把唯一的活压缩标记也一并撤掉时，标记之前折叠的原文会失去对应的摘要——
  // 那段历史此后既不会被发送（displayOnly 仍是 true），也没有摘要替它说话，等于
  // 从上下文里永久消失。这里就是"撤回能拿回压缩前上下文"的实现：
  // 找回退后剩下的、最靠后的一条旧压缩标记（如果压缩发生过不止一次），让它重新
  // "接管"——它之前的折叠原文继续由它的摘要代表，不用动；它之后（曾属于被撤掉的
  // 那一轮压缩）的折叠原文则解除折叠，恢复成可发送的原文。全没有旧标记时，
  // 说明整段历史都已回到压缩前，全部解除折叠。这样任意时刻仍然最多一条活标记。
  function restoreOrphanedFold(sess) {
    if (sess.messages.some(m => m.role === 'compressed' && !m.displayOnly)) return;
    let boundary = -1;
    for (let i = sess.messages.length - 1; i >= 0; i--)
      if (sess.messages[i].role === 'compressed') { boundary = i; break; }
    if (boundary >= 0) delete sess.messages[boundary].displayOnly;
    for (let i = boundary + 1; i < sess.messages.length; i++)
      if (sess.messages[i].displayOnly) delete sess.messages[i].displayOnly;
  }

  async function rollbackTo(snapId) {
    const plan = Versioning.planRollback(S.snapshots, snapId);
    let msg = '将把文件回滚到该轮开始之前的状态，并删除其后的全部撤回点。此操作不可恢复。';
    if (plan.conflictSessions.length) {
      const names = plan.conflictSessions.map(id => (S.sessions.find(s => s.id === id) || {}).name || id).join('、');
      msg += '\n\n⚠ 警告：这会丢弃其他会话（' + names + '）之后产生的文件进度！';
    }
    if (!await confirmDialog('回滚文件', msg, true)) return;
    await doRollback(snapId, true);
  }

  async function doRollback(snapId, rerender) {
    const plan = Versioning.planRollback(S.snapshots, snapId);
    const ws = getWorkspaceNode();
    const restored = VFS.clone(plan.restoreTree);
    ws.children = restored.children;
    // 回滚整体换掉了文件内容，AI 手里的「已读」记录全部过期。
    // 不清的话它写任何一个自己刚改过的文件都会被判成「已被外部改动」而拒绝。
    S.readState.clear();
    for (const id of plan.deleteIds) await DB.del('snapshots', id);
    S.snapshots = S.snapshots.filter(s => !plan.deleteIds.includes(s.id));
    await saveTree();
    if (rerender) { renderChat(); renderFileTree(); toast('已回滚'); }
  }

  // ---------- 上下文指示器与主动压缩 ----------
  function renderCtxBadge() {
    const b = $('#ctxBadge');
    if (!b) return;
    const sess = cur.session();
    if (!sess) { b.textContent = ''; return; }
    const used = ContextBudget.occupied(S.settings, ContextBudget.cost(requestMessages(sess), Agent.toolDefinitions(cur.allSkills(), { imageSending: S.settings.imageSending })));
    const cap = S.settings.maxContextK * 1000;
    b.title = used >= S.settings.maxContextK * 1000 ? '上下文已满：' + ContextBudget.HINT : '上下文占用估算 / 上限';
    b.textContent = (sess.__partial === 'cap' ? '≥ ' : '') + (used >= 1000 ? (used / 1000).toFixed(1) + 'k' : used) + ' / ' + S.settings.maxContextK + 'k';
    b.className = used > cap * 0.8 ? 'warn' : '';
    b.id = 'ctxBadge';
  }
  async function ctxMenu() {
    if (!await confirmDialog('压缩上下文',
      '将把较早的对话历史交给模型总结为一条摘要，之后只发送摘要。\n原始消息在界面上保留，可以随时回看。', false)) return;
    await compressNow(true);
  }
  async function performCompression(sess, { interactive = false, signal, preserveUserId, reserveTokens = 0, toolDefs } = {}) {
    await ensureFullHistory(sess);
    toolDefs = toolDefs || Agent.toolDefinitions(cur.allSkills(), { imageSending: S.settings.imageSending });
    const cap = ContextBudget.limit(S.settings, ContextBudget.cost(requestMessages(sess), toolDefs));
    const fixed = ContextBudget.cost(requestMessages({ ...sess, messages: [] }), toolDefs);
    const available = cap - fixed - reserveTokens - 64;
    if (available < 512) throw ContextBudget.limitError(fixed + reserveTokens, cap);
    const summaryBudget = Math.min(3000, Math.floor(available * 0.2));
    const transport = Agent.createHttpTransport({ ...S.settings, stream: false, maxOutputTokens: summaryBudget }, [], { signal });
    const compressible = sess.messages.filter(m => m.role !== 'system-error' && !m.displayOnly);
    const out = await Compress.run(compressible, {
      retainedBudgetTokens: available - summaryBudget,
      preserveUserId,
      inputBudgetTokens: Math.floor(cap * COMPRESS_CONFIG.inputBudgetRatio),
      requestBudgetTokens: cap - summaryBudget - 64,
      summaryBudgetTokens: summaryBudget,
      maxWords: Math.min(COMPRESS_CONFIG.maxWords, summaryBudget),
      fileTree: VFS.overview(S.tree).slice(0, Math.floor(cap * 0.05)),
    }, transport, (i, total) => {
      if (interactive && total > 1) toast(`压缩中 ${i}/${total} 段…`);
    });
    if (!out) { if (interactive) toast('当前历史已在保留范围内，无需压缩'); return false; }
    if (signal && signal.aborted) throw Object.assign(new Error('已中止'), { name: 'AbortError' });
    const candidate = ContextBudget.fold(sess.messages, out);
    ContextBudget.requireReduction(requestMessages(sess), requestMessages({ ...sess, messages: candidate }), toolDefs);
    sess.messages = candidate;
    if (sess.contextInterrupted) {
      sess.contextInterrupted.compressed = true;
      if (ContextBudget.occupied(S.settings, ContextBudget.cost(requestMessages(sess), toolDefs)) <= S.settings.maxContextK * 1000)
        sess.contextInterrupted.message = '本轮已中断，可点击继续执行。';
    }
    markSessionDirty(sess);
    await saveSession(sess);
    if (S.lastError && S.lastError.sessionId === sess.id && S.lastError.actionLabel === '压缩上下文') S.lastError = null;
    if (interactive) toast('压缩完成');
    return true;
  }
  async function compressNow(interactive, reserveTokens = 0) {
    const sess = cur.session();
    if (!sess || S.running) return false;
    const acquired = lease.acquireForRun(S.projectId, sess.id);
    if (!acquired.ok) {
      const r = lease.blockedReason(S.projectId, sess.id) || acquired.conflict;
      toast(r && r.kind === 'session' ? '⚠ 其他窗口正在运行此会话，无法压缩。' : '⚠ 项目正被其他窗口执行（VFS 写保护），无法压缩。');
      return false;
    }
    setLockRun(sess.id, true);
    try {
      return await performCompression(sess, { interactive, signal: S.abort.signal, reserveTokens });
    } catch (e) {
      const full = ContextBudget.occupied(S.settings, ContextBudget.cost(requestMessages(sess), Agent.toolDefinitions(cur.allSkills(), { imageSending: S.settings.imageSending }))) >= S.settings.maxContextK * 1000;
      toast(e.name === 'AbortError' ? '压缩已中止' : '压缩失败: ' + e.message + (full && !e.message.includes(ContextBudget.HINT) ? '\n' + ContextBudget.HINT : ''));
      return false;
    } finally {
      setLockRun(sess.id, false);
      renderChat(); renderCtxBadge();
    }
  }

  // ---------- 文件下载（单文件原样 / 目录打 zip） ----------
  // 下载一个 Blob。两条路径：
  //   Android 壳 —— 注入了 AndroidDownload 接口时走 JS 分块传输。WebView 对
  //     <a download> + blob: 的支持不一致，游离的 <a> 点击也常常不触发下载。
  //   普通浏览器 —— 标准 <a download>。必须先入 DOM 再点，且不能立刻 revoke，
  //     否则 blob URL 在下载真正开始前就失效了。
  const CHUNK_BYTES = 512 * 1024;
  function downloadBlob(blob, filename) {
    const bridge = window.AndroidDownload;
    if (bridge && typeof bridge.startDownload === 'function') { androidDownload(bridge, blob, filename); return; }
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // 延迟清理：立即 revoke 会让下载来不及启动
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
  }
  // 分块经 JS 桥传给原生层。base64 编码后逐块 append，避免一次性把大文件
  // 塞进一个字符串——ZIP 打包整个工作区时可能有几十 MB。
  function androidDownload(bridge, blob, filename) {
    const mimetype = blob.type || 'application/octet-stream';
    let ok = false;
    // 传 size：原生侧据此显示确定进度、预检磁盘空间、收完后校验字节数。
    // 多传一个参数对旧壳无害——JS 侧多余实参会被忽略，@JavascriptInterface
    // 按签名匹配，两参版本照旧工作。
    try { ok = bridge.startDownload(filename, mimetype, blob.size) !== false; }
    catch (e) { toast('下载启动失败：' + e.message); return; }
    if (ok === false) { toast('下载被拒绝'); return; }
    let off = 0;
    const finish = err => {
      try { bridge.finishDownload(err || ''); } catch (_) { /* 壳已销毁则忽略 */ }
      if (err) toast('下载失败：' + err);
    };
    const next = () => {
      if (off >= blob.size) { finish(); return; }
      const rd = new FileReader();
      rd.onloadend = () => {
        // readAsDataURL 结果形如 data:<mime>;base64,<payload>
        const comma = String(rd.result || '').indexOf(',');
        const b64 = comma >= 0 ? String(rd.result).slice(comma + 1) : '';
        if (!b64) { finish('分块编码为空'); return; }
        try { bridge.appendChunk(b64); } catch (e) { finish(e.message); return; }
        off += CHUNK_BYTES;
        next();
      };
      rd.onerror = () => finish('读取分块失败');
      rd.readAsDataURL(blob.slice(off, off + CHUNK_BYTES));
    };
    next();
  }
  function collectZipEntries(node, prefix, out) {
    for (const name of Object.keys(node.children).sort()) {
      const c = node.children[name];
      if (c.type === 'file') out.push({ name: prefix + name, bytes: VFS.fileBytes(c), mtime: c.mtime });
      else { out.push({ name: prefix + name + '/', mtime: c.mtime }); collectZipEntries(c, prefix + name + '/', out); }
    }
    return out;
  }
  function projectTimestampName(projectName = cur.project()?.name) {
    const name = String(projectName || '未命名项目').trim() || '未命名项目';
    const date = new Date();
    const stamp = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()]
      .map((value, index) => String(value).padStart(index ? 2 : 4, '0')).join('');
    return name + '_' + stamp;
  }
  function projectArchiveName() {
    return projectTimestampName().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') + '.zip';
  }
  function downloadPath(path, { projectArchive = false } = {}) {
    const node = VFS.resolve(S.tree, VFS.normalize(path));
    if (!node) { toast('路径不存在'); return; }
    if (node.type === 'file') {
      downloadBlob(new Blob([VFS.fileBytes(node)], { type: node.encoding === 'base64' ? 'application/octet-stream' : 'text/plain;charset=utf-8' }), node.name);
    } else {
      const entries = collectZipEntries(node, '', []);
      if (!entries.length) { toast('文件夹为空'); return; }
      downloadBlob(ZIP.makeZip(entries), projectArchive ? projectArchiveName() : (node.name || 'workspace') + '.zip');
    }
  }
  function confirmWorldPlay(paths, projectName, initialName) {
    return new Promise(resolve => {
      const overlay = el('div', { class: 'overlay', id: 'worldPlayConfirm' });
      const select = el('select', { 'aria-label': '试玩世界目录', style: 'width:100%;min-width:0' }, ...paths.map(path => el('option', { value: path, text: path })));
      if (paths.includes(S.fmRoot)) select.value = S.fmRoot;
      const saveName = el('input', { type: 'text', 'aria-label': '存档名称', value: initialName, maxlength: 120, style: 'width:100%;min-width:0;box-sizing:border-box' });
      const nameError = el('div', { class: 'field-error', 'aria-live': 'polite' });
      const done = value => { overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(value); };
      overlay.dismissFromBack = () => done(null);
      const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } };
      document.addEventListener('keydown', onKey, true);
      const status = el('div', { class: 'play-validation', 'aria-live': 'polite' });
      const force = el('input', { type: 'checkbox', id: 'forceWorldPlay' });
      const forceLabel = el('label', { class: 'force-world-play' }, force, '强制跳转（格式错误可能导致无法游玩）');
      let report;
      const submit = el('button', { class: 'primary', text: '确认并前往', onclick: () => {
        if (!submit.disabled && (report.valid || force.checked) && saveName.value.trim())
          done({ root: select.value, force: force.checked, name: saveName.value.trim() });
      } });
      const updateSubmit = () => {
        const emptyName = !saveName.value.trim();
        submit.disabled = emptyName || (!report.valid && !force.checked);
        nameError.textContent = emptyName ? '请输入存档名称' : '';
      };
      const refresh = () => {
        force.checked = false;
        try {
          const tree = S.editorDirty ? WorldValidation.withDraft(S.tree, S.editorPath, $('#editorText').value) : S.tree;
          report = WorldValidation.check(tree, [select.value]);
        } catch (error) { report = { valid: false, issues: [{ root: select.value, path: select.value, message: '[校验失败] ' + error.message }] }; }
        status.dataset.state = report.valid ? 'valid' : 'invalid';
        status.replaceChildren(el('p', { text: validationSummary(report) + (report.valid ? '，可以前往试玩。' : '，请先修复，或勾选强制跳转。') }),
          validationIssueList(report, issue => { done(null); locateValidationIssue(issue); }));
        forceLabel.hidden = report.valid; updateSubmit();
      };
      force.onchange = updateSubmit;
      saveName.oninput = updateSubmit;
      select.onchange = refresh;
      validateWorkspace(); refresh();
      overlay.append(el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '前往异闻手记试玩' },
        el('h3', { text: '前往异闻手记试玩' }),
        el('p', { text: '项目：' + projectName }),
        el('label', { style: 'display:flex;flex-direction:column;gap:6px;margin:10px 0' }, '存档名称', saveName), nameError,
        el('label', { style: 'display:flex;flex-direction:column;gap:6px;margin:10px 0' }, '世界目录', select),
        el('p', { text: '将创建新的独立游玩存档，不覆盖之前的进度，也不修改设计者中的世界。导入完成后由你点击开始。' }),
        S.editorDirty ? el('p', { text: '当前文件有未保存修改，确认后会先保存，再打包。' }) : null,
        status, forceLabel,
        el('div', { class: 'foot' }, el('button', { text: '取消', onclick: () => done(null) }),
          submit)));
      document.body.append(overlay); saveName.focus(); saveName.select();
    });
  }
  async function playWorld() {
    if (S.handoffBusy) return;
    if (S.running || S.lockedBy) return toast('请先停止当前任务或等待另一标签页释放项目');
    S.handoffBusy = true;
    const projectId = S.projectId, projectName = cur.project()?.name || '新世界';
    let dialog, archive, worldName = projectName, transferId;
    const bridge = WorldHandoff.create();
    const close = () => { dialog?.close(); S.handoffBusy = false; };
    const handOver = async () => {
      try {
        dialog.update('正在将世界暂存到浏览器…');
        if (!transferId) transferId = await bridge.put(archive, worldName);
        dialog.update('世界已暂存，正在前往异闻手记…', 1);
        await new Promise(resolve => setTimeout(resolve, 60));
        location.assign('index.html#handoff=' + encodeURIComponent(transferId));
      } catch (error) {
        dialog.choices('暂存或跳转失败：' + error.message + '\n世界仍然保留。你可以重试，或下载 ZIP 后在异闻手记中从文件导入。', [
          ['重试', handOver], ['下载 ZIP', () => TransferDialog.download(archive, worldName)], ['返回编辑', close],
        ]);
      }
    };
    try {
      let decision, proposedName = projectTimestampName(projectName);
      for (;;) {
        decision = await confirmWorldPlay(WorldHandoff.roots(S.tree), projectName, proposedName);
        if (!decision) { close(); return; }
        proposedName = decision.name;
        if (S.projectId !== projectId || S.running || S.lockedBy || lease.isHeldByOther(projectId)) throw Error('项目状态已变化，请重新发起试玩');
        dialog = TransferDialog.open('准备前往异闻手记');
        dialog.update('正在保存编辑与草稿…');
        await new Promise(resolve => setTimeout(resolve, 0));
        if (S.editorDirty) await saveEditor();
        await flushDraft();
        // The saved tree is authoritative. Never reuse a passing result from before an awaited save.
        validateWorkspace();
        if (WorldValidation.check(S.tree, [decision.root]).valid || decision.force) break;
        dialog.close(); dialog = null;
        toast('保存后的内容存在格式错误，请重新确认');
      }
      const root = decision.root;
      const node = VFS.resolve(S.tree, VFS.normalize(root));
      if (!node || node.type !== 'dir') throw Error('世界目录不存在');
      worldName = decision.name;
      const entries = [];
      let nextPaint = Date.now();
      async function collect(dir, prefix) {
        for (const name of Object.keys(dir.children).sort()) {
          // A designer preview is a fresh world, not a replay of imported game history.
          if (!prefix && name === '.trpg-save.json') continue;
          const child = dir.children[name];
          if (child.type === 'file') entries.push({ name: prefix + name, bytes: VFS.fileBytes(child), mtime: child.mtime });
          else { entries.push({ name: prefix + name + '/', mtime: child.mtime }); await collect(child, prefix + name + '/'); }
          if (Date.now() >= nextPaint) { dialog.update('正在整理世界文件：' + entries.length + ' 项'); await new Promise(resolve => setTimeout(resolve, 0)); nextPaint = Date.now() + 12; }
        }
      }
      await collect(node, '');
      if (!entries.some(e => !e.name.endsWith('/'))) throw Error('世界目录为空，请先创建世界文件');
      archive = await ZIP.makeZipAsync(entries, p => dialog.update('正在打包 ZIP：' + p.completed + ' / ' + p.total + ' 项 · 已处理 ' + (p.bytes / 1048576).toFixed(1) + ' MB', p.completed / p.total));
      await handOver();
    } catch (error) {
      dialog ||= TransferDialog.open('暂时无法试玩');
      dialog.choices(error.message, [['返回编辑', close]]);
    }
  }
  function exportWorkspace() {
    const ws = getWorkspaceNode();
    const entries = collectZipEntries(ws, '', []);
    if (!entries.length) { toast('工作区为空'); return; }
    downloadBlob(ZIP.makeZip(entries), projectArchiveName());
  }

  // ---------- 文件管理器 ----------
  function closeCtxMenu() {
    const m = $('.ctx-menu'); if (m) m.remove();
    $('#uploadMenuBtn')?.setAttribute('aria-expanded', 'false');
    $('#projectBtn')?.setAttribute('aria-expanded', 'false');
  }
  // 长按刚弹过菜单时，浏览器会补发一次原生 contextmenu。若不拦下：
  // ① 这里会把刚开的菜单关掉，② 元素上的 oncontextmenu 会再开一次——即闪一下。
  const isEchoContextMenu = () => (Date.now() - S.lastLongPressAt) < 900;
  document.addEventListener('contextmenu', e => {
    if (isEchoContextMenu()) { e.preventDefault(); e.stopPropagation(); return; }
    if (!e.target.closest('.ctx-menu')) closeCtxMenu();
  }, true);
  document.addEventListener('click', closeCtxMenu);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCtxMenu(); });

  function showCtxMenu(x, y, items, minWidth) {
    closeCtxMenu();
    const menu = el('div', { class: 'ctx-menu' });
    if (minWidth) menu.style.minWidth = minWidth + 'px';
    for (const it of items) {
      if (it === '-') { menu.append(el('div', { class: 'sep' })); continue; }
      menu.append(el('button', { class: it.danger ? 'danger' : '', onclick: e => { e.stopPropagation(); closeCtxMenu(); it.action(); } },
        icon(it.icon), el('span', { text: it.label })));
    }
    document.body.append(menu);
    // 防溢出
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }
  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function showProperties(path) {
    const st = VFS.stat(S.tree, path);
    const ov = el('div', { class: 'overlay', onclick: e => { if (e.target === ov) ov.remove(); } });
    const rows = [['名称', st.name], ['位置', displayPath(path)], ['类型', st.type === 'dir' ? '文件夹' : '文本文件']];
    if (st.type === 'file') {
      rows.push(['大小', fmtBytes(st.bytes)], ['字符数', String(st.chars)], ['行数', String(st.lines)]);
    } else {
      rows.push(['包含', st.files + ' 个文件，' + st.dirs + ' 个文件夹'], ['总字符数', String(st.chars)]);
    }
    rows.push(['创建时间', fmtTime(st.ctime)], ['修改时间', fmtTime(st.mtime)]);
    ov.append(el('div', { class: 'modal' },
      el('h3', { text: '属性' }),
      el('table', { class: 'prop-table' }, ...rows.map(([k, v]) => el('tr', {}, el('td', { text: k }), el('td', { text: v })))),
      el('div', { class: 'foot' }, el('button', { class: 'primary', text: '关闭', onclick: () => ov.remove() }))));
    document.body.append(ov);
  }

  async function fmRename(path) {
    const node = VFS.resolve(S.tree, VFS.normalize(path));
    const name = await promptDialog({
      title: '重命名', label: node.type === 'dir' ? '文件夹名称' : '文件名称',
      value: node.name, validate: nameValidator,
    });
    if (!name || name === node.name) { fmSelect(path); return; }
    const parts = VFS.normalize(path);
    try {
      const renamed = '/' + [...parts.slice(0, -1), name].join('/');
      VFS.move(S.tree, path, renamed);
      S.selectedPath = renamed;
      // 文件列表与编辑器可并排显示；改名后保存仍须落到同一个文件。
      if (S.editorPath && (S.editorPath === path || S.editorPath.startsWith(path + '/'))) {
        S.editorPath = renamed + S.editorPath.slice(path.length);
        $('#editorPath').textContent = displayPath(S.editorPath);
      }
      await saveTree(); renderFileTree();
    } catch (e) { toast(e.message); }
    fmSelect(S.selectedPath);
  }
  async function fmDelete(path) {
    const node = VFS.resolve(S.tree, VFS.normalize(path));
    const isDir = node.type === 'dir';
    if (!await confirmDialog('删除' + (isDir ? '文件夹' : '文件'),
      `删除「${displayPath(path)}」${isDir ? ' 及其全部内容' : ''}？此操作立即生效（可通过历史轮次的工作目录回滚恢复）。`, true)) { fmSelect(path); return; }
    try {
      VFS.deletePath(S.tree, path);
      S.selectedPath = null;
      if (S.view === 'editor' && S.editorPath && (S.editorPath === path || S.editorPath.startsWith(path + '/'))) {
        S.view = 'chat'; S.editorPath = null; S.editorDirty = false;
      }
      await saveTree(); renderAll();
    } catch (e) { toast(e.message); }
    fmSelect(S.selectedPath);
  }
  async function fmNewFolder(parentPath) {
    const name = await promptDialog({ title: '新建文件夹', label: '文件夹名称', value: '新建文件夹', okText: '创建', validate: nameValidator });
    if (!name) return;
    try { VFS.mkdir(S.tree, parentPath + '/' + name); await saveTree(); renderFileTree(); }
    catch (e) { toast(e.message); }
  }
  async function fmNewFile(parentPath) {
    const name = await promptDialog({ title: '新建文件', label: '文件名称', value: '新建文件.md', okText: '创建',
      validate: v => nameValidator(v) || (VFS.resolve(S.tree, VFS.normalize(parentPath + '/' + v)) ? '已存在同名文件或目录' : null) });
    if (!name) return;
    const path = parentPath + '/' + name;
    try { VFS.writeFile(S.tree, path, ''); await saveTree(); renderFileTree(); openEditor(path); }
    catch (e) { toast(e.message); }
  }
  function fmSelect(path) {
    S.selectedPath = path;
    for (const r of document.querySelectorAll('#fileTree .tree-item'))
      r.classList.toggle('selected', r.dataset.path === path);
    const row = document.querySelector('#fileTree .tree-item.selected');
    if (row) row.focus({ preventScroll: false });
    else $('#filePanel')?.focus({ preventScroll: true });
  }
  function fmVisibleRows() { return [...document.querySelectorAll('#fileTree .tree-item')]; }
  async function fmPaste() {
    const cb = S.clipboard;
    if (!cb) return;
    const node = VFS.resolve(S.tree, VFS.normalize(cb.path));
    if (!node) { S.clipboard = null; toast('来源已不存在'); return; }
    // 目标目录：选中目录 → 其内；选中文件 → 其父目录；无选中 → 根
    let destDir = '/workspace';
    if (S.selectedPath) {
      const sel = VFS.resolve(S.tree, VFS.normalize(S.selectedPath));
      destDir = (sel && sel.type === 'dir') ? S.selectedPath
        : '/' + VFS.normalize(S.selectedPath).slice(0, -1).join('/');
    }
    const base = VFS.normalize(cb.path).pop();
    let destPath = destDir + '/' + base;
    // 命名冲突：追加「 - 副本」
    while (VFS.resolve(S.tree, VFS.normalize(destPath))) {
      const m = base.match(/^(.*?)(\.[^.]+)?$/);
      destPath = destDir + '/' + m[1] + ' - 副本' + (m[2] || '');
      if (VFS.resolve(S.tree, VFS.normalize(destPath))) destPath = destDir + '/' + m[1] + ' - 副本' + Date.now() % 1000 + (m[2] || '');
    }
    try {
      if (cb.cut) { VFS.move(S.tree, cb.path, destPath); S.clipboard = null; }
      else VFS.copy(S.tree, cb.path, destPath);
      await saveTree(); renderFileTree(); fmSelect(destPath);
    } catch (e) { toast(e.message); }
  }
  function fmKeydown(e) {
    // 按焦点区分列表与编辑器；桌面编辑器打开时，旁边的文件列表仍可操作。
    if (e.defaultPrevented || (e.target !== e.currentTarget && !e.target.closest('#fileTree')) ||
        e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const rows = fmVisibleRows();
    const idx = rows.findIndex(r => r.dataset.path === S.selectedPath);
    const sel = S.selectedPath && VFS.resolve(S.tree, VFS.normalize(S.selectedPath));
    // ↑/↓ 移动选择
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      const next = e.key === 'ArrowDown' ? Math.min(idx + 1, rows.length - 1) : Math.max(idx - 1, 0);
      fmSelect(rows[next === -1 ? 0 : next].dataset.path);
      return;
    }
    // Backspace → 上一级
    if (e.key === 'Backspace') { e.preventDefault(); fmGoUp(); return; }
    if (mod && e.key.toLowerCase() === 'a') {     // 全部展开
      e.preventDefault(); fmExpandAll(S.fmRoot); return;
    }
    if (!sel) {
      if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); fmPaste(); }
      return;
    }
    // →/← 展开或收起目录
    if (e.key === 'ArrowRight' && sel.type === 'dir') {
      e.preventDefault();
      if (!S.expanded.has(S.selectedPath) && Object.keys(sel.children).length) fmToggleExpand(S.selectedPath);
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (sel.type === 'dir' && S.expanded.has(S.selectedPath)) fmToggleExpand(S.selectedPath);
      else {
        const parent = '/' + VFS.normalize(S.selectedPath).slice(0, -1).join('/');
        if (VFS.normalize(parent).length >= 1 && parent !== S.fmRoot) fmSelect(parent);
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (sel.type === 'file') openEditor(S.selectedPath);
      else fmEnter(S.selectedPath);
      return;
    }
    if (e.key === 'F2') { e.preventDefault(); fmRename(S.selectedPath); return; }
    if (e.key === 'Delete') { e.preventDefault(); fmDelete(S.selectedPath); return; }
    if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); S.clipboard = { path: S.selectedPath, cut: false }; toast('已复制'); return; }
    if (mod && e.key.toLowerCase() === 'x') { e.preventDefault(); S.clipboard = { path: S.selectedPath, cut: true }; toast('已剪切'); return; }
    if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); fmPaste(); return; }
  }

  // 复制文本到剪贴板。clipboard API 在文档失焦/非安全上下文下会抛错，
  // 因此失败时一律回退到 execCommand，而不是直接报错。
  function legacyCopy(text) {
    const ta = el('textarea', { style: 'position:fixed;opacity:0;top:-1000px;left:0' });
    ta.value = text;
    document.body.append(ta);
    ta.focus(); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    return ok;
  }
  async function copyText(text, label) {
    const shown = text.length > 40 ? text.slice(0, 40) + '…' : text;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        toast((label || '已复制') + '：' + shown);
        return;
      } catch (_) { /* 失焦等原因失败 → 走下方回退 */ }
    }
    if (legacyCopy(text)) toast((label || '已复制') + '：' + shown);
    else toast('复制失败，请手动选择文本');
  }

  function fileMenuItems(path, node) {
    const items = [];
    if (node.type === 'file') {
      items.push({ icon: 'open', label: '打开', action: () => openEditor(path) });
      if (S.pending[path]) items.push(
        { icon: 'diff', label: '审阅变更…', action: () => openReview(path) },
        { icon: 'check', label: '接受变更', action: () => acceptFile(path) },
        { icon: 'undo', label: '拒绝变更', danger: true, action: () => rejectFile(path) });
    } else {
      const empty = !Object.keys(node.children).length;
      items.push({ icon: 'enter', label: '进入', action: () => fmEnter(path) });
      if (!empty) items.push({ icon: S.expanded.has(path) ? 'collapseAll' : 'expandAll',
        label: S.expanded.has(path) ? '收起' : '展开', action: () => fmToggleExpand(path) });
      items.push(
        { icon: 'expandAll', label: '全部展开', action: () => { S.expanded.add(path); fmExpandAll(path); } },
        { icon: 'collapseAll', label: '全部收起', action: () => fmCollapseAll(path) },
        '-',
        { icon: 'filePlus', label: '新建文件', action: () => fmNewFile(path) },
        { icon: 'folderPlus', label: '新建文件夹', action: () => fmNewFolder(path) });
    }
    items.push('-',
      { icon: 'pencil', label: '重命名', action: () => fmRename(path) },
      { icon: 'copy', label: '复制', action: () => { S.clipboard = { path, cut: false }; toast('已复制'); } },
      { icon: 'cut', label: '剪切', action: () => { S.clipboard = { path, cut: true }; toast('已剪切'); } });
    if (S.clipboard && node.type === 'dir')
      items.push({ icon: 'paste', label: '粘贴到此处', action: () => { fmSelect(path); fmPaste(); } });
    items.push('-',
      { icon: 'link', label: '复制路径', action: () => copyText(displayPath(path), '已复制路径') },
      { icon: 'tag', label: '复制名称', action: () => copyText(node.name, '已复制名称') });
    items.push('-',
      { icon: 'download', label: node.type === 'dir' ? '下载 (zip)' : '下载', action: () => downloadPath(path) },
      '-',
      { icon: 'info', label: '属性', action: () => showProperties(path) },
      '-',
      { icon: 'trash', label: '删除', danger: true, action: () => fmDelete(path) });
    return items;
  }

  // 目录展开/折叠与视角导航
  function fmToggleExpand(path) {
    if (S.expanded.has(path)) S.expanded.delete(path); else S.expanded.add(path);
    renderFileTree();
  }
  function fmEnter(path) {
    S.fmRoot = path; S.selectedPath = null;
    renderFileTree();
  }
  function fmGoUp() {
    const parts = VFS.normalize(S.fmRoot);
    if (parts.length <= 1) return;              // 已在 /workspace
    S.fmRoot = '/' + parts.slice(0, -1).join('/');
    S.selectedPath = null;
    renderFileTree();
  }
  function collectDirs(node, prefix, out) {
    for (const name of Object.keys(node.children)) {
      const c = node.children[name];
      if (c.type === 'dir') { out.push(prefix + '/' + name); collectDirs(c, prefix + '/' + name, out); }
    }
    return out;
  }
  function fmExpandAll(rootPath) {
    const node = VFS.resolve(S.tree, VFS.normalize(rootPath));
    if (!node) return;
    for (const d of collectDirs(node, rootPath, [])) S.expanded.add(d);
    renderFileTree();
  }
  function fmCollapseAll(rootPath) {
    const node = VFS.resolve(S.tree, VFS.normalize(rootPath));
    if (!node) return;
    for (const d of collectDirs(node, rootPath, [])) S.expanded.delete(d);
    S.expanded.delete(rootPath);
    renderFileTree();
  }

  function renderFileTree() {
    const box = $('#fileTree');
    if (!box) return;
    const restoreFocus = box.contains(document.activeElement);
    box.innerHTML = '';
    // 面包屑与上一级按钮
    const rootParts = VFS.normalize(S.fmRoot);
    const pathLbl = $('#fmPath');
    if (pathLbl) pathLbl.textContent = rootParts.length <= 1 ? '文件' : displayPath(S.fmRoot);
    const upBtn = $('#fmUpBtn');
    if (upBtn) upBtn.style.visibility = rootParts.length <= 1 ? 'hidden' : 'visible';

    const root = VFS.resolve(S.tree, rootParts);
    if (!root) { S.fmRoot = '/workspace'; return renderFileTree(); }

    (function walk(node, depth, prefix) {
      for (const name of Object.keys(node.children).sort((a, b) => {
        const A = node.children[a], B = node.children[b];
        return (A.type === B.type) ? a.localeCompare(b) : (A.type === 'dir' ? -1 : 1);
      })) {
        const c = node.children[name];
        const path = prefix + '/' + name;
        const isDir = c.type === 'dir';
        const isOpen = isDir && S.expanded.has(path);
        const empty = isDir && !Object.keys(c.children).length;
        // 展开箭头：目录才有；空目录显示占位以保持缩进对齐
        const chev = isDir
          ? el('span', { class: 'tchev' + (isOpen ? ' open' : '') + (empty ? ' empty' : ''), text: empty ? '' : '▸',
              onclick: e => { e.stopPropagation(); if (!empty) fmToggleExpand(path); } })
          : el('span', { class: 'tchev empty' });
        // 待审变更红点：文件看自身，目录看其下是否有待审文件
        const pendingHere = isDir ? Pending.dirHasPending(S.pending, path) : !!S.pending[path];
        const row = el('div', { class: 'tree-item' + (S.selectedPath === path ? ' selected' : '') + (isDir ? ' is-dir' : ''),
          tabindex: '-1', 'data-path': path, draggable: 'true', style: 'padding-left:' + (4 + depth * 15) + 'px' },
          chev,
          icon(isDir ? (isOpen ? 'folderOpen' : 'folder') : 'doc', isDir ? 'ticon dir' : 'ticon'),
          el('span', { class: 'name', text: name, title: displayPath(path) }),
          pendingHere ? el('span', { class: 'pending-dot', title: '有未审阅的 AI 改动' }) : null);
        row.onclick = e => {
          e.stopPropagation();
          if (isDir) { fmSelect(path); if (!empty) fmToggleExpand(path); return; }
          if (isMobile() || S.selectedPath === path) { fmSelect(path); openEditor(path); return; }
          fmSelect(path);
        };
        row.ondblclick = e => { e.stopPropagation(); if (!isDir) openEditor(path); else fmEnter(path); };
        row.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); fmSelect(path); showCtxMenu(e.clientX, e.clientY, fileMenuItems(path, c)); };
        attachLongPress(row, () => { fmSelect(path); return fileMenuItems(path, c); });
        // 拖拽源
        row.addEventListener('dragstart', e => {
          e.dataTransfer.setData('text/vfspath', path);
          e.dataTransfer.effectAllowed = 'move';
          row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
        // 目录作为放置目标
        if (isDir) {
          row.addEventListener('dragover', e => {
            if (e.dataTransfer.types.includes('text/vfspath') || [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.stopPropagation(); row.classList.add('drag-over'); }
          });
          row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
          row.addEventListener('drop', async e => {
            e.preventDefault(); e.stopPropagation(); row.classList.remove('drag-over');
            row.classList.remove('drag-over-file');
            if (e.dataTransfer.files && e.dataTransfer.files.length) {
              const projectId = S.projectId;
              try {
                const files = await WorkspaceImport.droppedFiles(e.dataTransfer);
                if (S.projectId === projectId) await importDroppedFiles(files, path);
                else toast('项目已切换，请重新上传');
              } catch (err) { toast('读取文件夹失败：' + err.message); }
              return;
            }
            await fmMoveTo(e.dataTransfer.getData('text/vfspath'), path);
          });
        }
        box.append(row);
        if (isDir && isOpen) walk(c, depth + 1, path);
      }
    })(root, 0, S.fmRoot);

    if (!box.children.length)
      box.append(el('div', { class: 'tree-empty', text: '该区域文件为空，可考虑上传或创建一些文件' }));
    renderReviewBar();

    // 空白处：右键菜单 + 拖放
    box.oncontextmenu = e => {
      if (e.target !== box) return;
      e.preventDefault();
      fmClearSelection();
      showCtxMenu(e.clientX, e.clientY, blankMenuItems());
    };
    attachLongPress(box, () => { fmClearSelection(); return blankMenuItems(); });
    box.onclick = e => { if (e.target === box) fmClearSelection(); };
    if (restoreFocus) fmSelect(S.selectedPath);
  }
  function fmClearSelection() {
    S.selectedPath = null;
    for (const r of document.querySelectorAll('#fileTree .tree-item')) r.classList.remove('selected');
  }
  function blankMenuItems() {
    const items = [
      { icon: 'filePlus', label: '新建文件', action: () => fmNewFile(S.fmRoot) },
      { icon: 'folderPlus', label: '新建文件夹', action: () => fmNewFolder(S.fmRoot) },
    ];
    if (S.clipboard) items.push({ icon: 'paste', label: '粘贴', action: () => fmPaste() });
    items.push('-',
      { icon: 'expandAll', label: '全部展开', action: () => fmExpandAll(S.fmRoot) },
      { icon: 'collapseAll', label: '全部收起', action: () => fmCollapseAll(S.fmRoot) });
    if (VFS.normalize(S.fmRoot).length > 1)
      items.push('-', { icon: 'upLevel', label: '上一级', action: fmGoUp });
    items.push('-',
      { icon: 'upload', label: '上传文件', action: () => pickFilesToUpload() },
      { icon: 'archive', label: '上传 ZIP 并解压', action: () => pickFilesToUpload('zip') },
      { icon: 'folder', label: '上传文件夹', action: () => pickFilesToUpload(true) },
      { icon: 'download', label: '下载当前目录 (zip)', action: () => downloadPath(S.fmRoot) });
    return items;
  }
  // ---------- 外部文件与目录导入 ----------
  function showUploadMenu(e) {
    e.stopPropagation();
    const button = e.currentTarget, open = button.getAttribute('aria-expanded') === 'true';
    closeCtxMenu();
    if (open) return;
    const rect = button.getBoundingClientRect();
    showCtxMenu(rect.left, rect.bottom + 5, [
      { icon: 'doc', label: '上传文件', action: () => pickFilesToUpload() },
      { icon: 'folder', label: '上传文件夹', action: () => pickFilesToUpload(true) },
      { icon: 'archive', label: '上传 ZIP 并解压', action: () => pickFilesToUpload('zip') },
    ], 180);
    button.setAttribute('aria-expanded', 'true');
    const menu = $('.ctx-menu'), items = [...menu.querySelectorAll('button')];
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '上传');
    items.forEach(item => item.setAttribute('role', 'menuitem'));
    items[0].focus();
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.stopPropagation(); closeCtxMenu(); button.focus(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const index = items.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
          (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next].focus();
      }
      if (event.key === 'Tab') closeCtxMenu();
    });
  }

  function importConflictDialog(tree, destDir, entries) {
    return new Promise(resolve => {
      const choices = {}, ov = el('div', { class: 'overlay' });
      let preview;
      const done = result => { ov.remove(); document.removeEventListener('keydown', onKey, true); resolve(result); };
      ov.dismissFromBack = () => done(null);
      const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
      const rows = el('div', { class: 'import-conflict-list' });
      const summary = el('div', { class: 'hint', 'aria-live': 'polite' });
      const info = item => (item.type === 'dir' ? '文件夹' : item.size.toLocaleString() + ' 字节') +
        ' · 修改时间：' + (item.mtime === null ? '未知' : new Date(item.mtime).toLocaleString()) + ' · ' + item.source;
      const labels = { keep: '保留两份（自动重命名）', skip: '跳过', replace: '覆盖现有文件' };
      function render() {
        preview = WorkspaceImport.plan(tree, destDir, entries, choices);
        rows.replaceChildren();
        for (const c of preview.conflicts) {
          choices[c.id] = c.choice;
          const select = el('select', { 'aria-label': '处理 ' + c.path, onchange: e => {
            choices[c.id] = e.target.value; render();
            [...rows.querySelectorAll('select')].find(s => s.getAttribute('aria-label') === '处理 ' + c.path)?.focus();
          } }, ...Object.entries(labels).filter(([key]) => key !== 'replace' || c.canReplace)
            .map(([key, label]) => el('option', { value: key, text: label })));
          select.value = c.choice;
          rows.append(el('div', { class: 'import-conflict' },
            el('strong', { text: c.path }),
            el('div', { text: '现有：' + info(c.existing) }),
            el('div', { text: '上传：' + info(c.incoming) }), select,
            el('div', { class: 'hint', text: c.result ? '导入到：' + c.result : '本项及其子文件将跳过' })));
        }
        const replacements = preview.conflicts.filter(c => c.choice === 'replace').length;
        summary.textContent = `${preview.conflicts.length} 处冲突，准备导入 ${preview.count} 个文件` +
          (replacements ? `，其中 ${replacements} 处将覆盖。` : '。');
      }
      const bulk = el('div', { class: 'import-conflict-actions' },
        ...[['keep', '全部保留两份'], ['skip', '全部跳过'], ['replace', '全部覆盖（仅文件）']].map(([action, text]) =>
          el('button', { text, onclick: () => {
            for (const c of preview.conflicts) choices[c.id] = action === 'replace' && !c.canReplace ? 'keep' : action;
            render();
          } })));
      ov.append(el('div', { class: 'modal import-conflicts', role: 'dialog', 'aria-modal': 'true', 'aria-label': '上传文件冲突' },
        el('h3', { text: '上传文件冲突' }),
        el('div', { class: 'hint', text: '逐项选择或统一处理。相同文件夹会合并；文件与文件夹重名时不允许覆盖。确认前不会写入任何文件。' }),
        bulk, summary, rows,
        el('div', { class: 'foot' }, el('button', { text: '取消', onclick: () => done(null) }),
          el('button', { class: 'primary', text: '确认导入', onclick: () => done(preview) }))));
      render(); document.addEventListener('keydown', onKey, true); document.body.append(ov);
      ov.querySelector('select, button').focus();
    });
  }

  async function importDroppedFiles(fileList, destDir, options = {}) {
    const projectId = S.projectId;
    try {
      const entries = await WorkspaceImport.prepare([...fileList], options);
      if (!entries.length) return;
      const binary = entries.filter(e => e.encoding === 'base64' && !Documents.supported(e.name));
      if (binary.length && !await confirmDialog('非文本文件提醒',
        '以下文件可以保存和下载；开启多模态后，图片可由 AI 按需查看，列表中的其他非文本类型暂不支持解析：\n\n' +
        binary.map(e => e.name).join('\n') +
        (!options.extractZip && binary.some(e => /\.zip$/i.test(e.name)) ? '\n\nZIP 将作为普通文件保存；需要解压请使用“上传 ZIP 并解压”。' : '') +
        '\n\n点击“我已知晓”后继续上传。', false, '我已知晓')) return;
      // 读取文件、确认弹窗期间可能切换项目，不能把文件导入另一个项目。
      if (S.projectId !== projectId) { toast('项目已切换，请重新上传'); return; }
      const blocked = lease.blockedReason(S.projectId, S.sessionId);
      if (S.running || blocked) { toast('项目正在执行，请结束后再上传'); return; }
      let preview;
      while (true) {
        const snapshot = VFS.clone(S.tree), baseline = JSON.stringify(snapshot);
        preview = WorkspaceImport.plan(snapshot, destDir, entries);
        if (preview.conflicts.length) preview = await importConflictDialog(snapshot, destDir, entries);
        if (!preview) return;
        if (S.projectId !== projectId) { toast('项目已切换，请重新上传'); return; }
        if (S.running || lease.blockedReason(projectId, S.sessionId)) { toast('项目正在执行，请结束后再上传'); return; }
        if (baseline === JSON.stringify(S.tree)) break;
        toast('工作区已有变化，请重新核对文件冲突');
      }
      const previous = S.tree;
      S.tree = preview.tree;
      try { await saveTree(); } catch (e) { if (S.tree === preview.tree) S.tree = previous; throw e; }
      if (S.projectId !== projectId) return;
      S.readState.clear(); renderFileTree(); toast(`已导入 ${preview.count} 个文件`);
    } catch (e) { toast('导入失败：' + e.message); }
  }

  function pickFilesToUpload(folder = false) {
    // onclick 会传 MouseEvent，只有显式 true 才启用目录选择。
    const projectId = S.projectId, destDir = S.fmRoot;
    const inp = el('input', { type: 'file', multiple: 'true', style: 'display:none',
      onchange: async e => {
        if (S.projectId === projectId) await importDroppedFiles(e.target.files, destDir, { extractZip: folder === 'zip' });
        else toast('项目已切换，请重新上传');
        inp.remove();
      }, oncancel: () => inp.remove() });
    if (folder === true) inp.setAttribute('webkitdirectory', '');
    if (folder === 'zip') inp.setAttribute('accept', '.zip,application/zip');
    document.body.append(inp);
    inp.click();
  }

  // 文件面板整体作为外部文件放置目标
  function setupPanelDrop() {
    const panel = $('#filePanel');
    const tree = $('#fileTree');
    if (!panel) return;
    let depth = 0;
    const isExternal = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    panel.addEventListener('dragenter', e => {
      if (!isExternal(e)) return;
      e.preventDefault(); depth++; panel.classList.add('drag-over-file');
    });
    panel.addEventListener('dragover', e => {
      if (isExternal(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; return; }
      // 内部条目拖到空白区 → 移动到当前目录
      if (e.target === tree && e.dataTransfer.types.includes('text/vfspath')) {
        e.preventDefault(); tree.classList.add('drag-over-root');
      }
    });
    panel.addEventListener('dragleave', e => {
      if (isExternal(e)) { depth = Math.max(0, depth - 1); if (!depth) panel.classList.remove('drag-over-file'); }
      if (e.target === tree) tree.classList.remove('drag-over-root');
    });
    panel.addEventListener('drop', async e => {
      depth = 0; panel.classList.remove('drag-over-file'); tree.classList.remove('drag-over-root');
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        e.preventDefault();
        if (S.view === 'editor') { toast('请先返回文件列表再拖入文件'); return; }
        const projectId = S.projectId, destDir = S.fmRoot;
        try {
          const files = await WorkspaceImport.droppedFiles(e.dataTransfer);
          if (S.projectId === projectId) await importDroppedFiles(files, destDir);
          else toast('项目已切换，请重新上传');
        } catch (err) { toast('读取文件夹失败：' + err.message); }
        return;
      }
      if (e.target === tree && e.dataTransfer.types.includes('text/vfspath')) {
        e.preventDefault();
        await fmMoveTo(e.dataTransfer.getData('text/vfspath'), S.fmRoot);
      }
    });
  }
  // 阻止浏览器默认「打开文件」行为（拖到页面其他位置时）
  window.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });

  async function fmMoveTo(fromPath, destDir) {
    if (!fromPath) return;
    const parts = VFS.normalize(fromPath);
    const destParts = VFS.normalize(destDir);
    if (parts.slice(0, -1).join('/') === destParts.join('/')) return; // 已在目标目录
    try {
      VFS.move(S.tree, fromPath, destDir + '/' + parts[parts.length - 1]);
      if (S.view === 'editor' && S.editorPath === fromPath) S.editorPath = destDir + '/' + parts[parts.length - 1];
      await saveTree(); renderFileTree();
    } catch (e) { toast(e.message); }
  }

  // ---------- 编辑器快捷键 ----------
  // 用 execCommand('insertText') 修改内容以保留原生撤销栈（Ctrl+Z/Y 天然可用）
  function edInsert(ta, text) {
    ta.focus();
    if (!document.execCommand('insertText', false, text)) {
      // 兜底（极老内核）：直接改 value，代价是丢失撤销栈
      const { selectionStart: s, selectionEnd: e } = ta;
      ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
      ta.selectionStart = ta.selectionEnd = s + text.length;
    }
    S.editorDirty = true;
  }
  function lineRange(ta) {
    const v = ta.value;
    const start = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let end = v.indexOf('\n', ta.selectionEnd);
    if (end === -1) end = v.length;
    return { start, end };
  }
  function editorKeydown(e) {
    const ta = e.target;
    const mod = e.ctrlKey || e.metaKey;
    // Ctrl+S → 我们的保存
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveEditor(); return; }
    // Ctrl+P → md 预览切换（拦截打印）
    if (mod && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      if ($('#previewToggle').style.display !== 'none') toggleEditorPreview();
      return;
    }
    // Esc → 返回
    if (e.key === 'Escape') { e.preventDefault(); closeEditor(); return; }
    // Tab / Shift+Tab → 缩进 / 反缩进（多行）
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: s0, selectionEnd: e0 } = ta;
      const multi = ta.value.slice(s0, e0).includes('\n');
      if (!e.shiftKey && !multi) { edInsert(ta, '  '); return; }
      const r = lineRange(ta);
      const block = ta.value.slice(r.start, r.end);
      const out = block.split('\n').map(l =>
        e.shiftKey ? l.replace(/^ {1,2}/, '') : '  ' + l).join('\n');
      ta.setSelectionRange(r.start, r.end);
      edInsert(ta, out);
      ta.setSelectionRange(r.start, r.start + out.length);
      return;
    }
    // Ctrl+D → 复制当前行（或选区）到下方
    if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      const r = lineRange(ta);
      const line = ta.value.slice(r.start, r.end);
      ta.setSelectionRange(r.end, r.end);
      edInsert(ta, '\n' + line);
      return;
    }
    // Alt+↑/↓ → 移动当前行
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const up = e.key === 'ArrowUp';
      const r = lineRange(ta);
      const v = ta.value;
      if (up && r.start === 0) return;
      if (!up && r.end === v.length) return;
      const line = v.slice(r.start, r.end);
      if (up) {
        const prevStart = v.lastIndexOf('\n', r.start - 2) + 1;
        const prev = v.slice(prevStart, r.start - 1);
        ta.setSelectionRange(prevStart, r.end);
        edInsert(ta, line + '\n' + prev);
        ta.setSelectionRange(prevStart, prevStart + line.length);
      } else {
        let nextEnd = v.indexOf('\n', r.end + 1);
        if (nextEnd === -1) nextEnd = v.length;
        const next = v.slice(r.end + 1, nextEnd);
        ta.setSelectionRange(r.start, nextEnd);
        edInsert(ta, next + '\n' + line);
        ta.setSelectionRange(nextEnd - line.length, nextEnd);
      }
      return;
    }
  }

  // ---------- 三栏宽度（桌面端可拖动分隔条调整，宽度持久化） ----------
  const PANE_DEFAULT = [288, 288];      // [左栏, 右栏] 初始宽度
  const PANE_MIN = 180, PANE_MAX = 640, CENTER_MIN = 320;

  function applyPanes() {
    const app = document.getElementById('app');
    if (!app) return;
    let [l, r] = S.settings.panes || PANE_DEFAULT;
    const style = getComputedStyle(app);
    const available = app.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 12 - CENTER_MIN;
    if (!isMobile() && l + r > available) {
      const scale = available / (l + r);
      l = Math.max(PANE_MIN, Math.floor(l * scale));
      r = Math.max(PANE_MIN, available - l);
      l = Math.max(PANE_MIN, available - r);
    }
    app.style.gridTemplateColumns = l + 'px 6px 1fr 6px ' + r + 'px';
  }
  async function savePanes(l, r) {
    S.settings.panes = [Math.round(l), Math.round(r)];
    await DB.put('config', { id: 'settings', value: S.settings });
  }
  function setupSplitters() {
    const app = document.getElementById('app');
    for (const side of ['L', 'R']) {
      const bar = $('#split' + side);
      if (!bar) continue;
      let startX = 0, startL = 0, startR = 0;
      const onMove = e => {
        const style = getComputedStyle(app);
        const total = app.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const dx = e.clientX - startX;
        let l = startL, r = startR;
        if (side === 'L') l = startL + dx; else r = startR - dx;
        l = Math.min(PANE_MAX, Math.max(PANE_MIN, l));
        r = Math.min(PANE_MAX, Math.max(PANE_MIN, r));
        // 中栏不能被挤没：超限时反向压回正在拖的那一侧
        const center = total - l - r - 12;
        if (center < CENTER_MIN) {
          if (side === 'L') l = Math.max(PANE_MIN, total - r - 12 - CENTER_MIN);
          else r = Math.max(PANE_MIN, total - l - 12 - CENTER_MIN);
        }
        app.style.gridTemplateColumns = l + 'px 6px 1fr 6px ' + r + 'px';
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        bar.classList.remove('dragging');
        document.body.classList.remove('resizing');
        const cols = getComputedStyle(app).gridTemplateColumns.split(' ');
        savePanes(parseFloat(cols[0]), parseFloat(cols[4]));
      };
      bar.addEventListener('pointerdown', e => {
        if (isMobile()) return;
        const cols = getComputedStyle(app).gridTemplateColumns.split(' ');
        startX = e.clientX; startL = parseFloat(cols[0]); startR = parseFloat(cols[4]);
        bar.classList.add('dragging');
        document.body.classList.add('resizing');
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        e.preventDefault();
      });
      bar.addEventListener('dblclick', () => {
        S.settings.panes = [...PANE_DEFAULT];
        applyPanes();
        savePanes(PANE_DEFAULT[0], PANE_DEFAULT[1]);
      });
    }
  }

  // ---------- 编辑器位置（右/中/左/悬浮，窄屏恒为右=文件标签页内） ----------
  const EDITOR_HOSTS = { right: '#filePanel', center: '#main', left: '#sidebar' };
  function editorPosition() {
    if (isMobile()) return 'right';   // 窄屏三栏折叠成标签页，编辑器留在「文件」内
    const p = S.settings.editorPosition;
    return (p === 'float' || EDITOR_HOSTS[p]) ? p : 'right';
  }
  // 把 #editorPane 挂到目标容器；悬浮模式挂到 body 并加可拖动外框。
  // opts.silent=true 用于启动阶段：此时项目尚未加载，不能触发 renderAll。
  function applyEditorPosition(opts) {
    const pane = $('#editorPane');
    if (!pane) return;
    const pos = editorPosition();
    const app = document.getElementById('app');
    app.setAttribute('data-editor-pos', pos);
    const host = pos === 'float' ? document.body : document.querySelector(EDITOR_HOSTS[pos] || '#filePanel');
    if (host && pane.parentElement !== host) host.append(pane);
    pane.classList.toggle('floating', pos === 'float');
    // 非悬浮时必须清掉内联尺寸/坐标，否则窄屏回落后仍带着悬浮窗的宽高
    if (pos !== 'float') {
      pane.style.left = pane.style.top = pane.style.width = pane.style.height = '';
    } else if (!pane.style.left) {
      // 悬浮窗首次出现时给个居中偏上的初始位置
      pane.style.left = Math.max(16, Math.round(window.innerWidth * 0.25)) + 'px';
      pane.style.top = '64px';
      pane.style.width = Math.min(760, Math.round(window.innerWidth * 0.5)) + 'px';
      pane.style.height = Math.min(560, Math.round(window.innerHeight * 0.7)) + 'px';
    }
    if (!(opts && opts.silent)) renderAll();
  }

  // 悬浮编辑器：拖标题栏移动，右下角把手缩放。仅在 floating 状态生效。
  function setupFloatingEditor() {
    const pane = $('#editorPane');
    const header = $('#editorHeader');
    if (!pane || !header) return;
    let mode = null, sx = 0, sy = 0, ox = 0, oy = 0, ow = 0, oh = 0;
    const onMove = e => {
      if (!mode) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (mode === 'move') {
        // 限制在视口内，至少留出标题栏可见以免拖丢
        pane.style.left = Math.min(window.innerWidth - 80, Math.max(0, ox + dx)) + 'px';
        pane.style.top = Math.min(window.innerHeight - 40, Math.max(0, oy + dy)) + 'px';
      } else {
        pane.style.width = Math.max(320, ow + dx) + 'px';
        pane.style.height = Math.max(220, oh + dy) + 'px';
      }
    };
    const onUp = () => {
      mode = null;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    const start = (e, m) => {
      if (!pane.classList.contains('floating')) return;
      // 点标题栏上的按钮时不触发拖动
      if (m === 'move' && e.target.closest('button')) return;
      mode = m; sx = e.clientX; sy = e.clientY;
      const r = pane.getBoundingClientRect();
      ox = r.left; oy = r.top; ow = r.width; oh = r.height;
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      e.preventDefault();
    };
    header.addEventListener('pointerdown', e => start(e, 'move'));
    const grip = el('div', { class: 'float-grip', title: '拖动调整大小' });
    grip.addEventListener('pointerdown', e => start(e, 'resize'));
    pane.append(grip);
    // 窄屏/宽屏切换时编辑器归属会变（窄屏强制回落到文件标签页），需重挂
    let wasMobile = isMobile();
    window.addEventListener('resize', () => {
      applyPanes();
      const now = isMobile();
      if (now !== wasMobile) { wasMobile = now; applyEditorPosition({ silent: !S.projectId }); }
    });
    // 关标签页/切后台时立刻落盘，否则节流窗口内的最后几个字会丢。
    // pagehide 比 beforeunload 可靠（移动端 Safari 常不触发后者）。
    window.addEventListener('pagehide', flushDraft);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushDraft();
    });
  }


  // ---------- 名词释义气泡 ----------
  // 专有名词旁的问号：点开讲清原理与优劣，替代选项文案里的括号注释。
  // 支持传入多个词条，用于「一个下拉里有若干名词」的场景。
  function helpBtn(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    const b = el('button', { class: 'help-btn', type: 'button', title: '这是什么？', text: '?' });
    b.onclick = e => { e.stopPropagation(); e.preventDefault(); toggleHelpPop(b, list); };
    return b;
  }
  function closeHelpPop() {
    const p = $('#helpPop');
    if (p) p.remove();
  }
  function toggleHelpPop(anchor, keys) {
    const existing = $('#helpPop');
    if (existing && existing.dataset.keys === keys.join(',')) { closeHelpPop(); return; }
    closeHelpPop();
    const pop = el('div', { id: 'helpPop', class: 'help-pop' });
    pop.dataset.keys = keys.join(',');
    for (const k of keys) {
      const g = GLOSSARY[k];
      if (!g) continue;
      const sec = el('div', { class: 'hp-sec' });
      sec.append(el('div', { class: 'hp-title', text: g.title }));
      for (const p of g.body || []) sec.append(el('div', { class: 'hp-body', text: p }));
      if ((g.pros || []).length) {
        sec.append(el('div', { class: 'hp-label good', text: '优点' }));
        const ul = el('ul', { class: 'hp-list' });
        for (const t of g.pros) ul.append(el('li', { text: t }));
        sec.append(ul);
      }
      if ((g.cons || []).length) {
        sec.append(el('div', { class: 'hp-label bad', text: '代价' }));
        const ul = el('ul', { class: 'hp-list' });
        for (const t of g.cons) ul.append(el('li', { text: t }));
        sec.append(ul);
      }
      pop.append(sec);
    }
    document.body.append(pop);
    // 定位：优先放在问号右侧，空间不足则贴边并上移，始终留在视口内
    const r = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    let left = r.right + 8;
    if (left + pr.width > window.innerWidth - 8) left = Math.max(8, r.left - pr.width - 8);
    let top = r.top - 4;
    if (top + pr.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - pr.height - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    setTimeout(() => {
      document.addEventListener('click', onDoc);
      document.addEventListener('keydown', onEsc, true);
    }, 0);
    function onDoc(e) {
      if (e.target.closest('#helpPop') || e.target.closest('.help-btn')) return;
      cleanup();
    }
    function onEsc(e) { if (e.key === 'Escape') { e.stopPropagation(); cleanup(); } }
    function cleanup() {
      closeHelpPop();
      document.removeEventListener('click', onDoc);
      document.removeEventListener('keydown', onEsc, true);
    }
    pop.dismissFromBack = cleanup;
  }

  // ---------- 向用户提问（ask_user 工具） ----------
  // 两种呈现：弹窗（默认，一屏列出全部问题）与内嵌气泡（最小化后，逐题翻页）。
  // 两者共享同一份状态 S.pendingAsk，随时可以来回切换，答案不丢。
  // 最小化只是让出屏幕，Agent 循环依旧挂起等待——不回答就不会往下跑。

  // 把当前作答状态汇成给模型的回执文本
  function askAnswerText(st) {
    const isOther = (q, val) => (q.options || []).some(o => (o.value || o.label) === val && o.other);
    const lines = st.questions.map((q, i) => {
      const note = (st.notes[i] || '').trim();
      let ans;
      if (q.multiSelect) {
        // 「其他」本身不是答案，靠说明框补内容；说明为空就别把它报给模型
        const picks = (st.answers[i] || []).filter(v => !isOther(q, v));
        ans = picks.length ? picks.join('、') : '';
      } else {
        const v = st.answers[i];
        ans = (v && !isOther(q, v)) ? v : '';
      }
      // 没选任何选项时，补充说明本身就是答案；都没有才算未回答
      if (!ans) ans = note ? note : '(未回答)';
      else if (note) ans += '（补充：' + note + '）';
      return '问：' + q.question + '\n答：' + ans;
    });
    return '用户回答如下：\n\n' + lines.join('\n\n');
  }

  function askUserDialog(questions) {
    return new Promise(resolve => {
      const st = {
        questions,
        answers: questions.map(q => (q.multiSelect ? [] : null)),
        notes: questions.map(() => ''),
        page: 0,
        minimized: false,
        sessionId: S.sessionId,
        done: null,
      };
      st.done = text => {
        S.pendingAsk = null;
        closeAskModal();
        resolve(text);
        renderChat();
      };
      S.pendingAsk = st;
      openAskModal(st);
    });
  }

  function closeAskModal() {
    const ov = $('#askOverlay');
    if (ov) ov.remove();
    if (askKeyHandler) { document.removeEventListener('keydown', askKeyHandler, true); askKeyHandler = null; }
  }
  let askKeyHandler = null;

  // 渲染一道题：选项按钮 + 常驻的补充说明框。
  // 不再提供「其他」选项——补充说明框任何时候都能填，没选项合适时直接写就是了。
  function askQuestionBlock(st, qi, onChange) {
    const q = st.questions[qi];
    const fire = () => { if (onChange) onChange(); };
    const block = el('div', { class: 'ask-q' });
    if (q.header) block.append(el('span', { class: 'ask-chip', text: q.header }));
    block.append(el('div', { class: 'ask-title', text: q.question }));
    const optWrap = el('div', { class: 'ask-opts' });
    const note = el('input', { class: 'ask-note', value: st.notes[qi] || '',
      placeholder: '补充说明（可选）' });
    q.options.forEach(o => {
      const val = o.value || o.label;
      const on = q.multiSelect ? (st.answers[qi] || []).includes(val) : st.answers[qi] === val;
      const btn = el('button', { class: 'ask-opt' + (on ? ' on' : '') + (o.other ? ' ask-opt-other' : '') },
        el('span', { class: 'ask-opt-label', text: o.label }),
        o.description ? el('span', { class: 'ask-opt-desc', text: o.description }) : null);
      btn.onclick = () => {
        if (q.multiSelect) {
          const arr = st.answers[qi] || (st.answers[qi] = []);
          const at = arr.indexOf(val);
          if (at >= 0) arr.splice(at, 1); else arr.push(val);
          btn.classList.toggle('on', arr.includes(val));
        } else {
          st.answers[qi] = st.answers[qi] === val ? null : val;   // 再点一次可取消
          for (const b of optWrap.querySelectorAll('.ask-opt')) b.classList.remove('on');
          if (st.answers[qi]) btn.classList.add('on');
        }
        // 选了「其他」就把光标送到说明框——那才是真正要填答案的地方
        if (o.other && btn.classList.contains('on')) note.focus();
        fire();
      };
      optWrap.append(btn);
    });
    note.addEventListener('input', () => { st.notes[qi] = note.value; fire(); });
    block.append(optWrap, note);
    return block;
  }

  // 某题是否已作答：选了选项，或填了补充说明。
  // 只勾了「其他」不算——它本身没有内容，答案得写在说明框里。
  function askAnswered(st, qi) {
    const q = st.questions[qi];
    const isOther = val => (q.options || []).some(o => (o.value || o.label) === val && o.other);
    if ((st.notes[qi] || '').trim()) return true;
    const a = st.answers[qi];
    if (Array.isArray(a)) return a.some(v => !isOther(v));
    return !!(a && !isOther(a));
  }
  // 全部作答完毕才允许提交，否则只能「继续」翻到下一道未答的题
  function askAllAnswered(st) {
    return st.questions.every((_, qi) => askAnswered(st, qi));
  }
  // 下一道未作答的题；没有则返回 -1
  function askNextUnanswered(st, from) {
    const n = st.questions.length;
    for (let i = 1; i <= n; i++) {
      const qi = (from + i) % n;
      if (!askAnswered(st, qi)) return qi;
    }
    return -1;
  }

  function openAskModal(st) {
    st.minimized = false;
    closeAskModal();
    const ov = el('div', { class: 'overlay', id: 'askOverlay' });
    const body = el('div', { class: 'ask-body' });
    const total = st.questions.length;

    const skip = () => st.done('用户跳过了本次提问，未作回答。请基于现有信息自行决定，或说明你需要什么才能继续。');
    ov.dismissFromBack = () => minimizeAsk(st);
    // Esc 收起而非取消：问题还在，回答的机会也还在
    askKeyHandler = e => { if (e.key === 'Escape') { e.preventDefault(); minimizeAsk(st); } };
    document.addEventListener('keydown', askKeyHandler, true);

    // 主按钮：全部答完才是「提交回答」，否则是「继续」——点了跳到下一道没答的题
    const mainBtn = el('button', { class: 'primary ask-btn' });
    const paint = () => {
      const ready = askAllAnswered(st);
      mainBtn.textContent = ready ? '提交回答' : '继续';
      mainBtn.title = ready ? '' : '还有问题未作答，点击跳到下一题';
      mainBtn.onclick = () => {
        if (askAllAnswered(st)) { st.done(askAnswerText(st)); return; }
        const nx = askNextUnanswered(st, st.page);
        if (nx >= 0) { st.page = nx; drawBody(); }
      };
      // 多题时标出进度与当前题
      const pg = ov.querySelector('.ask-page');
      if (pg) pg.textContent = (st.page + 1) + ' / ' + total;
    };
    // 弹窗里一次只显示一题，与内嵌卡片保持一致，避免长列表滚动
    const drawBody = () => {
      body.innerHTML = '';
      body.append(askQuestionBlock(st, st.page, paint));
      paint();
      const prev = ov.querySelector('.ask-prev'), next = ov.querySelector('.ask-next');
      if (prev) prev.disabled = st.page === 0;
      if (next) next.disabled = st.page === total - 1;
    };

    const foot = el('div', { class: 'foot ask-foot' });
    if (total > 1) {
      foot.append(
        el('button', { class: 'ask-nav ask-prev', text: '上一题',
          onclick: () => { if (st.page > 0) { st.page--; drawBody(); } } }),
        el('span', { class: 'ask-page' }),
        el('button', { class: 'ask-nav ask-next', text: '下一题',
          onclick: () => { if (st.page < total - 1) { st.page++; drawBody(); } } }));
    }
    foot.append(el('span', { class: 'ask-inline-spacer' }),
      el('button', { class: 'ask-btn', text: '跳过', onclick: skip }),
      el('button', { class: 'ask-btn', text: '稍后回答', title: '收起到对话里，随时可以回答',
        onclick: () => minimizeAsk(st) }),
      mainBtn);

    ov.append(el('div', { class: 'modal ask-modal' },
      el('div', { class: 'ask-head' },
        el('h3', { text: total > 1 ? `AI 有 ${total} 个问题` : 'AI 有一个问题' })),
      body, foot));
    document.body.append(ov);
    drawBody();
  }

  function minimizeAsk(st) {
    st.minimized = true;
    closeAskModal();
    renderChat();
    toast('提问已收起到对话里，随时可以回答');
  }

  // 内嵌气泡：最小化后停在对话末尾，多题时逐题翻页
  function askInlineCard(st) {
    const card = el('div', { class: 'ask-inline' });
    const total = st.questions.length;
    card.append(el('div', { class: 'ask-inline-head' },
      icon('help', 'ac-icon'),
      el('span', { text: total > 1 ? `AI 有 ${total} 个问题` : 'AI 有一个问题' }),
      el('span', { class: 'ask-inline-spacer' }),
      el('button', { class: 'ask-expand', title: '展开为弹窗', text: '⤢',
        onclick: () => openAskModal(st) })));
    const mainBtn = el('button', { class: 'primary ask-btn' });
    const paint = () => {
      const ready = askAllAnswered(st);
      mainBtn.textContent = ready ? '提交回答' : '继续';
      mainBtn.title = ready ? '' : '还有问题未作答，点击跳到下一题';
      mainBtn.onclick = () => {
        if (askAllAnswered(st)) { st.done(askAnswerText(st)); return; }
        const nx = askNextUnanswered(st, st.page);
        if (nx >= 0) { st.page = nx; renderChat(); }
      };
    };
    card.append(askQuestionBlock(st, st.page, paint));
    const nav = el('div', { class: 'ask-inline-foot' });
    if (total > 1) {
      nav.append(
        el('button', { class: 'ask-nav', text: '上一题', disabled: st.page === 0,
          onclick: () => { if (st.page > 0) { st.page--; renderChat(); } } }),
        el('span', { class: 'ask-page', text: (st.page + 1) + ' / ' + total }),
        el('button', { class: 'ask-nav', text: '下一题', disabled: st.page === total - 1,
          onclick: () => { if (st.page < total - 1) { st.page++; renderChat(); } } }));
    }
    nav.append(el('span', { class: 'ask-inline-spacer' }),
      el('button', { class: 'ask-btn', text: '跳过',
        onclick: () => st.done('用户跳过了本次提问，未作回答。请基于现有信息自行决定，或说明你需要什么才能继续。') }),
      mainBtn);
    card.append(nav);
    paint();
    return card;
  }

  // ---------- 待审阅变更 ----------
  // 把一次写工具的结果登记为待审变更。res.change 由 agent.js 提供（含 before/after）。
  function recordPendingChange(res, turnNo) {
    if (res?.isWrite && !/^错误/.test(res.result)) S.validationDirty = true;
    const ch = res && res.change;
    if (!ch || ch.binary) return;
    const scope = S.settings.changeScope === 'accumulate' ? 'accumulate' : 'last';
    if (ch.kind === 'create') Pending.record(S.pending, ch.path, null, ch.after, { scope, turn: turnNo });
    else if (ch.kind === 'delete') { if (!ch.isDir) Pending.record(S.pending, ch.path, ch.before, null, { scope, turn: turnNo }); }
    else if (ch.kind === 'modify') Pending.record(S.pending, ch.path, ch.before, ch.after, { scope, turn: turnNo });
    else if (ch.kind === 'move') {
      // 移动＝旧路径删除 + 新路径新建，两边都要能审
      Pending.record(S.pending, ch.from, ch.before || '', null, { scope, turn: turnNo });
      Pending.record(S.pending, ch.path, null, ch.after || '', { scope, turn: turnNo });
    } else if (ch.kind === 'copy') Pending.record(S.pending, ch.path, null, ch.after || '', { scope, turn: turnNo });
  }

  // AI 改动了正在编辑的文件时同步编辑器。
  // 用户有未保存修改则不静默覆盖，只挂提示条让其选择。
  function syncOpenEditor() {
    if (S.view !== 'editor' || !S.editorPath) return;
    const node = VFS.resolve(S.tree, VFS.normalize(S.editorPath));
    if (!node) {                       // 文件被 AI 删了
      S.editorStale = { gone: true };
      renderEditorNotice();
      return;
    }
    const ta = $('#editorText');
    if (!ta || ta.value === node.content) return;
    if (S.editorDirty) {
      S.editorStale = { gone: false };  // 有未保存改动，交给用户决定
      renderEditorNotice();
      return;
    }
    // 无未保存改动：直接同步，保持光标位置不跳
    const pos = ta.selectionStart;
    ta.value = node.content;
    try { ta.setSelectionRange(pos, pos); } catch (_) { /* 位置越界忽略 */ }
    if (S.editorPreview) $('#editorPreview').innerHTML = MD.render(ta.value);
    renderEditorNotice();
    renderEditorStatus();
  }

  // 编辑器顶部提示条：文件被外部改动 / 有待审变更
  function renderEditorNotice() {
    const bar = $('#editorNotice');
    if (!bar) return;
    bar.innerHTML = '';
    const stale = S.editorStale;
    const entry = S.editorPath ? S.pending[S.editorPath] : null;
    if (stale) {
      bar.className = 'editor-notice warn';
      bar.append(el('span', { class: 'en-text',
        text: stale.gone ? '此文件已被 AI 删除，你的编辑还没保存。' : '冲突：此文件已被 AI 修改，而你有未保存的编辑。' }));
      if (!stale.gone) {
        // 每个按钮都点明后果，尤其是会丢弃本地编辑的那些
        bar.append(el('button', { class: 'primary', text: '保留我的版本',
          title: '用编辑器里的内容覆盖 AI 的改动并保存', onclick: () => keepMineOverAI() }));
        bar.append(el('button', { text: '另存为…',
          title: '把我的版本存成新文件，AI 的改动留在原文件里', onclick: () => saveEditorAs() }));
        bar.append(el('button', { class: 'danger', text: '丢弃我的编辑，查看 AI 改动',
          title: '放弃编辑器里未保存的内容，然后进入审阅', onclick: () => discardMineThenReview() }));
        bar.append(el('button', { class: 'danger', text: '丢弃我的编辑并重载',
          title: '放弃编辑器里未保存的内容，载入 AI 修改后的版本', onclick: () => discardMineAndReload() }));
      } else {
        bar.append(el('button', { class: 'primary', text: '保留我的版本（重建此文件）',
          title: '用编辑器里的内容重新创建该文件', onclick: () => keepMineOverAI() }));
        bar.append(el('button', { text: '另存为…', title: '把我编辑的内容存成新文件', onclick: () => saveEditorAs() }));
        bar.append(el('button', { class: 'danger', text: '放弃编辑并关闭',
          onclick: () => { S.editorStale = null; S.editorDirty = false; closeEditor(); } }));
      }
      bar.style.display = 'flex';
      return;
    }
    if (entry && S.reviewPath !== S.editorPath) {
      const s = Pending.summarize(entry);
      bar.className = 'editor-notice';
      bar.append(el('span', { class: 'en-text', text: `AI 有 ${s.hunks} 处改动待审阅` }));
      bar.append(el('button', { text: '审阅', onclick: () => openReview(S.editorPath) }));
      bar.append(el('button', { text: '全部接受', onclick: () => acceptFile(S.editorPath) }));
      bar.style.display = 'flex';
      return;
    }
    bar.style.display = 'none';
  }

  // 冲突处理：保留本地版本，覆盖 AI 的改动
  async function keepMineOverAI() {
    const path = S.editorPath;
    if (!path) return;
    const content = $('#editorText').value;
    try { VFS.writeFile(S.tree, path, content); }
    catch (e) { toast('保存失败：' + e.message); return; }
    // AI 的那次改动已被覆盖，待审记录随之失效
    delete S.pending[path];
    if (S.reviewPath === path) { S.reviewPath = null; S.reviewDecided = new Map(); }
    S.editorStale = null; S.editorDirty = false;
    await savePending(); await saveTree();
    renderFileTree(); renderEditorNotice();
    toast('已保留你的版本');
  }
  // 冲突处理：明确丢弃本地未保存内容后再进入审阅
  async function discardMineThenReview() {
    const path = S.editorPath;
    if (!await confirmDialog('丢弃未保存的编辑',
      '编辑器里未保存的内容将被丢弃，然后进入 AI 改动的审阅界面。此操作不可撤销。', true)) return;
    S.editorStale = null; S.editorDirty = false;
    openReview(path);
  }
  async function discardMineAndReload() {
    const path = S.editorPath;
    if (!await confirmDialog('丢弃未保存的编辑',
      '编辑器里未保存的内容将被丢弃，载入 AI 修改后的版本。此操作不可撤销。', true)) return;
    S.editorStale = null; S.editorDirty = false;
    openEditor(path);
  }

  // 接受：变更已经落盘，只需丢弃 baseline
  async function acceptFile(path) {
    delete S.pending[path];
    if (S.reviewPath === path) S.reviewPath = null;
    await savePending();
    renderFileTree(); renderEditorNotice();
    if (S.view === 'editor' && S.editorPath === path) openEditor(path);
    toast('已接受变更');
  }
  // 拒绝：按 baseline 回退整个文件
  async function rejectFile(path) {
    const entry = S.pending[path];
    if (!entry) return;
    await applyRebuild(path, entry, Pending.hunks(entry).map(h => h.id), true);
    toast('已拒绝变更');
  }
  // 按选中的 hunk 重建文件内容并落盘
  async function applyRebuild(path, entry, rejectedIds, isReject) {
    const content = Pending.rebuild(entry, rejectedIds);
    try {
      if (content === null) {
        // 整体新建被拒 → 删除该文件
        if (VFS.resolve(S.tree, VFS.normalize(path))) VFS.deletePath(S.tree, path);
      } else {
        VFS.writeFile(S.tree, path, content);
      }
    } catch (e) { toast('回退失败：' + e.message); return; }
    // 拒绝时让指纹失效，AI 下次写前必须重读——它合理地以为文件是自己写的内容，但拒绝已经退回旧版了。
    // 接受时同步指纹，文件确实是 AI 写的那样，预期一致，不该再要求 read。
    if (isReject) {
      if (S.readState) S.readState.delete(path);
    } else {
      const node = VFS.resolve(S.tree, VFS.normalize(path));
      if (node && node.type === 'file') Agent.recordRead({ tree: S.tree, readState: S.readState }, path);
    }
    delete S.pending[path];
    if (S.reviewPath === path) S.reviewPath = null;
    await savePending(); await saveTree();
    renderFileTree();
    if (S.view === 'editor' && S.editorPath === path) {
      if (content === null) closeEditor(); else openEditor(path);
    }
    renderEditorNotice();
  }
  async function acceptAll() {
    const paths = Object.keys(S.pending);
    const n = Pending.count(S.pending);
    if (!n) { toast('没有待审阅的变更'); return; }
    if (!await confirmDialog('接受全部变更', `接受 ${n} 个文件的全部改动？接受后不再显示待审标记。`, false)) return;
    // 接受 = 文件确实是 AI 写的内容，同步指纹
    for (const p of paths) {
      const node = VFS.resolve(S.tree, VFS.normalize(p));
      if (node && node.type === 'file') Agent.recordRead({ tree: S.tree, readState: S.readState }, p);
    }
    S.pending = {}; S.reviewPath = null;
    await savePending();
    renderFileTree(); renderEditorNotice();
    if (S.view === 'editor' && S.editorPath) openEditor(S.editorPath);
    toast(`已接受 ${n} 个文件的变更`);
  }
  async function rejectAll() {
    const paths = Object.keys(S.pending);
    if (!paths.length) { toast('没有待审阅的变更'); return; }
    if (!await confirmDialog('拒绝全部变更',
      `将 ${paths.length} 个文件回退到 AI 修改前的状态。此操作不可撤销。`, true)) return;
    for (const p of paths) {
      const entry = S.pending[p];
      const content = Pending.rebuild(entry, Pending.hunks(entry).map(h => h.id));
      try {
        if (content === null) { if (VFS.resolve(S.tree, VFS.normalize(p))) VFS.deletePath(S.tree, p); }
        else VFS.writeFile(S.tree, p, content);
        // 拒绝 = 内容已退回旧版，AI 的预期落空，必须重读
        if (S.readState) S.readState.delete(p);
      } catch (_) { /* 单个文件失败不阻断其余回退 */ }
    }
    S.pending = {}; S.reviewPath = null;
    await savePending(); await saveTree();
    renderFileTree();
    if (S.view === 'editor' && S.editorPath) {
      if (VFS.resolve(S.tree, VFS.normalize(S.editorPath))) openEditor(S.editorPath); else closeEditor();
    }
    renderEditorNotice();
    toast(`已拒绝 ${paths.length} 个文件的变更`);
  }
  async function savePending() {
    await DB.put('config', { id: 'pending:' + S.projectId, value: S.pending });
  }

  // ---------- 审阅视图：逐段接受/拒绝 ----------
  function openReview(path) {
    const entry = S.pending[path];
    if (!entry) { toast('该文件没有待审阅的变更'); return; }
    if (S.view !== 'editor' || S.editorPath !== path) {
      // 从文件树直接进入审阅时先把编辑器切到该文件
      S.view = 'editor'; S.editorPath = path; S.editorDirty = false; S.editorPreview = false;
      $('#editorPath').textContent = displayPath(path);
      renderAll();
      if (isMobile()) setTab('files');
    }
    S.reviewPath = path;
    S.reviewDecided = new Map();      // hunkId → 'accept' | 'reject'
    // 进入时记下当前内容，作为「撤销全部决定」的还原点
    const node = VFS.resolve(S.tree, VFS.normalize(path));
    S.reviewOrigin = node && node.type === 'file' ? node.content : null;
    renderReview();
  }
  function closeReview() {
    // 决定已即时生效；离开即认可现状（未决定的段落等同接受）
    S.reviewPath = null;
    S.reviewDecided = new Map();
    S.reviewOrigin = null;
    renderReview();
    if (S.editorPath) openEditor(S.editorPath);
  }
  function renderReview() {
    const pane = $('#reviewPane');
    if (!pane) return;
    const inReview = !!S.reviewPath;
    pane.style.display = inReview ? 'flex' : 'none';
    $('#editorText').style.display = inReview ? 'none' : (S.editorPreview ? 'none' : 'block');
    $('#editorPreview').style.display = (!inReview && S.editorPreview) ? 'block' : 'none';
    $('#previewToggle').style.display = inReview ? 'none' : (/\.md$/i.test(S.editorPath || '') ? '' : 'none');
    $('#saveFileBtn').style.display = inReview ? 'none' : '';
    if (!inReview) { renderEditorNotice(); renderEditorStatus(); return; }
    $('#editorNotice').style.display = 'none';
    renderEditorStatus();          // 审阅态下自行隐藏

    const entry = S.pending[S.reviewPath];
    if (!entry) { S.reviewPath = null; renderReview(); return; }
    pane.innerHTML = '';
    const hs = Pending.hunks(entry);
    // 三态：未决定 / 已接受 / 已拒绝。不预选任何一方——「不选就继续聊天」
    // 等于默认接受，是由「关闭审阅时保留现状」自然达成的，不需要预先勾上。
    if (!S.reviewDecided) S.reviewDecided = new Map();
    const decided = S.reviewDecided;
    const pendingCount = hs.filter(h => !decided.has(h.id)).length;

    // 每次点击即刻生效；离开审阅前可用「撤销全部决定」后悔
    const decidedCount = hs.length - pendingCount;
    const head = el('div', { class: 'rv-head' },
      el('span', { class: 'rv-title',
        text: pendingCount ? `${pendingCount}/${hs.length} 处待决定` : `${hs.length} 处已决定` }),
      el('button', { class: 'rv-ok', text: '全部接受', onclick: () => acceptFile(S.reviewPath) }),
      el('button', { class: 'rv-no', text: '全部拒绝', onclick: () => rejectFile(S.reviewPath) }));
    if (decidedCount) {
      head.append(el('button', { class: 'rv-undo', text: '撤销全部决定',
        title: '把本次审阅的所有决定还原，回到刚进来时的状态', onclick: () => undoAllDecisions() }));
    }
    pane.append(head);

    const body = el('div', { class: 'rv-body' });
    if (entry.before === null || entry.after === null) {
      const whole = entry.before === null ? '新建整个文件' : '删除整个文件';
      body.append(el('div', { class: 'rv-whole', text: whole }));
      const text = entry.before === null ? entry.after : entry.before;
      const cls = entry.before === null ? 'add' : 'del';
      Diff.splitLines(text || '').slice(0, 200).forEach((line, i) => {
        body.append(el('div', { class: 'dl ' + cls },
          el('span', { class: 'ln', text: String(i + 1) }),
          el('span', { class: 'sg', text: cls === 'add' ? '+' : '-' }),
          el('span', { class: 'dt', text: line })));
      });
    } else {
      for (const h of hs) {
        const state = decided.get(h.id);              // undefined | 'accept' | 'reject'
        const card = el('div', { class: 'rv-hunk' + (state ? ' decided ' + state : '') });
        const label = { add: '新增', del: '删除', mod: '修改' }[h.type] || h.type;
        const at = h.newStart != null ? '第 ' + h.newStart + ' 行' : (h.oldStart != null ? '原第 ' + h.oldStart + ' 行' : '');
        const headRow = el('div', { class: 'rv-hunk-head' },
          el('span', { class: 'rv-tag ' + h.type, text: label }),
          el('span', { class: 'rv-at', text: at }));
        if (state) {
          // 已决定：折叠为一行，但仍可直接改判或展开细看——在离开审阅前都不是终局
          headRow.append(
            el('span', { class: 'rv-state ' + state, text: state === 'accept' ? '已接受' : '已拒绝' }),
            el('button', {
              class: state === 'accept' ? 'rv-no' : 'rv-ok',
              title: '改为' + (state === 'accept' ? '拒绝' : '接受'),
              text: '改为' + (state === 'accept' ? '拒绝' : '接受'),
              onclick: () => decideHunk(h.id, state === 'accept' ? 'reject' : 'accept'),
            }),
            el('button', { class: 'rv-undo', text: '重新决定', onclick: () => { decided.delete(h.id); renderReview(); } }));
        } else {
          headRow.append(
            el('button', { class: 'rv-ok', text: '接受', onclick: () => decideHunk(h.id, 'accept') }),
            el('button', { class: 'rv-no', text: '拒绝', onclick: () => decideHunk(h.id, 'reject') }));
        }
        card.append(headRow);
        if (state) {
          // 折叠态给一行摘要，点开可复查具体差异
          const det = el('details', { class: 'rv-collapsed' });
          const firstLine = (h.rows[0] && (h.rows[0].text || h.rows[0].newText || h.rows[0].oldText)) || '';
          det.append(el('summary', { text: firstLine.trim().slice(0, 48) + (h.rows.length > 1 ? ` …共 ${h.rows.length} 行` : '') }));
          const lines = el('div', { class: 'rv-lines' });
          for (const row of h.rows) lines.append(diffRow(row));
          det.append(lines);
          card.append(det);
        } else {
          const lines = el('div', { class: 'rv-lines' });
          for (const row of h.rows) lines.append(diffRow(row));
          card.append(lines);
        }
        body.append(card);
      }
    }
    pane.append(body);
  }
  // 每次点击接受/拒绝都立即写入文件——不需要再点「应用」。
  // 后悔机会来自 reviewOrigin 快照：离开审阅前可「撤销全部决定」还原。
  function cancelAutoApply() { /* 已改为即时生效，保留空实现以兼容旧调用点 */ }
  async function decideHunk(id, choice) {
    S.reviewDecided.set(id, choice);
    const path = S.reviewPath;
    const entry = S.pending[path];
    if (!entry) return;
    const hs = Pending.hunks(entry);
    // 按当前全部决定重算文件内容：拒绝的段落取 baseline，其余保留 AI 的值。
    // 未决定的段落暂按「保留 AI 的值」处理，与「不作为=接受」一致。
    const rejects = hs.filter(h => S.reviewDecided.get(h.id) === 'reject').map(h => h.id);
    const content = Pending.rebuild(entry, rejects);
    try {
      if (content === null) { if (VFS.resolve(S.tree, VFS.normalize(path))) VFS.deletePath(S.tree, path); }
      else VFS.writeFile(S.tree, path, content);
    } catch (e) { toast('应用失败：' + e.message); return; }
    // 只要有段落被拒，文件就不是 AI 写的那样了，得让它重读；全部接受则同步指纹
    if (rejects.length) { if (S.readState) S.readState.delete(path); }
    else {
      const node = VFS.resolve(S.tree, VFS.normalize(path));
      if (node && node.type === 'file') Agent.recordRead({ tree: S.tree, readState: S.readState }, path);
    }
    await saveTree();
    renderFileTree();
    // 全部决定完则结束审阅：待审记录清空，文件停在当前结果
    if (hs.every(h => S.reviewDecided.has(h.id))) {
      const acc = hs.length - rejects.length;
      delete S.pending[path];
      S.reviewPath = null; S.reviewDecided = new Map(); S.reviewOrigin = null;
      await savePending();
      renderReview(); renderFileTree();
      if (content === null) closeEditor(); else openEditor(path);
      toast(rejects.length ? `已应用：接受 ${acc} 处，拒绝 ${rejects.length} 处` : '已接受全部改动');
      return;
    }
    renderReview();
  }
  // 撤销本次审阅的所有决定，把文件还原到进入审阅时的样子
  async function undoAllDecisions() {
    const path = S.reviewPath;
    const origin = S.reviewOrigin;
    if (!path || origin == null) return;
    try {
      if (origin === null) { if (VFS.resolve(S.tree, VFS.normalize(path))) VFS.deletePath(S.tree, path); }
      else VFS.writeFile(S.tree, path, origin);
    } catch (e) { toast('撤销失败：' + e.message); return; }
    // reviewOrigin 就是进入审阅时的内容，即 AI 写完的那一版——与它的预期一致
    const node = VFS.resolve(S.tree, VFS.normalize(path));
    if (node && node.type === 'file') Agent.recordRead({ tree: S.tree, readState: S.readState }, path);
    else if (S.readState) S.readState.delete(path);
    S.reviewDecided = new Map();
    await saveTree();
    renderFileTree(); renderReview();
    toast('已撤销本次审阅的全部决定');
  }

  // 文件树底部的全局操作条：整条可点开清单（不只是文字），右侧两个批量按钮
  function renderReviewBar() {
    const bar = $('#reviewBar');
    if (!bar) return;
    const n = Pending.count(S.pending);
    if (!n) { bar.style.display = 'none'; bar.innerHTML = ''; closeChangeList(); return; }
    bar.innerHTML = '';
    bar.style.display = 'flex';
    bar.title = '点击查看改动的文件清单';
    const label = el('div', { class: 'rb-text' },
      el('span', { class: 'rb-chev', text: '▸' }),
      el('span', { text: `${n} 个文件有改动待审阅` }));
    // 整条操作条都是热区；批量按钮自己 stopPropagation，避免顺带展开清单
    // 阻止冒泡：否则这次点击会传到 document 上的关闭监听，刚打开又被关掉
    bar.onclick = e => { e.stopPropagation(); toggleChangeList(bar); };
    const accept = el('button', { class: 'rv-ok', text: '接受全部' });
    accept.onclick = e => { e.stopPropagation(); acceptAll(); };
    const reject = el('button', { class: 'rv-no', text: '拒绝全部' });
    reject.onclick = e => { e.stopPropagation(); rejectAll(); };
    bar.append(label, accept, reject);
  }
  function closeChangeList() {
    const p = $('#changeList');
    if (p) p.remove();
  }
  function toggleChangeList(anchor) {
    if ($('#changeList')) { closeChangeList(); return; }
    const pop = el('div', { id: 'changeList', class: 'change-list' });
    pop.append(el('div', { class: 'cl-head' }, el('span', { text: '有改动的文件' }),
      el('button', { class: 'iconbtn', title: '关闭', text: '✕', onclick: closeChangeList })));
    const body = el('div', { class: 'cl-body' });
    // 按路径排序，展示「文件名 + 所在目录」，点击直接进审阅
    for (const path of Object.keys(S.pending).sort()) {
      const entry = S.pending[path];
      const s = Pending.summarize(entry);
      const parts = VFS.normalize(path);
      const name = parts[parts.length - 1];
      const dir = displayPath('/' + parts.slice(0, -1).join('/'));
      const row = el('div', { class: 'cl-item' },
        icon('doc', 'cl-icon'),
        el('div', { class: 'cl-main' },
          el('div', { class: 'cl-name', text: name }),
          el('div', { class: 'cl-dir', text: dir === '/' ? '（根目录）' : dir })),
        el('span', { class: 'cl-stat' },
          s.added ? el('span', { class: 'plus', text: '+' + s.added }) : null,
          s.removed ? el('span', { class: 'minus', text: '-' + s.removed }) : null));
      row.onclick = () => { closeChangeList(); openReview(path); };
      body.append(row);
    }
    pop.append(body);
    document.body.append(pop);
    // 宽度对齐文件面板：清单比面板还宽会显得突出且遮住中栏
    const panel = $('#filePanel');
    const pw = panel ? panel.getBoundingClientRect() : null;
    const r = anchor.getBoundingClientRect();
    if (pw && pw.width > 120) {
      pop.style.width = Math.round(pw.width) + 'px';
      pop.style.left = Math.round(pw.left) + 'px';
    } else {
      pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.getBoundingClientRect().width - 8)) + 'px';
    }
    pop.style.top = Math.max(8, r.top - pop.getBoundingClientRect().height - 6) + 'px';
    setTimeout(() => document.addEventListener('click', onDocClose), 0);
    function onDocClose(e) {
      if (e.target.closest('#changeList')) return;
      closeChangeList();
      document.removeEventListener('click', onDocClose);
    }
  }

  // ---------- 编辑器模式（文件面板内的一层视图） ----------
  // 编辑器底部状态栏：字数/行数/光标位置/选中量，以及保存状态。
  // 中文场景下「字符数」比「单词数」有意义，故不做分词统计。
  function renderEditorStatus() {
    const bar = $('#editorStatus');
    const ta = $('#editorText');
    if (!bar || !ta) return;
    if (S.view !== 'editor' || !S.editorPath) { bar.style.display = 'none'; return; }
    // 审阅态下编辑区不可编辑，状态栏无意义
    if (S.reviewPath) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    const v = ta.value;
    const chars = [...v].length;                    // 按码点算，避免 emoji 被计成 2
    const lines = v === '' ? 1 : v.split('\n').length;
    const selLen = ta.selectionEnd - ta.selectionStart;
    // 光标所在行列（列按码点数，从 1 起）
    const upto = v.slice(0, ta.selectionStart);
    const ln = upto.split('\n').length;
    const col = [...upto.slice(upto.lastIndexOf('\n') + 1)].length + 1;
    const cells = [
      { label: '字符', value: fmtNum(chars) },
      { label: '行', value: fmtNum(lines) },
      { label: '', value: '行 ' + ln + '，列 ' + col },
    ];
    if (selLen > 0) cells.push({ label: '已选', value: fmtNum([...v.slice(ta.selectionStart, ta.selectionEnd)].length) });
    bar.innerHTML = '';
    for (const c of cells)
      bar.append(el('span', { class: 'es-cell' },
        c.label ? el('span', { class: 'es-label', text: c.label }) : null,
        el('span', { class: 'es-val', text: c.value })));
    bar.append(el('span', { class: 'es-spacer' }));
    bar.append(el('span', { class: 'es-cell es-state' + (S.editorDirty ? ' dirty' : '') },
      el('span', { text: S.editorDirty ? '未保存' : '已保存' })));
  }
  const fmtNum = n => n.toLocaleString('en-US');

  function openEditor(path) {
    S.validationReveal = false;
    const node = VFS.resolve(S.tree, VFS.normalize(path));
    if (node && node.encoding === 'base64') {
      confirmDialog('非文本文件', '文本编辑器无法打开此文件。PDF、DOCX 可由 AI 使用 parse_document 解析；图片可在多模态开启时通过 view_image 查看。文件可通过菜单下载。', false, '我已知晓');
      return;
    }
    // Agent 运行中也可编辑：冲突由 syncOpenEditor 的提示条与待审阅机制处理
    S.view = 'editor'; S.editorPath = path; S.editorDirty = false; S.editorPreview = false;
    S.reviewPath = null; S.editorStale = null;
    const r = VFS.readFile(S.tree, path, { cap: Infinity });
    $('#editorText').value = r.content;
    $('#editorText').style.display = 'block';
    $('#editorPreview').style.display = 'none';
    $('#reviewPane').style.display = 'none';
    $('#saveFileBtn').style.display = '';
    $('#previewToggle').textContent = '预览';
    $('#editorPath').textContent = displayPath(path);
    $('#previewToggle').style.display = /\.md$/i.test(path) ? '' : 'none';
    renderAll();
    renderEditorNotice();
    renderEditorStatus();
    // 窄屏：编辑器在「文件」标签内，需切过去；桌面按设置的位置就地展开
    if (isMobile()) setTab('files');
  }
  const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
  async function closeEditor() {
    // 审阅态下「返回」先退回普通编辑视图，不直接关掉编辑器
    if (S.reviewPath) { closeReview(); return; }
    if (S.editorDirty && !await confirmDialog('放弃修改', '有未保存的修改，确定离开编辑器？', true)) return;
    S.view = 'chat'; S.editorPath = null; S.editorDirty = false; S.editorStale = null;
    renderAll();
  }
  function toggleEditorPreview() {
    S.editorPreview = !S.editorPreview;
    $('#editorText').style.display = S.editorPreview ? 'none' : 'block';
    const pv = $('#editorPreview');
    pv.style.display = S.editorPreview ? 'block' : 'none';
    $('#previewToggle').textContent = S.editorPreview ? '编辑' : '预览';
    if (S.editorPreview) pv.innerHTML = MD.render($('#editorText').value);
    renderEditorStatus();
  }
  async function saveEditor() {
    if (!S.editorPath) return;
    VFS.writeFile(S.tree, S.editorPath, $('#editorText').value);
    S.editorDirty = false;
    S.editorStale = null;
    await saveTree();
    renderFileTree(); renderEditorNotice(); renderEditorStatus(); toast('已保存');
  }

  // 另存为：与 AI 的改动冲突时，把自己的版本存成新文件，两份都留下
  async function saveEditorAs() {
    if (!S.editorPath) return;
    const parts = VFS.normalize(S.editorPath);
    const dir = '/' + parts.slice(0, -1).join('/');
    const base = parts[parts.length - 1];
    const m = base.match(/^(.*?)(\.[^.]+)?$/);
    const suggest = m[1] + '-我的版本' + (m[2] || '');
    // displayPath 对 workspace 根返回 '/'，直接拼 '/' 会得到 '//'
    const dirLabel = displayPath(dir) === '/' ? '工作区根目录' : displayPath(dir) + '/';
    const name = await promptDialog({
      title: '另存为', label: '保存到 ' + dirLabel,
      value: suggest, okText: '保存',
      validate: v => nameValidator(v)
        || (VFS.resolve(S.tree, VFS.normalize(dir + '/' + v)) ? '已存在同名文件' : null),
    });
    if (!name) return;
    const target = dir + '/' + name;
    try {
      VFS.writeFile(S.tree, target, $('#editorText').value);
    } catch (e) { toast('保存失败：' + e.message); return; }
    S.editorDirty = false; S.editorStale = null;
    await saveTree();
    renderFileTree();
    openEditor(target);          // 切到新文件，原文件保留 AI 的版本
    toast('已另存为 ' + displayPath(target));
  }

  // ---------- 存储占用估算 ----------
  async function estimateStorage() {
    await flushDraft();
    return DesignerStorage.estimate(DB, SEED_FILES);
  }

  // 可折叠分区：count > 5 时默认折叠
  function collapsible(title, bodyEl, count, forceOpen) {
    const open = forceOpen !== undefined ? forceOpen : !(count > 5);
    const wrap = el('div', { class: 'collapsible' + (open ? ' open' : '') });
    const head = el('div', { class: 'coll-head' },
      el('span', { class: 'chev', text: '▾' }),
      el('h3', { text: title }),
      count !== undefined ? el('span', { class: 'count', text: String(count) }) : null);
    head.onclick = () => wrap.classList.toggle('open');
    wrap.append(head, el('div', { class: 'coll-body' }, bodyEl));
    return wrap;
  }

  // ---------- 设置弹窗 ----------
  // 发一条无上下文的 hello 验证配置是否可用。成功返回模型回复文本，失败抛出可读原因。
  async function testConnection(cfg) {
    const url = ApiUrl.root(cfg.baseUrl) + '/chat/completions';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: 'hello' }],
          temperature: cfg.temperature,
          stream: false,
          max_tokens: 32,
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('请求超时（20 秒无响应），检查网络或 Base URL 是否可达');
      // fetch 本身失败时拿不到状态码，最常见是 CORS 被拦或域名写错
      throw new Error('无法连接（' + (e.message || '网络错误') + '）。常见原因：Base URL 拼写有误、服务端未允许跨域、或本机网络不通');
    } finally { clearTimeout(timer); }

    const raw = await resp.text().catch(() => '');
    if (!resp.ok) {
      // 优先用服务端返回的结构化错误信息，它通常最准确
      let detail = '';
      try { const j = JSON.parse(raw); detail = (j.error && (j.error.message || j.error.code)) || j.message || ''; } catch (_) { detail = raw.slice(0, 200); }
      const hint = { 401: '（API Key 无效或未授权）', 403: '（无访问权限，检查 Key 的权限或余额）',
        404: '（路径不存在，Base URL 是否漏了 /v1？）', 429: '（触发限流或额度不足）',
        500: '（服务端内部错误）', 502: '（网关错误）', 503: '（服务不可用）' }[resp.status] || '';
      throw new Error('HTTP ' + resp.status + hint + (detail ? '：' + detail : ''));
    }

    let json;
    try { json = JSON.parse(raw); }
    catch (_) { throw new Error('返回的不是合法 JSON，可能 Base URL 指向了非 API 地址：' + raw.slice(0, 120)); }
    // 少数服务 HTTP 200 但在 body 里报错
    if (json.error) throw new Error(json.error.message || String(json.error));
    const msg = json.choices && json.choices[0] && json.choices[0].message;
    if (!msg) throw new Error('响应缺少 choices[0].message，接口可能不兼容 OpenAI 格式');
    const text = (msg.content || '').trim();
    return text || '(模型返回空内容，但接口连通正常)';
  }

  function openSettings() {
    const s = S.settings;
    const ov = el('div', { class: 'overlay' });
    const close = () => ov.remove();
    ov.dismissFromBack = close;
    const field = (labelText, inputEl, helpKey) => el('div', { class: 'row' },
      el('label', { text: labelText }), inputEl, helpKey ? helpBtn(helpKey) : null);

    const baseUrl = el('input', { value: s.baseUrl, placeholder: 'https://api.deepseek.com/v1', 'aria-label': 'API Base URL' });
    const baseUrlWrap = el('div', { class: 'api-base-setting' }, baseUrl);
    const apiKey = el('input', { value: s.apiKey, type: 'password' });
    // 模型：可输入 + 可从 /models 拉取后下拉选择
    const model = el('input', { value: s.model, list: 'modelListOpts', style: 'flex:1;min-width:0' });
    const modelDatalist = el('datalist', { id: 'modelListOpts' });
    const fetchModelsBtn = el('button', { class: 'iconbtn', title: '从接口获取模型列表', onclick: async () => {
      const base = baseUrl.value.trim();
      if (!base) { toast('请先填写 API Base URL'); return; }
      fetchModelsBtn.disabled = true;
      try {
        const resp = await fetch(ApiUrl.root(base) + '/models', { headers: { 'Authorization': 'Bearer ' + apiKey.value.trim() } });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const json = await resp.json();
        const ids = (json.data || []).map(m => m.id).filter(Boolean).sort();
        if (!ids.length) throw new Error('返回的模型列表为空');
        modelDatalist.innerHTML = '';
        for (const id of ids) modelDatalist.append(el('option', { value: id }));
        toast('已获取 ' + ids.length + ' 个模型，点击模型输入框选择');
        model.focus();
      } catch (e) { toast('获取失败: ' + e.message); }
      finally { fetchModelsBtn.disabled = false; }
    } }, icon('refresh'));
    const modelWrap = el('div', { style: 'display:flex;flex:1;gap:4px;align-items:center;min-width:0' }, model, fetchModelsBtn, modelDatalist);

    // 连通性测试：用当前表单里的值（而非已保存值）发一条无上下文的 hello
    const testResult = el('div', { class: 'api-test-result' });
    const testBtn = el('button', { text: '测试连接', onclick: async () => {
      const base = baseUrl.value.trim();
      const key = apiKey.value.trim();
      const mdl = model.value.trim();
      testResult.className = 'api-test-result';
      if (!base) { testResult.classList.add('bad'); testResult.textContent = '请先填写 API Base URL'; return; }
      if (!mdl) { testResult.classList.add('bad'); testResult.textContent = '请先填写模型名'; return; }
      testBtn.disabled = true;
      testResult.classList.add('pending');
      testResult.textContent = '测试中…';
      const t0 = Date.now();
      try {
        const reply = await testConnection({ baseUrl: base, apiKey: key, model: mdl,
          temperature: Number(temp.value) || 0 });
        const ms = Date.now() - t0;
        testResult.className = 'api-test-result ok';
        testResult.textContent = `连接成功（${ms}ms）· 模型回复：${reply.slice(0, 60)}`;
      } catch (e) {
        testResult.className = 'api-test-result bad';
        testResult.textContent = '失败：' + e.message;
      } finally { testBtn.disabled = false; }
    } });
    // 可编辑的系统提示词；常驻技能由程序随后注入。
    const sysPromptInput = el('textarea', { class: 'sys-prompt', rows: '12' });
    sysPromptInput.value = (s.systemPromptOverride || '').trim() || AGENT_CONFIG.systemPrompt;
    const sysPromptStatus = el('span', { class: 'sys-prompt-status' });
    const refreshSysStatus = () => {
      const isDefault = sysPromptInput.value.trim() === AGENT_CONFIG.systemPrompt.trim();
      sysPromptStatus.textContent = isDefault ? '使用默认（随版本更新）' : '已自定义';
      sysPromptStatus.className = 'sys-prompt-status ' + (isDefault ? 'default' : 'custom');
    };
    refreshSysStatus();
    sysPromptInput.addEventListener('input', refreshSysStatus);
    const restoreBtn = el('button', { text: '还原为默认提示词', onclick: async () => {
      if (sysPromptInput.value.trim() === AGENT_CONFIG.systemPrompt.trim()) {
        toast('当前已是默认提示词'); return;
      }
      if (!await confirmDialog('还原为默认提示词',
        '当前的自定义内容将被默认提示词覆盖。此操作不可撤销。', true)) return;
      sysPromptInput.value = AGENT_CONFIG.systemPrompt;
      refreshSysStatus();
      toast('已还原为默认提示词');
    } });
    const agentSection = el('div');
    const agentBody = el('div');
    agentBody.append(
      el('div', { class: 'field-label', text: '系统提示词' }),
      el('div', { class: 'hint', text: '这里只写助手的人设与工作方式。常驻世界构建技能的主体会紧随本段注入；工具用法、目录约定与可用 Skill 清单由程序自动附加。' }),
      sysPromptInput,
      el('div', { class: 'row', style: 'justify-content:space-between;align-items:center' }, sysPromptStatus, restoreBtn));
    // 默认展开：折叠态看不出可以点开，用户容易以为这里没内容
    agentSection.append(collapsible('系统提示词', agentBody, undefined, true));

    const reverseSendNewline = el('input', { type: 'checkbox', checked: s.reverseSendNewline === true, 'aria-label': '反转发送与换行' });
    const changeScope = el('select', {},
      el('option', { value: 'last', text: '仅最后一轮的改动' }),
      el('option', { value: 'accumulate', text: '累积到我处理为止' }));
    changeScope.value = s.changeScope === 'accumulate' ? 'accumulate' : 'last';

    const editorPos = el('select', {},
      el('option', { value: 'right', text: '右栏（文件面板）' }),
      el('option', { value: 'center', text: '中栏（对话区）' }),
      el('option', { value: 'left', text: '左栏（会话列表）' }),
      el('option', { value: 'float', text: '悬浮窗口' }));
    editorPos.value = s.editorPosition || 'right';

    const expandThink = el('select', {},
      el('option', { value: 'collapsed', text: '思考完成后折叠' }),
      el('option', { value: 'alwaysCollapsed', text: '始终折叠' }),
      el('option', { value: 'expanded', text: '始终展开' }),
      el('option', { value: 'hidden', text: '总是隐藏' }));
    expandThink.value = ['collapsed', 'alwaysCollapsed', 'expanded', 'hidden'].includes(s.reasoningDisplay)
      ? s.reasoningDisplay : 'collapsed';

    // 思考强度：滑块，5 档离散刻度。内部值 none/low/high/xhigh/max，界面显示中文
    const EFFORT_LABELS = { none: '关', low: '低', high: '中', xhigh: '高', max: '最高' };
    const effortIdx = Math.max(0, Agent.EFFORT_LEVELS.indexOf(
      Agent.EFFORT_LEVELS.includes(s.reasoningEffort) ? s.reasoningEffort : 'high'));
    const effortSlider = el('input', { type: 'range', min: '0', max: '4', step: '1', value: String(effortIdx), class: 'effort-slider' });
    const effortVal = el('span', { class: 'effort-value', text: EFFORT_LABELS[Agent.EFFORT_LEVELS[effortIdx]] });
    effortSlider.addEventListener('input', () => {
      effortVal.textContent = EFFORT_LABELS[Agent.EFFORT_LEVELS[+effortSlider.value]];
    });
    const effortRow = el('div', { class: 'effort-row' },
      effortSlider, effortVal);
    // 刻度标签要正对滑块把手的落点。把手中心的行程是 [8px, 100%-8px]（半个把手宽），
    // 第 i 档落在 8px + i*(100%-16px)/4 —— 展开即 i*25% - i*4px，逐个绝对定位过去。
    // 用等分 flex 会差半格：那样得到的是每格中心，不是刻度点。
    const effortTicks = el('div', { class: 'effort-ticks' },
      ...Agent.EFFORT_LEVELS.map((lv, i) => el('span', {
        text: EFFORT_LABELS[lv],
        style: 'left: calc(8px + ' + (i * 25) + '% - ' + (i * 4) + 'px)',
      })));
    const effortWrap = el('div', { class: 'effort-wrap' }, effortRow, effortTicks);

    const temp = el('input', { value: String(s.temperature), type: 'number', step: '0.1', min: '0', max: '2' });
    const stream = el('select', {}, el('option', { value: '1', text: '开启' }), el('option', { value: '0', text: '关闭' }));
    stream.value = s.stream ? '1' : '0';
    const apiHelp = el('div', { id: 'api-options-help', class: 'api-options-help', hidden: true },
      el('p', { text: 'API 地址可填写基础地址（如 https://api.example.com/v1），也可填写完整的 /chat/completions 地址。模型请求、测试连接和模型列表都会自动处理路径。' }),
      el('p', { text: '温度控制输出的随机性，数值越低越稳定；思考强度控制模型推理投入，是否支持以及实际效果取决于服务商和模型。' }),
      el('p', { text: '流式输出会逐步接收正文、思考过程和工具调用；视觉模型设为“是”时可发送图片，需要接口与模型支持图片输入。' }),
      el('p', { text: '测试连接会使用当前表单中的地址、API Key 和模型发送一条简短消息。参数修改后请点击“保存”。' }));
    const apiHelpButton = el('button', { class: 'help-btn settings-info-button', type: 'button', text: 'i',
      title: '参数说明与示例', 'aria-label': '参数说明与示例', 'aria-controls': 'api-options-help', 'aria-expanded': 'false',
      onclick: () => { apiHelp.hidden = !apiHelp.hidden; apiHelpButton.setAttribute('aria-expanded', String(!apiHelp.hidden)); } });
    const apiHeading = el('div', { class: 'api-settings-heading' }, el('span', { text: '请求参数' }), apiHelpButton);
    const imageSending = el('select', { 'aria-label': '视觉模型' }, el('option', { value: '1', text: '是' }), el('option', { value: '0', text: '否' }));
    imageSending.value = s.imageSending ? '1' : '0';
    const overflow = el('select', {},
      el('option', { value: 'disabled', text: '禁用' }),
      el('option', { value: 'sliding', text: '滑动窗口' }),
      el('option', { value: 'truncate', text: '切断' }),
      el('option', { value: 'compress', text: '自动压缩' }));
    overflow.value = s.contextOverflow;
    const ctxSel = el('select', {},
      ...ContextBudget.PRESETS.map(k => el('option', { value: String(k), text: k >= 1024 ? '1m' : k + 'k' })),
      el('option', { value: 'custom', text: '自定义…' }));
    const ctxCustom = el('input', { type: 'number', placeholder: '单位 k，1–10000', style: 'display:none' });
    if (ContextBudget.mode(s) === 'preset') ctxSel.value = String(s.maxContextK);
    else { ctxSel.value = 'custom'; ctxCustom.style.display = ''; ctxCustom.value = String(s.maxContextK); }
    ctxSel.onchange = () => { ctxCustom.style.display = ctxSel.value === 'custom' ? '' : 'none'; };

    // 项目存储列表：分开显示 撤回/文件/对话 占用，支持单独清理与删除项目
    const projStoreList = el('div');
    const projSection = el('div');
    const renderProjStore = async () => {
      projStoreList.innerHTML = '';
      const { perProject, total } = await estimateStorage();
      for (const p of S.projects) {
        const e = perProject.get(p.id) || { chat: 0, files: 0, snaps: 0, snapCount: 0, other: 0 };
        const sub = e.chat + e.files + e.snaps + e.other;
        const busy = S.storageBusy || S.handoffBusy || (S.running && S.projectId === p.id) || lease.isHeldByOther(p.id);
        projStoreList.append(el('div', { class: 'proj-store-item' },
          el('div', { class: 'head' },
            el('span', { class: 'name', text: p.name + (p.id === S.projectId ? '（当前）' : '') }),
            el('span', { class: 'total', text: fmtBytes(sub) })),
          el('div', { class: 'store-actions' },
            el('button', { class: 'danger', text: '清理撤回', disabled: busy || !e.snapCount, title: '删除该项目的全部撤回点（文件与对话保留）', onclick: async () => {
              if (!await confirmDialog('清理撤回数据',
                `删除项目「${p.name}」的全部撤回点（${e.snapCount} 个）？其历史轮次将无法再回滚；文件与对话不受影响。`, true)) return;
              if (S.storageBusy || S.handoffBusy || (S.running && S.projectId === p.id) || lease.isHeldByOther(p.id)) return toast('项目正在执行任务，请稍后清理');
              await DB.delWhere('snapshots', x => x.projectId === p.id);
              if (p.id === S.projectId) S.snapshots = [];
              p.historyLocked = true; await DB.put('projects', p);
              renderChat(); renderProjStore(); toast('已清理');
            } }),
            el('button', { class: 'danger', text: '清理项目数据', disabled: busy || !sub, onclick: async () => { await clearProjectData(p); await renderProjStore(); } })),
          el('div', { class: 'detail' },
            el('span', { text: '撤回数据 ' + fmtBytes(e.snaps) + '（' + e.snapCount + ' 点）' }),
            el('span', { text: '文件 ' + fmtBytes(e.files) }),
            el('span', { text: '对话与草稿 ' + fmtBytes(e.chat) }),
            e.other ? el('span', { text: '其他数据 ' + fmtBytes(e.other) }) : null)));
      }
      projStoreList.append(el('div', { class: 'store-total' },
        el('span', { text: '总占用（估算）' }), el('span', { text: fmtBytes(total) })));
      // 重建折叠外壳以更新计数
      projSection.innerHTML = '';
      projSection.append(collapsible('项目与存储', projStoreList, S.projects.length));
    };
    renderProjStore();

    const skillList = el('div');
    const skillSection = el('div');
    const renderSkillList = () => {
      skillList.innerHTML = '';
      const all = cur.installedSkills();       // 含被禁用的，禁用项也要能看到并重新启用
      const activeCount = all.filter(s => !isSkillDisabled(s.name)).length;
      // 外部 skills/ 目录的加载状态
      const rep = S.skillLoad;
      if (rep && rep.available) {
        const from = rep.origin === 'bundled' ? '本页内置资源' : '世界设计者专属资源目录';
        skillList.append(el('div', { class: 'hint' },
          el('span', { text: '本页的四个技能来自' + from + '，与异闻手记独立。世界构建技能常驻，其余技能可自由开关。' })));
        for (const err of rep.errors)
          skillList.append(el('div', { class: 'skill-load-err', text: '✕ ' + err }));
      } else {
        skillList.append(el('div', { class: 'hint',
          text: '本页技能加载失败，请重新加载或重新构建页面。' }));
      }
      if (!all.length) skillList.append(el('div', { class: 'tree-empty', text: '技能尚未加载，请重新加载本页资源。' }));
      for (const sk of all) {
        const off = isSkillDisabled(sk.name);
        const required = DesignerResources.isRequired(sk.name);
        const fileCount = Object.keys(sk.files || {}).length;
        const actions = el('div', { class: 'sk-actions' });
        // 特殊技能常驻，其他技能关闭后卸载提示词、工具和附件。
        actions.append(el('button', {
          class: 'sk-toggle' + (off ? '' : ' on'),
          disabled: required,
          role: 'switch', 'aria-checked': String(!off),
          'aria-label': sk.name + (required ? '：特殊技能，始终启用' : '：启用技能'),
          title: required ? '特殊技能，始终启用且不可关闭' : off ? '当前已禁用，点击启用' : '当前已启用，点击禁用',
          onclick: async () => { await toggleSkillEnabled(sk.name); renderSkillList(); },
        }, el('span', { class: 'knob' })));
        actions.append(required
          ? el('span', { class: 'tag required-badge', text: '特殊 · 常驻', title: '主体紧随系统提示词注入' })
          : sk.builtin
          ? el('span', { class: 'tag', title: sk.source ? '发现方式: ' + sk.source : '', text: '内置' })
          : el('button', { class: 'danger', text: '删除', onclick: async () => {
              if (!await confirmDialog('删除 Skill', '删除 Skill「' + sk.name + '」？此操作不可恢复。', true)) return;
              S.userSkills = S.userSkills.filter(x => x.name !== sk.name);
              await DB.del('userSkills', sk.name);
              // 一并清掉禁用记录，避免同名 Skill 重新导入后仍是禁用态
              if (S.disabledSkills.delete(sk.name)) await saveDisabledSkills();
              if (S.tree) {
                const root = VFS.resolve(S.tree, ['skills']);
                if (root) root.children = {};
                mountSkillFiles(S.tree); await saveTree(); renderFileTree();
              }
              renderSkillList();
            } }));
        skillList.append(el('div', { class: 'skill-item' + (required ? ' required' : '') + (off ? ' disabled' : ''), 'data-skill': sk.name },
          el('span', { class: 'grow', text: sk.name + ' — ' + sk.description
            + (fileCount ? '（' + fileCount + ' 个附件）' : '') }),
          sk.warnings && sk.warnings.length
            ? el('span', { class: 'warn-mark', text: '⚠', title: sk.warnings.join('\n') }) : null,
          actions));
      }
      skillList.append(el('div', { style: 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap' },
        el('button', { text: '↻ 重新加载技能', title: '重新读取世界设计者的四个技能', onclick: async () => {
          await reloadExternalSkills();
          renderSkillList();
          toast(S.skillLoad && S.skillLoad.available
            ? '已重新加载：' + S.externalSkills.length + ' 个内置 Skill'
            : '本页技能加载失败');
        } })));
      skillSection.innerHTML = '';
      // 计数显示「生效/总数」，一眼看出有没有被禁用的
      const label = activeCount === all.length ? String(all.length) : activeCount + '/' + all.length;
      const box = collapsible('Skill', skillList, all.length);
      const cnt = box.querySelector('.count');
      if (cnt) { cnt.textContent = label; cnt.title = '已启用 ' + activeCount + ' / 共 ' + all.length; }
      skillSection.append(box);
    };
    renderSkillList();

    ov.append(el('div', { class: 'modal' },
      el('h3', { text: '设置' }),
      el('div', { class: 'settings-project' },
        el('a', { class: 'github-link', href: 'https://github.com/clinlx/unusual-book-agent-for-web', target: '_blank', rel: 'noopener noreferrer', title: '在 GitHub 查看项目', 'aria-label': '在 GitHub 查看异闻手记项目' }, icon('github'), el('span', { text: 'GitHub' }))),
      apiHeading, apiHelp,
      field('API Base URL', baseUrlWrap), field('API Key', apiKey), field('模型', modelWrap),
      field('温度', temp), field('思考强度', effortWrap), field('流式输出', stream),
      field('视觉模型', imageSending),
      el('div', { class: 'row' }, el('label', { text: '' }), el('div', { style: 'flex:1;min-width:0' }, testBtn, testResult)),
      el('div', { class: 'section' }, el('h3', { text: '上下文' }),
        field('满上下文处理', overflow, ['contextOverflow', 'disabled', 'sliding', 'truncate', 'compress']),
        field('最大上下文', ctxSel), field('', ctxCustom)),
      el('div', { class: 'section' }, el('h3', { text: '界面' }),
        field('反转发送与换行', reverseSendNewline),
        el('div', { class: 'hint', text: '默认 Ctrl / ⌘ + Enter 发送、Enter 换行；开启后 Enter 发送、Ctrl / ⌘ + Enter 换行。' }),
        field('编辑器打开位置', editorPos),
        el('div', { class: 'hint', text: '窄屏（手机）始终在「文件」标签内打开，不受此项影响。' }),
        field('思考过程', expandThink),
        field('变更审阅范围', changeScope, ['changeScope', 'scopeLast', 'scopeAccumulate'])),
      el('div', { class: 'section' }, skillSection),
      el('div', { class: 'section' }, projSection),
      el('div', { class: 'section' }, el('h3', { text: '数据管理' }),
        el('div', { class: 'hint', text: '统计仅包含用户数据，已排除内置技能、未改动的预制文件和空会话基础记录。可在上方按项目清理；文件、对话及草稿会永久删除，请先下载备份。' }),
        el('div', { class: 'row' },
          el('button', { class: 'danger', text: '清理所有撤回数据', onclick: async () => {
            if (!await confirmDialog('清理所有撤回数据', '删除全部项目的所有撤回点，均不可再回滚历史。', true)) return;
            await DB.delWhere('snapshots', () => true);
            S.snapshots = [];
            for (const p of S.projects) { p.historyLocked = true; await DB.put('projects', p); }
            renderChat(); renderProjStore(); toast('已清理');
          } }),
          el('button', { class: 'danger', text: '清理全部数据', onclick: async () => {
            if (!await confirmDialog('清理全部数据', '删除所有项目、会话、文件与设置，恢复出厂状态。页面将刷新。', true)) return;
            await DB.wipeAll(); location.reload();
          } }))),
      el('div', { class: 'section' }, agentSection),
      el('div', { class: 'foot' },
        el('button', { text: '取消', onclick: close }),
        el('button', { class: 'primary', text: '保存', onclick: async () => {
          let maxK;
          if (ctxSel.value === 'custom') {
            maxK = validateCustomContextK(ctxCustom.value);
            if (maxK === null) { toast('自定义上限无效：需为 1–10000 的整数（单位 k）'); return; }
          } else maxK = Number(ctxSel.value);
          S.settings = {
            baseUrl: baseUrl.value.trim() || DEFAULT_SETTINGS.baseUrl,
            apiKey: apiKey.value.trim(),
            model: model.value.trim() || DEFAULT_SETTINGS.model,
            temperature: Number(temp.value) || 0.7,
            stream: stream.value === '1',
            imageSending: imageSending.value === '1',
            reverseSendNewline: reverseSendNewline.checked,
            contextOverflow: overflow.value,
            maxContextK: maxK,
            contextLimitMode: ctxSel.value === 'custom' ? 'custom' : 'preset',
            editorPosition: editorPos.value,
            changeScope: changeScope.value,
            reasoningDisplay: expandThink.value,
            reasoningEffort: Agent.EFFORT_LEVELS[+effortSlider.value] || 'high',
            // 与默认值相同则存空串：这样日后默认提示词改进了，未自定义的用户能自动跟进
            systemPromptOverride: sysPromptInput.value.trim() === AGENT_CONFIG.systemPrompt.trim()
              ? '' : sysPromptInput.value,
          };
          await DB.put('config', { id: 'settings', value: S.settings });
          // 编辑器位置变了要重挂 DOM；若正开着编辑器则原地迁移
          applyEditorPosition();
          renderCtxBadge();
          renderChat();          // 思考卡片的默认展开状态可能变了
          close(); toast('设置已保存');
        } }))));
    document.body.append(ov);
  }

  // 暴露给冒烟调试：状态与少量重渲染入口
  window.__UI_STATE__ = S;
  window.addEventListener('pageshow', event => { if (event.persisted && S.tree) validateWorkspace(); });
  window.__UI__ = { renderAll, renderFileTree, renderChat, saveTree, openEditor, closeEditor, setTab, importDroppedFiles, requestMessages, applyEditorPosition, applyPanes, testConnection, recordPendingChange, syncOpenEditor, openReview, acceptFile, rejectFile, acceptAll, rejectAll, renderReview, askUserDialog };
})();
