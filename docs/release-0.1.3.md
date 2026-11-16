# 搭搭不搭搭 0.1.3 生产发布

按当前代码生成后端与小程序生产包，包含首页天气推荐、推荐单品及穿搭详情。天气优先使用 getLocation，失败后使用 IP，也支持手动选城。getLocation 需在微信后台开通权限；本次未执行上传或真机验证。

## 数据库升级

新增 V9__weather_recommendations.sql，只创建每日推荐缓存表，不清空现有业务数据。历史 V1–V8 校验和与 0.1.2 一致。已有 V8 记录的数据库升级到 V9 时保留用户、头像、衣物、分类、会话及邀请码；迁移由 API/worker 启动时自动执行。

尚未执行 V8 的旧库首次运行时仍会执行此前授权的一次性测试数据清理：保留用户整行资料、微信身份、头像资源与迁移历史，清空其他测试业务数据（含会话及邀请码），为现有用户重建 11 个一级分类，不预置二级分类。保留 schema_migrations 和媒体卷，已执行 V8 的库不会重复清理。

## 部署

镜像为 fit-or-not-backend:0.1.3，平台 linux/amd64。在原部署目录保留已填写的 .env、Compose 项目名及媒体卷，停止原 API/worker 后导入镜像。将 API、worker 两处镜像标签均改为 fit-or-not-backend:0.1.3，或使用新包 compose.yml，然后重建。

```sh
docker compose -f compose.yml stop api worker
docker load -i fit-or-not-backend-0.1.3-linux-amd64.tar.gz
docker compose -f compose.yml up -d --force-recreate --wait
docker compose -f compose.yml logs --tail=100 api worker
```

1Panel 部署同样导入新镜像、更新两处标签并以原项目名重建。勿用包内空密钥模板覆盖服务器现有 .env。PUBLIC_BASE_URL 保持 https://fabric.wapiti.vip/ootd；小程序 API 为 https://fabric.wapiti.vip/ootd/api。

天气需要 AMAP_KEY，推荐复用 NEW_API_BASE_URL 和 NEW_API_KEY。新增可选配置默认 AI_RECOMMENDATION_MODEL=gpt-6-luna、AI_RECOMMENDATION_TIMEOUT_MS=45000。反代后的 IP 识别按实际代理地址填写 TRUST_PROXY，配置说明见源码 README。

## 本次验证

- 类型检查、服务端编译、微信官方 npm 构建与 ES2015 CommonJS 打包通过。
- 53 项测试：48 通过、0 失败、5 跳过。跳过 1 项付费图片、2 项真实推荐 AI、2 项真实高德测试；其余使用真实独立 PostgreSQL、应用 HTTP 和本地供应商协议夹具。
- 独立 PostgreSQL V8 → V9 升级通过，比较 23 张已有表全部行，确认历史数据未变；并发迁移只执行一次，重启保留推荐缓存。测试数据库已清理。
- 实际 docker load 通过，版本 0.1.3、平台 linux/amd64；全部 52 个编译文件、入口及 9 个迁移 SQL 与当前源码构建一致。镜像 ID：sha256:e7a030bee428e49484acca892feeba2b15624278fac8c78a9efbacf45df571a0。
- 镜像 API 健康、worker 就绪，V8 升级到 V9 后用户、头像及衣物保留；重启保留新增二级分类。
- 测试数据库清理：passed；测试容器及媒体卷清理：passed。

发布元数据、源码指纹、迁移清单及归档校验和见 release.json、source-sha256.json、migrations.json、SHA256SUMS。本次未执行生产服务器部署、微信上传或真机验收。
