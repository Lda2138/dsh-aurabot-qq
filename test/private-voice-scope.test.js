import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { voiceTargetAllowed,assertVoiceAction,containsAudioPayload } from '../src/voice/access.js'
import { createOneBotClient } from '../src/onebot/client.js'
import { normalize } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
const log={info(){},warn(){},debug(){},error(){}}
const cfg=()=>normalize({enabled:true,dryRun:false,botQQ:'10000',ownerQQ:'10001',coOwners:[{qq:'10002',role:'妈妈'}],familyGroups:['777'],allow:{private:['10003'],groups:['888']},voice:{enabled:true,autoChance:1},chat:{typingDelay:false},stickers:{enabled:false,faces:false}})
function rig(t,extra={}){
 process.env.AURABOT_DATA_DIR=mkdtempSync(join(tmpdir(),'aurabot-private-voice-'))
 const config=cfg(),fake=createFakeDsh({brain:async()=>''}),calls=[],synthesis=[]
 const file=join(process.env.AURABOT_DATA_DIR,'speech.wav');writeFileSync(file,Buffer.alloc(96,1))
 const hub=createHub({dsh:fake.ctx,getConfig:()=>config,log,tts:{available:()=>true,speak:async text=>{synthesis.push(text);return {file,engine:'fixture'}}},onebot:{state:'connected',call:async(action,params)=>{calls.push({action,params});return {message_id:String(calls.length)}}},...extra})
 t.after(()=>{hub.dispose();fake.dispose()});return {config,hub,calls,synthesis,file}
}
test('only owner private destinations and configured family groups allow audio',()=>{
 const c=cfg();for(const id of ['private:10001','private:10002','group:777'])assert.equal(voiceTargetAllowed(c,id),true)
 for(const id of ['private:10003','group:888','system:test','private:','group:'])assert.equal(voiceTargetAllowed(c,id),false)
})
test('ordinary private/group voice markup and explicit voice requests become text without synthesizing',async t=>{
 const r=rig(t)
 for(const id of ['private:10003','group:888']){
  await r.hub.deliver(id,'<voice>这里按文字回复</voice>',{own:true})
  await r.hub.deliver(id,'明确要求也用文字',{own:true,wantVoice:true})
 }
 assert.equal(r.synthesis.length,0);assert.ok(r.calls.length>=4)
 assert.ok(r.calls.every(c=>c.params.message.every(s=>s.type!=='record')))
})
test('all three authorized destinations still synthesize and deliver audio',async t=>{
 const r=rig(t)
 for(const id of ['private:10001','private:10002','group:777'])assert.equal(await r.hub.sendVoice(id,'正常语音'),true)
 assert.equal(r.synthesis.length,3);assert.equal(r.calls.filter(c=>c.params.message[0].type==='record').length,3)
})
test('direct files, nested forwards, force and raw AI audio cannot bypass destination scope',async t=>{
 const r=rig(t)
 await assert.rejects(r.hub.sendVoiceFile('group:888','missing.wav'),/语音仅限/)
 await assert.rejects(r.hub.sendSegments('group:888',[{type:'node',data:{content:[{type:'record',data:{file:'base64://fixture'}}]}}],'nested',{force:true}),/语音仅限/)
 await assert.rejects(r.hub.sendPlatformAction('send_group_ai_record',{group_id:888,text:'test'}),/语音仅限/)
 assert.equal(r.calls.length,0)
 assert.equal(containsAudioPayload('[CQ:record,file=x]'),true)
 assert.equal(containsAudioPayload([{type:'file',data:{file:'recording.wav'}}]),true)
 assert.equal(containsAudioPayload([{type:'text',data:{text:'歌曲名'}}]),false)
})
test('revoking family membership during synthesis prevents sending and cancels recovery',async t=>{
 let resolve,entered;const gate=new Promise(r=>resolve=r),started=new Promise(r=>entered=r)
 const r=rig(t),oldSpeak=r.hub // independent delayed rig preserves normal fake TTS boundary
 r.hub.dispose()
 const fake=createFakeDsh({brain:async()=>''});t.after(()=>fake.dispose())
 const hub=createHub({dsh:fake.ctx,getConfig:()=>r.config,log,tts:{available:()=>true,speak:async()=>{entered();await gate;return {file:r.file,engine:'fixture'}}},onebot:{state:'connected',call:async()=>{r.calls.push('unexpected');return {message_id:'unexpected'}}}});t.after(()=>hub.dispose())
 const work=hub.sendVoice('group:777','制作期间撤权');await started;r.config.familyGroups=[];r.config.allow.groups.push('777');resolve();await work;await hub.recoverVoice()
 assert.equal(r.calls.length,0);assert.equal(hub.voiceOutboxStatus().at(-1).status,'cancelled')
})
test('raw OneBot client runs the latest policy before any network call',async t=>{
 let config=cfg(),fetched=0;const original=globalThis.fetch;t.after(()=>globalThis.fetch=original)
 globalThis.fetch=async()=>{fetched++;return {json:async()=>({retcode:0,data:{message_id:'ok'}})}}
 const c=createOneBotClient({endpoint:()=>({httpUrl:'http://127.0.0.1'}),log,authorize:(a,p)=>assertVoiceAction(config,a,p)})
 await assert.rejects(c.call('send_private_msg',{user_id:10003,message:[{type:'record',data:{file:'x'}}]}),/语音仅限/)
 await c.call('send_private_msg',{user_id:10002,group_id:888,message:[{type:'record',data:{file:'x'}}]})
 config.coOwners=[]
 await assert.rejects(c.call('send_private_msg',{user_id:10002,message:'[CQ:record,file=x]'}),/语音仅限/)
 assert.equal(fetched,1);c.stop()
})
