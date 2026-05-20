import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  CalendarCheck2,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Link2,
  Plus,
  RefreshCcw,
  Trash2,
  UsersRound,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { isSupabaseConfigured, roomTableName, supabase } from './supabaseClient'
import './App.css'

type Participant = {
  id: string
  name: string
  color: string
}

type Availability = Record<string, string[]>

type PlannerState = {
  participants: Participant[]
  availability: Availability
}

type CalendarDay = {
  date: Date
  key: string
  inMonth: boolean
}

type SyncStatus = 'local' | 'needs-config' | 'connecting' | 'online' | 'offline'

const STORAGE_KEY = 'when-we-free-state-v1'
const ROOM_CACHE_PREFIX = 'when-we-free-room-state-v1:'
const SELECTED_BY_ROOM_KEY = 'when-we-free-selected-participant-v1'

const colorPalette = [
  '#E85D45',
  '#247C8A',
  '#D8A132',
  '#7B62C6',
  '#2E9E6F',
  '#D6538B',
  '#5B7F2D',
  '#2F64B5',
]

const weekdayLabels = ['一', '二', '三', '四', '五', '六', '日']

const starterState: PlannerState = {
  participants: [
    {
      id: 'p-me',
      name: '我',
      color: colorPalette[0],
    },
  ],
  availability: {},
}

const todayKey = toDateKey(new Date())

function createId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID()
  }

  return `p-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function createRoomId() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function toDateKey(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function fromDateKey(key: string) {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function getCalendarDays(visibleMonth: Date): CalendarDay[] {
  const year = visibleMonth.getFullYear()
  const month = visibleMonth.getMonth()
  const firstDay = new Date(year, month, 1)
  const firstWeekdayFromMonday = (firstDay.getDay() + 6) % 7
  const gridStart = new Date(year, month, 1 - firstWeekdayFromMonday)

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart)
    date.setDate(gridStart.getDate() + index)

    return {
      date,
      key: toDateKey(date),
      inMonth: date.getMonth() === month,
    }
  })
}

function encodeState(state: PlannerState) {
  const bytes = new TextEncoder().encode(JSON.stringify(state))
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeState(payload: string): PlannerState | null {
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const decoded = new TextDecoder().decode(bytes)

    return sanitizeState(JSON.parse(decoded))
  } catch {
    return null
  }
}

function sanitizeState(value: unknown): PlannerState | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Partial<PlannerState>
  if (!Array.isArray(candidate.participants)) {
    return null
  }

  const participants = candidate.participants
    .filter(
      (participant): participant is Participant =>
        Boolean(participant) &&
        typeof participant.id === 'string' &&
        typeof participant.name === 'string' &&
        typeof participant.color === 'string',
    )
    .map((participant) => ({
      id: participant.id,
      name: participant.name.trim() || '未命名',
      color: participant.color,
    }))

  if (participants.length === 0) {
    return starterState
  }

  const participantIds = new Set(participants.map((participant) => participant.id))
  const availability: Availability = {}
  const rawAvailability =
    candidate.availability && typeof candidate.availability === 'object'
      ? candidate.availability
      : {}

  Object.entries(rawAvailability).forEach(([dateKey, ids]) => {
    if (!Array.isArray(ids)) {
      return
    }

    const availableIds = Array.from(
      new Set(ids.filter((id): id is string => typeof id === 'string' && participantIds.has(id))),
    )

    if (availableIds.length > 0) {
      availability[dateKey] = availableIds
    }
  })

  return { participants, availability }
}

function readHashParam(name: string) {
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  return hashParams.get(name)
}

function readRoomId() {
  return readHashParam('room')?.trim() || ''
}

function setRoomHash(roomId: string) {
  window.history.replaceState(null, '', `#room=${roomId}`)
}

function readJson<T>(key: string, fallback: T) {
  const storedValue = window.localStorage.getItem(key)
  if (!storedValue) {
    return fallback
  }

  try {
    return JSON.parse(storedValue) as T
  } catch {
    window.localStorage.removeItem(key)
    return fallback
  }
}

function readInitialState(roomId: string) {
  const sharedState = readHashParam('state')

  if (sharedState) {
    const decoded = decodeState(sharedState)
    if (decoded) {
      return decoded
    }
  }

  if (roomId) {
    const cachedState = sanitizeState(readJson(`${ROOM_CACHE_PREFIX}${roomId}`, null))
    if (cachedState) {
      return cachedState
    }
  }

  const storedState = sanitizeState(readJson(STORAGE_KEY, null))
  return storedState ?? starterState
}

