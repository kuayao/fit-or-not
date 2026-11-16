# HTTP 接口契约草案

前缀 `/api`，JSON 字段 camelCase；调用方使用 Bearer 会话令牌。登录、邀请码绑定、受限媒体签名下载之外均需会话。所有业务资源隐含当前用户，不接受客户端指定所属用户。

成功：`{ "data": ... }`；列表：`{ "data": [], "pagination": { "page": 1, "pageSize": 20, "total": 0 } }`；失败：`{ "error": { "code": "...", "message": "中文说明" } }`。204 不返回响应体。requestId 放在响应头 `X-Request-Id`。

## 公共约定

- 页码从 1 开始，默认 pageSize=20，上限 50；状态/排序参数使用服务端允许值。
- ID、priceCents 为字符串；时间点 ISO 8601 UTC，自然日 YYYY-MM-DD。
- PATCH（包含用户资料、分类、标签）携带 version，各对应响应包含当前版本。版本不匹配返回 409 `VERSION_CONFLICT`，客户端提示重新加载，不静默覆盖。
- POST 创建任务/付费请求携带 `Idempotency-Key`，作用域为用户+路由。相同 key 与请求体重复返回原结果；同 key 不同内容返回 409。
- HTTP 状态：200 查询/修改，201 创建，202 异步受理，204 删除，400 输入格式错误，401 未登录，403 未获准入，404 资源不可用，409 版本/引用/状态冲突，413 文件超限，422 内容不能处理，429 配额或频率限制，503 依赖不可用。

## 端点清单

