import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'aurabot-persona-preview-'))
process.env.AURABOT_DATA_DIR = dir
process.env.AURABOT_WORKSPACE = join(dir, 'workspace')
process.env.AURABOT_REGISTRY_URL = 'http://127.0.0.1:9/index.json'
const { createFakeDsh } = await import('./helpers/fake-dsh.js')
const { apply } = await import('../src/host.js')

test('角色文字预览只调用模型，不发QQ、不启动会话、不写心情或记忆', async (t) => {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ enabled: false, setupDone: true, ownerQQ: '10001', familyGroups: ['777'], snowluma: { autoStart: false, autoAttach: false, dir: join(dir, 'missing') }, speakUp: { enabled: false } }))
  const fake = createFakeDsh({ brain: async () => { throw new Error('预览不得启动聊天agent') } })
  const prompts = []
  fake.ctx.llm.stream = async function * (p) { prompts.push(p); yield { type: 'text-delta', text: '好呀，我看看穿什么合适' }; yield { type: 'finish', reason: { kind: 'completed' } } }
  await apply(fake.ctx)
  t.after(() => fake.dispose())
  const files = ['mood.json', 'memory.sqlite', 'outbound-state.json']
  const before = files.map((f) => existsSync(join(dir, f)) ? readFileSync(join(dir, f)) : null)
  const response = (await fake.call('/persona/preview', { kind: 'group', groupId: '777', text: '拍张普通生活照吧', context: '上次你拒绝了另一个请求' })).json()
  assert.equal(response.ok, true); assert.equal(response.previewOnly, true); assert.deepEqual(response.sent, [])
  assert.equal(fake.turns.length, 0)
  assert.match(prompts[0].system, /只读文字预览/)
  assert.match(prompts[0].system, /来源标着【群聊】的，是你们自己家的家庭群/)
  assert.match(prompts[0].messages[0].content[0].text, /上次你拒绝了另一个请求/)
  files.forEach((f, i) => assert.deepEqual(existsSync(join(dir, f)) ? readFileSync(join(dir, f)) : null, before[i], f))
  const now = new Date(), day = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
  mkdirSync(join(dir,'chatlog'),{recursive:true})
  writeFileSync(join(dir,'chatlog',day+'.jsonl'),JSON.stringify({t:Date.now()-1000,chatId:'private:10001',who:'bot',text:'私聊中真实存在的旧回应'})+'\n')
  const exact='拍张露腿的相片'
  const crossPreview=(await fake.call('/persona/preview',{kind:'group',groupId:'777',text:exact,includeFamilyCross:true})).json()
  assert.equal(crossPreview.contextSummary.familyCrossIncluded,false,'单独的助手旧回应不作为家庭新事实注入')
  assert.doesNotMatch(prompts.at(-1).messages[0].content[0].text,/私聊中真实存在的旧回应/)
  writeFileSync(join(dir,'chatlog',day+'.jsonl'),[
    {t:Date.now()-2000,chatId:'private:10001',who:'家人',uid:'10001',text:'我们刚刚聊过周末吃饭'},
    {t:Date.now()-1000,chatId:'private:10001',who:'bot',text:'私聊中真实存在的旧回应'}].map((row)=>JSON.stringify(row)).join('\n')+'\n')
  const pairedPreview=(await fake.call('/persona/preview',{kind:'group',groupId:'777',text:exact,includeFamilyCross:true})).json()
  assert.equal(pairedPreview.contextSummary.familyCrossIncluded,true)
  const submitted=prompts.at(-1).messages[0].content[0].text
  assert.match(submitted,/家人近况节选 v2[\s\S]*私聊中真实存在的旧回应/)
  assert.ok(submitted.endsWith(exact),'复现保留用户原句，不替换成普通穿搭说明')
  assert.equal(existsSync(join(dir,'family-cross-state.json')),false,'只读预览不消耗共享水位')
  assert.equal(fake.turns.length,0)
  const beforeReplay = files.map((f) => existsSync(join(dir, f)) ? readFileSync(join(dir, f)) : null)
  const replay = (await fake.call('/conversation/replay', { system: '历史系统规则', messages: [
    { role: 'assistant', content: [{ type: 'text', text: '去说呀' }] },
    { role: 'user', content: [{ type: 'text', text: '说了呀' }] },
  ] })).json()
  assert.equal(replay.ok, true)
  assert.equal(replay.replayOnly, true)
  assert.deepEqual(replay.sent, [])
  assert.equal(fake.turns.length, 0)
  files.forEach((f, i) => assert.deepEqual(existsSync(join(dir, f)) ? readFileSync(join(dir, f)) : null, beforeReplay[i], f))
  const promptCount = prompts.length
  const protectedFiles = [...files, 'sessions.json', 'family-cross-state.json', 'context-recovery.json']
  const beforeContext = protectedFiles.map((f) => existsSync(join(dir, f)) ? readFileSync(join(dir, f)) : null)
  for (const chatId of ['private:10001', 'group:777']) {
    const snapshot = (await fake.call('/conversation/context', { chatId })).json()
    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.chatId, chatId)
    assert.equal(snapshot.readOnly, true)
    assert.equal(snapshot.modelRequests, 0)
    assert.match(snapshot.context, /家人身份/)
    assert.deepEqual(snapshot.sent, [])
  }
  assert.equal((await fake.call('/conversation/context', { chatId: 'group:999' })).json().status, 'invalid-chat')
  assert.equal(prompts.length, promptCount, '读取当前资料不调用模型')
  assert.equal(fake.turns.length, 0)
  protectedFiles.forEach((f, i) => assert.deepEqual(existsSync(join(dir, f)) ? readFileSync(join(dir, f)) : null, beforeContext[i], f))
})
