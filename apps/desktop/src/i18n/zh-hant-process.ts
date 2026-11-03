import type { ProcessCopy, StepCopy, StepFacts } from './types-process'

// hc-973: 過程區用創作者聽得懂的話，不用機制的話。zh-process.ts 的繁體版，
// 用詞跟 zh-hant-assistant-tool.ts 一致（影片、帳號、搜尋、檔案）。

const step = (
  running: string,
  title: string,
  done: (facts: StepFacts) => string,
  source?: (facts: StepFacts) => string
): StepCopy => (source ? { running, title, done, source } : { running, title, done })

const said = (text: string) => () => text

const found =
  (unit: string, fallback = '好了') =>
  (facts: StepFacts) =>
    facts.count ? `找到 ${facts.count} ${unit}` : facts.empty ? '沒找到' : fallback

const each = (verb: string, unit: string, single: string) => (facts: StepFacts) =>
  facts.calls > 1 ? `${verb} ${facts.calls} ${unit}` : single

const publicData = (facts: StepFacts) => `來源：${facts.platform ?? '平台'}上的公開資料。`
const douyinIndex = () => '來源：巨量算數，經第三方資料服務取得。'

const tenths = (value: number) => String(Math.round(value * 10) / 10)

const KANBAN: Record<string, [string, string]> = {
  kanban_attach: ['正在幫任務加附件', '加附件'],
  kanban_attach_url: ['正在幫任務加連結', '加連結'],
  kanban_attachments: ['正在看任務附件', '看附件'],
  kanban_block: ['正在標記任務受阻', '標記受阻'],
  kanban_comment: ['正在評論任務', '評論任務'],
  kanban_complete: ['正在標記任務完成', '標記完成'],
  kanban_create: ['正在新增任務', '新增任務'],
  kanban_heartbeat: ['正在回報進度', '回報進度'],
  kanban_link: ['正在關聯任務', '關聯任務'],
  kanban_list: ['正在看任務看板', '看任務看板'],
  kanban_request_changes: ['正在請對方修改', '請求修改'],
  kanban_request_review: ['正在請人審核', '請求審核'],
  kanban_show: ['正在打開任務', '打開任務'],
  kanban_unblock: ['正在解除任務受阻', '解除受阻']
}

