/**
 * dsh-tv-player client half: the browser TV player, loaded by the web
 * ModuleLoader as a plain React plugin. It injects a now-playing bar into the
 * composer dock, a floating draggable video window (画中画/PiP for the
 * "Vibe coding companion" use case), and a channel panel grouped by 央视/凤凰/卫视.
 *
 * Video is a native <video> element played through the Host's same-origin HLS
 * proxy (/dsh-tv/playlist + /dsh-tv/segment). HLS is decoded in the browser by
 * the vendored hls.js (served from /dsh-tv/vendor/hls.min.js, injected via a
 * <script> tag) with a native-HLS fallback for Safari. Host communication is
 * plain HTTP to the /dsh-tv/(manifest|channels|intent|prefs) routes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-tv-player',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const ReactDOM = require('react-dom');
    const { useState, useEffect, useRef, useCallback, useSyncExternalStore } = React;
    const createPortal = (ReactDOM && typeof ReactDOM.createPortal === 'function')
      ? (node, container) => ReactDOM.createPortal(node, container)
      : (node) => node;
    const portalToBody = (node) => createPortal(node, document.body);

    // ================= 小工具 =================
    const jsonGet = async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    };
    const jsonPost = async (url, body) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    };

    // ================= 模块级 store（useSyncExternalStore）=================
    const initialState = () => ({
      channels: [],
      groups: { cctv: '央视 CCTV', phoenix: '凤凰卫视 Phoenix', satellite: '卫视 Satellite', other: '其他 Other' },
      loading: false,
      source: '',
      current: null,       // { id, name, url, group, logo }
      playing: false,
      volume: 1,
      muted: false,
      panelOpen: false,
      windowVisible: false,
      search: '',
      favs: [],            // 收藏的频道稳定键（数组，便于 useSyncExternalStore 快照）
      customSources: [],   // 自定义 m3u 源
      searching: false,    // 搜索频道中
      searchResults: [],   // 搜索到的可播放频道
      searchOpen: false,   // 搜索框是否展开
      tempChannels: [],    // 临时频道（搜索后添加，显示在底部临时频道栏）
      recent: [],          // 最近播放
      epg: {},             // { channelId: { title, start, stop } } 当前节目
      mirroring: false,    // 多标签页：本页是否为「镜像态」（另一页正在出声）
      schedule: [],        // 定时规则（换台/关电视/关电脑）
      error: null,
      hlsReady: false,
    });
    let state = initialState();
    const listeners = new Set();
    const getState = () => state;
    const set = (patch) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      listeners.forEach((l) => l());
    };
    const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };

    // ================= 媒体元素与 hls.js =================
    const video = document.createElement('video');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.objectFit = 'contain';
    video.style.background = '#ffffff';
    let hls = null;
    let hlsLibPromise = null;
    let sidebarRightSvc = null;   // ctx.get('sidebarRight')，用于在右侧栏打开网页（原生浏览器 tab）

    // ================= 多标签页统一播放器（BroadcastChannel）=================
    // 同一时刻只有一页出声（「出声页」），其余页静音并进入「镜像态」（显示同一频道、
    // 同一播放状态 + 提示声音来自另一页）。用户在某页点 ▶ 会重新「抢占」出声权。
    const XTAB = 'dsh-tv-player';
    const tabId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    let xtab = null;
    let ownerId = null;        // 非 null = 另一页 tabId 是出声页
    let lastOwnerPing = 0;

    function xtabInit() {
      if (typeof BroadcastChannel === 'undefined') return;
      try {
        xtab = new BroadcastChannel(XTAB);
        xtab.onmessage = (ev) => {
          const m = ev.data || {};
          if (!m || m.tabId === tabId) return;
          if (m.type === 'claim') {
            ownerId = m.tabId;
            lastOwnerPing = Date.now();
            try { video.muted = true; } catch (e) {}
            set({ mirroring: true });
          } else if (m.type === 'bye') {
            if (ownerId === m.tabId) { ownerId = null; set({ mirroring: false }); }
          } else if (m.type === 'ping') {
            if (ownerId === m.tabId) lastOwnerPing = Date.now();
          }
        };
      } catch (e) { xtab = null; }
    }
    function xtabClaim() {
      ownerId = null;
      set({ mirroring: false });
      try { video.muted = state.muted; } catch (e) {}
      if (xtab) { try { xtab.postMessage({ type: 'claim', tabId }); } catch (e) {} }
    }
    function xtabBye() {
      if (xtab) { try { xtab.postMessage({ type: 'bye', tabId }); } catch (e) {} }
    }

    const loadHlsLib = () => {
      if (window.Hls) { set({ hlsReady: true }); return Promise.resolve(); }
      if (hlsLibPromise) return hlsLibPromise;
      hlsLibPromise = new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = '/dsh-tv/vendor/hls.min.js';
        s.onload = () => { set({ hlsReady: true }); resolve(); };
        s.onerror = () => { resolve(); }; // 失败也继续，走 canPlayType 原生回退
        document.head.appendChild(s);
      });
      return hlsLibPromise;
    };

    const destroyHls = () => {
      if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
      video.onerror = null;
    };

    const attachNative = (proxyUrl) => {
      destroyHls();
      video.src = proxyUrl;
      video.load();
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => { set({ error: '浏览器拦截了自动播放，请点 ▶ 解锁', playing: false }); });
    };

    // ---- 多源容灾：主 URL 失效自动切换下一候选源 ----
    let currentChannel = null;   // { id, name, urls: [...] }
    let currentUrlIndex = 0;
    const deadUrls = new Map();  // url -> 失效时刻（60s 冷却）
    const isDead = (url) => { const t = deadUrls.get(url); return !!t && Date.now() - t < 60000; };
    const markDead = (url) => { if (url) deadUrls.set(url, Date.now()); };

    const attachHls = (proxyUrl, rawUrl) => {
      destroyHls();
      if (window.Hls && window.Hls.isSupported()) {
        const h = new window.Hls({ enableWorker: true });
        hls = h;
        h.loadSource(proxyUrl);
        h.attachMedia(video);
        h.on(window.Hls.Events.MANIFEST_PARSED, () => {
          const p = video.play();
          if (p && typeof p.catch === 'function') p.catch(() => { set({ error: '浏览器拦截了自动播放，请点 ▶ 解锁', playing: false }); });
        });
        h.on(window.Hls.Events.ERROR, (_evt, data) => {
          if (data && data.fatal) {
            set({ error: '播放错误：' + (data.details || data.type || '未知') });
            markDead(rawUrl);
            tryNextUrl();
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.onerror = () => { markDead(rawUrl); tryNextUrl(); };
        attachNative(proxyUrl);
      } else {
        set({ error: '当前浏览器不支持 HLS 播放（请使用 Chrome/Edge/Safari）' });
      }
    };

    // 尝试当前频道下一个可用源；全部失效则明确报错（60s 冷却后或手动重选频道可重试）。
    const tryNextUrl = () => {
      const ch = currentChannel;
      const urls = (ch && Array.isArray(ch.urls) && ch.urls.length > 0) ? ch.urls : (ch ? [ch.url] : []);
      let idx = currentUrlIndex;
      while (idx < urls.length && isDead(urls[idx])) idx++;
      if (idx >= urls.length) {
        set({ error: '该频道所有直播源均失效，请在频道面板点「⟳」刷新源，或稍后重试', playing: false });
        return;
      }
      currentUrlIndex = idx;
      attachHls(proxyUrlFor(urls[idx]), urls[idx]);
    };

    const proxyUrlFor = (url) => '/dsh-tv/playlist?u=' + encodeURIComponent(url);

    const playChannel = (ch) => {
      if (!ch) return;
      const sameAsCurrent = state.current && state.current.id === ch.id && !!video.src;
      set({ current: ch, error: null, windowVisible: true });
      savePrefs({ lastChannel: { id: ch.id, name: ch.name, url: ch.url } });
      recordRecent(ch);
      if (sameAsCurrent) {
        // 已在播同一频道：直接续播，不重新挂流。
        resume();
        return;
      }
      // 重置容灾状态，从第一个可用源开始。
      currentChannel = ch;
      currentUrlIndex = 0;
      deadUrls.clear();
      loadHlsLib().then(() => {
        tryNextUrl();
        set({ playing: true });
      });
    };

    const pause = () => { try { video.pause(); } catch (e) {} set({ playing: false }); };
    const resume = () => {
      if (!state.current) return;
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch((err) => { if (err && err.name === 'NotAllowedError') set({ error: '浏览器拦截了自动播放，请点 ▶ 解锁' }); });
      set({ playing: true });
    };
    const stop = () => {
      try { video.pause(); } catch (e) {}
      destroyHls();
      video.removeAttribute('src');
      video.load();
      currentChannel = null;
      currentUrlIndex = 0;
      deadUrls.clear();
      set({ current: null, playing: false, windowVisible: false, error: null });
    };
    const setMuted = (m) => { video.muted = m; set({ muted: m }); savePrefs({ muted: m }); };
    const setVolume = (v) => { video.volume = v; set({ volume: v }); savePrefs({ volume: v }); };
    const step = (dir) => {
      const list = state.channels || [];
      if (list.length === 0) return;
      const idx = state.current ? list.findIndex((c) => c.id === state.current.id) : -1;
      const next = list[(idx + dir + list.length) % list.length];
      playChannel(next);
    };
    // 随机播放一个频道（无当前频道时点 ▶ 用）。
    const playRandom = () => {
      const list = state.channels || [];
      if (list.length === 0) return;
      const pick = list[Math.floor(Math.random() * list.length)];
      playChannel(pick);
    };

    // ================= 偏好持久化（Host，防抖）=================
    let prefsTimer = null;
    let pendingPrefs = {};
    const savePrefs = (patch) => {
      pendingPrefs = { ...pendingPrefs, ...patch };
      if (prefsTimer) clearTimeout(prefsTimer);
      prefsTimer = setTimeout(async () => {
        const p = pendingPrefs; pendingPrefs = {};
        try { await jsonPost('/dsh-tv/prefs', p); } catch (e) {}
      }, 600);
    };
    const loadPrefs = async () => {
      try {
        const r = await jsonGet('/dsh-tv/prefs');
        if (r && r.prefs) {
          set({
            volume: typeof r.prefs.volume === 'number' ? r.prefs.volume : 1,
            muted: !!r.prefs.muted,
          });
          video.volume = state.volume;
          video.muted = state.muted;
        }
      } catch (e) {}
    };

    // ================= 频道目录 =================
    const loadChannels = async (force) => {
      set({ loading: true });
      try {
        const r = await jsonGet('/dsh-tv/channels' + (force ? '?refresh=1' : ''));
        if (r && Array.isArray(r.channels)) {
          set({ channels: r.channels, source: r.source || '', loading: false });
        } else {
          set({ loading: false });
        }
      } catch (e) {
        set({ loading: false, error: '频道目录加载失败' });
      }
    };
    const loadManifest = async () => {
      try {
        const r = await jsonGet('/dsh-tv/manifest');
        if (r && r.groups) set({ groups: r.groups });
      } catch (e) {}
    };

    // ================= 收藏频道 =================
    const loadFavs = async () => {
      try {
        const r = await jsonGet('/dsh-tv/favs');
        if (r && Array.isArray(r.favs)) set({ favs: r.favs });
      } catch (e) {}
    };
    const toggleFav = async (id) => {
      // 乐观更新，再同步服务端。
      const cur = state.favs.slice();
      const on = !cur.includes(id);
      set({ favs: on ? [...cur, id] : cur.filter((x) => x !== id) });
      try { await jsonPost('/dsh-tv/favs/toggle', { id }); } catch (e) { loadFavs(); }
    };

    // ================= 自定义 m3u 源 =================
    const loadSources = async () => {
      try {
        const r = await jsonGet('/dsh-tv/sources');
        if (r && Array.isArray(r.custom)) set({ customSources: r.custom });
      } catch (e) {}
    };
    // 搜索频道：从公开源查找可播放（AAC）频道；空查询返回可浏览列表。
    const doSearchChannels = async (q, refresh) => {
      const query = String(q || '').trim();
      set({ searching: true });
      try {
        const r = await jsonGet('/dsh-tv/search?q=' + encodeURIComponent(query) + (refresh ? '&refresh=1' : ''));
        if (r && Array.isArray(r.results)) set({ searchResults: r.results, searching: false });
        else set({ searching: false });
      } catch (e) { set({ searching: false, error: '搜索失败' }); }
    };
    // 临时频道：把搜索到的频道加入底部临时频道栏（去重）。
    const addTempChannel = (c) => {
      set((s) => {
        if (s.tempChannels.some((t) => t.id === c.id)) return s;
        return { tempChannels: [...s.tempChannels, { id: c.id, name: c.name, url: c.url, group: c.group || 'other', urls: Array.isArray(c.urls) && c.urls.length > 0 ? c.urls : [c.url] }] };
      });
    };
    const removeTempChannel = (id) => {
      set((s) => ({ tempChannels: s.tempChannels.filter((t) => t.id !== id) }));
    };
    const addSource = async (url) => {
      try {
        const r = await jsonPost('/dsh-tv/sources', { url });
        if (r && Array.isArray(r.custom)) set({ customSources: r.custom });
        loadChannels(true);
      } catch (e) { set({ error: '添加源失败' }); }
    };
    const removeSource = async (url) => {
      try {
        const r = await jsonPost('/dsh-tv/sources/remove', { url });
        if (r && Array.isArray(r.custom)) set({ customSources: r.custom });
        loadChannels(true);
      } catch (e) { set({ error: '移除源失败' }); }
    };

    // ================= 最近播放 =================
    const loadRecent = async () => {
      try {
        const r = await jsonGet('/dsh-tv/recent');
        if (r && Array.isArray(r.recent)) set({ recent: r.recent });
      } catch (e) {}
    };
    const recordRecent = (ch) => {
      if (!ch || !ch.id) return;
      // 乐观更新 + 异步落盘。
      set({ recent: [ch, ...state.recent.filter((x) => x.id !== ch.id)].slice(0, 12) });
      jsonPost('/dsh-tv/recent', { id: ch.id, name: ch.name, url: ch.url, group: ch.group || 'other' }).catch(() => {});
    };

    // ================= EPG 节目单 =================
    const loadEpg = async () => {
      try {
        const r = await jsonGet('/dsh-tv/epg');
        if (r && r.programs && typeof r.programs === 'object') set({ epg: r.programs });
      } catch (e) {}
    };

    // ================= 定时换台 =================
    const loadSchedule = async () => {
      try {
        const r = await jsonGet('/dsh-tv/schedule');
        if (r && Array.isArray(r.schedule)) set({ schedule: r.schedule });
      } catch (e) {}
    };
    const addSchedule = async (rule) => {
      try {
        const r = await jsonPost('/dsh-tv/schedule', rule);
        if (r && Array.isArray(r.schedule)) set({ schedule: r.schedule });
      } catch (e) { set({ error: '添加定时失败' }); }
    };
    const removeSchedule = async (id) => {
      try {
        const r = await jsonPost('/dsh-tv/schedule/remove', { id });
        if (r && Array.isArray(r.schedule)) set({ schedule: r.schedule });
      } catch (e) {}
    };
    const toggleSchedule = async (id) => {
      try {
        const r = await jsonPost('/dsh-tv/schedule/toggle', { id });
        if (r && Array.isArray(r.schedule)) set({ schedule: r.schedule });
      } catch (e) {}
    };
    const runSchedule = async (id) => {
      try { await jsonPost('/dsh-tv/schedule/run-now', { id }); } catch (e) {}
    };

    // ================= 组件：电视画面 + 播放条（dock，与输入框同框）=================
    function TvDock() {
      const st = useSyncExternalStore(subscribe, getState);
      const cur = st.current;
      const videoVisible = !!(cur && st.windowVisible);

      // 把全局 video 元素稳定挂到视频容器里（容器常驻 DOM，避免反复移动导致播放中断）。
      const attachVideo = useCallback((el) => {
        if (el && el !== video.parentNode) el.appendChild(video);
      }, []);

      return React.createElement('div', { className: 'dsh-tv-dock' },
        // 电视画面（全宽，与播放条等宽；隐藏时折叠）
        React.createElement('div', {
          className: 'dsh-tv-video' + (videoVisible ? '' : ' dsh-tv-video-hidden'),
          ref: attachVideo,
        }),
        // 播放条（白底黑字）
        React.createElement('div', { className: 'dsh-tv-bar' },
          React.createElement('div', { className: 'dsh-tv-bar-main' },
            React.createElement('button', {
              className: 'dsh-tv-icon-btn',
              title: st.playing ? '暂停 Pause' : (cur ? '播放 Play' : '随机播放 Random Play'),
              onClick: () => {
                if (st.playing) { pause(); return; }
                if (cur) { resume(); return; }
                playRandom();
              },
            }, st.playing ? '⏸' : '▶'),
            React.createElement('div', { className: 'dsh-tv-bar-info' },
              React.createElement('span', { className: 'dsh-tv-bar-title' }, cur ? cur.name : 'DSH 电视'),
              cur ? React.createElement('span', { className: 'dsh-tv-bar-sub' },
                (st.groups[cur.group] || cur.group) + ' · LIVE' + (st.mirroring ? ' · 🔇 另一页正在播放' : ''),
              ) : null,
            ),
            React.createElement('button', {
              className: 'dsh-tv-icon-btn',
              title: st.muted ? '取消静音 Unmute' : '静音 Mute',
              onClick: () => setMuted(!st.muted),
            }, st.muted ? '🔇' : '🔊'),
            React.createElement('input', {
              className: 'dsh-tv-vol dsh-tv-vol-bar',
              type: 'range', min: 0, max: 1, step: 0.01, value: st.muted ? 0 : st.volume,
              title: '音量 Volume',
              onChange: (e) => { const v = parseFloat(e.target.value); if (v > 0 && st.muted) setMuted(false); setVolume(v); },
            }),
            React.createElement('button', {
              className: 'dsh-tv-icon-btn',
              title: '上一个频道 Previous',
              onClick: () => step(-1),
            }, '⏮'),
            React.createElement('button', {
              className: 'dsh-tv-icon-btn',
              title: '下一个频道 Next',
              onClick: () => step(1),
            }, '⏭'),
            cur ? React.createElement('button', {
              className: 'dsh-tv-icon-btn',
              title: '停止 Stop',
              onClick: stop,
            }, '⏹') : null,
            cur ? React.createElement('button', {
              className: 'dsh-tv-icon-btn' + (st.windowVisible ? ' dsh-tv-on' : ''),
              title: st.windowVisible ? '隐藏电视画面 Hide TV' : '显示电视画面 Show TV',
              onClick: () => {
                if (st.windowVisible) {
                  // 隐藏画面：若正在画中画，先退出画中画，避免视频回落到已隐藏的容器里。
                  if (document.pictureInPictureElement) {
                    try { document.exitPictureInPicture(); } catch (e) {}
                  }
                  set({ windowVisible: false });
                } else {
                  set({ windowVisible: true });
                }
              },
            }, st.windowVisible ? '👁' : '🙈') : null,
            React.createElement('button', {
              className: 'dsh-tv-icon-btn',
              title: '频道列表 Channel List',
              onClick: () => set({ panelOpen: !st.panelOpen }),
            }, '📺'),
            React.createElement('button', {
              className: 'dsh-tv-icon-btn',
              title: '上网 · aichinesechess.com（右侧栏浏览器）Browse',
              onClick: () => {
                if (!sidebarRightSvc) { set({ error: '右侧栏浏览器不可用（sidebarRight 未注入）' }); return; }
                try { sidebarRightSvc.openTab('browser', { params: { url: 'https://aichinesechess.com' } }); } catch (e) { set({ error: '打开失败：' + String((e && e.message) || e) }); }
              },
            }, '🌐'),
          ),
          // 频道面板（锚定到频道列表按钮上方）
          React.createElement(TvPanel),
        ),
      );
    }

    // ================= 组件：频道面板（锚定到电视区右侧）=================
    const WEEKDAYS = [['每天 Every Day', 0], ['周一 Mon', 1], ['周二 Tue', 2], ['周三 Wed', 3], ['周四 Thu', 4], ['周五 Fri', 5], ['周六 Sat', 6], ['周日 Sun', 7]];
    const SCH_ACTIONS = [['换台 Switch', 'switch'], ['关电视 TV Off', 'tvoff'], ['关电脑 Shutdown', 'shutdown']];
    function TvPanel() {
      const st = useSyncExternalStore(subscribe, getState);
      const [schTime, setSchTime] = useState('19:00');
      const [schDow, setSchDow] = useState(0);
      const [schChan, setSchChan] = useState('');
      const [schAction, setSchAction] = useState('switch');
      if (!st.panelOpen) return null;

      const renderChannel = (c) => {
        const isFav = st.favs.includes(c.id);
        const active = st.current && st.current.id === c.id;
        const epg = st.epg[c.id];
        return React.createElement('div', {
          key: c.id + '|' + c.name,
          className: 'dsh-tv-channel' + (active ? ' active' : ''),
          onClick: () => playChannel(c),
        },
          React.createElement('div', { className: 'dsh-tv-channel-main' },
            React.createElement('span', { className: 'dsh-tv-channel-name' },
              c.name,
              c.quality ? React.createElement('span', { className: 'dsh-tv-quality-badge' }, c.quality) : null,
            ),
            epg && epg.title
              ? React.createElement('span', { className: 'dsh-tv-channel-epg', title: epg.title }, '现在 Now · ' + epg.title)
              : null,
          ),
          React.createElement('button', {
            className: 'dsh-tv-fav' + (isFav ? ' on' : ''),
            title: isFav ? '取消收藏 Unfavorite' : '收藏 Favorite',
            onClick: (e) => { e.stopPropagation(); toggleFav(c.id); },
          }, isFav ? '★' : '☆'),
          active ? React.createElement('span', { className: 'dsh-tv-live-badge' }, 'LIVE') : null,
        );
      };

      const groupList = () => {
        const groups = ['satellite', 'cctv', 'phoenix', 'other'];
        const out = [];
        const favChannels = st.channels.filter((c) => st.favs.includes(c.id));
        if (favChannels.length > 0) {
          out.push(React.createElement('div', { key: '__fav__', className: 'dsh-tv-group' },
            React.createElement('div', { className: 'dsh-tv-group-title' }, '★ 我的收藏 Favorites'),
            favChannels.map(renderChannel),
          ));
        }
        for (const g of groups) {
          const list = st.channels.filter((c) => c.group === g);
          if (list.length === 0) continue;
          out.push(React.createElement('div', { key: g, className: 'dsh-tv-group' },
            React.createElement('div', { className: 'dsh-tv-group-title' }, st.groups[g] || g),
            list.map(renderChannel),
          ));
        }
        return out;
      };

      const actionLabel = (r) => {
        if (r.action === 'tvoff') return '关电视 TV Off';
        if (r.action === 'shutdown') return '关电脑 Shutdown';
        return '换台 Switch → ' + (r.channelName || r.channelId);
      };

      return React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'dsh-tv-panel-backdrop', onClick: () => set({ panelOpen: false }) }),
        React.createElement('div', { className: 'dsh-tv-panel', onClick: (e) => e.stopPropagation() },
          React.createElement('div', { className: 'dsh-tv-panel-head' },
            React.createElement('span', { className: 'dsh-tv-panel-title' }, '频道列表 Channel List'),
            React.createElement('span', { className: 'dsh-tv-panel-src' }, st.source),
            React.createElement('button', { className: 'dsh-tv-icon-btn' + (st.searchOpen ? ' dsh-tv-on' : ''), title: '临时频道搜索 Search', onClick: () => { const next = !st.searchOpen; set({ searchOpen: next, search: '', searchResults: [] }); if (next) doSearchChannels(''); } }, '🔍'),
            React.createElement('button', { className: 'dsh-tv-icon-btn', title: '刷新频道源与搜索源 Refresh', onClick: () => { loadChannels(true); doSearchChannels(st.search, true); } }, (st.loading || st.searching) ? '…' : '⟳'),
            React.createElement('button', { className: 'dsh-tv-icon-btn', title: '关闭 Close', onClick: () => set({ panelOpen: false }) }, '✕'),
          ),
          st.searchOpen
            ? React.createElement('div', { className: 'dsh-tv-search-wrap' },
              React.createElement('input', {
                className: 'dsh-tv-search',
                placeholder: '搜索频道，点结果加入临时频道栏 Search…',
                value: st.search,
                autoFocus: true,
                onChange: (e) => { const v = e.target.value; set({ search: v }); doSearchChannels(v); },
              }),
              st.searching ? React.createElement('span', { className: 'dsh-tv-searching' }, '…') : null,
            )
            : null,
          st.searchOpen && st.searchResults.length > 0
            ? React.createElement('div', { className: 'dsh-tv-search-results' },
              st.searchResults.map((c) => React.createElement('div', {
                key: c.id + '|' + c.name,
                className: 'dsh-tv-channel',
                onClick: () => addTempChannel(c),
              },
                React.createElement('div', { className: 'dsh-tv-channel-main' },
                  React.createElement('span', { className: 'dsh-tv-channel-name' }, c.name),
                ),
                React.createElement('span', { className: 'dsh-tv-add-badge' }, '＋ 加入'),
              )),
            )
            : null,
          React.createElement('div', { className: 'dsh-tv-panel-body' },
            st.loading && st.channels.length === 0
              ? React.createElement('div', { className: 'dsh-tv-panel-empty' }, '正在加载频道目录 Loading…')
              : (st.channels.length === 0
                ? React.createElement('div', { className: 'dsh-tv-panel-empty' }, '暂无频道 No Channels')
                : groupList()),
          ),
          st.tempChannels.length > 0
            ? React.createElement('div', { className: 'dsh-tv-temp dsh-tv-schedule' },
              React.createElement('div', { className: 'dsh-tv-sources-title' }, '📌 临时频道 Temporary'),
              st.tempChannels.map((c) => React.createElement('div', { key: c.id + '|' + c.name, className: 'dsh-tv-temp-row' },
                React.createElement('span', { className: 'dsh-tv-temp-name' }, c.name),
                React.createElement('button', { className: 'dsh-tv-icon-btn mini', title: '播放 Play', onClick: () => playChannel(c) }, '▶'),
                React.createElement('button', { className: 'dsh-tv-icon-btn mini', title: '移除 Remove', onClick: () => removeTempChannel(c.id) }, '✕'),
              )),
            )
            : null,
          React.createElement('div', { className: 'dsh-tv-sources dsh-tv-schedule' },
            React.createElement('div', { className: 'dsh-tv-sources-title' }, '⏰ 定时 Schedule（换台 Switch / 关电视 TV Off / 关电脑 Shutdown）'),
            st.schedule.map((r) => {
              const dowLabel = (r.weekdays && r.weekdays.length > 0)
                ? r.weekdays.map((d) => ['一', '二', '三', '四', '五', '六', '日'][d - 1]).join('/')
                : '每天 Every Day';
              return React.createElement('div', { key: r.id, className: 'dsh-tv-sched-row' },
                React.createElement('span', { className: 'dsh-tv-sched-info' + (r.enabled ? '' : ' off') },
                  dowLabel + ' ' + r.time + ' · ' + actionLabel(r),
                ),
                React.createElement('button', { className: 'dsh-tv-icon-btn mini', title: r.enabled ? '停用 Disable' : '启用 Enable', onClick: () => toggleSchedule(r.id) }, r.enabled ? '●' : '○'),
                React.createElement('button', { className: 'dsh-tv-icon-btn mini', title: '立即执行 Run Now', onClick: () => runSchedule(r.id) }, '▶'),
                React.createElement('button', { className: 'dsh-tv-icon-btn mini', title: '删除 Delete', onClick: () => removeSchedule(r.id) }, '✕'),
              );
            }),
            React.createElement('div', { className: 'dsh-tv-src-add' },
              React.createElement('input', { className: 'dsh-tv-src-input', type: 'time', value: schTime, onChange: (e) => setSchTime(e.target.value) }),
              React.createElement('select', {
                className: 'dsh-tv-src-input',
                value: String(schDow),
                onChange: (e) => setSchDow(parseInt(e.target.value, 10)),
              }, WEEKDAYS.map(([label, v]) => React.createElement('option', { key: v, value: String(v) }, label))),
              React.createElement('select', {
                className: 'dsh-tv-src-input',
                value: schAction,
                onChange: (e) => setSchAction(e.target.value),
              }, SCH_ACTIONS.map(([label, v]) => React.createElement('option', { key: v, value: v }, label))),
              schAction === 'switch' ? React.createElement('select', {
                className: 'dsh-tv-src-input',
                value: schChan,
                onChange: (e) => setSchChan(e.target.value),
              },
                React.createElement('option', { value: '' }, '选择频道 Select Channel…'),
                st.channels.map((c) => React.createElement('option', { key: c.id, value: c.id }, c.name)),
              ) : null,
              React.createElement('button', {
                className: 'dsh-tv-icon-btn',
                title: '添加定时 Add',
                onClick: () => {
                  const wd = schDow === 0 ? [] : [schDow];
                  if (schAction === 'switch') {
                    const ch = st.channels.find((c) => c.id === schChan);
                    if (!ch) { set({ error: '请先选择频道' }); return; }
                    addSchedule({ time: schTime, weekdays: wd, action: 'switch', channelId: ch.id, channelName: ch.name, channelUrl: ch.url });
                  } else {
                    addSchedule({ time: schTime, weekdays: wd, action: schAction });
                  }
                },
              }, '＋'),
            ),
          ),
        ),
      );
    }

    // ================= apply =================
    const inject = ['slots', 'sidebarRight'];
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;
      const sidebarRight = ctx.sidebarRight || ctx.get('sidebarRight');
      sidebarRightSvc = (sidebarRight && typeof sidebarRight.openTab === 'function') ? sidebarRight : null;

      ctx.effect(() => {
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-plugin', 'dsh-tv-player');
        styleEl.textContent = PLAYER_CSS;
        document.head.appendChild(styleEl);
        return () => { if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); };
      });

      ctx.effect(() => {
        loadHlsLib();
        loadPrefs();
        loadManifest();
        loadChannels(false);
        loadFavs();
        loadSources();
        loadRecent();
        loadEpg();
        loadSchedule();
        xtabInit();

        // 出声即抢占多标签页出声权；暂停不改变 ownership。
        const onPlay = () => { xtabClaim(); set({ playing: true }); };
        const onPause = () => set({ playing: false });
        video.addEventListener('play', onPlay);
        video.addEventListener('pause', onPause);
        // 出声页心跳；镜像态 10s 未收到 ping 即判定出声页已关闭。
        const xtabPing = setInterval(() => {
          if (xtab && ownerId === null) { try { xtab.postMessage({ type: 'ping', tabId }); } catch (e) {} }
          if (ownerId !== null && Date.now() - lastOwnerPing > 10000) { ownerId = null; set({ mirroring: false }); }
        }, 3000);
        // 关页时交还出声权，其余页解除镜像态。
        const onPageHide = () => { try { video.pause(); } catch (e) {} xtabBye(); };
        window.addEventListener('pagehide', onPageHide);

        // 播放意图轮询。
        const intentTimer = setInterval(() => {
          jsonGet('/dsh-tv/intent').then((intent) => {
            if (intent === null || typeof intent !== 'object') return;
            const action = intent.action || 'play';
            if (action === 'pause') { pause(); return; }
            if (action === 'resume') { resume(); return; }
            if (action === 'stop') { stop(); return; }
            if (action === 'mute') { setMuted(true); return; }
            if (action === 'unmute') { setMuted(false); return; }
            if (action === 'next') { step(1); return; }
            if (action === 'prev') { step(-1); return; }
            // play：优先取目录里的完整频道对象（带多源 urls 容灾），退化为 intent 自带 URL。
            if (intent.kind === 'tv' && typeof intent.url === 'string') {
              const full = (state.channels || []).find((c) => c.id === intent.id)
                || { id: intent.id, name: intent.name, url: intent.url, group: intent.group || 'other', logo: intent.logo || '', urls: [intent.url] };
              playChannel(full);
            }
          }).catch(() => {});
        }, 2000);

        return () => {
          clearInterval(intentTimer);
          clearInterval(xtabPing);
          window.removeEventListener('pagehide', onPageHide);
          video.removeEventListener('play', onPlay);
          video.removeEventListener('pause', onPause);
        };
      }, 'dsh-tv-player: engine');

      ctx.effect(() => slots.inject('conversation.input.dock', () => slots.register(
        { name: 'conversation.input.dock', id: 'tv-player-bar', order: 41 },
        () => React.createElement(TvDock),
      )), 'dsh-tv-player: bar + video + panel');
    }

    exports.apply = apply;
    exports.inject = inject;

    // ================= CSS =================
    const PLAYER_CSS = '\n' +
      '.dsh-tv-dock{display:flex;flex-direction:column;gap:8px;width:100%;box-sizing:border-box;position:relative;}\n' +
      '.dsh-tv-video{width:100%;aspect-ratio:16/9;max-height:45vh;background:#ffffff;border:1px solid #e0e0e0;border-radius:10px;overflow:hidden;box-sizing:border-box;}\n' +
      '.dsh-tv-video video{display:block;width:100%;height:100%;object-fit:contain;background:#ffffff;}\n' +
      '.dsh-tv-video-hidden{display:none;}\n' +
      '.dsh-tv-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;border:1px solid #e0e0e0;border-radius:10px;background:#ffffff;font-size:13px;width:100%;box-sizing:border-box;position:relative;}\n' +
      '.dsh-tv-bar-main{display:flex;align-items:center;gap:6px;min-width:0;flex:1;}\n' +
      '.dsh-tv-bar-side{display:flex;align-items:center;gap:4px;}\n' +
      '.dsh-tv-bar-info{display:flex;flex-direction:column;min-width:0;}\n' +
      '.dsh-tv-bar-title{font-weight:600;color:#111111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}\n' +
      '.dsh-tv-bar-sub{font-size:11px;color:#666666;}\n' +
      '.dsh-tv-icon-btn{display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:26px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:#111111;cursor:pointer;font-size:14px;line-height:1;}\n' +
      '.dsh-tv-icon-btn:hover{background:rgba(0,0,0,.06);}\n' +
      '.dsh-tv-icon-btn.dsh-tv-on{background:rgba(66,133,244,.15);color:#1a73e8;}\n' +
      '.dsh-tv-icon-btn.mini{min-width:22px;height:22px;font-size:12px;}\n' +
      '.dsh-tv-panel-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:2000;}\n' +
      '.dsh-tv-panel{position:absolute;left:0;bottom:calc(100% + 8px);width:360px;max-width:92%;max-height:60vh;background:#ffffff;border:1px solid #e0e0e0;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.15);display:flex;flex-direction:column;overflow:hidden;color:#111111;z-index:2001;}\n' +
      '.dsh-tv-panel-head{display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid #e0e0e0;}\n' +
      '.dsh-tv-panel-title{font-weight:600;flex:1;color:#111111;}\n' +
      '.dsh-tv-panel-src{font-size:11px;color:#666666;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}\n' +
      '.dsh-tv-panel-empty{padding:20px;text-align:center;color:#666666;}\n' +
      '.dsh-tv-group{padding:4px 0;}\n' +
      '.dsh-tv-group-title{padding:6px 12px;font-size:11px;font-weight:600;color:#666666;text-transform:uppercase;letter-spacing:.05em;}\n' +
      '.dsh-tv-channel{display:flex;align-items:center;gap:6px;padding:7px 12px;cursor:pointer;color:#111111;}\n' +
      '.dsh-tv-channel:hover{background:rgba(0,0,0,.05);}\n' +
      '.dsh-tv-channel.active{background:rgba(66,133,244,.15);}\n' +
      '.dsh-tv-channel-main{flex:1;min-width:0;display:flex;flex-direction:column;}\n' +
      '.dsh-tv-channel-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}\n' +
      '.dsh-tv-quality-badge{margin-left:6px;padding:0 5px;border-radius:4px;background:rgba(0,0,0,.06);font-size:10px;font-weight:600;color:#666666;vertical-align:1px;}\n' +
      '.dsh-tv-channel-epg{font-size:11px;color:#666666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}\n' +
      '.dsh-tv-fav{border:0;background:transparent;color:#666666;cursor:pointer;font-size:14px;line-height:1;padding:2px;}\n' +
      '.dsh-tv-fav.on{color:#f6c344;}\n' +
      '.dsh-tv-fav:hover{transform:scale(1.15);}\n' +
      '.dsh-tv-live-badge{font-size:10px;font-weight:700;color:#e53935;letter-spacing:.05em;}\n' +
      '.dsh-tv-search-wrap{display:flex;align-items:center;gap:4px;padding:8px 12px;border-bottom:1px solid #e0e0e0;}\n' +
      '.dsh-tv-search{flex:1;height:30px;padding:0 10px;border:1px solid #e0e0e0;border-radius:7px;background:#ffffff;color:#111111;font-size:13px;outline:none;}\n' +
      '.dsh-tv-search:focus{border-color:#4285f4;}\n' +
      '.dsh-tv-searching{font-size:12px;color:#666666;padding:0 2px;}\n' +
      '.dsh-tv-search-results{max-height:40vh;overflow-y:auto;border-bottom:1px solid #e0e0e0;}\n' +
      '.dsh-tv-add-badge{font-size:11px;color:#4285f4;white-space:nowrap;}\n' +
      '.dsh-tv-temp-row{display:flex;align-items:center;gap:6px;padding:4px 0;}\n' +
      '.dsh-tv-temp-name{flex:1;min-width:0;font-size:13px;color:#111111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}\n' +
      '.dsh-tv-panel-body{flex:1;overflow-y:auto;}\n' +
      '.dsh-tv-sources{border-top:1px solid #e0e0e0;padding:8px 12px;background:#fafafa;}\n' +
      '.dsh-tv-sources-title{font-size:11px;font-weight:600;color:#666666;margin-bottom:6px;}\n' +
      '.dsh-tv-src-row{display:flex;align-items:center;gap:4px;padding:2px 0;}\n' +
      '.dsh-tv-src-url{flex:1;font-size:11px;color:#666666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}\n' +
      '.dsh-tv-src-dir{padding:5px 0;border-bottom:1px solid #e0e0e0;}\n' +
      '.dsh-tv-src-dir-main{flex:1;min-width:0;display:flex;flex-direction:column;}\n' +
      '.dsh-tv-src-dir-name{font-size:12px;color:#111111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}\n' +
      '.dsh-tv-src-dir-desc{font-size:10px;color:#666666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}\n' +
      '.dsh-tv-src-add{display:flex;align-items:center;gap:4px;margin-top:4px;}\n' +
      '.dsh-tv-src-input{flex:1;height:28px;padding:0 8px;border:1px solid #e0e0e0;border-radius:6px;background:#ffffff;color:#111111;font-size:12px;outline:none;min-width:0;}\n' +
      '.dsh-tv-schedule{border-top:1px solid #e0e0e0;}\n' +
      '.dsh-tv-sched-row{display:flex;align-items:center;gap:4px;padding:3px 0;}\n' +
      '.dsh-tv-sched-info{flex:1;font-size:12px;color:#111111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}\n' +
      '.dsh-tv-sched-info.off{color:#666666;text-decoration:line-through;}\n' +
      '.dsh-tv-vol{width:60px;accent-color:#4285f4;}\n' +
      '.dsh-tv-vol-bar{width:52px;}\n' +
      '';

    return module.exports;
  },
});
