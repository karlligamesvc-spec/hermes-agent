import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { $connection } from '@/store/session'

import type { AnalysisDocument, AnalysisDocumentsBridge, AnalysisQuestion, AnalysisVideoResolution } from '../analysis-types'
import { BusinessPageHeader } from '../components/business-page-header'
import { DeepAnalysisReports } from '../components/deep-analysis-reports'
import { VideoSemanticOverviewPanel } from '../components/video-semantic-overview'
import type { VideoBreakdownLocale } from '../video-deep-breakdown-draft'
import { captureVideoFrame, sampleVideoFrames } from '../video-frame-evidence'
import { videoQuickOverview } from '../video-quick-overview'

const COPY = {
  zh: {
    title: '沉浸式分析', description: '导入资料，沿着原文证据提问和记笔记。', import: '导入文档或字幕',
    link: '粘贴资料链接', linkHint: '飞书文档需要本人授权及读取权限。', openLink: '在原站打开', importLink: '读取链接', authorize: '授权飞书', forget: '移除平台保存的飞书授权', authorizing: '等待飞书授权…', authorized: '已授权，可读取链接',
    local: '本地保存', cloud: '云端保存', localDisclosure: '本地保存：导入文件的原件、飞书正文快照、证据和笔记留在这台设备；解析请求会经过 APEX，飞书授权令牌由 APEX 加密保管。',
    cloudDisclosure: '云端保存：导入文件的原件或飞书正文快照，以及证据和笔记保存在当前账号下，可跨设备回看。飞书授权令牌由 APEX 加密保管。',
    cloudUnavailable: '云端资料存储尚未配置，请联系平台管理员。',
    empty: '尚无资料。导入文档或 SRT/VTT 字幕开始。', loadingSources: '正在读取资料记录…', failedList: '资料记录读取失败。', retryList: '重试读取', processing: '正在解析原文…', ready: '可提问', failed: '解析失败',
    retry: '重试解析', chooseAgain: '重新选择文件', open: '打开原文件', remove: '删除资料',
    question: '针对当前资料提问', ask: '查找证据', noEvidence: '这份资料中未找到相关原文证据。', excerpts: '匹配的原文片段',
    note: '保存笔记', notePlaceholder: '记录你的发现', notes: '笔记', evidence: '原文证据', source: '资料记录',
    noSourceText: '尚未取得可读取的正文。', select: '选择一份资料查看原文。', opening: '正在打开资料…', deleteNote: '删除笔记',
    error: '操作失败，请重试。', subtitleInvalid: '字幕时间码或格式无效，请检查 SRT/VTT 文件。', pdfOriginal: 'PDF 原件', pdfPreviewUnavailable: 'PDF 预览暂不可用，可打开原件。', permission: '此链接的正文尚未获授权读取，无法生成问答。', page: '第 {n} 页', paragraph: '第 {n} 段', sheet: '{sheet} · {cell}',
    anchorNote: '记到此处', selectedAnchor: '当前引用', citation: '查看出处', unsupportedLink: '暂不支持直接读取此链接，请下载文档后导入。',
    videoCheck: '检查并尝试转写视频', videoCandidate: '已识别为 {platform}。尚未读取媒体或字幕，当前无法提问；可在原站查看。', videoUpload: '已识别为 {platform}。目前需要上传视频或字幕才能分析。', videoUnreadable: '无法确认可读取的视频链接，请核对地址或在原站打开。', subtitleNotice: '以下仅依据导入的字幕原文，不代表已分析视频画面。', timestamp: '{time} 起',
    videoAnalyze: '转写视频声音', videoAnalyzing: '正在获取媒体和转写，可能需要数分钟…', videoNoTiming: '已尝试转写，但当前服务未返回可靠时间码。可上传 SRT/VTT 字幕继续分析。', videoTranscriptNotice: '以下仅依据真实视频声音转写及时间码，尚未分析画面；时间码引用定位到转写片段。', videoProcessingDisclosure: '视频链接由 APEX 媒体服务下载和转写；生成的字幕证据按上方模式保存，服务端媒体缓存遵循现有生命周期。',
    videoUploadLocal: '选择本地视频转写', videoUploading: '正在上传并转写视频，可能需要数分钟…', videoUploadDisclosure: '本地视频将临时上传到 APEX 获取语音时间码；处理后删除视频原件，只按上方模式保存字幕证据。暂不分析画面。', videoFileTooLarge: '视频文件不得超过 128 MB。', videoFileUnsupported: '请选择 MP4、MOV、M4V、WebM、MKV、AVI 或 FLV 视频。', videoEmpty: '视频文件为空。', mediaQuota: '媒体空间配额不足。',
    attachVideo: '选择本地视频播放', videoPlayer: '本地视频', videoPairing: '视频仅在本次查看期间留在这台设备，不会上传或保存。请确认所选视频与字幕对应；时间码来自字幕，不代表已分析画面。', videoUnsupported: '请选择视频文件。', videoPlaybackFailed: '此设备无法播放所选视频格式，请更换文件。', videoTimeOutside: '字幕时间码超出所选视频时长，请确认视频与字幕对应。', frameCapture: '截取当前画面', frameEvidence: '本次查看的画面截图', frameBoundary: '截图来自手动配对的本地视频，仅保存在本次页面内存中；尚未经过模型分析，也不证明视频与字幕对应。', frameFailed: '当前画面无法截取，请先播放或跳到可播放的时间。',
    quickTitle: '视频声音速览', quickCoverage: '已取得 {count} 条带时间码的语音片段，覆盖 {start}–{end}。', quickBoundary: '以下为原文时间轴抽样，可跳回出处；不包含画面或镜头证据。', quickJump: '跳到此片段',
    deepAction: '准备深度拆解', deepDisclosure: '将可用的转写片段和来源链接（如有）放入本机助手草稿；检查后由你点击发送。若需分析画面，请在聊天中附上原视频。', deepAutoFrameDisclosure: '点击后将从手动配对的本地视频抽取最多 3 张画面，连同语音原文加入草稿；只有你点击发送后才交给助手。未抽取的部分仍需原视频。', deepFrameDisclosure: '已截取的画面会写入此设备的聊天附件目录并加入草稿；只有你点击发送后才交给助手。未截取的部分仍需原视频。', deepLocalOnly: '深度拆解需要连接本机助手。'
  },
  'zh-hant': {
    title: '沉浸式分析', description: '匯入資料，沿著原文證據提問和記筆記。', import: '匯入文件或字幕',
    link: '貼上資料連結', linkHint: '飛書文件需要本人授權及讀取權限。', openLink: '在原站開啟', importLink: '讀取連結', authorize: '授權飛書', forget: '移除平台儲存的飛書授權', authorizing: '等待飛書授權…', authorized: '已授權，可讀取連結',
    local: '本機儲存', cloud: '雲端儲存', localDisclosure: '本機儲存：匯入文件原件、飛書正文快照、證據和筆記留在此裝置；解析請求會經過 APEX，飛書授權令牌由 APEX 加密保管。',
    cloudDisclosure: '雲端儲存：匯入文件原件或飛書正文快照，以及證據和筆記保存在目前帳號下，可跨裝置回看。飛書授權令牌由 APEX 加密保管。',
    cloudUnavailable: '雲端資料儲存尚未設定，請聯絡平台管理員。',
    empty: '尚無資料。匯入文件或 SRT/VTT 字幕開始。', loadingSources: '正在讀取資料記錄…', failedList: '資料記錄讀取失敗。', retryList: '重試讀取', processing: '正在解析原文…', ready: '可提問', failed: '解析失敗',
    retry: '重試解析', chooseAgain: '重新選擇文件', open: '開啟原文件', remove: '刪除資料',
    question: '針對目前資料提問', ask: '尋找證據', noEvidence: '這份資料中未找到相關原文證據。', excerpts: '匹配的原文片段',
    note: '儲存筆記', notePlaceholder: '記錄你的發現', notes: '筆記', evidence: '原文證據', source: '資料記錄',
    noSourceText: '尚未取得可讀取的正文。', select: '選擇一份資料查看原文。', opening: '正在開啟資料…', deleteNote: '刪除筆記',
    error: '操作失敗，請重試。', subtitleInvalid: '字幕時間碼或格式無效，請檢查 SRT/VTT 文件。', pdfOriginal: 'PDF 原件', pdfPreviewUnavailable: 'PDF 預覽暫時無法使用，可開啟原件。', permission: '此連結的正文尚未獲授權讀取，無法產生問答。', page: '第 {n} 頁', paragraph: '第 {n} 段', sheet: '{sheet} · {cell}',
    anchorNote: '記到此處', selectedAnchor: '目前引用', citation: '查看出處', unsupportedLink: '目前無法直接讀取此連結，請下載文件後匯入。',
    videoCheck: '檢查並嘗試轉寫影片', videoCandidate: '已識別為 {platform}。尚未讀取影片或字幕，目前無法提問；可在原站查看。', videoUpload: '已識別為 {platform}。目前需上傳影片或字幕才能分析。', videoUnreadable: '無法確認可讀取的影片連結，請檢查網址或在原站開啟。', subtitleNotice: '以下僅依據匯入的字幕原文，不代表已分析影片畫面。', timestamp: '{time} 起',
    videoAnalyze: '轉寫影片聲音', videoAnalyzing: '正在取得媒體與轉寫，可能需要數分鐘…', videoNoTiming: '已嘗試轉寫，但目前服務未回傳可靠時間碼。可匯入 SRT/VTT 字幕繼續分析。', videoTranscriptNotice: '以下僅依據真實影片聲音轉寫與時間碼，尚未分析畫面；時間碼引用定位到轉寫片段。', videoProcessingDisclosure: '影片連結由 APEX 媒體服務下載與轉寫；產生的字幕證據依上方模式儲存，伺服器媒體快取遵循既有生命週期。',
    videoUploadLocal: '選擇本機影片轉寫', videoUploading: '正在上傳並轉寫影片，可能需要數分鐘…', videoUploadDisclosure: '本機影片會暫時上傳至 APEX 取得語音時間碼；處理後刪除影片原檔，僅依上方模式儲存字幕證據。暫不分析畫面。', videoFileTooLarge: '影片檔案不得超過 128 MB。', videoFileUnsupported: '請選擇 MP4、MOV、M4V、WebM、MKV、AVI 或 FLV 影片。', videoEmpty: '影片檔案為空。', mediaQuota: '媒體空間配額不足。',
    attachVideo: '選擇本機影片播放', videoPlayer: '本機影片', videoPairing: '影片僅在本次查看期間留在此裝置，不會上傳或儲存。請確認所選影片與字幕對應；時間碼來自字幕，不代表已分析畫面。', videoUnsupported: '請選擇影片檔案。', videoPlaybackFailed: '此裝置無法播放所選影片格式，請更換檔案。', videoTimeOutside: '字幕時間碼超出所選影片長度，請確認影片與字幕對應。', frameCapture: '擷取目前畫面', frameEvidence: '本次查看的畫面截圖', frameBoundary: '截圖來自手動配對的本機影片，僅保存在本次頁面記憶體；尚未經模型分析，也不證明影片與字幕對應。', frameFailed: '無法擷取目前畫面，請先播放或跳到可播放的時間。',
    quickTitle: '影片聲音速覽', quickCoverage: '已取得 {count} 段有時間碼的語音，涵蓋 {start}–{end}。', quickBoundary: '以下是原文時間軸取樣，可跳回出處；不含畫面或鏡頭證據。', quickJump: '跳至此片段',
    deepAction: '準備深度拆解', deepDisclosure: '可用的逐字稿片段和來源連結（如有）會放入本機助手草稿；檢查後由你按傳送。如需分析畫面，請在聊天中附上原影片。', deepAutoFrameDisclosure: '點擊後會從手動配對的本機影片擷取最多 3 張畫面，連同語音原文放入草稿；只有你按傳送後才交給助手。未擷取部分仍需原影片。', deepFrameDisclosure: '已擷取的畫面會寫入此裝置的聊天附件目錄並加入草稿；只有你按傳送後才交給助手。未擷取的部分仍需原影片。', deepLocalOnly: '深度拆解需要連接本機助手。'
  },
  en: {
    title: 'Immersive analysis', description: 'Import a document, ask against its original text, and keep notes.', import: 'Import document or captions',
    link: 'Paste a source link', linkHint: 'Feishu documents require your authorization and read access.', openLink: 'Open original site', importLink: 'Read link', authorize: 'Authorize Feishu', forget: 'Remove saved Feishu access', authorizing: 'Waiting for Feishu authorization…', authorized: 'Authorized. You can read the link.',
    local: 'Saved locally', cloud: 'Saved in cloud', localDisclosure: 'Local save: imported files, Feishu text snapshots, evidence, and notes stay on this device. Parsing passes through APEX; Feishu authorization tokens are encrypted on APEX.',
    cloudDisclosure: 'Cloud save: imported files or Feishu text snapshots, evidence, and notes are stored under your account across devices. Feishu authorization tokens are encrypted on APEX.',
    cloudUnavailable: 'Cloud document storage is not configured. Contact the platform administrator.',
    empty: 'No sources yet. Import a document or SRT/VTT captions.', loadingSources: 'Loading source history…', failedList: 'Could not load source history.', retryList: 'Retry loading', processing: 'Reading original text…', ready: 'Ready for questions', failed: 'Parsing failed',
    retry: 'Retry parsing', chooseAgain: 'Choose file again', open: 'Open original file', remove: 'Delete source',
    question: 'Ask about this source', ask: 'Find evidence', noEvidence: 'No matching original text was found in this source.', excerpts: 'Matching original passages',
    note: 'Save note', notePlaceholder: 'Record your finding', notes: 'Notes', evidence: 'Original evidence', source: 'Source history',
    noSourceText: 'No readable body has been obtained.', select: 'Select a source to inspect its text.', opening: 'Opening source…', deleteNote: 'Delete note',
    error: 'The action failed. Try again.', subtitleInvalid: 'Invalid subtitle timing or format. Check the SRT/VTT file.', pdfOriginal: 'Original PDF', pdfPreviewUnavailable: 'PDF preview is unavailable. You can open the original.', permission: 'The body of this link has not been authorized for reading. Questions are unavailable.', page: 'Page {n}', paragraph: 'Paragraph {n}', sheet: '{sheet} · {cell}',
    anchorNote: 'Note this passage', selectedAnchor: 'Current citation', citation: 'Jump to source', unsupportedLink: 'Direct reading is unavailable for this link. Download the document and import it.',
    videoCheck: 'Check and transcribe video', videoCandidate: '{platform} link recognized. Media and captions have not been read, so questions are unavailable; you can open the original site.', videoUpload: '{platform} link recognized. Upload the video or captions to analyze it.', videoUnreadable: 'This video link cannot be verified. Check the address or open the original site.', subtitleNotice: 'These excerpts come only from the imported captions; video frames have not been analyzed.', timestamp: 'From {time}',
    videoAnalyze: 'Transcribe video audio', videoAnalyzing: 'Fetching media and transcribing; this may take several minutes…', videoNoTiming: 'Transcription was attempted, but the provider returned no reliable timecodes. Import SRT/VTT captions to continue.', videoTranscriptNotice: 'These excerpts use real video-audio transcription and timing only. Frames were not analyzed; timecode citations locate transcript passages.', videoProcessingDisclosure: 'APEX downloads and transcribes linked media. Generated caption evidence follows the save mode above; server media cache follows its existing lifecycle.',
    videoUploadLocal: 'Choose local video to transcribe', videoUploading: 'Uploading and transcribing the video; this may take several minutes…', videoUploadDisclosure: 'The video is uploaded temporarily to APEX for timed audio transcription, then deleted. Only caption evidence follows the save mode above. Frames are not analyzed.', videoFileTooLarge: 'The video must be at most 128 MB.', videoFileUnsupported: 'Choose an MP4, MOV, M4V, WebM, MKV, AVI, or FLV video.', videoEmpty: 'The video file is empty.', mediaQuota: 'Media storage quota is insufficient.',
    attachVideo: 'Choose local video to play', videoPlayer: 'Local video', videoPairing: 'The video stays on this device for this viewing session; it is not uploaded or saved. Confirm it matches the captions. Timecodes come from captions and do not imply frame analysis.', videoUnsupported: 'Choose a video file.', videoPlaybackFailed: 'This device cannot play the selected video format. Choose another file.', videoTimeOutside: 'The caption timecode exceeds this video’s duration. Confirm that the video matches the captions.', frameCapture: 'Capture current frame', frameEvidence: 'Frames from this viewing session', frameBoundary: 'Frames come from the local video you paired and stay only in this page’s memory. They have not been analyzed by a model and do not prove the video matches the captions.', frameFailed: 'Cannot capture this frame. Play or seek to a playable time first.',
    quickTitle: 'Video audio at a glance', quickCoverage: '{count} timed speech passages found, spanning {start}–{end}.', quickBoundary: 'These are samples from the original transcript timeline. They contain no frame or shot evidence.', quickJump: 'Jump to passage',
    deepAction: 'Prepare deep breakdown', deepDisclosure: 'Available transcript excerpts and source link, if any, go into a local Agent draft for your review and submission. Attach the original video in chat for frame analysis.', deepAutoFrameDisclosure: 'On click, up to 3 frames are sampled from your manually paired local video and added with the transcript to a draft. The Agent receives them only after you send. Attach the original video for unsampled portions.', deepFrameDisclosure: 'Captured frames are written to this device’s chat attachment folder and added to the draft. The Agent receives them only after you send. Attach the original video for uncaptured portions.', deepLocalOnly: 'Deep breakdown needs a local Agent connection.'
  },
  ja: {
    title: '資料分析', description: '原文の根拠を確認しながら質問し、メモを残せます。', import: '文書・字幕を読み込む',
    link: '資料リンクを貼り付け', linkHint: 'Feishu 文書には本人の認証と閲覧権限が必要です。', openLink: '元サイトを開く', importLink: 'リンクを読む', authorize: 'Feishu を認証', forget: '保存済みの Feishu 認証を削除', authorizing: 'Feishu の認証を待機中…', authorized: '認証済み。リンクを読めます。',
    local: 'ローカル保存', cloud: 'クラウド保存', localDisclosure: 'ローカル保存：読み込んだファイル、Feishu の本文、根拠、メモはこの端末に保存されます。解析は APEX を経由し、Feishu 認証トークンは APEX で暗号化して保管します。',
    cloudDisclosure: 'クラウド保存：ファイルまたは Feishu の本文、根拠、メモをアカウントに保存します。Feishu 認証トークンは APEX で暗号化して保管します。',
    cloudUnavailable: 'クラウド保存が設定されていません。管理者に連絡してください。',
    empty: '資料はまだありません。文書または SRT/VTT 字幕を読み込んでください。', loadingSources: '資料履歴を読み込み中…', failedList: '資料履歴を読み込めませんでした。', retryList: '再読み込み', processing: '原文を解析中…', ready: '質問できます', failed: '解析に失敗',
    retry: '解析を再試行', chooseAgain: 'ファイルを選び直す', open: '原本を開く', remove: '資料を削除',
    question: 'この資料について質問', ask: '根拠を探す', noEvidence: '一致する原文は見つかりませんでした。', excerpts: '一致した原文',
    note: 'メモを保存', notePlaceholder: '発見を記録', notes: 'メモ', evidence: '原文の根拠', source: '資料履歴',
    noSourceText: '読める本文がありません。', select: '資料を選択してください。', opening: '資料を開いています…', deleteNote: 'メモを削除',
    error: '失敗しました。再試行してください。', subtitleInvalid: '字幕の時間または形式が無効です。SRT/VTT ファイルを確認してください。', pdfOriginal: '元の PDF', pdfPreviewUnavailable: 'PDF をプレビューできません。元のファイルを開けます。', permission: 'このリンクの本文を読む権限がないため、質問できません。', page: '{n} ページ', paragraph: '{n} 段落', sheet: '{sheet} · {cell}',
    anchorNote: 'ここにメモ', selectedAnchor: '選択中の引用', citation: '出典へ移動', unsupportedLink: 'このリンクは直接読み込めません。文書をダウンロードしてから読み込んでください。',
    videoCheck: '動画を確認して文字起こし', videoCandidate: '{platform} のリンクです。動画や字幕は未取得のため質問はできません。元サイトで確認できます。', videoUpload: '{platform} のリンクです。分析するには動画または字幕をアップロードしてください。', videoUnreadable: '動画リンクを確認できません。URL を確認するか元サイトを開いてください。', subtitleNotice: '以下は読み込んだ字幕のみを根拠とし、映像は解析していません。', timestamp: '{time} から',
    videoAnalyze: '動画音声を文字起こし', videoAnalyzing: 'メディアを取得して文字起こし中です。数分かかる場合があります…', videoNoTiming: '文字起こしを試みましたが、信頼できる時間情報が返りませんでした。SRT/VTT 字幕を取り込んでください。', videoTranscriptNotice: '以下は実際の動画音声の文字起こしと時間情報のみを根拠とします。映像は解析していません。', videoProcessingDisclosure: 'リンク先のメディアは APEX が取得・文字起こしします。生成された字幕の保存先は上の設定に従い、サーバーのメディアキャッシュには既存の保存期間が適用されます。',
    videoUploadLocal: 'ローカル動画を文字起こし', videoUploading: '動画をアップロードして文字起こし中です。数分かかる場合があります…', videoUploadDisclosure: '音声の時間情報を得るため動画を一時的に APEX に送信し、処理後に元動画を削除します。字幕の根拠のみ上記の保存設定に従います。映像は解析しません。', videoFileTooLarge: '動画は 128 MB 以下にしてください。', videoFileUnsupported: 'MP4、MOV、M4V、WebM、MKV、AVI または FLV を選択してください。', videoEmpty: '動画ファイルが空です。', mediaQuota: 'メディア容量が不足しています。',
    attachVideo: 'ローカル動画を選んで再生', videoPlayer: 'ローカル動画', videoPairing: '動画はこの閲覧中、この端末だけに残り、アップロード・保存されません。字幕に対応する動画か確認してください。時間情報は字幕に由来し、映像解析を意味しません。', videoUnsupported: '動画ファイルを選択してください。', videoPlaybackFailed: 'この端末では選択した動画形式を再生できません。別のファイルを選んでください。', videoTimeOutside: '字幕の時間情報が動画の長さを超えています。動画と字幕の対応を確認してください。', frameCapture: '現在のフレームを取得', frameEvidence: '今回の閲覧で取得したフレーム', frameBoundary: 'フレームは手動で対応付けたローカル動画から取得し、このページのメモリにのみ保持します。モデルによる分析や字幕との一致確認は行っていません。', frameFailed: 'このフレームを取得できません。再生するか、再生可能な時刻に移動してください。',
    quickTitle: '動画音声の概要', quickCoverage: '時間付きの発話 {count} 件を取得しました。範囲: {start}–{end}。', quickBoundary: '以下は原文の時間軸からの抜粋です。映像やショットの根拠は含みません。', quickJump: 'この箇所へ移動',
    deepAction: '詳細な分解を準備', deepDisclosure: '利用可能な文字起こしの抜粋と元のリンク（ある場合）をローカル Agent の下書きに入れます。確認してから送信してください。映像を分析する場合は元動画をチャットに添付してください。', deepAutoFrameDisclosure: '押すと手動で対応付けたローカル動画から最大 3 枚のフレームを取得し、文字起こしと共に下書きに追加します。Agent に渡すのは送信後のみです。未取得部分には元動画が必要です。', deepFrameDisclosure: '撮影したフレームはこの端末のチャット添付フォルダに保存され、下書きに追加されます。送信するまで Agent には渡されません。未撮影部分には元動画が必要です。', deepLocalOnly: '詳細な分解にはローカル Agent 接続が必要です。'
  },
  ar: {
    title: 'تحليل المستندات', description: 'اطرح أسئلة مستندة إلى النص الأصلي واحفظ ملاحظاتك.', import: 'استيراد مستند أو ترجمة',
    link: 'ألصق رابط المصدر', linkHint: 'تتطلب مستندات Feishu موافقتك وصلاحية القراءة.', openLink: 'فتح الموقع الأصلي', importLink: 'قراءة الرابط', authorize: 'تفويض Feishu', forget: 'إزالة تفويض Feishu المحفوظ', authorizing: 'بانتظار تفويض Feishu…', authorized: 'تم التفويض؛ يمكنك قراءة الرابط.',
    local: 'حفظ محلي', cloud: 'حفظ سحابي', localDisclosure: 'الحفظ المحلي: تبقى الملفات المستوردة ونسخة نص Feishu والأدلة والملاحظات على هذا الجهاز. تمر القراءة عبر APEX، وتُحفظ رموز تفويض Feishu مشفرة لدى APEX.',
    cloudDisclosure: 'الحفظ السحابي: تُخزن الملفات أو نسخة نص Feishu والأدلة والملاحظات ضمن حسابك عبر الأجهزة. تُحفظ رموز تفويض Feishu مشفرة لدى APEX.',
    cloudUnavailable: 'لم يتم إعداد التخزين السحابي. تواصل مع مسؤول المنصة.',
    empty: 'لا توجد مصادر بعد. استورد مستندًا أو ترجمة SRT/VTT.', loadingSources: 'جارٍ تحميل سجل المصادر…', failedList: 'تعذر تحميل سجل المصادر.', retryList: 'إعادة التحميل', processing: 'جارٍ قراءة النص الأصلي…', ready: 'جاهز للأسئلة', failed: 'فشل التحليل',
    retry: 'إعادة التحليل', chooseAgain: 'اختر ملفًا مجددًا', open: 'فتح الملف الأصلي', remove: 'حذف المصدر',
    question: 'اسأل عن هذا المصدر', ask: 'البحث عن أدلة', noEvidence: 'لم يُعثر على نص أصلي مطابق في هذا المصدر.', excerpts: 'مقاطع من النص الأصلي',
    note: 'حفظ ملاحظة', notePlaceholder: 'سجل ما وجدته', notes: 'ملاحظات', evidence: 'الأدلة الأصلية', source: 'سجل المصادر',
    noSourceText: 'لم يُحصل على نص قابل للقراءة.', select: 'اختر مصدرًا لقراءة النص.', opening: 'جارٍ فتح المصدر…', deleteNote: 'حذف الملاحظة',
    error: 'فشلت العملية. حاول مجددًا.', subtitleInvalid: 'توقيت الترجمة أو تنسيقها غير صالح. تحقق من ملف SRT/VTT.', pdfOriginal: 'ملف PDF الأصلي', pdfPreviewUnavailable: 'معاينة PDF غير متاحة. يمكنك فتح الملف الأصلي.', permission: 'لم يُمنح إذن قراءة محتوى هذا الرابط، فلا يمكن طرح الأسئلة.', page: 'صفحة {n}', paragraph: 'فقرة {n}', sheet: '{sheet} · {cell}',
    anchorNote: 'ملاحظة لهذا المقطع', selectedAnchor: 'المرجع الحالي', citation: 'انتقل إلى المصدر', unsupportedLink: 'لا يمكن قراءة هذا الرابط مباشرةً. نزّل المستند ثم استورده.',
    videoCheck: 'تحقق من الفيديو وحاول تفريغ صوته', videoCandidate: 'تم التعرف على رابط {platform}. لم تُقرأ الوسائط أو الترجمة بعد، فلا يمكن طرح الأسئلة؛ يمكنك فتح الموقع الأصلي.', videoUpload: 'تم التعرف على رابط {platform}. ارفع الفيديو أو الترجمة لتحليله.', videoUnreadable: 'تعذر التحقق من رابط الفيديو. تحقق من العنوان أو افتح الموقع الأصلي.', subtitleNotice: 'تستند المقاطع التالية إلى الترجمة المستوردة فقط؛ لم تُحلل إطارات الفيديو.', timestamp: 'من {time}',
    videoAnalyze: 'تفريغ صوت الفيديو', videoAnalyzing: 'يجري جلب الوسائط وتفريغ الصوت؛ قد يستغرق ذلك عدة دقائق…', videoNoTiming: 'جرت محاولة التفريغ، لكن الخدمة لم تُرجع توقيتًا موثوقًا. استورد ترجمة SRT/VTT للمتابعة.', videoTranscriptNotice: 'تعتمد هذه المقاطع على تفريغ صوت الفيديو الحقيقي وتوقيته فقط. لم تُحلل الإطارات.', videoProcessingDisclosure: 'تنزّل APEX الوسائط المرتبطة وتفرّغ صوتها. تُحفظ أدلة الترجمة وفق الوضع أعلاه، وتخضع ذاكرة الوسائط المؤقتة لدورة حياتها الحالية.',
    videoUploadLocal: 'اختر فيديو محليًا لتفريغ صوته', videoUploading: 'يجري رفع الفيديو وتفريغ صوته؛ قد يستغرق ذلك عدة دقائق…', videoUploadDisclosure: 'يُرفع الفيديو مؤقتًا إلى APEX لاستخراج نص صوتي بتوقيت، ثم يُحذف الأصل بعد المعالجة. تُحفظ أدلة الترجمة فقط وفق وضع الحفظ أعلاه. لا تُحلّل الإطارات.', videoFileTooLarge: 'يجب ألا يتجاوز الفيديو 128 ميغابايت.', videoFileUnsupported: 'اختر فيديو MP4 أو MOV أو M4V أو WebM أو MKV أو AVI أو FLV.', videoEmpty: 'ملف الفيديو فارغ.', mediaQuota: 'مساحة الوسائط المتاحة غير كافية.',
    attachVideo: 'اختر فيديو محليًا لتشغيله', videoPlayer: 'فيديو محلي', videoPairing: 'يبقى الفيديو على هذا الجهاز أثناء هذه المشاهدة فقط، ولا يُرفع أو يُحفظ. تأكد من مطابقته للترجمة؛ التوقيت مأخوذ من الترجمة ولا يعني تحليل الإطارات.', videoUnsupported: 'اختر ملف فيديو.', videoPlaybackFailed: 'لا يستطيع هذا الجهاز تشغيل صيغة الفيديو المختارة. اختر ملفًا آخر.', videoTimeOutside: 'يتجاوز توقيت الترجمة مدة الفيديو المختار. تأكد من تطابق الفيديو والترجمة.', frameCapture: 'التقاط الإطار الحالي', frameEvidence: 'إطارات من جلسة المشاهدة هذه', frameBoundary: 'تأتي الإطارات من الفيديو المحلي الذي ربطته يدويًا وتبقى في ذاكرة هذه الصفحة فقط. لم يحللها نموذج، ولا تثبت تطابق الفيديو مع الترجمة.', frameFailed: 'تعذر التقاط هذا الإطار. شغّل الفيديو أو انتقل إلى وقت قابل للتشغيل.',
    quickTitle: 'نظرة على صوت الفيديو', quickCoverage: 'تم العثور على {count} مقطعًا صوتيًا بتوقيت من {start} إلى {end}.', quickBoundary: 'هذه عينات من النص الأصلي المرتبط بالوقت. لا تتضمن أدلة عن الإطارات أو اللقطات.', quickJump: 'الانتقال إلى المقطع',
    deepAction: 'تحضير التحليل المعمق', deepDisclosure: 'ستُدرج مقتطفات النص المتاحة ورابط المصدر، إن وجد، في مسودة للوكيل المحلي لمراجعتها وإرسالها بنفسك. أرفق الفيديو الأصلي في المحادثة لتحليل الإطارات.', deepAutoFrameDisclosure: 'عند النقر، تُلتقط حتى 3 إطارات من الفيديو المحلي الذي ربطته يدويًا وتُضاف مع النص إلى مسودة. لن يتلقاها الوكيل إلا بعد الإرسال. يلزم الفيديو الأصلي للأجزاء التي لم تُلتقط.', deepFrameDisclosure: 'تُحفظ الإطارات الملتقطة في مجلد مرفقات المحادثة على هذا الجهاز وتُضاف للمسودة. لن يتلقاها الوكيل حتى تضغط إرسال. يلزم الفيديو الأصلي للأجزاء غير الملتقطة.', deepLocalOnly: 'يتطلب التحليل المعمق الاتصال بوكيل محلي.'
  }
} as const

