'use strict';

const icon = (name, small = false) => `<img class="icon${small ? ' small' : ''}" src="assets/icons/${name}.svg" alt="" aria-hidden="true">`;
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const photo = item => item.uploadPreview || `assets/clothes/${item.asset}.svg`;
const today = '2026-11-12';
const screens = [
  ['wardrobe', '我的衣橱', '图片优先的个人衣橱。搜索、分类与收藏组合筛选，新增入口保持明确。', ['切换分类或搜索“针织”', '点击衣物查看详情', '点击右上角添加衣物']],
  ['clothing-edit', '添加衣物', '保留原图，后台抠图与识别提供候选。录入的基础信息可以随时编辑。', ['选择本地图片，仅在原型内预览', '修改名称和分类后保存', '从状态条进入图片任务']],
  ['clothing-detail', '衣物详情', '大图与资料集中展示，穿着数据能追溯到日历，归档保留历史。', ['收藏这件衣物', '加入搭配', '查看更多操作与归档']],
  ['jobs', '图片处理', '异步任务有独立状态，离开页面继续处理。示例按钮仅模拟状态推进。', ['启动演示处理', '检查失败与重试状态', '完成后确认候选资料']],
  ['outfits', '我的搭配', '搭配以完整画布呈现，场景与名称帮助快速选择。', ['查看搭配详情', '新建一套搭配', '收藏喜欢的组合']],
  ['outfit-edit', '搭配编辑', '自动排版提供起点。拖动、缩放、旋转和层级均保持在独立画布内。', ['拖动一件衣物', '点击工具调整位置与大小', '从底部添加单品并保存']],
  ['outfit-detail', '搭配详情', '搭配收藏、记录穿着、导出和试穿集中在同一页面。', ['记录今天穿过', '编辑搭配', '查看试穿入口']],
  ['calendar', '穿搭日历', '一件衣物同一天只统计一次。保存搭配与实际穿着是两个不同操作。', ['点击有圆点的日期', '切换月份', '添加一条穿搭记录']],
  ['wear-edit', '记录穿搭', '日期、场景和实际穿过的单品组成一条记录，支持补记和修改。', ['修改日期与场景', '选择一套搭配', '保存并返回日历']],
  ['statistics', '衣橱统计', '所有数字来自演示数据计算。价格缺失、零次穿着与范围都有独立说明。', ['查看分类占比', '查看少穿衣物', '进入单品详情']],
  ['packing-lists', '出行清单', '从自己的衣橱整理旅行或出差衣物，打包进度直接可见。', ['打开清单', '新建一个清单', '查看勾选进度']],
  ['packing-detail', '清单详情', '同一件衣物自动去重，打包状态与衣物资料独立保存。', ['勾选已经收好的衣物', '加入更多衣物', '复制清单']],
  ['profile', '我的', '低频管理集中于此。统计、清单、智能能力与设置可以直接进入。', ['打开统计或旅行清单', '管理分类标签', '查看数据导出与账号设置']],
  ['taxonomy', '分类与标签', '分类和标签属于各自用户，删除使用中的分类时明确显示限制。', ['切换分类与场景标签', '新增标签', '检查使用中分类删除提示']],
  ['settings', '设置与数据', '个人资料、服务状态、导出与注销保持可理解，密钥不进入产品界面。', ['编辑昵称', '导出演示数据', '查看注销确认说明']],
  ['recommendations', '智能搭配', '天气与推荐为演示内容。正式接入需明确服务、额度与授权。', ['选择场景', '生成示例搭配', '保存建议为搭配']],
  ['try-on', '虚拟试穿', '发起前说明图像发送范围，结果仅作生成示意。原型不发送任何照片。', ['查看使用照片和搭配', '确认后生成示例结果', '切换未配置状态']],
  ['welcome', '登录与准入', '私人衣橱通过微信身份和一次性邀请码准入。原型登录不连接微信。', ['点击微信登录', '输入演示邀请码', '进入个人衣橱']],
];
const initialClothes = [
  { id: 'c1', name: '奶油色针织衫', category: '上装', color: '奶油白', asset: 'cream-knit', price: 299, favorite: true, season: '秋 / 冬', bg: '#f8f9fb' },
  { id: 'c8', name: '砂色百褶半裙', category: '下装', color: '砂色', asset: 'sand-skirt', price: 239, favorite: false, season: '春 / 秋', bg: '#f8f9fb' },
  { id: 'c5', name: '柔白棉质衬衫', category: '上装', color: '米白', asset: 'white-shirt', price: 269, favorite: false, season: '四季', bg: '#f8f9fb' },
  { id: 'c10', name: '日常小白鞋', category: '鞋履', color: '白色', asset: 'white-sneakers', price: 329, favorite: false, season: '四季', bg: '#f8f9fb' },
  { id: 'c2', name: '雾蓝直筒牛仔裤', category: '下装', color: '雾蓝', asset: 'blue-jeans', price: 359, favorite: false, season: '四季', bg: '#f8f9fb' },
  { id: 'c3', name: '经典驼色风衣', category: '外套', color: '驼色', asset: 'camel-coat', price: 899, favorite: true, season: '春 / 秋', bg: '#f8f9fb' },
  { id: 'c4', name: '苔绿针织开衫', category: '上装', color: '苔绿', asset: 'sage-cardigan', price: 329, favorite: false, season: '秋 / 冬', bg: '#f8f9fb' },
  { id: 'c6', name: '可可色通勤托特包', category: '包袋', color: '可可棕', asset: 'brown-tote', price: 499, favorite: true, season: '四季', bg: '#f8f9fb' },
  { id: 'c7', name: '黑色吊带连衣裙', category: '连衣裙', color: '黑色', asset: 'black-dress', price: 399, favorite: false, season: '春 / 夏', bg: '#f8f9fb' },
  { id: 'c9', name: '棕色乐福鞋', category: '鞋履', color: '棕色', asset: 'brown-loafers', price: 429, favorite: true, season: '四季', bg: '#f8f9fb' },
  { id: 'c11', name: '橄榄绿休闲长裤', category: '下装', color: '橄榄绿', asset: 'olive-pants', price: 299, favorite: false, season: '春 / 秋', bg: '#f8f9fb' },
  { id: 'c12', name: '燕麦色柔软围巾', category: '配饰', color: '燕麦色', asset: 'cream-scarf', price: null, favorite: false, season: '秋 / 冬', bg: '#f8f9fb' },
];
const initialRecords = [
  { id: 'r1', date: '2026-11-12', occasion: '日常通勤', items: ['c1', 'c2', 'c6', 'c9'], note: '舒适地开始一天。' },
  { id: 'r2', date: '2026-11-10', occasion: '日常通勤', items: ['c5', 'c2', 'c3', 'c9'], note: '早晚加一件风衣。' },
  { id: 'r3', date: '2026-11-08', occasion: '周末出游', items: ['c4', 'c11', 'c10'], note: '公园散步。' },
  { id: 'r4', date: '2026-11-06', occasion: '日常通勤', items: ['c1', 'c8', 'c9'], note: '' },
  { id: 'r5', date: '2026-11-04', occasion: '日常通勤', items: ['c5', 'c2', 'c6'], note: '' },
  { id: 'r6', date: '2026-11-02', occasion: '朋友聚会', items: ['c4', 'c8', 'c9'], note: '' },
  { id: 'r7', date: '2026-10-29', occasion: '日常通勤', items: ['c1', 'c2', 'c10'], note: '' },
];
const params = new URLSearchParams(location.search);
const state = {
  screen: location.hash.slice(1) || params.get('screen') || 'wardrobe', demoState: 'normal', category: '全部', query: '', onlyFavorites: false, archived: false,
  clothes: initialClothes.map(item => ({ ...item, archived: false })), records: initialRecords.map(item => ({ ...item, items: [...item.items] })), selectedId: 'c1', selectedOutfit: 0,
  outfits: [{ name: '把日常穿得温柔一点', occasion: '日常通勤', items: ['c1', 'c2', 'c6', 'c9'], favorite: true }, { name: '周末，慢慢走', occasion: '周末出游', items: ['c4', 'c11', 'c10'], favorite: false }],
  canvasItems: ['c1', 'c2', 'c6', 'c9'], canvasSelected: 'c1', canvasLayout: {}, canvasHistory: [], outfitName: '把日常穿得温柔一点', editorIndex: null,
  calendarYear: 2026, calendarMonth: 10, selectedDate: today, wearDate: today, wearOccasion: '日常通勤', wearNote: '', wearRecordId: null,
  form: { name: '奶油色针织衫', category: '上装', color: '奶油白', price: '', notes: '' }, uploadPreview: '', editingId: null,
  jobState: 'queued', jobTimer: null, services: true, aiReady: false, aiLoading: false, aiOccasion: '日常通勤', tryOnReady: false, tryOnConsent: false,
  categories: ['上装', '下装', '外套', '连衣裙', '鞋履', '包袋', '配饰'], tags: ['日常通勤', '周末出游', '朋友聚会', '运动休闲'], taxonomyTab: '分类', nickname: '小鹿', showDataInfo: false,
  packingLists: [{ name: '周末，去山里走走', date: '11.14 — 11.15', items: ['c1', 'c2', 'c3', 'c10', 'c12'], packed: ['c1', 'c2'] }], selectedPacking: 0,
};
if (params.get('embed') === '1') document.body.classList.add('embed');
const app = document.getElementById('app');
const findClothing = id => state.clothes.find(item => item.id === id);
const wearCount = id => new Set(state.records.filter(record => record.items.includes(id)).map(record => record.date)).size;
const activeClothes = () => state.clothes.filter(item => !item.archived);
const currentOutfit = () => state.outfits[state.selectedOutfit];
const heading = (title, subtitle, action = '') => `<div class="page-top"><div><h1>${title}</h1><p class="subtitle">${subtitle}</p></div>${action}</div>`;
const goButton = (screen, label, name = 'plus') => `<button class="icon-button soft" data-action="go" data-screen="${screen}" aria-label="${label}">${icon(name)}</button>`;
const backLine = (title, screen) => `<div class="back-line"><button data-action="go" data-screen="${screen}" aria-label="返回">${icon('back')}</button><span>${title}</span></div>`;
const chips = (items, selected, action) => `<div class="chips">${items.map(item => `<button class="chip${item === selected ? ' active' : ''}" data-action="${action}" data-value="${escapeHtml(item)}" aria-pressed="${item === selected}">${escapeHtml(item)}</button>`).join('')}</div>`;
const menuRow = (name, text, screen, detail = '') => `<button class="row-item" data-action="go" data-screen="${screen}">${icon(name)}<div class="row-copy"><h3>${text}</h3>${detail ? `<p>${detail}</p>` : ''}</div>${icon('chevron', true)}</button>`;
function toast(message) {
  const element = document.getElementById('toast');
  element.textContent = message;
  element.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('visible'), 3000);
}
function openModal(title, content) {
  document.getElementById('modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><div class="modal-heading"><h2>${title}</h2><button class="icon-button" data-action="close-modal" aria-label="关闭">${icon('close')}</button></div>${content}</section></div>`;
}
const closeModal = () => { document.getElementById('modal-root').innerHTML = ''; };
function navigate(screen) {
  state.screen = screen;
  history.replaceState(null, '', `${location.pathname}${location.search}#${screen}`);
  closeModal();
  render();
  app.scrollTop = 0;
}
function clothingCard(item) {
  return `<article class="clothing-card"><button class="clothing-visual" style="background:${item.bg};width:100%" data-action="clothing" data-id="${item.id}" aria-label="查看${escapeHtml(item.name)}"><img class="garment" src="${item.uploadPreview || photo(item)}" alt="${escapeHtml(item.name)}"></button><button class="heart-button icon-button${item.favorite ? ' selected' : ''}" data-action="favorite" data-id="${item.id}" aria-label="${item.favorite ? '取消收藏' : '收藏'}${escapeHtml(item.name)}" aria-pressed="${item.favorite}">${icon(item.favorite ? 'heart-filled' : 'heart', true)}</button><h3>${escapeHtml(item.name)}</h3><p><span class="label-dot"></span>${item.category} · ${item.color}</p></article>`;
}
function wardrobeResults() {
  const items = state.clothes.filter(item => item.archived === state.archived && (state.category === '全部' || item.category === state.category) && (!state.onlyFavorites || item.favorite) && `${item.name}${item.category}${item.color}`.includes(state.query.trim()));
  if (state.demoState === 'loading') return `<div class="clothes-grid">${[0,1,2,3].map(() => '<div><div class="skeleton"></div><div class="skeleton-line"></div></div>').join('')}</div>`;
  if (state.demoState === 'error') return `<div class="empty-state">${icon('wifi')}<h2>暂时没能加载衣橱</h2><p>你的衣物都还在，请稍后重试。</p><button class="secondary-button" data-action="reset-state">重新加载</button></div>`;
  if (state.demoState === 'empty' || !items.length) return `<div class="empty-state">${icon('shirt')}<h2>${state.query || state.category !== '全部' ? '暂时没有匹配的衣物' : '给喜欢的衣物一个位置'}</h2><p>${state.query || state.category !== '全部' ? '换个分类，或清除筛选再看看。' : '拍下第一件衣物，慢慢整理属于你的日常。'}</p><button class="secondary-button" data-action="${state.query || state.category !== '全部' ? 'clear-filters' : 'new-clothing'}">${state.query || state.category !== '全部' ? '清除筛选' : '添加衣物'}</button></div>`;
  return `<div class="section-head" style="margin-top:2px"><span class="count-note">${items.length} 件${state.onlyFavorites ? '收藏' : '单品'}</span><button class="text-button" data-action="manage-wardrobe">整理衣橱 ${icon('chevron', true)}</button></div><div class="clothes-grid">${items.map(clothingCard).join('')}</div>`;
}
function wardrobe() {
  return `${heading(state.archived ? '归档衣物' : '我的衣橱', '把喜欢的衣物，穿进每一天。', `<button class="icon-button primary" data-action="new-clothing" aria-label="添加衣物">${icon('plus')}</button>`)}${state.archived ? '<div class="archive-banner">归档保留历史记录，衣物随时可以恢复。<button class="text-button" data-action="show-active">返回日常衣橱</button></div>' : ''}<div class="search-row"><label class="search-box">${icon('search', true)}<input id="wardrobe-search" aria-label="搜索衣物" placeholder="寻找一件衣物…" value="${escapeHtml(state.query)}"></label><button class="filter-button" data-action="filter" aria-label="筛选衣物">${icon('filter', true)}</button></div>${chips(['全部', ...state.categories], state.category, 'category')}<div id="wardrobe-results">${wardrobeResults()}</div>`;
}
function clothingDetail() {
  const item = findClothing(state.selectedId);
  const count = wearCount(item.id);
  return `${backLine('衣物详情', 'wardrobe')}<div class="detail-hero" style="background:${item.bg}"><img class="garment" src="${item.uploadPreview || photo(item)}" alt="${escapeHtml(item.name)}"><span class="mini-badge">${icon('check', true)} ${item.archived ? '已归档' : '衣橱单品'}</span></div><div class="detail-title"><div><h1>${escapeHtml(item.name)}</h1><p>${item.category} · ${item.color}</p></div><button class="icon-button soft" data-action="favorite" data-id="${item.id}" aria-label="收藏" aria-pressed="${item.favorite}">${icon(item.favorite ? 'heart-filled' : 'heart')}</button></div><div class="tag-row"><span class="soft-tag">${item.season}</span><span class="soft-tag">日常通勤</span></div><div class="stats-inline"><div><strong>${count}<small style="font-size:12px"> 次</small></strong><span>已记录穿着日</span></div><div><strong>${item.price === null ? '—' : `¥${item.price}`}</strong><span>购入价格</span></div><div><strong>${item.price === null || !count ? '—' : `¥${(item.price / count).toFixed(2)}`}</strong><span>每次穿着成本</span></div></div><div class="info-list"><div class="info-line"><span>备注</span><span>${escapeHtml(item.notes || '好穿，也值得被好好记录。')}</span></div><div class="info-line"><span>图片</span><span>${item.uploadPreview ? '本地选择的图片' : '示例衣物插画'}</span></div></div><button class="primary-button" data-action="add-to-outfit" data-id="${item.id}">${icon('layers')}用它搭配</button><div class="actions-row"><button class="secondary-button" data-action="edit-clothing">${icon('edit', true)}编辑资料</button><button class="secondary-button" data-action="clothing-more">${icon('more', true)}更多</button></div>`;
}
function clothingEdit() {
  return `${backLine(state.editingId ? '编辑衣物' : '添加衣物', 'wardrobe')}<form id="clothing-form"><button type="button" class="upload-card" style="width:100%" data-action="choose-photo"><img class="preview" src="${state.uploadPreview || 'assets/clothes/cream-knit.svg'}" alt="衣物照片预览"><span class="upload-label">${icon('camera')}选择或更换照片</span></button><button type="button" class="status-box" style="width:100%;text-align:left" data-action="go" data-screen="jobs">${icon('sparkles')}<div>抠图与识别，帮你少填一点<p>示例候选：上装 · 奶油白，可随时修改</p></div>${icon('chevron', true)}</button><div class="form-field"><label for="clothing-name">衣物名称 · 选填</label><input id="clothing-name" name="name" value="${escapeHtml(state.form.name)}" maxlength="60" placeholder="为它取个容易找到的名字"></div><div class="form-field"><label for="clothing-category">分类 · 必填</label><select id="clothing-category" name="category"><option value="">请选择分类</option>${state.categories.map(value => `<option${state.form.category === value ? ' selected' : ''}>${value}</option>`).join('')}</select></div><div class="form-label">主要颜色</div><div class="color-options">${[['奶油白','#e5d8bc'],['苔绿','#929d86'],['雾蓝','#668493'],['黑色','#414940'],['棕色','#987858']].map(([name,color])=>`<button type="button" aria-label="${name}" class="${state.form.color === name ? 'active' : ''}" style="--swatch:${color}" data-action="color" data-value="${name}"></button>`).join('')}</div><div class="field-pair"><div class="form-field"><label for="price">购买价格 · 选填</label><input id="price" name="price" type="number" min="0" step=".01" placeholder="¥ 未填写" value="${escapeHtml(state.form.price)}"></div><div class="form-field"><label for="season">适合季节</label><select id="season">${['秋 / 冬','四季','春 / 夏','春 / 秋'].map(value=>`<option${value===(state.form.season||'秋 / 冬')?' selected':''}>${value}</option>`).join('')}</select></div></div><button type="button" class="text-button" data-action="more-fields">更多资料：品牌、尺码、备注 ${icon('chevron', true)}</button><p class="field-error" id="form-error" role="alert"></p><div class="form-actions"><button class="primary-button" type="submit">保存到我的衣橱</button><p class="form-hint">图片与资料只属于你</p></div></form>`;
}
function jobs() {
  const messages = { queued:['等待处理','图片已保存，正在等待本地图像处理。'], running:['处理中','正在生成透明背景和分类候选。'], succeeded:['处理完成','确认结果后使用，资料仍可手动修改。'], failed:['这张照片需要再试一次','保留原图，换张背景更简单的照片也可以。'], cancelled:['已取消处理','原图已保留，可以继续手动填写。'] };
  const [title, description] = messages[state.jobState];
  return `${backLine('图片处理', 'clothing-edit')}${heading('让衣物更清晰', '照片整理好，搭配也更轻松。')}<div class="detail-hero"><img class="garment" src="assets/clothes/cream-knit.svg" alt="处理结果示意"><span class="mini-badge">示例插画 · 状态演示</span></div><div class="status-box ${state.jobState === 'failed' ? 'error' : ''}">${icon(state.jobState === 'succeeded' ? 'check' : 'clock')}<div>${title}<p>${description}</p></div></div>${state.jobState === 'succeeded' ? '<div class="tag-row"><span class="soft-tag">分类建议：上装</span><span class="soft-tag">主色建议：奶油白</span></div><button class="primary-button" data-action="accept-suggestions">使用这些建议</button>' : `<button class="primary-button" data-action="run-job" ${state.jobState === 'running' ? 'disabled' : ''}>${state.jobState === 'running' ? '正在处理…' : '开始处理演示'}</button>`}<div class="actions-row"><button class="secondary-button" data-action="job-fail">查看失败状态</button><button class="secondary-button" data-action="job-cancel">取消任务</button></div><p class="form-hint" style="margin-top:18px">离开页面后，正式产品的处理任务会继续；当前原型只演示交互状态。</p>`;
}
function defaultLayout(ids) {
  const positions = [{x:.08,y:.15,w:.5,h:.54},{x:.47,y:.15,w:.48,h:.75},{x:.03,y:.59,w:.44,h:.36},{x:.44,y:.7,w:.53,h:.28}];
  return Object.fromEntries(ids.map((id,index) => [id,{ ...(positions[index] || {x:.15 + (index%3)*.2,y:.18 + Math.floor(index/3)*.18,w:.35,h:.4}), rotation:0,z:index }]));
}
function outfitVisual(outfit, large = false) {
  const layout = outfit.layout || defaultLayout(outfit.items);
  return `<div class="outfit-cover"${large ? ' data-size="large"' : ''}>${outfit.items.map(id => { const item = findClothing(id); const box = layout[id]; return `<img class="garment" src="${photo(item)}" alt="${escapeHtml(item.name)}" style="left:${box.x*100}%;top:${box.y*100}%;width:${box.w*100}%;height:${box.h*100}%;transform:rotate(${box.rotation}deg);z-index:${box.z}">`; }).join('')}</div>`;
}
function outfits() {
  return `${heading('我的搭配', '让每一次出门，都有一点期待。', `<button class="icon-button primary" data-action="new-outfit" aria-label="新建搭配">${icon('plus')}</button>`)}${chips(['全部', '日常通勤', '周末出游'], state.outfitFilter || '全部', 'outfit-filter')}<div class="outfits-grid">${state.outfits.map((outfit,index)=>({outfit,index})).filter(({outfit})=>!state.outfitFilter || state.outfitFilter === '全部' || outfit.occasion === state.outfitFilter).map(({outfit,index})=>`<button class="outfit-card" data-action="outfit" data-index="${index}">${outfitVisual(outfit)}<div class="outfit-info"><div><h3>${escapeHtml(outfit.name)}</h3><p>${outfit.occasion} · ${outfit.items.length} 件单品</p></div>${icon('arrow')}</div></button>`).join('')}</div>`;
}
function canvasMarkup() {
  return `<span class="canvas-mark">我的搭配画布</span>${state.canvasItems.map(id => { const item=findClothing(id); const box=state.canvasLayout[id]; return `<button class="canvas-item${state.canvasSelected === id ? ' selected' : ''}" data-canvas-id="${id}" aria-label="拖动${escapeHtml(item.name)}" style="left:${box.x*100}%;top:${box.y*100}%;width:${box.w*100}%;height:${box.h*100}%;transform:rotate(${box.rotation}deg);z-index:${box.z}"><img src="${photo(item)}" alt="${escapeHtml(item.name)}" draggable="false"></button>`; }).join('')}`;
}
function outfitEdit() {
  if (!Object.keys(state.canvasLayout).length) state.canvasLayout = defaultLayout(state.canvasItems);
  return `${backLine('编辑搭配', 'outfits')}<div class="form-field" style="margin-top:8px"><label for="outfit-name">搭配名称</label><input id="outfit-name" value="${escapeHtml(state.outfitName)}" maxlength="60"></div><div class="canvas" id="outfit-canvas">${canvasMarkup()}</div><div class="canvas-tools"><button data-action="layout-auto">${icon('grid')}排版</button><button data-action="canvas-scale" data-factor="1.12">${icon('plus')}放大</button><button data-action="canvas-scale" data-factor="0.89">${icon('minus')}缩小</button><button data-action="canvas-rotate">${icon('rotate')}旋转</button><button data-action="canvas-front">${icon('layers')}置顶</button><button data-action="canvas-undo">${icon('undo')}撤销</button><button data-action="canvas-remove">${icon('trash')}移除</button></div><div class="section-head" style="margin-top:0"><h2>从衣橱里挑选</h2><span class="count-note">已选 ${state.canvasItems.length} 件</span></div><div class="mini-closet">${activeClothes().map(item=>`<button class="mini-item${state.canvasItems.includes(item.id) ? ' active' : ''}" data-action="canvas-add" data-id="${item.id}" aria-label="添加${escapeHtml(item.name)}"><img src="${photo(item)}" alt="${escapeHtml(item.name)}"></button>`).join('')}</div><button class="primary-button" data-action="save-outfit" style="margin-top:16px">保存这套搭配</button>`;
}
function outfitDetail() {
  const outfit = currentOutfit();
  return `${backLine('搭配详情', 'outfits')}${outfitVisual(outfit,true)}<div class="detail-title"><div><h1>${escapeHtml(outfit.name)}</h1><p>${outfit.occasion} · ${outfit.items.length} 件单品</p></div><button class="icon-button soft" data-action="outfit-favorite" aria-label="收藏搭配" aria-pressed="${outfit.favorite}">${icon(outfit.favorite ? 'heart-filled' : 'heart')}</button></div><div class="tag-row"><span class="soft-tag">舒适日常</span><span class="soft-tag">秋日</span></div><button class="primary-button" data-action="record-outfit">${icon('calendar')}记录今天穿过</button><div class="actions-row"><button class="secondary-button" data-action="edit-outfit">${icon('edit',true)}编辑</button><button class="secondary-button" data-action="go" data-screen="try-on">${icon('sparkles',true)}试穿</button></div><button class="text-button" style="margin:18px auto" data-action="export-outfit">${icon('download',true)}导出搭配展示图</button>`;
}
function dateText(date) { const [year,month,day]=date.split('-').map(Number); return `${month}月${day}日`; }
function calendar() {
  const first = (new Date(state.calendarYear,state.calendarMonth,1).getDay()+6)%7;
  const days = new Date(state.calendarYear,state.calendarMonth+1,0).getDate();
  const prefix = `${state.calendarYear}-${String(state.calendarMonth+1).padStart(2,'0')}`;
  const records = state.records.filter(record=>record.date===state.selectedDate);
  return `${heading('穿搭日历', '把穿过的日子，好好收藏。', `<button class="icon-button soft" data-action="new-record" aria-label="记录穿搭">${icon('plus')}</button>`)}<div class="month-heading"><button data-action="month" data-delta="-1" aria-label="上个月">${icon('back')}</button><h2>${state.calendarYear} 年 ${state.calendarMonth+1} 月</h2><button data-action="month" data-delta="1" aria-label="下个月">${icon('arrow')}</button></div><div class="weekdays">${['一','二','三','四','五','六','日'].map(value=>`<span>${value}</span>`).join('')}</div><div class="days">${Array.from({length:first},()=>'<span class="blank"></span>').join('')}${Array.from({length:days},(_,index)=>{const date=`${prefix}-${String(index+1).padStart(2,'0')}`;return `<button class="${date===today?'today ':''}${date===state.selectedDate?'selected ':''}${state.records.some(record=>record.date===date)?'has-record':''}" data-action="day" data-date="${date}" aria-label="${date}${state.records.some(record=>record.date===date)?' 有穿搭记录':''}" aria-pressed="${date===state.selectedDate}">${index+1}</button>`;}).join('')}</div><p class="calendar-legend"><i></i>有穿搭记录的日子</p><div class="section-head"><h2>${dateText(state.selectedDate)}</h2><span class="count-note">${records.length} 条记录</span></div>${records.length ? records.map(record=>`<button class="record-card" style="width:100%;text-align:left" data-action="edit-record" data-id="record:${record.id}"><div class="record-head"><strong>${record.occasion}</strong><span>已记录</span></div><div class="record-items">${record.items.slice(0,4).map(id=>`<img src="${photo(findClothing(id))}" alt="${escapeHtml(findClothing(id).name)}">`).join('')}</div><p class="record-note">${escapeHtml(record.note || '值得记住的日常穿搭。')}</p></button>`).join('') : '<div class="record-card"><p class="form-hint">这一天还没有记录。留下穿搭，慢慢认识自己的喜好。</p></div>'}<button class="secondary-button" data-action="new-record" style="margin-top:15px">${icon('plus',true)}记下这一天</button>`;
}
function wearEdit() {
  const outfit = state.wearItems ? { items: state.wearItems } : currentOutfit();
  return `${backLine(state.wearRecordId ? '编辑记录' : '记录穿搭','calendar')}<form id="wear-form"><div class="form-field"><label for="wear-date">穿着日期</label><input id="wear-date" type="date" max="${today}" value="${state.wearDate}" required></div><div class="form-field"><label for="wear-occasion">今天的场景</label><select id="wear-occasion">${state.tags.map(value=>`<option${value===state.wearOccasion?' selected':''}>${value}</option>`).join('')}</select></div><div class="section-head"><h2>今天穿了这一套</h2><button class="text-button" type="button" data-action="choose-wear-outfit">更换 ${icon('chevron',true)}</button></div>${outfitVisual(outfit)}<div class="form-field"><label for="wear-note">留一句话 · 选填</label><textarea id="wear-note" placeholder="这套搭配，穿起来感觉如何？">${escapeHtml(state.wearNote)}</textarea></div><button class="primary-button" type="submit">保存穿搭记录</button>${state.wearRecordId ? '<button type="button" class="text-button" style="margin:16px auto;color:var(--danger)" data-action="delete-record">删除这条记录</button>' : ''}</form>`;
}
function statistics() {
  const items=activeClothes();
  const priced=items.filter(item=>item.price!==null);
  const total=priced.reduce((sum,item)=>sum+item.price,0);
  const dates=new Set(state.records.map(record=>record.date)).size;
  return `${backLine('衣橱统计','profile')}${heading('多了解一点自己', '每一次真实记录，都有迹可循。')}<div class="metric-grid"><div class="metric accent"><strong>${items.length}</strong><span>日常衣橱 · 件</span></div><div class="metric"><strong>${dates}</strong><span>已记录穿搭 · 天</span></div><div class="metric"><strong>¥${total.toLocaleString()}</strong><span>已知购入金额</span></div><div class="metric"><strong>${state.outfits.length}</strong><span>已保存搭配 · 套</span></div></div><p class="form-hint">统计正常状态衣物；${priced.length}/${items.length} 件填写价格。穿着按每件衣物的不同日期计数。</p><div class="section-head"><h2>衣橱的组成</h2><span class="count-note">${items.length} 件</span></div><div class="bar-chart">${state.categories.map(category=>({category,count:items.filter(item=>item.category===category).length})).filter(item=>item.count).map(item=>`<div class="bar-row"><span>${item.category}</span><div class="bar-track"><div class="bar-fill" style="width:${item.count/items.length*100}%"></div></div><span>${item.count}</span></div>`).join('')}</div><div class="section-head"><h2>给它们一个出场机会</h2></div>${[...items].sort((a,b)=>wearCount(a.id)-wearCount(b.id)).slice(0,3).map(item=>`<button class="row-item" data-action="clothing" data-id="${item.id}"><img class="thumb" src="${photo(item)}" alt=""><div class="row-copy"><h3>${item.name}</h3><p>${wearCount(item.id)?`记录了 ${wearCount(item.id)} 个穿着日`:'尚未记录穿着'}</p></div>${icon('chevron',true)}</button>`).join('')}`;
}
function packingLists() {
  return `${backLine('出行清单','profile')}${heading('轻装，去喜欢的地方', '带上合适的衣物，也带上好心情。', `<button class="icon-button soft" data-action="new-packing" aria-label="新建清单">${icon('plus')}</button>`)}${state.packingLists.map((list,index)=>`<button class="packing-card" data-action="packing" data-index="${index}">${icon('suitcase')}<h2>${escapeHtml(list.name)}</h2><p>${escapeHtml(list.date)} · ${list.items.length} 件衣物</p><div class="progress"><span style="width:${list.items.length ? list.packed.length/list.items.length*100 : 0}%"></span></div><p style="margin-top:10px">已收好 ${list.packed.length} / ${list.items.length} 件</p></button>`).join('')}<button class="secondary-button" data-action="new-packing" style="margin-top:20px">${icon('plus',true)}创建新的清单</button>`;
}
function packingDetail() {
  const list=state.packingLists[state.selectedPacking];
  return `${backLine('清单详情','packing-lists')}${heading(escapeHtml(list.name), `${escapeHtml(list.date)} · ${list.items.length} 件衣物`)}<div class="status-box">${icon('suitcase')}<div>已经收好 ${list.packed.length} 件<p>${list.packed.length===list.items.length && list.items.length ? '都准备好了，出发吧。' : '一件一件勾选，出门更从容。'}</p></div></div>${list.items.map(id=>{const item=findClothing(id);return `<button class="row-item" data-action="packed" data-id="${id}" aria-pressed="${list.packed.includes(id)}"><img class="thumb" src="${photo(item)}" alt=""><div class="row-copy"><h3>${item.name}</h3><p>${item.category} · ${item.color}</p></div><span class="check-control${list.packed.includes(id)?' checked':''}">${list.packed.includes(id)?icon('check'):''}</span></button>`;}).join('')}<button class="secondary-button" data-action="packing-add" style="margin-top:20px">${icon('plus',true)}从衣橱添加</button><button class="text-button" data-action="packing-copy" style="margin:18px auto">${icon('copy',true)}复制这份清单</button>`;
}
function profile() {
  return `<div class="profile-head"><div class="avatar">${icon('user')}</div><div><h1>${escapeHtml(state.nickname)}的日常</h1><p>慢慢整理，认真喜欢。</p></div></div><div class="profile-metrics"><div><strong>${activeClothes().length}</strong><span>件衣物</span></div><div><strong>${state.outfits.length}</strong><span>套搭配</span></div><div><strong>${new Set(state.records.map(record=>record.date)).size}</strong><span>个穿着日</span></div></div><p class="eyebrow">我的日常</p><div class="menu-list">${menuRow('chart','衣橱统计','statistics')}${menuRow('suitcase','出行清单','packing-lists')}${menuRow('tag','分类与标签','taxonomy')}<button class="row-item" data-action="show-archive">${icon('archive')}<div class="row-copy"><h3>归档衣物</h3></div>${icon('chevron',true)}</button></div><p class="eyebrow" style="margin-top:25px">一点穿搭灵感</p><div class="menu-list">${menuRow('sparkles','智能搭配','recommendations','从自己的衣橱里，找一点新灵感')}${menuRow('wand','虚拟试穿','try-on')}${menuRow('clock','图片处理任务','jobs')}</div><div class="menu-list">${menuRow('settings','设置与数据','settings')}</div><p class="form-hint profile-private" style="text-align:center;margin:22px 0">${icon('lock',true)}<span style="display:block;margin-top:8px">你的衣橱，由你自己管理</span></p>`;
}
function taxonomy() {
  const items=state.taxonomyTab==='分类'?state.categories:state.tags;
  return `${backLine('分类与标签','profile')}${heading('整理成你的习惯','分类清楚，找到喜欢的衣物更容易。')}${chips(['分类','场景标签'],state.taxonomyTab,'taxonomy-tab')}<div class="menu-list">${items.map(value=>`<button class="row-item" data-action="taxonomy-item" data-value="${escapeHtml(value)}">${icon(state.taxonomyTab==='分类'?'shirt':'tag')}<div class="row-copy"><h3>${escapeHtml(value)}</h3></div><span class="trailing">${state.taxonomyTab==='分类'?`${state.clothes.filter(item=>item.category===value).length} 件`:''}</span>${icon('chevron',true)}</button>`).join('')}</div><button class="secondary-button" data-action="taxonomy-add">${icon('plus',true)}添加${state.taxonomyTab==='分类'?'分类':'标签'}</button>`;
}
function settings() {
  return `${backLine('设置与数据','profile')}${heading('把日常照顾好','资料、偏好和数据，都在这里。')}<div class="menu-list"><button class="row-item" data-action="nickname"><div class="row-copy"><h3>昵称</h3></div><span class="trailing">${escapeHtml(state.nickname)}</span>${icon('chevron',true)}</button><button class="row-item" data-action="city"><div class="row-copy"><h3>默认城市</h3></div><span class="trailing">${escapeHtml(state.city || '杭州')}</span>${icon('chevron',true)}</button><button class="row-item" data-action="toggle-services"><div class="row-copy"><h3>外部服务状态</h3><p>用于检查原型已配置 / 未配置界面</p></div><span class="trailing">${state.services?'演示可用':'未配置'}</span></button></div><div class="menu-list"><button class="row-item" data-action="export-data">${icon('download')}<div class="row-copy"><h3>导出我的数据</h3><p>衣物、搭配和穿搭记录</p></div>${icon('chevron',true)}</button><button class="row-item" data-action="data-info" aria-expanded="${state.showDataInfo}">${icon('lock')}<div class="row-copy"><h3>数据与图片</h3><p>${state.showDataInfo?'点击收起说明':'了解存储与删除规则'}</p></div>${icon('chevron',true)}</button>${state.showDataInfo?'<p class="modal-copy">每个人的衣橱独立管理。归档保留历史；永久删除检查引用；注销撤销会话并清理数据。导出文件在正式产品中有有效期。</p>':''}</div><button class="secondary-button" data-action="logout" style="margin-top:25px">退出登录</button><button class="text-button" data-action="delete-account" style="margin:22px auto;color:var(--danger)">注销账号</button>`;
}
function recommendations() {
  return `${backLine('智能搭配','profile')}${heading('今天，想怎么穿？','从熟悉的衣物里，找到新的组合。')}<div class="weather-card"><div><span class="demo-label">天气演示</span><h2 style="margin-top:8px">18°</h2><p>${escapeHtml(state.city||'杭州')} · 多云 · 示例更新时间 09:30</p></div>${icon('cloud')}</div><div class="form-field"><label for="occasion">今天的场景</label><select id="occasion">${state.tags.map(value=>`<option${state.aiOccasion===value?' selected':''}>${value}</option>`).join('')}</select></div><div class="status-box">${icon('lock')}<div>只从你的衣橱中挑选<p>将使用衣物资料与所选场景，正式调用前确认服务和额度。</p></div></div>${state.services?`<button class="primary-button" data-action="generate-ai"${state.aiLoading?' disabled':''}>${icon('sparkles')}${state.aiLoading?'正在寻找灵感…':'生成搭配演示'}</button>`:'<div class="status-box warning">外部搭配服务尚未配置，当前无法发起生成。</div>'}${state.aiReady?`<div class="ai-result"><span class="demo-label">推荐结果示意</span><h3 style="margin-top:12px">柔和的颜色，刚好的层次</h3><p>奶油色针织衫与雾蓝牛仔裤，搭配棕色包袋，适合轻松的日常通勤。</p><div class="record-items">${['c1','c2','c6'].map(id=>`<img src="${photo(findClothing(id))}" alt="${findClothing(id).name}">`).join('')}</div><button class="secondary-button" data-action="save-ai" style="margin-top:14px">保存这套建议</button></div>`:''}<p class="form-hint" style="margin-top:15px">当前展示示例天气与推荐，不会调用外部服务。</p>`;
}
function tryOn() {
  return `${backLine('虚拟试穿','outfit-detail')}${heading('看看新的可能','生成的试穿图，仅作搭配效果参考。')}<div class="photo-pair"><button class="photo-slot" data-action="try-photo"><img src="assets/clothes/body-preview.svg" alt="上身照片插画示意"><span>你的照片 · 示意</span></button><div class="photo-slot"><img src="assets/clothes/camel-coat.svg" alt="选定衣物示意"><span>所选衣物</span></div></div><div class="status-box warning">${icon('info')}<div>发起前，请确认<p>正式功能会将所选上身照和衣物图片发送给已配置的试穿服务，并显示费用。当前只演示页面。</p></div></div><label class="consent-box"><input id="try-consent" type="checkbox"${state.tryOnConsent?' checked':''}><span>我了解图像发送范围，查看试穿演示。生成图不代表真实尺码或合身程度。</span></label>${state.services?`<button class="primary-button" data-action="generate-try-on"${state.tryOnConsent?'':' disabled'}>${icon('wand')}生成试穿演示</button>`:'<div class="status-box warning">试穿服务尚未配置，当前无法发起任务。</div>'}${state.tryOnReady?'<div class="ai-result"><span class="demo-label">结果页面示意 · 非模型输出</span><img src="assets/clothes/body-preview.svg" alt="试穿结果占位插画" style="height:260px;margin:12px auto"><p>正式结果在此展示，可保存或删除。</p><button class="secondary-button" data-action="delete-try-result" style="margin-top:12px">删除演示结果</button></div>':''}`;
}
function welcome() {
  return `<p class="welcome-kicker">属于你的轻盈衣橱</p><h1 class="welcome-title">搭搭不搭搭</h1><h2 class="welcome-subtitle">让每件喜欢的衣服，<br>都有出场机会。</h2><div class="welcome-art"><img src="assets/clothes/white-shirt.svg" alt="白衬衫插画"><img src="assets/clothes/sand-skirt.svg" alt="半裙插画"></div><p class="welcome-copy">整理衣物，收藏搭配，记录穿过的日子。<br>一个只属于你和朋友的私人衣橱。</p><button class="primary-button" data-action="login">微信登录 · 演示</button><p class="form-hint" style="text-align:center;margin-top:14px">首次使用需要邀请码</p>`;
}
const pageRenderers = { wardrobe, 'clothing-edit':clothingEdit, 'clothing-detail':clothingDetail, jobs, outfits, 'outfit-edit':outfitEdit, 'outfit-detail':outfitDetail, calendar, 'wear-edit':wearEdit, statistics, 'packing-lists':packingLists, 'packing-detail':packingDetail, profile, taxonomy, settings, recommendations, 'try-on':tryOn, welcome };
function render() {
  const metadata=screens.find(item=>item[0]===state.screen) || screens[0];
  state.screen=metadata[0];
  app.dataset.screen=state.screen;
  app.innerHTML=pageRenderers[state.screen]();
  document.getElementById('mini-title').textContent='搭搭不搭搭';
  document.getElementById('review-title').textContent=metadata[1];
  document.getElementById('review-description').textContent=metadata[2];
  document.getElementById('review-steps').innerHTML=metadata[3].map(item=>`<li>${item}</li>`).join('');
  document.getElementById('screen-nav').innerHTML=screens.map(([screen,title],index)=>`<button class="${screen===state.screen?'active':''}" data-action="go" data-screen="${screen}"><span>${String(index+1).padStart(2,'0')}</span><span>${title}</span></button>`).join('');
  document.getElementById('screen-select').innerHTML=screens.map(([screen,title])=>`<option value="${screen}"${screen===state.screen?' selected':''}>${title}</option>`).join('');
  const tabs=[['wardrobe','shirt','衣橱'],['outfits','layers','搭配'],['calendar','calendar','日历'],['profile','user','我的']];
  const tabbar=document.getElementById('tabbar');
  tabbar.hidden=!tabs.some(([screen])=>screen===state.screen);
  tabbar.innerHTML=tabs.map(([screen,name,label])=>`<button class="${screen===state.screen?'active':''}" data-action="go" data-screen="${screen}" aria-label="${label}" ${screen===state.screen?'aria-current="page"':''}>${icon(name)}<span>${label}</span></button>`).join('');
  document.getElementById('demo-state').value=state.demoState;
}
function rememberCanvas() { state.canvasHistory.push(JSON.stringify({items:state.canvasItems,layout:state.canvasLayout})); }
function changeCanvas(change) { if (!state.canvasSelected) return; rememberCanvas(); change(state.canvasLayout[state.canvasSelected]); render(); }
function saveTextModal(title,label,value,action) { openModal(title,`<div class="form-field"><label for="modal-text">${label}</label><input id="modal-text" value="${escapeHtml(value)}" maxlength="60"></div><button class="primary-button" data-action="${action}">保存</button>`); }
const actions = {
  go: button=>navigate(button.dataset.screen),
  'close-modal':closeModal,
  clothing:button=>{state.selectedId=button.dataset.id;navigate('clothing-detail');},
  favorite:button=>{const item=findClothing(button.dataset.id);item.favorite=!item.favorite;const scroll=app.scrollTop;render();app.scrollTop=scroll;toast(item.favorite?'已加入收藏':'已取消收藏');},
  category:button=>{state.category=button.dataset.value;render();},
  filter:()=>openModal('筛选衣物',`<p class="modal-copy">选择你想看的衣物。</p><button class="row-item" data-action="toggle-favorites">${icon('heart')}<div class="row-copy"><h3>只看收藏</h3></div><span class="check-control${state.onlyFavorites?' checked':''}">${state.onlyFavorites?icon('check'):''}</span></button><button class="primary-button" data-action="apply-filter" style="margin-top:24px">查看结果</button><button class="text-button" data-action="clear-filters" style="margin:16px auto">清除全部筛选</button>`),
  'toggle-favorites':()=>{state.onlyFavorites=!state.onlyFavorites;actions.filter();},
  'apply-filter':()=>{closeModal();render();},
  'clear-filters':()=>{state.category='全部';state.query='';state.onlyFavorites=false;state.demoState='normal';closeModal();render();},
  'reset-state':()=>{state.demoState='normal';render();},
  'new-clothing':()=>{state.editingId=null;state.form={name:'',category:'',color:'奶油白',price:'',notes:''};state.uploadPreview='';navigate('clothing-edit');},
  'choose-photo':()=>document.getElementById('file-input').click(),
  color:button=>{state.form.color=button.dataset.value;const scroll=app.scrollTop;render();app.scrollTop=scroll;},
  'more-fields':()=>openModal('更多衣物资料','<div class="form-field"><label for="brand-input">品牌 · 选填</label><input id="brand-input" placeholder="例如你喜欢的品牌"></div><div class="form-field"><label for="size-input">尺码 · 选填</label><input id="size-input" placeholder="例如 M / 38"></div><div class="form-field"><label for="notes-input">备注 · 选填</label><textarea id="notes-input" placeholder="记录材质、洗护方式等"></textarea></div><button class="primary-button" data-action="save-more-fields">保存资料</button>'),
  'save-more-fields':()=>{state.form.brand=document.getElementById('brand-input').value;state.form.size=document.getElementById('size-input').value;state.form.notes=document.getElementById('notes-input').value;closeModal();toast('已保存本次录入的补充资料');},
  'edit-clothing':()=>{const item=findClothing(state.selectedId);state.editingId=item.id;state.form={name:item.name,category:item.category,color:item.color,price:item.price??'',notes:item.notes||'',brand:item.brand||'',size:item.size||'',season:item.season};state.uploadPreview=item.uploadPreview||photo(item);navigate('clothing-edit');},
  'clothing-more':()=>openModal('整理这件衣物',`<p class="modal-copy">归档会保留搭配和历史穿着。永久删除前需要处理已有引用。</p><button class="secondary-button" data-action="archive-clothing">${findClothing(state.selectedId).archived?'恢复到衣橱':'归档这件衣物'}</button><button class="danger-button" data-action="delete-clothing" style="margin-top:12px">永久删除</button>`),
  'archive-clothing':()=>{const item=findClothing(state.selectedId);item.archived=!item.archived;closeModal();navigate('wardrobe');toast(item.archived?'已归档，历史记录保留':'已恢复到日常衣橱');},
  'delete-clothing':()=>{const id=state.selectedId;const references=state.outfits.filter(item=>item.items.includes(id)).length+state.records.filter(item=>item.items.includes(id)).length+state.packingLists.filter(item=>item.items.includes(id)).length;if(references){openModal('这件衣物还有记录',`<p class="modal-copy">已有 ${references} 处搭配、穿搭或清单引用。处理这些引用后才可以永久删除，也可以先归档。</p><button class="secondary-button" data-action="archive-clothing">归档并保留历史</button>`);return;}state.clothes=state.clothes.filter(item=>item.id!==id);navigate('wardrobe');toast('已从本次演示数据中删除');},
  'show-archive':()=>{state.archived=true;state.category='全部';state.query='';state.onlyFavorites=false;navigate('wardrobe');},
  'show-active':()=>{state.archived=false;navigate('wardrobe');},
  'manage-wardrobe':()=>openModal('整理衣橱','<p class="modal-copy">查看已归档衣物，或整理分类标签。批量选择的正式交互见页面规格。</p><button class="secondary-button" data-action="show-archive">查看归档</button><button class="secondary-button" data-action="go" data-screen="taxonomy" style="margin-top:12px">管理分类与标签</button>'),
  'run-job':()=>{state.jobState='running';render();clearTimeout(state.jobTimer);state.jobTimer=setTimeout(()=>{state.jobState='succeeded';if(state.screen==='jobs')render();toast('演示处理完成，未运行模型');},1200);},
  'job-fail':()=>{clearTimeout(state.jobTimer);state.jobState='failed';render();},
  'job-cancel':()=>{clearTimeout(state.jobTimer);state.jobState='cancelled';render();},
  'accept-suggestions':()=>{state.form.category='上装';state.form.color='奶油白';navigate('clothing-edit');toast('已填入示例候选，可以继续修改');},
  outfit:button=>{state.selectedOutfit=Number(button.dataset.index);navigate('outfit-detail');},
  'outfit-filter':button=>{state.outfitFilter=button.dataset.value;render();},
  'new-outfit':()=>{state.editorIndex=null;state.canvasItems=['c1','c2','c6'];state.canvasLayout=defaultLayout(state.canvasItems);state.canvasSelected='c1';state.canvasHistory=[];state.outfitName='我的新搭配';navigate('outfit-edit');},
  'edit-outfit':()=>{const outfit=currentOutfit();state.editorIndex=state.selectedOutfit;state.canvasItems=[...outfit.items];state.canvasLayout=structuredClone(outfit.layout||defaultLayout(outfit.items));state.canvasSelected=outfit.items[0];state.outfitName=outfit.name;state.canvasHistory=[];navigate('outfit-edit');},
  'add-to-outfit':button=>{state.editorIndex=null;state.canvasItems=[button.dataset.id];state.canvasLayout=defaultLayout(state.canvasItems);state.canvasSelected=button.dataset.id;state.canvasHistory=[];state.outfitName='我的新搭配';navigate('outfit-edit');},
  'canvas-add':button=>{const id=button.dataset.id;if(state.canvasItems.includes(id)){state.canvasSelected=id;render();return;}if(state.canvasItems.length>=12){toast('一套搭配最多选择12件衣物');return;}rememberCanvas();state.canvasItems.push(id);state.canvasLayout[id]={x:.25,y:.25,w:.42,h:.48,rotation:0,z:state.canvasItems.length};state.canvasSelected=id;render();},
  'layout-auto':()=>{rememberCanvas();state.canvasLayout=defaultLayout(state.canvasItems);render();},
  'canvas-scale':button=>changeCanvas(box=>{const factor=Number(button.dataset.factor);const ratio=Math.min(.9/box.w,.95/box.h,Math.max(.1/box.w,.1/box.h,factor));box.w*=ratio;box.h*=ratio;}),
  'canvas-rotate':()=>changeCanvas(box=>{box.rotation=(box.rotation+15)%360;}),
  'canvas-front':()=>changeCanvas(box=>{box.z=Math.max(...Object.values(state.canvasLayout).map(item=>item.z))+1;}),
  'canvas-remove':()=>{if(!state.canvasSelected)return;rememberCanvas();state.canvasItems=state.canvasItems.filter(id=>id!==state.canvasSelected);delete state.canvasLayout[state.canvasSelected];state.canvasSelected=state.canvasItems[0];render();},
  'canvas-undo':()=>{if(!state.canvasHistory.length){toast('还没有需要撤销的操作');return;}const previous=JSON.parse(state.canvasHistory.pop());state.canvasItems=previous.items;state.canvasLayout=previous.layout;state.canvasSelected=previous.items[0];render();},
  'save-outfit':()=>{if(!state.canvasItems.length){toast('请至少选择一件衣物');return;}const outfit={name:state.outfitName.trim()||'我的搭配',occasion:'日常通勤',items:[...state.canvasItems],layout:structuredClone(state.canvasLayout),favorite:false};if(state.editorIndex!==null){state.outfits[state.editorIndex]=outfit;state.selectedOutfit=state.editorIndex;}if(state.editorIndex===null){state.outfits.push(outfit);state.selectedOutfit=state.outfits.length-1;}navigate('outfit-detail');toast('搭配已保存在本次演示中');},
  'outfit-favorite':()=>{currentOutfit().favorite=!currentOutfit().favorite;render();toast(currentOutfit().favorite?'已收藏这套搭配':'已取消收藏');},
  'record-outfit':()=>{state.wearItems=null;state.wearDate=today;state.wearOccasion=currentOutfit().occasion;state.wearNote='';state.wearRecordId=null;navigate('wear-edit');},
  month:button=>{const date=new Date(state.calendarYear,state.calendarMonth+Number(button.dataset.delta),1);state.calendarYear=date.getFullYear();state.calendarMonth=date.getMonth();render();},
  day:button=>{state.selectedDate=button.dataset.date;render();},
  'new-record':()=>{if(state.selectedDate>today){toast('实际穿着记录只能选择今天或过去的日期');return;}state.wearItems=null;state.wearOccasion=currentOutfit().occasion;state.wearRecordId=null;state.wearDate=state.selectedDate;state.wearNote='';navigate('wear-edit');},
  'edit-record':button=>{const record=state.records.find(item=>item.id===button.dataset.id.replace('record:',''));state.wearRecordId=record.id;state.wearDate=record.date;state.wearOccasion=record.occasion;state.wearNote=record.note;const index=state.outfits.findIndex(outfit=>JSON.stringify(outfit.items)===JSON.stringify(record.items));state.selectedOutfit=index>=0?index:0;state.wearItems=[...record.items];navigate('wear-edit');},
  'choose-wear-outfit':()=>openModal('选择今天的搭配',state.outfits.map((outfit,index)=>`<button class="row-item" data-action="wear-outfit" data-index="${index}">${icon('layers')}<div class="row-copy"><h3>${escapeHtml(outfit.name)}</h3><p>${outfit.items.length} 件单品</p></div>${icon('chevron',true)}</button>`).join('')),
  'wear-outfit':button=>{state.selectedOutfit=Number(button.dataset.index);state.wearItems=[...currentOutfit().items];closeModal();render();},
  'delete-record':()=>openModal('删除这条记录？','<p class="modal-copy">删除后，对应日期的穿着次数会重新计算。衣物和搭配仍保留。</p><button class="danger-button" data-action="confirm-delete-record">删除记录</button>'),
  'confirm-delete-record':()=>{state.records=state.records.filter(record=>record.id!==state.wearRecordId);state.wearRecordId=null;navigate('calendar');toast('已删除演示记录，统计已更新');},
  packing:button=>{state.selectedPacking=Number(button.dataset.index);navigate('packing-detail');},
  packed:button=>{const list=state.packingLists[state.selectedPacking];list.packed=list.packed.includes(button.dataset.id)?list.packed.filter(id=>id!==button.dataset.id):[...list.packed,button.dataset.id];render();},
  'new-packing':()=>saveTextModal('新的出行清单','清单名称','下一次小旅行','save-packing'),
  'save-packing':()=>{const name=document.getElementById('modal-text').value.trim();if(!name){toast('请填写清单名称');return;}state.packingLists.push({name,date:'日期待定',items:[],packed:[]});state.selectedPacking=state.packingLists.length-1;navigate('packing-detail');},
  'packing-add':()=>openModal('从衣橱添加',`<div class="clothes-grid">${activeClothes().map(item=>`<button class="clothing-card" data-action="packing-pick" data-id="${item.id}"><div class="clothing-visual"><img class="garment" src="${photo(item)}" alt=""></div><h3>${item.name}</h3></button>`).join('')}</div>`),
  'packing-pick':button=>{const list=state.packingLists[state.selectedPacking];if(list.items.includes(button.dataset.id)){toast('这件衣物已经在清单中');return;}list.items.push(button.dataset.id);closeModal();render();},
  'packing-copy':()=>{const list=state.packingLists[state.selectedPacking];state.packingLists.push({name:`${list.name} · 副本`,date:list.date,items:[...list.items],packed:[]});state.selectedPacking=state.packingLists.length-1;render();toast('已复制，收拾状态已重置');},
  'taxonomy-tab':button=>{state.taxonomyTab=button.dataset.value;render();},
  'taxonomy-add':()=>saveTextModal(`新增${state.taxonomyTab}`,'名称','','save-taxonomy'),
  'save-taxonomy':()=>{const value=document.getElementById('modal-text').value.trim();const list=state.taxonomyTab==='分类'?state.categories:state.tags;if(!value){toast('请填写名称');return;}if(list.includes(value)){toast('这个名称已经存在');return;}list.push(value);closeModal();render();},
  'taxonomy-item':button=>toast(state.taxonomyTab==='分类'&&state.clothes.some(item=>item.category===button.dataset.value)?'分类正在使用，删除前请先迁移衣物':'可按整理习惯重命名或移除'),
  nickname:()=>saveTextModal('编辑昵称','昵称',state.nickname,'save-nickname'),
  'save-nickname':()=>{const value=document.getElementById('modal-text').value.trim();if(!value){toast('请填写昵称');return;}state.nickname=value;closeModal();render();},
  city:()=>saveTextModal('默认城市','城市名称',state.city||'杭州','save-city'),
  'save-city':()=>{state.city=document.getElementById('modal-text').value.trim()||'杭州';closeModal();render();toast('已更新演示城市，天气数据仍为示例');},
  'toggle-services':()=>{state.services=!state.services;state.aiReady=false;state.tryOnReady=false;render();},
  'generate-ai':()=>{state.aiLoading=true;render();setTimeout(()=>{state.aiLoading=false;state.aiReady=true;if(state.screen==='recommendations')render();toast('已显示推荐示意，未调用外部服务');},900);},
  'save-ai':()=>{state.outfits.push({name:'柔和的日常组合',occasion:state.aiOccasion,items:['c1','c2','c6'],favorite:false});state.selectedOutfit=state.outfits.length-1;navigate('outfit-detail');toast('已保存到本次演示搭配');},
  'try-photo':()=>toast('当前展示原创人物插画；正式功能选择本人照片'),
  'generate-try-on':()=>{if(!state.tryOnConsent)return;state.tryOnReady=true;render();toast('已显示结果页面示意，未发送照片');},
  'delete-try-result':()=>{state.tryOnReady=false;render();toast('演示结果已删除');},
  'data-info':()=>{state.showDataInfo=!state.showDataInfo;render();},
  'export-data':()=>{const blob=new Blob([JSON.stringify({notice:'搭搭不搭搭 原型演示数据',clothes:state.clothes.map(({uploadPreview,...item})=>item),outfits:state.outfits,records:state.records},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='fit-or-not-demo.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已导出演示 JSON；正式产品导出含图片的 ZIP');},
  'export-outfit':()=>toast('原型仅演示导出入口，静态图可从设计包获取'),
  logout:()=>openModal('退出当前账号？','<p class="modal-copy">正式产品会撤销当前会话。这里仅演示返回登录页面。</p><button class="primary-button" data-action="go" data-screen="welcome">退出登录</button>'),
  'delete-account':()=>openModal('注销账号','<p class="modal-copy">正式产品会撤销会话并清理你的衣物、搭配、记录和图片，备份按保留周期到期清理。建议先导出数据。</p><p class="form-hint">当前为设计原型，不执行真实账号注销。</p><button class="secondary-button" data-action="close-modal" style="margin-top:16px">保留账号</button>'),
  login:()=>openModal('欢迎来到私人衣橱','<p class="modal-copy">新成员使用一次性邀请码。当前是界面演示，可填写任意非空内容体验。</p><div class="form-field"><label for="invite-code">邀请码</label><input id="invite-code" placeholder="请输入邀请码"></div><button class="primary-button" data-action="redeem-invite">进入我的衣橱</button>'),
  'redeem-invite':()=>{if(!document.getElementById('invite-code').value.trim()){toast('请输入演示邀请码');return;}navigate('wardrobe');toast('已进入演示衣橱，未连接微信登录');},
};
document.addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(!button)return;const action=actions[button.dataset.action];if(action)action(button);});
document.addEventListener('input',event=>{
  if(event.target.id==='wardrobe-search'){state.query=event.target.value;document.getElementById('wardrobe-results').innerHTML=wardrobeResults();}
  if(event.target.id==='outfit-name')state.outfitName=event.target.value;
  if(event.target.closest('#clothing-form') && event.target.name)state.form[event.target.name]=event.target.value;
  if(event.target.id==='wear-note')state.wearNote=event.target.value;
});
document.addEventListener('change',event=>{
  if(event.target.id==='screen-select')navigate(event.target.value);
  if(event.target.id==='demo-state'){state.demoState=event.target.value;navigate('wardrobe');}
  if(event.target.id==='try-consent'){state.tryOnConsent=event.target.checked;render();}
  if(event.target.id==='occasion')state.aiOccasion=event.target.value;
  if(event.target.id==='season')state.form.season=event.target.value;
  if(event.target.id==='wear-date')state.wearDate=event.target.value;
  if(event.target.id==='wear-occasion')state.wearOccasion=event.target.value;
  if(event.target.id==='clothing-category')state.form.category=event.target.value;
  if(event.target.id==='file-input' && event.target.files.length){const file=event.target.files[0];if(!file.type.startsWith('image/')){toast('请选择图片文件');return;}state.uploadPreview=URL.createObjectURL(file);render();toast('图片仅在当前原型中预览，不会上传');}
});
document.addEventListener('submit',event=>{
  event.preventDefault();
  if(event.target.id==='clothing-form'){
    if(!state.form.category){document.getElementById('form-error').textContent='请选择衣物分类，再保存到衣橱。';return;}
    const item={name:state.form.name.trim()||`${state.form.color}${state.form.category}`,category:state.form.category,color:state.form.color,price:state.form.price===''?null:Number(state.form.price),season:state.form.season||document.getElementById('season').value,notes:state.form.notes,brand:state.form.brand||'',size:state.form.size||'',uploadPreview:state.uploadPreview};
    if(state.editingId)Object.assign(findClothing(state.editingId),item);
    if(!state.editingId)state.clothes.unshift({id:`c${Date.now()}`,asset:'cream-knit',favorite:false,archived:false,bg:'#f8f9fb',...item});
    state.archived=false;state.category='全部';state.query='';state.demoState='normal';navigate('wardrobe');toast('已保存到本次演示衣橱');return;
  }
  if(event.target.id==='wear-form'){
    if(!state.wearDate || state.wearDate>today){toast('请选择今天或过去的日期');return;}
    const record={id:state.wearRecordId||`r${Date.now()}`,date:state.wearDate,occasion:state.wearOccasion,items:[...(state.wearItems||currentOutfit().items)],note:state.wearNote};
    state.records=state.records.filter(item=>item.id!==record.id);state.records.push(record);state.selectedDate=record.date;state.calendarYear=Number(record.date.slice(0,4));state.calendarMonth=Number(record.date.slice(5,7))-1;state.wearItems=null;state.wearRecordId=null;navigate('calendar');toast('记录已保存，同件衣物同日只计一次');
  }
});
document.addEventListener('pointerdown',event=>{
  const element=event.target.closest('[data-canvas-id]');
  if(!element)return;
  event.preventDefault();
  const id=element.dataset.canvasId;
  state.canvasSelected=id;
  rememberCanvas();
  document.querySelectorAll('.canvas-item').forEach(item=>item.classList.toggle('selected',item===element));
  const canvas=document.getElementById('outfit-canvas').getBoundingClientRect();
  const start={x:event.clientX,y:event.clientY,...state.canvasLayout[id]};
  const pointerStart={x:event.clientX,y:event.clientY};
  element.setPointerCapture(event.pointerId);
  const move=moveEvent=>{const box=state.canvasLayout[id];box.x=Math.max(-box.w*.2,Math.min(1-box.w*.8,start.x+(moveEvent.clientX-pointerStart.x)/canvas.width));box.y=Math.max(-box.h*.2,Math.min(1-box.h*.8,start.y+(moveEvent.clientY-pointerStart.y)/canvas.height));element.style.left=`${box.x*100}%`;element.style.top=`${box.y*100}%`;};
  const finish=()=>{element.removeEventListener('pointermove',move);element.removeEventListener('pointerup',finish);element.removeEventListener('pointercancel',finish);};
  element.addEventListener('pointermove',move);element.addEventListener('pointerup',finish);element.addEventListener('pointercancel',finish);
});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeModal();});
render();
