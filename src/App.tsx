import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  CalendarCheck2,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Link2,
  Plus,
  RefreshCcw,
  Share2,
  Trash2,
  UsersRound,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { isSupabaseConfigured, supabase } from './supabaseClient'
import './App.css'

type Participant = {
  id: string
  name: string
  color: string
  keyHash?: string
}

type Availability = Record<string, string[]>

type PlannerState = {
  version?: number
  adminKeyHash?: string
  participants: Participant[]
  availability: Availability
}

type RoomCredentials = {
  id: string
  key: string
  adminKey?: string
}

type RoomBroadcastPayload = {
  state?: unknown
  dissolved?: boolean
}

type CalendarDay = {
  date: Date
  key: string
  inMonth: boolean
}

type SyncStatus =
  | 'local'
  | 'needs-config'
  | 'missing-key'
  | 'connecting'
  | 'online'
  | 'offline'
  | 'not-found'
  | 'dissolved'

const STORAGE_KEY = 'when-we-free-state-v1'
const ROOM_CACHE_PREFIX = 'when-we-free-room-state-v1:'
const ROOM_PENDING_SYNC_PREFIX = 'when-we-free-room-pending-sync-v1:'
const PARTICIPANT_KEYS_PREFIX = 'when-we-free-participant-keys-v1:'
const SELECTED_BY_ROOM_KEY = 'when-we-free-selected-participant-v1'
const SECURED_STATE_VERSION = 2

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