| 方法与路径 | 请求/用途 | 返回核心内容 |
| --- | --- | --- |
| POST /auth/wechat | code | 已成员 token/expiresAt/user，或 requiresInvitation+短期 registrationToken |
| POST /auth/invitations/redeem | registrationToken, invitationCode | 创建会话；绑定邀请码 |
| POST /auth/logout | 当前会话 | 204 |
| GET /me | 当前用户 | id/nickname/avatarAssetId/cityCode/timezone |
| PATCH /me | 允许修改的资料 | 更新后资料 |
| DELETE /me | confirmation=`DELETE_MY_ACCOUNT` | 202 deletion 状态；立即撤销会话 |
| GET /categories | 分类列表 | id/name/sortOrder |
| POST /categories | name | 新分类 |
| PATCH /categories/:id | name/sortOrder | 分类 |
| DELETE /categories/:id | 无引用才能删除 | 204 或 RESOURCE_REFERENCED |
| GET /tags | kind | 标签列表 |
| POST /tags | kind/name | 新标签 |
| PATCH /tags/:id | name/sortOrder | 标签 |
| DELETE /tags/:id | 删除标签并清理关联 | 204 |
| POST /media | multipart：file, purpose | 201 assetId,width,height,mimeType；限制 purpose |
| POST /media/signed-urls | assetIds（最多20） | assetId/url/expiresAt |
| GET /media/content/:id | 短期签名参数 | 文件流，Nginx internal 发送 |
| GET /clothes | q/categoryId/colors/seasons/tagIds/occasionIds/favorite/status/sort/page/pageSize | 衣物列表 |
| POST /clothes | 图片/分类/基本资料；status=draft 或 active | 201 衣物 |
| GET /clothes/:id | 衣物详情 | 资料/图像状态/wearCount/lastWornOn/version |
| PATCH /clothes/:id | version 与允许修改字段 | 修改后衣物 |
| POST /clothes/batch | ids, action, parameters | affectedCount；全量校验后一次事务 |
| GET /clothes/:id/references | 删除前查询引用 | outfits/wearRecords/packingLists 数量与 ID |
| DELETE /clothes/:id | 无引用永久删除 | 204 或 409 |
| POST /image-jobs | inputAssetId/clothingId/kind=process、cutout、classify | 202 jobId/status |
| GET /image-jobs | status/page/pageSize | 当前用户任务列表 |
| GET /image-jobs/:id | 查询状态 | status/phase/result/errorCode |
| POST /image-jobs/:id/cancel | 显式取消 | 202 或 409 状态冲突 |
| POST /image-jobs/:id/retry | 失败任务重新处理 | 202 新任务及 attemptOf |
| GET /outfit-categories | 本人分类 | `{ data: [{ id, name }] }`，按创建时间和 ID 排序 |
| POST /outfit-categories | name（去除首尾空白，1–12 字） | 201 `{ data: { id, name } }`；本人同名返回 409 |
| GET /outfits | q/occasion/categoryId/favorite/page/pageSize | 搭配列表，分类和收藏可组合筛选 |
| POST /outfits | name/backgroundColor/items/categoryId/occasion/seasons/notes | 201 搭配及封面任务；categoryId 可为 null |
| GET /outfits/:id | 详情 | 布局/单品/封面资产/categoryId/categoryName/previewAssets/version |
| PATCH /outfits/:id | version 与字段/完整 items | 更新后的搭配 |
| DELETE /outfits/:id | 删除搭配；穿搭已保存快照 | 204 |
| GET /wear-records | from/to | 日期范围内记录；范围最多366天 |
| POST /wear-records | wornOn/clothingIds 或 outfitId/occasion/bodyAssetId/notes | 201 记录与单品快照 |
| PATCH /wear-records/:id | version 与允许修改内容 | 更新记录 |
| DELETE /wear-records/:id | 删除记录 | 204 |
| GET /statistics | scope=active 或 all | 数量/金额覆盖数/分类/排行/统计口径 |
| GET /packing-lists | page/pageSize | 清单及进度 |
| POST /packing-lists | name/startOn/endOn/clothingIds | 201 清单 |
| GET /packing-lists/:id | 详情 | 去重单品列表/packed/version |
| PATCH /packing-lists/:id | version/name/dates/items | 更新清单 |
| POST /packing-lists/:id/copy | name/startOn/endOn | 201 新清单，packed 全部重置 |
| DELETE /packing-lists/:id | 删除清单 | 204 |
| GET /capabilities | 服务配置可用性和用户额度 | localImage/weather/recommendation/tryOn 状态与原因 |
| GET /weather | source=ip，或 cityCode（高德六位 adcode），或 latitude/longitude（GCJ02 经纬度） | city/current/updatedAt/forecast/source/stale |
| GET /weather-locations | q（中文、拼音或空格分隔关键词）/page/pageSize | data: id/cityCode/name/path；pagination: page/pageSize/total |
| POST /recommendations | occasion/clothingIds/useWeather/consent | 202 externalJob |
| POST /try-ons | bodyAssetId/outfitId/consent | 202 externalJob |
| GET /external-jobs/:id | 任务状态 | 状态/结果资产/候选搭配/收费状态 |
| POST /external-jobs/:id/cancel | 提供商允许时取消 | 可取消性、状态和已知收费说明 |
| DELETE /external-jobs/:id | 清理本人已完成结果 | 204；运行中返回409 |
| POST /data-exports | format=zip | 202 exportId |
| GET /data-exports/:id | 导出状态 | status/assetId/expiresAt/errorCode |

## 天气约定

