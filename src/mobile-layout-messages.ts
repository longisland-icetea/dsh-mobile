export type MobileLayoutLanguage = 'it' | 'en' | 'zh'

export const MOBILE_LAYOUT_MESSAGES = Object.freeze({
  it: Object.freeze({ closePanels: 'Chiudi pannelli', workspaceNavigation: 'Navigazione area di lavoro e sessioni', notifyDone: 'Attività completata', notifyFailed: 'Attività non riuscita', notifyFailedDetail: 'Attività non riuscita: {message}', notifyApproval: 'Input richiesto', notifyUntitledSession: 'Sessione senza titolo' }),
  en: Object.freeze({ closePanels: 'Close panels', workspaceNavigation: 'Workspace and session navigation', notifyDone: 'Task completed', notifyFailed: 'Task failed', notifyFailedDetail: 'Task failed: {message}', notifyApproval: 'Input needed', notifyUntitledSession: 'Untitled session' }),
  zh: Object.freeze({ closePanels: '关闭浮层', workspaceNavigation: '工作区与会话导航', notifyDone: '任务完成', notifyFailed: '任务失败', notifyFailedDetail: '任务失败：{message}', notifyApproval: '需要处理', notifyUntitledSession: '未命名会话' }),
})
