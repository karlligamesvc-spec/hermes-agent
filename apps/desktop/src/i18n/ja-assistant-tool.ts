import type { AssistantToolOverrides } from './define-locale'

export const jaAssistantTool: AssistantToolOverrides = {
  copyCode: 'コードをコピー',
  renderingImage: '画像をレンダリング中',
  copyOutput: '出力をコピー',
  copyCommand: 'コマンドをコピー',
  copyContent: 'コンテンツをコピー',
  copyUrl: 'URL をコピー',
  copyResults: '結果をコピー',
  copyQuery: 'クエリをコピー',
  copyFile: 'ファイルをコピー',
  copyPath: 'パスをコピー',
  failedCalls: (count: number) => `失敗したツール呼び出し: ${count}`,
  skillActivity: {
    loading: 'スキルを読み込み中',
    loaded: 'スキルを読み込みました',
    loadFailed: 'スキルの読み込みに失敗しました',
    readingResource: 'スキルのリソースを読み込み中',
    readResource: 'スキルのリソースを読み込みました',
    resourceFailed: 'スキルのリソースの読み込みに失敗しました',
    listing: 'スキル一覧を取得中',
    listed: 'スキル一覧を取得しました',
    listFailed: 'スキル一覧の取得に失敗しました',
    unavailable: 'スキルの結果を取得できません'
  },
  outputAlt: 'ツール出力',
  rawResponse: '生の応答',
  copyActivity: 'アクティビティをコピー',
  recoveredOne: '1 つの失敗したステップの後に回復しました',
  recoveredMany: count => `${count} つの失敗したステップの後に回復しました`,
  failedOne: '1 つのステップが失敗しました',
  failedMany: count => `${count} つのステップが失敗しました`,
  statusRunning: '実行中',
  statusError: 'エラー',
  statusRecovered: '回復しました',
  statusDone: '完了',
  actions: {
    read: '読み取り完了',
    reading: '読み取り中',
    opened: 'オープン済み',
    opening: 'オープン中',
    failedToOpen: 'オープン失敗',
    searched: '検索完了',
    searching: '検索中',
    ran: '実行完了',
    running: '実行中',
    ranCode: 'コード実行完了',
    runningCode: 'スクリプト作成中'
  },
  prefixes: {
    browser: 'ブラウザー',
    web: 'Web'
  },
  titleTemplates: {
    actionCommand: (action, command) => `${action} ${command}`,
    actionQuoted: (action, value) => `「${value}」を${action}`,
    actionTarget: (action, target) => `${target} を${action}`,
    prefixedDone: (prefix, action) => `${prefix} ${action}`,
    runningPrefixedTool: (prefix, action) => `${prefix} ${action}を実行中`,
    runningTool: action => `${action}を実行中`
  },
  titles: {
    browser_click: {
      done: 'ページ要素をクリックしました',
      pending: 'ページ要素をクリック中',
      pendingAction: 'クリック中'
    },
    browser_fill: { done: 'フォーム欄に入力しました', pending: 'フォーム欄に入力中', pendingAction: '入力中' },
    browser_navigate: { done: 'ページを開きました', pending: 'ページをオープン中', pendingAction: 'オープン中' },
    browser_snapshot: {
      done: 'ページスナップショットを取得しました',
      pending: 'ページスナップショットを取得中',
      pendingAction: '取得中'
    },
    browser_take_screenshot: {
      done: 'スクリーンショットを取得しました',
      pending: 'スクリーンショットを取得中',
      pendingAction: '取得中'
    },
    browser_type: { done: 'ページに入力しました', pending: 'ページに入力中', pendingAction: '入力中' },
    clarify: { done: '質問しました', pending: '質問中', pendingAction: '質問中' },
    cronjob: { done: 'Cron ジョブ', pending: 'Cron ジョブをスケジュール中', pendingAction: 'スケジュール中' },
    edit_file: { done: 'ファイルを編集しました', pending: 'ファイルを編集中', pendingAction: '編集中' },
    execute_code: { done: 'コードを実行しました', pending: 'スクリプト作成中', pendingAction: 'スクリプト作成中' },
    image_generate: { done: '画像を生成しました', pending: '画像を生成中', pendingAction: '生成中' },
    list_files: {
      done: 'ファイルを一覧表示しました',
      pending: 'ファイルを一覧表示中',
      pendingAction: '一覧表示中'
    },
    patch: {
      done: 'ファイルにパッチを適用しました',
      pending: 'ファイルにパッチ適用中',
      pendingAction: 'パッチ適用中'
    },
    read_file: { done: 'ファイルを読み取りました', pending: 'ファイルを読み取り中', pendingAction: '読み取り中' },
    search_files: { done: 'ファイルを検索しました', pending: 'ファイルを検索中', pendingAction: '検索中' },
    session_search_recall: {
      done: 'セッション履歴を検索しました',
      pending: 'セッション履歴を検索中',
      pendingAction: '検索中'
    },
    terminal: { done: 'コマンドを実行しました', pending: 'コマンドを実行中', pendingAction: '実行中' },
    todo: { done: 'Todo を更新しました', pending: 'Todo を更新中', pendingAction: '更新中' },
    vision_analyze: { done: '画像を分析しました', pending: '画像を分析中', pendingAction: '分析中' },
    web_extract: {
      done: 'Web ページを読み取りました',
      pending: 'Web ページを読み取り中',
      pendingAction: '読み取り中'
    },
    web_search: { done: 'Web を検索しました', pending: 'Web を検索中', pendingAction: '検索中' },
    write_file: { done: 'ファイルを編集しました', pending: 'ファイルを編集中', pendingAction: '編集中' }
  },
  searchResults: '検索結果',
  stdoutLabel: '出力',
  stderrLabel: 'エラー出力',
  countLabel: count => `${count} 件`,
  formatDuration: (value, unit) => `${value}${{ h: '時間', m: '分', ms: 'ミリ秒', s: '秒' }[unit]}`,
  runSummary: {
    delegate: { past: 'タスク委任', present: 'タスク委任中', count: count => `${count} 件` },
    edit: { past: 'ファイル編集', present: 'ファイル編集中', count: count => `${count} 件` },
    explore: { past: '調査', present: '調査中', count: count => `${count} 件` },
    other: { past: 'ツール使用', present: 'ツール使用中', count: count => `${count} 件` },
    run: { past: 'コマンド実行', present: 'コマンド実行中', count: count => `${count} 件` },
    separator: '、'
  },
  detail: {
    arguments: '引数',
    result: '結果',
    payload: 'ツールの詳細',
    search: '検索',
    details: '詳細',
    snapshotSummary: 'スナップショットの概要',
    errorDetails: 'エラーの詳細',
    duration: '所要時間',
    toolError: 'ツールがエラーを返しました。',
    toolSuccessFalse: 'ツールが失敗を報告しました。',
    toolStatus: status => `ツールがステータス「${status}」を返しました。`,
    exitCode: code => `コマンドが終了コード ${code} で失敗しました。`,
    truncated: count => `… 残り ${count} 文字を省略しました。全文はコピーで取得できます。`,
    snapshotStats: (buttons, links, inputs) => `ボタン ${buttons} · リンク ${links} · 入力欄 ${inputs}`,
    topControls: labels => `主なコントロール: ${labels}`,
    noCronJobsScheduled: '予定されたジョブはありません',
    cronSchedule: 'スケジュール',
    cronRepeat: '繰り返し',
    cronDelivery: '配信先',
    cronNextRun: '次回実行',
    delegatedTask: '委任したタスク',
    exitBadge: code => `終了コード ${code}`,
    items: count => `${count} 件`,
    fields: count => `${count} 個のフィールド`,
    moreItems: count => `… ほか ${count} 件`
  }
}
