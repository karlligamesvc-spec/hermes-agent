import type { ProcessCopy, StepCopy, StepFacts } from './types-process'

// hc-973: the process area in a creator's words, not the mechanism's. Every
// tool Desktop can meet is named here: what it says while it runs, its name in
// the finished chain, and what it came back with. No code name, slug, English
// word or millisecond count reaches a Chinese screen through this table.

const step = (
  running: string,
  title: string,
  done: (facts: StepFacts) => string,
  source?: (facts: StepFacts) => string
): StepCopy => (source ? { running, title, done, source } : { running, title, done })

const said = (text: string) => () => text

/** 「找到 20 条作品」, or the fallback when the call reported nothing countable. */
const found =
  (unit: string, fallback = '好了') =>
  (facts: StepFacts) =>
    facts.count ? `找到 ${facts.count} ${unit}` : facts.empty ? '没找到' : fallback

/** 「读了 3 个文件」 when the step ran more than once. */
const each = (verb: string, unit: string, single: string) => (facts: StepFacts) =>
  facts.calls > 1 ? `${verb} ${facts.calls} ${unit}` : single

const publicData = (facts: StepFacts) => `来源：${facts.platform ?? '平台'}上的公开数据。`
const douyinIndex = () => '来源：巨量算数，经第三方数据服务获取。'

const tenths = (value: number) => String(Math.round(value * 10) / 10)

const KANBAN: Record<string, [string, string]> = {
  kanban_attach: ['正在给任务加附件', '加附件'],
  kanban_attach_url: ['正在给任务加链接', '加链接'],
  kanban_attachments: ['正在看任务附件', '看附件'],
  kanban_block: ['正在标记任务受阻', '标记受阻'],
  kanban_comment: ['正在评论任务', '评论任务'],
  kanban_complete: ['正在标记任务完成', '标记完成'],
  kanban_create: ['正在新建任务', '新建任务'],
  kanban_heartbeat: ['正在汇报进度', '汇报进度'],
  kanban_link: ['正在关联任务', '关联任务'],
  kanban_list: ['正在看任务看板', '看任务看板'],
  kanban_request_changes: ['正在请对方修改', '请求修改'],
  kanban_request_review: ['正在请人审核', '请求审核'],
  kanban_show: ['正在打开任务', '打开任务'],
  kanban_unblock: ['正在解除任务受阻', '解除受阻']
}

