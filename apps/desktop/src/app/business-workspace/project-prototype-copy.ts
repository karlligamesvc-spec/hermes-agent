export const PROJECT_PROTOTYPE_COPY = {
  zh: {
    peers: '项目内容', projects: '我的项目', library: '工作流库',
    filters: { all: '全部', 'not-started': '待开始', 'in-progress': '进行中', 'awaiting-acceptance': '待验收', completed: '已完成' },
    overview: '概览', workflows: '工作流', results: '成果', tabs: '项目详情',
    goal: '项目目标', relationship: '项目承载目标，工作流负责执行，成果用于验收。',
    stages: ['定义项目', '加入工作流', '执行与产出', '完成项目'],
    stageDescriptions: ['明确目标与验收标准', '选择可复用的执行路径', '所有工作流运行成功', '查看成果后手动确认'],
    unknown: '项目进度暂不可用', loading: '正在读取项目进度', progress: '工作流完成进度',
    noResults: '尚无已记录的项目成果', resultsUnavailable: '项目成果暂不可用，请重试。',
    reviewResults: '查看成果并验收', viewWorkflows: '查看工作流进度', finishHint: '运行成功后，查看成果再确认项目完成。',
    moreResults: '加载更多成果', loaded: (count: number) => `已加载 ${count} 个项目，筛选基于已加载项目`
  },
  'zh-hant': {
    peers: '專案內容', projects: '我的專案', library: '工作流庫',
    filters: { all: '全部', 'not-started': '待開始', 'in-progress': '進行中', 'awaiting-acceptance': '待驗收', completed: '已完成' },
    overview: '概覽', workflows: '工作流', results: '成果', tabs: '專案詳情',
    goal: '專案目標', relationship: '專案承載目標，工作流負責執行，成果用於驗收。',
    stages: ['定義專案', '加入工作流', '執行與產出', '完成專案'],
    stageDescriptions: ['明確目標與驗收標準', '選擇可重用的執行路徑', '所有工作流執行成功', '查看成果後手動確認'],
    unknown: '專案進度暫不可用', loading: '正在讀取專案進度', progress: '工作流完成進度',
    noResults: '尚無已記錄的專案成果', resultsUnavailable: '專案成果暫不可用，請重試。',
    reviewResults: '查看成果並驗收', viewWorkflows: '查看工作流進度', finishHint: '執行成功後，查看成果再確認專案完成。',
    moreResults: '載入更多成果', loaded: (count: number) => `已載入 ${count} 個專案，篩選依據已載入專案`
  },
  en: {
    peers: 'Project content', projects: 'My projects', library: 'Workflow library',
    filters: { all: 'All', 'not-started': 'Not started', 'in-progress': 'In progress', 'awaiting-acceptance': 'Awaiting acceptance', completed: 'Completed' },
    overview: 'Overview', workflows: 'Workflows', results: 'Results', tabs: 'Project details',
    goal: 'Project goal', relationship: 'Projects hold goals, workflows execute them, and results support acceptance.',
    stages: ['Define project', 'Add workflows', 'Execute and produce', 'Complete project'],
    stageDescriptions: ['Set the goal and acceptance criteria', 'Choose reusable execution paths', 'All workflow runs succeed', 'Review results and confirm manually'],
    unknown: 'Project progress unavailable', loading: 'Reading project progress', progress: 'Workflow completion progress',
    noResults: 'No recorded project results yet', resultsUnavailable: 'Project results unavailable. Please retry.',
    reviewResults: 'Review results', viewWorkflows: 'View workflow progress', finishHint: 'After runs succeed, review the results before completing the project.',
    moreResults: 'Load more results', loaded: (count: number) => `${count} projects loaded; filters apply to loaded projects`
  },
  ja: {
    peers: 'プロジェクト内容', projects: '自分のプロジェクト', library: 'ワークフローライブラリ',
    filters: { all: 'すべて', 'not-started': '未開始', 'in-progress': '進行中', 'awaiting-acceptance': '確認待ち', completed: '完了' },
    overview: '概要', workflows: 'ワークフロー', results: '成果', tabs: 'プロジェクト詳細',
    goal: 'プロジェクトの目標', relationship: 'プロジェクトで目標を定め、ワークフローで実行し、成果を確認します。',
    stages: ['目標を定義', 'ワークフローを追加', '実行と成果作成', 'プロジェクトを完了'],
    stageDescriptions: ['目標と確認基準を設定', '再利用できる実行手順を選択', 'すべての実行が成功', '成果を確認して手動で完了'],
    unknown: '進捗を取得できません', loading: '進捗を読み込み中', progress: 'ワークフローの完了進捗',
    noResults: '記録された成果はまだありません', resultsUnavailable: '成果を取得できません。再試行してください。',
    reviewResults: '成果を確認', viewWorkflows: '実行の進捗を見る', finishHint: '実行成功後に成果を確認し、プロジェクトを完了してください。',
    moreResults: '成果をさらに読み込む', loaded: (count: number) => `${count} 件を読み込み済み。絞り込みは読み込み済みのプロジェクトが対象です`
  },
  ar: {
    peers: 'محتوى المشروع', projects: 'مشاريعي', library: 'مكتبة سير العمل',
    filters: { all: 'الكل', 'not-started': 'لم يبدأ', 'in-progress': 'قيد التنفيذ', 'awaiting-acceptance': 'بانتظار القبول', completed: 'مكتمل' },
    overview: 'نظرة عامة', workflows: 'سير العمل', results: 'النتائج', tabs: 'تفاصيل المشروع',
    goal: 'هدف المشروع', relationship: 'تحمل المشاريع الأهداف، وتنفذها مسارات العمل، وتدعم النتائج عملية القبول.',
    stages: ['تحديد المشروع', 'إضافة سير العمل', 'التنفيذ والإنتاج', 'إكمال المشروع'],
    stageDescriptions: ['تحديد الهدف ومعايير القبول', 'اختيار مسارات تنفيذ قابلة لإعادة الاستخدام', 'نجاح جميع عمليات سير العمل', 'مراجعة النتائج والتأكيد يدويًا'],
    unknown: 'تقدم المشروع غير متاح', loading: 'جارٍ قراءة تقدم المشروع', progress: 'تقدم إكمال سير العمل',
    noResults: 'لا توجد نتائج مسجلة للمشروع بعد', resultsUnavailable: 'نتائج المشروع غير متاحة. أعد المحاولة.',
    reviewResults: 'مراجعة النتائج', viewWorkflows: 'عرض تقدم سير العمل', finishHint: 'بعد نجاح التنفيذ، راجع النتائج قبل إكمال المشروع.',
    moreResults: 'تحميل المزيد من النتائج', loaded: (count: number) => `تم تحميل ${count} مشروعًا؛ تُطبّق المرشحات على المشاريع المحمّلة`
  }
} as const
