# 双城图志 · 公共地点资料

伦敦与福州的公共地点与活动资料（JSON），由本机内容后台自动同步到这里，供《双城图志》电脑版和安卓版在线更新。

App 内“Codex 内容后台”地址：

    https://mikhailxiaomaikou.github.io/twin-city-atlas-content/content.json

仅包含公开来源的公共资料，不含任何个人记录。

## 网页版

    https://mikhailxiaomaikou.github.io/twin-city-atlas-content/

同一份 `content.json` 的浏览页面：伦敦 / 福州 / 双城对照地图，地点按区域路牌分组，活动按当地日期排成时刻表（可导出 .ics 加入日历），并列出每条资料的来源与核验状态。

- 纯静态页面，无构建步骤：`index.html`、`assets/`（样式、脚本、字体）、`vendor/`（Leaflet 与聚合插件）。
- 不依赖外部 CDN；只有底图瓦片来自 CARTO（© OpenStreetMap contributors © CARTO）。底图加载失败时，点位与列表仍可使用。
- 链接可直接定位：`#london`、`#fuzhou`、`#both`、`#events`、`#sources`，或某个地点的 id（如 `#london-british-museum`）。
- 本地预览：在仓库根目录运行 `python3 -m http.server`，打开 http://localhost:8000/ 。

## 资料约定

- 坐标系 WGS84。地图点多为建筑、园区或邮编中心的概略位置，不代表入口；每条说明里写明坐标来源与精度。
- 时间字段为 UTC 毫秒；活动另带 `timeZone`（伦敦为 `Europe/London`）。开放时间文字均注明当地时间。
- `priceMinor` 以便士计；`0` 为免费，`null` 为分档或未确认（详见标题、系列或来源说明）。
- `sources[]` 按 URL 与地点、活动对应；`validUntil` 过期后表示该条活动资料已结束。

## 2026-10 伦敦资料更新

- 伦敦地点由 9 处增至 45 处：博物馆与美术馆、皇家公园与邱园、市场与唐人街、棋会与比赛场地、成人课程与公开讲座场地、大学校园参考。
- 新增 2026 年 10 月至 2027 年 1 月的伦敦活动：City Lit 素描入门各期课程、Gresham College 免费讲座、棋类快棋赛与公开赛、博物馆夜场与写生活动、大学公开讲座等。
- 原有 9 处伦敦地点的开放时间与说明已重新核对，过期内容（如 9 月课程、9 月快棋赛）已改写。
- 核对方式：通过搜索引擎读取各机构官网页面内容（官方域名限定），每条再经独立复核；未能确认的内容在文字中注明“未核实”或“以官网为准”。出发、报名前请仍以官网为准。
