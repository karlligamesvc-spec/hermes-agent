/**
 * Copy for hc-1016 记得你 v1: the 「它记得什么」 settings section and the 记下了 line
 * under a reply. Kept beside the feature (like creator-intake-copy.ts) because
 * the locale trees are at their size cap, and typed per locale so a missing key
 * is a compile error, not an English fallback.
 */

import type { Locale } from '@/i18n/types'
import type { MemoryKind } from '@/lib/memory-ledger'

export interface MemoryLedgerCopy {
  settings: {
    title: string
    intro: string
    /** Says plainly what a delete does and when the assistant stops knowing. */
    deleteNote: string
    groups: Record<MemoryKind, { title: string; hint: (days: number) => string; placeholder: string }>
    empty: string
    add: string
    edit: string
    remove: string
    save: string
    cancel: string
    loading: string
    unavailable: string
    failed: string
    gone: string
    /** The cloud's refusal reasons (detail.code), worded for the person. */
    refusals: Record<string, string>
  }
  noted: {
    /** 「APEX 记下了：…」; `name` is single-thread-chat's assistantName. */
    line: (content: string, name: string) => string
    undo: string
    undone: (content: string) => string
    undoFailed: string
  }
}

export const MEMORY_LEDGER_COPY: Record<Locale, MemoryLedgerCopy> = {
  zh: {
    settings: {
      title: '它记得什么',
      intro: '电脑上和微信、飞书里的助手记得的是同一份。每条都能改、删、加。',
      deleteNote: '删掉就是真删：从下一段对话起它就不知道了，正在聊的这一段里它可能还记得。',
      groups: {
        about_you: { title: '关于你', hint: () => '你是谁、喜欢怎么做', placeholder: '加一条，比如：不露脸，女声配音' },
        recent: {
          title: '最近发生的',
          hint: days => `做过的事和你报的数据，保留 ${days} 天`,
          placeholder: '加一条，比如：周三发了收纳三样，播放 1.2 万'
        }
      },
      empty: '还没有',
      add: '加上',
      edit: '改',
      remove: '删',
      save: '保存',
      cancel: '取消',
      loading: '正在读…',
      unavailable: '这个账号还没有记忆底账；登录后再打开这一页。',
      failed: '没存上，稍后再试。',
      gone: '这条已经不在了。',
      refusals: {
        empty_content: '写点什么再加。',
        content_too_long: '一句话，不超过 100 字。',
        sensitive_content: '像是密码、验证码、证件号或卡号，不能记。',
        ledger_full: '「关于你」已经记满 30 条，先删掉几条。'
      }
    },
    noted: {
      line: (content, name) => `${name} 记下了：${content}`,
      undo: '撤销',
      undone: content => `已撤销：${content}`,
      undoFailed: '没撤销成功，可以去「它记得什么」里删。'
    }
  },
  'zh-hant': {
    settings: {
      title: '它記得什麼',
      intro: '電腦上和微信、飛書裡的助手記得的是同一份。每條都能改、刪、加。',
      deleteNote: '刪掉就是真刪：從下一段對話起它就不知道了，正在聊的這一段裡它可能還記得。',
      groups: {
        about_you: { title: '關於你', hint: () => '你是誰、喜歡怎麼做', placeholder: '加一條，比如：不露臉，女聲配音' },
        recent: {
          title: '最近發生的',
          hint: days => `做過的事和你報的數據，保留 ${days} 天`,
          placeholder: '加一條，比如：週三發了收納三樣，播放 1.2 萬'
        }
      },
      empty: '還沒有',
      add: '加上',
      edit: '改',
      remove: '刪',
      save: '儲存',
      cancel: '取消',
      loading: '正在讀取…',
      unavailable: '這個帳號還沒有記憶底帳；登入後再開這一頁。',
      failed: '沒存上，稍後再試。',
      gone: '這條已經不在了。',
      refusals: {
        empty_content: '寫點什麼再加。',
        content_too_long: '一句話，不超過 100 字。',
        sensitive_content: '像是密碼、驗證碼、證件號或卡號，不能記。',
        ledger_full: '「關於你」已經記滿 30 條，先刪掉幾條。'
      }
    },
    noted: {
      line: (content, name) => `${name} 記下了：${content}`,
      undo: '撤銷',
      undone: content => `已撤銷：${content}`,
      undoFailed: '沒撤銷成功，可以去「它記得什麼」裡刪。'
    }
  },
  en: {
    settings: {
      title: 'What it remembers',
      intro:
        'Your assistant on this computer and in WeChat or Feishu remembers the same things. Edit, delete or add any of them.',
      deleteNote:
        'Deleting removes it for good: from the next conversation on, it will not know. The conversation in progress may still remember.',
      groups: {
        about_you: {
          title: 'About you',
          hint: () => 'Who you are and how you like things done',
          placeholder: 'Add one, e.g. never shows face, female voice-over'
        },
        recent: {
          title: 'Recently',
          hint: days => `Things done together and numbers you shared, kept ${days} days`,
          placeholder: 'Add one, e.g. posted the storage video Wednesday, 12k views'
        }
      },
      empty: 'Nothing yet',
      add: 'Add',
      edit: 'Edit',
      remove: 'Delete',
      save: 'Save',
      cancel: 'Cancel',
      loading: 'Loading…',
      unavailable: 'This account has no memory yet. Sign in, then open this page again.',
      failed: 'Not saved. Try again in a moment.',
      gone: 'This one is already gone.',
      refusals: {
        empty_content: 'Write something first.',
        content_too_long: 'One sentence, at most 100 characters.',
        sensitive_content: 'That looks like a password, code, ID or card number, so it cannot be kept.',
        ledger_full: '“About you” is full (30). Delete a few first.'
      }
    },
    noted: {
      line: (content, name) => `${name} noted: ${content}`,
      undo: 'Undo',
      undone: content => `Undone: ${content}`,
      undoFailed: 'Could not undo. You can delete it in “What it remembers”.'
    }
  },
  ja: {
    settings: {
      title: '覚えていること',
      intro: 'このパソコンと WeChat・Feishu のアシスタントは同じことを覚えています。どれも編集・削除・追加できます。',
      deleteNote: '削除すると完全に消えます。次の会話からは知りません。進行中の会話ではまだ覚えている場合があります。',
      groups: {
        about_you: {
          title: 'あなたについて',
          hint: () => 'あなたのことと、好みのやり方',
          placeholder: '追加：例）顔出しなし、女性ナレーション'
        },
        recent: {
          title: '最近のこと',
          hint: days => `一緒にやったことと共有された数字（${days} 日間保存）`,
          placeholder: '追加：例）水曜に収納動画を投稿、再生 1.2 万'
        }
      },
      empty: 'まだありません',
      add: '追加',
      edit: '編集',
      remove: '削除',
      save: '保存',
      cancel: 'キャンセル',
      loading: '読み込み中…',
      unavailable: 'このアカウントにはまだ記憶がありません。サインインしてから開き直してください。',
      failed: '保存できませんでした。少し待ってからもう一度。',
      gone: 'これはもうありません。',
      refusals: {
        empty_content: '何か書いてから追加してください。',
        content_too_long: '一文、100 文字以内で。',
        sensitive_content: 'パスワード・認証コード・証明書番号・カード番号のようなので、覚えられません。',
        ledger_full: '「あなたについて」は 30 件でいっぱいです。先にいくつか削除してください。'
      }
    },
    noted: {
      line: (content, name) => `${name} が覚えました：${content}`,
      undo: '取り消す',
      undone: content => `取り消しました：${content}`,
      undoFailed: '取り消せませんでした。「覚えていること」で削除できます。'
    }
  },
  ar: {
    settings: {
      title: 'ما الذي يتذكره',
      intro:
        'المساعد على هذا الكمبيوتر وفي WeChat وFeishu يتذكر الأشياء نفسها. يمكنك تعديل أي منها أو حذفه أو إضافة جديد.',
      deleteNote: 'الحذف نهائي: من المحادثة التالية لن يعرفه. قد يتذكره في المحادثة الجارية.',
      groups: {
        about_you: {
          title: 'عنك',
          hint: () => 'من أنت وكيف تحب أن تُنجز الأمور',
          placeholder: 'أضف واحدًا، مثلًا: بلا ظهور للوجه، تعليق صوتي نسائي'
        },
        recent: {
          title: 'مؤخرًا',
          hint: days => `ما أنجزناه معًا والأرقام التي شاركتها، يُحفظ ${days} يومًا`,
          placeholder: 'أضف واحدًا، مثلًا: نشرت فيديو التنظيم الأربعاء، 12 ألف مشاهدة'
        }
      },
      empty: 'لا شيء بعد',
      add: 'إضافة',
      edit: 'تعديل',
      remove: 'حذف',
      save: 'حفظ',
      cancel: 'إلغاء',
      loading: 'جارٍ التحميل…',
      unavailable: 'لا توجد ذاكرة لهذا الحساب بعد. سجّل الدخول ثم افتح هذه الصفحة مرة أخرى.',
      failed: 'لم يُحفظ. حاول مرة أخرى بعد قليل.',
      gone: 'هذا العنصر لم يعد موجودًا.',
      refusals: {
        empty_content: 'اكتب شيئًا أولًا.',
        content_too_long: 'جملة واحدة، 100 حرف على الأكثر.',
        sensitive_content: 'يبدو ككلمة مرور أو رمز أو رقم هوية أو بطاقة، لذلك لا يمكن حفظه.',
        ledger_full: 'قائمة «عنك» ممتلئة (30). احذف بعضها أولًا.'
      }
    },
    noted: {
      line: content => `تم الحفظ: ${content}`,
      undo: 'تراجع',
      undone: content => `تم التراجع: ${content}`,
      undoFailed: 'تعذّر التراجع. يمكنك حذفه من «ما الذي يتذكره».'
    }
  }
}
