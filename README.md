# B站已开奖动态清理

Chrome 插件（Manifest V3）。扫描**自己**的B站动态，把转发过的抽奖动态按状态分类，预览确认后批量删除。

## 安装（加载已解压的扩展程序）

1. Chrome 地址栏打开 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录 `bili-lottery-cleaner/`
4. 打开 <https://t.bilibili.com/>（或 `space.bilibili.com`），右下角出现粉色「🎲 清理开奖动态」按钮；也可以点浏览器工具栏的插件图标

改了代码后在 `chrome://extensions/` 点插件卡片上的刷新图标，再刷新B站页面。

### 不装插件也能用

`content.js` 是自包含的：登录B站后在 `t.bilibili.com` 打开 DevTools（F12）→ Console，把整个文件粘贴进去回车，面板会直接弹出来。

## 用法

1. 点「开始扫描」。默认扫全部动态，几百条动态大约 1–2 分钟（受「请求间隔」控制）
2. 结果按状态打标签：

   | 标签 | 含义 | 默认勾选 |
   |---|---|---|
   | 已开奖 | 原动态是官方互动抽奖 / 预约抽奖 / 充电抽奖，且已开奖 | ✅ |
   | 源动态已删除 | 原动态被作者删了，转发已经没意义 | ✅ |
   | 已过开奖时间 | 开奖时间已过但接口状态还不是"已开奖"（少见） | ✅ |
   | 未开奖 | 还没开奖，删了等于弃权 | ❌ |
   | 状态未知 | 抽奖接口查询失败 | ❌ |
   | 疑似抽奖 | 原动态文字里有"抽奖/开奖/抽N位"但不是官方抽奖（UP 自己评论区抽），无法自动判断，自己看日期决定 | ❌ |

3. 检查勾选项，点「删除选中」，二次确认后逐条删除。删除不可恢复。

## 判定逻辑

- 动态列表：`api.bilibili.com/x/polymer/web-dynamic/v1/feed/space`，只看 `DYNAMIC_TYPE_FORWARD`
- 抽奖识别：原动态富文本里的 `RICH_TEXT_NODE_TYPE_LOTTERY` 节点（互动抽奖，business_type=1）；附加卡片里 `lottery/result?business_id=…&business_type=…` 链接（预约抽奖 10 / 充电抽奖 12）
- 开奖状态：`api.vc.bilibili.com/lottery_svr/v1/lottery_svr/lottery_notice`，`status === 2` 或有 `lottery_result` 视为已开奖
- 删除：`api.bilibili.com/x/dynamic/feed/operate/remove`（JSON），失败时退回旧接口 `dynamic_svr/rm_dynamic`

请求全部在你自己登录态的页面里发出（带 cookie，CSRF 用 `bili_jct`），不经过任何第三方。

## 注意

- 触发风控（-352 / HTTP 412）会自动停下并提示；等几分钟，把「请求间隔」调到 800–1000 再试
- 只处理转发动态；自己发起的抽奖、原创动态不会出现在列表里
- 设置（上限 / 间隔 / 是否列出疑似）存在 `localStorage`

## 免责声明

本工具只在你自己的浏览器登录态下、用你自己的账号删除你自己发布的动态，不收集、不上传任何数据。B站接口随时可能变动导致失效；删除操作不可恢复，请先看清楚勾选项再点删除。使用风险自负。

## License

[MIT](LICENSE)
