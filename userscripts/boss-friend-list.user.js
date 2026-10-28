// ==UserScript==
// @name         Boss直聘-好友列表浮窗
// @namespace    boss-spider
// @version      1.2.0
// @description  抓取 getGeekFriendList 并统计：我发起未回(relationType=2)/我发起有回复(=3)，ECharts 按时间展示，列出已回复会话的公司与 HR
// @match        https://www.zhipin.com/*
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const REQUEST_URL = '/wapi/zprelation/friend/getGeekFriendList.json';
    // 使用前把这里换成你要查询的好友/沟通对象 ID（uid）列表，逗号分隔。
    // 获取方式：在 Boss直聘聊天页打开 DevTools -> Network，筛选 getGeekFriendList，
    // 复制其请求体里的 friendIds 参数即可。
    const FRIEND_IDS = '';

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
        <div id="bf-header" style="padding:6px 10px;cursor:pointer;user-select:none;background:#2d2d2d;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center;">
            <span>Boss 好友列表</span><span id="bf-toggle" style="cursor:pointer;">—</span>
        </div>
        <div id="bf-body" style="padding:8px 10px;display:flex;flex-direction:column;gap:8px;overflow:auto;">
            <div style="display:flex;gap:8px;">
                <button id="bf-send" style="padding:4px 14px;cursor:pointer;border:0;border-radius:4px;background:#00a6a7;color:#fff;">发送请求</button>
                <button id="bf-copy" style="padding:4px 14px;cursor:pointer;border:1px solid #555;border-radius:4px;background:transparent;color:#d4d4d4;">复制结果</button>
                <span id="bf-status" style="line-height:24px;color:#6a9955;"></span>
            </div>
            <div id="bf-stats" style="display:none;background:#252526;border:1px solid #333;border-radius:6px;padding:8px;white-space:pre-line;"></div>
            <div id="bf-chart" style="display:none;width:100%;height:240px;background:#1a1a1a;border:1px solid #333;border-radius:6px;"></div>
            <div id="bf-r3" style="display:none;background:#252526;border:1px solid #333;border-radius:6px;padding:8px;white-space:pre-line;max-height:32vh;overflow:auto;"></div>
        </div>`;
    document.body.appendChild(panel);

    // ---- 浮窗拖动 ----
    const headerEl = document.getElementById('bf-header');
    headerEl.addEventListener('mousedown', (e) => {
        if (e.target.id === 'bf-toggle') return;
        const rect = panel.getBoundingClientRect();
        const dx = e.clientX - rect.left;
        const dy = e.clientY - rect.top;
        const move = (ev) => {
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

    const $ = (id) => document.getElementById(id);
    const statsEl = $('bf-stats');
    const chartEl = $('bf-chart');
    const r3El = $('bf-r3');
    const statusEl = $('bf-status');
    let collapsed = false;
    let lastStatsText = '';
    let lastResult = '';
    let chart = null;

    $('bf-header').onclick = () => {
        collapsed = !collapsed;
        $('bf-body').style.display = collapsed ? 'none' : 'flex';
        $('bf-toggle').textContent = collapsed ? '▣' : '—';
    };
    $('bf-send').onclick = sendRequest;
    $('bf-copy').onclick = () => {
        navigator.clipboard.writeText(lastStatsText + '\n' + lastResult).then(() => {
            $('bf-copy').textContent = '已复制';
            setTimeout(() => { $('bf-copy').textContent = '复制结果'; }, 1200);
        });
    };

    // 统计: relationType 2=我发起(对方未回) 3=我发起且对方回过 1=对方主动发起
    function computeStats(list) {
        const s = { total: list.length, r1: 0, r2: 0, r3: 0, r2Unread: 0, r2ReadNoReply: 0, r2Other: 0, r3Detail: [] };
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
            }
        }
        s.r3Detail.sort((a, b) => b.ts - a.ts);
        return s;
    }

    function pct(n, total) {
        return total ? Math.round(n / total * 100) + '%' : '0%';
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
                const s = document.createElement('script');
                s.src = CDNS[i++];
                s.onload = () => window.echarts ? resolve() : tryNext();
                s.onerror = tryNext;
                document.head.appendChild(s);
            };
            tryNext();
        });
    }

    function dayOf(ts) {
        const d = new Date(ts);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function fillDayGaps(points) {
        if (!points.length) return [];
        const map = new Map(points);
        const min = points[0][0], max = points[points.length - 1][0];
        const start = new Date(min + 'T00:00:00');
        const end = new Date(max + 'T00:00:00');
        const days = [];
        for (let d = start; d <= end; d.setDate(d.getDate() + 1)) {
            days.push(dayOf(d.getTime()));
        }
        return days.map(day => (map.get(day) ? [day, map.get(day)] : [day, null]));
    }

    function renderChart(list) {
        // 按天累计三类会话数
        const byDay = {};
        for (const item of list) {
            if (!item.lastTS) continue;
            const day = dayOf(item.lastTS);
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
            data: fillDayGaps(Object.entries(byDay).sort((a, b) => a[0] < b[0] ? -1 : 1).map(([day, v]) => [day, v[k]])),
            itemStyle: k === 'r3' ? { color: '#00a6a7' } : (k === 'r2' ? { color: '#d19a66' } : { color: '#6a9955' })
        }));
        const xDays = series[0] && series[0].data.length ? series[0].data.map(d => d[0]) : [];
        chartEl.style.display = 'block';
        if (!chart) chart = echarts.init(chartEl, null, { renderer: 'canvas' });
        chart.setOption({
            backgroundColor: 'transparent',
            title: { text: '按天的会话数', left: 4, top: 2, textStyle: { color: '#d4d4d4', fontSize: 12 } },
            legend: { right: 4, top: 0, textStyle: { color: '#9cdcfe', fontSize: 10 }, itemWidth: 12, itemHeight: 8 },
            grid: { left: 30, right: 6, top: 30, bottom: 20 },
            tooltip: { trigger: 'axis' },
            xAxis: { type: 'category', data: xDays, axisLabel: { color: '#888', fontSize: 9, rotate: 0 }, axisLine: { lineStyle: { color: '#444' } } },
            yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#888', fontSize: 9 }, splitLine: { lineStyle: { color: '#2a2a2a' } } },
            series
        }, true);
        chart.resize();
    }

    function renderR3(detail) {
        if (!detail.length) { r3El.style.display = 'none'; return; }
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
        statsEl.innerHTML =
            `共 ${s.total} 个会话\n` +
            `我发起、对方未回 (relationType=2): ${s.r2} 个 (${pct(s.r2, s.total)})\n` +
            `  ├ 未读/status=1 (发了没被看): ${s.r2Unread} 个\n` +
            `  └ 已读未回/status=2 (看了没理): ${s.r2ReadNoReply} 个\n` +
            `我发起、对方回过 (relationType=3): ${s.r3} 个 (${pct(s.r3, s.total)})\n` +
            `对方主动发起 (relationType=1): ${s.r1} 个 (${pct(s.r1, s.total)})`;
        lastStatsText = statsEl.textContent;
        statsEl.style.display = 'block';
        try {
            await loadECharts();
            renderChart(list);
        } catch (e) {
            chartEl.style.display = 'none';
            statusEl.textContent = '图表加载失败(可先重装脚本使 @require 生效)，统计与清单正常展示';
        }
        renderR3(s.r3Detail);
    }

    async function sendRequest() {
        if (!FRIEND_IDS) {
            statusEl.textContent = '请先编辑脚本顶部 FRIEND_IDS，填入对象 uid 列表（见注释）';
            return;
        }
        $('bf-send').disabled = true;
        statusEl.textContent = '请求中...';
        try {
            const resp = await fetch(REQUEST_URL, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'accept': 'application/json, text/plain, */*',
                    'content-type': 'application/x-www-form-urlencoded',
                    'x-requested-with': 'XMLHttpRequest',
                    'traceid': 'F-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 14)
                },
                body: 'friendIds=' + encodeURIComponent(FRIEND_IDS)
            });
            const json = await resp.json();
            lastResult = JSON.stringify(json, null, 2);
            const list = (json.zpData && json.zpData.result) || [];
            if (json.code !== 0) {
                statusEl.textContent = `业务码异常: ${json.code} ${json.message || ''} (详情可复制查看)`;
            } else {
                statusEl.textContent = `完成 · ${new Date().toLocaleTimeString()}`;
                renderAll(list);
            }
        } catch (e) {
            statusEl.textContent = `请求失败: ${e.message}`;
        } finally {
            $('bf-send').disabled = false;
        }
    }
})();
