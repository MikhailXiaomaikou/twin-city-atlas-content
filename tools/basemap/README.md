# 内置底图的生成

`basemap/<city>/{z}/{x}/{y}.json` 是网页自带的矢量底图瓦片，由 `assets/basemap.js` 在浏览器里用 canvas 画出来，不依赖任何外部地图服务。

重新生成：

```sh
cd tools/basemap
sh fetch.sh data            # 下载原始数据（约 250 MB）
npm install geojson-vt      # 切片用
node build.mjs data ../../basemap london,fuzhou
```

瓦片格式：每个文件是 `{ 图层名: [[标签, [扁平坐标数组, …]], …] }`，坐标为 0–4096 的整数（瓦片内坐标）。伦敦切到 z14，福州到 z13，更深的缩放由浏览器放大上一级瓦片。

数据来源与许可：

| 图层 | 来源 | 许可 |
|---|---|---|
| 陆地、湖泊、河流、国界、城区、主要公路、城市名 | [Natural Earth](https://www.naturalearthdata.com/) 1:10m（经 nvkelso/natural-earth-vector） | 公有领域 |
| 伦敦街道（全市）| [Propensity to Cycle Tool](https://www.pct.bike/) 伦敦 `rnet_full`（基于 OpenStreetMap / CycleStreets 的路网） | CC BY 4.0；路网数据 © OpenStreetMap contributors, ODbL |
| 伦敦市中心带名字的街道 | petercorke/pgraph-python 示例里的 OpenStreetMap 提取 | © OpenStreetMap contributors, ODbL |
| TfL 道路网（主干道面）、泰晤士河、国铁线路与车站、地铁/轻轨线路与车站、选区中心点（街区名）| Oliver O'Brien（oobrien/vis）整理的 TfL 与 OS OpenData 开放数据 | TfL open data；Contains OS data © Crown copyright and database right |
| 伦敦各区边界 | radoi90/housequest-data（ONS/OS OpenData） | Open Government Licence |

福州只有 Natural Earth 的概略数据（海岸、闽江、几条主要公路）；OpenStreetMap 的福州街道无法从本环境获取，有了数据可以照伦敦的方式切片。