export const zhProcess: ProcessCopy = {
  steps: {
    // APEX 平台工具
    social_download: step(
      '正在下载视频',
      '下载视频',
      facts =>
        [`下载了 ${facts.calls} 个视频`, facts.length, facts.likes && `${facts.likes}赞`].filter(Boolean).join('，'),
      facts => `来源：${facts.platform ?? ''}公开链接里的这条作品。只读公开数据，没有登录你的账号。`
    ),
    media_transcribe: step(
      '正在识别语音',
      '识别语音',
      facts =>
        facts.empty
          ? '视频里没有人声'
          : facts.chars
            ? `拿到逐字稿，${facts.chars} 字`
            : facts.length
              ? `识别了 ${facts.length}的语音`
              : '拿到逐字稿',
      facts =>
        facts.length ? `方式：把视频里的声音转成文字，共 ${facts.length}音频。` : '方式：把视频里的声音转成文字。'
    ),
    image_ocr: step('正在识别图片里的字', '识别图片文字', facts =>
      facts.count ? `识别了 ${facts.count} 张图片` : '识别好了'
    ),
    social_batch_submit: step('正在提交批量任务', '提交批量任务', facts =>
      facts.count ? `提交了 ${facts.count} 条链接` : '提交好了'
    ),
    social_batch_status: step('正在查看批量进度', '查看批量进度', said('看过了')),
    creator_top_posts: step('正在找博主的热门作品', '找博主热门作品', found('条作品'), publicData),
    social_audience: step(
      '正在看人群画像',
      '看人群画像',
      facts => (facts.query ? `看了「${facts.query}」的受众` : '看过了'),
      douyinIndex
    ),
    social_captions: step(
      '正在获取字幕',
      '获取字幕',
      facts => (facts.chars ? `拿到字幕，${facts.chars} 字` : '拿到字幕'),
      publicData
    ),
    social_comments: step(
      '正在看评论',
      '看评论',
      facts => (facts.count ? `看了 ${facts.count} 条评论` : '看过了'),
      publicData
    ),
    social_content: step(
      '正在看作品详情',
      '看作品详情',
      facts => (facts.count && facts.count > 1 ? `看了 ${facts.count} 条作品` : '看过了'),
      publicData
    ),
    social_creator_discovery: step('正在找博主', '找博主', found('位博主'), () => '来源：巨量算数达人库，经第三方数据服务获取。'),
    social_keyword_insight: step(
      '正在看关键词热度',
      '看关键词热度',
      facts => (facts.query ? `看了「${facts.query}」的热度` : '看过了'),
      douyinIndex
    ),
    social_posts: step(
      '正在看账号作品',
      '看账号作品',
      facts => (facts.count ? `看了 ${facts.count} 条作品` : '看过了'),
      publicData
    ),
    social_product: step(
      '正在看在售商品',
      '看在售商品',
      found('个商品'),
      facts => `来源：${facts.platform ?? '平台'}上在售的商品。`
    ),
    social_profile: step('正在看账号资料', '看账号资料', said('看过了'), publicData),
    social_search: step('正在搜同类作品', '搜同类作品', found('条作品'), publicData),
    social_trending: step(
      '正在看热榜',
      '看热榜',
      facts => (facts.count ? `看了 ${facts.count} 条热点` : '看过了'),
      publicData
    ),
    generate_image: step('正在生成图片', '生成图片', facts =>
      facts.count ? `生成了 ${facts.count} 张图片` : '图片做好了'
    ),
    generate_video: step('正在生成视频', '生成视频', facts =>
      facts.count ? `生成了 ${facts.count} 条视频` : '视频做好了'
    ),
    live_record_start: step('正在开始录直播', '开始录直播', said('开始录了')),
    live_record_status: step('正在查看录制进度', '查看录制进度', said('看过了')),
    live_record_stop: step('正在结束录制', '结束录制', said('录好了')),
    honesty_verify: step('正在检查文案说法', '检查文案说法', said('检查好了')),
    doc_file_write: step('正在生成文档', '生成文档', said('文档做好了')),
    xlsx_file_write: step('正在生成表格', '生成表格', said('表格做好了')),
    pptx_file_write: step('正在生成演示文稿', '生成演示文稿', said('演示文稿做好了')),
    feishu_doc_write: step('正在写进飞书文档', '写进飞书文档', said('写好了')),
    feishu_bitable_write: step('正在写进飞书表格', '写进飞书表格', facts =>
      facts.count ? `写入了 ${facts.count} 行` : '写好了'
    ),
    // 找工具、读技能：是准备，不算任务的步骤
    tool_search: step('正在找能用的工具', '找能用的工具', found('个工具')),
    tool_describe: step('正在看工具怎么用', '看工具说明', said('看过了')),
    tool_call: step('正在处理', '处理', said('好了')),
    skill_view: step('正在准备做法', '准备做法', said('准备好了')),
    skills_list: step('正在看有哪些做法', '看有哪些做法', said('看过了')),
    skill_manage: step('正在更新做法', '更新做法', said('更新好了')),
    // 内置工具
    web_search: step('正在搜网页', '搜网页', found('条结果'), () => '来源：网页搜索。'),
    web_extract: step('正在读网页', '读网页', each('读了', '个网页', '读完了'), () => '来源：下面这些网页。'),
    terminal: step('正在电脑上处理', '在电脑上处理', each('处理了', '次', '处理好了')),
    execute_code: step('正在处理数据', '处理数据', said('处理好了')),
    process_manage: step('正在查看后台任务', '查看后台任务', said('看过了')),
    read_file: step('正在读文件', '读文件', each('读了', '个文件', '读完了')),
    write_file: step('正在写文件', '写文件', each('写了', '个文件', '存好了')),
    edit_file: step('正在改文件', '改文件', each('改了', '个文件', '改好了')),
    patch: step('正在改文件', '改文件', each('改了', '个文件', '改好了')),
    list_files: step('正在看文件夹', '看文件夹', facts => (facts.count ? `有 ${facts.count} 个文件` : '看过了')),
    search_files: step('正在找文件', '找文件', found('处')),
    vision_analyze: step('正在看图片', '看图片', said('看过了')),
    video_analyze: step('正在看视频', '看视频', said('看过了')),
    image_generate: step('正在生成图片', '生成图片', said('图片做好了')),
    video_generate: step('正在生成视频', '生成视频', said('视频做好了')),
    xai_video_edit: step('正在剪辑视频', '剪辑视频', said('剪好了')),
    xai_video_extend: step('正在延长视频', '延长视频', said('延长好了')),
    text_to_speech: step('正在生成配音', '生成配音', said('配音做好了')),
    browser_navigate: step('正在打开网页', '打开网页', each('打开了', '个网页', '打开了')),
    browser_snapshot: step('正在读页面', '读页面', said('读完了')),
    browser_click: step('正在点页面', '点页面', said('点好了')),
    browser_type: step('正在页面上输入', '页面输入', said('输好了')),
    browser_fill: step('正在填表', '填表', said('填好了')),
    browser_scroll: step('正在滚动页面', '滚动页面', said('好了')),
    browser_back: step('正在返回上一页', '返回上一页', said('好了')),
    browser_press: step('正在按键', '按键', said('好了')),
    browser_get_images: step('正在收集网页图片', '收集网页图片', found('张图片')),
    browser_vision: step('正在看网页画面', '看网页画面', said('看过了')),
    browser_console: step('正在查看网页消息', '查看网页消息', said('看过了')),
    browser_cdp: step('正在操作浏览器', '操作浏览器', said('好了')),
    browser_dialog: step('正在处理弹窗', '处理弹窗', said('好了')),
    browser_vault: step('正在使用保存的登录', '使用保存的登录', said('好了')),
    browser_exec: step('正在网页上操作', '网页操作', said('好了')),
    browser_take_screenshot: step('正在截图', '截图', said('截好了')),
    todo: step('正在列计划', '列计划', facts => (facts.count ? `列了 ${facts.count} 项` : '列好了')),
    todo_list: step('正在列计划', '列计划', facts => (facts.count ? `列了 ${facts.count} 项` : '列好了')),
    memory: step('正在记下来', '记下要点', said('记好了')),
    session_search: step('正在翻之前的对话', '翻之前的对话', found('处')),
    session_search_recall: step('正在翻之前的对话', '翻之前的对话', found('处')),
    clarify: step('正在问你', '问你', said('问过了')),
    delegate_task: step('正在分派子任务', '分派子任务', facts =>
      facts.count ? `分出 ${facts.count} 个子任务` : '分派好了'
    ),
    cronjob: step('正在设定时任务', '设定时任务', said('设好了')),
    cronjob_manage: step('正在设定时任务', '设定时任务', said('设好了')),
    computer_use: step('正在操作电脑', '操作电脑', said('好了')),
    manage_connections: step('正在管理连接', '管理连接', said('好了')),
    manage_catalog: step('正在看能连接的应用', '看能连接的应用', said('看过了')),
    send_message: step('正在发消息', '发消息', said('发好了')),
    react_to_message: step('正在回应', '回应', said('好了')),
    read_terminal: step('正在看终端', '看终端', said('看过了')),
    close_terminal: step('正在关闭终端', '关闭终端', said('关好了')),
    read_window_below: step('正在看窗口内容', '看窗口内容', said('看过了')),
    focus_pane: step('正在切换面板', '切换面板', said('好了')),
    gui_tour: step('正在带你看界面', '带你看界面', said('好了')),
    set_theme: step('正在换主题', '换主题', said('换好了')),
    setup_beat: step('正在设置', '设置', said('好了')),
    show_tip: step('正在显示提示', '显示提示', said('好了')),
    annotate_preview: step('正在标注预览', '标注预览', said('标好了')),
    desktop_preview: step('正在打开预览', '打开预览', said('打开了')),
    desktop_project: step('正在更新项目', '更新项目', said('更新好了')),
    drive_preview: step('正在打开文件预览', '打开文件预览', said('打开了')),
    feishu_doc_read: step('正在读飞书文档', '读飞书文档', said('读完了')),
    feishu_drive_add_comment: step('正在添加飞书评论', '添加飞书评论', said('加好了')),
    feishu_drive_list_comments: step('正在看飞书评论', '看飞书评论', found('条评论')),
    feishu_drive_list_comment_replies: step('正在看评论回复', '看评论回复', found('条回复')),
    feishu_drive_reply_comment: step('正在回复评论', '回复评论', said('回好了')),
    x_search: step('正在搜索 X 平台', '搜索 X 平台', found('条内容'), publicData),
    ...Object.fromEntries(
      Object.entries(KANBAN).map(([name, [running, title]]) => [name, step(running, title, said('好了'))])
    )
  },
  unknownStep: step('正在处理', '处理', said('好了')),
  status: {
    preparing: '正在准备…',
    thinking: '正在思考…',
    writing: '正在整理结果…',
    running: running => `${running}…`,
    stepOf: index => `第 ${index} 步`,
    stepOfTotal: (index, total) => `第 ${index} 步，共 ${total} 步`,
    chainSeparator: ' → ',
    moreSteps: total => `共 ${total} 步`,
    took: duration => `用时 ${duration}`,
    failed: title => `${title}没成功`,
    stopped: title => `停在了「${title}」`,
    methodsOnly: names => `参考了这些做法：${names}`
  },
  showSteps: '看步骤',
  hideSteps: '收起步骤',
  stepsLabel: '步骤',
  showSource: '数据从哪来',
  hideSource: '收起来源',
  source: {
    platform: name => `来源平台：${name}`,
    links: '链接',
    queries: '搜索词',
    count: count => `拿到 ${count} 条`
  },
  stepFailed: '没成功',
  stepPartlyFailed: count => `其中 ${count} 次没成功`,
  stepStopped: '没做完',
  slowHint: '这一步要久一点，你可以先去忙别的。',
  methods: names => `用到的方法：${names}`,
  listSeparator: '、',
  subtasks: {
    title: '子任务',
    done: '已完成',
    running: '进行中',
    failed: '没成功',
    dispatched: '已分派'
  },
  reasoning: {
    thinking: '正在想',
    thought: '想过了',
    thoughtFor: duration => `想了 ${duration}`,
    collapse: '收起'
  },
  failure: {
    fallbackReason: '这一步没有拿到结果。',
    keptNote: '已经拿到的部分不会丢。',
    retry: '重试',
    anotherWay: '换个办法',
    partial: '先给我能出的部分',
    retryMessage: title => `再试一次「${title}」这一步。`,
    anotherWayMessage: title => `「${title}」这一步没成功，换个办法继续。`,
    partialMessage: title => `「${title}」先跳过，把已经拿到的部分整理给我。`
  },
  tech: {
    title: '技术细节',
    line: (names, duration) => (duration ? `${names} · ${duration}` : names),
    calls: count => `${count} 次调用`
  },
  compactNumber: value =>
    value >= 1e8 ? `${tenths(value / 1e8)} 亿` : value >= 1e4 ? `${tenths(value / 1e4)} 万` : String(value),
  platforms: {
    bilibili: '哔哩哔哩',
    douyin: '抖音',
    instagram: 'Instagram',
    kuaishou: '快手',
    tiktok: 'TikTok',
    wechat_channels: '视频号',
    wechat_mp: '公众号',
    weibo: '微博',
    x: 'X',
    xiaohongshu: '小红书',
    youtube: 'YouTube',
    zhihu: '知乎'
  }
}
