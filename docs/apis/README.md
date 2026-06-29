## 保留接口

项目只保留基金查询、净值、估值和排行相关接口。服务启动后会自动注册 `src/module/*.js` 下的模块。

## 搜索

- `/fundSearch?m=1&key=新能源`
- `/fundSearchInfoByName?key=华夏&orderType=2&pageindex=1&pagesize=20`
- `/fundSuggestList`

## 基金列表

- `/fundNetList`
- `/fundMNNetNewList`
- `/fundMNRank`
- `/fundMNHKRank`

## 基金详情与净值

- `/fundMNDetailInformation?FCODE=720003`
- `/fundMNStopWatch?FCODE=720003`
- `/fundGradeDetail?FCODE=720003`
- `/fundMNPeriodIncrease?FCODE=720003`
- `/fundRankDiagram?FCODE=720003`
- `/fundVPageAcc?FCODE=720003`
- `/fundVPageDiagram?FCODE=720003`
- `/fundMNHisNetList?FCODE=720003&pageIndex=1&pagesize=1`
- `/fundVarietieValuationDetail?FCODE=720003`

管理页面需要登录，基金接口可以直接请求。
