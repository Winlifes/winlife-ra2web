# AI 地图制作与验收资料的维护

公开入口：<https://ra.winlife.fun/map-ai/>。AI 执行说明为 `/map-ai/AGENTS.md`；完整包为 `/map-ai/winlife-ra2-map-ai-1.0.0.zip`。用户也可以下载 ZIP 后直接交给另一个 AI，避免依赖对方浏览工具能否访问该域名。

`kit/` 是制作包源码。编码器来自当前 `map-editor/map-codec.mjs`；构建时从已部署客户端提取有来源散列的独立数据解码快照，并从原始 INI/MIX 资源核实瓦片、树木和中立建筑地基。包不包含模型接入、服务器凭据或完整游戏素材。

重建到新目录：

```sh
node deploy/ra2web-lan/map-ai/package-kit.mjs vendor/ra2web-lan-0.87.3-20261112-workshop7 vendor/map-ai-package-新版本
```

输出包含 `winlife-ra2-map-ai/` 源码包、ZIP 和可放在网页根目录 `map-ai/` 下的 `site/`。`package-kit.mjs` 会运行测试、生成三种人数示例和 SHA256 清单；发布时将版本号及 ZIP 名称在构建器、打包器和页面模板中同步更新。

当前版本 1.0.0：17 项测试通过；2、8、16 人示例生成确定，原生数据读取器与 codec 的地块、覆盖物、路点、出生点一致。压缩包在独立临时目录解压后完成了再次生成、校验与待验收记录拒绝测试。证据见 `../proof/map-ai-kit-20261113/`。

此版本的示例只标注 `static-pass-runtime-pending`。原生快照不执行渲染、碰撞、建筑放置、寻路、AI 或完整脚本；资源轮廓为基础资源加 overlay，活动 MOD 另验。不要把工具测试记录写成示例地图的实战验收。

发布使用客户端静态更新：增加文档和下载文件，保持所有原有非 deployment 文件逐字节不变；保留既有客户端构建号，不重启后端，也不将这些示例注册进公共选图列表。