- 查询参数三选一：`source=ip`，或六位行政区编码 `cityCode`，或同时传入 GCJ02 `latitude`（-90～90）与 `longitude`（-180～180）。入口拒绝混传、空值、缺失及越界坐标。IP 由服务端依据可信代理配置获取，不接受客户端指定；本地、私网、IPv6 及高德未识别到城市时返回 400 `LOCATION_UNAVAILABLE`。坐标通过高德逆地理编码换取 `adcode`，精确坐标不落库，缓存与供应商请求均保留六位小数。
- 地点搜索使用高德官方行政区编码目录，支持地级市、县级市及区县，按原目录顺序稳定分页；`id` 区分地点，`cityCode` 是高德 `adcode`，`path` 展示行政归属。`q` 长度 1～100，`page` 为 1～10000，`pageSize` 为 1～50，默认 20。无匹配时返回空列表和 `total=0`。目录搜索不需要天气密钥，地区是否有预报以高德实际结果为准。
- 天气无地区结果时返回 422 `WEATHER_LOCATION_NOT_SUPPORTED`；高德密钥或接口权限错误返回 503 `AMAP_ACCESS_DENIED`，额度或频率限制返回 503 `AMAP_QUOTA_EXCEEDED`，其他上游故障返回 502 `WEATHER_UNAVAILABLE`。不返回供应商原始响应或含密钥的 URL。
- 可额外传入 `refresh=true` 绕过尚未过期的缓存；省略时复用有效缓存。其他 refresh 值返回 400。
- 高德实况使用 `extensions=base`，返回 `current`：`weather`、`temperature`（摄氏度数值）、`windDirection`、`windPower`、`humidity`（0～100 数值）与 `updatedAt`（供应商实况发布时间，带 `+08:00` 的 ISO 8601 字符串）。首页大字温度使用实况气温。
- 高德预报使用 `extensions=all`，后端选取今天、明天、后天；客户端切换日期时不重复请求。`forecast` 为 1～3 项，包含 `date`、`textDay`、`textNight`、`tempDay`、`tempNight`。日期为上海时区 `YYYY-MM-DD`，温度为摄氏度数值，分别表示白天与夜间温度。
- `updatedAt` 取自高德 `reporttime`，转换成带 `+08:00` 的 ISO 8601 字符串；`source` 为“高德天气”。
- 实况与预报按查询位置共同缓存 10 分钟，上海时区跨日失效；同日缓存过期或手动刷新时查询失败，返回保留原发布时间的 `stale=true` 缓存。没有可用缓存时返回明确错误；缺少地区实况或预报返回 422 `WEATHER_LOCATION_NOT_SUPPORTED`。客户端刷新失败保留原内容并提供重试入口。

## 核心结构示例

```json
{
  "data": {
    "id": "uuid",
    "name": "奶油色针织衫",
    "categoryId": "uuid",
    "primaryAssetId": "uuid",
    "colors": ["cream"],
    "seasons": ["autumn", "winter"],
    "tagIds": [],
    "priceCents": "29900",
    "status": "active",
    "favorite": false,
    "version": 1
  }
}
```

```json
{
  "data": {
    "jobId": "uuid",
    "status": "succeeded",
    "phase": "complete",
    "result": {
      "cutoutAssetId": "uuid",
      "thumbnailAssetId": "uuid",
      "categoryCandidates": [{ "categoryId": "uuid", "rank": 1 }],
      "colors": ["cream"],
      "modelRevision": "fixed-model-revision"
    }
  }
}
```

搭配封面任务由保存搭配接口内部创建，客户端不能任意提交服务端渲染目标。

搭配分类与衣物分类、场景分别维护，均按当前登录用户隔离。`PATCH /outfits/:id` 可使用 `version` 与 `categoryId` 更新分类，传入 null 清除分类；不能关联他人的分类。搭配响应中的 `previewAssets` 为 `{ clothingId, assetId }[]`，用于封面生成期间按已保存布局展示单品，图片仍通过鉴权签名接口获取。V6 迁移新增搭配分类表与关联，已有搭配分类为空，原有场景和穿搭记录不变。

任务结果不包含自动生效的用户字段变更。客户端接受建议后，以 PATCH clothes 和当前 version 保存。

## 状态与错误

| code | 含义 | 页面动作 |
| --- | --- | --- |
| INVITATION_REQUIRED / INVITATION_INVALID | 未绑定成员或邀请码无效 | 邀请码页面 |
| SESSION_EXPIRED | 会话过期 | 重新登录 |
| RESOURCE_NOT_FOUND | 不存在或不属于用户 | 返回列表 |
| RESOURCE_REFERENCED | 存在引用 | 展示引用、归档或处理引用 |
| VERSION_CONFLICT | 数据已变化 | 重新加载并保留未保存输入 |
| IMAGE_TOO_LARGE / IMAGE_UNSUPPORTED | 文件不满足约束 | 更换/压缩图片 |
| IMAGE_PROCESSING_FAILED / JOB_TIMEOUT | 本地处理失败 | 保留原图、手动填写或重试 |
| SERVICE_NOT_CONFIGURED | 外部服务缺配置 | 显示不可用原因 |
| QUOTA_EXCEEDED | 已达额度 | 不重复发起 |
| PROVIDER_PENDING / PROVIDER_FAILED | 外部状态未明或失败 | 查询原任务或按明确规则重试 |

