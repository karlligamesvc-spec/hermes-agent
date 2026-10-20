/**
 * Copy for the hc-991 first-use creator intake: the three Start-page cards and
 * the 创作档案 settings section. Kept beside the business workspace (like
 * analysis-page-copy.ts) because the locale trees are at their size cap, and
 * typed per locale so a missing key is a compile error, not an English fallback.
 */

import type {
  DesktopCreatorContentType,
  DesktopCreatorIntakeStep,
  DesktopCreatorPainPoint,
  DesktopCreatorPlatform
} from '@/global'
import type { Locale } from '@/i18n/types'

export interface CreatorIntakeCopy {
  /** Region label for the cards on the Start page. */
  region: string
  progress: (step: number, total: number) => string
  questions: Record<DesktopCreatorIntakeStep, { lead: string; title: string; hint: string }>
  contentTypes: Record<Exclude<DesktopCreatorContentType, 'other'>, string>
  otherPlaceholder: string
  platforms: Record<DesktopCreatorPlatform, string>
  painPoints: Record<DesktopCreatorPainPoint, string>
  skip: string
  continueLabel: string
  saving: string
  saveFailed: string
  /** Shown once the third card is answered or skipped. */
  done: (summary: string) => string
  doneNothing: string
  dismiss: string
  summarySeparator: string
  listSeparator: string
  settings: {
    title: string
    intro: string
    contentType: string
    platforms: string
    painPoint: string
    notSet: string
    saved: string
    saveFailed: string
    loading: string
    unavailable: string
  }
}

