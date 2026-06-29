const koa = require('koa');
const Router = require('@koa/router');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { log } = require('./utils/log');
const { getModules } = require('./utils');

const dataDir = path.join(__dirname, '..', 'data');
const portfolioPath = path.join(dataDir, 'portfolio.json');
const snapshotsPath = path.join(dataDir, 'snapshots.json');
const settingsPath = path.join(dataDir, 'settings.json');

let snapshotTimer = null;

const snapshotSchedules = [
  { type: 'estimate', label: '估值', time: '15:00' },
  { type: 'netValue', label: '真实净值', time: '23:00' },
];

const marketHolidayRanges = [
  ['2026-01-01', '2026-01-03'],
  ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'],
  ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'],
  ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07'],
];

const iconFiles = {
  '/app-icon.png': 'app-icon-128.png',
  '/apple-touch-icon.png': 'app-icon.png',
  '/favicon-32.png': 'favicon-32.png',
  '/favicon.ico': 'favicon-32.png',
};

const iconDir = path.join(__dirname, 'assets');

function renderIconLinks() {
  return `<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
    <link rel="manifest" href="/site.webmanifest">
    <meta name="theme-color" content="#b91c1c">`;
}

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function normalizeHolding(holding) {
  return {
    code: String(holding.code || '').trim(),
    costPrice: toNumber(holding.costPrice),
    shares: toNumber(holding.shares),
  };
}

function readPortfolioHoldings() {
  return readJsonFile(portfolioPath, [])
    .map(normalizeHolding)
    .filter(
      (holding) => holding.code && holding.costPrice > 0 && holding.shares > 0,
    );
}

function writePortfolioHoldings(holdings) {
  const normalized = holdings
    .map(normalizeHolding)
    .filter(
      (holding) => holding.code && holding.costPrice > 0 && holding.shares > 0,
    );
  writeJsonFile(portfolioPath, normalized);
  return normalized;
}

function readSnapshots() {
  return readJsonFile(snapshotsPath, []);
}

function writeSnapshots(snapshots) {
  writeJsonFile(snapshotsPath, snapshots);
}

function hashPassword(password, salt) {
  return crypto
    .pbkdf2Sync(String(password), String(salt), 120000, 32, 'sha256')
    .toString('hex');
}

function createDefaultSettings() {
  const passwordSalt = crypto.randomBytes(16).toString('hex');
  return {
    username: 'admin',
    passwordSalt,
    passwordHash: hashPassword('Qqqaaa000', passwordSalt),
    sessionSecret: crypto.randomBytes(32).toString('hex'),
  };
}

function normalizeSettings(settings = {}) {
  const next = {
    username: String(settings.username || 'admin').trim() || 'admin',
    passwordSalt:
      settings.passwordSalt || crypto.randomBytes(16).toString('hex'),
    passwordHash: settings.passwordHash || '',
    sessionSecret:
      settings.sessionSecret || crypto.randomBytes(32).toString('hex'),
  };

  if (!next.passwordHash) {
    next.passwordHash = hashPassword('Qqqaaa000', next.passwordSalt);
  }

  return next;
}

function readSettings() {
  const settings = normalizeSettings(
    readJsonFile(settingsPath, createDefaultSettings()),
  );
  writeJsonFile(settingsPath, settings);
  return settings;
}

function writeSettings(settings) {
  const next = normalizeSettings(settings);
  writeJsonFile(settingsPath, next);
  return next;
}

function verifyPassword(password, settings) {
  const expected = Buffer.from(settings.passwordHash, 'hex');
  const actual = Buffer.from(
    hashPassword(password, settings.passwordSalt),
    'hex',
  );

  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  );
}

function getSessionToken(username, settings) {
  const payload = Buffer.from(
    JSON.stringify({
      username,
      expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 7,
    }),
  ).toString('base64url');
  const signature = crypto
    .createHmac('sha256', settings.sessionSecret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function readSession(ctx) {
  const token = ctx.cookies.get('fund_monitor_session');
  if (!token || !token.includes('.')) {
    return null;
  }

  const settings = readSettings();
  const [payload, signature] = token.split('.');
  const expectedSignature = crypto
    .createHmac('sha256', settings.sessionSecret)
    .update(payload)
    .digest('base64url');

  const signatureBuffer = Buffer.from(signature || '');
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const session = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    if (session.expiresAt < Date.now()) {
      return null;
    }
    return { username: session.username };
  } catch (error) {
    return null;
  }
}

function setSession(ctx, username) {
  const settings = readSettings();
  ctx.cookies.set('fund_monitor_session', getSessionToken(username, settings), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7,
  });
}

function clearSession(ctx) {
  ctx.cookies.set('fund_monitor_session', '', {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 0,
  });
}

function isPublicPath(pathname) {
  return (
    pathname === '/login' ||
    pathname === '/site.webmanifest' ||
    Object.keys(iconFiles).includes(pathname) ||
    pathname.startsWith('/fund')
  );
}

function getShanghaiNow() {
  return new Date();
}

