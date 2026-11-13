import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountWallets, createCreativeLife } from '../src/features/creative-life.js'
import definition from '../src/modules/creative-life/index.js'

function setup(t, action = 'rest') {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-creative-')), old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  let clock = new Date(2026, 10, 13, 14).getTime()
  const cfg = { model: { provider: 'deepseek-account', model: 'test' }, enabled: true, dryRun: false, familyGroups: ['123456'], ownerQQ: '12345', speakUp: { awakeFrom: 0, awakeTo: 24 }, imageGen: { enabled: true }, song: { enabled: true } }
  const settings = { ...definition.defaults, enabled: true }
  const calls = { model: [], generated: 0, sent: [], memories: [], songs: [] }
  const gen = { enabled: () => cfg.imageGen.enabled, generate: async () => { calls.generated++; return Buffer.from('image') } }
  const song = { status: () => ({ enabled: true, ready: true, queue: [] }), request: (x) => { calls.songs.push(x); return { ok: true } } }
  const memory = { addEvent: (x) => calls.memories.push(x) }
  const hub = { lastChatAt: 0, lastGroupAt: () => 0, chatLogOf: () => [], runSystemTurn: async (...args) => { calls.model.push(args); return JSON.stringify({ action, subject: action === 'sing' ? '歌名 歌手' : '一条小鱼', nextMinutes: 60 }) }, sendSegments: async (id, segs, note, opts) => { if (!opts.isCurrent()) return null; calls.sent.push(id); return { message_id: '123' } } }
  const api = { config: () => cfg, settings: () => settings, core: { hub, mutes: { muted: () => false }, ask: async () => JSON.stringify({ subject: 'none', decision: 'allow', reason: '普通绘画' }) }, dsh: { get: () => ({ getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: '12.5' }], bonusWallets: [] }) }) }, use: (id) => ({ imagegen: gen, song, memory })[id], log: { warn() {} } }
  const life = createCreativeLife(api, { now: () => clock, fetchImpl: async () => ({ ok: true, json: async () => ({ code: 0, data: { balance: '7.25' } }) }) })
  t.after(() => { life.dispose(); if (old === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = old; rmSync(dir, { recursive: true, force: true }) })
  return { life, cfg, settings, calls, gen, api, hub, advance: (minutes) => { clock += minutes * 60_000 } }
}

