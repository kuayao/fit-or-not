# 搭搭不搭搭 0.1.1 生产部署

本次统一升级前后端版本、锁文件、生产镜像标签及发布元数据为 0.1.1。业务代码和 V1–V8 SQL 与已验证的 0.1.0 保持一致，小程序继续使用 IP 识别天气城市及手动选城。

## 数据库

已有 V8 执行记录的数据库升级到 0.1.1 时校验历史并跳过 V8，保留清理后新增的衣物、分类等数据。尚未执行 V8 的数据库首次部署本包时，仍会自动执行已授权的一次性清理：保留用户整行资料、微信身份和头像资源，清空其他测试业务数据（含会话和邀请码），为每个现有账号创建 11 个一级分类，不预置二级分类。

默认一级分类依次为上衣、外套、裤子、裙子、连衣裙、鞋靴、箱包、配饰、眼镜、帽子、其他；鞋靴使用鞋码。迁移成功后记录在 `schema_migrations`，后续正常启动不会再次清理。保留迁移记录和媒体卷。

## 部署

镜像文件为 `fit-or-not-backend-0.1.1-linux-amd64.tar.gz`。完整后端包为 `fit-or-not-backend-0.1.1-production-linux-amd64.tar.gz`，内含镜像、新版 compose.yml 和配置模板。小程序为 `fit-or-not-wechat-0.1.1-production.zip`。

在原部署目录保留已填写的 `.env`、Compose 项目名和媒体卷，先停止现有 API/worker：

```sh
docker compose -f compose.yml stop api worker
docker load -i fit-or-not-backend-0.1.1-linux-amd64.tar.gz
```

使用新包 `compose.yml`，或将原编排 API 和 worker 的镜像均改为 `fit-or-not-backend:0.1.1`，然后启动：

```sh
docker compose -f compose.yml up -d --force-recreate --wait
docker compose -f compose.yml logs --tail=100 api worker
```

使用 1Panel 时，停止原编排，导入新镜像，将 API 和 worker 两处镜像标签都更新为 0.1.1，再以原项目名重建启动。服务器现有 `.env` 继续使用，勿用模板中的空密钥覆盖。API 地址仍为 `https://fabric.wapiti.vip/ootd/api`，PUBLIC_BASE_URL 保持 `https://fabric.wapiti.vip/ootd`。

## 验证

本次执行类型检查、微信官方 npm 构建、ES2015 CommonJS 打包和后端构建。业务代码及迁移与前版逐文件校验，不重复运行前版已通过且未受影响的全量集成测试。镜像运行、版本升级和归档检查结果记录于包内 `release.json`、`migrations.json`、`SHA256SUMS`。

未执行生产服务器部署及微信上传、发布或真机验证。

本次镜像 ID：`sha256:c89f8282c0eb78223f88c75d9c7ba488e7eca33c2e40ba70017aadb45e6d53bf`。

镜像静态检查：导出后实际 docker load 通过，包内版本号为 0.1.1，全部 8 个迁移 SQL、50 个编译文件及入口与工作区一致。244 项其他源码指纹、历史 V1–V8 校验和保持不变。

镜像运行验收未完成：not completed: Docker command timeout。本地 Docker 未正常启动测试应用；静态镜像、类型及构建检查已通过。清理结果见 release.json。
