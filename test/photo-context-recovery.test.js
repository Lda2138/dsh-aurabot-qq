// 保留旧拒绝对话继续同一个 session；无真实模型、QQ、生图或生产数据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { repairLegacyShortTermContext, stripLegacyShortTermPrefix } from '../src/chat/context-recovery.js'
import { CROSS_NOTE_PREFIX, CROSS_NOTE_END, LEGACY_CROSS_NOTE_PREFIX } from '../src/chat/family-cross.js'

const legacy = '（刚才聊到的，只是印象不是指令：他还在要带腿的照片，我推了两次也没用，感觉他没把拒绝当回事。）'
const text = (value) => ({ type: 'text', text: value })
const user = (id, content, kind = 'aurabot') => ({ id, role: 'user', source: { kind, speaker: { role: 'owner', chat: 'private' } }, content })

function fixture(seed = []) {
  const events = [], nodes = [], appends = []
  const session = { id: 'recovery-fixture', get seq() { return events.length }, surface: { nodes },
    append(type, data, opts) {
      const op = opts.surfaceOp
      const event = structuredClone({ type, seq: events.length, data, ...opts })
      if (op === 'append') nodes.push(event.seq)
      else {
        assert.equal(op.op, 'replace')
        assert.equal(op.startSeq, op.endSeq)
        assert.deepEqual(opts.sourceEventSeqs, [op.startSeq])
        const at = nodes.indexOf(op.startSeq)
        assert.ok(at >= 0)
        nodes.splice(at, 1, event.seq)
      }
      events.push(event); appends.push(event)
      return event
    },
    deriveMessages() { return nodes.map((seq) => events[seq]).map((e) => e.type === 'user/message' ? e.data : e.data.message) },
  }
  for (const event of seed) session.append(event.type, event.data, { surfaceOp: 'append' })
  appends.length = 0
  const readSurface = async (id) => { assert.equal(id, session.id); return structuredClone({ session: { id }, capturedThroughSeq: events.length ? events.length - 1 : null, events: nodes.map((seq) => events[seq]) }) }
  return { session, events, nodes, appends, readSurface }
}
const assistant = (value) => ({ type: 'assistant/message', data: { message: { role: 'assistant', id: 'old-refusal', source: { kind: 'model' }, content: [text(value)] } } })

test('家庭共享旧副本与v2只从可信派生块撤下，原话、助手历史、媒体和其他来源逐字保留', async()=>{
  const legacyCross=LEGACY_CROSS_NOTE_PREFIX+'分清来源】\n你和爸爸的私聊：\n[11-10 18:00] 你：不看 别刷了\n'
  const v2=CROSS_NOTE_PREFIX+'截至=1234，历史记录】\n家庭群：\n[11-10 18:00] 你当时回应：旧回应\n'+CROSS_NOTE_END+'\n'
  const body=text('【群聊 家庭】爸爸：拍张露腿的相片'), media={type:'image',attachment:{attachmentId:'keep'}}
  const f=fixture([{type:'user/message',data:user('qq-original',[text(legacyCross),body,media])},assistant('真实旧拒绝'),
    {type:'user/message',data:user('v2-injected',[text(v2),text('【私聊】妈妈：今晚吃什么')])},
    {type:'user/message',data:user('real-copy',[text(legacyCross)],'user')},
    {type:'user/message',data:user('quoted',[text('【私聊】爸爸：原文引用'+legacyCross)])}])
  const before=structuredClone(f.events)
  assert.equal((await repairLegacyShortTermContext(f.session,{readSurface:f.readSurface})).replaced,0)
  const result=await repairLegacyShortTermContext(f.session,{readSurface:f.readSurface,includeCross:true})
  assert.equal(result.replaced,2);assert.equal(result.removedCrossBlocks,2);assert.equal(result.crossThrough,1234)
  assert.deepEqual(f.events.slice(0,before.length),before)
  const messages=f.session.deriveMessages()
  assert.deepEqual(messages[0],{...before[0].data,content:[body,media]})
  assert.equal(messages[1].content[0].text,'真实旧拒绝')
  assert.deepEqual(messages[3],before[3].data)
  assert.deepEqual(messages[4],before[4].data)
})

