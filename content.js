/*
 * B站已开奖动态清理
 * 作为浏览器插件的内容脚本运行；也可以整段粘贴到 t.bilibili.com / space.bilibili.com 的控制台直接运行。
 *
 * 流程：拉取自己的动态列表 → 只看「转发」动态 → 识别原动态里的抽奖信息
 *      → 查询开奖状态 → 面板里预览、勾选 → 批量删除
 */
(() => {
  'use strict';

  const NS = '__biliLotteryCleaner';
  if (window[NS]) { window[NS].toggle(); return; }

  const API = {
    nav: 'https://api.bilibili.com/x/web-interface/nav',
    space: 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space',
    lottery: 'https://api.vc.bilibili.com/lottery_svr/v1/lottery_svr/lottery_notice',
    removeNew: 'https://api.bilibili.com/x/dynamic/feed/operate/remove',
    removeOld: 'https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/rm_dynamic',
  };
  const FEATURES = 'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,forwardListHidden,decorationCard,commentsNewVersion,onlyfansAssetsV2,ugcDelete,onlyfansQaCard';
  const STORE_KEY = 'blc.settings.v1';

  const STATES = {
    drawn:   { label: '已开奖',       cls: 'drawn',   pick: true },
    deleted: { label: '源动态已删除', cls: 'deleted', pick: true },
    expired: { label: '已过开奖时间', cls: 'expired', pick: true },
    pending: { label: '未开奖',       cls: 'pending', pick: false },
    unknown: { label: '状态未知',     cls: 'unknown', pick: false },
    suspect: { label: '疑似抽奖',     cls: 'suspect', pick: false },
  };

  const defaults = { limit: 0, delay: 400, delDelay: 800, includeSuspect: true };
  const settings = Object.assign({}, defaults, loadSettings());

  const state = {
    mid: 0, uname: '', csrf: '',
    scanning: false, deleting: false, abort: false,
    scanned: 0, forwards: 0,
    results: [],            // 扫描结果，见 analyzeForward()
    lotteryCache: new Map() // businessType:businessId -> 查询结果
  };

  // ---------- 工具 ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pad = n => String(n).padStart(2, '0');
  const fmt = ts => {
    if (!ts) return '-';
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cookie = name => {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  };
  const qs = obj => Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; }
  }
  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  }

  // 风控时B站会直接回 412 的 HTML 页面，不是 JSON
  async function parse(r) {
    if (r.status === 412 || r.status === 429) throw new Error(`触发风控 (HTTP ${r.status})，请过几分钟再试，并把请求间隔调大`);
    let j;
    try { j = await r.json(); } catch { throw new Error(`接口返回了非 JSON 内容 (HTTP ${r.status})`); }
    if (j.code === -352 || j.code === -412) throw new Error(`触发风控 (${j.code})，请过几分钟再试，并把请求间隔调大`);
    if (j.code === -101) throw new Error('未登录，请先登录B站');
    return j;
  }
  async function getJSON(url, params) {
    return parse(await fetch(params ? url + '?' + qs(params) : url, { credentials: 'include' }));
  }
  async function postForm(url, data) {
    return parse(await fetch(url, {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: qs(data),
    }));
  }
  async function postJSON(url, params, body) {
    return parse(await fetch(url + '?' + qs(params), {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  // ---------- B站接口 ----------
  async function loadAccount() {
    const j = await getJSON(API.nav);
    if (!j.data || !j.data.isLogin) throw new Error('未登录，请先登录B站');
    state.mid = j.data.mid;
    state.uname = j.data.uname;
    state.csrf = cookie('bili_jct');
    if (!state.csrf) throw new Error('读不到 bili_jct cookie，删除会失败；请刷新页面重试');
  }

  async function* iterateSpace(mid) {
    let offset = '';
    for (;;) {
      const j = await getJSON(API.space, {
        host_mid: mid, offset, features: FEATURES, platform: 'web',
        web_location: '333.1387', timezone_offset: -480,
      });
      if (j.code !== 0) throw new Error(`拉取动态失败: ${j.code} ${j.message || ''}`);
      const d = j.data || {};
      for (const it of d.items || []) yield it;
      if (!d.has_more || !d.offset) return;
      offset = d.offset;
      await sleep(settings.delay);
    }
  }

  // 从 additional 卡片里递归找 lottery/result?business_id=..&business_type=.. 这种链接（预约抽奖、充电抽奖）
  function findLotteryLinks(obj, out, depth = 0) {
    if (!obj || depth > 6) return;
    if (typeof obj === 'string') {
      if (/lottery/.test(obj) && /business_id=/.test(obj)) {
        const id = obj.match(/business_id=(\d+)/), ty = obj.match(/business_type=(\d+)/);
        if (id && ty) out.push({ businessType: +ty[1], businessId: id[1] });
      }
      return;
    }
    if (typeof obj === 'object') for (const v of Object.values(obj)) findLotteryLinks(v, out, depth + 1);
  }

  const KIND_NAME = { 1: '互动抽奖', 10: '预约抽奖', 12: '充电抽奖' };

  // 只处理转发动态；返回一条结果记录
  function analyzeForward(item) {
    const orig = item.orig;
    if (!orig) return null;
    const md = orig.modules?.module_dynamic || {};
    const major = md.major || null;
    const nodes = [
      ...(md.desc?.rich_text_nodes || []),
      ...(major?.opus?.summary?.rich_text_nodes || []),
    ];
    const text = md.desc?.text || major?.opus?.summary?.text || major?.archive?.title || major?.opus?.title || '';

    const info = {
      id: item.id_str,
      pubTs: item.modules?.module_author?.pub_ts || 0,
      myText: item.modules?.module_dynamic?.desc?.text || '',
      origId: orig.id_str,
      origType: orig.type,
      origAuthor: orig.modules?.module_author?.name || '',
      origPubTs: orig.modules?.module_author?.pub_ts || 0,
      text,
      lotteries: [],
      state: null,
      lotteryTime: 0,
      prize: '',
      note: '',
    };

    if (orig.type === 'DYNAMIC_TYPE_NONE' || major?.type === 'MAJOR_TYPE_NONE') {
      info.state = 'deleted';
      info.note = major?.none?.tips || '源动态已失效';
      return info;
    }

    if (nodes.some(n => n.type === 'RICH_TEXT_NODE_TYPE_LOTTERY')) {
      info.lotteries.push({ businessType: 1, businessId: orig.id_str });
    }
    const links = [];
    findLotteryLinks(md.additional, links);
    for (const l of links) {
      if (!info.lotteries.some(x => x.businessType === l.businessType && x.businessId === l.businessId)) info.lotteries.push(l);
    }

    if (!info.lotteries.length) {
      if (/抽奖|开奖|中奖|揪\s*\d|抽\s*\d+\s*(位|人|名|个)/.test(text + '\n' + info.myText)) info.state = 'suspect';
      else return null;
    }
    return info;
  }

  async function checkLottery(l) {
    const key = l.businessType + ':' + l.businessId;
    if (state.lotteryCache.has(key)) return state.lotteryCache.get(key);
    let res;
    try {
      const j = await getJSON(API.lottery, {
        business_type: l.businessType, business_id: l.businessId,
        csrf: state.csrf, web_location: '333.1330',
      });
      const d = j.data;
      if (j.code !== 0 || !d || !d.lottery_id) {
        res = { state: 'unknown', note: `抽奖接口 ${j.code}: ${j.message || j.msg || '无数据'}` };
      } else {
        const now = Date.now() / 1000;
        let st = 'pending';
        if (d.status === 2 || d.lottery_result) st = 'drawn';
        else if (d.lottery_time && d.lottery_time < now) st = 'expired';
        res = { state: st, lotteryTime: d.lottery_time, prize: d.first_prize_cmt || '', participants: d.participants };
      }
    } catch (e) {
      if (/风控|未登录/.test(e.message)) throw e;
      res = { state: 'unknown', note: '查询失败: ' + e.message };
    }
    state.lotteryCache.set(key, res);
    return res;
  }

  async function deleteDynamic(id) {
    // 新接口（JSON），跨域预检失败或参数报错时退回旧接口（表单）
    try {
      const j = await postJSON(API.removeNew, { csrf: state.csrf, platform: 'web' }, { dyn_id_str: id });
      if (j.code === 0) return { ok: true, via: 'new' };
      if (![-400, -111, 4101001].includes(j.code)) return { ok: false, msg: `${j.code} ${j.message || ''}` };
    } catch (e) {
      if (/风控|未登录/.test(e.message)) throw e;
    }
    const j = await postForm(API.removeOld, { dynamic_id: id, csrf_token: state.csrf, csrf: state.csrf });
    if (j.code === 0 || j.code === 500404) return { ok: true, via: 'old' };
    return { ok: false, msg: `${j.code} ${j.message || j.msg || ''}` };
  }

  // ---------- UI ----------
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
    .fab { position: fixed; right: 24px; bottom: 96px; z-index: 2147483646; border: 0; border-radius: 999px;
      padding: 10px 16px; background: #fb7299; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer;
      box-shadow: 0 4px 14px rgba(251,114,153,.45); }
    .fab:hover { background: #ff85ad; }
    .fab.hidden, .panel.hidden { display: none; }
    .panel { position: fixed; top: 0; right: 0; width: 560px; max-width: 100vw; height: 100vh; z-index: 2147483647;
      background: #fff; color: #18191c; display: flex; flex-direction: column; box-shadow: -6px 0 24px rgba(0,0,0,.18);
      font-size: 13px; line-height: 1.45; }
    .hd { display: flex; align-items: center; gap: 10px; padding: 12px 14px; background: #fb7299; color: #fff; }
    .hd .ttl { font-size: 15px; font-weight: 700; flex: 1; }
    .hd .acct { font-weight: 400; opacity: .9; margin-left: 8px; font-size: 12px; }
    .hd .x { border: 0; background: transparent; color: #fff; font-size: 18px; cursor: pointer; padding: 0 4px; }
    .bar, .ft { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 14px; border-bottom: 1px solid #e3e5e7; }
    .ft { border-bottom: 0; border-top: 1px solid #e3e5e7; background: #f6f7f8; }
    label { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; color: #61666d; }
    input[type=number] { width: 72px; padding: 3px 6px; border: 1px solid #c9ccd0; border-radius: 4px; font-size: 13px; }
    input[type=checkbox] { width: 15px; height: 15px; margin: 0; cursor: pointer; }
    small { color: #9499a0; }
    .btn { border: 1px solid #c9ccd0; background: #fff; border-radius: 6px; padding: 5px 12px; font-size: 13px; cursor: pointer; color: #18191c; }
    .btn:hover:not(:disabled) { border-color: #fb7299; color: #fb7299; }
    .btn:disabled { opacity: .5; cursor: not-allowed; }
    .btn.primary { background: #00aeec; border-color: #00aeec; color: #fff; }
    .btn.primary:hover:not(:disabled) { background: #33bfef; color: #fff; }
    .btn.danger { background: #f25d8e; border-color: #f25d8e; color: #fff; }
    .btn.danger:hover:not(:disabled) { background: #ff7fa8; color: #fff; }
    .status { padding: 8px 14px; background: #fff7fa; color: #61666d; border-bottom: 1px solid #e3e5e7; min-height: 34px; }
    .status.err { color: #d32f2f; background: #fdecec; }
    .sum { padding: 6px 14px; display: flex; flex-wrap: wrap; gap: 6px; border-bottom: 1px solid #e3e5e7; }
    .sum:empty { display: none; }
    .list { flex: 1; overflow: auto; }
    .empty { padding: 40px 0; text-align: center; color: #9499a0; }
    .row { display: flex; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #f1f2f3; }
    .row:hover { background: #fafafa; }
    .row.gone { opacity: .45; text-decoration: line-through; }
    .row .ck { margin-top: 3px; flex: none; }
    .row .body { flex: 1; min-width: 0; }
    .meta { color: #61666d; font-size: 12px; margin-bottom: 3px; }
    .meta b { color: #18191c; }
    .txt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .links { font-size: 12px; margin-top: 3px; color: #9499a0; }
    .links a { color: #00aeec; text-decoration: none; }
    .links a:hover { text-decoration: underline; }
    .tag { display: inline-block; padding: 0 6px; border-radius: 3px; font-size: 11px; line-height: 18px; color: #fff; margin-right: 4px; vertical-align: 1px; }
    .tag.drawn { background: #fb7299; } .tag.deleted { background: #9499a0; } .tag.expired { background: #ff9f43; }
    .tag.pending { background: #2ac864; } .tag.unknown { background: #c9ccd0; color: #18191c; } .tag.suspect { background: #7d6bff; }
    .tag.big { font-size: 12px; line-height: 20px; }
    .err-msg { color: #d32f2f; font-size: 12px; }
    .grow { flex: 1; }
    .log { border-top: 1px solid #e3e5e7; background: #f6f7f8; }
    .log summary { padding: 6px 14px; cursor: pointer; color: #61666d; font-size: 12px; }
    .log pre { margin: 0; padding: 6px 14px 10px; max-height: 140px; overflow: auto; font-size: 11px; line-height: 1.4;
      font-family: ui-monospace, Menlo, monospace; color: #61666d; white-space: pre-wrap; }
  `;

  const host = document.createElement('div');
  host.id = 'blc-host';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>${CSS}</style>
    <button class="fab" id="fab" title="扫描并清理自己转发过的已开奖抽奖动态">🎲 清理开奖动态</button>
    <div class="panel hidden" id="panel">
      <div class="hd">
        <div class="ttl">B站已开奖动态清理<span class="acct" id="acct"></span></div>
        <button class="x" id="close" title="收起">✕</button>
      </div>
      <div class="bar">
        <label>扫描上限 <input id="limit" type="number" min="0" step="100"> <small>0=全部</small></label>
        <label>请求间隔 <input id="delay" type="number" min="100" step="100"> <small>ms</small></label>
        <label><input id="suspect" type="checkbox"> 列出疑似抽奖（无法自动判断的）</label>
        <span class="grow"></span>
        <button class="btn primary" id="scan">开始扫描</button>
        <button class="btn" id="stop" disabled>停止</button>
      </div>
      <div class="status" id="status">准备就绪。只扫描当前登录账号自己发布的动态。</div>
      <div class="sum" id="sum"></div>
      <div class="list" id="list"><div class="empty">尚未扫描</div></div>
      <div class="ft">
        <button class="btn" id="selDefault">勾选 已开奖 + 源已删 + 已过期</button>
        <button class="btn" id="selNone">全不选</button>
        <span class="grow"></span>
        <label>删除间隔 <input id="delDelay" type="number" min="200" step="100"> <small>ms</small></label>
        <button class="btn danger" id="del" disabled>删除选中 (0)</button>
      </div>
      <details class="log"><summary>日志</summary><pre id="log"></pre></details>
    </div>
  `;
  document.documentElement.appendChild(host);

  const $ = id => root.getElementById(id);
  const el = {
    fab: $('fab'), panel: $('panel'), acct: $('acct'), close: $('close'),
    limit: $('limit'), delay: $('delay'), suspect: $('suspect'), scan: $('scan'), stop: $('stop'),
    status: $('status'), sum: $('sum'), list: $('list'),
    selDefault: $('selDefault'), selNone: $('selNone'), delDelay: $('delDelay'), del: $('del'), log: $('log'),
  };

  // 只在动态页 / 空间页显示悬浮按钮；其他B站页面靠工具栏图标唤起
  if (!/^(t|space)\.bilibili\.com$/.test(location.host)) el.fab.classList.add('hidden');

  el.limit.value = settings.limit;
  el.delay.value = settings.delay;
  el.delDelay.value = settings.delDelay;
  el.suspect.checked = settings.includeSuspect;
  for (const [k, e, kind] of [['limit', el.limit, 'n'], ['delay', el.delay, 'n'], ['delDelay', el.delDelay, 'n'], ['includeSuspect', el.suspect, 'b']]) {
    e.addEventListener('change', () => {
      settings[k] = kind === 'n' ? Math.max(0, parseInt(e.value, 10) || 0) : e.checked;
      if (k === 'delay') settings.delay = Math.max(100, settings.delay);
      if (k === 'delDelay') settings.delDelay = Math.max(200, settings.delDelay);
      saveSettings();
    });
  }

  function log(msg) {
    const t = new Date();
    el.log.textContent += `[${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}] ${msg}\n`;
    el.log.scrollTop = el.log.scrollHeight;
  }
  function setStatus(msg, isErr) {
    el.status.textContent = msg;
    el.status.classList.toggle('err', !!isErr);
  }
  function setBusy() {
    const busy = state.scanning || state.deleting;
    el.scan.disabled = busy;
    el.stop.disabled = !busy;
    el.scan.textContent = state.scanning ? '扫描中…' : '开始扫描';
    updateDelBtn();
  }
  function selectedRows() {
    return [...el.list.querySelectorAll('.row:not(.gone) .ck:checked')].map(c => c.closest('.row'));
  }
  function updateDelBtn() {
    const n = selectedRows().length;
    el.del.textContent = `删除选中 (${n})`;
    el.del.disabled = n === 0 || state.scanning || state.deleting;
  }
  function updateSummary() {
    const counts = {};
    for (const r of state.results) counts[r.state] = (counts[r.state] || 0) + 1;
    el.sum.innerHTML = Object.entries(STATES)
      .filter(([k]) => counts[k])
      .map(([k, s]) => `<span class="tag big ${s.cls}">${s.label} ${counts[k]}</span>`).join('');
  }

  function renderRow(r) {
    const s = STATES[r.state];
    const kinds = r.lotteries.map(l => KIND_NAME[l.businessType] || `类型${l.businessType}`).join('/');
    const metaBits = [
      `<span class="tag ${s.cls}">${s.label}</span>`,
      r.origAuthor ? `<b>${esc(r.origAuthor)}</b>` : '<b>（原作者未知）</b>',
      kinds ? esc(kinds) : '',
      r.origPubTs ? `原动态 ${fmt(r.origPubTs)}` : '',
      r.lotteryTime ? `开奖 ${fmt(r.lotteryTime)}` : '',
      `我的转发 ${fmt(r.pubTs)}`,
    ].filter(Boolean).join(' · ');
    const extra = [
      r.prize ? `奖品: ${esc(r.prize)}` : '',
      r.note ? esc(r.note) : '',
    ].filter(Boolean).join(' · ');
    const text = (r.text || r.note || '').replace(/\s+/g, ' ').trim();
    const div = document.createElement('div');
    div.className = 'row';
    div.dataset.id = r.id;
    div.innerHTML = `
      <input type="checkbox" class="ck" ${s.pick ? 'checked' : ''}>
      <div class="body">
        <div class="meta">${metaBits}</div>
        <div class="txt" title="${esc(text)}">${esc(text.slice(0, 120)) || '<small>（无文字）</small>'}</div>
        <div class="links">
          <a href="https://t.bilibili.com/${esc(r.id)}" target="_blank" rel="noreferrer">我的转发</a>
          ${r.state !== 'deleted' ? ` · <a href="https://t.bilibili.com/${esc(r.origId)}" target="_blank" rel="noreferrer">原动态</a>` : ''}
          ${extra ? ' · ' + extra : ''}
          <span class="err-msg"></span>
        </div>
      </div>`;
    div.querySelector('.ck').addEventListener('change', updateDelBtn);
    return div;
  }
  function addResult(r) {
    if (el.list.querySelector('.empty')) el.list.innerHTML = '';
    state.results.push(r);
    el.list.appendChild(renderRow(r));
    updateSummary();
    updateDelBtn();
  }

  // ---------- 扫描 ----------
  async function scan() {
    if (state.scanning || state.deleting) return;
    state.scanning = true; state.abort = false;
    state.scanned = 0; state.forwards = 0; state.results = [];
    el.list.innerHTML = '<div class="empty">扫描中…</div>';
    el.sum.innerHTML = '';
    setBusy();
    try {
      await loadAccount();
      el.acct.textContent = `${state.uname} (${state.mid})`;
      log(`账号 ${state.uname} (${state.mid})，开始扫描`);
      const progress = () => setStatus(`已扫描 ${state.scanned} 条动态（其中转发 ${state.forwards} 条），命中 ${state.results.length} 条`);
      for await (const item of iterateSpace(state.mid)) {
        if (state.abort) break;
        state.scanned++;
        if (item.type === 'DYNAMIC_TYPE_FORWARD') {
          state.forwards++;
          const info = analyzeForward(item);
          if (info) {
            if (info.lotteries.length) {
              const rs = [];
              for (const l of info.lotteries) {
                rs.push(await checkLottery(l));
                await sleep(Math.max(150, settings.delay / 2));
              }
              // 多个抽奖时取「最不该删」的状态：未开奖 > 未知 > 已过期 > 已开奖
              const order = ['pending', 'unknown', 'expired', 'drawn'];
              rs.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
              const top = rs[0];
              info.state = top.state;
              info.lotteryTime = top.lotteryTime || 0;
              info.prize = top.prize || '';
              info.note = top.note || '';
            }
            if (info.state !== 'suspect' || settings.includeSuspect) addResult(info);
          }
        }
        progress();
        if (settings.limit && state.scanned >= settings.limit) { log(`达到扫描上限 ${settings.limit}`); break; }
      }
      const c = k => state.results.filter(r => r.state === k).length;
      setStatus(`${state.abort ? '已停止' : '扫描完成'}：共 ${state.scanned} 条动态，转发 ${state.forwards} 条；已开奖 ${c('drawn')}，源已删 ${c('deleted')}，已过期 ${c('expired')}，未开奖 ${c('pending')}，未知 ${c('unknown')}，疑似 ${c('suspect')}`);
      if (!state.results.length) el.list.innerHTML = '<div class="empty">没有找到可清理的动态 🎉</div>';
      log('扫描结束');
    } catch (e) {
      setStatus('扫描出错：' + e.message, true);
      log('错误: ' + e.message);
      if (!state.results.length) el.list.innerHTML = '<div class="empty">扫描失败</div>';
    } finally {
      state.scanning = false;
      setBusy();
    }
  }

  // ---------- 删除 ----------
  async function removeSelected() {
    if (state.scanning || state.deleting) return;
    const rows = selectedRows();
    if (!rows.length) return;
    const byState = {};
    for (const row of rows) {
      const r = state.results.find(x => x.id === row.dataset.id);
      if (r) byState[r.state] = (byState[r.state] || 0) + 1;
    }
    const detail = Object.entries(byState).map(([k, n]) => `${STATES[k].label} ${n}`).join('，');
    if (byState.pending && !confirm(`选中的动态里有 ${byState.pending} 条抽奖【还没开奖】，删掉就等于放弃参与。确定要一起删吗？`)) return;
    if (!confirm(`确认删除 ${rows.length} 条动态（${detail}）？\n删除后无法恢复。`)) return;

    state.deleting = true; state.abort = false;
    setBusy();
    let ok = 0, fail = 0;
    for (const row of rows) {
      if (state.abort) break;
      const id = row.dataset.id;
      setStatus(`正在删除 ${ok + fail + 1}/${rows.length}…（成功 ${ok}，失败 ${fail}）`);
      try {
        const res = await deleteDynamic(id);
        if (res.ok) {
          ok++;
          row.classList.add('gone');
          row.querySelector('.ck').checked = false;
          row.querySelector('.ck').disabled = true;
          state.results = state.results.filter(x => x.id !== id);
          log(`已删除 ${id} (${res.via})`);
        } else {
          fail++;
          row.querySelector('.err-msg').textContent = ' 删除失败: ' + res.msg;
          log(`删除失败 ${id}: ${res.msg}`);
        }
      } catch (e) {
        fail++;
        row.querySelector('.err-msg').textContent = ' 删除失败: ' + e.message;
        log(`删除失败 ${id}: ${e.message}`);
        if (/风控|未登录/.test(e.message)) { setStatus(e.message, true); break; }
      }
      updateDelBtn();
      await sleep(settings.delDelay);
    }
    updateSummary();
    setStatus(`${state.abort ? '已停止' : '删除完成'}：成功 ${ok}，失败 ${fail}`, fail > 0);
    state.deleting = false;
    setBusy();
  }

  // ---------- 事件 ----------
  const open = () => { el.panel.classList.remove('hidden'); if (!state.mid) loadAccount().then(() => { el.acct.textContent = `${state.uname} (${state.mid})`; }).catch(e => setStatus(e.message, true)); };
  const close = () => el.panel.classList.add('hidden');
  const toggle = () => el.panel.classList.contains('hidden') ? open() : close();

  el.fab.addEventListener('click', toggle);
  el.close.addEventListener('click', close);
  el.scan.addEventListener('click', scan);
  el.stop.addEventListener('click', () => { state.abort = true; log('用户请求停止'); });
  el.del.addEventListener('click', removeSelected);
  el.selDefault.addEventListener('click', () => {
    for (const row of el.list.querySelectorAll('.row:not(.gone)')) {
      const r = state.results.find(x => x.id === row.dataset.id);
      row.querySelector('.ck').checked = !!(r && STATES[r.state].pick);
    }
    updateDelBtn();
  });
  el.selNone.addEventListener('click', () => {
    for (const c of el.list.querySelectorAll('.row .ck')) c.checked = false;
    updateDelBtn();
  });

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(msg => { if (msg?.type === 'blc:toggle') toggle(); });
  }

  window[NS] = { toggle, open, close, scan, state, settings, analyzeForward, checkLottery, deleteDynamic };
  // 控制台粘贴运行时直接打开面板
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) open();
})();
