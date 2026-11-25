# 亚美尼亚徒步轨迹 · 离线地图（PWA）

可以「添加到主屏幕」的网页应用：在手机上**离线**查看自己导入的 GPX / KML / TCX / GeoJSON 轨迹——多条分色显示、海拔剖面、山体阴影、3D 地形、GPS 定位。

轨迹只保存在使用者自己手机的浏览器存储里，**本仓库不含任何轨迹**。

*An installable offline web app (PWA) for viewing your own GPX / KML / TCX / GeoJSON hiking tracks on a phone: multi-colour routes, elevation profile, hillshade, 3D terrain, GPS. Tracks stay on the device; this repo contains no tracks.*

## 数据与署名 / Credits

* 底图数据 © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)（ODbL）；矢量切片与样式：[Protomaps](https://protomaps.com)（2026-11-25 构建）。
* 地形：Mapzen / [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)（NASA SRTM 等）。
* 在线底图（卫星 / OpenTopoMap）仅联网时使用，不会缓存：Esri、OpenTopoMap。
* 开源库（都在 `lib/`）：[Leaflet](https://leafletjs.com)、[MapLibre GL JS](https://maplibre.org)、[protomaps-leaflet](https://github.com/protomaps/protomaps-leaflet)、[PMTiles](https://github.com/protomaps/PMTiles)、[@protomaps/basemaps](https://github.com/protomaps/basemaps)。

## 结构

| 路径 | 说明 |
|---|---|
| `index.html` `app.js` `terrain.js` `style.css` | 页面本体（无构建步骤） |
| `sw.js` | Service Worker：只缓存应用外壳；改了文件后 `VER` 要跟着变 |
| `data/*.pmtiles` | 离线底图（Azat 河谷走廊 z0–z15 + 亚美尼亚全境 z0–z11）和离线高程（走廊 z12 + 全境 z9） |
| `lib/` | 第三方库 |