function timestamp(seconds: number): string {
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60

  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${minutes}:${String(rest).padStart(2, '0')}`
}

function frameTimestamp(seconds: number): string {
  const tenths = Math.floor(seconds * 10 + 1e-6)

  return `${timestamp(Math.floor(tenths / 10))}.${tenths % 10}`
}

function locationLabel(location: Record<string, number | string>, copy: { page: string; paragraph: string; sheet: string; timestamp: string }): string {
  if (typeof location.start_seconds === 'number') {return copy.timestamp.replace('{time}', timestamp(location.start_seconds))}

  if (location.page) {return copy.page.replace('{n}', String(location.page))}

  if (location.sheet) {return copy.sheet.replace('{sheet}', String(location.sheet)).replace('{cell}', String(location.cell))}

  return copy.paragraph.replace('{n}', String(location.paragraph || 1))
}

function bridge(): AnalysisDocumentsBridge | null {
  return window.hermesDesktop?.analysisDocuments ?? null
}

function isHttpsUrl(value: string): boolean {
  try {return new URL(value).protocol === 'https:'} catch {return false}
}

function isFeishuUrl(value: string): boolean {
  if (!isHttpsUrl(value)) {return false}

  const host = new URL(value).hostname.toLowerCase()

  return host === 'feishu.cn' || host.endsWith('.feishu.cn') || host === 'larksuite.com' || host.endsWith('.larksuite.com')
}

function humanError(code: string, copy: { cloudUnavailable: string; empty: string; error: string; failed: string; noSourceText: string; permission: string; subtitleInvalid: string; videoNoTiming: string; videoFileTooLarge: string; videoFileUnsupported: string; videoEmpty: string; mediaQuota: string }): string {
  if (['no_readable_text', 'empty_file'].includes(code)) {return copy.noSourceText}

  if (['analysis_cloud_storage_unavailable', 'cloud_upload_failed', 'download_unavailable'].includes(code)) {return copy.cloudUnavailable}

  if (['permission_denied', 'analysis_cloud_storage_disabled', 'feishu_permission_denied', 'feishu_authorization_required', 'feishu_identity_mismatch', 'feishu_binding_required', 'feishu_scope_unavailable'].includes(code)) {return copy.permission}

  if (code === 'unsupported_format') {return copy.empty}

  if (['invalid_subtitle', 'invalid_subtitle_timing'].includes(code)) {return copy.subtitleInvalid}

  if (['timed_evidence_unavailable', 'timed_evidence_invalid'].includes(code)) {return copy.videoNoTiming}

  if (code === 'video_file_too_large') {return copy.videoFileTooLarge}

  if (code === 'video_file_unsupported') {return copy.videoFileUnsupported}

  if (code === 'empty_video_file') {return copy.videoEmpty}

  if (code === 'media_quota_exceeded') {return copy.mediaQuota}

  if (['parse_failed', 'parse_interrupted'].includes(code)) {return copy.failed}

  return copy.error
}

export function AnalysisView({ onDeepBreakdown }: {
  onDeepBreakdown?: (document: AnalysisDocument, locale: VideoBreakdownLocale, frames: ReadonlyArray<{ seconds: number; dataUrl: string }>) => Promise<void> | void
}) {
  const { locale } = useI18n()
  const c = COPY[locale]
  const connection = useStore($connection)
  const [policy, setPolicy] = useState<{ mode: 'cloud' | 'local'; cloud_storage_configured: boolean } | null>(null)
  const [items, setItems] = useState<AnalysisDocument[]>([])
  const [listStatus, setListStatus] = useState<'error' | 'loading' | 'ready'>('loading')
  const listRequestRef = useRef(0)
  const [selected, setSelected] = useState<AnalysisDocument | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const selectedDocumentIdRef = useRef<string | null>(null)
  const openedDocumentIdRef = useRef<string | null>(null)
  const openRequestRef = useRef(0)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState('')
  const [link, setLink] = useState('')
  const [videoResolution, setVideoResolution] = useState<AnalysisVideoResolution | null>(null)
  const [transcribingVideo, setTranscribingVideo] = useState(false)
  const [uploadingVideo, setUploadingVideo] = useState(false)
  const [authFlow, setAuthFlow] = useState<{ id: string; interval: number } | null>(null)
  const [feishuAuthorized, setFeishuAuthorized] = useState(false)
  const [question, setQuestion] = useState('')
  const [note, setNote] = useState('')
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const [pdfPreview, setPdfPreview] = useState<{ id: string; url: string } | null>(null)
  const [pdfPage, setPdfPage] = useState(1)
  const [pdfError, setPdfError] = useState(false)
  const [localVideo, setLocalVideo] = useState<{ documentId: string; name: string; url: string } | null>(null)
  const [frames, setFrames] = useState<Array<{ id: number; videoUrl: string; seconds: number; dataUrl: string }>>([])
  const frameIdRef = useRef(0)
  const [videoError, setVideoError] = useState('')
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const selectedId = selected?.id
  const selectedKind = selected?.kind
  const selectedStatus = selected?.status
  const activeVideo = localVideo?.documentId === selectedId ? localVideo : null
  const quickOverview = videoQuickOverview(selected)

  useEffect(() => () => {
    if (localVideo) {URL.revokeObjectURL(localVideo.url)}
  }, [localVideo])

  const refreshList = useCallback(async () => {
    const request = ++listRequestRef.current
    setListStatus('loading')

    try {
      const result = await bridge()?.list()

      if (request !== listRequestRef.current) {return}

      if (result?.ok && Array.isArray(result.items)) {
        setItems(result.items)
        setListStatus('ready')

        if (result.cloudUnavailable) {setError(c.error)}
      } else {setListStatus('error')}
    } catch {
      if (request === listRequestRef.current) {setListStatus('error')}
    }
  }, [c.error])

  const openDocument = useCallback(async (id: string, select = false) => {
    if (select) {
      const switchingSource = openedDocumentIdRef.current !== id
      selectedDocumentIdRef.current = id

      if (switchingSource) {
        openedDocumentIdRef.current = null
        setSelected(null)
        setOpeningId(id)
        setLocalVideo(null)
        setFrames([])
        setVideoError('')
        setQuestion('')
        setNote('')
        setAnchorId(null)
        setError('')
      }
    } else if (selectedDocumentIdRef.current !== id) {
      return
    }

    const request = ++openRequestRef.current

    try {
      const result = await bridge()?.get(id)

      if (request !== openRequestRef.current || selectedDocumentIdRef.current !== id) {return}

      if (result?.ok && result.item?.id === id) {
        openedDocumentIdRef.current = id
        setSelected(result.item)
        setVideoError('')
      } else {
        setError(result?.code ?? c.error)
      }
    } catch {
      if (request === openRequestRef.current && selectedDocumentIdRef.current === id) {setError(c.error)}
    } finally {
      if (request === openRequestRef.current && selectedDocumentIdRef.current === id) {setOpeningId(null)}
    }
  }, [c.error])

  useEffect(() => {
    void bridge()?.policy().then(result => {
      if (result.ok && result.policy) {setPolicy(result.policy)}
      else {setError(result.code ?? c.error)}
    })
    void refreshList()
  }, [c.error, refreshList])

  useEffect(() => {
    if (selected?.status !== 'processing') {return}

    const timer = window.setInterval(() => {
      void openDocument(selected.id)
      void refreshList()
    }, 2000)

    return () => window.clearInterval(timer)
  }, [selected?.id, selected?.status, openDocument, refreshList])

  useEffect(() => {
    setPdfPreview(null)
    setPdfPage(1)
    setPdfError(false)

    if (!selectedId || selectedKind !== 'pdf' || selectedStatus !== 'ready') {return}

    let active = true
    let objectUrl = ''

    void bridge()?.previewPdf?.(selectedId).then(result => {
      if (!active) {return}

      try {
        const prefix = 'data:application/pdf;base64,'

        if (!result.ok || !result.data_url?.startsWith(prefix) || typeof URL.createObjectURL !== 'function') {throw new Error('preview_unavailable')}

        const binary = atob(result.data_url.slice(prefix.length))

        if (!binary.startsWith('%PDF-')) {throw new Error('preview_unavailable')}

        objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: 'application/pdf' }))
        setPdfPreview({ id: selectedId, url: objectUrl })
      } catch {setPdfError(true)}
    }).catch(() => {if (active) {setPdfError(true)}})

    return () => {
      active = false

      if (objectUrl) {URL.revokeObjectURL(objectUrl)}
    }
  }, [selectedId, selectedKind, selectedStatus])

  useEffect(() => {
    if (!authFlow) {return}

    const timer = window.setTimeout(() => {
      void bridge()?.pollFeishu(authFlow.id).then(result => {
        if (!result?.ok) {setAuthFlow(null); setError(result?.code ?? c.error);

 return }

        if (result.status === 'authorized') {setAuthFlow(null); setFeishuAuthorized(true);

 return }

        if (result.status !== 'pending') {setAuthFlow(null); setError('feishu_authorization_required');

 return }

        setAuthFlow({ ...authFlow, interval: result.interval ?? authFlow.interval })
      })
    }, authFlow.interval * 1000)

    return () => window.clearTimeout(timer)
  }, [authFlow, c.error])

  const perform = async (action: () => Promise<void>) => {
    if (busyRef.current) {return}

    busyRef.current = true
    setBusy(true)
    setError('')

    try { await action() } catch { setError(c.error) } finally { busyRef.current = false; setBusy(false) }
  }

  const acceptTimedTranscript = async (result: { ok: boolean; code?: string; item?: AnalysisDocument } | undefined) => {
    if (!result?.ok || !result.item) {
      if (result?.code !== 'cancelled') {setError(result?.code ?? c.error)}

      return
    }

    const timedEvidence = result.item.kind === 'subtitle' && result.item.status === 'ready' && result.item.anchors?.some(anchor =>
      typeof anchor.location.start_seconds === 'number' && Number.isFinite(anchor.location.start_seconds)
      && anchor.location.start_seconds >= 0
      && typeof anchor.location.end_seconds === 'number' && Number.isFinite(anchor.location.end_seconds)
      && anchor.location.end_seconds > anchor.location.start_seconds && !!anchor.text.trim())

    if (!timedEvidence) {setError('timed_evidence_unavailable'); return}

    setLink('')
    setVideoResolution(null)
    await refreshList()
    await openDocument(result.item.id, true)
  }

  const transcribeResolvedVideo = async (sourceUrl: string) => {
    setTranscribingVideo(true)

    try {await acceptTimedTranscript(await bridge()?.transcribeVideoLink(sourceUrl))}
    finally {setTranscribingVideo(false)}
  }

  const captureCurrentFrame = () => {
    const player = videoRef.current

    if (!activeVideo || !player) {
      setVideoError(c.frameFailed)

      return
    }

    try {
      const frame = { id: ++frameIdRef.current, videoUrl: activeVideo.url, ...captureVideoFrame(player) }
      setFrames(previous => [...previous.filter(item => item.videoUrl === activeVideo.url).slice(-2), frame])
      setVideoError('')
    } catch {
      setVideoError(c.frameFailed)
    }
  }

  const jump = (id: string) => {
    const sourceLocation = selected?.anchors?.find(anchor => anchor.id === id)?.location

    if (selected?.kind === 'pdf' && typeof sourceLocation?.page === 'number') {setPdfPage(sourceLocation.page)}

    if (selected?.kind === 'subtitle' && activeVideo && videoRef.current && typeof sourceLocation?.start_seconds === 'number') {
      const seconds = sourceLocation.start_seconds
      const player = videoRef.current

      if (Number.isFinite(seconds) && seconds >= 0) {
        if (player.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(player.duration) && seconds > player.duration) {setVideoError(c.videoTimeOutside)}
        else {player.currentTime = seconds; setVideoError('')}
      }
    }

    document.getElementById(`analysis-anchor-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const answer = (item: AnalysisQuestion) => (
    <article className="rounded-xl border border-(--ui-border) p-4" key={item.id}>
      <h4 className="font-medium">{item.question}</h4>
      <p className="mt-2 whitespace-pre-wrap text-sm text-(--ui-text-secondary)">{item.answer_type === 'no_evidence' ? c.noEvidence : item.answer}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {item.citations.map(citation => {
          const sourceAnchor = selected?.anchors?.find(anchor => anchor.id === citation.anchor_id)

          return sourceAnchor && <button className="rounded-lg border px-2 py-1 text-xs" key={citation.anchor_id} onClick={() => jump(citation.anchor_id)} type="button">
            {c.citation} · {locationLabel(sourceAnchor.location, c)}
          </button>
        })}
      </div>
    </article>
  )

  return <section className="apex-business-surface apex-business-page apex-primary-page overflow-y-auto">
    <div className="apex-primary-page-column space-y-5 pb-10">
      <BusinessPageHeader description={c.description} eyebrow={c.source} icon="book" title={c.title} />
      <div className="rounded-xl border border-(--ui-border) p-4 text-sm">
        <div className="font-medium">{policy ? policy.mode === 'cloud' ? c.cloud : c.local : c.error}</div>
        {policy && <p className="mt-1 text-(--ui-text-secondary)">{policy.mode === 'cloud' ? c.cloudDisclosure : c.localDisclosure}</p>}
        {policy?.mode === 'cloud' && !policy.cloud_storage_configured && <p className="mt-2 text-destructive">{c.cloudUnavailable}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" disabled={busy || !policy || (policy.mode === 'cloud' && !policy.cloud_storage_configured)} onClick={() => void perform(async () => {
          const result = await bridge()?.importFile()

          if (result?.code === 'cancelled') {return}

          if (!result?.ok || !result.item) { setError(result?.code ?? c.error);

 return }

          await refreshList()
          await openDocument(result.item.id, true)
        })} type="button">{c.import}</button>
        <button className="rounded-lg border px-3 py-2 disabled:opacity-50" disabled={busy || !policy || (policy.mode === 'cloud' && !policy.cloud_storage_configured)} onClick={() => void perform(async () => {
          setUploadingVideo(true)

          try {await acceptTimedTranscript(await bridge()?.uploadVideo())}
          finally {setUploadingVideo(false)}
        })} type="button">{uploadingVideo ? c.videoUploading : c.videoUploadLocal}</button>
        <input aria-label={c.link} className="min-w-52 flex-1 rounded-lg border bg-transparent px-3 py-2" disabled={busy} onChange={event => { setLink(event.target.value); setVideoResolution(null) }} placeholder={c.link} type="url" value={link} />
        {isFeishuUrl(link) && <button className="rounded-lg border px-3 py-2 disabled:opacity-50" disabled={busy} onClick={() => void perform(async () => {
          const result = await bridge()?.importLink(link.trim())

          if (!result?.ok || !result.item) {setError(result?.code ?? c.error);

 return }

          setLink(''); await refreshList(); await openDocument(result.item.id, true)
        })} type="button">{c.importLink}</button>}
        {isFeishuUrl(link) && <button className="rounded-lg border px-3 py-2 disabled:opacity-50" disabled={busy || !!authFlow} onClick={() => void perform(async () => {
          const result = await bridge()?.authorizeFeishu()

          if (!result?.ok || !result.flow_id) {setError(result?.code ?? c.error);

 return }

          setAuthFlow({ id: result.flow_id, interval: result.interval ?? 5 }); setFeishuAuthorized(false)
        })} type="button">{c.authorize}</button>}
        {isFeishuUrl(link) && <button className="rounded-lg border px-3 py-2 disabled:opacity-50" disabled={busy} onClick={() => void perform(async () => {
          const result = await bridge()?.forgetFeishu()

          if (!result?.ok) {setError(result?.code ?? c.error);

 return }

          setAuthFlow(null); setFeishuAuthorized(false)
        })} type="button">{c.forget}</button>}
        {isHttpsUrl(link) && !isFeishuUrl(link) && <button className="rounded-lg border px-3 py-2 disabled:opacity-50" disabled={busy} onClick={() => void perform(async () => {
          const result = await bridge()?.resolveVideoLink(link.trim())

          if (!result?.ok || !result.resolution) {setError(result?.code ?? c.error);

 return }

          setVideoResolution(result.resolution)
          if (!result.resolution.source_url || !['download_candidate', 'audio_candidate'].includes(result.resolution.capability ?? '')) {return}

          const effectivePolicy = policy ?? (await bridge()?.policy())?.policy

          if (effectivePolicy && (effectivePolicy.mode === 'local' || effectivePolicy.cloud_storage_configured)) {
            await transcribeResolvedVideo(result.resolution.source_url)
          }
        })} type="button">{c.videoCheck}</button>}
        {videoResolution?.source_url && ['download_candidate', 'audio_candidate'].includes(videoResolution.capability ?? '') && <button className="rounded-lg border px-3 py-2 disabled:opacity-50" disabled={busy || !policy || (policy.mode === 'cloud' && !policy.cloud_storage_configured)} onClick={() => void perform(async () => {
          await transcribeResolvedVideo(videoResolution.source_url!)
        })} type="button">{transcribingVideo ? c.videoAnalyzing : c.videoAnalyze}</button>}
        {isHttpsUrl(link) && <button className="rounded-lg border px-3 py-2" onClick={() => void window.hermesDesktop.openExternal(videoResolution?.source_url ?? link)} type="button">{c.openLink}</button>}
      </div>
      <p className="text-xs text-(--ui-text-tertiary)">{c.videoUploadDisclosure}</p>
      {link && <p className="text-sm text-(--ui-text-secondary)">{isFeishuUrl(link) ? authFlow ? c.authorizing : feishuAuthorized ? c.authorized : c.linkHint : videoResolution ? transcribingVideo ? c.videoAnalyzing : videoResolution.status === 'unreadable' ? c.videoUnreadable : (videoResolution.status === 'upload_required' ? c.videoUpload : c.videoCandidate).replace('{platform}', videoResolution.platform ?? '') : c.unsupportedLink}</p>}
      {videoResolution?.source_url && ['download_candidate', 'audio_candidate'].includes(videoResolution.capability ?? '') && <p className="text-xs text-(--ui-text-tertiary)">{c.videoProcessingDisclosure}</p>}
      {error && <p className="text-sm text-destructive" role="alert">{humanError(error, c)}</p>}
      <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="space-y-2">
          <h3 className="font-medium">{c.source}</h3>
          {listStatus === 'loading' && <p className="text-sm text-(--ui-text-secondary)">{c.loadingSources}</p>}
          {listStatus === 'error' && <div className="space-y-2 text-sm text-destructive" role="alert"><p>{c.failedList}</p><button className="rounded-lg border px-3 py-1" onClick={() => void refreshList()} type="button">{c.retryList}</button></div>}
          {items.length === 0 && listStatus === 'ready' && <p className="text-sm text-(--ui-text-secondary)">{c.empty}</p>}
          {items.map(item => <button className={`block w-full rounded-xl border p-3 text-left ${(openingId ?? selected?.id) === item.id ? 'bg-(--ui-row-active-background)' : ''}`} key={item.id} onClick={() => void openDocument(item.id, true)} type="button">
            <span className="block truncate font-medium">{item.filename}</span>
            <span className="text-xs text-(--ui-text-secondary)">{item.storageMode === 'cloud' ? c.cloud : c.local} · {item.status === 'ready' ? c.ready : item.status === 'processing' ? c.processing : c.failed}</span>
          </button>)}
        </aside>
        <main className="min-w-0 space-y-5">
          {!selected && <p className="rounded-xl border p-6 text-sm text-(--ui-text-secondary)">{openingId ? c.opening : c.select}</p>}
          {selected && <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
              <div><h3 className="font-semibold">{selected.filename}</h3><p className="text-xs text-(--ui-text-secondary)">{selected.status === 'ready' ? c.ready : selected.status === 'processing' ? c.processing : humanError(selected.error_code ?? '', c)}</p>{selected.kind === 'subtitle' && <p className="mt-1 text-xs text-(--ui-text-secondary)">{selected.evidence_origin || selected.evidenceOrigin ? c.videoTranscriptNotice : c.subtitleNotice}</p>}</div>
              <div className="flex gap-2">
                <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => void perform(async () => {
                  const sourceId = selected.id
                  const result = await bridge()?.openSource(sourceId)

                  if (!result?.ok && selectedDocumentIdRef.current === sourceId) {setError(result?.code ?? c.error)}
                })} type="button">{selected.kind === 'feishu' || (selected.kind === 'subtitle' && (selected.source_url || selected.sourceUrl)) ? c.openLink : c.open}</button>
                {selected.status === 'failed' && <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => void perform(async () => {
                  const sourceId = selected.id
                  const result = await bridge()?.retry(sourceId)

                  if (!result?.ok) { if (selectedDocumentIdRef.current === sourceId) {setError(result?.code ?? c.error)}

 return }

                  await openDocument(sourceId)
                })} type="button">{c.retry}</button>}
                <button className="rounded-lg border px-3 py-2 text-sm text-destructive" onClick={() => void perform(async () => {
                  const sourceId = selected.id
                  const result = await bridge()?.delete(sourceId)

                  if (!result?.ok) { if (selectedDocumentIdRef.current === sourceId) {setError(result?.code ?? c.error)}

 return }

                  if (selectedDocumentIdRef.current === sourceId) {
                    selectedDocumentIdRef.current = null
                    openedDocumentIdRef.current = null
                    openRequestRef.current += 1
                    setSelected(null)
                    setOpeningId(null)
                    setLocalVideo(null)
                    setFrames([])
                  }

                  await refreshList()
                })} type="button">{c.remove}</button>
              </div>
            </div>
            {selected.kind === 'pdf' && selected.status === 'ready' && <section className="rounded-xl border p-4">
              <h3 className="mb-3 font-medium">{c.pdfOriginal} · {c.page.replace('{n}', String(pdfPage))}</h3>
              {pdfPreview?.id === selected.id && <iframe aria-label={c.pdfOriginal} className="h-96 w-full rounded-lg border bg-white" key={`${pdfPreview.url}-${pdfPage}`} src={`${pdfPreview.url}#page=${pdfPage}`} title={c.pdfOriginal} />}
              {pdfError && <p className="text-sm text-(--ui-text-secondary)">{c.pdfPreviewUnavailable}</p>}
            </section>}
            {selected.kind === 'subtitle' && selected.status === 'ready' && <section className="space-y-3 rounded-xl border p-4">
              <h3 className="font-medium">{c.videoPlayer}</h3>
              <p className="text-xs text-(--ui-text-secondary)">{c.videoPairing}</p>
              <label className="inline-block cursor-pointer rounded-lg border px-3 py-2 text-sm">
                {c.attachVideo}
                <input accept="video/*" aria-label={c.attachVideo} className="sr-only" onChange={event => {
                  const file = event.target.files?.[0]
                  event.target.value = ''

                  if (!file) {return}

                  if (!file.type.startsWith('video/') && !(!file.type && /\.(?:mp4|webm|mov|m4v|ogv)$/i.test(file.name))) {
                    setVideoError(c.videoUnsupported)

                    return
                  }

                  setLocalVideo({ documentId: selected.id, name: file.name, url: URL.createObjectURL(file) })
                  setFrames([])
                  setVideoError('')
                }} type="file" />
              </label>
              {activeVideo && <video aria-label={`${c.videoPlayer}: ${activeVideo.name}`} className="w-full rounded-lg bg-black" controls onError={() => setVideoError(c.videoPlaybackFailed)} preload="metadata" ref={videoRef} src={activeVideo.url} />}
              {activeVideo && <button className="rounded-lg border px-3 py-2 text-sm" onClick={captureCurrentFrame} type="button">{c.frameCapture}</button>}
              {activeVideo && frames.some(frame => frame.videoUrl === activeVideo.url) && <div aria-label={c.frameEvidence} className="space-y-2" role="region">
                <p className="text-xs text-(--ui-text-tertiary)">{c.frameBoundary}</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {frames.filter(frame => frame.videoUrl === activeVideo.url).map(frame => <figure className="rounded-lg border p-2" key={frame.id}>
                    <img alt={`${c.frameEvidence} · ${frameTimestamp(frame.seconds)}`} className="w-full rounded bg-black" src={frame.dataUrl} />
                    <figcaption className="mt-1 text-xs text-(--ui-text-secondary)">{frameTimestamp(frame.seconds)}</figcaption>
                  </figure>)}
                </div>
              </div>}
              {videoError && <p className="text-sm text-destructive" role="alert">{videoError}</p>}
            </section>}
            {(quickOverview || !!selected.deep_reports?.length) && <DeepAnalysisReports bridge={bridge()} key={`reports:${selected.analysis_scope}:${selected.id}:${selected.analysis_revision}`} locale={locale} onChange={reports => {
              setSelected(current => current?.id === selected.id && current.analysis_scope === selected.analysis_scope && current.analysis_revision === selected.analysis_revision
                ? { ...current, deep_reports: reports } : current)
            }} source={selected} />}
            {selected.status === 'ready' && <>
              {quickOverview && <VideoSemanticOverviewPanel bridge={bridge()} jump={jump} key={`${selected.analysis_scope}:${selected.id}:${selected.analysis_revision}:${locale}`} label={location => locationLabel(location, c)} locale={locale} source={selected} />}
              {quickOverview && <section aria-label={c.quickTitle} className="space-y-3 rounded-xl border p-4">
                <h3 className="font-medium">{c.quickTitle}</h3>
                <p className="text-sm text-(--ui-text-secondary)">{c.quickCoverage.replace('{count}', String(quickOverview.count)).replace('{start}', timestamp(quickOverview.firstSeconds)).replace('{end}', timestamp(quickOverview.lastSeconds))}</p>
                <p className="text-xs text-(--ui-text-tertiary)">{c.quickBoundary}</p>
                {onDeepBreakdown && <div className="space-y-1">
                  <button className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50" disabled={busy || connection?.mode === 'remote'} onClick={() => void perform(async () => {
                    let visualEvidence = activeVideo ? frames.filter(frame => frame.videoUrl === activeVideo.url) : []

                    if (activeVideo && visualEvidence.length < 3) {
                      const seconds = quickOverview.samples
                        .map(anchor => Number(anchor.location.start_seconds) + Math.min(0.25, (Number(anchor.location.end_seconds) - Number(anchor.location.start_seconds)) / 2))
                        .filter(second => visualEvidence.every(frame => Math.abs(frame.seconds - second) > 0.1))
                        .slice(0, 3 - visualEvidence.length)
                      const sampled = await sampleVideoFrames(activeVideo.url, seconds)

                      if (selectedDocumentIdRef.current !== selected.id || videoRef.current?.src !== activeVideo.url) {return}

                      visualEvidence = [...visualEvidence, ...sampled.map(frame => ({ ...frame, id: ++frameIdRef.current, videoUrl: activeVideo.url }))].slice(-3)
                      if (sampled.length) {setFrames(visualEvidence); setVideoError('')}
                      else if (!visualEvidence.length) {setVideoError(c.frameFailed)}
                    }

                    await onDeepBreakdown(selected, locale, visualEvidence)
                  })} type="button">{c.deepAction}</button>
                  <p className="text-xs text-(--ui-text-tertiary)">{connection?.mode === 'remote' ? c.deepLocalOnly : activeVideo ? frames.some(frame => frame.videoUrl === activeVideo.url) ? c.deepFrameDisclosure : c.deepAutoFrameDisclosure : c.deepDisclosure}</p>
                </div>}
                <div className="grid gap-2 md:grid-cols-3">
                  {quickOverview.samples.map(anchor => <button className="min-w-0 rounded-lg border p-3 text-left text-sm hover:bg-(--ui-row-active-background)" key={anchor.id} onClick={() => jump(anchor.id)} type="button">
                    <span className="block text-xs text-(--ui-text-secondary)">{c.quickJump} · {locationLabel(anchor.location, c)}</span>
                    <span className="mt-1 block line-clamp-3 whitespace-pre-wrap">{anchor.text}</span>
                  </button>)}
                </div>
              </section>}
              <section className="space-y-3 rounded-xl border p-4">
                <h3 className="font-medium">{c.question}</h3>
                <div className="flex gap-2"><input aria-label={c.question} className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2" onChange={event => setQuestion(event.target.value)} value={question} /><button className="rounded-lg border px-3 py-2 disabled:opacity-50" disabled={busy || question.trim().length < 2} onClick={() => void perform(async () => {
                  const sourceId = selected.id
                  const result = await bridge()?.ask(sourceId, question)

                  if (!result?.ok) { if (selectedDocumentIdRef.current === sourceId) {setError(result?.code ?? c.error)}

 return }

                  if (selectedDocumentIdRef.current === sourceId) {setQuestion('')}
                  await openDocument(sourceId)
                })} type="button">{c.ask}</button></div>
                {(selected.questions ?? []).map(answer)}
              </section>
              <section className="space-y-3 rounded-xl border p-4">
                <h3 className="font-medium">{c.notes}</h3>
                {anchorId && <p className="text-xs text-(--ui-text-secondary)">{c.selectedAnchor}: {anchorId}</p>}
                <textarea aria-label={c.notePlaceholder} className="min-h-20 w-full rounded-lg border bg-transparent p-3" onChange={event => setNote(event.target.value)} placeholder={c.notePlaceholder} value={note} />
                <button className="rounded-lg border px-3 py-2 disabled:opacity-50" disabled={busy || !note.trim()} onClick={() => void perform(async () => {
                  const sourceId = selected.id
                  const result = await bridge()?.addNote(sourceId, note, anchorId)

                  if (!result?.ok) { if (selectedDocumentIdRef.current === sourceId) {setError(result?.code ?? c.error)}

 return }

                  if (selectedDocumentIdRef.current === sourceId) {setNote(''); setAnchorId(null)}
                  await openDocument(sourceId)
                })} type="button">{c.note}</button>
                {(selected.notes ?? []).map(item => <div className="flex justify-between gap-3 rounded-lg border p-3 text-sm" key={item.id}><div><p>{item.body}</p>{item.anchor_id && <button className="text-xs underline" onClick={() => jump(item.anchor_id!)} type="button">{c.citation} · {item.anchor_id}</button>}</div><button aria-label={c.deleteNote} onClick={() => void perform(async () => {
                  const sourceId = selected.id
                  const result = await bridge()?.deleteNote(sourceId, item.id)

                  if (!result?.ok) {if (selectedDocumentIdRef.current === sourceId) {setError(result?.code ?? c.error)}

 return}

                  await openDocument(sourceId)
                })} type="button">×</button></div>)}
              </section>
              <section className="space-y-3"><h3 className="font-medium">{c.evidence}</h3>
                {(selected.anchors ?? []).length === 0 && <p>{c.noSourceText}</p>}
                {(selected.anchors ?? []).map(anchor => <article className="scroll-mt-5 rounded-xl border p-4" id={`analysis-anchor-${anchor.id}`} key={anchor.id}><div className="flex justify-between gap-3 text-xs text-(--ui-text-secondary)"><span>{locationLabel(anchor.location, c)}</span><button className="underline" onClick={() => { setAnchorId(anchor.id); setNote('') }} type="button">{c.anchorNote}</button></div><p className="mt-2 whitespace-pre-wrap text-sm">{anchor.text}</p></article>)}
              </section>
            </>}
          </>}
        </main>
      </div>
    </div>
  </section>
}
