// ==UserScript==
// @name         Boss直聘-好友列表浮窗
// @namespace    boss-spider
// @version      1.6.1
// @description  自动拉取联系人，按 3 天窗口分批请求 getGeekFriendList；用 localStorage 按 friendId+lastTS 做 diff 复用缓存，图表只展示最近 7 天，带页面内调试日志
// @match        https://www.zhipin.com/*
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const REQUEST_URL = '/wapi/zprelation/friend/getGeekFriendList.json';
    const LABEL_URL = '/wapi/zprelation/friend/geekFilterByLabel?labelId=0';
    // 留空则自动通过 geekFilterByLabel 拉取最近 30 天联系人，无需手动填写
    const FRIEND_IDS = '';

    // 分批参数：按 3 天一个时间窗拉取，单个请求最多 40 个 id（防止 friendIds 过长）
    const WINDOW_DAYS = 3;
    const MAX_IDS_PER_REQUEST = 40;
    // 图表只展示最近 N 天（更早的数据仍计入统计与清单）
    const CHART_DAYS = 7;
    // 请求间隔，避免过快触发风控
    const REQUEST_GAP_MS = 320;
    // 单个窗口失败后最多对半拆分几次
    const MAX_SPLIT_DEPTH = 5;

    // 本地缓存：按 friendId 存会话详情，lastTS 没变就直接复用
    const CACHE_KEY = 'boss-friend-list-cache-v1';
    const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 超过 12 小时即使 lastTS 没变也刷新一次（已读状态可能变）
    const CACHE_MAX_ENTRIES = 1200;

    // ---- UI ----
    const panel = document.createElement('div');
    panel.style.cssText = [
        'position:fixed', 'right:16px', 'top:96px', 'z-index:999999',
        'width:480px', 'max-height:82vh', 'display:flex', 'flex-direction:column',
        'background:#1e1e1e', 'color:#d4d4d4', 'font:12px/1.5 monospace',
        'border-radius:8px', 'box-shadow:0 4px 16px rgba(0,0,0,.4)',
        'border:1px solid #333'
    ].join(';');
    panel.innerHTML = `
        <div id="bf-header" style="padding:6px 10px;cursor:pointer;user-select:none;background:#2d2d2d;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center;flex:0 0 auto;">
            <span>Boss 好友列表</span><span id="bf-toggle" style="cursor:pointer;">—</span>
        </div>
        <div id="bf-body" style="padding:8px 10px;display:flex;flex-direction:column;gap:8px;overflow-y:auto;overflow-x:hidden;flex:1 1 auto;min-height:0;">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <button id="bf-send" style="padding:4px 14px;cursor:pointer;border:0;border-radius:4px;background:#00a6a7;color:#fff;">发送请求</button>
                <button id="bf-copy" style="padding:4px 14px;cursor:pointer;border:1px solid #555;border-radius:4px;background:transparent;color:#d4d4d4;">复制结果</button>
                <button id="bf-copy-log" style="padding:4px 10px;cursor:pointer;border:1px solid #444;border-radius:4px;background:transparent;color:#9a9a9a;">复制日志</button>
                <button id="bf-clear-cache" style="padding:4px 10px;cursor:pointer;border:1px solid #444;border-radius:4px;background:transparent;color:#9a9a9a;">清缓存</button>
                <span id="bf-status" style="line-height:24px;color:#6a9955;word-break:break-all;"></span>
            </div>

            <section class="bf-sec" data-sec="stats">
                <div class="bf-sec-head" data-sec="stats">
                    <span class="bf-sec-title">概览统计</span>
                    <span class="bf-sec-badge" id="bf-badge-stats"></span>
                    <span class="bf-arrow">▾</span>
                </div>
                <div class="bf-sec-body" id="bf-pane-stats">
                    <div id="bf-stats" class="bf-empty" style="white-space:pre-line;"></div>
                </div>
            </section>

            <section class="bf-sec" data-sec="funnel">
                <div class="bf-sec-head" data-sec="funnel">
                    <span class="bf-sec-title">转化漏斗</span>
                    <span class="bf-sec-badge" id="bf-badge-funnel"></span>
                    <span class="bf-arrow">▾</span>
                </div>
                <div class="bf-sec-body" id="bf-pane-funnel">
                    <div id="bf-funnel" class="bf-empty" style="width:100%;height:190px;"></div>
                    <div id="bf-funnel-rates" style="display:none;margin-top:6px;color:#9a9a9a;font-size:11px;line-height:1.7;"></div>
                </div>
            </section>

            <section class="bf-sec" data-sec="chart">
                <div class="bf-sec-head" data-sec="chart">
                    <span class="bf-sec-title">按天趋势</span>
                    <span class="bf-sec-badge" id="bf-badge-chart"></span>
                    <span class="bf-arrow">▸</span>
                </div>
                <div class="bf-sec-body" id="bf-pane-chart">
                    <div id="bf-chart-empty" class="bf-empty"></div>
                    <div id="bf-chart" style="display:none;width:100%;height:240px;background:#1a1a1a;border:1px solid #333;border-radius:6px;"></div>
                </div>
            </section>

            <section class="bf-sec" data-sec="r3">
                <div class="bf-sec-head" data-sec="r3">
                    <span class="bf-sec-title">已回复会话清单</span>
                    <span class="bf-sec-badge" id="bf-badge-r3"></span>
                    <span class="bf-arrow">▸</span>
                </div>
                <div class="bf-sec-body" id="bf-pane-r3">
                    <div id="bf-r3-empty" class="bf-empty"></div>
                    <div id="bf-r3" style="display:none;white-space:pre-line;max-height:32vh;overflow:auto;"></div>
                </div>
            </section>

            <section class="bf-sec" data-sec="log">
                <div class="bf-sec-head" data-sec="log">
                    <span class="bf-sec-title">调试日志</span>
                    <span class="bf-sec-badge" id="bf-badge-log"></span>
                    <span class="bf-arrow">▸</span>
                </div>
                <div class="bf-sec-body" id="bf-pane-log">
                    <div style="color:#777;font-size:11px;margin-bottom:4px;">同步输出到 DevTools Console，可用 __bossFriendListDebug 查看详情</div>
                    <div id="bf-log" style="background:#141414;border:1px solid #333;border-radius:6px;padding:6px;max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:#8f8f8f;font-size:11px;"></div>
                </div>
            </section>
        </div>`;
    document.body.appendChild(panel);

    // ---- 手风琴样式 ----
    const styleEl = document.createElement('style');
    styleEl.textContent = `
#bf-body .bf-sec { border:1px solid #333; border-radius:6px; background:#232324; flex:0 0 auto; }
#bf-body .bf-sec-head { display:flex; align-items:center; gap:8px; padding:6px 8px; cursor:pointer; user-select:none; background:#2a2a2b; border-radius:5px 5px 0 0; }
#bf-body .bf-sec.bf-collapsed .bf-sec-head { border-radius:5px; }
#bf-body .bf-sec-title { color:#d4d4d4; font-weight:600; }
#bf-body .bf-sec-badge { margin-left:auto; color:#7f7f7f; font-size:11px; }
#bf-body .bf-arrow { color:#888; width:12px; text-align:center; }
#bf-body .bf-sec-body { padding:8px; border-top:1px solid #333; }
#bf-body .bf-empty:empty::before { content:'运行一次后展示'; color:#666; font-size:11px; }
`;
    document.head.appendChild(styleEl);

    const $ = (id) => document.getElementById(id);
    const statsEl = $('bf-stats');
    const chartEl = $('bf-chart');
    const chartEmptyEl = $('bf-chart-empty');
    const r3El = $('bf-r3');
    const r3EmptyEl = $('bf-r3-empty');
    const funnelEl = $('bf-funnel');
    const funnelRatesEl = $('bf-funnel-rates');
    const statusEl = $('bf-status');
    const logEl = $('bf-log');
    let collapsed = false;
    let lastStatsText = '';
    let lastResult = '';
    let chart = null;
    let funnelChart = null;
    let running = false;

    // ---- 日志：页面内可见 + console + window 调试对象 ----
    const logs = [];
    const debug = (window.__bossFriendListDebug = {
        version: '1.6.1',
        logs,
        buckets: [],
        responses: [],
        mergedList: [],
        funnel: null,
        friendListSample: [],
        cache: { hit: 0, miss: 0, expired: 0, noTs: 0, entries: 0 },
        startedAt: 0,
        finishedAt: 0,
        error: null,
        run: () => sendRequest(),
        getLogs: () => logs.join('\n'),
        clearCache: () => clearCache(),
        cacheSize: () => Object.keys(loadCache().entries).length
    });

    function safeJson(v) {
        try {
            const s = typeof v === 'string' ? v : JSON.stringify(v);
            if (s === undefined) return String(v);
            return s.length > 600 ? s.slice(0, 600) + '…' : s;
        } catch (e) {
            return String(v);
        }
    }

    function log(...args) {
        const text = args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ');
        const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`;
        logs.push(line);
        if (logs.length > 600) logs.splice(0, logs.length - 600);
        logEl.textContent = logs.join('\n');
        logEl.scrollTop = logEl.scrollHeight;
        setBadge('log', logs.length + ' 行');
        console.log('%c[Boss好友统计]', 'color:#00a6a7', ...args);
    }

    function setStatus(text) {
        statusEl.textContent = text;
    }

    function setBadge(key, text) {
        const el = $('bf-badge-' + key);
        if (el) el.textContent = text;
    }

    function fmtPct(rate) {
        if (!rate) return '0%';
        return (rate * 100).toFixed(1).replace(/\.0$/, '') + '%';
    }

    // ---- 浮窗拖动（拖动后不触发折叠）----
    let dragMoved = false;
    $('bf-header').addEventListener('mousedown', (e) => {
        if (e.target.id === 'bf-toggle' || e.button !== 0) return;
        const rect = panel.getBoundingClientRect();
        const dx = e.clientX - rect.left;
        const dy = e.clientY - rect.top;
        const startX = e.clientX;
        const startY = e.clientY;
        dragMoved = false;
        const move = (ev) => {
            if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 3) dragMoved = true;
            panel.style.left = Math.max(0, ev.clientX - dx) + 'px';
            panel.style.top = Math.max(0, ev.clientY - dy) + 'px';
            panel.style.right = 'auto';
        };
        const up = () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        e.preventDefault();
    });

    $('bf-header').onclick = () => {
        if (dragMoved) {
            dragMoved = false;
            return;
        }
        collapsed = !collapsed;
        $('bf-body').style.display = collapsed ? 'none' : 'flex';
        $('bf-toggle').textContent = collapsed ? '▣' : '—';
    };
    // ---- 手风琴折叠（状态持久化）----
    const SEC_KEY = 'boss-friend-list-sections-v1';
    const DEFAULT_SECS = { stats: true, funnel: true, chart: false, r3: false, log: false };
    function loadSecState() {
        try {
            return Object.assign({}, DEFAULT_SECS, JSON.parse(localStorage.getItem(SEC_KEY) || '{}'));
        } catch (e) {
            return Object.assign({}, DEFAULT_SECS);
        }
    }
    let secState = loadSecState();
    function applySecState() {
        document.querySelectorAll('.bf-sec').forEach((sec) => {
            const key = sec.dataset.sec;
            const open = secState[key] !== false;
            const body = sec.querySelector('.bf-sec-body');
            if (body) body.style.display = open ? 'block' : 'none';
            const arrow = sec.querySelector('.bf-arrow');
            if (arrow) arrow.textContent = open ? '▾' : '▸';
            sec.classList.toggle('bf-collapsed', !open);
        });
    }
    function saveSecState() {
        try { localStorage.setItem(SEC_KEY, JSON.stringify(secState)); } catch (e) {}
    }
    function toggleSec(key) {
        secState[key] = secState[key] === false;
        saveSecState();
        applySecState();
        if (key === 'chart' && chart) setTimeout(() => chart.resize(), 30);
        if (key === 'funnel' && funnelChart) setTimeout(() => funnelChart.resize(), 30);
        if (key === 'log') logEl.scrollTop = logEl.scrollHeight;
    }
    function openSec(key) {
        if (secState[key] === false) {
            secState[key] = true;
            saveSecState();
            applySecState();
            if (key === 'chart' && chart) setTimeout(() => chart.resize(), 30);
            if (key === 'funnel' && funnelChart) setTimeout(() => funnelChart.resize(), 30);
        }
    }
    document.querySelectorAll('.bf-sec-head').forEach((head) => {
        head.addEventListener('click', () => toggleSec(head.dataset.sec));
    });
    applySecState();
    window.addEventListener('resize', () => {
        if (chart) chart.resize();
        if (funnelChart) funnelChart.resize();
    });
    $('bf-copy-log').onclick = () => {
        copyText(logs.join('\n'));
        $('bf-copy-log').textContent = '已复制';
        setTimeout(() => { $('bf-copy-log').textContent = '复制日志'; }, 1200);
    };
    $('bf-clear-cache').onclick = () => clearCache();

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(() => {});
        }
    }

    $('bf-send').onclick = sendRequest;
    $('bf-copy').onclick = () => {
        copyText(lastStatsText + '\n' + lastResult);
        $('bf-copy').textContent = '已复制';
        setTimeout(() => { $('bf-copy').textContent = '复制结果'; }, 1200);
    };

    // ---- 工具 ----
    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    function dayOf(ts) {
        const d = new Date(ts);
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }

    function fmtTime(ts) {
        const d = new Date(ts);
        return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }

    // 兼容秒级时间戳
    let secondsTsCount = 0;
    function normalizeTs(ts) {
        const n = typeof ts === 'string' ? Number(ts) : ts;
        if (!n || !isFinite(n) || n <= 0) return 0;
        if (n < 1e11) {
            secondsTsCount++;
            return n * 1000;
        }
        return n;
    }

    function newTraceId() {
        return 'F-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 14);
    }

    // 统计: relationType 2=我发起(对方未回) 3=我发起且对方回过 1=对方主动发起
    function computeStats(list) {
        const s = { total: list.length, r1: 0, r2: 0, r3: 0, other: 0, r2Unread: 0, r2ReadNoReply: 0, r2Other: 0, r3Detail: [] };
        for (const item of list) {
            switch (item.relationType) {
                case 1: s.r1++; break;
                case 2: {
                    s.r2++;
                    const st = item.lastMessageInfo && item.lastMessageInfo.status;
                    if (st === 1) s.r2Unread++;
                    else if (st === 2) s.r2ReadNoReply++;
                    else s.r2Other++;
                    break;
                }
                case 3:
                    s.r3++;
                    s.r3Detail.push({
                        name: item.name,
                        brand: item.brandName || '',
                        title: item.title || '',
                        lastMsg: (item.lastMessageInfo && item.lastMessageInfo.showText) || '',
                        ts: item.lastTS || 0
                    });
                    break;
                default:
                    s.other++;
                    break;
            }
        }
        s.r3Detail.sort((a, b) => b.ts - a.ts);
        return s;
    }

    function pct(n, total) {
        return total ? Math.round(n / total * 100) + '%' : '0%';
    }

    // 转化漏斗：分母 = relationType 1+2+3 的总和，分子 = relationType 3（相互有交流）
    function computeFunnel(s) {
        const greetings = s.r1 + s.r2 + s.r3;
        const mutual = s.r3;
        const mine = s.r2 + s.r3;
        return {
            greetings,
            mutual,
            mine,
            otherInitiated: s.r1,
            other: s.other || 0,
            overall: greetings ? mutual / greetings : 0,
            mineRate: mine ? mutual / mine : 0
        };
    }

    function renderFunnel(f) {
        funnelRatesEl.innerHTML =
            `<div>总转化率 <b style="color:#00a6a7;">${fmtPct(f.overall)}</b> · ${f.mutual}/${f.greetings}（r3 / r1+r2+r3）</div>` +
            `<div>我发起 <b style="color:#d19a66;">${f.mine}</b> → 相互交流 <b>${f.mutual}</b> · 转化 <b style="color:#d19a66;">${fmtPct(f.mineRate)}</b>（r3 / r2+r3）</div>` +
            `<div>对方发起 <b style="color:#6a9955;">${f.otherInitiated}</b> → 相互交流 <b style="color:#8a8a8a;">—</b> · relationType=1 不含我是否回复，无法判定</div>` +
            (f.other ? `<div style="color:#c586c0;">另有 ${f.other} 个其他 relationType，未计入分母</div>` : '');
        funnelRatesEl.style.display = 'block';

        if (!funnelChart) {
            funnelChart = echarts.init(funnelEl, null, funnelEl.offsetWidth
                ? { renderer: 'canvas' }
                : { renderer: 'canvas', width: 448, height: 190 });
        }
        funnelChart.setOption({
            backgroundColor: 'transparent',
            tooltip: {
                trigger: 'item',
                formatter: (p) => `${p.name}<br/>${p.value} 个 · ${p.data.rate}`
            },
            series: [{
                type: 'funnel',
                left: '8%',
                right: '8%',
                top: 8,
                bottom: 8,
                minSize: '24%',
                maxSize: '100%',
                sort: 'descending',
                gap: 2,
                label: {
                    show: true,
                    position: 'inside',
                    color: '#fff',
                    fontSize: 11,
                    formatter: (p) => `${p.name}  ${p.value} · ${p.data.rate}`
                },
                itemStyle: { borderWidth: 0 },
                emphasis: { label: { fontSize: 12 } },
                data: [
                    { value: f.greetings, name: '打招呼', rate: '100%', itemStyle: { color: '#3a6ea5' } },
                    { value: f.mutual, name: '相互交流', rate: fmtPct(f.overall), itemStyle: { color: '#00a6a7' } }
                ]
            }]
        }, true);
        if (funnelEl.offsetWidth) funnelChart.resize();
        setBadge('funnel', `总转化 ${fmtPct(f.overall)}`);
        log(`漏斗：总转化 ${fmtPct(f.overall)}（${f.mutual}/${f.greetings}）· 我发起 ${fmtPct(f.mineRate)}（${f.mutual}/${f.mine}）`);
    }

    function loadECharts() {
        if (window.echarts) return Promise.resolve();
        const CDNS = [
            'https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js',
            'https://unpkg.com/echarts@5.5.1/dist/echarts.min.js',
            'https://cdn.staticfile.org/echarts/5.5.1/echarts.min.js'
        ];
        return new Promise((resolve, reject) => {
            let i = 0;
            const tryNext = () => {
                if (i >= CDNS.length) return reject(new Error('echarts 全部 CDN 加载失败'));
                const src = CDNS[i++];
                log(`加载 ECharts: ${src}`);
                const s = document.createElement('script');
                s.src = src;
                s.onload = () => window.echarts ? resolve() : tryNext();
                s.onerror = () => {
                    log(`ECharts 加载失败: ${src}`);
                    tryNext();
                };
                document.head.appendChild(s);
            };
            tryNext();
        });
    }

    function renderChart(list) {
        // 图表固定展示最近 CHART_DAYS 天，更早的数据不画
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const days = [];
        for (let i = CHART_DAYS - 1; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            days.push(dayOf(d.getTime()));
        }
        const inRange = new Set(days);
        const byDay = {};
        let shown = 0;
        for (const item of list) {
            const ts = normalizeTs(item.lastTS);
            if (!ts) continue;
            const day = dayOf(ts);
            if (!inRange.has(day)) continue;
            shown++;
            const key = item.relationType === 3 ? 'r3' : (item.relationType === 2 ? 'r2' : 'r1');
            byDay[day] = byDay[day] || { r1: 0, r2: 0, r3: 0 };
            byDay[day][key]++;
        }
        const seriesKeys = [['r1', '对方主动(1)'], ['r2', '我发起未回(2)'], ['r3', '有互动(3)']];
        const series = seriesKeys.map(([k, label]) => ({
            name: label,
            type: 'bar',
            stack: 'total',
            barMaxWidth: 28,
            data: days.map((day) => (byDay[day] ? byDay[day][k] : 0)),
            itemStyle: k === 'r3' ? { color: '#00a6a7' } : (k === 'r2' ? { color: '#d19a66' } : { color: '#6a9955' })
        }));
        chartEl.style.display = 'block';
        if (chartEmptyEl) chartEmptyEl.style.display = 'none';
        if (!chart) {
            const hidden = !chartEl.offsetWidth;
            chart = echarts.init(chartEl, null, hidden
                ? { renderer: 'canvas', width: 448, height: 240 }
                : { renderer: 'canvas' });
        }
        chart.setOption({
            backgroundColor: 'transparent',
            title: {
                text: `最近 ${CHART_DAYS} 天会话数（${shown}/${list.length}）`,
                left: 4, top: 2, textStyle: { color: '#d4d4d4', fontSize: 12 }
            },
            legend: { right: 4, top: 0, textStyle: { color: '#9cdcfe', fontSize: 10 }, itemWidth: 12, itemHeight: 8 },
            grid: { left: 30, right: 6, top: 30, bottom: 20 },
            tooltip: { trigger: 'axis' },
            xAxis: { type: 'category', data: days, axisLabel: { color: '#888', fontSize: 9, rotate: 0 }, axisLine: { lineStyle: { color: '#444' } } },
            yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#888', fontSize: 9 }, splitLine: { lineStyle: { color: '#2a2a2a' } } },
            series
        }, true);
        if (chartEl.offsetWidth) chart.resize();
        setBadge('chart', `${shown} 条`);
        log(`图表：最近 ${CHART_DAYS} 天 ${shown} 条，${list.length - shown} 条早于图表范围（仍计入统计）`);
    }

    function renderR3(detail) {
        if (!detail.length) {
            r3El.style.display = 'none';
            if (r3EmptyEl) {
                r3EmptyEl.style.display = 'block';
                r3EmptyEl.textContent = '没有 relationType=3 的会话';
            }
            return;
        }
        if (r3EmptyEl) r3EmptyEl.style.display = 'none';
        r3El.innerHTML =
            `<div style="color:#00a6a7;">我发起、对方回过 (relationType=3) · ${detail.length} 个（按最近时间倒序）</div>` +
            detail.map((d, i) =>
                `<div style="padding:4px 0;border-bottom:1px dashed #333;">` +
                `${i + 1}. <b style="color:#9cdcfe;">${d.name}</b>` +
                (d.title ? `<span style="color:#808080;"> · ${d.title}</span>` : '') +
                ` <span style="color:#d19a66;">${d.brand}</span>` +
                `<span style="color:#666;float:right;">${d.lastMsg.slice(0, 24)}</span>` +
                `</div>`).join('');
        r3El.style.display = 'block';
    }

    async function renderAll(list) {
        const s = computeStats(list);
        const dist = {};
        for (const item of list) {
            const k = item.relationType;
            dist[k] = (dist[k] || 0) + 1;
        }
        log('relationType 分布：', JSON.stringify(dist));
        if (s.other) log(`注意：有 ${s.other} 个会话的 relationType 不在 1/2/3 内，未计入漏斗分母`);

        const funnel = computeFunnel(s);
        debug.funnel = funnel;

        statsEl.innerHTML =
            `共 ${s.total} 个会话（30 天内，图表仅展示最近 ${CHART_DAYS} 天）\n` +
            `我发起、对方未回 (relationType=2): ${s.r2} 个 (${pct(s.r2, s.total)})\n` +
            `  ├ 未读/status=1 (发了没被看): ${s.r2Unread} 个\n` +
            `  └ 已读未回/status=2 (看了没理): ${s.r2ReadNoReply} 个\n` +
            `我发起、对方回过 (relationType=3): ${s.r3} 个 (${pct(s.r3, s.total)})\n` +
            `对方主动发起 (relationType=1): ${s.r1} 个 (${pct(s.r1, s.total)})` +
            (s.other ? `\n其他 relationType: ${s.other} 个` : '');
        lastStatsText = statsEl.textContent;
        setBadge('stats', `共 ${s.total}`);

        try {
            await loadECharts();
            renderFunnel(funnel);
            renderChart(list);
        } catch (e) {
            log('图表加载失败:', e && e.message ? e.message : String(e));
            chartEl.style.display = 'none';
            if (chartEmptyEl) {
                chartEmptyEl.style.display = 'block';
                chartEmptyEl.textContent = '图表加载失败（详见日志）';
            }
            funnelEl.innerHTML = `<div style="color:#888;">漏斗绘制失败：打招呼 ${funnel.greetings} → 相互交流 ${funnel.mutual}（${fmtPct(funnel.overall)}）</div>`;
            funnelRatesEl.style.display = 'block';
        }
        renderR3(s.r3Detail);
        setBadge('r3', `${s.r3} 个`);
    }

    // ---- 网络请求 ----
    const JSON_HEADERS = {
        'accept': 'application/json, text/plain, */*',
        'x-requested-with': 'XMLHttpRequest'
    };

    async function fetchFriendList() {
        const url = LABEL_URL;
        log(`GET ${url}`);
        const t0 = performance.now();
        const resp = await fetch(url, {
            credentials: 'include',
            headers: { ...JSON_HEADERS, 'traceid': newTraceId() }
        });
        const text = await resp.text();
        log(`联系人列表响应：HTTP ${resp.status} · ${text.length}B · ${Math.round(performance.now() - t0)}ms`);
        let json;
        try {
            json = JSON.parse(text);
        } catch (e) {
            log('联系人列表返回非 JSON，前 300 字：', text.slice(0, 300));
            throw new Error('联系人列表返回非 JSON（见日志）');
        }
        log(`联系人列表 code=${json.code} message=${json.message || ''}`);
        if (json.code !== 0) {
            debug.responses.push({ step: 'friendList', code: json.code, message: json.message, raw: json });
            log('联系人列表 zpData:', json.zpData);
            if (json.code === 1092) {
                log('提示：联系人列表接口本身返回 1092，可能是一次拉取 30 天范围过大，或 labelId/参数不被接受；' +
                    '可在 DevTools Network 里确认 geekFilterByLabel 实际支持的时间参数。');
            }
            throw new Error(`联系人列表业务码 ${json.code} ${json.message || ''}（见日志）`);
        }
        const zd = json.zpData || {};
        log('zpData 字段：', Object.keys(zd).join(',') || '(空)');
        let list = zd.friendList || zd.list || zd.result || zd.friends;
        if (!Array.isArray(list)) {
            log('未识别的联系人结构，zpData =', zd);
            list = [];
        }
        log(`联系人 ${list.length} 条`);
        if (list[0]) log('联系人首条字段：', Object.keys(list[0]).join(','));
        debug.friendListSample = list.slice(0, 3);
        debug.responses.push({ step: 'friendList', code: json.code, count: list.length, zpDataKeys: Object.keys(zd) });
        return list;
    }

    function extractTs(item) {
        const raw = item.lastTS || item.lastTime || item.lastChatTime ||
            (item.lastMessageInfo && (item.lastMessageInfo.time || item.lastMessageInfo.ts)) || 0;
        return normalizeTs(raw);
    }

    function bucketLabel(idx, now) {
        const end = now - idx * WINDOW_DAYS * 86400000;
        const start = end - WINDOW_DAYS * 86400000;
        return `${fmtTime(start)} ~ ${fmtTime(end)}`;
    }

    function chunkIds(ids, size) {
        const out = [];
        for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
        return out;
    }

    // ---- 本地缓存（localStorage）----
    function loadCache() {
        const empty = { version: 1, updatedAt: 0, entries: {} };
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if (!raw) return empty;
            const data = JSON.parse(raw);
            if (!data || data.version !== 1 || !data.entries || typeof data.entries !== 'object') {
                log('本地缓存格式不匹配，已重置');
                return empty;
            }
            return data;
        } catch (e) {
            log('读取本地缓存失败，按空缓存处理：', e.message);
            return empty;
        }
    }

    function saveCache(cache) {
        cache.updatedAt = Date.now();
        let raw;
        try {
            raw = JSON.stringify(cache);
        } catch (e) {
            log('序列化本地缓存失败：', e.message);
            return;
        }
        try {
            localStorage.setItem(CACHE_KEY, raw);
            log(`本地缓存已保存：${Object.keys(cache.entries).length} 条 · ${(raw.length / 1024).toFixed(1)}KB`);
        } catch (e) {
            log('本地缓存写入失败（可能超出配额），裁剪一半后重试：', e.message);
            const half = Object.entries(cache.entries)
                .sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0))
                .slice(0, Math.max(10, Math.floor(Object.keys(cache.entries).length / 2)));
            cache.entries = Object.fromEntries(half);
            try {
                localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
                log(`已裁剪并保存：${Object.keys(cache.entries).length} 条`);
            } catch (e2) {
                log('本地缓存仍然写入失败，本次不缓存：', e2.message);
            }
        }
    }

    function clearCache() {
        try {
            localStorage.removeItem(CACHE_KEY);
            const msg = `已清除本地缓存 ${new Date().toLocaleTimeString()}`;
            log(msg);
            setStatus(msg);
        } catch (e) {
            log('清除本地缓存失败：', e.message);
        }
    }

    // 缓存的键：尽量覆盖 label 列表和 detail 列表可能使用的各种 id 字段
    function cacheKeysOf(item) {
        return [...new Set([
            item.friendId, item.encryptUid, item.encryptFriendId, item.encryptGeekId, item.uid, item.id
        ].filter(Boolean).map(String))];
    }

    function cacheLookupId(f) {
        return f && (f.friendId || f.encryptFriendId || f.encryptUid || f.uid || f.id);
    }

    // 和本地缓存做 diff：lastTS 相同且缓存未过期 => 复用；否则进请求队列
    function diffCache(friendList, cache) {
        const now = Date.now();
        const cachedItems = [];
        const need = [];
        const stats = { hit: 0, miss: 0, expired: 0, noTs: 0 };
        let missingId = 0;

        for (const f of friendList) {
            const id = cacheLookupId(f);
            if (!id) { missingId++; continue; }
            const ts = extractTs(f);
            const entry = cache.entries[id];
            // 联系人列表没有时间戳时无法 diff，只能按 TTL 复用，避免完全用不上缓存
            if (!ts) {
                if (entry && entry.item && (now - (entry.savedAt || 0) <= CACHE_TTL_MS)) {
                    cachedItems.push(entry.item);
                    entry.savedAt = now;
                    stats.hit++;
                } else {
                    stats.noTs++;
                    need.push({ id, ts: 0 });
                }
                continue;
            }
            const sameTs = !!(entry && Number(entry.ts) === ts);
            const fresh = !!(entry && entry.item && (now - (entry.savedAt || 0) <= CACHE_TTL_MS));
            if (sameTs && fresh) {
                cachedItems.push(entry.item);
                entry.savedAt = now; // 记录最近使用时间，避免被裁剪
                stats.hit++;
            } else {
                if (sameTs) stats.expired++;
                stats.miss++;
                need.push({ id, ts });
            }
        }

        if (missingId) log(`有 ${missingId} 个联系人没有 id，已跳过`);
        return { cachedItems, need, stats };
    }

    // 把新拉到的会话写进缓存（同一 item 可能按多个 id 字段各存一份）
    function updateCacheFromItems(cache, items) {
        const now = Date.now();
        let stored = 0;
        for (const item of items) {
            const ts = extractTs(item);
            if (!ts) continue;
            const keys = cacheKeysOf(item);
            if (!keys.length) continue;
            for (const key of keys) {
                cache.entries[key] = { ts, savedAt: now, item };
                stored++;
            }
        }
        pruneCache(cache);
        return stored;
    }

    function pruneCache(cache) {
        const cut = Date.now() - 45 * 86400000;
        let removed = 0;
        for (const [key, entry] of Object.entries(cache.entries)) {
            if (!entry || (entry.savedAt || 0) < cut) {
                delete cache.entries[key];
                removed++;
            }
        }
        if (removed) log(`本地缓存清理了 ${removed} 条 45 天未使用的记录`);

        const entries = Object.entries(cache.entries);
        if (entries.length <= CACHE_MAX_ENTRIES) return;
        entries.sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
        cache.entries = Object.fromEntries(entries.slice(0, CACHE_MAX_ENTRIES));
        log(`本地缓存超过 ${CACHE_MAX_ENTRIES} 条，已按最近使用时间裁剪到 ${CACHE_MAX_ENTRIES} 条`);
    }

    // 按最后消息时间分成 3 天一个窗口，每窗再限制单请求 id 数
    function buildBuckets(entries) {
        const now = Date.now();
        const groups = new Map();
        let noTs = 0;

        for (const { id, ts } of entries) {
            if (!id) continue;
            if (!ts) {
                noTs++;
                if (!groups.has('no-ts')) groups.set('no-ts', { label: '无时间戳', ids: [] });
                groups.get('no-ts').ids.push(id);
                continue;
            }
            const idx = Math.max(0, Math.floor((now - ts) / (WINDOW_DAYS * 86400000)));
            if (!groups.has(idx)) groups.set(idx, { label: bucketLabel(idx, now), idx, ids: [] });
            groups.get(idx).ids.push(id);
        }

        if (noTs) log(`有 ${noTs} 个联系人没有时间戳，单独成组请求（无法命中缓存）`);
        if (secondsTsCount) log(`注意：${secondsTsCount} 个时间戳为秒级，已自动 ×1000`);

        const keys = [...groups.keys()].sort((a, b) => {
            if (a === 'no-ts') return 1;
            if (b === 'no-ts') return -1;
            return a - b;
        });

        const buckets = [];
        for (const key of keys) {
            const g = groups.get(key);
            const parts = chunkIds(g.ids, MAX_IDS_PER_REQUEST);
            parts.forEach((ids, i) => {
                buckets.push({
                    label: parts.length > 1 ? `${g.label} #${i + 1}/${parts.length}` : g.label,
                    ids
                });
            });
        }
        return buckets;
    }

    async function postFriends(ids, label) {
        const body = 'friendIds=' + encodeURIComponent(ids.join(','));
        log(`POST ${REQUEST_URL} · ${label} · ${ids.length} id / body ${body.length}B`);
        const t0 = performance.now();
        const resp = await fetch(REQUEST_URL, {
            method: 'POST',
            credentials: 'include',
            headers: {
                ...JSON_HEADERS,
                'content-type': 'application/x-www-form-urlencoded',
                'traceid': newTraceId()
            },
            body
        });
        const text = await resp.text();
        const ms = Math.round(performance.now() - t0);
        log(`窗口 ${label} 响应：HTTP ${resp.status} · ${text.length}B · ${ms}ms`);

        let json;
        try {
            json = JSON.parse(text);
        } catch (e) {
            log(`窗口 ${label} 返回非 JSON，前 300 字：`, text.slice(0, 300));
            debug.responses.push({ step: 'detail', label, ids: ids.length, error: 'non-json', httpStatus: resp.status });
            return { ok: false, code: -1, message: '非 JSON 响应', list: [] };
        }

        const rawList = json.zpData && (json.zpData.result || json.zpData.friendList || json.zpData.list);
        const list = Array.isArray(rawList) ? rawList : [];
        if (json.code === 0 && !Array.isArray(rawList)) {
            log(`窗口 ${label} 的 zpData 结构异常（不是数组），zpData 字段：`, Object.keys(json.zpData || {}).join(','));
        }
        log(`窗口 ${label} 业务：code=${json.code} message=${json.message || ''} · ${list.length} 条`);
        const record = { step: 'detail', label, ids: ids.length, code: json.code, message: json.message || '', count: list.length };
        if (json.code !== 0) {
            record.raw = json;
            debug.responses.push(record);
            return { ok: false, code: json.code, message: json.message || '', list: [] };
        }
        debug.responses.push(record);
        return { ok: true, code: 0, list };
    }

    // 失败时对半拆 id 重试，避免单个请求过大
    async function fetchChunkWithSplit(ids, label, depth) {
        if (!ids.length) return [];
        const res = await postFriends(ids, label);
        if (res.ok) return res.list;

        if (ids.length <= 1 || depth >= MAX_SPLIT_DEPTH) {
            log(`窗口 ${label} 放弃：${ids.length} 个 id，code=${res.code} ${res.message || ''}`);
            return [];
        }
        const mid = Math.ceil(ids.length / 2);
        log(`窗口 ${label} 失败，拆分为 ${mid} + ${ids.length - mid} 个 id 重试（depth=${depth + 1}）`);
        await sleep(REQUEST_GAP_MS);
        const a = await fetchChunkWithSplit(ids.slice(0, mid), `${label}-a`, depth + 1);
        await sleep(REQUEST_GAP_MS);
        const b = await fetchChunkWithSplit(ids.slice(mid), `${label}-b`, depth + 1);
        return a.concat(b);
    }

    function mergeUnique(list) {
        const map = new Map();
        let dup = 0;
        for (const item of list) {
            const key = item.encryptUid || item.friendId || item.encryptFriendId || item.uid || item.id ||
                item.encryptGeekId || JSON.stringify(item);
            if (map.has(key)) dup++;
            else map.set(key, item);
        }
        if (dup) log(`汇总去重：${dup} 条重复会话已合并`);
        return [...map.values()];
    }

    async function sendRequest() {
        if (running) {
            log('已有请求在跑，忽略本次点击');
            return;
        }
        running = true;
        $('bf-send').disabled = true;
        const t0 = Date.now();
        debug.startedAt = t0;
        debug.finishedAt = 0;
        debug.error = null;
        debug.buckets = [];
        debug.responses = [];
        debug.mergedList = [];
        secondsTsCount = 0;

        log('========== 新一轮 ==========');
        setStatus('请求中...');
        try {
            let buckets;
            let cachedItems = [];
            const cache = loadCache();
            debug.cache = { hit: 0, miss: 0, expired: 0, noTs: 0, entries: Object.keys(cache.entries).length };
            const manualIds = (FRIEND_IDS || '').split(/[,\s]+/).filter(Boolean);

            if (manualIds.length) {
                log(`使用手动 FRIEND_IDS：${manualIds.length} 个（手动模式不读缓存，但会写入）`);
                buckets = chunkIds(manualIds, MAX_IDS_PER_REQUEST).map((ids, i, arr) => ({
                    label: arr.length > 1 ? `手动指定 #${i + 1}/${arr.length}` : '手动指定',
                    ids
                }));
            } else {
                setStatus('步骤 1/4：拉取联系人列表...');
                const friendList = await fetchFriendList();
                if (!friendList.length) {
                    setStatus('未拉取到联系人（请确认已登录，且 30 天内有沟通记录）');
                    log('联系人列表为空，终止');
                    return;
                }
                const diff = diffCache(friendList, cache);
                cachedItems = diff.cachedItems;
                debug.cache = {
                    ...diff.stats,
                    entries: Object.keys(cache.entries).length,
                    cachedItems: cachedItems.length
                };
                log(`本地缓存：命中 ${diff.stats.hit} 个（lastTS 未变化，跳过请求），需新拉 ${diff.need.length} 个` +
                    (diff.stats.expired ? `；其中 ${diff.stats.expired} 个 lastTS 未变但缓存超过 ${CACHE_TTL_MS / 3600000} 小时，强制刷新` : '') +
                    (diff.stats.noTs ? `；${diff.stats.noTs} 个无时间戳，无法命中` : ''));
                if (diff.stats.hit === 0 && diff.need.length && Object.keys(cache.entries).length) {
                    log('提示：缓存里有数据但一个都没命中，可能是 friendId 与 encryptUid 不一致，请把日志发我。');
                }
                setStatus(`步骤 2/4：缓存命中 ${diff.stats.hit} 个，需新拉 ${diff.need.length} 个...`);
                buckets = buildBuckets(diff.need);
            }

            if (!buckets.length && !cachedItems.length) {
                setStatus('没有可请求的联系人');
                log('没有可请求的联系人，终止');
                return;
            }

            const totalIds = buckets.reduce((n, b) => n + b.ids.length, 0);
            debug.buckets = buckets.map((b) => ({ label: b.label, count: b.ids.length }));
            if (!buckets.length) {
                log('全部命中本地缓存，跳过网络请求');
                setStatus('全部命中本地缓存，直接汇总...');
            } else {
                log(`共 ${buckets.length} 个请求窗口，合计 ${totalIds} 个 id（每窗约 ${WINDOW_DAYS} 天，单请求 ≤ ${MAX_IDS_PER_REQUEST}）`);
            }

            const all = [];
            for (let i = 0; i < buckets.length; i++) {
                const b = buckets[i];
                setStatus(`步骤 3/4：拉取 ${b.label}（${i + 1}/${buckets.length}）...`);
                log(`--- [${i + 1}/${buckets.length}] ${b.label} 开始（${b.ids.length} 个 id）`);
                const list = await fetchChunkWithSplit(b.ids, b.label, 0);
                all.push(...list);
                log(`--- [${i + 1}/${buckets.length}] ${b.label} 完成：${list.length} 条`);
                await sleep(REQUEST_GAP_MS);
            }

            const merged = mergeUnique(cachedItems.concat(all));
            debug.mergedList = merged;
            log(`汇总完成：缓存 ${cachedItems.length} 条 + 新拉 ${all.length} 条，去重后 ${merged.length} 条，耗时 ${Date.now() - t0}ms`);
            if (!merged.length) {
                setStatus('所有窗口都没有返回会话（详见日志）');
                openSec('log');
                return;
            }

            if (all.length) {
                updateCacheFromItems(cache, all);
            }
            if (all.length || cachedItems.length) {
                saveCache(cache);
                debug.cache.entries = Object.keys(cache.entries).length;
            }

            setStatus('步骤 4/4：统计与绘图...');
            await renderAll(merged);
            const failed = debug.responses.filter((r) => r.step === 'detail' && r.code !== 0).length;
            if (failed) openSec('log');
            setStatus(`完成 · ${new Date().toLocaleTimeString()} · ${merged.length} 个会话 / ${buckets.length} 个窗口` +
                (cachedItems.length ? ` · 缓存命中 ${cachedItems.length}` : '') +
                (failed ? ` · ${failed} 个窗口失败(见日志)` : ''));
            log('========== 结束 ==========');
        } catch (e) {
            debug.error = (e && e.stack) || String(e);
            log('ERROR', debug.error);
            openSec('log');
            setStatus(`请求失败: ${e && e.message ? e.message : String(e)}（详见日志）`);
        } finally {
            debug.finishedAt = Date.now();
            running = false;
            $('bf-send').disabled = false;
        }
    }

    log('脚本已注入 v1.6.1，调试对象：window.__bossFriendListDebug');
})();
