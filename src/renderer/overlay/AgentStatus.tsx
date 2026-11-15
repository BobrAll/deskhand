import type { AgentEvent, AgentToolRequest } from '@shared/types'
import { agentMark } from './agentRow'

interface Props {
  agent: AgentEvent | null
  done: boolean
  running: boolean
  status: string | null
  hint: string | null
  blockedAction: boolean
  answerAgent(request: AgentToolRequest, allow: boolean, remember: boolean): Promise<void>
}

export function AgentStatus({ agent, done, running, status, hint, blockedAction, answerAgent }: Props) {
  const approval = agent?.approval ?? null
  return done ? (
    <div className="agent-head agent-done" role="status">
      <svg className="agent-check" viewBox="0 0 20 20" aria-hidden="true">
        <path d="m3 10 4.5 4.5 9-9" />
      </svg>
      <span className="agent-label">Готово</span>
    </div>
  ) : agent && (status || approval) && !(agent.code === 'blocked' && blockedAction) ? (
    <div className="agent" data-phase={agent.phase} data-mark={agentMark(agent)} data-running={running || undefined}>
      {status && (
        <div className="agent-head" role="status">
          <span className="agent-dot" aria-hidden />
          <span className="agent-label" key={`${agent.step}:${agent.phase}`}>
            {status}
          </span>
          {hint && <span className="agent-hint">{hint}</span>}
        </div>
      )}

      {/*
        The confirmation, in the flow of the run rather than in a modal.
        The question is about one named element — "нажать «Экспорт» в Safari" —
        and a system dialog would cover the window it is asking about. Here it
        appears where the step it belongs to appears, so the user reads the
        run and the question as one thing.
      */}
      {agent.phase === 'asking' && approval && (
        <div className="agent-ask" role="group" aria-label="Подтверждение действия">
          <div className="agent-ask-title">Нужно разрешение</div>
          {agent.message && <div className="agent-ask-detail">{agent.message}</div>}
          <div className="agent-ask-buttons">
            <button className="agent-allow" onClick={() => void answerAgent(approval, true, false)}>
              Разрешить
            </button>
            <button
              className="agent-always"
              title="Запомнить именно это действие и больше не спрашивать"
              onClick={() => void answerAgent(approval, true, true)}
            >
              Больше не спрашивать
            </button>
            <button className="agent-deny" onClick={() => void answerAgent(approval, false, false)}>
              Отменить
            </button>
          </div>
          <div className="agent-ask-hint">↩ разрешить · ⌘↩ больше не спрашивать · Esc отменить</div>
        </div>
      )}
    </div>
  ) : null
}
