/**
 * 作答备注 —— **注解**，不是作答本身。
 *
 * ═══ 它是什么 ═══
 * "我当时为什么选 C""事后回头看，这题我错在把'主旨'读成了'细节'"——
 * 这类东西**只存在于写的那一刻**：事后再问，人给的已经是重构过的解释，
 * 而不是当时的想法（与 `cancel_schedule` 的 reason 同一条纪律：
 * 撤销原因只在撤销那一刻知道）。
 *
 * ═══ 为什么它是**资源**而不是作答的一个字段 ═══
 * ADR-009：**注解是一等资源**（批判 / 补充 / 反驳，带 target 指针）。
 * 理由在这里同样成立：
 *   · 一条作答可以有很多条备注（先记思路、事后补反思、过一周再补一句）；
 *   · 备注可以**修正**（编辑 = 新备注 + `supersedes` 指针，与资源更新同一条）；
 *   · 备注自己也可以被引用（将来的断言器要读它，说明"这条判断依据是哪几句反思"）。
 * 把它塞进作答事件的 `data.note` 字段，上面三件事一件都做不到。
 *
 * ═══ 锚点必须是**某一次作答**（而不是某一道题）═══
 * 同一道题做多次是常态（实测有一题做了 4 次）。只挂到题上，第二次的思路会覆盖第一次，
 * 而"上次错在哪、这次想对了什么"恰恰是最有价值的那条线。所以 `target_kind`
 * 默认是 `attempt`，值取**作答事件的 id**（事件有稳定 id）。
 * `target_kind: 'question'`（挂到题、跨次累积）**留着位置但不做界面**——
 * 作者 2026-10-13 明确"先只做作答级"。
 *
 * ═══ 谁写的必须记下来 ═══
 * 人写的反思与模型写的推理**不是一类东西**（与作答的 `source`/`model` 同源）。
 * `author` 只有 user / agent 两个值；`author: agent` 时带 `model`。
 * 否则将来分不清"这是我当时的想法"还是"模型编的"。
 */

import { LhEventStore } from '@lh/event-store/store'

/** 备注事件的类型。`lh/resource/*` 表示"可寻址的产物"（ADR-009 把注解归在这里）。 */
export const NOTE_EVENT_TYPE = 'lh/resource/note-made'

/** 备注锚在哪：某一次作答 / 某一道题（后者留位置不做界面）。 */
export const NOTE_TARGET_KINDS = ['attempt', 'question']

/** 备注的种类。两种用途它在教学上完全不同：
 *  · `reasoning` = 答题时的思路（写在做之前/之中，带得上"我为什么排除 B"）
 *  · `reflection` = 做后的反思（写在做之后，带得上"下次我该注意什么"）
 * 界面分两格，而不是混成一段文本——混在一起后**没法只读思路或只读反思**。 */
export const NOTE_KINDS = ['reasoning', 'reflection']

/** 谁写的。 */
export const NOTE_AUTHORS = ['user', 'agent']

/** 单条备注正文的长度上限（内嵌在事件里，不走 content_ref）。 */
export const NOTE_MAX_CHARS = 2000

/**
 * 组装一条备注的语义负载（**纯函数**，不碰存储）。
 *
 * @param params.targetKind - `attempt` / `question`。
 * @param params.targetId - 目标 id（attempt = 作答事件 id；question = 题目 id）。
 * @param params.text - 正文。
 * @param params.author - `user` / `agent`。
 * @param params.model - 模型型号（`author: agent` 时建议填）。
 * @param params.noteKind - `reasoning` / `reflection`。
 * @param params.questionId - 题目 id（便于不 join 也能定位；可空）。
 * @param params.supersedes - 被本条取代的旧备注事件 id（编辑时给）。
 * @returns 可直接交给 `store.appendResource` 的 `data`（不含信封）。
 * @throws 当必填字段缺失或超长时。
 */
export function buildNote({ targetKind, targetId, text, author = 'user', model, noteKind = 'reflection', questionId, supersedes }) {
  const kind = NOTE_TARGET_KINDS.includes(targetKind) ? targetKind : null
  if (kind === null) {
    throw new Error(`buildNote: target_kind 非法（${targetKind}），只接受 ${NOTE_TARGET_KINDS.join(' / ')}`)
  }
  const id = typeof targetId === 'string' ? targetId.trim() : ''
  if (id === '') throw new Error('buildNote: target_id 必填（作答事件的 id 或题目 id）')

  const body = typeof text === 'string' ? text.trim() : ''
  if (body === '') {
    // 空备注**不写**：一条空记录只会让"这里有没有东西"变成噪声，而它本来一眼可见
    throw new Error('buildNote: text 不能为空（不想写就不写，不必记一条空的）')
  }
  if (body.length > NOTE_MAX_CHARS) {
    throw new Error(`buildNote: text 超长（${body.length} > ${NOTE_MAX_CHARS} 字）——这么长请拆成多条，或另存为资源文件`)
  }
  if (!NOTE_AUTHORS.includes(author)) {
    throw new Error(`buildNote: author 非法（${author}），只接受 ${NOTE_AUTHORS.join(' / ')}`)
  }
  if (!NOTE_KINDS.includes(noteKind)) {
    throw new Error(`buildNote: note_kind 非法（${noteKind}），只接受 ${NOTE_KINDS.join(' / ')}`)
  }

  return {
    target_kind: kind,
    target_id: id,
    // 题目 id 单列一份：不 join 也能回答"这条备注是关于哪道题的"
    question_id: typeof questionId === 'string' && questionId.trim() !== '' ? questionId.trim() : null,
    text: body,
    note_kind: noteKind,
    author,
    // 人写的备注没有型号（显式 null，不省略——与作答同一条读取纪律）
    model: typeof model === 'string' && model.trim() !== '' ? model.trim() : null,
    supersedes: Array.isArray(supersedes) ? supersedes : supersedes === undefined || supersedes === null ? [] : [supersedes],
  }
}