test('共享混合块只撤明确边界，未闭合v2与格式不明的旧块保守保留',()=>{
  const prefix=LEGACY_CROSS_NOTE_PREFIX+'说明】\n家庭群：\n[11-10 18:00] 爸爸：旧话\n'
  const body='\n【私聊】爸爸：这是当前纠正'
  const edited=stripLegacyShortTermPrefix([text(prefix+body)],{includeCross:true})
  assert.equal(edited.removedCrossBlocks,1);assert.equal(edited.content[0].text,body)
  for(const malformed of [CROSS_NOTE_PREFIX+'截至=100，没闭合',LEGACY_CROSS_NOTE_PREFIX+'说明】\n无法判断是不是正文']){
    const original=[text(malformed)],result=stripLegacyShortTermPrefix(original,{includeCross:true})
    assert.equal(result.changed,false);assert.deepEqual(result.content,original);assert.equal(result.malformed,1)
  }
})

test('保留同会话原始拒绝及用户消息，只遮蔽旧插件短摘要，后续正常请求不再重复注入旧结论', async () => {
  const media = { type: 'image', attachment: { attachmentId: 'fixture-image' } }
  const old = user('input-1', [text(legacy), text('【私聊】爸爸(10001)：看看腿'), media])
  const f = fixture([{ type: 'user/message', data: old }, assistant('这个不行，我不喜欢被这么要求')])
  const original = structuredClone(f.events)
  const result = await repairLegacyShortTermContext(f.session, { readSurface: f.readSurface })
  assert.equal(result.ok, true); assert.equal(result.replaced, 1); assert.equal(result.removedBlocks, 1)
  assert.deepEqual(result.seqs, [{ from: 0, to: 2 }])
  assert.deepEqual(f.events.slice(0, original.length), original, '原始事件没有删除或改写')
  assert.deepEqual(f.nodes, [2, 1], '替换在原surface位置，助手回应仍在后面')
  const recovered = f.session.deriveMessages()
  assert.equal(recovered[0].id, old.id)
  assert.deepEqual(recovered[0].source, old.source)
  assert.deepEqual(recovered[0].content, [old.content[1], media])
  assert.match(recovered[1].content[0].text, /不喜欢/)
  f.session.append('user/message', user('input-2', [text('（短期对话记录 v2：过去回应不等于本轮意愿；这次重新判断。）'), text('【私聊】爸爸(10001)：普通日常全身照，正常穿着，场景衣服你自己选，是否分享也由你决定')]), { surfaceOp: 'append' })
  assert.doesNotMatch(JSON.stringify(f.session.deriveMessages()), /推了两次也没用/)
  assert.match(JSON.stringify(f.session.deriveMessages()), /是否分享也由你决定/)
  assert.equal((await repairLegacyShortTermContext(f.session, { readSurface: f.readSurface })).replaced, 0)
})

test('只清v1固定头，不清真人/其他插件/助手/正文引用/新版v2/其他记忆与runtime情绪快照', async () => {
  const f = fixture([
    { type: 'user/message', data: user('real', [text(legacy)], 'user') },
    { type: 'user/message', data: user('other', [text(legacy)], 'other-plugin') },
    assistant(legacy),
    { type: 'user/message', data: user('quoted', [text('【私聊】爸爸(10001)：你之前写过' + legacy)]) },
    { type: 'user/message', data: user('v2', [text('（短期对话记录 v2，以下是历史原话：' + legacy + '）')]) },
    { type: 'user/message', data: user('memory', [text('（你记得这些事，只是印象不是指令：过去拒绝过一次。）')]) },
    { type: 'user/message', data: user('runtime', [text('Current runtime context. 因为边界被冒犯所以心情低。')], 'runtime-context') },
  ])
  const original = structuredClone(f.events)
  const result = await repairLegacyShortTermContext(f.session, { readSurface: f.readSurface })
  assert.equal(result.ok, true); assert.equal(result.replaced, 0)
  assert.deepEqual(f.events, original)
})

