import type { ProcessCopy, StepCopy, StepFacts } from './types-process'

// hc-973: the process area in words a creator uses. Every tool Desktop can
// meet has a running text, a title and a summary of what it came back with;
// `src/components/assistant-ui/process/step-registry.test.ts` fails when one
// is missing.

const n = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString('en')} ${count === 1 ? one : many}`

const step = (
  running: string,
  title: string,
  done: (facts: StepFacts) => string,
  source?: (facts: StepFacts) => string
): StepCopy => (source ? { running, title, done, source } : { running, title, done })

const said = (text: string) => () => text

/** "Found 20 posts" — or the fallback when the call reported nothing countable. */
const found =
  (one: string, many?: string, fallback = 'Done') =>
  (facts: StepFacts) =>
    facts.count ? `Found ${n(facts.count, one, many)}` : facts.empty ? 'Found nothing' : fallback

/** "Read 3 files" when the step ran more than once. */
const each = (verb: string, one: string, single: string, many?: string) => (facts: StepFacts) =>
  facts.calls > 1 ? `${verb} ${n(facts.calls, one, many)}` : single

const publicData = (facts: StepFacts) => (facts.platform ? `Public data on ${facts.platform}` : 'Public platform data')
const douyinIndex = () => "Douyin's official trend data (Juliang Suanshu)"

const KANBAN: Record<string, [string, string]> = {
  kanban_attach: ['Attaching a file to the task', 'Attach file'],
  kanban_attach_url: ['Attaching a link to the task', 'Attach link'],
  kanban_attachments: ["Checking the task's attachments", 'Check attachments'],
  kanban_block: ['Marking the task as blocked', 'Mark blocked'],
  kanban_comment: ['Commenting on the task', 'Comment'],
  kanban_complete: ['Marking the task done', 'Mark done'],
  kanban_create: ['Creating a task', 'Create task'],
  kanban_heartbeat: ['Reporting progress', 'Report progress'],
  kanban_link: ['Linking tasks', 'Link tasks'],
  kanban_list: ['Checking the task board', 'Task board'],
  kanban_request_changes: ['Asking for changes', 'Ask for changes'],
  kanban_request_review: ['Asking for a review', 'Ask for review'],
  kanban_show: ['Opening the task', 'Open task'],
  kanban_unblock: ['Unblocking the task', 'Unblock task']
}

export const enProcess: ProcessCopy = {
  steps: {
    // APEX platform tools
    social_download: step(
      'Downloading the video',
      'Download video',
      facts =>
        [`Downloaded ${n(facts.calls, 'video')}`, facts.length, facts.likes && `${facts.likes} likes`]
          .filter(Boolean)
          .join(', '),
      facts =>
        facts.platform ? `The public post behind this ${facts.platform} link` : 'The public post behind this link'
    ),
    media_transcribe: step(
      'Transcribing the speech',
      'Transcribe speech',
      facts =>
        facts.empty
          ? 'No speech in the video'
          : facts.chars
            ? `Got the transcript, ${n(facts.chars, 'character')}`
            : facts.length
              ? `Transcribed ${facts.length} of audio`
              : 'Got the transcript',
      facts =>
        facts.length
          ? `Turned the speech in the video into text, ${facts.length} of audio`
          : 'Turned the speech in the video into text'
    ),
    image_ocr: step('Reading the text in the images', 'Read image text', facts =>
      facts.count ? `Read ${n(facts.count, 'image')}` : 'Done'
    ),
    social_batch_submit: step('Submitting the batch', 'Submit batch', facts =>
      facts.count ? `Submitted ${n(facts.count, 'link')}` : 'Submitted'
    ),
    social_batch_status: step('Checking the batch', 'Check batch', said('Checked')),
    creator_top_posts: step("Finding the creator's top posts", 'Find top posts', found('post'), publicData),
    social_audience: step(
      'Looking at the audience',
      'Audience profile',
      facts => (facts.query ? `Audience for "${facts.query}"` : 'Done'),
      douyinIndex
    ),
    social_captions: step(
      'Getting the captions',
      'Get captions',
      facts => (facts.chars ? `Got the captions, ${n(facts.chars, 'character')}` : 'Got the captions'),
      publicData
    ),
    social_comments: step(
      'Reading the comments',
      'Read comments',
      facts => (facts.count ? `Read ${n(facts.count, 'comment')}` : 'Done'),
      publicData
    ),
    social_content: step(
      'Opening the post',
      'Open post',
      facts => (facts.count && facts.count > 1 ? `Opened ${n(facts.count, 'post')}` : 'Opened the post'),
      publicData
    ),
    social_creator_discovery: step(
      'Finding creators',
      'Find creators',
      found('creator'),
      () => "Douyin's official creator directory"
    ),
    social_keyword_insight: step(
      'Checking how hot the keyword is',
      'Keyword trends',
      facts => (facts.query ? `Trends for "${facts.query}"` : 'Done'),
      douyinIndex
    ),
    social_posts: step(
      "Reading the account's posts",
      'Account posts',
      facts => (facts.count ? `Read ${n(facts.count, 'post')}` : 'Done'),
      publicData
    ),
    social_product: step('Looking at products on sale', 'Products on sale', found('product'), facts =>
      facts.platform ? `Products listed on ${facts.platform}` : 'Products listed on the platform'
    ),
    social_profile: step('Opening the account profile', 'Account profile', said('Opened the profile'), publicData),
    social_search: step('Searching for similar posts', 'Search posts', found('post'), publicData),
    social_trending: step(
      'Checking the trending list',
      'Trending list',
      facts => (facts.count ? n(facts.count, 'trending topic') : 'Done'),
      publicData
    ),
    generate_image: step('Generating the image', 'Generate image', facts =>
      facts.count ? `Made ${n(facts.count, 'image')}` : 'Image ready'
    ),
    generate_video: step('Generating the video', 'Generate video', facts =>
      facts.count ? `Made ${n(facts.count, 'video')}` : 'Video ready'
    ),
    live_record_start: step('Starting the live recording', 'Start recording', said('Recording')),
    live_record_status: step('Checking the recording', 'Check recording', said('Checked')),
    live_record_stop: step('Stopping the recording', 'Stop recording', said('Stopped')),
    honesty_verify: step("Checking the copy's claims", 'Check claims', said('Checked')),
    doc_file_write: step('Making the document', 'Make document', said('Document ready')),
    xlsx_file_write: step('Making the spreadsheet', 'Make spreadsheet', said('Spreadsheet ready')),
    pptx_file_write: step('Making the slides', 'Make slides', said('Slides ready')),
    feishu_doc_write: step('Writing the Feishu doc', 'Write Feishu doc', said('Written')),
    feishu_bitable_write: step('Writing to the Feishu base', 'Write Feishu base', facts =>
      facts.count ? `Wrote ${n(facts.count, 'row')}` : 'Written'
    ),
    // Finding and loading tools and skills: preparation, not steps of the task
    tool_search: step('Looking for the right tools', 'Find tools', found('tool')),
    tool_describe: step('Reading how the tools work', 'Read tool instructions', said('Done')),
    tool_call: step('Working', 'Work', said('Done')),
    skill_view: step('Getting the method ready', 'Prepare method', said('Ready')),
    skills_list: step('Checking the methods on hand', 'List methods', said('Done')),
    skill_manage: step('Updating a method', 'Update method', said('Updated')),
    // Built-in tools
    web_search: step('Searching the web', 'Web search', found('result'), () => 'A web search'),
    web_extract: step(
      'Reading the web page',
      'Read web page',
      each('Read', 'page', 'Read the page'),
      () => 'The web pages below'
    ),
    terminal: step('Working on your computer', 'Work on your computer', each('Done,', 'action', 'Done')),
    execute_code: step('Processing the data', 'Process data', said('Done')),
    process_manage: step('Checking background work', 'Check background work', said('Checked')),
    read_file: step('Reading the file', 'Read file', each('Read', 'file', 'Read the file')),
    write_file: step('Writing the file', 'Write file', each('Wrote', 'file', 'Saved the file')),
    edit_file: step('Editing the file', 'Edit file', each('Edited', 'file', 'Edited the file')),
    patch: step('Editing the file', 'Edit file', each('Edited', 'file', 'Edited the file')),
    list_files: step('Looking through the folder', 'Look through folder', facts =>
      facts.count ? n(facts.count, 'file') : 'Done'
    ),
    search_files: step('Searching your files', 'Search files', found('match', 'matches')),
    vision_analyze: step('Looking at the image', 'Look at image', said('Done')),
    video_analyze: step('Watching the video', 'Watch video', said('Done')),
    image_generate: step('Generating the image', 'Generate image', said('Image ready')),
    video_generate: step('Generating the video', 'Generate video', said('Video ready')),
    xai_video_edit: step('Editing the video', 'Edit video', said('Edited')),
    xai_video_extend: step('Extending the video', 'Extend video', said('Extended')),
    text_to_speech: step('Making the voice-over', 'Make voice-over', said('Voice-over ready')),
    browser_navigate: step('Opening the page', 'Open page', each('Opened', 'page', 'Opened the page')),
    browser_snapshot: step('Reading the page', 'Read page', said('Done')),
    browser_click: step('Clicking on the page', 'Click', said('Done')),
    browser_type: step('Typing on the page', 'Type', said('Done')),
    browser_fill: step('Filling in the form', 'Fill in form', said('Done')),
    browser_scroll: step('Scrolling the page', 'Scroll', said('Done')),
    browser_back: step('Going back a page', 'Go back', said('Done')),
    browser_press: step('Pressing a key', 'Press key', said('Done')),
    browser_get_images: step('Collecting images from the page', 'Collect images', found('image')),
    browser_vision: step('Looking at the page', 'Look at page', said('Done')),
    browser_console: step("Checking the page's messages", 'Check page messages', said('Done')),
    browser_cdp: step('Controlling the browser', 'Control browser', said('Done')),
    browser_dialog: step('Handling a pop-up', 'Handle pop-up', said('Done')),
    browser_vault: step('Using a saved sign-in', 'Use saved sign-in', said('Done')),
    browser_exec: step('Working in the browser', 'Work in browser', said('Done')),
    browser_take_screenshot: step('Taking a screenshot', 'Screenshot', said('Done')),
    todo: step('Making a plan', 'Plan', facts => (facts.count ? n(facts.count, 'item') : 'Done')),
    todo_list: step('Making a plan', 'Plan', facts => (facts.count ? n(facts.count, 'item') : 'Done')),
    memory: step('Noting it down', 'Remember', said('Noted')),
    session_search: step('Looking through past chats', 'Search past chats', found('match', 'matches')),
    session_search_recall: step('Looking through past chats', 'Search past chats', found('match', 'matches')),
    clarify: step('Asking you', 'Ask you', said('Asked')),
    delegate_task: step('Handing out subtasks', 'Hand out subtasks', facts =>
      facts.count ? n(facts.count, 'subtask') : 'Handed out'
    ),
    cronjob: step('Scheduling a task', 'Schedule task', said('Scheduled')),
    cronjob_manage: step('Scheduling a task', 'Schedule task', said('Scheduled')),
    computer_use: step('Using your computer', 'Use computer', said('Done')),
    manage_connections: step('Managing connections', 'Manage connections', said('Done')),
    manage_catalog: step('Checking apps you can connect', 'Check apps', said('Done')),
    send_message: step('Sending the message', 'Send message', said('Sent')),
    react_to_message: step('Reacting', 'React', said('Done')),
    read_terminal: step('Reading the terminal', 'Read terminal', said('Done')),
    close_terminal: step('Closing the terminal', 'Close terminal', said('Closed')),
    read_window_below: step('Reading the window', 'Read window', said('Done')),
    focus_pane: step('Switching panes', 'Switch pane', said('Done')),
    gui_tour: step('Showing you around', 'Show around', said('Done')),
    set_theme: step('Changing the theme', 'Change theme', said('Done')),
    setup_beat: step('Setting things up', 'Set up', said('Done')),
    show_tip: step('Showing a tip', 'Show tip', said('Done')),
    annotate_preview: step('Marking up the preview', 'Mark up preview', said('Done')),
    desktop_preview: step('Opening the preview', 'Open preview', said('Done')),
    desktop_project: step('Updating the project', 'Update project', said('Done')),
    drive_preview: step('Opening the file preview', 'Open file preview', said('Done')),
    feishu_doc_read: step('Reading the Feishu doc', 'Read Feishu doc', said('Read')),
    feishu_drive_add_comment: step('Adding a Feishu comment', 'Add comment', said('Added')),
    feishu_drive_list_comments: step('Reading Feishu comments', 'Read comments', found('comment')),
    feishu_drive_list_comment_replies: step('Reading the replies', 'Read replies', found('reply', 'replies')),
    feishu_drive_reply_comment: step('Replying to the comment', 'Reply to comment', said('Replied')),
    x_search: step('Searching X', 'Search X', found('post'), publicData),
    ...Object.fromEntries(
      Object.entries(KANBAN).map(([name, [running, title]]) => [name, step(running, title, said('Done'))])
    )
  },
  unknownStep: step('Working', 'Work', said('Done')),
  status: {
    preparing: 'Getting ready…',
    thinking: 'Thinking…',
    writing: 'Writing the reply…',
    running: running => `${running}…`,
    stepOf: index => `Step ${index}`,
    stepOfTotal: (index, total) => `Step ${index} of ${total}`,
    chainSeparator: ' → ',
    moreSteps: total => `${total} steps in all`,
    took: duration => `Took ${duration}`,
    failed: title => `${title} didn't work`,
    stopped: title => `Stopped at ${title}`,
    methodsOnly: names => `Followed ${names}`
  },
  showSteps: 'Show steps',
  hideSteps: 'Hide steps',
  stepsLabel: 'Steps',
  showSource: 'Where the data came from',
  hideSource: 'Hide sources',
  source: {
    platform: name => `Platform: ${name}`,
    links: 'Links',
    queries: 'Searched for',
    count: count => `Got ${n(count, 'item')}`
  },
  stepFailed: "Didn't work",
  stepPartlyFailed: count => `${n(count, 'try', 'tries')} didn't work`,
  stepStopped: 'Not finished',
  slowHint: 'This step takes a while. Feel free to do something else meanwhile.',
  methods: names => `Methods used: ${names}`,
  listSeparator: ', ',
  subtasks: {
    title: 'Subtasks',
    done: 'Done',
    running: 'In progress',
    failed: "Didn't work",
    dispatched: 'Handed out'
  },
  reasoning: {
    thinking: 'Thinking',
    thought: 'Thought it over',
    thoughtFor: duration => `Thought for ${duration}`,
    collapse: 'Hide'
  },
  failure: {
    fallbackReason: "This step didn't get a result.",
    keptNote: "What's done so far is kept.",
    retry: 'Retry',
    anotherWay: 'Try another way',
    partial: 'Give me what you have',
    retryMessage: title => `Try the "${title}" step again.`,
    anotherWayMessage: title => `The "${title}" step didn't work. Try another way and carry on.`,
    partialMessage: title => `Skip "${title}" for now and give me what you have so far.`
  },
  tech: {
    title: 'Technical details',
    line: (names, duration) => (duration ? `${names} · ${duration}` : names),
    calls: count => n(count, 'call')
  },
  compactNumber: value => new Intl.NumberFormat('en', { maximumFractionDigits: 1, notation: 'compact' }).format(value),
  platforms: {
    bilibili: 'Bilibili',
    douyin: 'Douyin',
    instagram: 'Instagram',
    kuaishou: 'Kuaishou',
    tiktok: 'TikTok',
    wechat_channels: 'WeChat Channels',
    wechat_mp: 'WeChat Official Accounts',
    weibo: 'Weibo',
    x: 'X',
    xiaohongshu: 'Xiaohongshu',
    youtube: 'YouTube',
    zhihu: 'Zhihu'
  }
}