## 轮询与退出

任务页面可见时初始每 3 秒查询；长时间等待可退避到 10 秒，终态停止。页面隐藏/卸载停止本地轮询；返回页面重新取得状态。取消请求与取消任务是两个操作。外部服务状态不明不得通过重新发起 POST 代替查询。

## 契约验证

按端点验证归属、正常响应、非法输入、版本冲突、状态冲突和重复请求。上传还需验证真实文件内容、解码尺寸、私有访问与过期链接。接口文档在实现时生成对应的类型/校验代码，任何示例 UUID 均为占位字符串，不能作为真实测试数据。

## 必须一起实现的输入约束

- 衣物 active 必须有本人可用主图与分类；draft 允许分类未填，图片上传完成后才可引用。颜色/季节为允许集合，价格解析为非负整数分字符串；名称上限60字、备注上限1000字。
- 批量衣物操作单次最多50个唯一ID；action 仅允许 change-category/add-tags/remove-tags/archive/restore。逐项携带当前 version，任一越权/版本冲突时整个事务失败，返回冲突ID列表。
- 画布 items 为1–12个不同 clothingId；坐标定义以数据设计为准，变换后的可见边界在保存前裁定。创建新引用只允许 active 衣物；原有引用中的归档衣物可保留并显示状态，不能以此加入其他衣物。
- 穿搭创建时 clothingIds 与 outfitId 二选一；服务端解析实际单品并保存快照，日期不能在用户时区的未来。更新记录传最终 clothingIds，保留原 sourceOutfitId 仅用于追溯。
- GET wear-records 的 from/to 必填，最多366天，响应为日期范围集合且不分页；界面按月请求。其他列表遵循统一分页，分类/标签可限制为每用户最多100项并一次返回。
- 分类迁移先通过批量衣物接口改分类，再删除无引用分类；场景/风格标签删除仅清理当前标签关联，历史场景文本保持不变。
- DELETE external-jobs 只删除可清理的结果和用户可见内容；保留最少必要的幂等/费用记录至规定周期，不能因删结果而允许同一次付费操作重复结算。

## 本地实现补充（2026-11-12）

- 微信 `wx.request` 不支持 PATCH，客户端使用 POST 并设置 `X-HTTP-Method-Override: PATCH`。后端只接受此明确组合；标准 HTTP PATCH 仍可使用。
- `POST /api/media/signed-urls` 接收 `assetIds`（最多20个）及 `variant: original | thumbnail`，默认 original。响应的 assetId 对应请求 ID，URL 指向实际选用的媒体。
- `POST /api/categories/reorder` 与 `POST /api/tags/reorder` 接收 `{ items: [{ id, version }] }`，需提交该用户完整列表，在一个事务内完成排序；成功204，版本或集合冲突409。
- 衣物列表支持 `status=all-saved`，同时展示 active 与 archived，供“显示归档衣物”偏好使用；draft 由明确的草稿入口查询。
- 未配置微信 AppSecret 时登录返回503 `WECHAT_NOT_CONFIGURED`；天气密钥缺失与未选定的外部服务返回503 `SERVICE_NOT_CONFIGURED`。
- 衣橱统计摘要由 `GET /api/statistics?scope=active|all` 返回；明细单独通过 `GET /api/statistics/clothes?scope=active|all&page=1&pageSize=20` 分页，使用标准 `{ data: [...], pagination }` 结构。摘要另含 `wornDays`（本人有记录的不同日期数）与 `outfitCount`（本人搭配数）。明细支持 `sort=least-worn|most-worn`，默认 least-worn，按穿着天数及唯一 ID 稳定排序。

- 衣橱筛选：`colors`、`seasons`、`occasionIds` 使用逗号分隔多选值，各字段之间同时满足，同一字段内匹配任一选项。`occasionIds` 仅匹配本人场景标签；四季衣物也匹配春/夏/秋/冬。原有 `tagIds` 保持匹配全部指定标签。
