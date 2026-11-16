# Winlife 红警地图 AI 制作包

把本包和地图需求交给另一个 AI，让它先读取 [AGENTS.md](AGENTS.md)。支持终端的 AI 可以直接执行；纯聊天 AI 可以提供设计，但需要有文件执行能力的一方运行脚本和操作游戏。

本包不内置或调用模型。它提供真实地图编码器、设计示例、静态校验、原生解码交叉检查以及实际验收流程。运行环境为 **Node.js 22 或更新版本**，无需安装第三方依赖。

## 可直接复制给其他 AI

> 阅读这个制作包的 AGENTS.md 及其中链接的格式、验收说明。按我的需求设计地图，使用附带脚本生成真实 .map，修复校验失败并交付可复现设计、地图、预览和报告。有浏览器操作能力时执行实际游戏验收，保存证据；没有执行的测试标 pending。不要用示意图、可解析或静态通过冒充实际开局成功。需求：在这里填写人数、玩法、地形和布局。

## 快速使用

先解压整个包，在包根目录运行：

```sh
node scripts/generate.mjs examples/8p-snow.json --out out/snow-v1
node scripts/validate.mjs out/snow-v1/wl_ai_具体散列.map --design out/snow-v1/design.json --report out/snow-v1/static-report.json
node --test tests/kit.test.mjs
```

第一条命令会打印实际 `.map` 路径，第二条命令使用该路径。每次迭代选择新目录，例如 `out/snow-v2`。Windows 也使用同样的 Node 命令；不要把示例里的中文占位文件名当成实际文件名。

生成成功后包含：

| 文件 | 用途 |
| --- | --- |
| `wl_ai_<SHA256前24位>.map` | 实际可导入的地图，文件内容完整 SHA 在报告中 |
| `design.json` | 可复现的设计输入，包含人数及建议球队 |
| `preview.svg` | 从实际地图数据生成的示意图 |
| `static-report.json` | 格式、原生解码和静态设计近似检查 |
| `runtime-acceptance.json` | 全部运行项初始为 `pending` 的验收记录 |

在 [地图工坊](https://ra.winlife.fun/map-editor/) 导入 `.map`，点击“加入我的游戏”，刷新游戏并在自订地图中选择。保存只属于当前浏览器/域名；开局时由房主向客机传图。地图传输上限为 2 MiB。

## 阅读顺序

- [AGENTS.md](AGENTS.md)：给 AI 的工作约定和交付标准。
- [格式与 API](references/format-and-api.md)：坐标、人数标记、JSON 字段与支持范围。
- [验收流程](references/acceptance.md)：从导入、基地建设到联机校验的真实操作。
- `SOURCES.json`：目标客户端、编码器、原生数据路径和资源的来源散列。
- `LICENSE`：所附 RA2WEB 源码和衍生工具的 AGPL-3.0 许可与原作声明。游戏图像和完整客户端不包含在本包中。
