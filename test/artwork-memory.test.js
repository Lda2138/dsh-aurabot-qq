import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'artwork-memory-'))
const { createArtworkMemory } = await import('../src/features/artwork-memory.js')
const { normalize } = await import('../src/core/config.js')
const cfg = normalize({ ownerQQ: '10001', coOwners: [{ qq: '10002' }], familyGroups: ['777'] })
const rows = [
  { chatId: 'private:10002', t: 10, who: '妈妈', uid: '10002', text: '给爸爸画了一只戴围巾的猫' },
  { chatId: 'private:10001', t: 11, who: '爸爸', uid: '10001', text: '我给妈妈画了一棵树' },
  { chatId: 'group:888', t: 12, who: '别人', text: '私人画作secret' },
  { chatId: 'group:777', t: 13, who: '爸爸', text: '撤回的画不能查', forgottenAt: 15 },
]
const make = () => createArtworkMemory({ getConfig: () => cfg, hub: { chatLogDays: () => ['2026-11-13'], chatLogOf: () => rows } })

test('old artwork recalls human originals across family scopes only when permitted', () => {
  const memory = make(), chat = { chatId: 'group:777' }
  assert.equal(memory.search(chat, '妈妈给爸爸画', { shared: false }).length, 0)
  const out = memory.search(chat, '妈妈给爸爸画', { shared: true })
  assert.equal(out.length, 2)
  assert.ok(out.some((x) => x.speaker === '妈妈' && x.quote.includes('戴围巾的猫')))
  assert.doesNotMatch(JSON.stringify(out), /secret|撤回/)
})

test('generation and actual delivery are separate, restart keeps full prompt and receipt', () => {
  const memory = make()
  const job = memory.add({ chatId: 'group:777', prompt: '一只戴蓝色围巾坐在树下的猫', state: 'generating' })
  memory.update(job.id, { state: 'generated', file: 'C:/not-public/cat.png' })
  let found = make().search({ chatId: 'group:777' }, '蓝色围巾')
  assert.equal(found[0].state, 'generated')
  assert.equal(found[0].file, 'cat.png')
  memory.update(job.id, { state: 'sent', messageId: 'receipt-1' })
  found = make().search({ chatId: 'group:777' }, '蓝色围巾')
  assert.equal(found[0].messageId, 'receipt-1')
  assert.equal(found[0].prompt, '一只戴蓝色围巾坐在树下的猫')
})

test('concrete artifact provenance outranks diary keyword overlap and excludes system notices', () => {
  const memory = make()
  rows.push({ chatId: 'group:777', t: 20, who: 'bot', text: '爸爸给妈妈的画让爸爸妈妈都想画画，这是日记里的感想' },
    { chatId: 'group:777', t: 21, who: '系统', text: '【系统】爸爸让我哄喜欢画画的妈妈' })
  const found = memory.search({ chatId: 'group:777' }, '爸爸妈妈画画', { shared: true })
  assert.equal(found[0].source, 'generation-ledger')
  assert.ok(!found.some((r) => r.speaker === '系统'))
})
