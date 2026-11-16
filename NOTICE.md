# 来源、修改与许可范围

Copyright (c) 2026 Winlife contributors.

本仓库于 2026-11-16 从 Winlife 红警联机的维护源码整理而来。公开版将生产环境配置改为示例地址，将测试解析器与 WebSocket 库改为 npm 依赖，省略服务器访问脚本、私人配置、运行数据、历史验收录像和游戏资源包。

## RA2WEB / Chrono Divide

兼容基线是 RA2WEB 0.87.3，部署包提交：

`ec91229bf85d637c2388edae31ef1f09805568e8`

来源：<https://github.com/ra2web/ra2web.github.io/tree/ec91229bf85d637c2388edae31ef1f09805568e8>。

上游包含 AGPL-3.0 许可证文件，并在 README 中另行声明个人研究、爱好使用、商业授权与显著署名要求。本仓库保留这两份原文，不替上游解释或授予额外权利。依赖上游运行的站点应保留 RA2WEB / 网页红井 / 红色井界等上游要求的标识及相应署名入口。

`third_party/ra2web/` 只保存上游许可与说明。仓库不包含完整引擎实现或发布包；绑定上游符号的补丁和读码适配器不能被当作完整游戏引擎源码。

## 原版游戏与地图

Red Alert 2、Yuri's Revenge、Westwood 和 Electronic Arts 相关名称、素材与商标归各自权利人所有。本仓库不附带 MIX、SHP、Bink、WASM 游戏模块、MOD 安装包、原版菜单图像或音乐。

CnCNet、XWIS 等来源的第三方地图不随仓库分发；地图整理工具保留来源、作者和摘要字段，不代表获得其再授权。原创地图使用真实游戏格式，运行时仍需相应客户端与素材。

## npm 依赖

`ws`、`acorn` 与 `acorn-walk` 使用各自的 MIT 许可证，作者与条款随 npm 包提供；确切版本与完整性摘要见 `package-lock.json`。根目录 AGPL 许可证不替换这些依赖的许可证。

本仓库提供的是公开维护代码和工具；运行上游客户端及使用第三方资源时，请分别核对其条款。
