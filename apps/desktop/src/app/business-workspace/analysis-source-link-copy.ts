export const ANALYSIS_SOURCE_LINK_COPY = {
  zh: {
    open: '打开链接', placeholder: '粘贴链接或分享文案',
    ready: '已识别到链接。点击“打开链接”或按回车检查读取能力；支持的视频会尝试下载和转写，并计入媒体用量。',
    invalid: '未找到有效的 HTTPS 链接，请粘贴链接或包含链接的分享文案。',
    multiple: '识别到多个不同链接，请只保留本次要打开的一个。'
  },
  'zh-hant': {
    open: '開啟連結', placeholder: '貼上連結或分享文字',
    ready: '已識別到連結。按「開啟連結」或 Enter 檢查讀取能力；支援的影片會嘗試下載與轉寫，並計入媒體用量。',
    invalid: '未找到有效的 HTTPS 連結，請貼上連結或包含連結的分享文字。',
    multiple: '識別到多個不同連結，請只保留本次要開啟的一個。'
  },
  en: {
    open: 'Open link', placeholder: 'Paste a link or shared message',
    ready: 'Link recognized. Choose Open link or press Enter to check access. Supported videos will be downloaded and transcribed, counting toward media usage.',
    invalid: 'No valid HTTPS link found. Paste a link or a shared message containing one.',
    multiple: 'Several different links were found. Keep only the one you want to open.'
  },
  ja: {
    open: 'リンクを開く', placeholder: 'リンクまたは共有メッセージを貼り付け',
    ready: 'リンクを認識しました。「リンクを開く」または Enter で読み取り可否を確認します。対応する動画はダウンロードと文字起こしを試み、メディア使用量に計上されます。',
    invalid: '有効な HTTPS リンクが見つかりません。リンクまたはリンクを含む共有メッセージを貼り付けてください。',
    multiple: '複数の異なるリンクが見つかりました。開くリンクを一つだけ残してください。'
  },
  ar: {
    open: 'فتح الرابط', placeholder: 'الصق رابطًا أو رسالة مشاركة',
    ready: 'تم التعرف على الرابط. اختر فتح الرابط أو اضغط Enter للتحقق من إمكانية القراءة. ستُجرّب تنزيل الفيديوهات المدعومة وتفريغ صوتها، ويُحتسب ذلك ضمن استخدام الوسائط.',
    invalid: 'لم يُعثر على رابط HTTPS صالح. الصق رابطًا أو رسالة مشاركة تحتوي عليه.',
    multiple: 'عُثر على عدة روابط مختلفة. أبقِ فقط الرابط الذي تريد فتحه.'
  }
} as const
