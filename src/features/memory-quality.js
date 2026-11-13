// Only complete, transient observations are flagged. Plans, health, preferences,
// relationship changes and direct instructions remain eligible memories.
export function routineMemoryReason(text) {
  const value = String(text || '').trim()
  if (/提醒|记住|约定|以后|每天|习惯|喜欢|讨厌|不舒服|生病|手术|身体|关系|分手|相恋|出差|工作|失眠|睡不着/.test(value)) return ''
  return /(?:刚睡醒|已经吃完了饭|已经吃了饭|说他已经吃完了饭|说(?:了)?晚安(?:好梦)?|说(?:了)?早安|让我早点睡|让大肥鱼早点睡|问大肥鱼有几个主人)[。！!]*$/.test(value) ? '当天问候或作息流水，缺少持续价值' : ''
}
