# 部署说明

服务端与地图工具可以直接从本仓库运行；完整浏览器游戏还需要有权使用的、与补丁兼容的 RA2WEB 客户端及游戏资源。本仓库不自动获取或打包 EA 资源与第三方地图。

## 联机服务

在仓库根目录运行 `npm ci` 后：

```sh
ORIGIN=https://game.example.com PORT=18600 NICKNAME_ONLY=1 npm start
```

默认只监听回环地址。`ORIGIN` 用于网页同源与生成的服务信息，必须与网页实际入口相同。反向代理需要支持 WebSocket 的 `/wol` 和 `/gserv`，以及 HTTP 的 `/register` 和 `/healthz`；房间延迟通过 `/healthz?network=1` 查询。运行日志输出到标准输出，仓库不包含任何部署凭据。

`NICKNAME_ONLY=1` 为默认昵称模式，不保存账号密码数据库。设置 `NICKNAME_ONLY=0` 才启用原有账号模式；这时可用 `DATA_DIR` 指定独立数据目录。对局和恢复历史保存在内存，重启服务会丢失未结束的对局。

## 网页与 Caddy

先准备与本项目兼容的客户端发布目录，客户端 `servers.json` 应连接同站 `/wol`，游戏连接地址也应指向同站 `/gserv`。不要让局域网客户端继续连接原站联机服务。客户端配置包含完整性校验，修改脚本和 HTML 时应使用仓库构建工具重新生成版本清单与 SRI，不能只替换文件。

```sh
RA2_SITE_ADDRESS=game.example.com \
RA2_SITE_ROOT=/srv/ra2web/site \
caddy run --config deploy/Caddyfile.example --adapter caddyfile
```

局域网开发可以将 `RA2_SITE_ADDRESS` 设为 `:8080`，并将后端 `ORIGIN` 设为 `http://localhost:8080`；其他设备访问时改用对应主机地址。公网使用自己的域名、DNS 和 HTTPS。示例不改动现有机器的 DNS、SSH、证书或服务。

`deploy/ra2web-lan/build-release.py`、`neutralize-ui.py`、`customize-site.py` 和 `deploy/ra2web-public/build-release.py` 保留了版本绑定的构建过程。它们需要兼容的上游输入、资源目录及地图资料；不是通用引擎编译器，也不会从本仓库单独编译出完整游戏。`RA2_UPSTREAM_DIR`、`RA2_LAN_ORIGIN` 和 `RA2_PUBLIC_ORIGIN` 可覆盖示例路径及站点。

如果没有原版界面素材目录，可以保留输入客户端的原有界面；`neutralize-ui.py` 的原版素材转换步骤需要另行准备有权使用的原版素材。上游许可、声明和 RA2WEB 标识应保留。

## 更新方式

构建到新的发布目录，校验完成后再切换静态目录。只修改地图和网页辅助文件、且服务端源码不变时，可以保留服务端进程。修改服务端时应安排维护时间；重启会丢失内存对局。

地图有更新时重新加载页面、重新选择地图并开新局。旧对局使用的文件不应原地覆盖。不同客户端构建号必须明确核对是否兼容后，才能共享断线恢复记录。

## OSS 或 CDN

资源地址可通过客户端配置中的 `gameresBaseUrl` 和备用地址配置。上传凭据由部署者在自己的环境中管理；公共读权限不等于有上传权限。不要将 AccessKey、STS、SSH 私钥或生产 `.env` 提交到仓库。
