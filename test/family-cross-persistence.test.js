import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = mkdtempSync(join(tmpdir(), 'aurabot-family-cross-ledger-'))
process.env.AURABOT_DATA_DIR = root
process.env.AURABOT_WORKSPACE = join(root, 'workspace')
const { createOwnerCrossTracker } = await import('../src/chat/family-cross.js')
const { createHub } = await import('../src/chat/hub.js')
const { normalize } = await import('../src/core/config.js')
const { createFakeDsh } = await import('./helpers/fake-dsh.js')

test('共享水位跨实例持久，按目标session隔离、单调前进，只读查询不写', () => {
  let state = {}, writes = 0
  const make = () => createOwnerCrossTracker({ load: () => structuredClone(state), save: (s) => { state = s; writes++ } })
  const a = make(), now = Date.now()-100
  assert.equal(a.through('group:777', 'session-same'), 0)
  assert.equal(writes, 0)
  assert.equal(a.acknowledge('group:777', 'session-same', now), true)
  const b = make()
  assert.equal(b.through('group:777', 'same'), now)
  assert.equal(b.through('private:10001', 'same'), 0)
  assert.equal(b.through('group:777', 'new-session'), 0)
  assert.equal(b.acknowledge('group:777', 'same', now-1), false)
  assert.equal(b.acknowledge('group:777', '', now), false)
  assert.equal(b.acknowledge('group:777', 'same', Date.now()+10000), false)
  assert.equal(writes, 1)
})

function fixture(t) {
  const dir = mkdtempSync(join(root, 'case-'))
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ enabled: true, dryRun: true, ownerQQ: '10001', ownerName: '爸爸', coOwners: [{qq:'10002',name:'妈妈'}], familyGroups:['777'], voice:{enabled:false}, stickers:{enabled:false} })
  const fake = createFakeDsh({brain:async()=>''})
  const make = () => createHub({dsh:fake.ctx,getConfig:()=>cfg,log:{info(){},debug(){},warn(){}},onebot:{call:async()=>{throw new Error('不得访问QQ')}}})
  const hub = make()
  t.after(()=>{hub.dispose();fake.dispose()})
  return {dir,cfg,fake,hub,make,chat:{chatId:'group:777',kind:'group',groupId:'777',userId:'10001'}}
}

test('真实hub准入成功后持久记录，重启不再把私聊旧拒绝回灌，之后新消息仍共享', async(t)=>{
  const s=fixture(t)
  s.hub.logChat('private:10001','爸爸','原来的照片请求','10001',{at:Date.now()-2000})
  s.hub.logChat('private:10001','bot','这是上次的回应','',{at:Date.now()-1000})
  await s.hub.pushToSession(s.chat,[{type:'text',text:'【群聊 家】爸爸：当前原话'}],'10001')
  assert.match(s.fake.turns.at(-1).userText,/家人近况节选 v2[\s\S]*这是上次的回应/)
  const path=join(s.dir,'family-cross-state.json'), saved=readFileSync(path,'utf8')
  s.hub.dispose()
  const restored=s.make();t.after(()=>restored.dispose())
  assert.equal(restored.ownerCrossNote('group:777'),'')
  assert.equal(readFileSync(path,'utf8'),saved,'只读预览不消耗共享机会')
  await new Promise(r=>setTimeout(r,4))
  restored.logChat('private:10002','妈妈','今晚早点休息吧','10002')
  assert.match(restored.ownerCrossNote('group:777'),/今晚早点休息吧/)
  assert.equal(readFileSync(path,'utf8'),saved)
  await restored.pushToSession(s.chat,[{type:'text',text:'【群聊 家】爸爸：新问题'}],'10001')
  assert.match(s.fake.turns.at(-1).userText,/今晚早点休息吧/)
  assert.doesNotMatch(s.fake.turns.at(-1).userText,/这是上次的回应/)
})

test('宿主拒绝准入不消费共享水位，下次恢复仍可共享',async(t)=>{
  const s=fixture(t)
  await s.hub.pushToSession(s.chat,[{type:'text',text:'建立原会话'}],'10001')
  const sid=s.hub.sessions()['group:777'].sessionId, agent=s.fake.agents.get(sid), original=agent.followup
  s.hub.logChat('private:10002','妈妈','这是一条尚未共享的新话','10002',{at:Date.now()-1})
  agent.followup=async()=>{throw new Error('fixture admission failed')}
  await assert.rejects(s.hub.pushToSession(s.chat,[{type:'text',text:'当前问题'}],'10001'),/admission failed/)
  assert.equal(existsSync(join(s.dir,'family-cross-state.json')),false)
  agent.followup=original
  assert.match(s.hub.ownerCrossNote('group:777'),/尚未共享的新话/)
})

test('按明确原session刷新一个家庭工作上下文，旧会话归档可查、其他聊天保留，不触发模型回合',async(t)=>{
  const s=fixture(t)
  const off=s.fake.ctx.on('session/event',(session,event)=>s.hub.onSessionEvent(session,event));t.after(off)
  await s.hub.pushToSession(s.chat,[{type:'text',text:'需要保留原日志的旧聊天'}],'10001')
  const mom={chatId:'private:10002',kind:'private',userId:'10002'}
  await s.hub.pushToSession(mom,[{type:'text',text:'另一个家人的聊天'}],'10002')
  await new Promise(setImmediate)
  const previous=s.hub.sessions(),old=previous['group:777'].sessionId,turns=s.fake.turns.length
  assert.equal((await s.hub.refreshOwnerContext('group:777',{expectedSessionId:'wrong'})).status,'stale-session')
  const result=await s.hub.refreshOwnerContext('group:777',{expectedSessionId:old})
  assert.equal(result.ok,true);assert.equal(result.modelTurnStarted,false)
  assert.notEqual(result.sessionId,old)
  assert.ok(s.fake.ctx.workspaceRegistry.archivedSessionIds.includes(old))
  assert.ok(s.fake.agents.get(old),'原会话与其原始事件仍保留')
  assert.equal(s.hub.sessions()[mom.chatId].sessionId,previous[mom.chatId].sessionId)
  assert.equal(s.fake.turns.length,turns,'准备新会话不发消息、不启动模型')
  assert.equal(s.fake.agents.get(result.sessionId).events.filter(e=>/^(user\/message|assistant\/message|turn\/start|tool\/call)$/.test(e.type)).length,0)
})
