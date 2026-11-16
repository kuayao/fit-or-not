# 搭搭不搭搭 0.1.5 生产发布

按当前代码打包。包含出行清单进行中／历史、出发时刻、衣物增删及套装选择、行程提醒，以及当前图片预览、修补、录入和衣橱功能。

## 数据库迁移

- V13 新增行程结束时间与提醒任务；V14 新增出发时刻。原有清单、日期、衣物及收拾勾选状态保留，不为旧行程自动开启提醒。
- V15 将缺失的出发时刻设为 07:00，保留已填写时刻；提醒支持出发前两天／前一天，旧 departure-day 改为 day-before。已有待发提醒调整为出发前一天上海时间 19:00，过期或已结束则取消；既有发送结果保留，不自动增加第二条提醒。

历史 V1–V12 SQL 校验和与 0.1.4 完全一致。API／worker 启动自动迁移至 V15，无需删表或手工执行 SQL。V12 → V15 比较 27 张已有表，V14 → V15 比较 28 张表；用户、头像、微信身份、会话、邀请码、衣物、分类、任务及推荐缓存保留。两个场景的并发迁移、重启幂等及测试库清理均通过。

尚未执行历史 V8 的旧库首次运行时，仍会执行此前授权的一次性测试数据清理：保留用户整行资料、微信身份、头像资源和迁移历史，清空其余测试业务数据（含会话和邀请码），为已有账号重建 11 个一级分类、不预置二级分类。已有 V8 执行记录的库不会再次清理。保留 schema_migrations 及媒体卷。

## 部署

平台 linux/amd64，镜像 fit-or-not-backend:0.1.5。在原部署目录保留服务器 .env、原 Compose 项目名与媒体卷。停止原 API／worker 后导入镜像，API、worker 两处标签均更新为 fit-or-not-backend:0.1.5，再重建。不要用包内空密钥模板覆盖生产 .env。

```sh
docker compose -f compose.yml stop api worker
docker load -i fit-or-not-backend-0.1.5-linux-amd64.tar.gz
docker compose -f compose.yml up -d --force-recreate --wait
docker compose -f compose.yml logs --tail=100 api worker
```

启用出行提醒，在现有服务器 .env 中补充：

```dotenv
WECHAT_PACKING_TEMPLATE_ID=<微信后台已添加的出行提醒模板ID>
WECHAT_MESSAGE_ENV=formal
```

模板 ID 必须已添加到当前小程序微信后台，且 WECHAT_APP_SECRET 正确；用户需实际同意订阅，每次同意对应一次发送机会。未配置模板 ID 时提醒功能关闭。模板配置已补入生产包示例。PUBLIC_BASE_URL 保持 https://fabric.wapiti.vip/ootd，小程序 API 为 https://fabric.wapiti.vip/ootd/api。

## 验证

- 类型检查、后端编译、微信官方 npm 构建和 ES2015 CommonJS 依赖打包通过。
- 82 项测试：77 通过、0 失败、5 跳过。跳过 1 项付费图片、2 项真实推荐 AI、2 项真实高德测试。提醒发送使用本地 HTTP 协议夹具，覆盖归属、订阅额度、重复请求、取消及发送结果不确定等情况；未向真实微信用户发送消息。
- 修正两处测试夹具：归属校验使用独立有效会话；衣物移除后重新添加的测试明确搜索目标，避免前序批量数据和分页影响。未修改应用鉴权或分页行为。
- 镜像归档实际 docker load 成功，linux/amd64；60 个编译文件、入口及 15 个迁移 SQL 与当前工作区一致。镜像 ID：sha256:0cfe3cee8ae504325dad1a1d81a5c4cbaad10afc5d25b668b6882e186aa6824c。
- 使用交付镜像和隔离数据库启动 API／worker，API 健康、worker 就绪，V12 自动升级至 V15；已有用户、头像、衣物、行程和勾选状态保留，重启不重复执行 V8。测试容器、卷和数据库已清理。
- 源码指纹、目录校验和与归档内容核对结果见 release.json、source-sha256.json、migrations.json、SHA256SUMS。

未执行生产部署、微信上传、真机验收或真实订阅消息投递。用户需在开发者工具／真机检查清单增删、套装添加、结束／重新开启／复制行程和订阅同意／拒绝流程。小程序继续使用 getLocation，需微信后台开通；getFuzzyLocation 已移除。