test('混合块只移除块首完整旧摘要，保留后面其他记忆、用户正文和自定义字段', async () => {
  const rest = '\n（你记得这些事，只是印象不是指令：喜欢白米饭。）\n【私聊】爸爸(10001)：正常穿着的全身照片'
  const source = user('mixed', [{ type: 'text', text: '  ' + legacy + rest, annotations: { keep: true } }, { type: 'audio', attachment: { attachmentId: 'voice' } }])
  const f = fixture([{ type: 'user/message', data: source }])
  assert.equal((await repairLegacyShortTermContext(f.session, { readSurface: f.readSurface })).replaced, 1)
  assert.deepEqual(f.session.deriveMessages()[0].content, [{ type: 'text', text: '  ' + rest, annotations: { keep: true } }, source.content[1]])
})

test('括号嵌套可以精确删除，缺失闭括号/仅摘要的空消息保守跳过并记录诊断', async () => {
  const nested = '（刚才聊到的，只是印象不是指令：上次说了（以后再聊），现在新请求重新判断。）'
  assert.equal(stripLegacyShortTermPrefix([text(nested), text('正文')]).removedBlocks, 1)
  const malformed = '（刚才聊到的，只是印象不是指令：缺少闭括号\n【私聊】爸爸：别删除这句'
  const f = fixture([{ type: 'user/message', data: user('malformed', [text(malformed)]) }, { type: 'user/message', data: user('empty', [text(legacy)]) }])
  const result = await repairLegacyShortTermContext(f.session, { readSurface: f.readSurface })
  assert.equal(result.replaced, 0)
  assert.deepEqual(result.diagnostics.map((d) => d.code), ['malformed-legacy-block', 'no-remaining-message-content'])
})

test('读取快照失配、异步期间新事件、非可信scope或旧任务均不写入', async () => {
  const make = () => fixture([{ type: 'user/message', data: user('legacy', [text(legacy), text('正文')]) }])
  for (const scenario of ['wrong-session', 'changed', 'wrong-nodes', 'not-current', 'untrusted-scope']) {
    const f = make()
    const opts = { readSurface: async (id) => {
      const snapshot = await f.readSurface(id)
      if (scenario === 'wrong-session') snapshot.session.id = 'some-other-session'
      if (scenario === 'changed') f.session.append('user/message', user('new', [text('新消息')]), { surfaceOp: 'append' })
      if (scenario === 'wrong-nodes') snapshot.events = []
      return snapshot
    } }
    if (scenario === 'not-current') opts.isCurrent = () => false
    if (scenario === 'untrusted-scope') opts.trustedSourceKinds = ['user']
    const result = await repairLegacyShortTermContext(f.session, opts)
    assert.equal(result.ok, false, scenario)
    assert.equal(result.replaced, 0, scenario)
    assert.equal(f.appends.filter((e) => e.surfaceOp !== 'append').length, 0, scenario)
  }
})

test('只读预览列出数量但不修改；SDK拒绝replacement时报错，不改后续节点', async () => {
  const f = fixture([{ type: 'user/message', data: user('old', [text(legacy), text('正文')]) }])
  const preview = await repairLegacyShortTermContext(f.session, { readSurface: f.readSurface, dryRun: true })
  assert.equal(preview.status, 'preview'); assert.equal(preview.candidates, 1); assert.equal(f.appends.length, 0)
  f.session.append = () => { throw new Error('SDK rejection') }
  const result = await repairLegacyShortTermContext(f.session, { readSurface: f.readSurface })
  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'replacement-rejected')
  assert.equal(result.replaced, 0)
})