function formatShanghaiDate(date = getShanghaiNow()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function formatShanghaiDateTime(date = getShanghaiNow()) {
  return date
    .toLocaleString('zh-CN', {
      hour12: false,
      timeZone: 'Asia/Shanghai',
    })
    .replaceAll('/', '-');
}

function getShanghaiDateTime(dateKey, time) {
  return new Date(`${dateKey}T${time}:00+08:00`);
}

function addShanghaiDays(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return formatShanghaiDate(
    new Date(Date.UTC(year, month - 1, day + days, 4)),
  );
}

function isInDateRange(dateKey, [start, end]) {
  return dateKey >= start && dateKey <= end;
}

function isMarketTradingDay(dateKey) {
  const weekday = getShanghaiDateTime(dateKey, '12:00').getUTCDay();

  if (weekday === 0 || weekday === 6) {
    return false;
  }

  return !marketHolidayRanges.some((range) => isInDateRange(dateKey, range));
}

function getNextSnapshotEvent(now = new Date()) {
  const today = formatShanghaiDate(now);

  for (let offset = 0; offset < 370; offset += 1) {
    const date = addShanghaiDays(today, offset);

    if (!isMarketTradingDay(date)) {
      continue;
    }

    for (const schedule of snapshotSchedules) {
      const runAt = getShanghaiDateTime(date, schedule.time);

      if (runAt > now) {
        return { ...schedule, date, runAt };
      }
    }
  }

  return null;
}

async function readPostBody(ctx) {
  const chunks = [];
  for await (const chunk of ctx.req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return Object.fromEntries(new URLSearchParams(body));
}

function redirect(ctx, location = '/portfolio') {
  ctx.status = 303;
  ctx.redirect(location);
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatNumber(value, digits = 2) {
  return toNumber(value).toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatPrice(value) {
  return toNumber(value).toFixed(4);
}

function formatPercent(value) {
  return `${toNumber(value).toFixed(2)}%`;
}

function getTimeMs(value) {
  const time = Date.parse(String(value || '').replace(' ', 'T'));
  return Number.isFinite(time) ? time : 0;
}

function getDayProfit(price, shares, dayRate, previousPrice) {
  const current = toNumber(price);
  const previous = toNumber(previousPrice);

  if (current && previous) {
    return shares * (current - previous);
  }

  const rate = toNumber(dayRate) / 100;

  if (!current || rate === -1) {
    return 0;
  }

  return shares * (current - current / (1 + rate));
}

function getPreviousPriceForDayProfit(marketData, latestNet, previousNet) {
  return marketData.source === '最新净值' ? previousNet.DWJZ : latestNet.DWJZ;
}

function getEstimateDate(expansion) {
  return expansion && expansion.GZTIME
    ? String(expansion.GZTIME).slice(0, 10)
    : '';
}

function getMarketData(expansion = {}, latestNet = {}, mode = 'auto') {
  const hasEstimate = Boolean(expansion.GZ);
  const hasLatestNet = Boolean(latestNet.DWJZ);
  const estimateDate = getEstimateDate(expansion);
  const latestNetDate = latestNet.FSRQ || '';
  const useLatestNet =
    mode === 'netValue' ||
    (mode !== 'estimate' &&
      hasLatestNet &&
      (!hasEstimate || !estimateDate || latestNetDate >= estimateDate));

  if (useLatestNet && hasLatestNet) {
    return {
      price: latestNet.DWJZ,
      rate: latestNet.JZZZL,
      source: '最新净值',
      updateTime: latestNetDate,
      isEstimate: false,
    };
  }

  if (hasEstimate) {
    return {
      price: expansion.GZ,
      rate: expansion.GSZZL,
      source: '实时估算',
      updateTime: expansion.GZTIME,
      isEstimate: true,
    };
  }

  if (hasLatestNet) {
    return {
      price: latestNet.DWJZ,
      rate: latestNet.JZZZL,
      source: '最新净值',
      updateTime: latestNetDate,
      isEstimate: false,
    };
  }

  return {
    price: '',
    rate: '',
    source: '暂无数据',
    updateTime: '',
    isEstimate: false,
  };
}

function parseValuationPoints(datas = []) {
  return (Array.isArray(datas) ? datas : [])
    .map((item) => {
      const [index, time, rate] = String(item).split(',');
      return {
        index,
        time,
        rate: Number(rate),
      };
    })
    .filter(({ time, rate }) => time && Number.isFinite(rate));
}

function renderChart(points, emptyMessage = '暂无盘中估算曲线') {
  if (!points.length) {
    return `<div class="empty">${escapeHtml(emptyMessage)}</div>`;
  }

  const width = 760;
  const height = 240;
  const padding = 24;
  const rates = points.map(({ rate }) => rate);
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  const span = Math.max(max - min, 0.01);
  const coords = points
    .map(({ rate }, index) => {
      const x =
        padding +
        (index / Math.max(points.length - 1, 1)) * (width - padding * 2);
      const y = padding + ((max - rate) / span) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const zeroY = padding + ((max - 0) / span) * (height - padding * 2);
  const showZero = zeroY >= padding && zeroY <= height - padding;

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="估算涨幅曲线">
    ${showZero ? `<line x1="${padding}" y1="${zeroY.toFixed(1)}" x2="${width - padding}" y2="${zeroY.toFixed(1)}" stroke="#cbd5e1" stroke-dasharray="4 4" />` : ''}
    <polyline fill="none" stroke="#0f766e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${coords}" />
  </svg>`;
}

function renderSharedStyles() {
  return `
      * { box-sizing: border-box; }
      :root {
        --sidebar: #0b1220;
        --sidebar-muted: #94a3b8;
        --sidebar-active: #182338;
        --page-bg: #f3f6fb;
        --panel: #fff;
        --line: #d7e0ec;
        --line-soft: #edf1f6;
        --text: #111827;
        --muted: #64748b;
        --brand: #1677ff;
        --brand-strong: #0f62d8;
        --teal: #0f766e;
        --red: #dc2626;
        --green: #16a34a;
        --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.05);
        --shadow-md: 0 14px 36px rgba(15, 23, 42, 0.08);
      }
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--text); background: linear-gradient(180deg, #f8fafc 0, var(--page-bg) 300px); -webkit-text-size-adjust: 100%; }
      a { color: var(--teal); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .app-page main { max-width: none; min-height: 100vh; margin: 0 0 0 288px; padding: 126px 36px 52px; }
      .app-shell { max-width: none; }
      .app-nav { position: fixed; inset: 0 auto 0 0; z-index: 20; width: 288px; padding: 28px 18px; border-right: 1px solid rgba(148, 163, 184, 0.16); background: radial-gradient(circle at 24px 20px, rgba(22, 119, 255, 0.18), transparent 240px), var(--sidebar); color: #e5edf8; box-shadow: 10px 0 30px rgba(15, 23, 42, 0.12); }
      .app-brand { display: inline-flex; align-items: center; margin-bottom: 42px; color: #fff; font-size: 23px; font-weight: 800; letter-spacing: 0; }
      .app-brand img { width: 56px; height: 56px; border-radius: 8px; background: #fff; box-shadow: 0 10px 24px rgba(0, 0, 0, 0.16); }
      .app-nav-links { display: grid; gap: 10px; }
      .app-nav a { position: relative; display: flex; min-height: 56px; align-items: center; padding: 0 18px 0 22px; border: 1px solid transparent; border-radius: 8px; color: #cbd5e1; font-size: 18px; font-weight: 750; text-decoration: none; }
      .app-nav a:hover { color: #fff; background: rgba(255, 255, 255, 0.06); text-decoration: none; }
      .app-nav a.active { border-color: rgba(148, 163, 184, 0.2); color: #fff; background: linear-gradient(135deg, rgba(22, 119, 255, 0.2), rgba(255, 255, 255, 0.06)); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06); }
      .app-nav a.active::before { content: ""; position: absolute; left: 8px; top: 14px; bottom: 14px; width: 3px; border-radius: 999px; background: #38bdf8; }
      .app-topbar { position: fixed; top: 0; right: 0; left: 288px; z-index: 15; display: flex; min-height: 96px; align-items: center; justify-content: space-between; gap: 16px; padding: 0 36px; border-bottom: 1px solid rgba(215, 224, 236, 0.9); background: rgba(255, 255, 255, 0.9); backdrop-filter: blur(14px); box-shadow: var(--shadow-sm); }
      .app-context { display: grid; gap: 5px; min-width: 0; }
      .app-context strong { display: block; color: #101827; font-size: 21px; line-height: 1.2; font-weight: 850; }
      .app-context span { display: block; color: var(--muted); font-size: 13px; line-height: 1.35; font-weight: 650; }
      .app-user { display: flex; align-items: center; gap: 12px; color: #3f4b5f; white-space: nowrap; font-weight: 700; }
      .app-user form { margin: 0; }
      .logout-button { display: inline-flex; min-height: 40px; align-items: center; justify-content: center; padding: 8px 14px; border: 1px solid var(--line); border-radius: 8px; color: #334155; background: #fff; font: inherit; font-weight: 700; cursor: pointer; }
      .logout-button:hover { border-color: #cbd5e1; background: #f8fafc; }
      @media (max-width: 900px) {
        .app-page main { margin-left: 0; padding: 156px max(14px, env(safe-area-inset-right)) 32px max(14px, env(safe-area-inset-left)); }
        .app-nav { inset: 0 0 auto 0; width: auto; height: 76px; display: flex; align-items: center; gap: 14px; padding: 10px 14px; overflow-x: auto; border-right: 0; }
        .app-brand { flex: 0 0 auto; margin: 0; font-size: 18px; }
        .app-brand img { width: 42px; height: 42px; }
        .app-nav-links { display: flex; flex: 0 0 auto; gap: 8px; }
        .app-nav a { min-height: 42px; padding: 0 12px; font-size: 14px; }
        .app-nav a.active::before { display: none; }
        .app-topbar { top: 76px; left: 0; min-height: 64px; padding: 0 14px; }
        .app-context strong { font-size: 17px; }
        .app-context span { display: none; }
      }`;
}

function renderAppNav(active, user) {
  const pages = {
    funds: ['持仓总览', '实时查看组合市值、当日收益和盈亏状态'],
    config: ['持仓配置', '集中维护基金代码、成本价和份额'],
    trend: ['收益走势', '追踪 15:00 估值快照和 23:00 真实净值快照'],
    settings: ['账户设置', '管理本地登录用户名和密码'],
  };
  const page = pages[active] || ['Fund Monitor', '基金组合监控工作台'];
  const links = [
    ['funds', '/portfolio', '持仓总览'],
    ['config', '/config', '持仓配置'],
    ['trend', '/history', '收益走势'],
    ['settings', '/settings', '账户设置'],
  ]
    .map(
      ([key, href, label]) =>
        `<a class="${active === key ? 'active' : ''}" href="${href}">${label}</a>`,
    )
    .join('');

  return `<nav class="app-nav" aria-label="主导航">
      <a class="app-brand" href="/">
        <img src="/app-icon.png" alt="">
      </a>
      <div class="app-nav-links">${links}</div>
    </nav>
    <div class="app-topbar">
      <div class="app-context">
        <strong>${escapeHtml(page[0])}</strong>
        <span>${escapeHtml(page[1])}</span>
      </div>
      <div class="app-user">
        <span>${escapeHtml((user && user.username) || '')}</span>
        <form action="/logout" method="post"><button class="logout-button" type="submit">退出</button></form>
      </div>
    </div>`;
}

function renderLoginPage({ error = '', next = '/portfolio' } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    ${renderIconLinks()}
    <title>登录 - Fund Monitor</title>
    <style>
      ${renderSharedStyles()}
      body { min-height: 100vh; display: grid; place-items: center; padding: 18px; }
      .login-panel { width: min(420px, 100%); padding: 24px; border: 1px solid #dbe3ee; border-radius: 8px; background: #fff; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04); }
      h1 { margin: 0 0 18px; font-size: 28px; }
      label { display: grid; gap: 6px; margin-bottom: 14px; color: #64748b; font-size: 13px; }
      input { width: 100%; min-height: 42px; padding: 9px 10px; border: 1px solid #cbd5e1; border-radius: 6px; color: #172033; font: inherit; }
      button { width: 100%; min-height: 42px; border: 1px solid #0f766e; border-radius: 6px; color: #fff; background: #0f766e; font: inherit; cursor: pointer; }
      .error { margin: 0 0 14px; padding: 10px 12px; border-radius: 6px; color: #b91c1c; background: #fef2f2; }
    </style>
  </head>
  <body>
    <form class="login-panel" action="/login" method="post">
      <h1>登录</h1>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <label>用户名<input name="username" autocomplete="username" required></label>
      <label>密码<input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">登录</button>
    </form>
  </body>
</html>`;
}

function renderSettingsPage({ user, error = '', success = '' } = {}) {
  const settings = readSettings();

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    ${renderIconLinks()}
    <title>账户设置</title>
    <style>
      ${renderSharedStyles()}
      .panel { max-width: 640px; padding: 24px; border: 1px solid var(--line); border-radius: 8px; background: linear-gradient(180deg, #fff, #fbfdff); box-shadow: var(--shadow-md); }
      label { display: grid; gap: 6px; margin-bottom: 14px; color: var(--muted); font-size: 13px; }
      input { width: 100%; min-height: 42px; padding: 9px 10px; border: 1px solid #cbd5e1; border-radius: 8px; color: var(--text); font: inherit; }
      button { min-height: 42px; padding: 9px 14px; border: 1px solid var(--brand); border-radius: 8px; color: #fff; background: var(--brand); font: inherit; cursor: pointer; }
      .message { margin: 0 0 14px; padding: 10px 12px; border-radius: 6px; }
      .error { color: #b91c1c; background: #fef2f2; }
      .success { color: #0f766e; background: #ccfbf1; }
    </style>
  </head>
  <body class="app-page">
    <main class="app-shell">
      ${renderAppNav('settings', user)}
      <form class="panel" action="/settings" method="post">
        ${error ? `<p class="message error">${escapeHtml(error)}</p>` : ''}
        ${success ? `<p class="message success">${escapeHtml(success)}</p>` : ''}
        <label>用户名<input name="username" value="${escapeHtml(settings.username)}" autocomplete="username" required></label>
        <label>新密码<input name="password" type="password" autocomplete="new-password" minlength="6"></label>
        <label>确认新密码<input name="confirmPassword" type="password" autocomplete="new-password" minlength="6"></label>
        <button type="submit">保存设置</button>
      </form>
    </main>
  </body>
</html>`;
}

function renderValuationPage({ fcode, data, history, detail, error, user }) {
  const expansion = data && data.Expansion ? data.Expansion : {};
  const latestNet =
    history && Array.isArray(history.Datas) && history.Datas.length
      ? history.Datas[0]
      : {};
  const previousNet =
    history && Array.isArray(history.Datas) && history.Datas.length > 1
      ? history.Datas[1]
      : {};
  const detailInfo = detail && detail.Datas ? detail.Datas : {};
  const holding = readPortfolioHoldings().find((item) => item.code === fcode);
  const hasEstimate = Boolean(expansion.GZ);
  const marketData = getMarketData(expansion, latestNet);
  const displayName = expansion.SHORTNAME || detailInfo.SHORTNAME || '基金详情';
  const displayPrice = marketData.price;
  const displayRate = marketData.rate;
  const displayTime = marketData.updateTime;
  const displaySource = marketData.source;
  const points = parseValuationPoints(data && data.Datas);
  const latest = points[points.length - 1];
  const rate = Number(displayRate || (latest && latest.rate));
  const isUp = Number.isFinite(rate) && rate >= 0;
  const marketValue =
    holding && displayPrice ? holding.shares * toNumber(displayPrice) : 0;
  const costAmount = holding ? holding.costPrice * holding.shares : 0;
  const profit = marketValue - costAmount;
  const profitRate = costAmount ? (profit / costAmount) * 100 : 0;
  const previousPrice = getPreviousPriceForDayProfit(
    marketData,
    latestNet,
    previousNet,
  );
  const dayProfit = holding
    ? getDayProfit(
        toNumber(displayPrice),
        holding.shares,
        displayRate,
        previousPrice,
      )
    : 0;
  const fallbackMessage = latestNet.DWJZ
    ? '该基金暂无盘中估算曲线，已显示最新净值'
    : '暂无盘中估算曲线';
  const rows = [
    ['基金代码', expansion.FCODE || fcode],
    ['基金名称', displayName],
    ['基金类型', detailInfo.FTYPE],
    ['数据源', displaySource],
    ['更新时间', displayTime || (latest && latest.time)],
    [marketData.isEstimate ? '估值' : '最新净值', displayPrice],
    [
      marketData.isEstimate ? '估算涨幅' : '日涨幅',
      displayRate ? `${displayRate}%` : latest ? `${latest.rate}%` : '',
    ],
    ['盘中估算价', hasEstimate && !marketData.isEstimate && expansion.GZ],
    [
      '盘中估算涨幅',
      hasEstimate && !marketData.isEstimate && expansion.GSZZL
        ? `${expansion.GSZZL}%`
        : '',
    ],
    ['估算涨跌额', expansion.GZZF],
    ['净值日期', expansion.JZRQ],
    ['单位净值', expansion.DWJZ],
    ['申购状态', expansion.SGZT],
    ['赎回状态', expansion.SHZT],
    ['持仓成本价', holding && formatPrice(holding.costPrice)],
    ['持有份额', holding && formatNumber(holding.shares, 2)],
    ['持仓成本', holding && formatNumber(costAmount, 2)],
    ['当前市值', holding && formatNumber(marketValue, 2)],
    ['当日收益', holding && formatNumber(dayProfit, 2)],
    ['浮盈亏', holding && formatNumber(profit, 2)],
    ['收益率', holding && formatPercent(profitRate)],
  ];
  const tableRows = rows
    .filter(
      ([, value]) => value !== undefined && value !== null && value !== '',
    )
    .map(
      ([label, value]) =>
        `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${renderIconLinks()}
    <title>基金实时估算 - ${escapeHtml(fcode)}</title>
    <style>
      ${renderSharedStyles()}
      header { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
      h1 { margin: 0; font-size: 34px; line-height: 1.15; }
      .sub { margin: 8px 0 0; color: var(--muted); font-weight: 600; }
      form { display: flex; gap: 8px; }
      input { width: 128px; padding: 9px 10px; border: 1px solid #cbd5e1; border-radius: 8px; font: inherit; }
      button, .back { padding: 9px 14px; border: 1px solid var(--brand); border-radius: 8px; color: #fff; background: var(--brand); font: inherit; font-weight: 700; text-decoration: none; cursor: pointer; }
      .layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 20px; align-items: start; }
      .panel { border: 1px solid var(--line); border-radius: 8px; background: #fff; box-shadow: 0 10px 28px rgba(15, 23, 42, 0.05); }
      .chart { padding: 18px; }
      .chart svg { display: block; width: 100%; height: auto; }
      .latest { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; padding: 16px 18px; border-top: 1px solid #e5e7eb; }
      .metric span { display: block; color: var(--muted); font-size: 13px; font-weight: 700; }
      .metric strong { display: block; margin-top: 4px; font-size: 22px; }
      .up { color: var(--red); }
      .down { color: var(--green); }
      table { width: 100%; border-collapse: collapse; }
      th, td { padding: 12px 14px; border-bottom: 1px solid #edf2f7; text-align: left; }
      th { width: 96px; color: var(--muted); font-weight: 700; }
      .error, .empty { padding: 18px; color: #b91c1c; background: #fef2f2; border-radius: 8px; }
      .raw { margin-top: 20px; overflow: auto; }
      pre { margin: 0; padding: 16px; font-size: 12px; line-height: 1.6; }
      @media (max-width: 820px) {
        header { display: block; }
        form { margin-top: 16px; }
        .layout { grid-template-columns: 1fr; }
        .latest { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body class="app-page">
    <main>
      ${renderAppNav('funds', user)}
      <header>
        <div>
          <h1>${escapeHtml(displayName)}</h1>
          <p class="sub">FCODE ${escapeHtml(fcode)} · 页面每 60 秒自动刷新</p>
        </div>
        <form action="/valuation" method="get">
          <input name="FCODE" value="${escapeHtml(fcode)}" inputmode="numeric" aria-label="基金代码">
          <button type="submit">查看</button>
          <a class="back" href="/portfolio">返回</a>
        </form>
      </header>
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
      <section class="layout">
        <div class="panel">
          <div class="chart">${renderChart(points, fallbackMessage)}</div>
          <div class="latest">
            <div class="metric"><span>${marketData.isEstimate ? '最新估值' : '最新净值'}</span><strong>${escapeHtml(displayPrice || '--')}</strong></div>
            <div class="metric"><span>${marketData.isEstimate ? '估算涨幅' : '日涨幅'}</span><strong class="${isUp ? 'up' : 'down'}">${escapeHtml(displayRate ? `${displayRate}%` : latest ? `${latest.rate}%` : '--')}</strong></div>
            <div class="metric"><span>更新时间</span><strong>${escapeHtml(displayTime || (latest && latest.time) || '--')}</strong></div>
          </div>
        </div>
        <div class="panel">
          <table>${tableRows || '<tr><td>暂无估算摘要</td></tr>'}</table>
        </div>
      </section>
      <section class="panel raw">
        <pre>${escapeHtml(JSON.stringify({ valuation: data || {}, history: history || {}, detail: detail || {} }, null, 2))}</pre>
      </section>
    </main>
  </body>
</html>`;
}

async function getPortfolioRows(
  { valuationApi, historyApi, detailApi },
  { marketMode = 'auto' } = {},
) {
  const holdings = readPortfolioHoldings();

  return Promise.all(
    holdings.map(async (holding) => {
      const [valuation, history, detail] = await Promise.all([
        valuationApi({ FCODE: holding.code }).catch(() => null),
        historyApi({
          FCODE: holding.code,
          pageIndex: 1,
          pagesize: 2,
        }).catch(() => null),
        detailApi({ FCODE: holding.code }).catch(() => null),
      ]);
      const expansion =
        valuation && valuation.Expansion ? valuation.Expansion : {};
      const latestNet =
        history && Array.isArray(history.Datas) && history.Datas.length
          ? history.Datas[0]
          : {};
      const previousNet =
        history && Array.isArray(history.Datas) && history.Datas.length > 1
          ? history.Datas[1]
          : {};
      const detailInfo = detail && detail.Datas ? detail.Datas : {};
      const marketData = getMarketData(expansion, latestNet, marketMode);
      const price = toNumber(marketData.price);
      const costAmount = holding.costPrice * holding.shares;
      const marketValue = price * holding.shares;
      const profit = marketValue - costAmount;
      const profitRate = costAmount ? (profit / costAmount) * 100 : 0;
      const dayRate = toNumber(marketData.rate);
      const previousPrice = getPreviousPriceForDayProfit(
        marketData,
        latestNet,
        previousNet,
      );
      const dayProfit = getDayProfit(
        price,
        holding.shares,
        dayRate,
        previousPrice,
      );

      return {
        ...holding,
        name: expansion.SHORTNAME || detailInfo.SHORTNAME || holding.code,
        type: detailInfo.FTYPE || '',
        price,
        source: marketData.source,
        updateTime: marketData.updateTime,
        dayRate,
        dayProfit,
        costAmount,
        marketValue,
        profit,
        profitRate,
        isEstimate: marketData.isEstimate,
      };
    }),
  );
}

function renderPortfolioPage(rows, user) {
  const totalCost = rows.reduce((sum, row) => sum + row.costAmount, 0);
  const totalValue = rows.reduce((sum, row) => sum + row.marketValue, 0);
  const totalProfit = totalValue - totalCost;
  const totalProfitRate = totalCost ? (totalProfit / totalCost) * 100 : 0;
  const totalDayProfit = rows.reduce((sum, row) => sum + row.dayProfit, 0);
  const rowHtml = rows
    .map((row) => {
      const up = row.profit >= 0;
      const dayUp = row.dayRate >= 0;
      return `<tr>
        <td data-label="代码"><a href="/valuation?FCODE=${escapeHtml(row.code)}">${escapeHtml(row.code)}</a></td>
        <td data-label="基金">
          <strong>${escapeHtml(row.name)}</strong>
          <span>${escapeHtml(row.type)}</span>
        </td>
        <td data-label="成本价">${formatPrice(row.costPrice)}</td>
        <td data-label="份额">${formatNumber(row.shares, 2)}</td>
        <td data-label="当前价">${formatPrice(row.price)}</td>
        <td data-label="数据源"><span class="tag ${row.isEstimate ? 'live' : ''}">${escapeHtml(row.source)}</span></td>
        <td data-label="日涨幅" class="${dayUp ? 'up' : 'down'}">${formatPercent(row.dayRate)}</td>
        <td data-label="当日收益" class="${row.dayProfit >= 0 ? 'up' : 'down'}">${formatNumber(row.dayProfit, 2)}</td>
        <td data-label="成本">${formatNumber(row.costAmount, 2)}</td>
        <td data-label="市值">${formatNumber(row.marketValue, 2)}</td>
        <td data-label="浮盈亏" class="${up ? 'up' : 'down'}">${formatNumber(row.profit, 2)}</td>
        <td data-label="收益率" class="${up ? 'up' : 'down'}">${formatPercent(row.profitRate)}</td>
        <td data-label="数据时间">${escapeHtml(row.updateTime)}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta http-equiv="refresh" content="60">
    ${renderIconLinks()}
    <title>持仓总览</title>
    <style>
      ${renderSharedStyles()}
      * { box-sizing: border-box; }
      header { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; margin-bottom: 24px; }
      h1 { margin: 0 0 8px; font-size: 34px; line-height: 1.15; }
      p { margin: 0; color: var(--muted); font-size: 16px; font-weight: 600; }
      a { color: var(--teal); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
      .back, button { min-height: 40px; padding: 9px 14px; border: 1px solid var(--brand); border-radius: 8px; color: #fff; background: var(--brand); font: inherit; font-weight: 700; cursor: pointer; }
      .back.secondary { color: var(--brand); background: #fff; }
      button.danger { border-color: #fee2e2; color: #b91c1c; background: #fef2f2; }
      input { width: 96px; padding: 8px 9px; border: 1px solid #cbd5e1; border-radius: 8px; color: var(--text); background: #fff; font: inherit; text-align: right; }
      input:focus { outline: 2px solid #bfdbfe; border-color: #93c5fd; }
      input.is-saving { border-color: #93c5fd; background: #eff6ff; }
      input.is-saved { border-color: #86efac; background: #f0fdf4; }
      .summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 16px; margin-bottom: 20px; }
      .metric, .table-wrap { border: 1px solid rgba(215, 224, 236, 0.95); border-radius: 8px; background: #fff; box-shadow: var(--shadow-md); }
      .metric { position: relative; overflow: hidden; min-height: 116px; padding: 20px; background: linear-gradient(180deg, #fff 0%, #fbfdff 100%); }
      .metric::before { content: ""; position: absolute; inset: 0 0 auto; height: 3px; background: linear-gradient(90deg, #1677ff, #14b8a6); opacity: 0.72; }
      .metric span { display: block; color: var(--muted); font-size: 13px; font-weight: 750; }
      .metric strong { display: block; margin-top: 10px; font-size: 28px; line-height: 1.15; letter-spacing: 0; }
      .table-wrap { overflow-x: auto; background: linear-gradient(180deg, #fff, #fbfdff); }
      table { width: 100%; min-width: 1240px; border-collapse: collapse; }
      th, td { padding: 15px 16px; border-bottom: 1px solid var(--line-soft); text-align: right; white-space: nowrap; }
      th { color: #475569; font-size: 13px; font-weight: 800; background: #f8fafc; }
      th:first-child, th:nth-child(2), td:first-child, td:nth-child(2) { text-align: left; }
      tbody tr { transition: background 0.16s ease; }
      tbody tr:hover { background: #f8fbff; }
      td strong { display: block; font-size: 14px; font-weight: 800; }
      td span { display: block; margin-top: 4px; color: var(--muted); font-size: 12px; }
      .up { color: var(--red); }
      .down { color: var(--green); }
      .tag { display: inline-block; margin: 0; padding: 5px 8px; border-radius: 8px; color: #475569; background: #e8eef6; font-size: 12px; font-weight: 700; }
      .tag.live { color: #0f766e; background: #ccfbf1; }
      @media (max-width: 860px) {
        header { display: block; }
        .actions { justify-content: flex-start; margin-top: 14px; }
        .back { display: inline-block; }
        .summary { grid-template-columns: 1fr 1fr; }
      }
      @media (max-width: 560px) {
        main { padding: 18px max(12px, env(safe-area-inset-right)) 28px max(12px, env(safe-area-inset-left)); }
        header { margin-bottom: 16px; }
        h1 { font-size: 26px; line-height: 1.15; }
        p { font-size: 13px; line-height: 1.55; }
        .back { min-height: 40px; padding: 9px 14px; }
        .actions { gap: 6px; }
        .summary { grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
        .metric { min-height: auto; padding: 12px; }
        .metric span { font-size: 12px; }
        .metric strong { margin-top: 4px; font-size: 20px; line-height: 1.15; }
        .metric:last-child { grid-column: 1 / -1; }
        .table-wrap { overflow: visible; border: 0; background: transparent; box-shadow: none; }
        table { min-width: 0; border-collapse: separate; border-spacing: 0; }
        thead { display: none; }
        tbody { display: grid; gap: 10px; }
        tr { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid #dbe3ee; border-radius: 8px; background: #fff; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04); overflow: hidden; }
        td { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 12px; border-bottom: 1px solid #edf2f7; text-align: right; white-space: normal; font-size: 14px; }
        td input { width: 116px; }
        td::before { content: attr(data-label); flex: 0 0 auto; color: #64748b; font-size: 12px; font-weight: 500; }
        td:first-child, td:nth-child(2), td:nth-child(13) { grid-column: 1 / -1; }
        td:first-child { padding-top: 12px; }
        td:nth-child(2) { display: block; text-align: left; }
        td:nth-child(2)::before { display: none; }
        td:nth-child(2) strong { font-size: 16px; line-height: 1.3; white-space: normal; }
        td:nth-child(2) span { white-space: normal; }
        td a { font-size: 16px; font-weight: 700; }
        .tag { padding: 3px 7px; }
      }
    </style>
  </head>
  <body class="app-page">
    <main>
      ${renderAppNav('funds', user)}
      <section class="summary">
        <div class="metric"><span>持仓成本</span><strong>${formatNumber(totalCost, 2)}</strong></div>
        <div class="metric"><span>当前市值</span><strong>${formatNumber(totalValue, 2)}</strong></div>
        <div class="metric"><span>当日收益</span><strong class="${totalDayProfit >= 0 ? 'up' : 'down'}">${formatNumber(totalDayProfit, 2)}</strong></div>
        <div class="metric"><span>收益率</span><strong class="${totalProfit >= 0 ? 'up' : 'down'}">${formatPercent(totalProfitRate)}</strong></div>
        <div class="metric"><span>浮盈亏</span><strong class="${totalProfit >= 0 ? 'up' : 'down'}">${formatNumber(totalProfit, 2)}</strong></div>
      </section>
      <section class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>代码</th>
              <th>基金</th>
              <th>成本价</th>
              <th>份额</th>
              <th>当前价</th>
              <th>数据源</th>
              <th>日涨幅</th>
              <th>当日收益</th>
              <th>成本</th>
              <th>市值</th>
              <th>浮盈亏</th>
              <th>收益率</th>
              <th>数据时间</th>
            </tr>
          </thead>
          <tbody>${rowHtml}</tbody>
        </table>
      </section>
    </main>
    <script>
      setInterval(() => {
        const active = document.activeElement;
        if (!active || !['INPUT', 'BUTTON', 'TEXTAREA', 'SELECT'].includes(active.tagName)) {
          window.location.reload();
        }
      }, 60000);
    </script>
  </body>
</html>`;
}

function renderPortfolioConfigPage(rows, user) {
  const rowHtml = rows
    .map(
      (row) => `<tr>
        <td data-label="基金代码"><a href="/valuation?FCODE=${escapeHtml(row.code)}">${escapeHtml(row.code)}</a></td>
        <td data-label="基金名称"><strong>${escapeHtml(row.name)}</strong><span>${escapeHtml(row.type)}</span></td>
        <td data-label="成本价"><input class="holding-input" form="holding-${escapeHtml(row.code)}" name="costPrice" value="${formatPrice(row.costPrice)}" inputmode="decimal" aria-label="${escapeHtml(row.code)} 成本价"></td>
        <td data-label="份额"><input class="holding-input" form="holding-${escapeHtml(row.code)}" name="shares" value="${formatNumber(row.shares, 2).replaceAll(',', '')}" inputmode="decimal" aria-label="${escapeHtml(row.code)} 份额"></td>
        <td data-label="操作">
          <form id="holding-${escapeHtml(row.code)}" action="/portfolio/holdings/update" method="post" class="auto-save-form">
            <input type="hidden" name="code" value="${escapeHtml(row.code)}">
          </form>
          <form action="/portfolio/holdings/delete" method="post" class="row-actions">
            <input type="hidden" name="code" value="${escapeHtml(row.code)}">
            <button class="danger icon-button" type="submit" title="删除" aria-label="删除 ${escapeHtml(row.name)}">❌</button>
          </form>
        </td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    ${renderIconLinks()}
    <title>持仓配置</title>
    <style>
      ${renderSharedStyles()}
      h1 { margin: 0 0 8px; font-size: 34px; line-height: 1.15; }
      p { margin: 0 0 20px; color: var(--muted); font-weight: 600; }
      button { min-height: 40px; padding: 9px 14px; border: 1px solid var(--brand); border-radius: 8px; color: #fff; background: var(--brand); font: inherit; font-weight: 700; cursor: pointer; }
      button.danger { border-color: #fee2e2; color: #b91c1c; background: #fef2f2; }
      input { width: 128px; padding: 8px 9px; border: 1px solid #cbd5e1; border-radius: 8px; color: var(--text); background: #fff; font: inherit; text-align: right; }
      input:focus { outline: 2px solid #bfdbfe; border-color: #93c5fd; }
      input.is-saving { border-color: #93c5fd; background: #eff6ff; }
      input.is-saved { border-color: #86efac; background: #f0fdf4; }
      .panel { border: 1px solid rgba(215, 224, 236, 0.95); border-radius: 8px; background: linear-gradient(180deg, #fff, #fbfdff); box-shadow: var(--shadow-md); }
      .add-form { display: grid; grid-template-columns: minmax(150px, 0.9fr) minmax(140px, 0.8fr) minmax(140px, 0.8fr) auto; align-items: end; gap: 12px; margin-bottom: 20px; padding: 16px; }
      .add-form label { display: grid; gap: 7px; color: var(--muted); font-size: 12px; font-weight: 750; }
      .add-form input { text-align: left; }
      .table-wrap { overflow-x: auto; }
      table { width: 100%; min-width: 900px; border-collapse: collapse; }
      th, td { padding: 15px 16px; border-bottom: 1px solid var(--line-soft); text-align: right; white-space: nowrap; }
      th { color: #475569; font-size: 13px; font-weight: 800; background: #f8fafc; }
      th:first-child, th:nth-child(2), td:first-child, td:nth-child(2) { text-align: left; }
      tbody tr { transition: background 0.16s ease; }
      tbody tr:hover { background: #f8fbff; }
      td strong { display: block; font-size: 14px; font-weight: 800; }
      td span { display: block; margin-top: 4px; color: var(--muted); font-size: 12px; }
      .auto-save-form { display: none; }
      .row-actions { display: inline-flex; margin-left: 6px; }
      .icon-button { width: 34px; min-height: 34px; padding: 0; line-height: 1; }
      @media (max-width: 560px) {
        .add-form { display: grid; grid-template-columns: 1fr; gap: 8px; padding: 14px; }
        .add-form input, .add-form button { width: 100%; }
        .table-wrap { overflow: visible; border: 0; background: transparent; box-shadow: none; }
        table { min-width: 0; border-collapse: separate; border-spacing: 0; }
        thead { display: none; }
        tbody { display: grid; gap: 10px; }
        tr { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--line); border-radius: 8px; background: #fff; overflow: hidden; }
        td { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--line-soft); text-align: right; white-space: normal; }
        td::before { content: attr(data-label); flex: 0 0 auto; color: var(--muted); font-size: 12px; font-weight: 700; }
        td:first-child, td:last-child { grid-column: 1 / -1; }
        td:last-child { justify-content: flex-end; border-bottom: 0; }
        td input { width: 116px; }
      }
    </style>
  </head>
  <body class="app-page">
    <main>
      ${renderAppNav('config', user)}
      <form class="panel add-form" action="/portfolio/holdings/add" method="post">
        <label>基金代码<input name="code" inputmode="numeric" placeholder="720003" required></label>
        <label>成本价<input name="costPrice" inputmode="decimal" placeholder="2.1947" required></label>
        <label>份额<input name="shares" inputmode="decimal" placeholder="455.65" required></label>
        <button type="submit">添加基金</button>
      </form>
      <section class="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>基金代码</th>
              <th>基金名称</th>
              <th>成本价</th>
              <th>份额</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>${rowHtml || '<tr><td colspan="5">暂无基金配置</td></tr>'}</tbody>
        </table>
      </section>
    </main>
    <script>
      async function saveHoldingInput(input) {
        const form = input.form;
        if (!form || !input.value || Number(input.value) <= 0) {
          return;
        }

        const controls = Array.from(document.querySelectorAll('[form="' + form.id + '"]'));
        controls.forEach((control) => {
          control.classList.remove('is-saved');
          control.classList.add('is-saving');
        });

        try {
          const response = await fetch(form.action, {
            method: 'POST',
            body: new URLSearchParams(new FormData(form)),
          });

          if (!response.ok) {
            throw new Error('保存失败');
          }

          controls.forEach((control) => {
            control.classList.remove('is-saving');
            control.classList.add('is-saved');
            control.defaultValue = control.value;
          });
          window.setTimeout(() => {
            controls.forEach((control) => control.classList.remove('is-saved'));
          }, 900);
        } catch (error) {
          controls.forEach((control) => control.classList.remove('is-saving'));
        }
      }

      document.querySelectorAll('.holding-input').forEach((input) => {
        input.addEventListener('change', () => saveHoldingInput(input));
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            input.blur();
          }
        });
      });
    </script>
  </body>
</html>`;
}

function getPortfolioSummary(rows) {
  const totalCost = rows.reduce((sum, row) => sum + row.costAmount, 0);
  const totalValue = rows.reduce((sum, row) => sum + row.marketValue, 0);
  const totalProfit = totalValue - totalCost;
  const totalProfitRate = totalCost ? (totalProfit / totalCost) * 100 : 0;
  const totalDayProfit = rows.reduce((sum, row) => sum + row.dayProfit, 0);

  return {
    totalCost,
    totalValue,
    totalProfit,
    totalProfitRate,
    totalDayProfit,
  };
}

function getSnapshotType(snapshot = {}) {
  return snapshot.type || 'netValue';
}

function getSnapshotLabel(type) {
  const schedule = snapshotSchedules.find((item) => item.type === type);
  return schedule ? schedule.label : '真实净值';
}

function compareSnapshots(a, b) {
  const dateCompare = String(a.date).localeCompare(String(b.date));

  if (dateCompare !== 0) {
    return dateCompare;
  }

  const aIndex = snapshotSchedules.findIndex(
    (item) => item.type === getSnapshotType(a),
  );
  const bIndex = snapshotSchedules.findIndex(
    (item) => item.type === getSnapshotType(b),
  );

  return Math.max(aIndex, 0) - Math.max(bIndex, 0);
}

async function savePortfolioSnapshot(
  { valuationApi, historyApi, detailApi },
  { type = 'netValue', label = getSnapshotLabel(type), date } = {},
) {
  const marketMode = type === 'estimate' ? 'estimate' : 'netValue';
  const rows = await getPortfolioRows(
    { valuationApi, historyApi, detailApi },
    { marketMode },
  );
  const summary = getPortfolioSummary(rows);
  const snapshotDate = date || formatShanghaiDate();
  const snapshot = {
    date: snapshotDate,
    type,
    label,
    savedAt: formatShanghaiDateTime(),
    ...summary,
    holdings: rows.map((row) => ({
      code: row.code,
      name: row.name,
      costPrice: row.costPrice,
      shares: row.shares,
      price: row.price,
      marketValue: row.marketValue,
      profit: row.profit,
      profitRate: row.profitRate,
      dayProfit: row.dayProfit,
      dayRate: row.dayRate,
      source: row.source,
      updateTime: row.updateTime,
    })),
  };
  const snapshots = readSnapshots().filter(
    (item) =>
      item.date !== snapshotDate ||
      getSnapshotType(item) !== getSnapshotType(snapshot),
  );
  snapshots.push(snapshot);
  snapshots.sort(compareSnapshots);
  writeSnapshots(snapshots);
  return snapshot;
}

function renderHistoryChart(snapshots, key, color, label) {
  if (!snapshots.length) {
    return '<div class="empty">暂无快照数据</div>';
  }

  const width = 760;
  const height = 240;
  const padding = 30;
  const values = snapshots.map((item) => toNumber(item[key]));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 0.01);
  const coords = values
    .map((value, index) => {
      const x =
        padding +
        (index / Math.max(values.length - 1, 1)) * (width - padding * 2);
      const y = padding + ((max - value) / span) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const latest = snapshots[snapshots.length - 1];

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)}趋势">
    <text x="${padding}" y="20" fill="#64748b" font-size="13">${escapeHtml(label)} · ${escapeHtml(latest.date)} ${escapeHtml(latest.label || getSnapshotLabel(getSnapshotType(latest)))} · ${formatNumber(latest[key], 2)}</text>
    <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#e2e8f0" />
    <polyline fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${coords}" />
  </svg>`;
}

function renderHistoryPage(user) {
  const snapshots = readSnapshots().slice().sort(compareSnapshots);
  const rows = snapshots
    .slice()
    .reverse()
    .map(
      (snapshot) => `<tr>
        <td>${escapeHtml(snapshot.date)}</td>
        <td>${escapeHtml(snapshot.label || getSnapshotLabel(getSnapshotType(snapshot)))}</td>
        <td>${escapeHtml(snapshot.savedAt)}</td>
        <td>${formatNumber(snapshot.totalCost, 2)}</td>
        <td>${formatNumber(snapshot.totalValue, 2)}</td>
        <td class="${snapshot.totalProfit >= 0 ? 'up' : 'down'}">${formatNumber(snapshot.totalProfit, 2)}</td>
        <td class="${snapshot.totalProfit >= 0 ? 'up' : 'down'}">${formatPercent(snapshot.totalProfitRate)}</td>
        <td class="${snapshot.totalDayProfit >= 0 ? 'up' : 'down'}">${formatNumber(snapshot.totalDayProfit, 2)}</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    ${renderIconLinks()}
    <title>收益走势</title>
    <style>
      ${renderSharedStyles()}
      * { box-sizing: border-box; }
      header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 20px; }
      h1 { margin: 0 0 8px; font-size: 34px; line-height: 1.15; }
      p { margin: 0; color: var(--muted); font-weight: 600; }
      a { color: var(--teal); text-decoration: none; }
      .back { display: inline-block; padding: 9px 14px; border: 1px solid var(--brand); border-radius: 8px; color: #fff; background: var(--brand); }
      .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
      .panel { border: 1px solid rgba(215, 224, 236, 0.95); border-radius: 8px; background: linear-gradient(180deg, #fff, #fbfdff); box-shadow: var(--shadow-md); }
      .chart { padding: 16px; }
      .chart svg { display: block; width: 100%; height: auto; }
      .empty { padding: 18px; color: var(--muted); }
      .table-wrap { overflow-x: auto; }
      table { width: 100%; min-width: 860px; border-collapse: collapse; }
      th, td { padding: 15px 16px; border-bottom: 1px solid var(--line-soft); text-align: right; white-space: nowrap; }
      th:first-child, th:nth-child(2), td:first-child, td:nth-child(2) { text-align: left; }
      th { color: #475569; font-size: 13px; font-weight: 800; background: #f8fafc; }
      .up { color: var(--red); }
      .down { color: var(--green); }
      @media (max-width: 760px) {
        main { padding: 18px 12px 28px; }
        header { display: block; }
        .back { margin-top: 14px; }
        .charts { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body class="app-page">
    <main>
      ${renderAppNav('trend', user)}
      <section class="charts">
        <div class="panel chart">${renderHistoryChart(snapshots, 'totalValue', '#0f766e', '当前市值')}</div>
        <div class="panel chart">${renderHistoryChart(snapshots, 'totalProfit', '#dc2626', '浮盈亏')}</div>
      </section>
      <section class="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th>类型</th>
              <th>保存时间</th>
              <th>成本</th>
              <th>市值</th>
              <th>浮盈亏</th>
              <th>收益率</th>
              <th>当日收益</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="8">暂无快照数据</td></tr>'}</tbody>
        </table>
      </section>
    </main>
  </body>
</html>`;
}

function scheduleNextSnapshot(apis) {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  const event = getNextSnapshotEvent();

  if (!event) {
    log('⚠️ 未找到可用的自动快照时间');
    return;
  }

  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(async () => {
    try {
      await savePortfolioSnapshot(apis, {
        type: event.type,
        label: event.label,
        date: event.date,
      });
      log(`✅ 已保存${event.date} ${event.label}基金组合快照`);
    } catch (error) {
      log(`❌ 保存${event.label}基金组合快照失败：${error.message}`);
    } finally {
      scheduleNextSnapshot(apis);
    }
  }, Math.max(event.runAt.getTime() - Date.now(), 0));
  snapshotTimer.unref();
  log(
    `⏱️ 下次自动快照：${event.date} ${event.time} ${event.label}`,
  );
}

function startServe() {
  return new Promise((resolve) => {
    const app = new koa();

    const router = new Router();
    const modules = getModules();
    const valuationApi = require('./module/fundVarietieValuationDetail');
    const historyApi = require('./module/fundMNHisNetList');
    const detailApi = require('./module/fundMNDetailInformation');

    Object.entries(iconFiles).forEach(([routePath, fileName]) => {
      router.get(routePath, (ctx) => {
        ctx.type = 'image/png';
        ctx.body = fs.createReadStream(path.join(iconDir, fileName));
      });
    });

    router.get('/site.webmanifest', (ctx) => {
      ctx.type = 'application/manifest+json';
      ctx.body = JSON.stringify({
        name: 'Fund Desk',
        short_name: '持仓总览',
        start_url: '/portfolio',
        display: 'standalone',
        background_color: '#f3f6fb',
        theme_color: '#0b1220',
        icons: [
          {
            src: '/app-icon.png',
            sizes: '128x128',
            type: 'image/png',
          },
          {
            src: '/apple-touch-icon.png',
            sizes: '180x180',
            type: 'image/png',
          },
        ],
      });
    });

    router.get('/login', (ctx) => {
      const session = readSession(ctx);
      if (session) {
        redirect(ctx);
        return;
      }

      ctx.type = 'html';
      ctx.body = renderLoginPage({
        next: ctx.request.query.next || '/portfolio',
      });
    });

    router.post('/login', async (ctx) => {
      const body = await readPostBody(ctx);
      const settings = readSettings();
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const next = String(body.next || '/portfolio');

      if (
        username === settings.username &&
        verifyPassword(password, settings)
      ) {
        setSession(ctx, username);
        redirect(ctx, next.startsWith('/') ? next : '/portfolio');
        return;
      }

      ctx.status = 401;
      ctx.type = 'html';
      ctx.body = renderLoginPage({
        error: '用户名或密码错误',
        next,
      });
    });

    router.post('/logout', (ctx) => {
      clearSession(ctx);
      redirect(ctx, '/login');
    });

    router.get('/', (ctx) => {
      redirect(ctx, '/portfolio');
    });

    router.get('/valuation', async (ctx) => {
      const fcode = ctx.request.query.FCODE || '470007';
      let data = null;
      let history = null;
      let detail = null;
      let error = '';

      const [valuationResult, historyResult, detailResult] =
        await Promise.allSettled([
          valuationApi({ FCODE: fcode }),
          historyApi({ FCODE: fcode, pageIndex: 1, pagesize: 2 }),
          detailApi({ FCODE: fcode }),
        ]);

      if (valuationResult.status === 'fulfilled') {
        data = valuationResult.value;
      } else {
        error =
          valuationResult.reason && valuationResult.reason.message
            ? valuationResult.reason.message
            : '估算数据获取失败';
      }

      if (historyResult.status === 'fulfilled') {
        history = historyResult.value;
      }

      if (detailResult.status === 'fulfilled') {
        detail = detailResult.value;
      }

      ctx.type = 'html';
      ctx.body = renderValuationPage({
        fcode,
        data,
        history,
        detail,
        error,
        user: readSession(ctx),
      });
    });

    router.get('/portfolio', async (ctx) => {
      const rows = await getPortfolioRows({
        valuationApi,
        historyApi,
        detailApi,
      });

      ctx.type = 'html';
      ctx.body = renderPortfolioPage(rows, readSession(ctx));
    });

    router.get('/portfolio/config', (ctx) => {
      redirect(ctx, '/config');
    });

    router.get('/config', async (ctx) => {
      const rows = await getPortfolioRows({
        valuationApi,
        historyApi,
        detailApi,
      });

      ctx.type = 'html';
      ctx.body = renderPortfolioConfigPage(rows, readSession(ctx));
    });

    router.get('/portfolio/history', (ctx) => {
      redirect(ctx, '/history');
    });

    router.get('/history', (ctx) => {
      ctx.type = 'html';
      ctx.body = renderHistoryPage(readSession(ctx));
    });

    router.get('/settings', (ctx) => {
      ctx.type = 'html';
      ctx.body = renderSettingsPage({ user: readSession(ctx) });
    });

    router.post('/settings', async (ctx) => {
      const body = await readPostBody(ctx);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const confirmPassword = String(body.confirmPassword || '');

      if (!username) {
        ctx.status = 400;
        ctx.type = 'html';
        ctx.body = renderSettingsPage({
          user: readSession(ctx),
          error: '用户名不能为空',
        });
        return;
      }

      if (password && password !== confirmPassword) {
        ctx.status = 400;
        ctx.type = 'html';
        ctx.body = renderSettingsPage({
          user: readSession(ctx),
          error: '两次输入的新密码不一致',
        });
        return;
      }

      const settings = readSettings();
      const nextSettings = {
        ...settings,
        username,
      };

      if (password) {
        nextSettings.passwordSalt = crypto.randomBytes(16).toString('hex');
        nextSettings.passwordHash = hashPassword(
          password,
          nextSettings.passwordSalt,
        );
      }

      writeSettings(nextSettings);
      setSession(ctx, username);
      ctx.type = 'html';
      ctx.body = renderSettingsPage({
        user: { username },
        success: '设置已保存',
      });
    });

    router.post('/portfolio/holdings/add', async (ctx) => {
      const body = await readPostBody(ctx);
      const next = normalizeHolding(body);
      const holdings = readPortfolioHoldings().filter(
        (holding) => holding.code !== next.code,
      );

      if (next.code && next.costPrice > 0 && next.shares > 0) {
        holdings.push(next);
        writePortfolioHoldings(holdings);
      }

      redirect(ctx, '/config');
    });

    router.post('/portfolio/holdings/update', async (ctx) => {
      const body = await readPostBody(ctx);
      const next = normalizeHolding(body);
      const holdings = readPortfolioHoldings().map((holding) =>
        holding.code === next.code
          ? {
              ...holding,
              costPrice:
                next.costPrice > 0 ? next.costPrice : holding.costPrice,
              shares: next.shares > 0 ? next.shares : holding.shares,
            }
          : holding,
      );

      writePortfolioHoldings(holdings);
      redirect(ctx, '/config');
    });

    router.post('/portfolio/holdings/delete', async (ctx) => {
      const body = await readPostBody(ctx);
      const code = String(body.code || '').trim();
      writePortfolioHoldings(
        readPortfolioHoldings().filter((holding) => holding.code !== code),
      );
      redirect(ctx, '/config');
    });

    app.use(async (ctx, next) => {
      if (isPublicPath(ctx.path)) {
        await next();
        return;
      }

      if (readSession(ctx)) {
        await next();
        return;
      }

      redirect(ctx, `/login?next=${encodeURIComponent(ctx.originalUrl)}`);
    });

    modules.forEach(({ fileName, path }) => {
      const routerPath = `/${fileName}`;
      const api = require(path);

      app[fileName] = api;

      log(`✅ 生成路由 ${routerPath}`);

      router.get(routerPath, async (ctx, next) => {
        ctx.status = 200;
        ctx.body = await api(ctx.request.query, ctx);
        next();
      });
    });

    app.use(router.routes()).use(router.allowedMethods());

    const snapshotApis = { valuationApi, historyApi, detailApi };
    scheduleNextSnapshot(snapshotApis);

    const server = app.listen(3000, () => {
      log('🚀 server is running at port 3000');
      resolve(server);
    });
    server.on('close', () => {
      clearTimeout(snapshotTimer);
    });
  });
}

module.exports = {
  startServe,
};
