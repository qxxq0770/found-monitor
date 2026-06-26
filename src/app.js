const koa = require('koa');
const Router = require('@koa/router');
const fs = require('fs');
const path = require('path');
const { log } = require('./utils/log');
const { getModules } = require('./utils');

const portfolioHoldings = [
  { code: '001045', costPrice: 2.3603, shares: 423.68 },
  { code: '373020', costPrice: 2.7403, shares: 547.38 },
  { code: '720003', costPrice: 2.1947, shares: 455.65 },
  { code: '007028', costPrice: 2.0933, shares: 477.72 },
  { code: '011884', costPrice: 1.4594, shares: 342.61 },
  { code: '002179', costPrice: 3.1327, shares: 319.21 },
  { code: '018257', costPrice: 1.4635, shares: 341.65 },
  { code: '000979', costPrice: 6.4529, shares: 154.97 },
  { code: '010737', costPrice: 1.4272, shares: 350.34 },
  { code: '370027', costPrice: 5.4624, shares: 183.07 },
  { code: '166002', costPrice: 3.7281, shares: 268.23 },
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

function renderHomePage(modules) {
  const links = modules
    .map(({ fileName }) => `<li><a href="/${fileName}">/${fileName}</a></li>`)
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${renderIconLinks()}
    <title>TiantianFundApi</title>
    <style>
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2937; background: #f8fafc; }
      main { max-width: 960px; margin: 0 auto; padding: 40px 24px; }
      h1 { margin: 0 0 8px; font-size: 32px; }
      p { margin: 0 0 24px; color: #4b5563; }
      ul { columns: 2; padding-left: 20px; line-height: 1.9; }
      a { color: #0f766e; text-decoration: none; }
      a:hover { text-decoration: underline; }
      code { padding: 2px 6px; border-radius: 4px; background: #e5e7eb; }
      .tools { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 24px; }
      .tool { display: inline-block; padding: 10px 14px; border: 1px solid #99f6e4; border-radius: 6px; background: #ccfbf1; font-weight: 600; }
      @media (max-width: 720px) { ul { columns: 1; } }
    </style>
  </head>
  <body>
    <main>
      <h1>TiantianFundApi</h1>
      <p>API service is running at <code>localhost:3000</code>.</p>
      <div class="tools">
        <a class="tool" href="/portfolio">我的基金组合</a>
        <a class="tool" href="/valuation?FCODE=470007">查看基金实时估算</a>
      </div>
      <ul>${links}</ul>
    </main>
  </body>
</html>`;
}

function renderValuationPage({ fcode, data, history, detail, error }) {
  const expansion = data && data.Expansion ? data.Expansion : {};
  const latestNet =
    history && Array.isArray(history.Datas) && history.Datas.length
      ? history.Datas[0]
      : {};
  const detailInfo = detail && detail.Datas ? detail.Datas : {};
  const holding = portfolioHoldings.find((item) => item.code === fcode);
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
    <meta http-equiv="refresh" content="60">
    ${renderIconLinks()}
    <title>基金实时估算 - ${escapeHtml(fcode)}</title>
    <style>
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
      <header>
        <div>
          <h1>${escapeHtml(displayName)}</h1>
          <p class="sub">FCODE ${escapeHtml(fcode)} · 页面每 60 秒自动刷新</p>
        </div>
        <form action="/valuation" method="get">
          <input name="FCODE" value="${escapeHtml(fcode)}" inputmode="numeric" aria-label="基金代码">
          <button type="submit">查看</button>
          <a class="back" href="/">首页</a>
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
  return Promise.all(
    portfolioHoldings.map(async (holding) => {
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

function renderPortfolioPage(rows) {
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
    <title>我的基金组合</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f6f8fb; -webkit-text-size-adjust: 100%; }
      main { max-width: 1280px; margin: 0 auto; padding: 30px max(20px, env(safe-area-inset-right)) 48px max(20px, env(safe-area-inset-left)); }
      header { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; margin-bottom: 22px; }
      h1 { margin: 0 0 8px; font-size: 30px; }
      p { margin: 0; color: #64748b; }
      a { color: #0f766e; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .back { padding: 9px 12px; border: 1px solid #0f766e; border-radius: 6px; color: #fff; background: #0f766e; }
      .summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 14px; margin-bottom: 18px; }
      .metric, .table-wrap { border: 1px solid #dbe3ee; border-radius: 8px; background: #fff; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04); }
      .metric { padding: 16px; }
      .metric span { display: block; color: #64748b; font-size: 13px; }
      .metric strong { display: block; margin-top: 6px; font-size: 24px; }
      .table-wrap { overflow-x: auto; }
      table { width: 100%; min-width: 1200px; border-collapse: collapse; }
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
        .back { display: inline-block; margin-top: 14px; }
        .summary { grid-template-columns: 1fr 1fr; }
      }
      @media (max-width: 560px) {
        main { padding: 18px max(12px, env(safe-area-inset-right)) 28px max(12px, env(safe-area-inset-left)); }
        header { margin-bottom: 16px; }
        h1 { font-size: 26px; line-height: 1.15; }
        p { font-size: 13px; line-height: 1.55; }
        .back { min-height: 40px; padding: 9px 14px; }
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
        td::before { content: attr(data-label); flex: 0 0 auto; color: #64748b; font-size: 12px; font-weight: 500; }
        td:first-child, td:nth-child(2), td:nth-child(13) { grid-column: 1 / -1; }
        td:first-child { padding-top: 12px; }
        td:nth-child(2) { display: block; text-align: left; }
        td:nth-child(2)::before { display: none; }
        td:nth-child(2) strong { font-size: 16px; line-height: 1.3; white-space: normal; }
        td:nth-child(2) span { white-space: normal; }
        td:nth-child(12), td:nth-child(13) { border-bottom: 0; }
        td a { font-size: 16px; font-weight: 700; }
        .tag { padding: 3px 7px; }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>我的基金组合</h1>
          <p>${portfolioHoldings.length} 只基金 · ${estimateCount} 只使用实时估算 · ${latestNetCount} 只回退最新净值 · 数据时间 ${escapeHtml(earliestDataTime || '--')} - ${escapeHtml(latestDataTime || '--')}${dataDelayMinutes > 0 ? ` · 最大延迟约 ${dataDelayMinutes} 分钟` : ''} · 页面刷新 ${escapeHtml(renderedAt)} · 每 60 秒重新请求</p>
        </div>
        <a class="back" href="/">首页</a>
      </header>
      <section class="summary">
        <div class="metric"><span>持仓成本</span><strong>${formatNumber(totalCost, 2)}</strong></div>
        <div class="metric"><span>当前市值</span><strong>${formatNumber(totalValue, 2)}</strong></div>
        <div class="metric"><span>当日收益</span><strong class="${totalDayProfit >= 0 ? 'up' : 'down'}">${formatNumber(totalDayProfit, 2)}</strong></div>
        <div class="metric"><span>浮盈亏</span><strong class="${totalProfit >= 0 ? 'up' : 'down'}">${formatNumber(totalProfit, 2)}</strong></div>
        <div class="metric"><span>收益率</span><strong class="${totalProfit >= 0 ? 'up' : 'down'}">${formatPercent(totalProfitRate)}</strong></div>
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
  </body>
</html>`;
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
        name: '我的基金组合',
        short_name: '基金组合',
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

    router.get('/', (ctx) => {
      ctx.type = 'html';
      ctx.body = renderHomePage(modules);
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
      ctx.body = renderValuationPage({ fcode, data, history, detail, error });
    });

    router.get('/portfolio', async (ctx) => {
      const rows = await getPortfolioRows({
        valuationApi,
        historyApi,
        detailApi,
      });

      ctx.type = 'html';
      ctx.body = renderPortfolioPage(rows);
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

    const server = app.listen(3000, () => {
      log('🚀 server is running at port 3000');
      resolve(server);
    });
  });
}

module.exports = {
  startServe,
};
