# 搭搭不搭搭 0.1.4 生产发布

按当前代码打包，包含单件／套装照片预览与显式开始识别、多件定位与审核、整套图、补充描述重新识别及衣橱批量整理。小程序包继续使用 getLocation、IP 回退和手动选城；getLocation 需微信后台开通权限。

## 数据库迁移

- V10 新增录入、套装及关联结构；历史衣物默认无套装，历史任务和图片保留。
- V11 放行 set-cover 任务类型，不自动创建或重跑历史任务。
- V12 将没有已关联衣物、也没有活动任务的未结束录入改为 needs-attention；对应不足两件的已成功定位任务改为失败，保留原图和识别结果，允许用户补充描述后重试。

历史 V1–V9 的 SQL 校验和与 0.1.3 完全一致。应用启动时自动迁移至 V12，不需要手工删表或执行 SQL；保留原有用户、头像、衣物、分类、会话、邀请码和推荐缓存。已执行迁移不会在重启时重复运行。

尚未执行历史 V8 的旧库首次运行时，仍会执行此前授权的一次性测试数据清理：保留用户整行资料、微信身份、头像资源和迁移历史，清空其余测试业务数据（含会话和邀请码），为已有账号重建 11 个一级分类、不预置二级分类。已有 V8 执行记录的库不会再次清理。保留 schema_migrations 及媒体卷。

## 部署

镜像 fit-or-not-backend:0.1.4，平台 linux/amd64。在原部署目录保留已填写的 .env、原 Compose 项目名及媒体卷，停止原 API/worker 后导入镜像。API、worker 两处镜像标签均更新为 fit-or-not-backend:0.1.4，或使用本包 compose.yml，然后重建。

```sh
docker compose -f compose.yml stop api worker
docker load -i fit-or-not-backend-0.1.4-linux-amd64.tar.gz
docker compose -f compose.yml up -d --force-recreate --wait
docker compose -f compose.yml logs --tail=100 api worker
```

1Panel 同样导入镜像、更新两处标签并以原项目名重建。勿用包内空密钥模板覆盖服务器现有 .env。本次没有新增必填环境变量，原 NEW_API_KEY、AMAP_KEY 等配置继续使用。PUBLIC_BASE_URL 保持 https://fabric.wapiti.vip/ootd，小程序 API 为 https://fabric.wapiti.vip/ootd/api。

## 本次验证

- 类型检查、服务端编译、微信官方 npm 构建及 ES2015 CommonJS 打包通过；依赖扫描使用已有 esbuild 解析实际导入，避免将页面路径文字误认成依赖。
- 61 项测试：56 通过、0 失败、5 跳过。跳过 1 项付费图片、2 项真实推荐 AI、2 项真实高德测试；其余运行真实应用、独立 PostgreSQL、HTTP 和本地供应商协议夹具，覆盖套装录入、定位重试、审核确认、数据归属及事务回滚。
- 独立 V9 → V12 升级通过，比较 24 张已有表的原列和全部行；用户、头像、衣物、分类、历史任务、会话、邀请码和推荐缓存保留。
- 独立 V11 → V12 升级通过，比较 27 张表；仅预期卡住的录入及不足两件的定位任务被修正，有活动任务或已有衣物的录入保持原样。两个场景的并发启动、迁移记录及重启幂等验证通过，独立测试库已清理。
- 交付镜像实际 docker load 通过，版本 0.1.4、平台 linux/amd64；全部 58 个编译文件、入口及 12 个迁移 SQL 与当前工作区构建一致。镜像 ID：sha256:5b78be68f4ab4af85a7481dfa457c83db1e35334b132564f5441e9fc935ad165。
- 镜像 API 健康、worker 就绪，启动时 V9 自动升级至 V12；用户、头像和衣物保留，旧衣物无套装，重启保留新增二级分类。
- 镜像测试数据库清理：passed；测试容器及媒体卷清理：passed。

元数据、源码指纹、迁移清单和校验和见 release.json、source-sha256.json、migrations.json、SHA256SUMS。本次未执行生产服务器部署、微信上传、真机定位或真实付费图片生成验收。用户需在开发者工具／真机检查照片预览、单件入橱、套装审核、补充描述重试，以及加载、失败和空列表状态。