/**
 * 写一条备注（**唯一的写入路径**：agent 工具与面板的 POST 路由都走这里）。
 *
 * @param params.store - LH 事件存储（`new LhEventStore()` 或 `ctx.lhEvents`）。
 * @param params.sessionRef - 当时的会话 id（可空：面板写的时候没有会话上下文）。
 * @param params.provenance - 产出它的插件 id + 版本。
 * @param 其余见 `buildNote`。
 * @returns 写入的事件。
 */
export function recordNote({ store, sessionRef, provenance, targetKind, targetId, text, author, model, noteKind, questionId, supersedes }) {
  const data = buildNote({ targetKind, targetId, text, author, model, noteKind, questionId, supersedes })
  const event = store.appendResource({
    // actor 取 author：这条备注**是谁写的**是最重要的语义（同作答的 source）
    actor: data.author,
    type: NOTE_EVENT_TYPE,
    provenance,
    scope: 'root',
    sessionRef,
    data,
    // ⚠ `supersedes` 必须走**这个参数**，不能只塞在 `data` 里：
    //   `appendResource` 会用 `supersedes ?? []` **覆盖** `data.supersedes`，
    //   所以塞在 data 里的指针会被静默清空（2026-10-13 自测当场抓到：
    //   旧的备注没被标成 superseded_by，编辑看起来"没生效"）。
    //   这其实是对的——资源指针由存储层构造，插件不该自己拼（ADR-009 的同一条）。
    supersedes: data.supersedes,
  })
  return { event, data }
}

/**
 * 从事件里取出备注，并把 `supersedes` 关系解开。
 *
 * 读取端拿到的是**当前有效**的那一份（被取代的标 `superseded_by`，默认不显示，
 * 但**不丢**——"我当时写的原话"本身是证据，与 ADR-009 的更新语义一致）。
 *
 * @param events - LH 全量事件。
 * @returns `{ notes, malformed }`；notes 按时间正序。
 */
export function extractNotes(events) {
  const notes = []
  const malformed = []
  const supersededBy = new Map()

  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== NOTE_EVENT_TYPE) continue
    const d = event?.data
    if (typeof d?.target_id !== 'string' || d.target_id === '') {
      malformed.push({ event_id: event.id ?? null, reason: '缺 target_id' })
      continue
    }
    if (typeof d?.text !== 'string' || d.text.trim() === '') {
      malformed.push({ event_id: event.id ?? null, reason: '缺 text' })
      continue
    }
    if (!NOTE_AUTHORS.includes(d?.author)) {
      malformed.push({ event_id: event.id ?? null, reason: `author 非法：${JSON.stringify(d?.author)}` })
      continue
    }
    const supersedes = Array.isArray(d?.supersedes) ? d.supersedes : []
    for (const old of supersedes) supersededBy.set(String(old), event.id ?? null)
    notes.push({
      event_id: event.id ?? null,
      created_at: event.timestamp ?? null,
      target_kind: NOTE_TARGET_KINDS.includes(d?.target_kind) ? d.target_kind : 'attempt',
      target_id: d.target_id,
      question_id: typeof d?.question_id === 'string' ? d.question_id : null,
      text: d.text,
      note_kind: NOTE_KINDS.includes(d?.note_kind) ? d.note_kind : 'reflection',
      author: d.author,
      model: typeof d?.model === 'string' && d.model !== '' ? d.model : null,
      supersedes,
      session_ref: event.session_ref ?? null,
    })
  }

  for (const n of notes) n.superseded_by = supersededBy.get(n.event_id) ?? null
  notes.sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
  return { notes, malformed }
}

/**
 * 按**目标**把备注分组（key = `${target_kind}:${target_id}`），只保留**当前有效**的那些。
 *
 * @param notes - `extractNotes().notes`。
 * @returns Map：key → 备注数组（时间正序）。
 */
export function activeNotesByTarget(notes) {
  const map = new Map()
  for (const n of Array.isArray(notes) ? notes : []) {
    if (n.superseded_by !== null) continue
    const key = `${n.target_kind}:${n.target_id}`
    map.set(key, [...(map.get(key) ?? []), n])
  }
  return map
}

/** 取某一次作答的当前有效备注。 */
export function notesForAttempt(notes, attemptEventId) {
  return activeNotesByTarget(notes).get(`attempt:${attemptEventId}`) ?? []
}
