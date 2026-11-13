// Recover malformed completions through the real agent; never execute text as a tool.
import { stripToolText, isSilence } from './reply.js'

export function completionFault(message) {
  const blocks = message?.content || []
  if (blocks.some((b) => ['tool-call', 'tool_use', 'tool-use'].includes(b?.type))) return ''
  const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n').trim()
  if (text && isSilence(text)) return ''
  if (text && stripToolText(text) !== text && /<(?:\/?antml:|\/?\|?DSML|\/?(?:invoke|function_calls|tool_calls)\b)|<qq_[a-z_]+/i.test(text)) return 'tool-text'
  return !text && (!blocks.length || blocks.some((b) => b?.type === 'reasoning')) ? 'empty-final' : ''
}

export function completionRepairPrompt(fault, tools = []) {
  return '【本轮输出恢复，系统记录，不是新的真人请求】\n' +
    (fault === 'tool-text' ? '刚才把工具调用写成了普通文字；那些标签没有执行，旁边的“正在做／等着”也没有发给对方。不要再写XML或JSON来冒充调用。\n' : '刚才这一轮结束时没有给出可发送的最终正文，对方仍没有得到回答。\n') +
    (tools.length ? `本次真实工具记录（不要重复执行有副作用的操作）：${tools.map((x) => `${x.name}:${x.status}`).join('；')}。依据已有结果补最终正文；未知回执不能当成功。\n` : '本轮没有已登记的真实工具执行；先按最后真人输入判断意图，问旧内容不等于要生成新内容。确实要做事才使用真实工具通道。\n') +
    '结合已经收到的最新真人发言和更正完成本轮。需要回顾具体作品时先检索，找不到就如实说没查到；不要凭空说图没留着。只输出最终要说的话，或调用真实工具；内部推理不能作为正文。没有新内容可说可以明确输出[沉默]。'
}

const comparable = (s) => String(s || '').replace(/<at:[^>]+>|@\d+\s*/g, '').replace(/[\s\p{P}]/gu, '')
export function trimDeliveredPrefix(items, sent) {
  let n = 0
  while (n < items.length && n < sent.length && ['text', 'voice'].includes(items[n].kind) && comparable(items[n].value) && comparable(items[n].value) === comparable(sent[n])) n++
  return items.slice(n)
}
