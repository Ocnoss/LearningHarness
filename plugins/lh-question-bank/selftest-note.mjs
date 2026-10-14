/**
 * `@lh/question-bank/note` 的离线自测 —— 备注（作答级注解）的对象层与读写层。
 *
 * 跑法：node plugins/lh-question-bank/selftest-note.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ⚠ 日志指到临时目录（paths/store 都是惰性求值，必须在 import 之前设）
const sandbox = mkdtempSync(join(tmpdir(), 'lh-note-selftest-'))
process.env.LH_EVENT_LOG = join(sandbox, 'events.jsonl')

const { LhEventStore, readEvents } = await import('@lh/event-store/store')
const {
  NOTE_EVENT_TYPE,
  NOTE_KINDS,
  NOTE_TARGET_KINDS,
  NOTE_MAX_CHARS,
  buildNote,
  recordNote,
  extractNotes,
  activeNotesByTarget,
  notesForAttempt,
} = await import('./note.js')

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, message: error?.message ?? String(error) })
    console.log(`  FAIL ${name}\n       ${error?.message ?? String(error)}`)
  }
}

const PROVENANCE = { plugin: '@lh/question-bank', version: '0.0.1' }

console.log('\n══ 1. buildNote：纯函数校验 ══')

check('正常一条：默认作答级 + 反思 + 人写', () => {
  const d = buildNote({ targetKind: 'attempt', targetId: 'e-attempt-1', text: '  当时把主旨读成了细节  ' })
  assert.equal(d.target_kind, 'attempt')
  assert.equal(d.target_id, 'e-attempt-1')
  assert.equal(d.text, '当时把主旨读成了细节') // 首尾空白被压掉
  assert.equal(d.note_kind, 'reflection')
  assert.equal(d.author, 'user')
  assert.equal(d.model, null)
  assert.deepEqual(d.supersedes, [])
})
check('思路与反思是两种（教学上不同，不混成一段）', () => {
  assert.deepEqual(NOTE_KINDS, ['reasoning', 'reflection'])
  assert.equal(buildNote({ targetKind: 'attempt', targetId: 'x', text: 'a', noteKind: 'reasoning' }).note_kind, 'reasoning')
})
check('模型写的备注带型号（否则将来分不清是我写的还是模型编的）', () => {
  const d = buildNote({ targetKind: 'attempt', targetId: 'x', text: 'a', author: 'agent', model: 'deepseek-v4.1-flash' })
  assert.equal(d.author, 'agent')
  assert.equal(d.model, 'deepseek-v4.1-flash')
})
check('锚点只接受 attempt / question', () => {
  assert.deepEqual(NOTE_TARGET_KINDS, ['attempt', 'question'])
  assert.throws(() => buildNote({ targetKind: 'question_id', targetId: 'x', text: 'a' }), /target_kind 非法/)
})
check('缺 target_id / 空正文 / 超长 都拒绝（空备注不写：它只会变成噪声）', () => {
  assert.throws(() => buildNote({ targetKind: 'attempt', targetId: '  ', text: 'a' }), /target_id 必填/)
  assert.throws(() => buildNote({ targetKind: 'attempt', targetId: 'x', text: '   ' }), /text 不能为空/)
  assert.throws(() => buildNote({ targetKind: 'attempt', targetId: 'x', text: '字'.repeat(NOTE_MAX_CHARS + 1) }), /超长/)
})
check('author / note_kind 非法值都拒绝', () => {
  assert.throws(() => buildNote({ targetKind: 'attempt', targetId: 'x', text: 'a', author: 'human' }), /author 非法/)
  assert.throws(() => buildNote({ targetKind: 'attempt', targetId: 'x', text: 'a', noteKind: '乱写' }), /note_kind 非法/)
})
check('supersedes 单值会被收成数组（编辑 = 新备注 + 指针）', () => {
  assert.deepEqual(buildNote({ targetKind: 'attempt', targetId: 'x', text: 'a', supersedes: 'e-old' }).supersedes, ['e-old'])
})

console.log('\n══ 2. 读写：唯一写入路径 ══')

const store = new LhEventStore()
const first = recordNote({ store, provenance: PROVENANCE, targetKind: 'attempt', targetId: 'e-a1', text: '先排除 B，因为…', noteKind: 'reasoning' })
const second = recordNote({ store, provenance: PROVENANCE, targetKind: 'attempt', targetId: 'e-a1', text: '事后看是没抓到转折词', sessionRef: 'session-x' })
const other = recordNote({ store, provenance: PROVENANCE, targetKind: 'attempt', targetId: 'e-a2', text: '另一题的备注' })

check('写入的事件类型是资源类注解（lh/resource/*）', () => {
  assert.equal(first.event.type, NOTE_EVENT_TYPE)
  assert.ok(NOTE_EVENT_TYPE.startsWith('lh/resource/'))
})
check('actor 取 author：这条备注是谁写的最重要', () => {
  assert.equal(first.event.actor, 'user')
  const byAgent = recordNote({ store, provenance: PROVENANCE, targetKind: 'attempt', targetId: 'e-a3', text: '模型思路', author: 'agent', model: 'm' })
  assert.equal(byAgent.event.actor, 'agent')
})
check('事件真的落进了日志', () => {
  assert.equal(readEvents().filter((e) => e.type === NOTE_EVENT_TYPE).length, 4)
})

console.log('\n══ 3. 读取：supersedes 解链，但原话不丢 ══')

const events = readEvents()
const { notes, malformed } = extractNotes(events)
check('取到全部备注，且按时间正序', () => {
  assert.equal(notes.length, 4)
  assert.equal(malformed.length, 0)
  const times = notes.map((n) => n.created_at)
  assert.deepEqual(times, [...times].sort())
})
check('当前有效的那些按目标分组（被取代的不在内）', () => {
  const map = activeNotesByTarget(notes)
  assert.equal(map.get('attempt:e-a1').length, 2)
  assert.equal(map.get('attempt:e-a2').length, 1)
})
check('notesForAttempt 只取那一次作答的备注', () => {
  const list = notesForAttempt(notes, 'e-a1')
  assert.deepEqual(list.map((n) => n.text), ['先排除 B，因为…', '事后看是没抓到转折词'])
})

// 编辑：新备注取代旧的
const edited = recordNote({ store, provenance: PROVENANCE, targetKind: 'attempt', targetId: 'e-a1', text: '补一句：转折词在第 3 句', noteKind: 'reflection', supersedes: second.event.id })
const afterEdit = extractNotes(readEvents())
check('编辑（supersedes）后：旧的那条标了 superseded_by，但**仍在**（原话是证据）', () => {
  const all = afterEdit.notes
  const old = all.find((n) => n.event_id === second.event.id)
  assert.equal(old.superseded_by, edited.event.id)
  assert.equal(old.text, '事后看是没抓到转折词') // 原话一个字没变
  const active = notesForAttempt(afterEdit.notes, 'e-a1')
  assert.deepEqual(active.map((n) => n.text), ['先排除 B，因为…', '补一句：转折词在第 3 句'])
})
check('形状不合法的事件被如实报出，而不是当成空备注', () => {
  const bad = [
    { id: 'x1', timestamp: 't', type: NOTE_EVENT_TYPE, data: { target_kind: 'attempt', text: '没有 target_id' } },
    { id: 'x2', timestamp: 't', type: NOTE_EVENT_TYPE, data: { target_kind: 'attempt', target_id: 'e', text: '  ' } },
    { id: 'x3', timestamp: 't', type: NOTE_EVENT_TYPE, data: { target_kind: 'attempt', target_id: 'e', text: 'ok', author: 'human' } },
  ]
  const r = extractNotes(bad)
  assert.equal(r.notes.length, 0)
  assert.equal(r.malformed.length, 3)
  assert.ok(r.malformed.every((m) => typeof m.reason === 'string'))
})
check('target_kind 认不出时退回 attempt（而不是丢掉这条备注）', () => {
  const r = extractNotes([{ id: 'y', timestamp: 't', type: NOTE_EVENT_TYPE, data: { target_kind: '乱写', target_id: 'e', text: 'ok', author: 'user' } }])
  assert.equal(r.notes[0].target_kind, 'attempt')
})

console.log('\n══ 4. 答题时顺手写备注（一次调用两条事件） ══')

{
  // 造一个临时工作区 + 一个只有一道题的题库（recordAttempt 需要真题库文件）
  const { mkdirSync, writeFileSync: wf, existsSync: ex } = await import('node:fs')
  const ws = join(sandbox, 'ws')
  if (!ex(join(ws, 'lh-questions'))) mkdirSync(join(ws, 'lh-questions'), { recursive: true })
  const q = { id: 'q-note-1', kind: 'single_choice', stem: '甲题？', options: ['A', 'B'], answer: ['A'], accept: [], analysis: '解析', topics: [], unmapped_topics: [], source: { path: 'f.pdf', number: '1' }, provenance: {} }
  wf(join(ws, 'lh-questions', '测试库.json'), JSON.stringify({ schema_version: 1, title: '测试库', source_root: null, generated_at: null, provenance: {}, question_count: 1, duplicate_ids: [], questions: [q] }), 'utf8')

  const { recordAttempt } = await import('./index.js')
  const store2 = new LhEventStore()
  const before = readEvents().length
  const withNote = recordAttempt({
    store: store2,
    workspaceRoot: ws,
    bankName: '测试库',
    questionId: 'q-note-1',
    response: 'B',
    source: 'llm',
    model: 'deepseek-v4.1-flash',
    note: '我在 B 和 A 之间摇摆，选了 B 是因为把"旨在说明"读成了"细节"',
  })
  const afterOne = readEvents()

  check('一次调用写**两条**事件：作答 + 注解', () => {
    assert.equal(afterOne.length, before + 2)
    assert.equal(afterOne[afterOne.length - 1].type, 'lh/resource/note-made')
  })
  check('注解的 target 是**刚写的那条作答**（顺序有意义）', () => {
    assert.equal(withNote.noteEvent.data.target_id, withNote.event.id)
    assert.equal(withNote.noteEvent.data.target_kind, 'attempt')
  })
  check('模型答的 → 这条思路归模型（author: agent + 型号），不冒充人的想法', () => {
    assert.equal(withNote.noteEvent.data.author, 'agent')
    assert.equal(withNote.noteEvent.data.model, 'deepseek-v4.1-flash')
  })
  check('与作答同时写的默认是「思路」（reasoning），不是事后反思', () => {
    assert.equal(withNote.noteEvent.data.note_kind, 'reasoning')
  })
  check('不写 note 时**不多写**事件（空备注不落盘）', () => {
    const b = readEvents().length
    recordAttempt({ store: store2, workspaceRoot: ws, bankName: '测试库', questionId: 'q-note-1', response: 'A', source: 'human' })
    assert.equal(readEvents().length, b + 1)
  })
  check('人答时给的 note 归「用户」（agent 只是代记）', () => {
    const r = recordAttempt({ store: store2, workspaceRoot: ws, bankName: '测试库', questionId: 'q-note-1', response: 'A', source: 'human', note: '我选 A 是因为…' })
    assert.equal(r.noteEvent.data.author, 'user')
    assert.equal(r.noteEvent.data.model, null)
  })
}

try {
  rmSync(sandbox, { recursive: true, force: true })
} catch {
  /* 删不掉临时目录不该掩盖结果 */
}

console.log(`\n══ 结果：${passed} 通过 / ${failed} 失败 ══`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`)
  process.exit(1)
}
console.log('全部通过。')
