import { Link } from 'react-router-dom'

export function HomePage() {
  return (
    <main className="page">
      <h1>两个入口</h1>
      <p className="muted">工作区和陪伴使用分开的会话、文件和记忆。陪伴默认读不到工作区记录。</p>
      <div className="grid-2">
        <Link className="card" to="/workspace" data-testid="workspace-entry">
          <strong>Workspace</strong>
          <span>项目、任务、时间线和只属于工作的对话。</span>
        </Link>
        <Link className="card" to="/companion" data-testid="companion-entry">
          <strong>Companion</strong>
          <span>角色、人格卡、可确认的记忆，以及每个角色自己的聊天。</span>
        </Link>
      </div>
    </main>
  )
}