test('余额校验不把空值、错误或不同币种混成零/人民币', () => {
  assert.equal(accountWallets({ status: 'failed' }), null)
  assert.equal(accountWallets({ status: 'ready', value: [{ balance: null, currency: 'CNY' }], bonusWallets: [] }), null)
  assert.deepEqual(accountWallets({ status: 'ready', value: [{ balance: '2', currency: 'CNY' }, { balance: '3', currency: 'USD' }], bonusWallets: [{ balance: '0.5', currency: 'CNY' }] }), [{ currency: 'CNY', amount: 2.5 }, { currency: 'USD', amount: 3 }])
})
test('首次排期固定；休息不会发消息且余额传入无工具独立决策', async (t) => {
  const s = setup(t); await s.life.tick(); assert.equal(s.calls.model.length, 0)
  s.advance(31); await s.life.tick()
  assert.equal(s.calls.model.length, 1); assert.equal(s.calls.sent.length, 0)
  assert.match(s.calls.model[0][2], /12.5000 CNY/)
  assert.deepEqual(s.calls.model[0][3], { noTools: true, stateless: true, key: 'choice' })
  assert.equal(s.life.status().history[0].status, 'rest')
})
test('真实回执后才记自主画作经历，模型不能更换目标', async (t) => {
  const s = setup(t, 'draw'); s.advance(31); await s.life.tick()
  assert.equal(s.calls.generated, 1); assert.deepEqual(s.calls.sent, ['group:123456'])
  assert.equal(s.calls.memories.length, 1); assert.equal(s.life.status().history[0].status, 'sent')
})
test('模拟回执不能当作已送达', async (t) => {
  const s = setup(t, 'draw'); s.hub.sendSegments = async () => ({ message_id: 'sim-1' }); s.advance(31); await s.life.tick()
  assert.equal(s.calls.memories.length, 0); assert.equal(s.life.status().history[0].status, 'not_delivered')
})
test('画完时撤销家庭群不发送也不记成功，保留成品', async (t) => {
  const s = setup(t, 'draw'); s.gen.generate = async () => { s.cfg.familyGroups = []; return Buffer.from('image') }
  s.advance(31); await s.life.tick(); assert.equal(s.calls.sent.length, 0); assert.equal(s.calls.memories.length, 0)
  assert.equal(s.life.status().history[0].status, 'not_delivered'); assert.ok(s.life.status().history[0].path)
})
test('翻唱使用现有队列，带可撤权的发送检查', async (t) => {
  const s = setup(t, 'sing'); s.advance(31); await s.life.tick()
  assert.equal(s.calls.songs.length, 1); assert.equal(s.calls.songs[0].chatId, 'group:123456'); assert.ok(s.calls.songs[0].canSend())
  s.life.dispose(); assert.equal(s.calls.songs[0].canSend(), false)
})
test('忙碌/静音/试运行/关闭不启动创作模型', async (t) => {
  const s = setup(t, 'draw'); s.advance(31)
  s.cfg.dryRun = true; await s.life.tick(); s.cfg.dryRun = false
  s.hub.lastChatAt = Date.now() + 99999999999; await s.life.tick(); s.hub.lastChatAt = 0
  s.api.core.mutes.muted = () => true; await s.life.tick(); s.api.core.mutes.muted = () => false
  s.settings.enabled = false; await s.life.tick(); assert.equal(s.calls.model.length, 0)
})
test('预览不制作、不排队、不写历史和排期', async (t) => {
  const s = setup(t, 'sing'), nextAt = s.life.status().nextAt
  const r = await s.life.tick({ preview: true }); assert.equal(r.plan.action, 'sing')
  assert.equal(s.calls.songs.length, 0); assert.equal(s.life.status().history.length, 0); assert.equal(s.life.status().nextAt, nextAt)
})
test('XHY余额解析、未知、过时提示，凭据不出现在状态和模型输入', async (t) => {
  const s = setup(t); s.settings.xhyOpenApiKey = 's2o-private'
  await s.life.refreshBalances(); assert.match(s.life.balanceContext(), /7.2500 CNY/)
  assert.ok(!JSON.stringify(s.life.status()).includes('s2o-private'))
  s.advance(31); assert.match(s.life.balanceContext(), /已过时/)
  s.settings.xhyOpenApiKey = ''; await s.life.refreshBalances(); assert.match(s.life.balanceContext(), /画图.*余额未知/)
})
test('判断失败退避一小时，不每分钟重复收费调用', async (t) => {
  const s = setup(t); let attempts = 0; s.hub.runSystemTurn = async () => { attempts++; throw new Error('failed') }
  s.advance(31); await s.life.tick(); s.advance(1); await s.life.tick(); assert.equal(attempts, 1)
})
test('自画像不绕过本次分享决定，审查未通过不生成', async (t) => {
  const s = setup(t, 'draw'); s.api.core.ask = async () => JSON.stringify({ subject: 'self', decision: 'allow', reason: '角色本人' })
  s.advance(31); await s.life.tick(); assert.equal(s.calls.generated, 0)
})
test('官方API按当前配置的凭据引用查余额，拒绝把密钥发到改过的中转地址', async (t) => {
  const s = setup(t); s.cfg.model.provider = 'deepseek-official'
  let baseURL = 'https://api.deepseek.com', queried = []
  s.api.dsh.get = (name) => ({
    llm: { registration: () => ({ adapter: { dependencies: {
      options: () => ({ baseURL }), resolveAuth: async () => ({ headers: { 'x-api-key': 'private-key' } }),
    } } }) },
  })[name]
  const life = createCreativeLife(s.api, { fetchImpl: async (url, opts) => {
    queried.push(url); assert.equal(opts.headers.authorization, 'Bearer private-key')
    return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.5', granted_balance: '2', topped_up_balance: '10.5' }] }) }
  } })
  t.after(() => life.dispose())
  await life.refreshBalances(); assert.equal(life.status().balances.chat.wallets[0].amount, 12.5)
  assert.ok(!JSON.stringify(life.status()).includes('private-key'))
  baseURL = 'https://relay.invalid'; await life.refreshBalances(); assert.equal(life.status().balances.chat.ok, false); assert.equal(queried.length, 1)
})