function createHexToken(byteLength: number) {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function createRoomId() {
  return createHexToken(16)
}

function createRoomKey() {
  return createHexToken(32)
}

function createAdminKey() {
  return createHexToken(32)
}

function createParticipantKey() {
  return createHexToken(32)
}

function isHex(value: string | undefined, length: number) {
  return Boolean(value && new RegExp(`^[0-9a-f]{${length}}$`).test(value))
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
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
      keyHash: isHex(participant.keyHash, 64) ? participant.keyHash : undefined,
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

  return {
    version: candidate.version === SECURED_STATE_VERSION ? SECURED_STATE_VERSION : undefined,
    adminKeyHash: isHex(candidate.adminKeyHash, 64) ? candidate.adminKeyHash : undefined,
    participants,
    availability,
  }
}

function readHashParam(name: string) {
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  return hashParams.get(name)
}

function readRoomId() {
  return readHashParam('room')?.trim() || ''
}

function readRoomKey() {
  return readHashParam('key')?.trim() || ''
}

function readAdminKey() {
  return readHashParam('adminKey')?.trim() || ''
}

function readParticipantId() {
  return readHashParam('participant')?.trim() || ''
}

function readParticipantKey() {
  return readHashParam('participantKey')?.trim() || ''
}

function getRoomHash(
  roomId: string,
  roomKey: string,
  options: {
    adminKey?: string
    participantId?: string
    participantKey?: string
  } = {},
) {
  const params = new URLSearchParams({ room: roomId, key: roomKey })

  if (options.adminKey) {
    params.set('adminKey', options.adminKey)
  }

  if (options.participantId && options.participantKey) {
    params.set('participant', options.participantId)
    params.set('participantKey', options.participantKey)
  }

  return params.toString()
}

function setRoomHash(roomId: string, roomKey: string, options: Parameters<typeof getRoomHash>[2] = {}) {
  window.history.replaceState(null, '', `#${getRoomHash(roomId, roomKey, options)}`)
}

function getRoomSpaceKey(roomId: string, roomKey: string) {
  if (!roomId) {
    return 'local'
  }

  return roomKey ? `${roomId}:${roomKey}` : roomId
}

function getPlannerCacheKey(roomId: string, roomKey: string) {
  return roomId ? `${ROOM_CACHE_PREFIX}${getRoomSpaceKey(roomId, roomKey)}` : STORAGE_KEY
}

function getRoomPendingSyncKey(roomId: string, roomKey: string) {
  return `${ROOM_PENDING_SYNC_PREFIX}${getRoomSpaceKey(roomId, roomKey)}`
}

function getParticipantKeysStorageKey(roomId: string, roomKey: string) {
  return `${PARTICIPANT_KEYS_PREFIX}${getRoomSpaceKey(roomId, roomKey)}`
}

function readParticipantKeys(roomId: string, roomKey: string) {
  if (!roomId || !roomKey) {
    return {}
  }

  return readJson<Record<string, string>>(getParticipantKeysStorageKey(roomId, roomKey), {})
}

function writeParticipantKeys(roomId: string, roomKey: string, keys: Record<string, string>) {
  if (!roomId || !roomKey) {
    return
  }

  window.localStorage.setItem(getParticipantKeysStorageKey(roomId, roomKey), JSON.stringify(keys))
}

function storeParticipantKey(roomId: string, roomKey: string, participantId: string, participantKey: string) {
  const keys = readParticipantKeys(roomId, roomKey)
  keys[participantId] = participantKey
  writeParticipantKeys(roomId, roomKey, keys)
}

function getStoredParticipantKey(roomId: string, roomKey: string, participantId: string) {
  const key = readParticipantKeys(roomId, roomKey)[participantId]
  return isHex(key, 64) ? key : ''
}

function isRoomDissolvedError(error: { message?: string } | null | undefined) {
  return Boolean(error?.message?.toLowerCase().includes('dissolved'))
}

function isMissingRpcFunctionError(error: { message?: string } | null | undefined) {
  const message = error?.message?.toLowerCase() ?? ''
  return message.includes('could not find the function') || message.includes('schema cache')
}

function hasPendingRoomSync(roomId: string, roomKey: string) {
  return Boolean(
    roomId && roomKey && window.localStorage.getItem(getRoomPendingSyncKey(roomId, roomKey)),
  )
}

function markRoomPendingSync(roomId: string, roomKey: string) {
  if (!roomId || !roomKey) {
    return
  }

  window.localStorage.setItem(getRoomPendingSyncKey(roomId, roomKey), String(Date.now()))
}

function clearRoomPendingSync(roomId: string, roomKey: string) {
  if (!roomId || !roomKey) {
    return
  }

  window.localStorage.removeItem(getRoomPendingSyncKey(roomId, roomKey))
}

async function securePlannerStateForRoom(
  state: PlannerState,
  roomId: string,
  roomKey: string,
  adminKey: string,
) {
  const participantKeys = readParticipantKeys(roomId, roomKey)
  const participants = await Promise.all(
    state.participants.map(async (participant) => {
      const participantKey = participantKeys[participant.id] || createParticipantKey()
      participantKeys[participant.id] = participantKey

      return {
        ...participant,
        keyHash: await hashToken(participantKey),
      }
    }),
  )

  writeParticipantKeys(roomId, roomKey, participantKeys)

  return {
    ...state,
    version: SECURED_STATE_VERSION,
    adminKeyHash: await hashToken(adminKey),
    participants,
  }
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

function readInitialState(roomId: string, roomKey: string) {
  const sharedState = readHashParam('state')

  if (sharedState) {
    const decoded = decodeState(sharedState)
    if (decoded) {
      return decoded
    }
  }

  if (roomId) {
    const cachedState = sanitizeState(readJson(getPlannerCacheKey(roomId, roomKey), null))
    if (cachedState) {
      return cachedState
    }
  }

  const storedState = sanitizeState(readJson(STORAGE_KEY, null))
  return storedState ?? starterState
}

function App() {
  const [roomId, setRoomId] = useState(readRoomId)
  const [roomKey, setRoomKey] = useState(readRoomKey)
  const [adminKey, setAdminKey] = useState(readAdminKey)
  const [participantId, setParticipantId] = useState(readParticipantId)
  const [participantKey, setParticipantKey] = useState(readParticipantKey)
  const [planner, setPlanner] = useState<PlannerState>(() =>
    readInitialState(readRoomId(), readRoomKey()),
  )
  const [selectedParticipantByRoom, setSelectedParticipantByRoom] = useState<Record<string, string>>(
    () => readJson(SELECTED_BY_ROOM_KEY, {}),
  )
  const [visibleMonth, setVisibleMonth] = useState(() => new Date())
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(colorPalette[1])
  const [shareMessage, setShareMessage] = useState('')
  const [syncRetryToken, setSyncRetryToken] = useState(0)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(() => {
    if (roomId && isSupabaseConfigured) {
      return roomKey ? 'connecting' : 'missing-key'
    }

    return roomId ? 'needs-config' : 'local'
  })

  const plannerRef = useRef(planner)
  const remoteReadyRef = useRef(false)
  const skipRemoteSaveRef = useRef(false)
  const roomChannelRef = useRef<ReturnType<NonNullable<typeof supabase>['channel']> | null>(null)

  const participantCount = planner.participants.length
  const spaceKey = getRoomSpaceKey(roomId, roomKey)
  const hasAdminCredentials = Boolean(roomId && roomKey && adminKey)
  const hasParticipantCredentials = Boolean(roomId && roomKey && participantId && participantKey)
  const lockedParticipantId = hasParticipantCredentials && !hasAdminCredentials ? participantId : ''
  const canManageParticipants = !roomId || hasAdminCredentials
  const canShareParticipantLinks = Boolean(roomId && roomKey && hasAdminCredentials)
  const hasRemoteWriteAccess = Boolean(hasAdminCredentials || hasParticipantCredentials)
  const selectedParticipantId = selectedParticipantByRoom[spaceKey]
  const activeParticipant =
    planner.participants.find((participant) => participant.id === lockedParticipantId) ??
    planner.participants.find((participant) => participant.id === selectedParticipantId) ??
    planner.participants[0]
  const activeParticipantId = activeParticipant?.id ?? ''
  const canEditActiveParticipant =
    !roomId ||
    hasAdminCredentials ||
    Boolean(hasParticipantCredentials && participantId === activeParticipantId)
  const accessCopy = getAccessCopy({
    roomId,
    hasAdminCredentials,
    hasParticipantCredentials,
    canEditActiveParticipant,
  })

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

  const getRoomSaveArgs = useCallback(
    (roomState: PlannerState) => {
      if (!roomId || !roomKey) {
        return null
      }

      const baseArgs = {
        room_id: roomId,
        room_key: roomKey,
        room_state: roomState,
        admin_key: null as string | null,
        participant_id: null as string | null,
        participant_key: null as string | null,
      }

      if (adminKey) {
        return {
          ...baseArgs,
          admin_key: adminKey,
        }
      }

      if (participantId && participantKey) {
        return {
          ...baseArgs,
          participant_id: participantId,
          participant_key: participantKey,
        }
      }

      return null
    },
    [adminKey, participantId, participantKey, roomId, roomKey],
  )

  const saveRoomState = useCallback(async (saveArgs: NonNullable<ReturnType<typeof getRoomSaveArgs>>) => {
    if (!supabase) {
      return { error: new Error('Supabase 未配置') }
    }

    const { error } = await supabase.rpc('save_when_we_free_room', saveArgs)

    if (!error || !isMissingRpcFunctionError(error)) {
      return { error }
    }

    return supabase.rpc('save_when_we_free_room', {
      room_id: saveArgs.room_id,
      room_key: saveArgs.room_key,
      room_state: saveArgs.room_state,
    })
  }, [])

  useEffect(() => {
    plannerRef.current = planner
  }, [planner])

  useEffect(() => {
    const handler = () => {
      const nextRoomId = readRoomId()
      const nextRoomKey = readRoomKey()
      const nextAdminKey = readAdminKey()
      const nextParticipantId = readParticipantId()
      const nextParticipantKey = readParticipantKey()
      setRoomId(nextRoomId)
      setRoomKey(nextRoomKey)
      setAdminKey(nextAdminKey)
      setParticipantId(nextParticipantId)
      setParticipantKey(nextParticipantKey)
      setPlanner(readInitialState(nextRoomId, nextRoomKey))
    }

    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [])

  useEffect(() => {
    const cacheKey = getPlannerCacheKey(roomId, roomKey)
    window.localStorage.setItem(cacheKey, JSON.stringify(planner))
  }, [planner, roomId, roomKey])

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

      if (!roomKey) {
        if (!cancelled) {
          setShareMessage('房间链接缺少访问密钥，请重新创建或复制完整链接')
          setSyncStatus('missing-key')
        }
        return
      }

      setSyncStatus('connecting')
      const hasLocalPendingChanges = hasPendingRoomSync(roomId, roomKey)

      const { data, error } = await supabase.rpc('get_when_we_free_room', {
        room_id: roomId,
        room_key: roomKey,
      })

      if (cancelled) {
        return
      }

      if (error) {
        if (isRoomDissolvedError(error)) {
          setShareMessage('房间已被创建者解散')
          setSyncStatus('dissolved')
          return
        }

        setShareMessage(`连接房间失败：${error.message}。已保存在本机`)
        setSyncStatus('offline')
        return
      }

      if (data && !hasLocalPendingChanges) {
        const remoteState = sanitizeState(data)
        if (remoteState) {
          skipRemoteSaveRef.current = true
          setPlanner(remoteState)
          clearRoomPendingSync(roomId, roomKey)
        }
      } else {
        const saveArgs = getRoomSaveArgs(plannerRef.current)

        if (!saveArgs) {
          setShareMessage(data ? '当前链接只能查看房间，不能保存修改' : '房间不存在或链接已失效')
          setSyncStatus(data ? 'online' : 'not-found')
          return
        }

        const { error: insertError } = await saveRoomState(saveArgs)

        if (insertError) {
          if (isRoomDissolvedError(insertError)) {
            clearRoomPendingSync(roomId, roomKey)
            setShareMessage('房间已被创建者解散')
            setSyncStatus('dissolved')
            return
          }

          markRoomPendingSync(roomId, roomKey)
          setShareMessage(`同步房间失败：${insertError.message}。已保存在本机`)
          setSyncStatus('offline')
          return
        }

        clearRoomPendingSync(roomId, roomKey)
      }

      remoteReadyRef.current = true
      setSyncStatus('online')
    }

    void connectRoom()

    const client = supabase

    if (!roomId || !roomKey || !client) {
      return () => {
        cancelled = true
      }
    }

    const channel = client
      .channel(`when-we-free-${roomId}-${roomKey}`, {
        config: {
          broadcast: {
            self: false,
          },
        },
      })
      .on(
        'broadcast',
        {
          event: 'planner',
        },
        ({ payload }) => {
          if ((payload as RoomBroadcastPayload).dissolved) {
            clearRoomPendingSync(roomId, roomKey)
            remoteReadyRef.current = false
            setShareMessage('房间已被创建者解散')
            setSyncStatus('dissolved')
            return
          }

          if (hasPendingRoomSync(roomId, roomKey)) {
            return
          }

          const remoteState = sanitizeState((payload as RoomBroadcastPayload).state)
          if (!remoteState) {
            return
          }

          skipRemoteSaveRef.current = true
          setPlanner(remoteState)
          clearRoomPendingSync(roomId, roomKey)
          setSyncStatus('online')
        },
      )
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setSyncStatus('offline')
        }
      })

    roomChannelRef.current = channel

    return () => {
      cancelled = true
      if (roomChannelRef.current === channel) {
        roomChannelRef.current = null
      }
      void client.removeChannel(channel)
    }
  }, [getRoomSaveArgs, roomId, roomKey, saveRoomState, syncRetryToken])

  useEffect(() => {
    if (syncStatus !== 'offline' || !roomId || !roomKey || !supabase) {
      return
    }

    const retryTimer = window.setTimeout(() => {
      setSyncRetryToken((current) => current + 1)
    }, 8000)

    return () => window.clearTimeout(retryTimer)
  }, [roomId, roomKey, syncStatus])

  useEffect(() => {
    const client = supabase

    if (
      !roomId ||
      !roomKey ||
      !client ||
      !hasRemoteWriteAccess ||
      syncStatus !== 'online' ||
      !remoteReadyRef.current
    ) {
      return
    }

    if (skipRemoteSaveRef.current) {
      skipRemoteSaveRef.current = false
      return
    }

    const saveTimer = window.setTimeout(async () => {
      const saveArgs = getRoomSaveArgs(planner)

      if (!saveArgs) {
        return
      }

      const { error } = await saveRoomState(saveArgs)

      if (error) {
        if (isRoomDissolvedError(error)) {
          clearRoomPendingSync(roomId, roomKey)
          setShareMessage('房间已被创建者解散')
          setSyncStatus('dissolved')
          return
        }

        markRoomPendingSync(roomId, roomKey)
        setShareMessage(`同步失败：${error.message}。已保存在本机`)
        setSyncStatus('offline')
        return
      }

      clearRoomPendingSync(roomId, roomKey)

      const channel = roomChannelRef.current
      if (channel) {
        void channel.send({
          type: 'broadcast',
          event: 'planner',
          payload: { state: planner },
        })
      }
    }, 220)

    return () => window.clearTimeout(saveTimer)
  }, [getRoomSaveArgs, hasRemoteWriteAccess, planner, roomId, roomKey, saveRoomState, syncStatus])

  function updatePlannerLocally(updater: (current: PlannerState) => PlannerState) {
    if (syncStatus === 'dissolved') {
      setShareMessage('房间已解散，不能继续编辑')
      return
    }

    if (roomId && !hasRemoteWriteAccess) {
      setShareMessage('当前链接只能查看房间，不能编辑')
      return
    }

    markRoomPendingSync(roomId, roomKey)
    setPlanner(updater)
  }

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
    if (lockedParticipantId && id !== lockedParticipantId) {
      return
    }

    setSelectedParticipantByRoom((current) => ({
      ...current,
      [spaceKey]: id,
    }))
  }

  async function addParticipant() {
    if (!canManageParticipants) {
      setShareMessage('只有房间创建者可以添加参与者')
      return
    }

    const participantKeyForRoom = roomId && roomKey ? createParticipantKey() : ''
    const participant: Participant = {
      id: createId(),
      name: newName.trim() || `参与者 ${participantCount + 1}`,
      color: newColor,
      keyHash: participantKeyForRoom ? await hashToken(participantKeyForRoom) : undefined,
    }

    if (participantKeyForRoom) {
      storeParticipantKey(roomId, roomKey, participant.id, participantKeyForRoom)
    }

    updatePlannerLocally((current) => ({
      ...current,
      version: roomId ? SECURED_STATE_VERSION : current.version,
      participants: [...current.participants, participant],
    }))
    selectActiveParticipant(participant.id)
    setNewName('')
    setNewColor(colorPalette[(participantCount + 2) % colorPalette.length])
  }

  function updateParticipant(id: string, patch: Partial<Participant>) {
    if (!canManageParticipants && id !== participantId) {
      setShareMessage('只能编辑自己的身份信息')
      return
    }

    if (!canEditActiveParticipant && id === activeParticipantId) {
      setShareMessage('当前链接只能查看房间，不能编辑')
      return
    }

    updatePlannerLocally((current) => ({
      ...current,
      participants: current.participants.map((participant) =>
        participant.id === id ? { ...participant, ...patch } : participant,
      ),
    }))
  }

  function removeParticipant(id: string) {
    if (!canManageParticipants) {
      setShareMessage('只有房间创建者可以移除参与者')
      return
    }

    updatePlannerLocally((current) => {
      const participants = current.participants.filter((participant) => participant.id !== id)
      const availability = Object.fromEntries(
        Object.entries(current.availability)
          .map(([dateKey, ids]) => [dateKey, ids.filter((availableId) => availableId !== id)])
          .filter(([, ids]) => ids.length > 0),
      ) as Availability

      return {
        ...current,
        participants,
        availability,
      }
    })
  }

  function toggleAvailability(dateKey: string) {
    if (!activeParticipantId || !canEditActiveParticipant) {
      if (roomId) {
        setShareMessage('当前链接只能查看房间，不能编辑这个身份')
      }
      return
    }

    updatePlannerLocally((current) => {
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

  async function saveRoomAsAdmin(roomCredentials: Required<RoomCredentials>, roomState: PlannerState) {
    if (!supabase) {
      throw new Error('Supabase 未配置')
    }

    const { error } = await saveRoomState({
      room_id: roomCredentials.id,
      room_key: roomCredentials.key,
      room_state: roomState,
      admin_key: roomCredentials.adminKey,
      participant_id: null,
      participant_key: null,
    })

    if (error) {
      throw new Error(error.message)
    }

    clearRoomPendingSync(roomCredentials.id, roomCredentials.key)
  }

  async function ensureRoom(): Promise<RoomCredentials> {
    if (roomId && roomKey) {
      if (adminKey) {
        await saveRoomAsAdmin({ id: roomId, key: roomKey, adminKey }, plannerRef.current)
      }

      return { id: roomId, key: roomKey, adminKey }
    }

    const nextRoomId = createRoomId()
    const nextRoomKey = createRoomKey()
    const nextAdminKey = createAdminKey()
    const securedPlanner = await securePlannerStateForRoom(
      plannerRef.current,
      nextRoomId,
      nextRoomKey,
      nextAdminKey,
    )

    try {
      await saveRoomAsAdmin(
        { id: nextRoomId, key: nextRoomKey, adminKey: nextAdminKey },
        securedPlanner,
      )
    } catch (error) {
      setShareMessage(`创建房间失败：${error instanceof Error ? error.message : String(error)}`)
      throw error
    }

    setRoomHash(nextRoomId, nextRoomKey, { adminKey: nextAdminKey })
    setRoomId(nextRoomId)
    setRoomKey(nextRoomKey)
    setAdminKey(nextAdminKey)
    setParticipantId('')
    setParticipantKey('')
    setPlanner(securedPlanner)

    return { id: nextRoomId, key: nextRoomKey, adminKey: nextAdminKey }
  }

  async function createRealtimeRoom() {
    if (!isSupabaseConfigured) {
      setShareMessage('先配置 Supabase 后才能创建实时房间')
      return
    }

    const nextRoomId = createRoomId()
    const nextRoomKey = createRoomKey()
    const nextAdminKey = createAdminKey()
    const securedPlanner = await securePlannerStateForRoom(
      plannerRef.current,
      nextRoomId,
      nextRoomKey,
      nextAdminKey,
    )

    try {
      await saveRoomAsAdmin(
        { id: nextRoomId, key: nextRoomKey, adminKey: nextAdminKey },
        securedPlanner,
      )
    } catch (error) {
      setShareMessage(`创建房间失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }

    setRoomHash(nextRoomId, nextRoomKey, { adminKey: nextAdminKey })
    setRoomId(nextRoomId)
    setRoomKey(nextRoomKey)
    setAdminKey(nextAdminKey)
    setParticipantId('')
    setParticipantKey('')
    setPlanner(securedPlanner)
    setShareMessage('已创建实时房间，现在可以为每个参与者复制专属链接')
  }

  async function copyShareLink() {
    if (isSupabaseConfigured) {
      let credentials: RoomCredentials

      try {
        credentials = await ensureRoom()
      } catch {
        return
      }

      const shareUrl = `${window.location.origin}${window.location.pathname}#${getRoomHash(
        credentials.id,
        credentials.key,
      )}`

      try {
        await navigator.clipboard.writeText(shareUrl)
        setShareMessage('已复制只读房间链接')
      } catch {
        setShareMessage('只读房间链接已放入地址栏')
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

  async function copyParticipantLink(participant: Participant) {
    if (!canShareParticipantLinks) {
      setShareMessage('只有房间创建者可以复制参与者链接')
      return
    }

    let editKey = getStoredParticipantKey(roomId, roomKey, participant.id)

    if (!editKey) {
      editKey = createParticipantKey()
      const nextKeyHash = await hashToken(editKey)
      storeParticipantKey(roomId, roomKey, participant.id, editKey)
      updatePlannerLocally((current) => ({
        ...current,
        participants: current.participants.map((currentParticipant) =>
          currentParticipant.id === participant.id
            ? { ...currentParticipant, keyHash: nextKeyHash }
            : currentParticipant,
        ),
      }))
    }

    const shareUrl = `${window.location.origin}${window.location.pathname}#${getRoomHash(
      roomId,
      roomKey,
      {
        participantId: participant.id,
        participantKey: editKey,
      },
    )}`

    try {
      await navigator.clipboard.writeText(shareUrl)
      setShareMessage(`已复制 ${participant.name} 的专属编辑链接`)
    } catch {
      setShareMessage(`${participant.name} 的专属编辑链接已生成`)
    }
  }

  async function dissolveRoom() {
    if (!roomId || !roomKey || !adminKey || !supabase) {
      setShareMessage('只有房间创建者可以解散房间')
      return
    }

    const confirmed = window.confirm('解散后所有房间链接都会失效，且不能继续同步。确定解散这个房间吗？')
    if (!confirmed) {
      return
    }

    const { error } = await supabase.rpc('dissolve_when_we_free_room', {
      room_id: roomId,
      room_key: roomKey,
      admin_key: adminKey,
    })

    if (error && !isRoomDissolvedError(error)) {
      setShareMessage(`解散房间失败：${error.message}`)
      return
    }

    clearRoomPendingSync(roomId, roomKey)
    remoteReadyRef.current = false
    setSyncStatus('dissolved')
    setShareMessage('房间已解散，所有分享链接已失效')

    const channel = roomChannelRef.current
    if (channel) {
      void channel.send({
        type: 'broadcast',
        event: 'planner',
        payload: { dissolved: true },
      })
    }
  }

  function clearAvailability() {
    if (!canEditActiveParticipant) {
      setShareMessage('当前链接只能查看房间，不能清空标注')
      return
    }

    if (roomId && !hasAdminCredentials) {
      updatePlannerLocally((current) => {
        const availability = Object.fromEntries(
          Object.entries(current.availability)
            .map(([dateKey, ids]) => [
              dateKey,
              ids.filter((availableId) => availableId !== activeParticipantId),
            ])
            .filter(([, ids]) => ids.length > 0),
        ) as Availability

        return { ...current, availability }
      })
      return
    }

    updatePlannerLocally((current) => ({ ...current, availability: {} }))
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
          <button
            className="icon-button"
            type="button"
            onClick={clearAvailability}
            title={roomId && !hasAdminCredentials ? '清空当前身份标注' : '清空标注'}
          >
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
            {roomId ? <p className="access-copy">{accessCopy}</p> : null}

            <button className="room-button" type="button" onClick={() => void createRealtimeRoom()}>
              <Link2 size={17} aria-hidden="true" />
              新建实时房间
            </button>
            {hasAdminCredentials ? (
              <button
                className="room-button danger"
                type="button"
                onClick={() => void dissolveRoom()}
                disabled={syncStatus === 'dissolved'}
              >
                <Trash2 size={17} aria-hidden="true" />
                解散房间
              </button>
            ) : null}
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
                    disabled={!canEditActiveParticipant}
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
                    disabled={!canEditActiveParticipant}
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
                      disabled={!canEditActiveParticipant}
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
                    void addParticipant()
                  }
                }}
                placeholder="姓名"
                disabled={!canManageParticipants}
              />
              <input
                className="color-input compact"
                type="color"
                value={newColor}
                onChange={(event) => setNewColor(event.target.value)}
                aria-label="参与者颜色"
                disabled={!canManageParticipants}
              />
              <button
                className="icon-button add-button"
                type="button"
                onClick={() => void addParticipant()}
                title="添加"
                disabled={!canManageParticipants}
              >
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
                    disabled={Boolean(lockedParticipantId && lockedParticipantId !== participant.id)}
                  >
                    <span
                      className="person-dot"
                      style={{ '--person-color': participant.color } as CSSProperties}
                    />
                    <span>{participant.name}</span>
                  </button>
                  {canShareParticipantLinks ? (
                    <button
                      className="ghost-icon-button"
                      type="button"
                      onClick={() => void copyParticipantLink(participant)}
                      title={`复制 ${participant.name} 的专属编辑链接`}
                    >
                      <Share2 size={16} aria-hidden="true" />
                    </button>
                  ) : null}
                  <button
                    className="ghost-icon-button"
                    type="button"
                    onClick={() => removeParticipant(participant.id)}
                    title="移除参与者"
                    disabled={participantCount === 1 || !canManageParticipants}
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
                  disabled={!activeParticipantId || !canEditActiveParticipant}
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

  if (syncStatus === 'missing-key') {
    return '房间链接缺少密钥'
  }

  if (syncStatus === 'offline') {
    return '同步异常，先保存在本机'
  }

  if (syncStatus === 'not-found') {
    return '房间不存在或链接已失效'
  }

  if (syncStatus === 'dissolved') {
    return '房间已解散'
  }

  return '本地模式'
}

function getAccessCopy({
  roomId,
  hasAdminCredentials,
  hasParticipantCredentials,
  canEditActiveParticipant,
}: {
  roomId: string
  hasAdminCredentials: boolean
  hasParticipantCredentials: boolean
  canEditActiveParticipant: boolean
}) {
  if (!roomId) {
    return '本地编辑'
  }

  if (hasAdminCredentials) {
    return '房间创建者：可管理参与者、复制专属链接和解散房间'
  }

  if (hasParticipantCredentials && canEditActiveParticipant) {
    return '专属编辑链接：只能修改自己的时间'
  }

  return '只读链接：不能修改房间'
}

function formatHumanDate(dateKey: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  }).format(fromDateKey(dateKey))
}

export default App
