// 家里人之间互通近况（只在主人的地盘里）；她自己的样子（自拍参考图）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-self-'))

const { buildOwnerCrossNote, otherOwnerSpaces } = await import('../src/chat/family-cross.js')
const { resolveDrawImage, selfFacePath, SELF_PROMPT_GUARD } = await import('../src/features/imagegen.js')
const { normalize } = await import('../src/core/config.js')

const DAD = '10001'
const MOM = '10002'
const cfg = normalize({ ownerQQ: DAD, ownerName: '老登', coOwners: [{ qq: MOM, name: '老妈' }], familyGroups: ['777'] })
const T = 1_000_000_000_000

test('家里人互通：在老妈私聊里能知道老登刚在私聊说了什么；带上说话人；外人的聊天不带', () => {
  const rows = [
    { t: T + 1, chatId: `private:${DAD}`, who: '测试家人', uid: DAD, text: '我跟你妈吵架了' },
    { t: T + 2, chatId: `private:${DAD}`, who: 'bot', text: '又吵啥了' },
    { t: T + 3, chatId: 'group:777', who: '老妈', uid: MOM, text: '晚饭吃啥' },
    { t: T + 4, chatId: 'private:30003', who: '路人', uid: '30003', text: '这句不能带' },
    { t: T + 5, chatId: 'group:888', who: '群友', uid: '40004', text: '别的群也不带' },
    { t: T + 6, chatId: `private:${DAD}`, who: '系统', text: '【系统】她去说这些是因为：x' },
    { t: T + 7, chatId: `private:${DAD}`, who: '测试家人', uid: DAD, text: '这条被要求忘掉了', forgottenAt: T + 8 },
  ]
  const note = buildOwnerCrossNote({ cfg, chatId: `private:${MOM}`, rows, since: T, now: T + 100 })
  assert.match(note, /你和老登的私聊：[\s\S]*老登\(10001\)：我跟你妈吵架了[\s\S]*你当时回应：又吵啥了/)
  assert.match(note, /家庭群：[\s\S]*老妈\(10002\)：晚饭吃啥/)
  assert.match(note, /\[\d+-\d+ \d\d:\d\d\]/)
  assert.doesNotMatch(note, /这句不能带|别的群也不带|【系统】|这条被要求忘掉了/)
  assert.match(note, /不从旧记录推断自己一直要劝和/)
  assert.doesNotMatch(note, /私事别乱传话/)
})

test('只带上次之后的新内容；外人的私聊、普通群里不给', () => {
  const rows = [{ t: T + 1, chatId: `private:${DAD}`, who: 'x', uid: DAD, text: '旧的' }, { t: T + 50, chatId: `private:${DAD}`, who: 'x', uid: DAD, text: '新的' }]
  const note = buildOwnerCrossNote({ cfg, chatId: `private:${MOM}`, rows, since: T + 10, now: T + 100 })
  assert.match(note, /新的/)
  assert.doesNotMatch(note, /旧的/)
  assert.equal(buildOwnerCrossNote({ cfg, chatId: 'private:30003', rows, since: 0, now: T + 100 }), '')
  assert.equal(buildOwnerCrossNote({ cfg, chatId: 'group:888', rows, since: 0, now: T + 100 }), '')
  assert.deepEqual(otherOwnerSpaces(cfg, 'group:777'), [`private:${DAD}`, `private:${MOM}`])
  assert.equal(buildOwnerCrossNote({ cfg, chatId: `private:${MOM}`, rows: [], since: 0, now: T }), '')
})

test('她自己的样子：没定时如实说；定了以后 self / 自拍 都取这张；提示词要求同一张脸、衣服发型可变', async () => {
  await assert.rejects(resolveDrawImage('self', { hub: {}, chat: {} }), /还没定你自己的样子/)
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)])
  mkdirSync(dirname(selfFacePath()), { recursive: true })
  writeFileSync(selfFacePath(), png)
  assert.ok((await resolveDrawImage('self', { hub: {}, chat: {} })).equals(png))
  assert.ok((await resolveDrawImage('自拍', { hub: {}, chat: {} })).equals(png))
  assert.match(SELF_PROMPT_GUARD, /同一个人[\s\S]*发型、衣服[\s\S]*可以[\s\S]*不要二次元/)
})

test('她 17 岁：本人照片有无固定脸都包含正常衣着和非性化保护', async () => {
  const { selfPhotoPrompt } = await import('../src/features/imagegen.js')
  for (const reference of [true, false]) {
    const prompt = selfPhotoPrompt('在家吃白米饭', { reference })
    assert.match(prompt, /17 岁[\s\S]*正常衣着[\s\S]*非性化/)
    assert.ok(prompt.indexOf('在家吃白米饭') < prompt.indexOf('17 岁'), '画面描述在前，安全说明压短放最后')
    assert.equal(prompt.includes('参考图里的女生'), reference)
  }
})
