# 搭搭不搭搭 0.1.0 生产部署

本包包含当前代码，镜像为 `fit-or-not-backend:0.1.0`，平台 `linux/amd64`。

## 启动时的一次性清理

V8 按本次发布要求清空测试业务数据，保留用户整行资料、微信身份、昵称、头像及头像所需媒体资源，保留 V1–V7 迁移历史。会话和邀请码一起清空，现有账号重新微信登录即可，无需再次填写邀请码。每个现有账号重建以下 11 个一级分类，不预置二级分类：

上衣、外套、裤子、裙子、连衣裙、鞋靴、箱包、配饰、眼镜、帽子、其他。

鞋靴使用鞋码，其余使用服装尺码。迁移和 V8 执行记录在同一事务中提交，失败整体回滚；API/worker 使用已有迁移锁避免并发重复执行。V8 已执行后，正常重启保留后续新增数据。媒体卷需保留以继续提供头像文件，历史测试图片文件未从卷中物理删除。

## 上传镜像并启动

从后端完整包解压得到 `backend/fit-or-not-backend-0.1.0-linux-amd64.tar.gz`，也可直接使用发布目录 `release/backend/` 中的同名镜像文件。将镜像上传服务器，在现有部署目录执行：

```sh
docker compose -f compose.yml stop api worker
docker load -i fit-or-not-backend-0.1.0-linux-amd64.tar.gz
docker compose -f compose.yml up -d --force-recreate --wait
docker compose -f compose.yml logs --tail=100 api worker
```

保留服务器现有 `.env`、Compose 项目名及媒体卷，勿用包内空密钥模板覆盖。使用 1Panel 时先停止原编排，导入镜像后以同一项目名重建启动编排，使 API/worker 使用本次镜像；只重启旧容器不会切换到新镜像。API 日志首次应出现 `migration_applied` 和 `V8__reset_test_data.sql`。

配置文件仍为 `.env`，通过 DB_HOST、DB_PORT、DB_NAME、DB_USER、DB_PASSWORD 连接已准备好的 PostgreSQL。PUBLIC_BASE_URL 为 `https://fabric.wapiti.vip/ootd`，MEDIA_SIGNING_KEY 至少 32 字符。原 `.env` 中填写的数据库密码、微信及其他密钥继续使用。

## 验证

- Node.js 24.22.3 下类型检查及后端构建通过。
- 集成测试：21 项通过、0 项失败、3 项跳过（付费 AI 和两项高德真实接口）。空库可执行 V1–V8。
- 独立真实 PostgreSQL：V7 已有用户及全部业务表数据升级到 V8，用户整行资料、头像资源及历史校验和保留，其他业务数据清空，默认一级分类及鞋码分组正确。
- 强制迁移中途失败，确认全部删除和 V8 执行记录回滚；API/worker 并发迁移只执行一次；重启后新建二级分类保留。
- 生产镜像实际运行：API 健康检查、worker 启动、V7 升级 V8 自动清理及重启保留新数据均通过；测试容器、卷和独立数据库已移除。
- 镜像导出后实际 docker load 通过，镜像内 8 个 SQL、入口及全部 50 个编译文件与工作区一致。
- 小程序包继续使用当前 0.1.0，天气以 IP 识别城市及手动选城，已移除位置接口调用和声明。

本地镜像启动验证结果、镜像 ID、SQL 校验和及包校验记录见后端 `release.json`、`migrations.json` 和 `SHA256SUMS`。未执行生产服务器部署及微信上传、发布或真机验证。

本次镜像 ID：`sha256:fc9f4f61c31d5872706890fa59cf401103857ae8a0702bbc89786b0dbbf1fd89`。