export const zhHantProcess: ProcessCopy = {
  steps: {
    social_download: step(
      '正在下載影片',
      '下載影片',
      facts =>
        [`下載了 ${facts.calls} 部影片`, facts.length, facts.likes && `${facts.likes}讚`].filter(Boolean).join('，'),
      facts => `來源：${facts.platform ?? ''}公開連結裡的這則作品。只讀公開資料，沒有登入你的帳號。`
    ),
    media_transcribe: step(
      '正在辨識語音',
      '辨識語音',
      facts =>
        facts.empty
          ? '影片裡沒有人聲'
          : facts.chars
            ? `拿到逐字稿，${facts.chars} 字`
            : facts.length
              ? `辨識了 ${facts.length}的語音`
              : '拿到逐字稿',
      facts =>
        facts.length ? `方式：把影片裡的聲音轉成文字，共 ${facts.length}音訊。` : '方式：把影片裡的聲音轉成文字。'
    ),
    image_ocr: step('正在辨識圖片裡的字', '辨識圖片文字', facts =>
      facts.count ? `辨識了 ${facts.count} 張圖片` : '辨識好了'
    ),
    social_batch_submit: step('正在提交批次任務', '提交批次任務', facts =>
      facts.count ? `提交了 ${facts.count} 條連結` : '提交好了'
    ),
    social_batch_status: step('正在查看批次進度', '查看批次進度', said('看過了')),
    creator_top_posts: step('正在找創作者的熱門作品', '找創作者熱門作品', found('則作品'), publicData),
    social_audience: step(
      '正在看受眾輪廓',
      '看受眾輪廓',
      facts => (facts.query ? `看了「${facts.query}」的受眾` : '看過了'),
      douyinIndex
    ),
    social_captions: step(
      '正在取得字幕',
      '取得字幕',
      facts => (facts.chars ? `拿到字幕，${facts.chars} 字` : '拿到字幕'),
      publicData
    ),
    social_comments: step(
      '正在看評論',
      '看評論',
      facts => (facts.count ? `看了 ${facts.count} 則評論` : '看過了'),
      publicData
    ),
    social_content: step(
      '正在看作品詳情',
      '看作品詳情',
      facts => (facts.count && facts.count > 1 ? `看了 ${facts.count} 則作品` : '看過了'),
      publicData
    ),
    social_creator_discovery: step('正在找創作者', '找創作者', found('位創作者'), () => '來源：巨量算數達人庫，經第三方資料服務取得。'),
    social_keyword_insight: step(
      '正在看關鍵字熱度',
      '看關鍵字熱度',
      facts => (facts.query ? `看了「${facts.query}」的熱度` : '看過了'),
      douyinIndex
    ),
    social_posts: step(
      '正在看帳號作品',
      '看帳號作品',
      facts => (facts.count ? `看了 ${facts.count} 則作品` : '看過了'),
      publicData
    ),
    social_product: step(
      '正在看在售商品',
      '看在售商品',
      found('個商品'),
      facts => `來源：${facts.platform ?? '平台'}上在售的商品。`
    ),
    social_profile: step('正在看帳號資料', '看帳號資料', said('看過了'), publicData),
    social_search: step('正在搜同類作品', '搜同類作品', found('則作品'), publicData),
    social_trending: step(
      '正在看熱門榜',
      '看熱門榜',
      facts => (facts.count ? `看了 ${facts.count} 則熱點` : '看過了'),
      publicData
    ),
    generate_image: step('正在生成圖片', '生成圖片', facts =>
      facts.count ? `生成了 ${facts.count} 張圖片` : '圖片做好了'
    ),
    generate_video: step('正在生成影片', '生成影片', facts =>
      facts.count ? `生成了 ${facts.count} 部影片` : '影片做好了'
    ),
    video_highlights: step('正在挑選影片精華', '挑選影片精華', facts =>
      facts.count ? `挑出 ${facts.count} 段` : facts.empty ? '沒挑出能用的段落' : '已交給平台'
    ),
    video_moment_search: step('正在依描述找畫面', '依描述找畫面', facts =>
      facts.count ? `找到 ${facts.count} 處畫面` : facts.empty ? '沒找到' : '已交給平台'
    ),
    live_record_start: step('正在開始錄直播', '開始錄直播', said('開始錄了')),
    live_record_status: step('正在查看錄製進度', '查看錄製進度', said('看過了')),
    live_record_stop: step('正在結束錄製', '結束錄製', said('錄好了')),
    honesty_verify: step('正在檢查文案說法', '檢查文案說法', said('檢查好了')),
    doc_file_write: step('正在生成文件', '生成文件', said('文件做好了')),
    xlsx_file_write: step('正在生成試算表', '生成試算表', said('試算表做好了')),
    pptx_file_write: step('正在生成簡報', '生成簡報', said('簡報做好了')),
    feishu_doc_write: step('正在寫進飛書文件', '寫進飛書文件', said('寫好了')),
    feishu_bitable_write: step('正在寫進飛書表格', '寫進飛書表格', facts =>
      facts.count ? `寫入了 ${facts.count} 列` : '寫好了'
    ),
    tool_search: step('正在找能用的工具', '找能用的工具', found('個工具')),
    tool_describe: step('正在看工具怎麼用', '看工具說明', said('看過了')),
    tool_call: step('正在處理', '處理', said('好了')),
    skill_view: step('正在準備做法', '準備做法', said('準備好了')),
    skills_list: step('正在看有哪些做法', '看有哪些做法', said('看過了')),
    skill_manage: step('正在更新做法', '更新做法', said('更新好了')),
    web_search: step('正在搜網頁', '搜網頁', found('筆結果'), () => '來源：網頁搜尋。'),
    web_extract: step('正在讀網頁', '讀網頁', each('讀了', '個網頁', '讀完了'), () => '來源：下面這些網頁。'),
    terminal: step('正在電腦上處理', '在電腦上處理', each('處理了', '次', '處理好了')),
    execute_code: step('正在處理資料', '處理資料', said('處理好了')),
    process_manage: step('正在查看背景工作', '查看背景工作', said('看過了')),
    read_file: step('正在讀檔案', '讀檔案', each('讀了', '個檔案', '讀完了')),
    write_file: step('正在寫檔案', '寫檔案', each('寫了', '個檔案', '存好了')),
    edit_file: step('正在改檔案', '改檔案', each('改了', '個檔案', '改好了')),
    patch: step('正在改檔案', '改檔案', each('改了', '個檔案', '改好了')),
    list_files: step('正在看資料夾', '看資料夾', facts => (facts.count ? `有 ${facts.count} 個檔案` : '看過了')),
    search_files: step('正在找檔案', '找檔案', found('處')),
    vision_analyze: step('正在看圖片', '看圖片', said('看過了')),
    video_analyze: step('正在看影片', '看影片', said('看過了')),
    image_generate: step('正在生成圖片', '生成圖片', said('圖片做好了')),
    video_generate: step('正在生成影片', '生成影片', said('影片做好了')),
    xai_video_edit: step('正在剪輯影片', '剪輯影片', said('剪好了')),
    xai_video_extend: step('正在延長影片', '延長影片', said('延長好了')),
    text_to_speech: step('正在生成配音', '生成配音', said('配音做好了')),
    browser_navigate: step('正在打開網頁', '打開網頁', each('打開了', '個網頁', '打開了')),
    browser_snapshot: step('正在讀頁面', '讀頁面', said('讀完了')),
    browser_click: step('正在點頁面', '點頁面', said('點好了')),
    browser_type: step('正在頁面上輸入', '頁面輸入', said('輸入好了')),
    browser_fill: step('正在填表', '填表', said('填好了')),
    browser_scroll: step('正在捲動頁面', '捲動頁面', said('好了')),
    browser_back: step('正在返回上一頁', '返回上一頁', said('好了')),
    browser_press: step('正在按鍵', '按鍵', said('好了')),
    browser_get_images: step('正在收集網頁圖片', '收集網頁圖片', found('張圖片')),
    browser_vision: step('正在看網頁畫面', '看網頁畫面', said('看過了')),
    browser_console: step('正在查看網頁訊息', '查看網頁訊息', said('看過了')),
    browser_cdp: step('正在操作瀏覽器', '操作瀏覽器', said('好了')),
    browser_dialog: step('正在處理彈出視窗', '處理彈出視窗', said('好了')),
    browser_vault: step('正在使用儲存的登入', '使用儲存的登入', said('好了')),
    browser_exec: step('正在網頁上操作', '網頁操作', said('好了')),
    browser_take_screenshot: step('正在截圖', '截圖', said('截好了')),
    todo: step('正在列計畫', '列計畫', facts => (facts.count ? `列了 ${facts.count} 項` : '列好了')),
    todo_list: step('正在列計畫', '列計畫', facts => (facts.count ? `列了 ${facts.count} 項` : '列好了')),
    memory: step('正在記下來', '記下重點', said('記好了')),
    session_search: step('正在翻之前的對話', '翻之前的對話', found('處')),
    session_search_recall: step('正在翻之前的對話', '翻之前的對話', found('處')),
    clarify: step('正在問你', '問你', said('問過了')),
    delegate_task: step('正在分派子任務', '分派子任務', facts =>
      facts.count ? `分出 ${facts.count} 個子任務` : '分派好了'
    ),
    cronjob: step('正在設定排程任務', '設定排程任務', said('設好了')),
    cronjob_manage: step('正在設定排程任務', '設定排程任務', said('設好了')),
    computer_use: step('正在操作電腦', '操作電腦', said('好了')),
    manage_connections: step('正在管理連線', '管理連線', said('好了')),
    manage_catalog: step('正在看能連接的應用程式', '看能連接的應用程式', said('看過了')),
    send_message: step('正在傳訊息', '傳訊息', said('傳好了')),
    react_to_message: step('正在回應', '回應', said('好了')),
    read_terminal: step('正在看終端機', '看終端機', said('看過了')),
    close_terminal: step('正在關閉終端機', '關閉終端機', said('關好了')),
    read_window_below: step('正在看視窗內容', '看視窗內容', said('看過了')),
    focus_pane: step('正在切換面板', '切換面板', said('好了')),
    gui_tour: step('正在帶你看介面', '帶你看介面', said('好了')),
    set_theme: step('正在換主題', '換主題', said('換好了')),
    setup_beat: step('正在設定', '設定', said('好了')),
    show_tip: step('正在顯示提示', '顯示提示', said('好了')),
    annotate_preview: step('正在標註預覽', '標註預覽', said('標好了')),
    desktop_preview: step('正在打開預覽', '打開預覽', said('打開了')),
    desktop_project: step('正在更新專案', '更新專案', said('更新好了')),
    drive_preview: step('正在打開檔案預覽', '打開檔案預覽', said('打開了')),
    feishu_doc_read: step('正在讀飛書文件', '讀飛書文件', said('讀完了')),
    feishu_drive_add_comment: step('正在新增飛書評論', '新增飛書評論', said('加好了')),
    feishu_drive_list_comments: step('正在看飛書評論', '看飛書評論', found('則評論')),
    feishu_drive_list_comment_replies: step('正在看評論回覆', '看評論回覆', found('則回覆')),
    feishu_drive_reply_comment: step('正在回覆評論', '回覆評論', said('回好了')),
    x_search: step('正在搜尋 X 平台', '搜尋 X 平台', found('則內容'), publicData),
    ...Object.fromEntries(
      Object.entries(KANBAN).map(([name, [running, title]]) => [name, step(running, title, said('好了'))])
    )
  },
  unknownStep: step('正在處理', '處理', said('好了')),
  status: {
    preparing: '正在準備…',
    thinking: '正在思考…',
    writing: '正在整理結果…',
    running: running => `${running}…`,
    stepOf: index => `第 ${index} 步`,
    stepOfTotal: (index, total) => `第 ${index} 步，共 ${total} 步`,
    chainSeparator: ' → ',
    moreSteps: total => `共 ${total} 步`,
    took: duration => `用時 ${duration}`,
    failed: title => `${title}沒成功`,
    stopped: title => `停在了「${title}」`,
    methodsOnly: names => `參考了這些做法：${names}`
  },
  showSteps: '看步驟',
  hideSteps: '收起步驟',
  stepsLabel: '步驟',
  showSource: '資料從哪來',
  hideSource: '收起來源',
  source: {
    platform: name => `來源平台：${name}`,
    links: '連結',
    queries: '搜尋詞',
    count: count => `拿到 ${count} 筆`
  },
  stepFailed: '沒成功',
  stepPartlyFailed: count => `其中 ${count} 次沒成功`,
  stepStopped: '沒做完',
  slowHint: '這一步要久一點，你可以先去忙別的。',
  methods: names => `用到的方法：${names}`,
  listSeparator: '、',
  subtasks: {
    title: '子任務',
    done: '已完成',
    running: '進行中',
    failed: '沒成功',
    dispatched: '已分派'
  },
  reasoning: {
    thinking: '正在想',
    thought: '想過了',
    thoughtFor: duration => `想了 ${duration}`,
    collapse: '收起'
  },
  failure: {
    fallbackReason: '這一步沒有拿到結果。',
    keptNote: '已經拿到的部分不會遺失。',
    retry: '重試',
    anotherWay: '換個辦法',
    partial: '先給我能出的部分',
    retryMessage: title => `再試一次「${title}」這一步。`,
    anotherWayMessage: title => `「${title}」這一步沒成功，換個辦法繼續。`,
    partialMessage: title => `「${title}」先跳過，把已經拿到的部分整理給我。`
  },
  tech: {
    title: '技術細節',
    line: (names, duration) => (duration ? `${names} · ${duration}` : names),
    calls: count => `${count} 次呼叫`
  },
  compactNumber: value =>
    value >= 1e8 ? `${tenths(value / 1e8)} 億` : value >= 1e4 ? `${tenths(value / 1e4)} 萬` : String(value),
  platforms: {
    bilibili: '嗶哩嗶哩',
    douyin: '抖音',
    instagram: 'Instagram',
    kuaishou: '快手',
    tiktok: 'TikTok',
    wechat_channels: '視訊號',
    wechat_mp: '公眾號',
    weibo: '微博',
    x: 'X',
    xiaohongshu: '小紅書',
    youtube: 'YouTube',
    zhihu: '知乎'
  }
}
