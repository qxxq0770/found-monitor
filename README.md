# Fund Monitor

一个基于 Koa 的本地基金组合监控 Web 应用，数据来源于天天基金相关接口。项目只保留基金查询、净值、估值和排行相关接口，其他股票、主题、基金经理等旧接口已清理。

## 功能

- 登录保护：默认管理员账号 `admin`，默认密码 `Qqqaaa000`。
- 我的基金：访问 `/portfolio` 查看持仓成本、当前市值、当日收益、浮盈亏和收益率。
- 持仓管理：在组合页直接编辑成本价和份额，也可以添加或删除基金。
- 基金趋势：访问 `/portfolio/history` 查看每天 23:00 保存的组合快照和收益走势。
- 系统设置：访问 `/settings` 修改登录用户名和密码。
- 实时估算：优先使用天天基金 App 估算接口；当接口没有返回估算数据时，回退到 `fundgz.1234567.com.cn/js/{基金代码}.js`。
- 数据时间提示：页面会展示组合中最早和最新的数据时间，以及不同基金估算数据的最大时间差。
- 自动刷新：组合页和单基金估算页每 60 秒重新请求一次。
- 单基金详情：访问 `/valuation?FCODE=基金代码` 查看单只基金估值、净值和持仓收益。
- 每日快照：服务运行期间每天 23:00 自动保存组合结果，也支持在组合页手动保存当天快照。
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
- 我的基金：http://localhost:3000/portfolio
- 单基金估算：http://localhost:3000/valuation?FCODE=720003
- 基金趋势：http://localhost:3000/portfolio/history
- 系统设置：http://localhost:3000/settings

首次登录使用：

- 用户名：`admin`
- 密码：`Qqqaaa000`

## 组合配置

组合持仓保存在 [data/portfolio.json](data/portfolio.json) 中，也可以直接在组合页编辑：

```json
[
  { "code": "001045", "costPrice": 2.3603, "shares": 423.68 }
]
```

字段说明：

- `code`：基金代码
- `costPrice`：持仓成本价
- `shares`：持有份额

也可以在页面中添加、编辑或删除持仓，修改会立即写回该文件。

## 登录设置

登录配置保存在 `data/settings.json` 中。首次启动时如果该文件不存在，系统会自动创建默认管理员账号。

密码不会明文保存，系统设置页提交后会写入 PBKDF2 哈希值。修改用户名或密码后，当前登录会话会自动切换到新用户名。

## 每日快照

快照保存在 [data/snapshots.json](data/snapshots.json) 中。服务运行时会在每天 23:00 保存当天组合结果；组合页也提供“保存快照”按钮，可手动写入或覆盖当天快照。

每条快照包含组合汇总数据和当时每只基金的明细，用于 `/portfolio/history` 趋势页展示市值、浮盈亏和历史列表。

## 数据说明

页面中的“页面刷新”是本地服务渲染页面的时间。

列表中的“数据时间”是天天基金接口返回的每只基金估算数据时间。不同基金代码的数据文件不是同一秒刷新，可能出现几分钟差异，页面会显示组合内的数据时间范围和最大延迟。

## 常用路由

项目会自动注册 `src/module/*.js` 下保留的基金接口模块，例如：

- `/fundVarietieValuationDetail?FCODE=720003`
- `/fundMNHisNetList?FCODE=720003&pageIndex=1&pagesize=1`
- `/fundMNDetailInformation?FCODE=720003`
- `/fundSearch?key=新能源&m=1`
- `/fundMNRank`

管理页面需要登录，基金查询接口仍可直接请求。

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
