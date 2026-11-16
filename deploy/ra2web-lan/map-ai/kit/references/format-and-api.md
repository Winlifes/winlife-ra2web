# 格式、设计输入和 API

## 支持范围

目标是当前 Winlife 的 RA2WEB 0.87.3。自动制作配置 `winlife-flat-land-v1` 支持 2–16 人、32–160 的宽和高、`TEMPERATE` 与 `SNOW`。9–16 人依赖本站人数扩展；其他平台兼容性需要另验。配置故意限定为标准陆战地图，扩展内容应做专项验证。

观察者属于房间席位，不增加地图出生点：最多 16 名参战者另加 1 名观察者，地图仍只有 N 个参战出生点。

编码器本身能保留导入图的其他剧场、脚本和配置，但这不表示制作包会给这些内容出具自动通过结果。校验器对本配置外的内容报告失败；保留源图并说明尚待验证，不能删掉需求内容来凑通过。

## JSON 设计

以 `examples/8p-snow.json` 为完整示例。

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 固定为 1 |
| `name`, `author`, `intent` | 地图名称、作者、设计意图；名称不含换行和 INI 方括号 |
| `width`, `height`, `theater`, `players` | 尺寸、剧场和真实出生点人数 |
| `spawns` | 恰好 N 个对象；数组顺序对应出生点 0..N-1 |
| `position: [u,v]` | 在可玩投影矩形中 0..1 的位置，脚本吸附到有效交错地块 |
| `suggestedTeam` | 仅设计说明，球队仍在房间设置，不会伪造强制球队规则 |
| `water[].rect` | `[u0,v0,u1,v1]`，在矩形内铺设真正水域地块；不自动拼岸线 |
| `homeResources` | 每个出生点应用相同矿区配置；`offsets` 使用真实格坐标的 `[deltaRx,deltaRy]`，`radius` 为正方形半径，`value` 为 1..11 |
| `resourceZones[]` | 指定 `position`, `kind: ore/gems`, `radius:1..8`, `value:1..11` 的额外矿区 |
| `structures[]` | `{type,position}`；可用类型及实际地基尺寸见 `lib/profile.json` |
| `trees[]` | `{type,position}`；树木 ID 必须存在于 `lib/profile.json` |
| `validation.baseClearRadius` | 每家基地保留 `(2r+1)²` 的平地净空，默认 r=4；脚本范围 3..8 |
| `validation.minLaneWidth` | 地面近似图经 3/5/7 格腐蚀后仍连通；默认 3，不等于原生坦克转弯宽度 |
| `validation.homeResourceRadius` | 用四邻接地面图衡量近矿范围，默认 18 步；支持 8..64 |
| `validation.balanced` | 默认 true；明确需要非对称资源时可设 false 并说明设计理由 |
| `validation.resourceTolerance` | 近矿格数 `(max-min)/max` 容许差值，默认 0.1；矿石和宝石分开统计 |

基地保护区内不得有水、矿、树或建筑。矿区不会自动裁边或吞掉重叠格来隐藏设计错误，遇到冲突应调整设计。

## 直接使用编码 API

```js
import {
  createMap, serializeMap, parseMap, playableBounds,
  tileAtDisplay, tileAtCell, setSpawn, setOverlay, setTerrain,
  addStructure, setMetadata, getIniValue, setIniValue,
  OVERLAY_IDS, TERRAIN_TILES,
} from './lib/map-codec.mjs';

const doc = createMap({width: 128, height: 128, theater: 'SNOW',
  name: '原创地图', author: '你的名字', players: 8});
// 在此使用有效的真实格坐标编辑，随后 serializeMap(doc)。
// 将最终字节交给 scripts/validate.mjs，API 成功不等于验收通过。
```

`setSpawn(doc, number, rx, ry)` 设置真实出生点。`setOverlay(doc,rx,ry,OVERLAY_IDS.ORE,11)` 布置矿石。`addStructure(doc,{name:'CAOILD',rx,ry})` 添加中立油井。结构列表 ID 和对象名称是不同字段，不用格坐标冒充结构序号。

## 坐标的三个层次

| 坐标 | 规则 |
| --- | --- |
| 真实格 `rx,ry` | 路点值为 `ry * 1000 + rx`；树木键也用这个步长 |
| 覆盖物索引 | `ry * 512 + rx`，底层为两个 512×512 字节图层 |
| 显示网格 `dx,row` | 每行 `2*width-1` 列，`tileAtDisplay(doc,dx,row)` |
| 显示半行 `dy` | `dy=2*row+(dx&1)`；`displayToCell` 要求 dx 与 dy 同奇偶 |

转换公式由 codec 提供：`dx=rx-ry+width-1`，`dy=rx+ry-width-1`。不要把整行 row 当成 dy。地图矩形内的地块也可能位于 `LocalSize` 的不可玩边缘；使用 `playableBounds` / `isPlayableCell` 判断。

## 关键 INI 与资源

新图需要 `[Basic] NewINIFormat=4, MultiplayerOnly=yes, Official=no, GameMode=standard, MinPlayer=2, MaxPlayer=N`，`[Map] Theater/Size/LocalSize`，有效的 `[IsoMapPack5]` 和出生路点。9–16 人另外写 `WinlifeMaxPlayers=N`。

普通图把 waypoint 0–7 作为出生点，编号 8 及以上保留作普通路点；扩展图只在显式标记的范围内增加出生点。出生点不能重号、别名（如 `01` 与 `1`）、同坐标、落水或越出可玩范围。

此配置允许的平地瓦片为 0，水域为 314；具体剧场的可用子块来自原始 TMP 资源并记录在 `profile.json`。矿石覆盖物为 102，宝石为 27；值为资源密度/帧数据，不是直接填写金币数。其他瓦片和覆盖物 ID 不应靠猜测扩展。

`IsoMapPack5` 是分块 LZO，`OverlayPack/OverlayDataPack` 是分块 LCW/Format80。使用附带编码器，不手写压缩载荷。`MaxPlayer=16`、16 个文字标签或 16 个 SVG 圆圈都不能替代 16 个有效的真实出生点。

## 检查报告

`staticPassed` 包含当前配置范围内的结构、资源和设计近似检查；`nativeDecoded` 表示原始游戏数据读取器与 codec 的地块、覆盖物、路点和出生点结果一致。原始读取器运行在有超时的 VM 中，并跳过照明、触发器和场景执行；本配置拒绝这些脚本内容。

基地净空、地基遮挡、四邻接连通、通道腐蚀和近矿格数都是代理模型。它们不实现游戏的移动类、建筑邻接、MCV 展开、采矿收益或 AI。最终 `.map` 必须小于等于 2 MiB；编辑器能读入更大的文件不代表联机能传输。
