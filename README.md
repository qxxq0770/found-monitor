# Fund Monitor

一个基于 Koa 的本地基金组合监控 Web 应用，数据来源于天天基金相关接口。项目保留原 TiantianFundApi 的基金/股票 API 路由，并新增了适合日常查看的基金组合页面。

## 功能

- 基金组合看板：访问 `/portfolio` 查看持仓成本、当前市值、当日收益、浮盈亏和收益率。
- 实时估算：优先使用天天基金 App 估算接口；当接口没有返回估算数据时，回退到 `fundgz.1234567.com.cn/js/{基金代码}.js`。
- 数据时间提示：页面会展示组合中最早和最新的数据时间，以及不同基金估算数据的最大时间差。
- 自动刷新：组合页和单基金估算页每 60 秒重新请求一次。
- 单基金详情：访问 `/valuation?FCODE=基金代码` 查看单只基金估值、净值和持仓收益。
- 移动端适配：iPhone 等窄屏设备下，持仓明细会从横向表格切换为卡片布局。
- Web 应用图标：已配置 favicon、Apple Touch Icon 和 Web App Manifest。

## 环境要求

- Node.js
- 项目依赖已安装在 `node_modules` 中

如果需要重新安装依赖，优先使用锁文件对应的 pnpm：

```bash
pnpm install
```

当前机器如果没有 `pnpm`，但 `node_modules` 已存在，可以直接启动。

## 启动

在项目根目录运行：

```bash
node index.js
```

或在 pnpm 可用时运行：

```bash
pnpm start
```

启动成功后访问：

- 首页：http://localhost:3000/
- 基金组合：http://localhost:3000/portfolio
- 单基金估算：http://localhost:3000/valuation?FCODE=720003

## 组合配置

组合持仓目前写在 [src/app.js](src/app.js) 的 `portfolioHoldings` 中：

```js
const portfolioHoldings = [
  { code: '001045', costPrice: 2.3603, shares: 423.68 },
];
```

字段说明：

- `code`：基金代码
- `costPrice`：持仓成本价
- `shares`：持有份额

修改后重启服务即可生效。

## 数据说明

页面中的“页面刷新”是本地服务渲染页面的时间。

列表中的“数据时间”是天天基金接口返回的每只基金估算数据时间。不同基金代码的数据文件不是同一秒刷新，可能出现几分钟差异，页面会显示组合内的数据时间范围和最大延迟。

## 常用路由

项目会自动注册 `src/module/*.js` 下的接口模块，例如：

- `/fundVarietieValuationDetail?FCODE=720003`
- `/fundMNHisNetList?FCODE=720003&pageIndex=1&pagesize=1`
- `/fundMNDetailInformation?FCODE=720003`

## 检查

语法检查：

```bash
node --check src/app.js
```

测试：

```bash
pnpm test
```

如果本机没有 `pnpm` 命令，可以先安装 pnpm 或使用已有依赖直接运行服务验证。
