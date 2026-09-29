import type { VideoBreakdownLocale } from './video-deep-breakdown-draft'

export const VIDEO_WORKSPACE_COPY = {
  zh: {
    notice: '同时为本资料建立本机输出目录；助手完成后可回到这里收取报告。删除资料也会删除该目录。',
    prompt: '仅在以下输出目录开展本次深拆；Hypit 命令用 --workspace 显式指定该目录。先检查实际安装版本与能力，不存在 analyze 子命令。根据本条消息发送时仍有的证据，用普通文件写入 ANALYSIS.md（整体分析）和 TIMELINE.md（时间码与依据），每份非空 UTF-8 ≤64 KiB。只写最终报告，不写原始思维链；无画面/音频时明确缺口。不要修改 apex-source.json，不要扫描其他项目找同名报告。此目录不包含原视频或转写；只读取本条消息实际附着或用户授权的资料。输出目录：'
  },
  'zh-hant': {
    notice: '同時為本資料建立本機輸出目錄；助手完成後可回到這裡收取報告。刪除資料也會刪除該目錄。',
    prompt: '僅在以下輸出目錄進行本次深拆；Hypit 命令用 --workspace 明確指定該目錄。先核對實際安裝版本與能力，不存在 analyze 子命令。根據傳送時仍有的證據，寫入普通檔案 ANALYSIS.md（整體分析）及 TIMELINE.md（時間碼與依據），每份非空 UTF-8 ≤64 KiB。只寫最終報告，不寫原始思維鏈；缺少畫面或音訊須明示。勿修改 apex-source.json 或搜尋其他專案的同名報告。目錄不含原影片或逐字稿；僅讀取實際附件或使用者授權的資料。輸出目錄：'
  },
  en: {
    notice: 'A local output folder is also created for this source. Return here to collect the Agent’s reports. Deleting the source deletes that folder too.',
    prompt: 'Use only this output folder for this breakdown, passing it explicitly as --workspace to Hypit commands. Check the installed version and capabilities first; there is no analyze command. Write ordinary ANALYSIS.md (overall analysis) and TIMELINE.md (timecodes and evidence), each nonempty UTF-8 ≤64 KiB, based on evidence still present at send time. Write final findings, never raw chain of thought; disclose missing visual/audio evidence. Do not modify apex-source.json or search other projects for reports. This folder contains no video or transcript; read only actual message attachments or user-authorized sources. Output folder:'
  },
  ja: {
    notice: '資料専用のローカル出力フォルダも作成します。助手の完了後ここからレポートを取得できます。資料を削除するとこのフォルダも削除されます。',
    prompt: '今回の分析には次の出力フォルダのみを使い、Hypit の --workspace に明示してください。まず実際のバージョンと機能を確認してください。analyze コマンドはありません。送信時に残る証拠に基づき通常の ANALYSIS.md（全体分析）と TIMELINE.md（時刻と根拠）を作成してください。各ファイルは空でない UTF-8、64 KiB 以下です。最終的な結論のみを書き、内部思考過程は書かず、映像・音声の不足を明示してください。apex-source.json を変更したり他のプロジェクトを検索したりしないでください。このフォルダには動画や文字起こしはありません。実際の添付またはユーザーが許可した資料のみ読み取ってください。出力フォルダ：'
  },
  ar: {
    notice: 'سيُنشأ أيضًا مجلد إخراج محلي لهذا المصدر. عد هنا لجمع تقارير الوكيل. حذف المصدر يحذف هذا المجلد أيضًا.',
    prompt: 'استخدم مجلد الإخراج التالي وحده لهذا التحليل وحدده عبر --workspace في أوامر Hypit. تحقق أولًا من الإصدار المثبت وقدراته؛ لا يوجد أمر analyze. اكتب ملفي ANALYSIS.md للتحليل العام وTIMELINE.md للتوقيت والأدلة، كل منهما غير فارغ بترميز UTF-8 وبحد 64 KiB، وفق الأدلة الموجودة عند الإرسال. اكتب النتائج النهائية دون سلسلة التفكير الداخلية، ووضح غياب دليل مرئي أو صوتي. لا تعدل apex-source.json ولا تبحث عن تقارير في مشاريع أخرى. المجلد لا يحتوي على الفيديو أو النص؛ اقرأ المرفقات الفعلية أو المصادر المصرح بها فقط. مجلد الإخراج:'
  }
} satisfies Record<VideoBreakdownLocale, { notice: string; prompt: string }>

export function videoWorkspaceDraft(locale: VideoBreakdownLocale, directory: string): string {
  return `\n\n${VIDEO_WORKSPACE_COPY[locale].prompt}\n${JSON.stringify(directory)}`
}
