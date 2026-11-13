import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'aurabot-completion-'))
process.env.AURABOT_DATA_DIR = root
process.env.AURABOT_WORKSPACE = join(root, 'workspace')
const { completionFault, trimDeliveredPrefix } = await import('../src/chat/completion-recovery.js')
const { createHub } = await import('../src/chat/hub.js')
const { normalize } = await import('../src/core/config.js')
const { createFakeDsh } = await import('./helpers/fake-dsh.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const internalOnly = { content: [{ type: 'reasoning', text: 'private deliberation must never be sent' }] }
const pseudo = '我这不正在动手嘛 你等着\n<antml:invoke name="qq_draw_image"><antml:parameter name="prompt">猫</antml:parameter></antml:invoke>'
async function until(fn) { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await sleep(10) } }
function setup(t, brain, tools = []) {
  const data = mkdtempSync(join(root, 'case-')); process.env.AURABOT_DATA_DIR = data
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10001', botQQ: '20002', familyGroups: ['777'], merge: { enabled: false }, chat: { typingDelay: false }, voice: { enabled: false }, stickers: { enabled: false, faces: false, collect: false }, titleFilter: { enabled: false } })
  const sent = [], logs = [], fake = createFakeDsh({ brain })
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, buildTools: () => tools, log: { info: (...s) => logs.push(s.join(' ')), warn: (...s) => logs.push(s.join(' ')), debug() {}, error() {} }, onebot: { call: async (action, params) => { if (action.startsWith('send_')) { sent.push(params); return { message_id: 'receipt-' + sent.length } } return {} } } })
  fake.ctx.on('session/event', hub.onSessionEvent)
  t.after(() => { hub.dispose(); fake.dispose() })
  let id = 0
  const send = (text, family = false) => hub.onMessage({ post_type: 'message', message_type: family ? 'group' : 'private', self_id: 20002, user_id: 10001, ...(family ? { group_id: 777 } : {}), message_id: ++id, sender: { nickname: '爸爸' }, message: [{ type: 'text', data: { text } }] })
  const text = () => JSON.stringify(sent)
  return { hub, fake, sent, logs, send, text, cfg, data }
}

test('reasoning-only completion gets a real followup, private content never leaks', async (t) => {
  let n = 0
  const h = setup(t, async () => ++n === 1 ? internalOnly : '我去查查之前那几张画')
  await h.send('你还记得画的是什么吗')
  await until(() => h.sent.length === 1)
  assert.equal(h.fake.turns.length, 2)
  assert.match(h.fake.turns[1].userText, /本轮输出恢复/)
  assert.match(h.text(), /查查之前/)
  assert.doesNotMatch(h.text(), /private deliberation/)
  assert.deepEqual(h.hub.deliveryStatus().runningChats, [])
})

test('pseudo invocation status is held; recovery uses a real tool exactly once', async (t) => {
  let n = 0, executed = 0
  const h = setup(t, async ({ callTool }) => {
    if (++n === 1) return pseudo
    await callTool('qq_draw_image', { prompt: '猫' })
    return '图画好了'
  }, [{ name: 'qq_draw_image', execute: async () => { executed++; return { ok: true } } }])
  await h.send('画一只猫', true)
  await until(() => h.sent.length === 1)
  assert.equal(executed, 1)
  assert.doesNotMatch(h.text(), /正在动手|antml|你等着/)
  assert.match(h.text(), /图画好了/)
})

test('retry budget stops at two; explicit silence stays silent', async (t) => {
  const h = setup(t, async () => internalOnly)
  await h.send('你怎么没回答')
  await until(() => h.sent.length === 1)
  assert.equal(h.fake.turns.length, 3)
  assert.match(h.text(), /没回完整/)
  const s = setup(t, async () => '[沉默]')
  await s.send('嗯')
  await until(() => s.fake.turns.length === 1)
  await sleep(40)
  assert.equal(s.sent.length, 0)
})

test('revoked permission or disposed hub does not launch repair', async (t) => {
  const h = setup(t, async () => { h.cfg.enabled = false; return internalOnly })
  await h.send('问题呢')
  await until(() => h.fake.turns.length === 1)
  await sleep(40)
  assert.equal(h.sent.length, 0)
  assert.equal(h.fake.turns.length, 1)
})

test('real tool effects are not replayed by output recovery', async (t) => {
  let n = 0, writes = 0
  const h = setup(t, async ({ callTool, text }) => {
    if (++n === 1) { await callTool('effect', {}); return internalOnly }
    assert.match(text, /effect:returned/)
    await callTool('effect', {})
    return '刚才的事办好了'
  }, [{ name: 'effect', execute: async () => { writes++; return { ok: true } } }])
  await h.send('办好告诉我')
  await until(() => h.sent.length === 1)
  assert.equal(writes, 1)
})

test('interrupted bubbles supply actual sent prefix, drop unsent draft, and remove exact repeat', async (t) => {
  let h, n = 0
  h = setup(t, async () => ++n === 1 ? '妈妈 爸爸让我跟你道别\n别一个人灌酒\n以后我还在' : '妈妈 爸爸让我跟你道别\n我也不知道怎么说了')
  let inserted = false
  const watcher = setInterval(() => { if (!inserted && h.sent.length === 1) { inserted = true; h.send('哎') } }, 5)
  t.after(() => clearInterval(watcher))
  await h.send('道个别吧')
  await until(() => h.fake.turns.length >= 2 && h.sent.length >= 2)
  assert.match(h.fake.turns[1].userText, /已实际发送/)
  assert.doesNotMatch(h.fake.turns[1].userText, /灌酒|以后我还在/)
  assert.equal((h.text().match(/妈妈 爸爸让我跟你道别/g) || []).length, 1)
})

test('classification preserves native calls and silence; exact prefix only', () => {
  assert.equal(completionFault(internalOnly), 'empty-final')
  assert.equal(completionFault({ content: [{ type: 'text', text: pseudo }] }), 'tool-text')
  assert.equal(completionFault({ content: [{ type: 'tool-call', name: 'x' }] }), '')
  assert.equal(completionFault({ content: [{ type: 'text', text: '[沉默]' }] }), '')
  assert.deepEqual(trimDeliveredPrefix([{ kind: 'text', value: '<at:10000002> 妈妈 道别了' }, { kind: 'text', value: '新的话' }], ['@10000002 妈妈 道别了']).map((x) => x.value), ['新的话'])
})
