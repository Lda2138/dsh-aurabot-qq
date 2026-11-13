// 说话语音唱不了长歌：语气写「唱」或带 [唱歌] 且超过 12 个字时，改发文字；哼一两句照常发语音。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-sing-'))
const { isLongSinging } = await import('../src/voice/delivery.js')

test('长段「唱」判为改发文字，短哼和普通说话不受影响', () => {
  // 11-11 20:25 真实那条：认真唱整段，14.9 秒拖腔
  assert.equal(isLongSinging('世上只有爸爸好 有爸的孩子像块宝 投进爸爸的怀抱 幸福享不了', '认真唱，带笑，有点跑调'), true)
  assert.equal(isLongSinging('[唱歌] 世上只有妈妈好 有妈的孩子像块宝', ''), true)
  assert.equal(isLongSinging('[哼歌] 世上只有爸爸好', '开心地随口哼两句'), false)
  assert.equal(isLongSinging('啦啦啦 我会唱', '认真唱'), false)
  assert.equal(isLongSinging('今天放学路上看到一只特别胖的橘猫 蹲在便利店门口不走', '轻松，有点兴奋'), false)
  assert.equal(isLongSinging('行行行 爸爸最大 那我再唱一遍就是了', '笑着认命'), false)
  assert.equal(isLongSinging('世上只有爸爸好 有爸的孩子像块宝', '认真唱', 0), false)
})
