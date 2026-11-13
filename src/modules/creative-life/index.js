import { createCreativeLife } from '../../features/creative-life.js'
import { isOwnerSpaceChat } from '../../chat/access.js'
import { defineTool } from '../../tools/tools.js'

export default {
  id: 'creative-life', name: '空闲创作与经费', version: '1.0.0', tab: 'speakup',
  description: '空闲时自己画画或翻唱，成品分享家庭群；查看聊天和画图账户余额',
  files: ['features/creative-life.js'],
  defaults: { enabled: false, idleMinutes: 40, lowBalanceCny: 10, xhyOpenApiKey: '' },
  settings: [{ key: 'xhyOpenApiKey', type: 'password', label: 'XHY OpenAPI查询密钥' }],
  setup(api) {
    const life = createCreativeLife(api)
    api.onDispose(() => life.dispose())
    api.every(60_000, () => life.tick(), '空闲创作')
    api.every(15 * 60_000, () => life.refreshBalances(), '查询自己的经费')
    // 查余额本身不调用聊天/画图模型。
    life.refreshBalances().catch(() => {})
    api.context(({ chat }) => api.settings().enabled && isOwnerSpaceChat(api.config(), chat) ? life.balanceContext() : '')
    api.tool(({ chat }) => isOwnerSpaceChat(api.config(), chat) ? defineTool({
      name: 'qq_check_balance', description: '查看自己的聊天（DeepSeek账户）与画图（XHY账户）余额；只返回余额和时间，不含密钥。余额未知不代表零。', properties: {},
      execute: async () => { await life.refreshBalances(); return { ok: true, message: life.balanceContext() } },
    }) : [])
    const action = (fn) => async (req) => {
      if (req.method !== 'POST' || !/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) return { ok: false, message: '请用POST JSON' }
      return fn(req)
    }
    api.route('/creative-life/status', async () => ({ ok: true, ...life.status() }))
    api.route('/creative-life/balance', action(async () => { await life.refreshBalances(); return { ok: true, ...life.status() } }))
    api.route('/creative-life/preview', action(async () => life.tick({ preview: true })))
    api.route('/creative-life/settings', action(async (req) => {
      const b = await api.core.http.body(req), patch = {}
      if (typeof b.enabled === 'boolean') patch.enabled = b.enabled
      for (const [k, min, max] of [['idleMinutes', 5, 1440], ['lowBalanceCny', 0, 100000]]) if (typeof b[k] === 'number' && Number.isFinite(b[k])) patch[k] = Math.min(max, Math.max(min, b[k]))
      if (typeof b.xhyOpenApiKey === 'string') {
        if (b.xhyOpenApiKey !== '' && !/^s2o-[A-Za-z0-9_-]+$/.test(b.xhyOpenApiKey)) return { ok: false, message: '需要XHY个人中心的s2o- OpenAPI查询密钥' }
        patch.xhyOpenApiKey = b.xhyOpenApiKey
      }
      api.saveSettings(patch)
      await life.refreshBalances()
      return { ok: true, message: '已保存', ...life.status() }
    }))
    return life
  },
}
