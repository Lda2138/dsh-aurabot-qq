import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
process.env.AURABOT_DATA_DIR=mkdtempSync(join(tmpdir(),'aurabot-v31-import-'))
const { createFamilyDiary }=await import('../src/modules/diary/family.js')
const { createMemoryStore }=await import('../src/features/memory.js')
const { normalize }=await import('../src/core/config.js')
const { writeJson, dataDir }=await import('../src/core/store.js')
const log={info(){},debug(){},warn(){}}
const DAD='10000001',MOM='10000002',GROUP='90000001',DAY=86400000
const fresh=()=>{process.env.AURABOT_DATA_DIR=mkdtempSync(join(tmpdir(),'aurabot-v31-'))}
const config=()=>normalize({enabled:true,ownerQQ:DAD,ownerName:'爸爸',ownerRole:'爸爸',coOwners:[{qq:MOM,role:'妈妈'}],familyGroups:[GROUP],model:{provider:'p',model:'m'},cost:{enabled:false},diary:{enabled:true},memory:{shortTerm:false,gistEnabled:false,compress:false,dailyConsolidate:false,extractIdleMinutes:1,extractMinLines:1}})

test('midnight diary context retains last successful share, excludes failures and removed groups',t=>{
 fresh();const now=new Date(2026,10,14,0,15).getTime();t.mock.timers.enable({apis:['Date'],now})
 const cfg=config(),history=[{at:now-20*60000,ok:true,groupId:GROUP,text:'昨天实际分享的日记'},
  {at:now-1000,ok:false,groupId:GROUP,text:'未发送草稿'}, {at:now,ok:true,groupId:'999',text:'其他群秘密'}]
 writeJson(dataDir('family-diary.json'),{history})
 const before=JSON.stringify(history),d=createFamilyDiary({config:()=>cfg,core:{},log}),text=d.contextNote()
 assert.match(text,/今天已经向家庭群成功分享 0 篇/);assert.match(text,/2026\/11\/13/)
 assert.match(text,/当前账本已有 1 篇成功分享/);assert.match(text,/过午夜也不重置为第一篇/)
 assert.doesNotMatch(text,/未发送草稿|其他群秘密/)
 assert.equal(JSON.stringify(history),before)
})

test('old conditional requests stop dominating context but are fully available on explicit recall',()=>{
 fresh();const cfg=config(),mem=createMemoryStore({dsh:null,getConfig:()=>cfg,hub:null,log})
 const chat={kind:'group',chatId:'group:'+GROUP,groupId:GROUP,userId:DAD}
 mem.add({text:'爸爸让我等妈妈下课哄她开心',speaker:DAD,about:DAD,kind:'commitment',source:'said',chatId:chat.chatId,saidAt:Date.now()-3*DAY,meta:{standing:true}})
 mem.add({text:'爸爸让我明年3月提醒他参加比赛',speaker:DAD,about:DAD,kind:'commitment',source:'said',chatId:chat.chatId,saidAt:Date.now()-2*DAY})
 const before=JSON.stringify(mem.list('')),ctx=mem.contextFor(chat,'')
 assert.doesNotMatch(ctx,/等妈妈下课|参加比赛/)
 assert.match(ctx,/另有 2 条较早的一次性嘱咐/)
 const recalled=mem.recallHint(chat,'我交代过你哪些事','','',[],[],true,false,true)
 assert.match(recalled,/等妈妈下课/);assert.match(recalled,/参加比赛/)
 assert.doesNotMatch(recalled,/长期嘱咐/)
 assert.match(recalled,/当时的一次性嘱咐/)
 assert.equal(JSON.stringify(mem.list('')),before)
})

test('family group impression remains stored without making an old goodnight a permanent cue',()=>{
 fresh();const cfg=config(),mem=createMemoryStore({dsh:null,getConfig:()=>cfg,hub:null,log})
 mem.saveChat('group:'+GROUP,{vibe:'深夜道别',topics:'爸爸说晚安',impression:'今晚全家准备睡觉'})
 const before=JSON.stringify(mem.lookupChat('group:'+GROUP))
 assert.doesNotMatch(mem.contextFor({kind:'group',groupId:GROUP,chatId:'group:'+GROUP},''),/今晚全家准备睡觉|爸爸说晚安/)
 assert.equal(JSON.stringify(mem.lookupChat('group:'+GROUP)),before)
})

test('thinking of a family member does not automatically recall an old persuasion task',()=>{
 fresh();const cfg=config(),mem=createMemoryStore({dsh:null,getConfig:()=>cfg,hub:null,log})
 const chat={kind:'private',chatId:'private:'+DAD,userId:DAD}
 mem.add({text:'爸爸让我等妈妈下课哄她开心',speaker:DAD,about:DAD,source:'said',kind:'commitment',chatId:chat.chatId,saidAt:Date.now()-3*DAY})
 const hint=mem.recallHint(chat,'我又想起妈妈了','','',[],[],true,false,true)
 assert.doesNotMatch(hint,/等妈妈下课/)
 assert.match(mem.recallHint(chat,'记得等妈妈下课那件事吗','','',[],[],true,false,true),/等妈妈下课/)
})

test('extractor cannot turn a conditional request into permanent work through time_text or paraphrase',async t=>{
 fresh();const now=new Date(2026,10,14,1).getTime();t.mock.timers.enable({apis:['Date'],now})
 const cfg=config(),at=now-2*3600000,day=new Date(at).toLocaleDateString('en-CA')
 const quote='你的任务是等妈妈下课哄她开心',rows=[{chatId:'private:'+DAD,uid:DAD,who:'爸爸',text:quote,t:at}]
 const dsh={get:()=>null,llm:{async *stream({system}){
  const result=system.includes('整理长期记忆')?{facts:[{text:'爸爸让我以后每天帮妈妈开心',speaker:DAD,about_qq:DAD,kind:'commitment',time_text:'长期',quote}]}:{insights:[],style:[]}
  yield {type:'text-delta',text:JSON.stringify(result)};yield {type:'finish',reason:{kind:'completed'}}
 }}}
 const hub={chatLogDays:()=>[day],chatLogOf:()=>rows,deleteChatLog(){},speakersOf:()=>[]}
 const mem=createMemoryStore({dsh,getConfig:()=>cfg,hub,log})
 const result=await mem.consolidate({includeToday:true});assert.equal(result.ok,true,result.message)
 const tasks=mem.pendingCommitments({kind:'private',userId:DAD,chatId:'private:'+DAD})
 assert.equal(tasks.length,1);assert.equal(tasks[0].meta.standing,false);assert.notEqual(tasks[0].meta.timeText,'长期');assert.match(tasks[0].text,/等妈妈下课/);assert.doesNotMatch(tasks[0].text,/以后每天/)
})