export const CREATOR_INTAKE_COPY: Record<Locale, CreatorIntakeCopy> = {
  zh: {
    region: '认识一下你',
    progress: (step, total) => `第 ${step} 题，共 ${total} 题`,
    questions: {
      content_type: {
        lead: '先回答 3 个小问题，我就知道该怎么帮你。',
        title: '你主要做什么内容？',
        hint: '点一下就行，也可以自己写。'
      },
      platforms: { lead: '记下了。', title: '主要发在哪个平台？', hint: '可以多选，选好点「继续」。' },
      pain_point: { lead: '好，就按这些平台的习惯来。', title: '现在最头疼的是哪件事？', hint: '点一下就行。' }
    },
    contentTypes: {
      product_review: '好物测评',
      knowledge: '知识口播',
      store_visit: '探店',
      drama: '剧情',
      vlog: 'Vlog'
    },
    otherPlaceholder: '其他（自己写）',
    platforms: { douyin: '抖音', xiaohongshu: '小红书', channels: '视频号', kuaishou: '快手', bilibili: 'B 站' },
    painPoints: {
      no_topic: '没选题',
      no_script: '不会写脚本',
      no_editing: '不会剪',
      no_traffic: '没流量',
      no_shooting: '不会拍'
    },
    skip: '先跳过',
    continueLabel: '继续',
    saving: '正在保存…',
    saveFailed: '没保存上，请再点一次。',
    done: summary => `记住了：${summary}。之后的任务都会按这个来，想改可以去「设置 › 个性化」。`,
    doneNothing: '好，先不填。想补的话可以去「设置 › 个性化」。',
    dismiss: '知道了',
    summarySeparator: ' · ',
    listSeparator: '、',
    settings: {
      title: '创作档案',
      intro:
        '第一次使用时选的三件事，助手做任务时会按这些来。改完以后，桌面上新开的对话马上按新的来；云端助手（飞书、微信等）在下次重启后用上。',
      contentType: '主要做的内容',
      platforms: '主要发布平台',
      painPoint: '最头疼的事',
      notSet: '没填',
      saved: '已保存',
      saveFailed: '没保存上，请再试一次。',
      loading: '正在读取创作档案…',
      unavailable: '登录 APEX 账号后可以填写；如果已经登录，请稍后再打开这一页。'
    }
  },
  'zh-hant': {
    region: '認識一下你',
    progress: (step, total) => `第 ${step} 題，共 ${total} 題`,
    questions: {
      content_type: {
        lead: '先回答 3 個小問題，我就知道該怎麼幫你。',
        title: '你主要做什麼內容？',
        hint: '點一下就行，也可以自己寫。'
      },
      platforms: { lead: '記下了。', title: '主要發在哪個平台？', hint: '可以多選，選好點「繼續」。' },
      pain_point: { lead: '好，就按這些平台的習慣來。', title: '現在最頭痛的是哪件事？', hint: '點一下就行。' }
    },
    contentTypes: {
      product_review: '好物測評',
      knowledge: '知識口播',
      store_visit: '探店',
      drama: '劇情',
      vlog: 'Vlog'
    },
    otherPlaceholder: '其他（自己寫）',
    platforms: { douyin: '抖音', xiaohongshu: '小紅書', channels: '視頻號', kuaishou: '快手', bilibili: 'B 站' },
    painPoints: {
      no_topic: '沒選題',
      no_script: '不會寫腳本',
      no_editing: '不會剪',
      no_traffic: '沒流量',
      no_shooting: '不會拍'
    },
    skip: '先跳過',
    continueLabel: '繼續',
    saving: '正在儲存…',
    saveFailed: '沒儲存成功，請再點一次。',
    done: summary => `記住了：${summary}。之後的任務都會照這個來，想改可以去「設定 › 個性化」。`,
    doneNothing: '好，先不填。想補的話可以去「設定 › 個性化」。',
    dismiss: '知道了',
    summarySeparator: ' · ',
    listSeparator: '、',
    settings: {
      title: '創作檔案',
      intro:
        '第一次使用時選的三件事，助手做任務時會照這些來。改完以後，桌面上新開的對話馬上照新的來；雲端助手（飛書、微信等）在下次重啟後用上。',
      contentType: '主要做的內容',
      platforms: '主要發佈平台',
      painPoint: '最頭痛的事',
      notSet: '沒填',
      saved: '已儲存',
      saveFailed: '沒儲存成功，請再試一次。',
      loading: '正在讀取創作檔案…',
      unavailable: '登入 APEX 帳號後可以填寫；如果已經登入，請稍後再開這一頁。'
    }
  },
  en: {
    region: 'About you',
    progress: (step, total) => `Question ${step} of ${total}`,
    questions: {
      content_type: {
        lead: 'Three quick questions, and I will know how to help.',
        title: 'What do you mostly make?',
        hint: 'One tap is enough, or write your own.'
      },
      platforms: {
        lead: 'Got it.',
        title: 'Where do you mostly post?',
        hint: 'Pick any that apply, then press Continue.'
      },
      pain_point: {
        lead: 'Good, I will follow how those platforms work.',
        title: 'What is the hardest part right now?',
        hint: 'One tap is enough.'
      }
    },
    contentTypes: {
      product_review: 'Product reviews',
      knowledge: 'Explainers',
      store_visit: 'Shop and venue visits',
      drama: 'Skits',
      vlog: 'Vlogs'
    },
    otherPlaceholder: 'Something else (write it)',
    platforms: {
      douyin: 'Douyin',
      xiaohongshu: 'Xiaohongshu',
      channels: 'WeChat Channels',
      kuaishou: 'Kuaishou',
      bilibili: 'Bilibili'
    },
    painPoints: {
      no_topic: 'Finding topics',
      no_script: 'Writing scripts',
      no_editing: 'Editing',
      no_traffic: 'Getting views',
      no_shooting: 'Filming'
    },
    skip: 'Skip for now',
    continueLabel: 'Continue',
    saving: 'Saving…',
    saveFailed: 'That did not save. Press it again.',
    done: summary =>
      `Saved: ${summary}. Your tasks will follow this from now on. To change it, open Settings › Personalization.`,
    doneNothing: 'Fine, nothing filled in. You can add it later in Settings › Personalization.',
    dismiss: 'OK',
    summarySeparator: ' · ',
    listSeparator: ', ',
    settings: {
      title: 'Creator profile',
      intro:
        'The three things you picked on first use. Your assistants follow them in every task. After a change, new chats on this desktop use it right away; cloud assistants (Feishu, WeChat and others) pick it up after their next restart.',
      contentType: 'What you make',
      platforms: 'Where you post',
      painPoint: 'Hardest part',
      notSet: 'Not set',
      saved: 'Saved',
      saveFailed: 'That did not save. Try again.',
      loading: 'Loading your creator profile…',
      unavailable:
        'Sign in to your APEX account to fill this in. If you are signed in, open this page again in a moment.'
    }
  },
  ja: {
    region: 'あなたについて',
    progress: (step, total) => `${total} 問中 ${step} 問目`,
    questions: {
      content_type: {
        lead: '3 つだけ教えてください。手伝い方が分かります。',
        title: '主にどんな動画を作っていますか？',
        hint: 'タップするだけで OK。自分で書くこともできます。'
      },
      platforms: {
        lead: '分かりました。',
        title: '主にどこに投稿していますか？',
        hint: '複数選べます。選んだら「続ける」を押してください。'
      },
      pain_point: {
        lead: 'では、そのプラットフォームの流儀に合わせます。',
        title: 'いちばん困っていることは？',
        hint: 'タップするだけで OK。'
      }
    },
    contentTypes: {
      product_review: '商品レビュー',
      knowledge: '解説トーク',
      store_visit: 'お店めぐり',
      drama: 'ショートドラマ',
      vlog: 'Vlog'
    },
    otherPlaceholder: 'その他（自分で書く）',
    platforms: {
      douyin: 'Douyin',
      xiaohongshu: '小紅書',
      channels: 'WeChat チャンネル',
      kuaishou: '快手',
      bilibili: 'bilibili'
    },
    painPoints: {
      no_topic: 'ネタがない',
      no_script: '台本が書けない',
      no_editing: '編集できない',
      no_traffic: '再生されない',
      no_shooting: '撮影できない'
    },
    skip: 'あとで',
    continueLabel: '続ける',
    saving: '保存中…',
    saveFailed: '保存できませんでした。もう一度押してください。',
    done: summary =>
      `覚えました：${summary}。これからのタスクはこれに合わせます。変更は「設定 › パーソナライズ」から。`,
    doneNothing: '分かりました、未記入のままにします。あとで「設定 › パーソナライズ」から追加できます。',
    dismiss: 'OK',
    summarySeparator: ' · ',
    listSeparator: '、',
    settings: {
      title: 'クリエイタープロフィール',
      intro:
        '初回に選んだ 3 つの項目です。アシスタントはどのタスクでもこれに合わせます。変更すると、このデスクトップで新しく開く会話にはすぐ反映され、クラウドのアシスタント（Feishu、WeChat など）には次の再起動後に反映されます。',
      contentType: '作っている動画',
      platforms: '投稿先',
      painPoint: 'いちばん困っていること',
      notSet: '未設定',
      saved: '保存しました',
      saveFailed: '保存できませんでした。もう一度お試しください。',
      loading: 'クリエイタープロフィールを読み込み中…',
      unavailable:
        'APEX アカウントにサインインすると入力できます。サインイン済みの場合は、少し待ってからこのページを開き直してください。'
    }
  },
  ar: {
    region: 'تعرّف عليك',
    progress: (step, total) => `السؤال ${step} من ${total}`,
    questions: {
      content_type: {
        lead: 'ثلاثة أسئلة سريعة، وسأعرف كيف أساعدك.',
        title: 'ما نوع المحتوى الذي تصنعه غالبًا؟',
        hint: 'نقرة واحدة تكفي، أو اكتب إجابتك.'
      },
      platforms: { lead: 'تم.', title: 'أين تنشر غالبًا؟', hint: 'اختر كل ما ينطبق، ثم اضغط «متابعة».' },
      pain_point: { lead: 'حسنًا، سأتبع أسلوب هذه المنصات.', title: 'ما أصعب شيء الآن؟', hint: 'نقرة واحدة تكفي.' }
    },
    contentTypes: {
      product_review: 'مراجعات المنتجات',
      knowledge: 'شروحات',
      store_visit: 'زيارات المتاجر والأماكن',
      drama: 'مقاطع تمثيلية',
      vlog: 'مدونات فيديو'
    },
    otherPlaceholder: 'شيء آخر (اكتبه)',
    platforms: {
      douyin: 'Douyin',
      xiaohongshu: 'Xiaohongshu',
      channels: 'قنوات WeChat',
      kuaishou: 'Kuaishou',
      bilibili: 'Bilibili'
    },
    painPoints: {
      no_topic: 'إيجاد الأفكار',
      no_script: 'كتابة النص',
      no_editing: 'المونتاج',
      no_traffic: 'الحصول على مشاهدات',
      no_shooting: 'التصوير'
    },
    skip: 'تخطَّ الآن',
    continueLabel: 'متابعة',
    saving: 'جارٍ الحفظ…',
    saveFailed: 'لم يُحفظ. اضغط مرة أخرى.',
    done: summary => `تم الحفظ: ${summary}. ستتبع مهامك هذا من الآن. لتغييره افتح الإعدادات › Personalization.`,
    doneNothing: 'حسنًا، لن نملأ شيئًا الآن. يمكنك الإضافة لاحقًا من الإعدادات › Personalization.',
    dismiss: 'حسنًا',
    summarySeparator: ' · ',
    listSeparator: '، ',
    settings: {
      title: 'ملف صانع المحتوى',
      intro:
        'الأشياء الثلاثة التي اخترتها في أول استخدام. يتبعها مساعدوك في كل مهمة. بعد التغيير تستخدمه المحادثات الجديدة على هذا الجهاز فورًا، ويستخدمه المساعدون السحابيون (Feishu وWeChat وغيرهما) بعد إعادة تشغيلهم التالية.',
      contentType: 'ما تصنعه',
      platforms: 'أين تنشر',
      painPoint: 'أصعب شيء',
      notSet: 'غير محدد',
      saved: 'تم الحفظ',
      saveFailed: 'لم يُحفظ. حاول مرة أخرى.',
      loading: 'جارٍ تحميل ملف صانع المحتوى…',
      unavailable: 'سجّل الدخول إلى حساب APEX لملء هذا. إذا كنت مسجلًا، افتح هذه الصفحة مرة أخرى بعد قليل.'
    }
  }
}

/** One line naming what was answered, in the card's order; empty when nothing was. */
export function creatorAnswerSummary(
  copy: CreatorIntakeCopy,
  answers: {
    contentType: DesktopCreatorContentType | null
    contentTypeOther: null | string
    painPoint: DesktopCreatorPainPoint | null
    platforms: DesktopCreatorPlatform[]
  }
): string {
  const content =
    answers.contentType === 'other'
      ? answers.contentTypeOther
      : answers.contentType
        ? copy.contentTypes[answers.contentType]
        : null

  const parts = [
    content,
    answers.platforms.length > 0 ? answers.platforms.map(p => copy.platforms[p]).join(copy.listSeparator) : null,
    answers.painPoint ? copy.painPoints[answers.painPoint] : null
  ]

  return parts.filter((part): part is string => Boolean(part)).join(copy.summarySeparator)
}
