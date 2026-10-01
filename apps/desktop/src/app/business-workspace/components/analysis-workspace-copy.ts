export const ANALYSIS_WORKSPACE_COPY = {
  zh: {
    outline: '目录', notes: '研究笔记', reader: '原文阅读', media: '素材与逐字稿',
    readingCompanion: '阅读伙伴', viewingCompanion: '观看伙伴', navigation: '资料导航',
    emptyOutline: '尚无可定位的原文片段。', jumpReader: '跳到原文', jumpMedia: '跳到素材',
    jumpCompanion: '跳到伙伴', sheet: '工作表', row: '行', cell: '单元格', value: '原文值',
    sparse: '仅显示有数据的行和列；地址之间的空行、空列未展开。',
    compact: '数据分布较广，按有值单元格显示，保留实际地址。', unplaced: '其它原文片段'
  },
  'zh-hant': {
    outline: '目錄', notes: '研究筆記', reader: '原文閱讀', media: '素材與逐字稿',
    readingCompanion: '閱讀夥伴', viewingCompanion: '觀看夥伴', navigation: '資料導覽',
    emptyOutline: '尚無可定位的原文片段。', jumpReader: '跳至原文', jumpMedia: '跳至素材',
    jumpCompanion: '跳至夥伴', sheet: '工作表', row: '列', cell: '儲存格', value: '原文值',
    sparse: '僅顯示有資料的列與欄；地址之間的空列、空欄未展開。',
    compact: '資料分布較廣，按有值儲存格顯示，保留實際地址。', unplaced: '其它原文片段'
  },
  en: {
    outline: 'Outline', notes: 'Research notes', reader: 'Source reader', media: 'Media and transcript',
    readingCompanion: 'Reading companion', viewingCompanion: 'Viewing companion', navigation: 'Source navigation',
    emptyOutline: 'No source excerpts can be located yet.', jumpReader: 'Go to source', jumpMedia: 'Go to media',
    jumpCompanion: 'Go to companion', sheet: 'Worksheet', row: 'Row', cell: 'Cell', value: 'Source value',
    sparse: 'Only populated rows and columns are shown. Gaps in their addresses are not expanded.',
    compact: 'Widely spaced data is shown by populated cell, preserving actual addresses.', unplaced: 'Other source excerpts'
  },
  ja: {
    outline: '目次', notes: '研究ノート', reader: '原文を読む', media: '素材と文字起こし',
    readingCompanion: '読書パートナー', viewingCompanion: '視聴パートナー', navigation: '資料ナビゲーション',
    emptyOutline: '移動できる原文の抜粋はまだありません。', jumpReader: '原文へ移動', jumpMedia: '素材へ移動',
    jumpCompanion: 'パートナーへ移動', sheet: 'ワークシート', row: '行', cell: 'セル', value: '原文の値',
    sparse: 'データのある行と列のみ表示します。セル番地の間の空行・空列は展開しません。',
    compact: '広く分布するデータは、実際のセル番地を保持して値のあるセルごとに表示します。', unplaced: 'その他の原文の抜粋'
  },
  ar: {
    outline: 'الفهرس', notes: 'ملاحظات البحث', reader: 'قراءة المصدر', media: 'الوسائط والنص المفرغ',
    readingCompanion: 'رفيق القراءة', viewingCompanion: 'رفيق المشاهدة', navigation: 'التنقل في المصدر',
    emptyOutline: 'لا توجد مقتطفات من المصدر يمكن الانتقال إليها بعد.', jumpReader: 'الانتقال إلى المصدر', jumpMedia: 'الانتقال إلى الوسائط',
    jumpCompanion: 'الانتقال إلى الرفيق', sheet: 'ورقة العمل', row: 'الصف', cell: 'الخلية', value: 'قيمة المصدر',
    sparse: 'تُعرض الصفوف والأعمدة التي تحتوي على بيانات فقط، دون توسيع الفجوات بين العناوين.',
    compact: 'تُعرض البيانات المتباعدة حسب الخلايا المملوءة مع الحفاظ على عناوينها الفعلية.', unplaced: 'مقتطفات أخرى من المصدر'
  }
} as const
