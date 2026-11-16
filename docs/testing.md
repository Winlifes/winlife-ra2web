# 验证范围

## 不需要游戏资源

```sh
npm ci
npm run check
npm test
npm run maps
```

回归覆盖服务端房间、昵称、16 人席位、延迟采样、调参重放、断线恢复和房间生命周期，也检查编辑器撤销/重做、Worker 编码、显卡诊断与手势事件处理。地图命令生成两张原创地图，检查 SHA-256 与已发布修订版一致，并运行地图设计断言。

## 使用实际客户端的检查

部分 `*.test.mjs` / `*.test.cjs` 是引擎集成测试，需要外部客户端、MIX 或原图样本，故不加入默认 `npm test`。保留的历史路径只是输入示例，不包含生产资源。

例如准备兼容客户端后：

```sh
RA2_CLIENT_BUNDLE=/absolute/path/to/client/js/app.js \
node --test deploy/ra2web-lan/client-network-rate.test.mjs \
  deploy/ra2web-lan/player16-client.test.cjs \
  deploy/ra2web-lan/map-loader.test.cjs \
  deploy/ra2web-lan/rematch-client.test.cjs \
  deploy/ra2web-lan/reconnect/reconnect.test.mjs
```

这些测试依赖具体引擎符号，换上游版本后必须重新检查，不能为了通过而移除版本断言。

如需同时验证第三方原图与上一版本的归档一致，可以额外设置 `RA2_PREVIOUS_RELEASE=/absolute/path/to/previous-client`。未提供基线时仍逐一校验当前归档文件的 SHA-256，但不声称已比较历史版本。

AI 制作包需先用 `map-ai/build-kit.mjs` 与兼容客户端构建，生成原生解码快照、资源 profile 和来源清单，再运行输出包中的测试。仓库保存制作包源码，不附带从游戏客户端提取的运行数据。

## 两岸会战 8v8 最新修订

修复前的低桥文件没有原生加载器要求的中间格标记，因而只显示维修小屋。修复后每一段桥都写入三格配套的 `OverlayData=0,1,2`。

已完成的验证：

- 原生地图 Overlay 加载器生成 426 段桥、12 个桥头、6 个连续桥梁规格，维修小屋关联正确。
- 地图有桥时 16 个出生点静态连通，去桥后两队隔离；出生净空与资源对称检查通过。
- 实机回放中的三组双桥连续显示，桥头接岸；内嵌缩略图经原生解码逐像素检查。

仍未完成：车辆从一岸完整走到另一岸的实测，以及 16 台实体设备的通行压力测试。静态可达检查、画面显示和原生数据解码都不能替代这两项测试。

新增地图应参照 `deploy/ra2web-lan/map-ai/kit/references/acceptance.md`，把未执行的项目记录为 `pending`，并用最终地图 SHA-256 绑定证据。
