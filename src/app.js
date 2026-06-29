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

function getNextSnapshotDelay() {
  const now = new Date();
  const shanghai = new Date(
    now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }),
  );
  const next = new Date(shanghai);
  next.setHours(23, 0, 0, 0);
  if (next <= shanghai) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - shanghai.getTime();
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

function getDayProfit(price, shares, dayRate) {
  const rate = toNumber(dayRate) / 100;

  if (!price || rate === -1) {
    return 0;
  }

  return shares * (price - price / (1 + rate));
}

function getEstimateDate(expansion) {
  return expansion && expansion.GZTIME
    ? String(expansion.GZTIME).slice(0, 10)
    : '';
}

function getMarketData(expansion = {}, latestNet = {}) {
  const hasEstimate = Boolean(expansion.GZ);
  const hasLatestNet = Boolean(latestNet.DWJZ);
  const estimateDate = getEstimateDate(expansion);
  const latestNetDate = latestNet.FSRQ || '';
  const useLatestNet =
    hasLatestNet &&
    (!hasEstimate || !estimateDate || latestNetDate >= estimateDate);

  if (useLatestNet) {
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
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f6f8fb; -webkit-text-size-adjust: 100%; }
      a { color: #0f766e; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .app-shell { max-width: 1280px; margin: 0 auto; padding: 22px max(20px, env(safe-area-inset-right)) 48px max(20px, env(safe-area-inset-left)); }
      .app-nav { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 22px; padding: 10px; border: 1px solid #dbe3ee; border-radius: 8px; background: #fff; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04); }
      .app-nav-links { display: flex; flex-wrap: wrap; gap: 8px; }
      .app-nav a, .logout-button { display: inline-flex; min-height: 38px; align-items: center; justify-content: center; padding: 8px 12px; border: 1px solid transparent; border-radius: 6px; color: #475569; background: transparent; font: inherit; text-decoration: none; cursor: pointer; }
      .app-nav a.active { border-color: #99f6e4; color: #0f766e; background: #ccfbf1; font-weight: 700; }
      .app-user { display: flex; align-items: center; gap: 8px; color: #64748b; white-space: nowrap; }
      .app-user form { margin: 0; }
      .logout-button { border-color: #dbe3ee; background: #fff; }
      @media (max-width: 640px) {
        .app-shell { padding: 14px max(12px, env(safe-area-inset-right)) 28px max(12px, env(safe-area-inset-left)); }
        .app-nav { display: block; }
        .app-nav-links { display: grid; grid-template-columns: 1fr 1fr; }
        .app-nav-links a:first-child { grid-column: 1 / -1; }
        .app-user { margin-top: 8px; justify-content: space-between; }
      }`;
}

function renderAppNav(active, user) {
  const links = [
    ['funds', '/portfolio', '我的基金'],
    ['trend', '/portfolio/history', '基金趋势'],
    ['settings', '/settings', '系统设置'],
  ]
    .map(
      ([key, href, label]) =>
        `<a class="${active === key ? 'active' : ''}" href="${href}">${label}</a>`,
    )
    .join('');

  return `<nav class="app-nav">
      <div class="app-nav-links">${links}</div>
      <div class="app-user">
        <span>${escapeHtml((user && user.username) || '')}</span>
        <form action="/logout" method="post"><button class="logout-button" type="submit">退出</button></form>
      </div>
    </nav>`;
}

function renderHomePage(user) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${renderIconLinks()}
    <title>Fund Monitor</title>
    <style>
      ${renderSharedStyles()}
      h1 { margin: 0 0 8px; font-size: 32px; }
      p { margin: 0; color: #64748b; line-height: 1.6; }
      .modules { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 22px; }
      .module { display: block; min-height: 128px; padding: 18px; border: 1px solid #dbe3ee; border-radius: 8px; color: #172033; background: #fff; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04); }
      .module:hover { text-decoration: none; border-color: #99f6e4; }
      .module strong { display: block; margin-bottom: 8px; font-size: 20px; }
      .module span { color: #64748b; line-height: 1.5; }
      @media (max-width: 760px) { .modules { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main class="app-shell">
      ${renderAppNav('', user)}
      <h1>Fund Monitor</h1>
      <p>基金持仓管理、趋势快照和系统配置。</p>
      <section class="modules">
        <a class="module" href="/portfolio"><strong>我的基金</strong><span>维护持仓成本和份额，查看实时估算、市值、收益和每日盈亏。</span></a>
        <a class="module" href="/portfolio/history"><strong>基金趋势</strong><span>查看每天 23:00 保存的组合快照和收益走势。</span></a>
        <a class="module" href="/settings"><strong>系统设置</strong><span>配置登录用户名和密码。</span></a>
      </section>
    </main>
  </body>
</html>`;
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
    <title>系统设置</title>
    <style>
      ${renderSharedStyles()}
      h1 { margin: 0 0 8px; font-size: 30px; }
      p { margin: 0 0 20px; color: #64748b; }
      .panel { max-width: 560px; padding: 18px; border: 1px solid #dbe3ee; border-radius: 8px; background: #fff; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04); }
      label { display: grid; gap: 6px; margin-bottom: 14px; color: #64748b; font-size: 13px; }
      input { width: 100%; min-height: 42px; padding: 9px 10px; border: 1px solid #cbd5e1; border-radius: 6px; color: #172033; font: inherit; }
      button { min-height: 42px; padding: 9px 14px; border: 1px solid #0f766e; border-radius: 6px; color: #fff; background: #0f766e; font: inherit; cursor: pointer; }
      .message { margin: 0 0 14px; padding: 10px 12px; border-radius: 6px; }
      .error { color: #b91c1c; background: #fef2f2; }
      .success { color: #0f766e; background: #ccfbf1; }
    </style>
  </head>
  <body>
    <main class="app-shell">
      ${renderAppNav('settings', user)}
      <h1>系统设置</h1>
      <p>修改登录用户名和密码。新密码留空时只更新用户名。</p>
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
  const dayProfit = holding
    ? getDayProfit(toNumber(displayPrice), holding.shares, displayRate)
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
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f6f8fb; }
      main { max-width: 1040px; margin: 0 auto; padding: 32px 20px 48px; }
      header { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
      h1 { margin: 0; font-size: 30px; }
      .sub { margin: 8px 0 0; color: #64748b; }
      form { display: flex; gap: 8px; }
      input { width: 128px; padding: 9px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font: inherit; }
      button, .back { padding: 9px 12px; border: 1px solid #0f766e; border-radius: 6px; color: #fff; background: #0f766e; font: inherit; text-decoration: none; cursor: pointer; }
      .layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 20px; align-items: start; }
      .panel { border: 1px solid #dbe3ee; border-radius: 8px; background: #fff; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04); }
      .chart { padding: 18px; }
      .chart svg { display: block; width: 100%; height: auto; }
      .latest { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; padding: 16px 18px; border-top: 1px solid #e5e7eb; }
      .metric span { display: block; color: #64748b; font-size: 13px; }
      .metric strong { display: block; margin-top: 4px; font-size: 22px; }
      .up { color: #dc2626; }
      .down { color: #16a34a; }
      table { width: 100%; border-collapse: collapse; }
      th, td { padding: 12px 14px; border-bottom: 1px solid #edf2f7; text-align: left; }
      th { width: 96px; color: #64748b; font-weight: 500; }
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
  <body>
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

async function getPortfolioRows({ valuationApi, historyApi, detailApi }) {
  const holdings = readPortfolioHoldings();

  return Promise.all(
    holdings.map(async (holding) => {
      const [valuation, history, detail] = await Promise.all([
        valuationApi({ FCODE: holding.code }).catch(() => null),
        historyApi({
          FCODE: holding.code,
          pageIndex: 1,
          pagesize: 1,
        }).catch(() => null),
        detailApi({ FCODE: holding.code }).catch(() => null),
      ]);
      const expansion =
        valuation && valuation.Expansion ? valuation.Expansion : {};
      const latestNet =
        history && Array.isArray(history.Datas) && history.Datas.length
          ? history.Datas[0]
          : {};
      const detailInfo = detail && detail.Datas ? detail.Datas : {};
      const marketData = getMarketData(expansion, latestNet);
      const price = toNumber(marketData.price);
      const costAmount = holding.costPrice * holding.shares;
      const marketValue = price * holding.shares;
      const profit = marketValue - costAmount;
      const profitRate = costAmount ? (profit / costAmount) * 100 : 0;
      const dayRate = toNumber(marketData.rate);
      const dayProfit = getDayProfit(price, holding.shares, dayRate);

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
  const renderedAt = new Date().toLocaleString('zh-CN', {
    hour12: false,
    timeZone: 'Asia/Shanghai',
  });
  const totalCost = rows.reduce((sum, row) => sum + row.costAmount, 0);
  const totalValue = rows.reduce((sum, row) => sum + row.marketValue, 0);
  const totalProfit = totalValue - totalCost;
  const totalProfitRate = totalCost ? (totalProfit / totalCost) * 100 : 0;
  const totalDayProfit = rows.reduce((sum, row) => sum + row.dayProfit, 0);
  const estimateCount = rows.filter((row) => row.isEstimate).length;
  const latestNetCount = rows.filter((row) => row.source === '最新净值').length;
  const dataTimes = rows
    .map((row) => row.updateTime)
    .filter(Boolean)
    .sort();
  const earliestDataTime = dataTimes[0] || '';
  const latestDataTime = dataTimes.at(-1) || '';
  const dataDelayMinutes =
    latestDataTime && earliestDataTime
      ? Math.round(
          (getTimeMs(latestDataTime) - getTimeMs(earliestDataTime)) / 60000,
        )
      : 0;
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
        <td data-label="成本价"><input form="holding-${escapeHtml(row.code)}" name="costPrice" value="${formatPrice(row.costPrice)}" inputmode="decimal" aria-label="${escapeHtml(row.code)} 成本价"></td>
        <td data-label="份额"><input form="holding-${escapeHtml(row.code)}" name="shares" value="${formatNumber(row.shares, 2).replaceAll(',', '')}" inputmode="decimal" aria-label="${escapeHtml(row.code)} 份额"></td>
        <td data-label="当前价">${formatPrice(row.price)}</td>
        <td data-label="数据源"><span class="tag ${row.isEstimate ? 'live' : ''}">${escapeHtml(row.source)}</span></td>
        <td data-label="日涨幅" class="${dayUp ? 'up' : 'down'}">${formatPercent(row.dayRate)}</td>
        <td data-label="当日收益" class="${row.dayProfit >= 0 ? 'up' : 'down'}">${formatNumber(row.dayProfit, 2)}</td>
        <td data-label="成本">${formatNumber(row.costAmount, 2)}</td>
        <td data-label="市值">${formatNumber(row.marketValue, 2)}</td>
        <td data-label="浮盈亏" class="${up ? 'up' : 'down'}">${formatNumber(row.profit, 2)}</td>
        <td data-label="收益率" class="${up ? 'up' : 'down'}">${formatPercent(row.profitRate)}</td>
        <td data-label="数据时间">${escapeHtml(row.updateTime)}</td>
        <td data-label="操作">
          <form id="holding-${escapeHtml(row.code)}" action="/portfolio/holdings/update" method="post" class="row-actions">
            <input type="hidden" name="code" value="${escapeHtml(row.code)}">
            <button type="submit">保存</button>
          </form>
          <form action="/portfolio/holdings/delete" method="post" class="row-actions">
            <input type="hidden" name="code" value="${escapeHtml(row.code)}">
            <button class="danger" type="submit">删除</button>
          </form>
        </td>
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
    <title>我的基金</title>
    <style>
      ${renderSharedStyles()}
      * { box-sizing: border-box; }
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f6f8fb; -webkit-text-size-adjust: 100%; }
      main { max-width: 1280px; margin: 0 auto; padding: 30px max(20px, env(safe-area-inset-right)) 48px max(20px, env(safe-area-inset-left)); }
      header { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; margin-bottom: 22px; }
      h1 { margin: 0 0 8px; font-size: 30px; }
      p { margin: 0; color: #64748b; }
      a { color: #0f766e; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
      .back, button { padding: 9px 12px; border: 1px solid #0f766e; border-radius: 6px; color: #fff; background: #0f766e; font: inherit; cursor: pointer; }
      .back.secondary { color: #0f766e; background: #fff; }
      button.danger { border-color: #dc2626; background: #dc2626; }
      input { width: 92px; padding: 7px 8px; border: 1px solid #cbd5e1; border-radius: 6px; color: #172033; font: inherit; text-align: right; }
      .add-form { display: grid; grid-template-columns: repeat(4, max-content); align-items: end; gap: 10px; margin-bottom: 14px; padding: 14px; border: 1px solid #dbe3ee; border-radius: 8px; background: #fff; }
      .add-form label { display: grid; gap: 5px; color: #64748b; font-size: 12px; }
      .add-form input { width: 132px; text-align: left; }
      .row-actions { display: inline-flex; margin-left: 6px; }
      .row-actions button { padding: 6px 9px; font-size: 12px; }
      .summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 14px; margin-bottom: 18px; }
      .metric, .table-wrap { border: 1px solid #dbe3ee; border-radius: 8px; background: #fff; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04); }
      .metric { padding: 16px; }
      .metric span { display: block; color: #64748b; font-size: 13px; }
      .metric strong { display: block; margin-top: 6px; font-size: 24px; }
      .table-wrap { overflow-x: auto; }
      table { width: 100%; min-width: 1360px; border-collapse: collapse; }
      th, td { padding: 12px 14px; border-bottom: 1px solid #edf2f7; text-align: right; white-space: nowrap; }
      th { color: #64748b; font-size: 13px; font-weight: 600; background: #fbfdff; }
      th:first-child, th:nth-child(2), td:first-child, td:nth-child(2) { text-align: left; }
      td strong { display: block; font-size: 14px; }
      td span { display: block; margin-top: 3px; color: #64748b; font-size: 12px; }
      .up { color: #dc2626; }
      .down { color: #16a34a; }
      .tag { display: inline-block; margin: 0; padding: 4px 7px; border-radius: 999px; color: #475569; background: #e2e8f0; font-size: 12px; }
      .tag.live { color: #0f766e; background: #ccfbf1; }
      @media (max-width: 860px) {
        header { display: block; }
        .actions { justify-content: flex-start; margin-top: 14px; }
        .back { display: inline-block; }
        .add-form { grid-template-columns: 1fr 1fr; }
        .summary { grid-template-columns: 1fr 1fr; }
      }
      @media (max-width: 560px) {
        main { padding: 18px max(12px, env(safe-area-inset-right)) 28px max(12px, env(safe-area-inset-left)); }
        header { margin-bottom: 16px; }
        h1 { font-size: 26px; line-height: 1.15; }
        p { font-size: 13px; line-height: 1.55; }
        .back { min-height: 40px; padding: 9px 14px; }
        .actions { gap: 6px; }
        .add-form { grid-template-columns: 1fr; padding: 12px; }
        .add-form input { width: 100%; }
        .summary { grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
        .metric { padding: 12px; }
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
        td:first-child, td:nth-child(2), td:nth-child(13), td:nth-child(14) { grid-column: 1 / -1; }
        td:first-child { padding-top: 12px; }
        td:nth-child(2) { display: block; text-align: left; }
        td:nth-child(2)::before { display: none; }
        td:nth-child(2) strong { font-size: 16px; line-height: 1.3; white-space: normal; }
        td:nth-child(2) span { white-space: normal; }
        td:nth-child(14) { justify-content: flex-end; border-bottom: 0; }
        td a { font-size: 16px; font-weight: 700; }
        .tag { padding: 3px 7px; }
      }
    </style>
  </head>
  <body>
    <main>
      ${renderAppNav('funds', user)}
      <header>
        <div>
          <h1>我的基金</h1>
          <p>${rows.length} 只基金 · ${estimateCount} 只使用实时估算 · ${latestNetCount} 只回退最新净值 · 数据时间 ${escapeHtml(earliestDataTime || '--')} - ${escapeHtml(latestDataTime || '--')}${dataDelayMinutes > 0 ? ` · 最大延迟约 ${dataDelayMinutes} 分钟` : ''} · 页面刷新 ${escapeHtml(renderedAt)} · 空闲时每 60 秒重新请求</p>
        </div>
        <div class="actions">
          <form action="/portfolio/snapshot" method="post"><button type="submit">保存快照</button></form>
        </div>
      </header>
      <section class="summary">
        <div class="metric"><span>持仓成本</span><strong>${formatNumber(totalCost, 2)}</strong></div>
        <div class="metric"><span>当前市值</span><strong>${formatNumber(totalValue, 2)}</strong></div>
        <div class="metric"><span>当日收益</span><strong class="${totalDayProfit >= 0 ? 'up' : 'down'}">${formatNumber(totalDayProfit, 2)}</strong></div>
        <div class="metric"><span>浮盈亏</span><strong class="${totalProfit >= 0 ? 'up' : 'down'}">${formatNumber(totalProfit, 2)}</strong></div>
        <div class="metric"><span>收益率</span><strong class="${totalProfit >= 0 ? 'up' : 'down'}">${formatPercent(totalProfitRate)}</strong></div>
      </section>
      <form class="add-form" action="/portfolio/holdings/add" method="post">
        <label>基金代码<input name="code" inputmode="numeric" placeholder="720003" required></label>
        <label>成本价<input name="costPrice" inputmode="decimal" placeholder="2.1947" required></label>
        <label>份额<input name="shares" inputmode="decimal" placeholder="455.65" required></label>
        <button type="submit">添加基金</button>
      </form>
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
              <th>操作</th>
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

async function savePortfolioSnapshot({ valuationApi, historyApi, detailApi }) {
  const rows = await getPortfolioRows({ valuationApi, historyApi, detailApi });
  const summary = getPortfolioSummary(rows);
  const date = formatShanghaiDate();
  const snapshot = {
    date,
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
  const snapshots = readSnapshots().filter((item) => item.date !== date);
  snapshots.push(snapshot);
  snapshots.sort((a, b) => String(a.date).localeCompare(String(b.date)));
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
    <text x="${padding}" y="20" fill="#64748b" font-size="13">${escapeHtml(label)} · ${escapeHtml(latest.date)} · ${formatNumber(latest[key], 2)}</text>
    <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#e2e8f0" />
    <polyline fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${coords}" />
  </svg>`;
}

function renderHistoryPage(user) {
  const snapshots = readSnapshots();
  const rows = snapshots
    .slice()
    .reverse()
    .map(
      (snapshot) => `<tr>
        <td>${escapeHtml(snapshot.date)}</td>
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
    <title>基金趋势</title>
    <style>
      ${renderSharedStyles()}
      * { box-sizing: border-box; }
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f6f8fb; }
      main { max-width: 1120px; margin: 0 auto; padding: 30px 20px 48px; }
      header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 20px; }
      h1 { margin: 0 0 8px; font-size: 30px; }
      p { margin: 0; color: #64748b; }
      a { color: #0f766e; text-decoration: none; }
      .back { display: inline-block; padding: 9px 12px; border: 1px solid #0f766e; border-radius: 6px; color: #fff; background: #0f766e; }
      .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 18px; }
      .panel { border: 1px solid #dbe3ee; border-radius: 8px; background: #fff; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04); }
      .chart { padding: 14px; }
      .chart svg { display: block; width: 100%; height: auto; }
      .empty { padding: 18px; color: #64748b; }
      .table-wrap { overflow-x: auto; }
      table { width: 100%; min-width: 860px; border-collapse: collapse; }
      th, td { padding: 12px 14px; border-bottom: 1px solid #edf2f7; text-align: right; white-space: nowrap; }
      th:first-child, th:nth-child(2), td:first-child, td:nth-child(2) { text-align: left; }
      th { color: #64748b; font-size: 13px; font-weight: 600; background: #fbfdff; }
      .up { color: #dc2626; }
      .down { color: #16a34a; }
      @media (max-width: 760px) {
        main { padding: 18px 12px 28px; }
        header { display: block; }
        .back { margin-top: 14px; }
        .charts { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      ${renderAppNav('trend', user)}
      <header>
        <div>
          <h1>基金趋势</h1>
          <p>每天 23:00 自动保存一条快照，也可在组合页手动保存当天快照。</p>
        </div>
      </header>
      <section class="charts">
        <div class="panel chart">${renderHistoryChart(snapshots, 'totalValue', '#0f766e', '当前市值')}</div>
        <div class="panel chart">${renderHistoryChart(snapshots, 'totalProfit', '#dc2626', '浮盈亏')}</div>
      </section>
      <section class="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th>保存时间</th>
              <th>成本</th>
              <th>市值</th>
              <th>浮盈亏</th>
              <th>收益率</th>
              <th>当日收益</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="7">暂无快照数据</td></tr>'}</tbody>
        </table>
      </section>
    </main>
  </body>
</html>`;
}

function scheduleDailySnapshot(apis) {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(async () => {
    try {
      await savePortfolioSnapshot(apis);
      log('✅ 已保存每日基金组合快照');
    } catch (error) {
      log(`❌ 保存每日基金组合快照失败：${error.message}`);
    } finally {
      scheduleDailySnapshot(apis);
    }
  }, getNextSnapshotDelay());
  snapshotTimer.unref();
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
        name: 'Fund Monitor',
        short_name: '我的基金',
        start_url: '/portfolio',
        display: 'standalone',
        background_color: '#f6f8fb',
        theme_color: '#b91c1c',
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
      ctx.type = 'html';
      ctx.body = renderHomePage(readSession(ctx));
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
          historyApi({ FCODE: fcode, pageIndex: 1, pagesize: 1 }),
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

    router.get('/portfolio/history', (ctx) => {
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

      redirect(ctx);
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
      redirect(ctx);
    });

    router.post('/portfolio/holdings/delete', async (ctx) => {
      const body = await readPostBody(ctx);
      const code = String(body.code || '').trim();
      writePortfolioHoldings(
        readPortfolioHoldings().filter((holding) => holding.code !== code),
      );
      redirect(ctx);
    });

    router.post('/portfolio/snapshot', async (ctx) => {
      await savePortfolioSnapshot({ valuationApi, historyApi, detailApi });
      redirect(ctx, '/portfolio/history');
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
    scheduleDailySnapshot(snapshotApis);

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