function App() {
  const [roomId, setRoomId] = useState(readRoomId)
  const [planner, setPlanner] = useState<PlannerState>(() => readInitialState(readRoomId()))
  const [selectedParticipantByRoom, setSelectedParticipantByRoom] = useState<Record<string, string>>(
    () => readJson(SELECTED_BY_ROOM_KEY, {}),
  )
  const [visibleMonth, setVisibleMonth] = useState(() => new Date())
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(colorPalette[1])
  const [shareMessage, setShareMessage] = useState('')
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(() => {
    if (roomId && isSupabaseConfigured) {
      return 'connecting'
    }

    return roomId ? 'needs-config' : 'local'
  })

  const plannerRef = useRef(planner)
  const remoteReadyRef = useRef(false)
  const skipRemoteSaveRef = useRef(false)

  const participantCount = planner.participants.length
  const spaceKey = roomId || 'local'
  const selectedParticipantId = selectedParticipantByRoom[spaceKey]
  const activeParticipant =
    planner.participants.find((participant) => participant.id === selectedParticipantId) ??
    planner.participants[0]
  const activeParticipantId = activeParticipant?.id ?? ''

  const calendarDays = useMemo(() => getCalendarDays(visibleMonth), [visibleMonth])

  const monthLabel = useMemo(
    () =>
      new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: 'long',
      }).format(visibleMonth),
    [visibleMonth],
  )

  const allAvailableDates = Object.keys(planner.availability)
    .filter((dateKey) => isConsensusDate(dateKey))
    .sort()

  const monthAvailableDates = allAvailableDates.filter((dateKey) => {
    const date = fromDateKey(dateKey)
    return (
      date.getFullYear() === visibleMonth.getFullYear() &&
      date.getMonth() === visibleMonth.getMonth()
    )
  })

  const leadingDates = Object.entries(planner.availability)
    .map(([dateKey, ids]) => ({
      dateKey,
      count: ids.length,
      isConsensus: isConsensusDate(dateKey),
    }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || a.dateKey.localeCompare(b.dateKey))
    .slice(0, 5)

  const syncCopy = getSyncCopy(syncStatus, roomId)

  useEffect(() => {
    plannerRef.current = planner
  }, [planner])

  useEffect(() => {
    const handler = () => {
      const nextRoomId = readRoomId()
      setRoomId(nextRoomId)
      setPlanner(readInitialState(nextRoomId))
    }

    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [])

  useEffect(() => {
    const cacheKey = roomId ? `${ROOM_CACHE_PREFIX}${roomId}` : STORAGE_KEY
    window.localStorage.setItem(cacheKey, JSON.stringify(planner))
  }, [planner, roomId])

  useEffect(() => {
    window.localStorage.setItem(SELECTED_BY_ROOM_KEY, JSON.stringify(selectedParticipantByRoom))
  }, [selectedParticipantByRoom])

  useEffect(() => {
    let cancelled = false

    async function connectRoom() {
      remoteReadyRef.current = false

      if (!roomId) {
        if (!cancelled) {
          setSyncStatus('local')
        }
        return
      }

      if (!supabase) {
        if (!cancelled) {
          setSyncStatus('needs-config')
        }
        return
      }

      setSyncStatus('connecting')

      const { data, error } = await supabase
        .from(roomTableName)
        .select('state')
        .eq('id', roomId)
        .maybeSingle()

      if (cancelled) {
        return
      }

      if (error) {
        setShareMessage(`连接房间失败：${error.message}`)
        setSyncStatus('offline')
        return
      }

      if (data?.state) {
        const remoteState = sanitizeState(data.state)
        if (remoteState) {
          skipRemoteSaveRef.current = true
          setPlanner(remoteState)
        }
      } else {
        const { error: insertError } = await supabase
          .from(roomTableName)
          .upsert({ id: roomId, state: plannerRef.current })

        if (insertError) {
          setShareMessage(`创建房间失败：${insertError.message}`)
          setSyncStatus('offline')
          return
        }
      }

      remoteReadyRef.current = true
      setSyncStatus('online')
    }

    void connectRoom()

    const client = supabase

    if (!roomId || !client) {
      return () => {
        cancelled = true
      }
    }

    const channel = client
      .channel(`when-we-free-${roomId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: roomTableName,
          filter: `id=eq.${roomId}`,
        },
        (payload) => {
          const remoteState = sanitizeState((payload.new as { state?: unknown }).state)
          if (!remoteState) {
            return
          }

          skipRemoteSaveRef.current = true
          setPlanner(remoteState)
          setSyncStatus('online')
        },
      )
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setSyncStatus('offline')
        }
      })

    return () => {
      cancelled = true
      void client.removeChannel(channel)
    }
  }, [roomId])

  useEffect(() => {
    const client = supabase

    if (!roomId || !client || syncStatus !== 'online' || !remoteReadyRef.current) {
      return
    }

    if (skipRemoteSaveRef.current) {
      skipRemoteSaveRef.current = false
      return
    }

    const saveTimer = window.setTimeout(async () => {
      const { error } = await client
        .from(roomTableName)
        .upsert({ id: roomId, state: planner })

      if (error) {
        setShareMessage(`同步失败：${error.message}`)
        setSyncStatus('offline')
      }
    }, 220)

    return () => window.clearTimeout(saveTimer)
  }, [planner, roomId, syncStatus])

  function getAvailableIds(dateKey: string) {
    return planner.availability[dateKey] ?? []
  }

  function getAvailableParticipants(dateKey: string) {
    const ids = new Set(getAvailableIds(dateKey))
    return planner.participants.filter((participant) => ids.has(participant.id))
  }

  function isConsensusDate(dateKey: string) {
    if (participantCount === 0) {
      return false
    }

    const ids = new Set(getAvailableIds(dateKey))
    return planner.participants.every((participant) => ids.has(participant.id))
  }

  function shiftMonth(offset: number) {
    setVisibleMonth(
      (current) => new Date(current.getFullYear(), current.getMonth() + offset, 1),
    )
  }

  function jumpToToday() {
    setVisibleMonth(new Date())
  }

  function selectActiveParticipant(id: string) {
    setSelectedParticipantByRoom((current) => ({
      ...current,
      [spaceKey]: id,
    }))
  }

  function addParticipant() {
    const participant: Participant = {
      id: createId(),
      name: newName.trim() || `参与者 ${participantCount + 1}`,
      color: newColor,
    }

    setPlanner((current) => ({
      ...current,
      participants: [...current.participants, participant],
    }))
    selectActiveParticipant(participant.id)
    setNewName('')
    setNewColor(colorPalette[(participantCount + 2) % colorPalette.length])
  }

  function updateParticipant(id: string, patch: Partial<Participant>) {
    setPlanner((current) => ({
      ...current,
      participants: current.participants.map((participant) =>
        participant.id === id ? { ...participant, ...patch } : participant,
      ),
    }))
  }

  function removeParticipant(id: string) {
    setPlanner((current) => {
      const participants = current.participants.filter((participant) => participant.id !== id)
      const availability = Object.fromEntries(
        Object.entries(current.availability)
          .map(([dateKey, ids]) => [dateKey, ids.filter((availableId) => availableId !== id)])
          .filter(([, ids]) => ids.length > 0),
      ) as Availability

      return {
        participants,
        availability,
      }
    })
  }

  function toggleAvailability(dateKey: string) {
    if (!activeParticipantId) {
      return
    }

    setPlanner((current) => {
      const currentIds = new Set(current.availability[dateKey] ?? [])

      if (currentIds.has(activeParticipantId)) {
        currentIds.delete(activeParticipantId)
      } else {
        currentIds.add(activeParticipantId)
      }

      const nextIds = Array.from(currentIds)
      const availability = { ...current.availability }

      if (nextIds.length > 0) {
        availability[dateKey] = nextIds
      } else {
        delete availability[dateKey]
      }

      return { ...current, availability }
    })
  }

  function ensureRoom() {
    if (roomId) {
      return roomId
    }

    const nextRoomId = createRoomId()
    setRoomHash(nextRoomId)
    setRoomId(nextRoomId)
    return nextRoomId
  }

  function createRealtimeRoom() {
    if (!isSupabaseConfigured) {
      setShareMessage('先配置 Supabase 后才能创建实时房间')
      return
    }

    const nextRoomId = createRoomId()
    setRoomHash(nextRoomId)
    setRoomId(nextRoomId)
    setShareMessage('已创建实时房间，复制链接发给其他人即可')
  }

  async function copyShareLink() {
    if (isSupabaseConfigured) {
      const nextRoomId = ensureRoom()
      const shareUrl = `${window.location.origin}${window.location.pathname}#room=${nextRoomId}`

      try {
        await navigator.clipboard.writeText(shareUrl)
        setShareMessage('已复制实时房间链接')
      } catch {
        setShareMessage('实时房间链接已放入地址栏')
      }
      return
    }

    const payload = encodeState(planner)
    const shareUrl = `${window.location.origin}${window.location.pathname}#state=${payload}`

    window.history.replaceState(null, '', `#state=${payload}`)

    try {
      await navigator.clipboard.writeText(shareUrl)
      setShareMessage('已复制本地快照链接')
    } catch {
      setShareMessage('本地快照链接已放入地址栏')
    }
  }

  function clearAvailability() {
    setPlanner((current) => ({ ...current, availability: {} }))
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">When We Free</p>
          <h1>聚会时间共识日历</h1>
        </div>

        <div className="topbar-actions" aria-label="日历操作">
          <button className="icon-text-button" type="button" onClick={copyShareLink}>
            <ClipboardCopy size={18} aria-hidden="true" />
            分享
          </button>
          <button className="icon-button" type="button" onClick={clearAvailability} title="清空标注">
            <RefreshCcw size={18} aria-hidden="true" />
          </button>
        </div>
      </header>

      <section className="workspace" aria-label="聚会时间规划">
        <aside className="side-panel">
          <section className="panel-section room-section">
            <div className="section-heading">
              <span>实时房间</span>
              {syncStatus === 'online' ? <Wifi size={18} aria-hidden="true" /> : <WifiOff size={18} aria-hidden="true" />}
            </div>

            <div className={`sync-pill is-${syncStatus}`}>
              <span />
              {syncCopy}
            </div>

            {roomId ? <code className="room-id">{roomId}</code> : null}

            <button className="room-button" type="button" onClick={createRealtimeRoom}>
              <Link2 size={17} aria-hidden="true" />
              新建实时房间
            </button>
          </section>

          <section className="panel-section identity-section">
            <div className="section-heading">
              <span>当前身份</span>
              <UsersRound size={18} aria-hidden="true" />
            </div>

            {activeParticipant ? (
              <div className="identity-editor">
                <label>
                  <span>名称</span>
                  <input
                    value={activeParticipant.name}
                    onChange={(event) =>
                      updateParticipant(activeParticipant.id, { name: event.target.value })
                    }
                  />
                </label>

                <label>
                  <span>颜色</span>
                  <input
                    className="color-input"
                    type="color"
                    value={activeParticipant.color}
                    onChange={(event) =>
                      updateParticipant(activeParticipant.id, { color: event.target.value })
                    }
                  />
                </label>

                <div className="swatch-row" aria-label="快速颜色">
                  {colorPalette.map((color) => (
                    <button
                      key={color}
                      className="swatch"
                      type="button"
                      style={{ '--swatch': color } as CSSProperties}
                      onClick={() => updateParticipant(activeParticipant.id, { color })}
                      title={color}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <p className="empty-copy">先添加一个参与者</p>
            )}
          </section>

          <section className="panel-section add-section">
            <div className="section-heading">
              <span>添加参与者</span>
              <Plus size={18} aria-hidden="true" />
            </div>
            <div className="add-form">
              <input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    addParticipant()
                  }
                }}
                placeholder="姓名"
              />
              <input
                className="color-input compact"
                type="color"
                value={newColor}
                onChange={(event) => setNewColor(event.target.value)}
                aria-label="参与者颜色"
              />
              <button className="icon-button add-button" type="button" onClick={addParticipant} title="添加">
                <Plus size={18} aria-hidden="true" />
              </button>
            </div>
          </section>

          <section className="panel-section people-section">
            <div className="section-heading">
              <span>参与者</span>
              <strong>{participantCount}</strong>
            </div>

            <div className="people-list">
              {planner.participants.map((participant) => (
                <div
                  className={`person-row ${
                    activeParticipantId === participant.id ? 'is-active' : ''
                  }`}
                  key={participant.id}
                >
                  <button
                    type="button"
                    className="person-select"
                    onClick={() => selectActiveParticipant(participant.id)}
                  >
                    <span
                      className="person-dot"
                      style={{ '--person-color': participant.color } as CSSProperties}
                    />
                    <span>{participant.name}</span>
                  </button>
                  <button
                    className="ghost-icon-button"
                    type="button"
                    onClick={() => removeParticipant(participant.id)}
                    title="移除参与者"
                    disabled={participantCount === 1}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="panel-section result-section">
            <div className="section-heading">
              <span>全员可聚会日</span>
              <CalendarCheck2 size={18} aria-hidden="true" />
            </div>

            <div className="result-number">{monthAvailableDates.length}</div>
            <div className="candidate-list">
              {leadingDates.length > 0 ? (
                leadingDates.map((item) => (
                  <button
                    type="button"
                    key={item.dateKey}
                    className={`candidate ${item.isConsensus ? 'is-consensus' : ''}`}
                    onClick={() => setVisibleMonth(fromDateKey(item.dateKey))}
                  >
                    <span>{formatHumanDate(item.dateKey)}</span>
                    <strong>
                      {item.count}/{participantCount}
                    </strong>
                  </button>
                ))
              ) : (
                <p className="empty-copy">暂无标注</p>
              )}
            </div>
          </section>

          {shareMessage ? <p className="share-message">{shareMessage}</p> : null}
        </aside>

        <section className="calendar-panel">
          <div className="calendar-toolbar">
            <div>
              <p className="eyebrow">Calendar</p>
              <h2>{monthLabel}</h2>
            </div>

            <div className="month-actions">
              <button className="icon-button" type="button" onClick={() => shiftMonth(-1)} title="上个月">
                <ChevronLeft size={20} aria-hidden="true" />
              </button>
              <button className="today-button" type="button" onClick={jumpToToday}>
                今天
              </button>
              <button className="icon-button" type="button" onClick={() => shiftMonth(1)} title="下个月">
                <ChevronRight size={20} aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="weekday-grid" aria-hidden="true">
            {weekdayLabels.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>

          <div className="calendar-grid">
            {calendarDays.map((day) => {
              const availablePeople = getAvailableParticipants(day.key)
              const availableIds = getAvailableIds(day.key)
              const isConsensus = isConsensusDate(day.key)
              const activeIsAvailable = activeParticipantId
                ? availableIds.includes(activeParticipantId)
                : false

              return (
                <button
                  type="button"
                  key={day.key}
                  className={[
                    'day-cell',
                    day.inMonth ? '' : 'is-muted',
                    day.key === todayKey ? 'is-today' : '',
                    activeIsAvailable ? 'is-selected' : '',
                    isConsensus ? 'is-consensus' : '',
                  ].join(' ')}
                  onClick={() => toggleAvailability(day.key)}
                  disabled={!activeParticipantId}
                  aria-pressed={activeIsAvailable}
                  aria-label={`${day.key}，${availableIds.length}/${participantCount} 人有空`}
                >
                  <span className="day-header">
                    <span>{day.date.getDate()}</span>
                    {day.key === todayKey ? <span className="today-mark">今</span> : null}
                  </span>

                  <span className="availability-bars">
                    {availablePeople.map((participant) => (
                      <span
                        key={participant.id}
                        className="availability-bar"
                        style={{ '--person-color': participant.color } as CSSProperties}
                        title={participant.name}
                      />
                    ))}
                  </span>

                  <span className="day-footer">
                    <span>
                      {availableIds.length}/{participantCount}
                    </span>
                    {isConsensus ? <strong>聚会日</strong> : null}
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      </section>
    </main>
  )
}

function getSyncCopy(syncStatus: SyncStatus, roomId: string) {
  if (!roomId) {
    return isSupabaseConfigured ? '本地草稿，创建房间后实时同步' : '本地模式，未配置 Supabase'
  }

  if (syncStatus === 'online') {
    return '实时同步中'
  }

  if (syncStatus === 'connecting') {
    return '正在连接房间'
  }

  if (syncStatus === 'needs-config') {
    return '缺少 Supabase 配置'
  }

  if (syncStatus === 'offline') {
    return '同步异常，先保存在本机'
  }

  return '本地模式'
}

function formatHumanDate(dateKey: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  }).format(fromDateKey(dateKey))
}

export default App
