import { Link } from 'react-router-dom'
import { useSession } from '../session.tsx'

export function HomePage() {
  const { user } = useSession()
  const name = user?.displayName?.trim()
  return (
    <main className="page home-landing">
      <p className="eyebrow"><span className="mark">D/</span> Deep Companion</p>
      <h1>{name ? `${name}，从哪边开始` : '从哪边开始'}</h1>
      <p className="lede">工作区和陪伴使用分开的会话、文件和记忆。陪伴默认读不到工作区记录。</p>
      <div className="entry-grid">
        <Link className="entry entry-work" to="/workspace" data-testid="workspace-entry">
          <span className="kicker">Workspace</span>
          <strong>工作区</strong>
          <p>项目、任务、时间线，和只属于工作的对话。</p>
        </Link>
        <Link className="entry entry-companion" to="/companion" data-testid="companion-entry">
          <span className="kicker">Companion</span>
          <strong>陪伴</strong>
          <p>角色、人格卡、可确认的记忆，以及每个角色自己的聊天。</p>
        </Link>
      </div>
    </main>
  )
}