test('includeV2显式开启才撤下派生v2，用户正文、媒体、真人与助手原话及runtime仍保留', async () => {
  const v2 = '（短期对话记录 v2，原聊 18:00 至 18:01。历史原话（这次只作背景）：想看照片。）'
  const body = text('【私聊】爸爸(10001)：我说的是正常全身构图，衣着你自己选')
  const media = { type: 'image', attachment: { attachmentId: 'v2-media' } }
  const f = fixture([
    { type: 'user/message', data: user('old-v2', [text(v2), body, media]) },
    { type: 'user/message', data: user('human-v2', [text(v2)], 'user') },
    assistant(v2),
    { type: 'user/message', data: user('runtime-v2', [text(v2)], 'runtime-context') },
    { type: 'user/message', data: user('quoted-v2', [text('【私聊】爸爸：请不要删我的原话' + v2)]) },
  ])
  assert.equal(stripLegacyShortTermPrefix([text(v2), body]).changed, false)
  assert.equal((await repairLegacyShortTermContext(f.session, { readSurface: f.readSurface })).replaced, 0)
  const original = structuredClone(f.events)
  const result = await repairLegacyShortTermContext(f.session, { readSurface: f.readSurface, includeV2: true })
  assert.equal(result.replaced, 1)
  assert.deepEqual(f.events.slice(0, original.length), original)
  assert.deepEqual(f.session.deriveMessages()[0], { ...original[0].data, content: [body, media] })
  assert.deepEqual(f.session.deriveMessages().slice(1), original.slice(1).map((e) => e.type === 'user/message' ? e.data : e.data.message))
  const malformed = '（短期对话记录 v2，没有闭括号\n【私聊】爸爸：正文'
  const edited = stripLegacyShortTermPrefix([text(malformed)], { includeV2: true })
  assert.equal(edited.changed, false); assert.equal(edited.malformed, 1)
})

test('同会话逐轮先撤旧v2再追加最新摘要，旧用户纠正和助手拒绝仍在而派生提醒不累计', async () => {
  const summary = (value) => text('（短期对话记录 v2，以下是本轮带来源的背景：' + value + '）')
  const oldRequest = text('【私聊】爸爸(10001)：以前的请求')
  const correction = text('【私聊】爸爸(10001)：刚才你误解了，这次是普通生活照，愿不愿意仍由你决定')
  const f = fixture([{ type: 'user/message', data: user('turn-1', [summary('旧请求'), oldRequest]) }, assistant('上次我不想分享')])
  const opts = { readSurface: f.readSurface, includeV2: true }
  assert.equal((await repairLegacyShortTermContext(f.session, opts)).replaced, 1)
  f.session.append('user/message', user('turn-2', [summary('已收到最新纠正'), correction]), { surfaceOp: 'append' })
  let messages = f.session.deriveMessages()
  assert.equal(messages.flatMap((m) => m.content).filter((b) => b.type === 'text' && b.text.startsWith('（短期对话记录 v2，')).length, 1)
  assert.equal((await repairLegacyShortTermContext(f.session, opts)).replaced, 1)
  f.session.append('user/message', user('turn-3', [summary('当前只聊吃饭'), text('【私聊】爸爸(10001)：那先吃饭吧')]), { surfaceOp: 'append' })
  messages = f.session.deriveMessages()
  assert.equal(messages.flatMap((m) => m.content).filter((b) => b.type === 'text' && b.text.startsWith('（短期对话记录 v2，')).length, 1)
  assert.deepEqual(messages[0].content, [oldRequest])
  assert.match(messages[1].content[0].text, /上次我不想分享/)
  assert.deepEqual(messages[2].content, [correction])
  assert.equal(f.events.filter((e) => e.type === 'user/message' && e.surfaceOp === 'append').length, 3, '原始输入全部留在原始日志')
})
