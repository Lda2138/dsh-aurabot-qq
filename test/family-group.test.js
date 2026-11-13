// 家庭群：只听主人们的、主人那一档权限、主人视角；回话收着点。顺带：乱码的称呼 / 唤醒词自愈。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { normalize } = await import('../src/core/config.js')
const { checkAllowed, levelFor, isOwnerSpace, isOwnerSpaceChat, profileToolVisible, isFamilyGroup } = await import('../src/chat/access.js')
const { decideGroupReply, policyFor, FAMILY_GROUP_POLICY, familyGroupDecision, familyHint, familyPaceHint } = await import('../src/chat/group-policy.js')
const { bracketFacesToTags, textToSegments } = await import('../src/chat/faces.js')
const { stripBreezeTags, BREEZE_ZH_TAGS } = await import('../src/voice/breeze.js')
const { rulesText } = await import('../src/persona/personas.js')

const DAD = '10001'
const MOM = '10002'
const FAM = '777'
const cfgOf = (over = {}) => normalize({ ownerQQ: DAD, ownerName: '老登', botQQ: '20002', coOwners: [{ qq: MOM, name: '老妈' }], familyGroups: [FAM], ownerLevel: 'full', ...over })
const fam = { kind: 'group', groupId: FAM, chatId: `group:${FAM}` }

test('配置：家庭群自动算进群白名单；只留数字', () => {
  const c = cfgOf({ allow: { private: [], groups: ['888'] }, familyGroups: ['群 777', 'x'] })
  assert.deepEqual(c.familyGroups, [FAM])
  assert.deepEqual(c.allow.groups, ['888', FAM])
  assert.deepEqual(normalize({}).familyGroups, [])
})

test('家庭群：只有主人们说的话才交给她，别人混进来也不理', () => {
  const c = cfgOf()
  assert.equal(checkAllowed(c, { kind: 'group', groupId: FAM, userId: DAD }).allowed, true)
  assert.equal(checkAllowed(c, { kind: 'group', groupId: FAM, userId: MOM }).allowed, true)
  assert.equal(checkAllowed(c, { kind: 'group', groupId: FAM, userId: '30003' }).allowed, false)
  assert.equal(checkAllowed(c, { kind: 'group', groupId: '888', userId: '30003' }).allowed, false, '普通群照旧看白名单')
})

test('家庭群：和主人私聊同一档权限、按主人视角；普通群不变', () => {
  const c = cfgOf()
  assert.equal(levelFor(c, fam), 'full')
  assert.equal(levelFor(c, { kind: 'group', groupId: '888' }), 'social')
  assert.equal(isFamilyGroup(c, FAM), true)
  assert.equal(isOwnerSpaceChat(c, fam), true)
  assert.equal(isOwnerSpace(c, `group:${FAM}`), true)
  assert.equal(isOwnerSpace(c, 'group:888'), false)
  assert.equal(isOwnerSpace(c, `private:${MOM}`), true)
  assert.equal(profileToolVisible(c, 'qqNickname', fam), true, '「仅主人」的工具家庭群里也有')
  assert.equal(profileToolVisible(c, 'qqNickname', { kind: 'group', groupId: '888' }), false)
})

test('家庭群交给她自己判断：被叫照样必回；连续回复多也不硬拦家人的新消息', () => {
  const c = cfgOf()
  const pol = { ...policyFor(c.group, c.group.overrides, FAM), ...FAMILY_GROUP_POLICY }
  const now = Date.now()
  const base = { policy: pol, now, hour: 15, recentTimes: [now - 1000], interjectTimes: [], botReplyTimes: [], relevance: 0, rand: () => 0.99 }
  assert.equal(familyGroupDecision(decideGroupReply({ ...base, text: '肥鱼你说呢' })).mode, 'must')
  for (const text of ['今天吃啥', '嗯', '。']) {
    const d = familyGroupDecision(decideGroupReply({ ...base, text }))
    assert.equal(d.reply, true)
    assert.equal(d.mode, 'family')
  }
  const busy = familyGroupDecision(decideGroupReply({ ...base, text: '今天吃啥', botReplyTimes: Array.from({ length: 8 }, (_, i) => now - i * 1000) }))
  assert.equal(busy.reply, true, '两分钟内说了 8 次仍把家人的新消息交给她')
  assert.equal(busy.mode, 'family')
  assert.match(familyHint(), /短句、笑声和表情结合前文理解[\s\S]*\[沉默\]/)
  assert.doesNotMatch(familyHint(), /也该停了/)
})

test('家庭群的频率限制改为内容提醒，窗口过去不再提醒；普通群仍按原策略刹车', () => {
  const now = Date.now()
  const times = Array.from({ length: 8 }, (_, i) => now - i * 1000)
  assert.equal(familyPaceHint(times.slice(0, 7), now), '')
  assert.match(familyPaceHint(times, now), /留意一下聊天节奏[\s\S]*照常自然接着聊[\s\S]*\[沉默\]/)
  assert.equal(familyPaceHint(times, now + 120_000), '')
  const normal = decideGroupReply({ policy: cfgOf().group, now, text: '那你继续', botReplyTimes: times })
  assert.equal(normal.reply, false, '普通群仍使用原防刷屏规则')
})

test('规则：有家庭群时告诉她那是自己家的群、要少说；没有时不提', () => {
  assert.match(rulesText('private', cfgOf()), /家庭群（群号 777）[\s\S]*接不接你自己判断/)
  assert.doesNotMatch(rulesText('private', cfgOf({ familyGroups: [] })), /家庭群（群号/)
})

test('乱码自愈：称呼、唤醒词里有「�」的回到默认；正常的不动', () => {
  const c = normalize({ ownerName: '��', group: { wakeWords: ['���', '��'] } })
  assert.equal(c.ownerName, '主人')
  assert.deepEqual(c.group.wakeWords, ['大肥鱼', '肥鱼'])
  const ok = normalize({ ownerName: '老登', group: { wakeWords: ['小鱼', '�'] } })
  assert.equal(ok.ownerName, '老登')
  assert.deepEqual(ok.group.wakeWords, ['小鱼'])
})

test('小黄脸：照着别人的样子写的 [撇嘴] 也变成真表情；认不出的方括号不动；文字里的 Breeze 标签去掉', () => {
  const idOf = (n) => ({ 撇嘴: 1, 哼: 286, 笑哭: 182 })[n]
  const t = stripBreezeTags(bracketFacesToTags('你想得美 [撇嘴] 看 [图片] 了 [叹气]', idOf))
  assert.equal(t, '你想得美 <face:撇嘴> 看 [图片] 了')
  const segs = textToSegments(t, idOf)
  assert.deepEqual(segs.find((x) => x.type === 'face'), { type: 'face', data: { id: '1' } })
  assert.ok(!segs.some((x) => x.type === 'text' && x.data.text.includes('[撇嘴]')))
  // 语音里：Breeze 标签留给 Breeze 念，不当表情
  const idOf2 = (n) => ({ 叹气: 99, 哼: 286 })[n]
  assert.equal(bracketFacesToTags('[叹气]又来了 [哼]', idOf2, new Set(BREEZE_ZH_TAGS)), '[叹气]又来了 <face:哼>')
})
