/**
 * hc-1123: the words single-thread product mode uses where the catalogs say
 * 项目 or Hermes. Developer mode and the switch off keep the catalogs' words, so
 * these are overlays on top of them, not edits to them. They live beside the
 * catalogs because those files are past the code-health size cap.
 *
 * The composer's chip picks a working folder. It was only ever called a project.
 */

import type { Locale, Translations } from './types'

type FolderPickerWords = Pick<
  Translations['composer']['projectPicker'],
  | 'chooseParentTitle'
  | 'createFailed'
  | 'label'
  | 'namePlaceholder'
  | 'newBlank'
  | 'newTitle'
  | 'noMatches'
  | 'noRecent'
  | 'recentHeading'
  | 'searchPlaceholder'
  | 'select'
  | 'useExistingTitle'
>

export const PRODUCT_FOLDER_PICKER_WORDS: Readonly<Record<Locale, FolderPickerWords>> = {
  ar: {
    chooseParentTitle: 'اختر مكان إنشاء المجلد',
    createFailed: 'تعذر إنشاء المجلد',
    label: 'مجلد',
    namePlaceholder: 'اسم المجلد',
    newBlank: 'مجلد فارغ جديد…',
    newTitle: 'مجلد جديد',
    noMatches: 'لا توجد مجلدات مطابقة',
    noRecent: 'لا توجد مجلدات بعد',
    recentHeading: 'المجلدات الأخيرة',
    searchPlaceholder: 'ابحث في المجلدات…',
    select: 'اختر مجلدًا',
    useExistingTitle: 'اختر مجلدًا'
  },
  en: {
    chooseParentTitle: 'Choose where to create the folder',
    createFailed: 'Could not create the folder',
    label: 'Folder',
    namePlaceholder: 'Folder name',
    newBlank: 'New blank folder…',
    newTitle: 'New folder',
    noMatches: 'No matching folders',
    noRecent: 'No folders yet',
    recentHeading: 'Recent folders',
    searchPlaceholder: 'Search folders…',
    select: 'Choose folder',
    useExistingTitle: 'Choose a folder'
  },
  ja: {
    chooseParentTitle: 'フォルダの作成先を選択',
    createFailed: 'フォルダを作成できませんでした',
    label: 'フォルダ',
    namePlaceholder: 'フォルダ名',
    newBlank: '空のフォルダを新規作成…',
    newTitle: '新しいフォルダ',
    noMatches: '一致するフォルダはありません',
    noRecent: 'フォルダはまだありません',
    recentHeading: '最近のフォルダ',
    searchPlaceholder: 'フォルダを検索…',
    select: 'フォルダを選択',
    useExistingTitle: 'フォルダを選択'
  },
  zh: {
    chooseParentTitle: '选择新文件夹放在哪里',
    createFailed: '无法创建文件夹',
    label: '文件夹',
    namePlaceholder: '文件夹名称',
    newBlank: '新建空白文件夹…',
    newTitle: '新建文件夹',
    noMatches: '没有匹配的文件夹',
    noRecent: '还没有用过的文件夹',
    recentHeading: '最近用过的文件夹',
    searchPlaceholder: '搜索文件夹…',
    select: '选择文件夹',
    useExistingTitle: '选择文件夹'
  },
  'zh-hant': {
    chooseParentTitle: '選擇新資料夾放在哪裡',
    createFailed: '無法建立資料夾',
    label: '資料夾',
    namePlaceholder: '資料夾名稱',
    newBlank: '新建空白資料夾…',
    newTitle: '新建資料夾',
    noMatches: '沒有符合的資料夾',
    noRecent: '還沒有用過的資料夾',
    recentHeading: '最近用過的資料夾',
    searchPlaceholder: '搜尋資料夾…',
    select: '選擇資料夾',
    useExistingTitle: '選擇資料夾'
  }
}

type DeliverablesWords = Pick<
  Translations['businessWorkspace']['workflowDomain']['deliverables'],
  'description' | 'emptyDescription'
>

export const PRODUCT_DELIVERABLES_WORDS: Readonly<Record<Locale, DeliverablesWords>> = {
  ar: {
    description: 'راجع ما أنجزه APEX وتحقق منه واعتمده.',
    emptyDescription: 'ستظهر هنا النتائج التي ينجزها APEX.'
  },
  en: {
    description: 'Review, verify, and approve what APEX has made.',
    emptyDescription: 'What APEX makes will show up here.'
  },
  ja: {
    description: 'APEX が作成した成果を確認、検証、承認します。',
    emptyDescription: 'APEX が作成した成果はここに表示されます。'
  },
  zh: {
    description: '查看、验证并确认 APEX 做好的成果。',
    emptyDescription: 'APEX 做好的成果会出现在这里。'
  },
  'zh-hant': {
    description: '檢視、驗證並確認 APEX 做好的成果。',
    emptyDescription: 'APEX 做好的成果會出現在這裡。'
  }
}
